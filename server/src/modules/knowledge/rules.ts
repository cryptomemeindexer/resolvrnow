import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { JOURNAL_TYPES } from '../../engine/types.js';
import { isSysId } from '../../engine/util.js';
import { taskStates } from '../task/index.js';
import { type KnowledgeService, knowledge, PROTECTED_FIELDS } from './service.js';
import { TEMPLATE_CLASSES } from './tables.js';
import { ARTICLE, articleCol, physTable, props, splitList, today, WORKING_STATES } from './util.js';

/** A user acting directly (REST, form): ACLs enforced and not an administrator. */
const isUserCtx = (ctx: Context) => ctx.enforceAcl && !ctx.user.isSystem && !ctx.user.isAdmin;

/** Closed state per task class for the Knowledge checkbox (incident 7, problem 107, else the class's model). */
const CLOSE_STATES: Record<string, string> = { incident: '7', problem: '107' };

function closedStates(ctx: Context, task: Rec): string[] {
  for (const t of task.table.ancestors) if (CLOSE_STATES[t]) return [CLOSE_STATES[t]];
  const model = taskStates(ctx.platform).model(task.className);
  if (model?.defaultClosed) return [model.defaultClosed];
  return model?.closed ?? ['3'];
}

function categoryDenial(svc: KnowledgeService, cur: Rec, checkActive: boolean): string | null {
  const cat = cur.str('kb_category');
  if (!cat) return null;
  const info = svc.access.category(cat);
  if (!info) return 'Unknown knowledge category';
  if (checkActive && !info.active) return `Category ${info.label} is inactive`;
  if (svc.access.categoryKb(cat) !== cur.str('kb_knowledge_base'))
    return `Category ${info.label} does not belong to this knowledge base`;
  return null;
}

/** KCS confidence follows the workflow state. */
function setConfidence(ctx: Context, cur: Rec): void {
  const state = cur.str('workflow_state') || 'draft';
  if (WORKING_STATES.includes(state)) cur.setRaw('confidence', 'in_progress');
  else if (state === 'published') {
    const validated = ['knowledge_coach', 'kcs_contributor', 'kcs_publisher'].some((r) =>
      ctx.user.roles.has(r),
    );
    cur.setRaw('confidence', validated ? 'validated' : 'not_validated');
  } else if (state === 'retired') cur.setRaw('confidence', 'archived');
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

const articleRules: BusinessRuleDef[] = [
  {
    name: 'Knowledge: prepare new article',
    table: ARTICLE,
    when: 'before',
    actions: ['insert'],
    order: 50,
    description: 'Defaults, validation, summary and first version of a new article',
    run(cur, _prev, ctx) {
      const svc = knowledge(ctx.platform);
      if (isUserCtx(ctx)) {
        for (const f of PROTECTED_FIELDS) cur.setRaw(f, null);
        cur.setRaw('workflow_state', 'draft');
        for (const f of ['sys_view_count', 'use_count', 'helpful_count', 'flagged']) cur.setRaw(f, 0);
        cur.setRaw('latest', 1);
        if (!cur.str('author')) cur.setRaw('author', ctx.user.sysId);
      }
      if (!cur.str('workflow_state')) cur.setRaw('workflow_state', 'draft');
      if (!cur.str('short_description').trim()) return cur.abort('Short description is required');
      let kbId = cur.str('kb_knowledge_base');
      if (!kbId && !ctx.user.isSystem) {
        kbId = svc.access.contributableKbIds(ctx)[0] ?? '';
        if (kbId) cur.setRaw('kb_knowledge_base', kbId);
      }
      const kb = svc.kbRecord(kbId);
      if (!kb) return cur.abort('Knowledge base is required');
      if (ctx.enforceAcl && !ctx.user.isSystem) {
        const denial = svc.templateDenial(ctx, cur, kb);
        if (denial) return cur.abort(denial);
      }
      // A new version keeps its category even if the category was deactivated since.
      const cat = categoryDenial(svc, cur, !cur.str('base_version'));
      if (cat) return cur.abort(cat);
      if (!ctx.user.isSystem) {
        const sched = svc.scheduleDenial(cur.str('scheduled_publish_date'));
        if (sched) return cur.abort(sched);
      }
      if (!cur.str('valid_to')) cur.setRaw('valid_to', svc.validTo(kb));
      cur.setRaw('active', kb.get('active') === 0 ? 0 : 1);
      if (!cur.str('language')) cur.setRaw('language', 'en');
      if (!cur.str('article_type')) cur.setRaw('article_type', 'text');
      if (!cur.str('summary')) {
        const summary = ctx.elevated().insert('kb_knowledge_summary', { number: cur.str('number') });
        cur.setRaw('summary', summary.sysId);
      }
      if (!cur.str('article_id')) cur.setRaw('article_id', cur.sysId);
      if (cur.get('latest') === null) cur.setRaw('latest', 1);
      svc.composeTemplateBody(cur);
      setConfidence(ctx, cur);
      if (cur.str('workflow_state') === 'published' && !cur.str('published'))
        cur.setRaw('published', today());
      svc.initialVersion(ctx, cur);
    },
  },
  {
    name: 'Knowledge: validate article changes',
    table: ARTICLE,
    when: 'before',
    actions: ['update'],
    order: 50,
    description:
      'State changes only through actions, published content locked, versions, dates and confidence',
    run(cur, prev, ctx) {
      if (!prev) return;
      const svc = knowledge(ctx.platform);
      if (isUserCtx(ctx)) {
        if (cur.changed('workflow_state')) {
          return cur.abort(
            'Use the knowledge actions (Publish, Retire, Recall, Create new version) to change the workflow state',
          );
        }
        for (const f of PROTECTED_FIELDS) if (cur.changed(f)) cur.setRaw(f, prev.get(f));
        if ((prev.str('workflow_state') || 'draft') === 'published' && svc.access.settings().versioning) {
          const minor = new Set(
            splitList(props(ctx.platform).str('glide.knowman.versioning.minor_edit_fields', 'valid_to')),
          );
          const blocked = cur.changes().filter((f) => {
            const col = cur.column(f);
            return (
              !!col &&
              !col.system &&
              !minor.has(f) &&
              !PROTECTED_FIELDS.includes(f) &&
              !JOURNAL_TYPES.has(col.type)
            );
          });
          if (blocked.length)
            return cur.abort('Published articles cannot be edited. Create a new version to make changes.');
        }
      }
      if (!cur.str('short_description').trim()) return cur.abort('Short description is required');
      if (cur.changed('kb_knowledge_base')) {
        const kb = svc.kbRecord(cur.str('kb_knowledge_base'));
        if (!kb) return cur.abort('Knowledge base is required');
        if (ctx.enforceAcl && !ctx.user.isSystem && !svc.access.canContributeKb(ctx, kb.sysId)) {
          return cur.abort(`You cannot contribute to ${kb.str('title')}`);
        }
        if ((kb.num('article_validity') ?? 0) > 0) cur.setRaw('valid_to', svc.validTo(kb));
        cur.setRaw('active', kb.get('active') === 0 ? 0 : 1);
      }
      if (cur.changed('kb_category') || cur.changed('kb_knowledge_base')) {
        const cat = categoryDenial(svc, cur, cur.changed('kb_category'));
        if (cat) return cur.abort(cat);
      }
      if (cur.changed('scheduled_publish_date') && !ctx.user.isSystem) {
        const sched = svc.scheduleDenial(cur.str('scheduled_publish_date'));
        if (sched) return cur.abort(sched);
      }
      const tpl = TEMPLATE_CLASSES[cur.className];
      if (tpl?.fields.some((f) => cur.changed(f.field))) svc.composeTemplateBody(cur);
      if (cur.changed('workflow_state')) {
        svc.bumpVersion(ctx, cur, prev);
        setConfidence(ctx, cur);
        const to = cur.str('workflow_state');
        if (to === 'published') {
          cur.setRaw('published', today());
          cur.setRaw('retired', null);
        } else if (to === 'retired') cur.setRaw('retired', today());
      }
    },
  },
  {
    name: 'Knowledge: new article bookkeeping',
    table: ARTICLE,
    when: 'after',
    actions: ['insert'],
    order: 100,
    run(cur, _prev, ctx) {
      if (cur.str('base_version') && cur.str('summary')) {
        ctx.platform.db.run(
          `UPDATE ${physTable(ctx.platform, ARTICLE)} SET ${articleCol(ctx.platform, 'latest')} = 0 WHERE ${articleCol(ctx.platform, 'summary')} = ? AND "sys_id" <> ?`,
          [cur.str('summary'), cur.sysId],
        );
        return;
      }
      ctx.queueEvent('knowledge.created', cur, cur.str('source'), cur.ref('source')?.className ?? '');
    },
  },
  {
    name: 'Knowledge: outdate previous versions on publish',
    table: ARTICLE,
    when: 'after',
    actions: ['update'],
    order: 100,
    condition: (cur) => cur.changed('workflow_state'),
    run(cur, _prev, ctx) {
      const to = cur.str('workflow_state');
      if (to === 'published') {
        const summary = cur.str('summary');
        if (summary) {
          const e = ctx.elevated();
          for (const other of e.query(
            ARTICLE,
            `summary=${summary}^sys_id!=${cur.sysId}^workflow_state=published`,
          )) {
            e.update(other, { workflow_state: 'outdated' });
          }
        }
        ctx.queueEvent('kb.article.published', cur, cur.str('author'), cur.str('revised_by'));
      } else if (to === 'retired') {
        ctx.queueEvent('kb.article.retired', cur, cur.str('author'), cur.str('replacement_article'));
      }
    },
  },
  {
    name: 'Knowledge: keep the latest flag after a delete',
    table: ARTICLE,
    when: 'after',
    actions: ['delete'],
    order: 100,
    run(cur, _prev, ctx) {
      const summary = cur.str('summary');
      if (!summary) return;
      const rows = knowledge(ctx.platform).versionRows(summary);
      if (!rows.length) {
        const s = ctx.elevated().get('kb_knowledge_summary', summary);
        if (s) ctx.elevated().delete(s);
        return;
      }
      if (!rows.some((r) => r.latest)) {
        ctx.platform.db.run(
          `UPDATE ${physTable(ctx.platform, ARTICLE)} SET ${articleCol(ctx.platform, 'latest')} = 1 WHERE "sys_id" = ?`,
          [rows[rows.length - 1].sysId],
        );
      }
    },
  },
  {
    name: 'Knowledge: article visibility',
    table: ARTICLE,
    when: 'before',
    actions: ['query'],
    description:
      'Readers see live articles of readable bases; drafts only for authors, revisers and base managers',
    query(qb, ctx) {
      if (!ctx.enforceAcl) return;
      const q = knowledge(ctx.platform).access.articleQuery(ctx);
      if (q) qb.addEncodedQuery(q);
    },
  },
];

const baseRules: BusinessRuleDef[] = [
  {
    name: 'Knowledge: validate knowledge base',
    table: 'kb_knowledge_base',
    when: 'before',
    actions: ['insert', 'update'],
    order: 50,
    run(cur, _prev, ctx) {
      const title = cur.str('title').trim();
      if (!title) return cur.abort('Title is required');
      if (cur.changed('title') || cur.isNew()) {
        const dup = ctx.platform.db.get(
          `SELECT "sys_id" FROM "kb_knowledge_base" WHERE "title" = ? COLLATE NOCASE AND "sys_id" <> ?`,
          [title, cur.sysId],
        );
        if (dup) return cur.abort(`A knowledge base named ${title} already exists`);
      }
      if (!cur.str('owner') && ctx.user.sysId) cur.setRaw('owner', ctx.user.sysId);
      if (!cur.str('owner')) return cur.abort('Owner is required');
      if (!cur.str('resolvr_publish_flow')) cur.setRaw('resolvr_publish_flow', 'approval');
      if (!cur.str('resolvr_retire_flow')) cur.setRaw('resolvr_retire_flow', 'instant');
    },
  },
  {
    name: 'Knowledge: managers and active flag',
    table: 'kb_knowledge_base',
    when: 'after',
    actions: ['insert', 'update'],
    order: 100,
    description:
      'Base managers receive the knowledge_manager role; deactivating a base deactivates its articles',
    run(cur, _prev, ctx) {
      const e = ctx.elevated();
      if (cur.changed('kb_managers')) {
        const role = e.first('sys_user_role', 'name=knowledge_manager');
        if (role) {
          for (const uid of splitList(cur.str('kb_managers'))) {
            if (isSysId(uid) && !e.first('sys_user_has_role', `user=${uid}^role=${role.sysId}`)) {
              e.insert('sys_user_has_role', { user: uid, role: role.sysId });
            }
          }
        }
      }
      if (!cur.isNew() && cur.changed('active')) {
        ctx.platform.db.run(
          `UPDATE ${physTable(ctx.platform, ARTICLE)} SET ${articleCol(ctx.platform, 'active')} = ? WHERE ${articleCol(ctx.platform, 'kb_knowledge_base')} = ?`,
          [cur.get('active') === 0 ? 0 : 1, cur.sysId],
        );
      }
    },
  },
  {
    name: 'Knowledge: category path',
    table: 'kb_category',
    when: 'before',
    actions: ['insert', 'update'],
    order: 50,
    run(cur, _prev, ctx) {
      const label = cur.str('label').trim();
      if (!label) return cur.abort('Label is required');
      if (!cur.str('parent_table')) cur.setRaw('parent_table', 'kb_knowledge_base');
      const table = cur.str('parent_table');
      if (table !== 'kb_knowledge_base' && table !== 'kb_category')
        return cur.abort('A category belongs to a knowledge base or another category');
      const parentId = cur.str('parent_id');
      if (!parentId || parentId === cur.sysId) return cur.abort('Parent is required');
      const parent = ctx.elevated().get(table, parentId);
      if (!parent) return cur.abort('Parent not found');
      if (!cur.str('value')) cur.setRaw('value', slug(label));
      cur.setRaw(
        'full_category',
        table === 'kb_category' ? `${parent.str('full_category') || parent.str('label')} > ${label}` : label,
      );
    },
  },
  {
    name: 'Knowledge: cascade category path',
    table: 'kb_category',
    when: 'after',
    actions: ['update'],
    order: 100,
    condition: (cur) => cur.changed('full_category'),
    run(cur, _prev, ctx) {
      const e = ctx.elevated();
      for (const child of e.query('kb_category', `parent_table=kb_category^parent_id=${cur.sysId}`)) {
        e.update(child, { full_category: `${cur.str('full_category')} > ${child.str('label')}` });
      }
    },
  },
];

const feedbackRules: BusinessRuleDef[] = [
  {
    name: 'Knowledge: validate feedback',
    table: 'kb_feedback',
    when: 'before',
    actions: ['insert'],
    order: 50,
    run(cur, _prev, ctx) {
      knowledge(ctx.platform).prepareFeedback(ctx, cur);
    },
  },
  {
    name: 'Knowledge: feedback counters and tasks',
    table: 'kb_feedback',
    when: 'after',
    actions: ['insert'],
    order: 100,
    run(cur, _prev, ctx) {
      knowledge(ctx.platform).afterFeedback(ctx, cur);
    },
  },
  {
    name: 'Knowledge: feedback counters on change',
    table: 'kb_feedback',
    when: 'after',
    actions: ['update', 'delete'],
    order: 100,
    run(cur, _prev, ctx) {
      const svc = knowledge(ctx.platform);
      const article = cur.str('article');
      if (!article) return;
      svc.recomputeFeedback(article);
      svc.recomputeFlag(article);
    },
  },
  {
    name: 'Knowledge: feedback visibility',
    table: 'kb_feedback',
    when: 'before',
    actions: ['query'],
    query(qb, ctx) {
      if (!ctx.enforceAcl) return;
      const q = knowledge(ctx.platform).access.feedbackQuery(ctx);
      if (q) qb.addEncodedQuery(q);
    },
  },
  {
    name: 'Knowledge: feedback task resolution',
    table: 'kb_feedback_task',
    when: 'before',
    actions: ['insert', 'update'],
    order: 50,
    run(cur) {
      if (cur.str('state') === '6' && !cur.str('resolution_code'))
        cur.abort('A resolution code is required to resolve a feedback task');
    },
  },
  {
    name: 'Knowledge: feedback task events',
    table: 'kb_feedback_task',
    when: 'after',
    actions: ['update'],
    order: 100,
    run(cur, _prev, ctx) {
      if (cur.changedTo('state', '6'))
        ctx.queueEvent('kb_feedback_task.resolved', cur, cur.str('opened_by'), cur.str('resolution_code'));
      if (cur.str('state') === '3' && cur.changed('comments')) {
        const last =
          cur.journal
            .filter((j) => j.field === 'comments')
            .map((j) => j.value)
            .pop() ?? '';
        ctx.queueEvent('kb_feedback_task.commented', cur, cur.str('opened_by'), last.slice(0, 4000));
      }
    },
  },
  {
    name: 'Knowledge: submission outcome events',
    table: 'kb_submission',
    when: 'after',
    actions: ['update'],
    order: 100,
    condition: (cur) => cur.changed('status') && cur.str('status').startsWith('closed_'),
    run(cur, _prev, ctx) {
      ctx.queueEvent(
        `kb.submission.${cur.str('status')}`,
        cur,
        cur.str('opened_by'),
        cur.str('kb_knowledge'),
      );
    },
  },
];

const usageRules: BusinessRuleDef[] = [
  {
    name: 'Knowledge: count article use when attached to a task',
    table: 'm2m_kb_task',
    when: 'after',
    actions: ['insert'],
    order: 100,
    run(cur, _prev, ctx) {
      knowledge(ctx.platform).recordUse(ctx, cur.str('kb_knowledge'), cur.str('task'));
    },
  },
  ...(['kb_use', 'ts_query_kb'] as const).map(
    (table): BusinessRuleDef => ({
      name: `Knowledge: own ${table === 'kb_use' ? 'usage' : 'searches'} only`,
      table,
      when: 'before',
      actions: ['query'],
      query(qb, ctx) {
        if (!ctx.enforceAcl || ctx.hasRole('knowledge_manager') || ctx.hasRole('knowledge_admin')) return;
        qb.addEncodedQuery(ctx.user.sysId ? `user=${ctx.user.sysId}` : 'sys_id=-1');
      },
    }),
  ),
  {
    name: 'Knowledge: create article when a task closes with Knowledge checked',
    table: 'task',
    when: 'async',
    actions: ['update'],
    order: 500,
    description:
      'Draft article (or knowledge submission) from the task; skipped for incidents when KCS is enabled',
    condition: (cur, prev, ctx) =>
      !!prev &&
      cur.bool('knowledge') &&
      prev.str('state') !== cur.str('state') &&
      closedStates(ctx, cur).includes(cur.str('state')),
    run(cur, _prev, ctx) {
      const svc = knowledge(ctx.platform);
      if (svc.isKcsActive(ctx, cur)) return;
      const out = svc.createFromTask(ctx, cur);
      if (!out)
        ctx.platform.log.warn(`[resolvrnow] knowledge: no knowledge base available for ${cur.str('number')}`);
    },
  },
];

export const knowledgeRules: BusinessRuleDef[] = [
  ...articleRules,
  ...baseRules,
  ...feedbackRules,
  ...usageRules,
];
