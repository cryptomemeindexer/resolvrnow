import type { Context } from '../../engine/context.js';
import { AbortError, AccessError } from '../../engine/errors.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import { optionalService, SERVICES } from '../contracts.js';
import { COORDINATOR, KNOWN_ERROR_BASE } from './constants.js';

const ARTICLE_TABLE = 'kb_template_known_error_article';

/** What a knowledge provider may return: the article record, or its table and sys_id. */
type ProviderResult = Rec | { table?: string; sysId?: string } | null | undefined;

/** Optional hook a knowledge module may expose to build Known Error articles itself. */
interface KnownErrorProvider {
  createKnownErrorArticle?: (ctx: Context, problem: Rec) => ProviderResult;
}

function asArticle(ctx: Context, result: ProviderResult): Rec | null {
  if (!result) return null;
  if (typeof (result as Rec).str === 'function') return result as Rec;
  const { table, sysId } = result as { table?: string; sysId?: string };
  return table && sysId ? ctx.platform.systemContext().get(table, sysId) : null;
}

/** Known Error articles need the knowledge module (service plus its Known Error template table). */
export function knowledgeAvailable(platform: Platform): boolean {
  return !!optionalService(platform, SERVICES.knowledge) && platform.registry.has(ARTICLE_TABLE);
}

function insertArticle(ctx: Context, prb: Rec): Rec {
  const sys = ctx.elevated();
  const values: Record<string, unknown> = {
    short_description: prb.str('short_description'),
    kb_description: prb.str('description') || prb.str('short_description'),
    kb_workaround: prb.str('workaround'),
    kb_cause: prb.str('cause_notes'),
    source: prb.sysId,
    cmdb_ci: prb.str('cmdb_ci') || null,
    workflow_state: 'draft',
  };
  if (sys.registry.has('kb_knowledge_base')) {
    const base = sys.first('kb_knowledge_base', `title=${KNOWN_ERROR_BASE}`);
    if (base) values.kb_knowledge_base = base.sysId;
  }
  const categoryColumns =
    sys.registry.column('kb_category', 'label') && sys.registry.column('kb_category', 'parent_id');
  if (categoryColumns && prb.str('category') && values.kb_knowledge_base) {
    const category = sys.first(
      'kb_category',
      `label=${prb.display('category')}^parent_id=${values.kb_knowledge_base}`,
    );
    if (category) values.kb_category = category.sysId;
  }
  return sys.insert(ARTICLE_TABLE, values);
}

function attachToTask(ctx: Context, article: Rec, task: Rec): void {
  const reg = ctx.registry;
  if (
    !reg.has('m2m_kb_task') ||
    !reg.column('m2m_kb_task', 'task') ||
    !reg.column('m2m_kb_task', 'kb_knowledge')
  )
    return;
  const sys = ctx.elevated();
  if (sys.count('m2m_kb_task', `task=${task.sysId}^kb_knowledge=${article.sysId}`) === 0) {
    sys.insert('m2m_kb_task', { task: task.sysId, kb_knowledge: article.sysId });
  }
}

/** Create Known Error Article: drafts the article (through the knowledge module when it offers it) and links it. */
export function createKnownErrorArticle(ctx: Context, prb: Rec): Rec {
  if (!ctx.user.isSystem && !ctx.hasRole(COORDINATOR))
    throw new AccessError('Insufficient rights to create known error articles');
  if (!knowledgeAvailable(ctx.platform)) throw new AbortError('Knowledge Management is not installed');
  if (prb.str('primary_known_error_article'))
    throw new AbortError('This problem already has a known error article');
  const provider = optionalService<KnownErrorProvider>(ctx.platform, SERVICES.knowledge);
  const article = asArticle(ctx, provider?.createKnownErrorArticle?.(ctx, prb)) ?? insertArticle(ctx, prb);
  const current = ctx.platform.systemContext().get('problem', prb.sysId) ?? prb;
  ctx.update(current, {
    primary_known_error_article: article.sysId,
    known_error: true,
    work_notes: `Known error article ${article.str('number')} drafted from this problem.`,
  });
  attachToTask(ctx, article, current);
  return article;
}
