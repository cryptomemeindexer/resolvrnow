import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { defaultCatalogId, splitList } from './access.js';
import { APPROVAL, REQ_STATE, REQUEST_READ_ROLES, ROLES, STAGE, T, VT } from './constants.js';
import { fulfillmentOf } from './fulfillment.js';
import { isForbiddenTarget } from './producer.js';

const NO_NAME_TYPES = new Set<number>([VT.break, VT.containerStart, VT.containerEnd, VT.containerSplit]);

/** Derives a script-safe variable name from the question text. */
export function variableName(text: string): string {
  let base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  if (!base) base = 'variable';
  if (/^\d/.test(base)) base = `v_${base}`;
  return base;
}

function ownerQuery(cur: Rec): string {
  if (cur.str('cat_item')) return `cat_item=${cur.str('cat_item')}`;
  if (cur.str('variable_set')) return `variable_set=${cur.str('variable_set')}`;
  return '';
}

const fulfillment = (ctx: Context) => fulfillmentOf(ctx.platform);

export const CATALOG_RULES: BusinessRuleDef[] = [
  // ------------------------------------------------------------ definitions
  {
    name: 'Catalog: unique title',
    table: T.catalog,
    when: 'before',
    actions: ['insert', 'update'],
    condition: (cur) => cur.isNew() || cur.changed('title'),
    run(cur, _prev, ctx) {
      const title = cur.str('title').trim();
      if (!title) return;
      const dup = ctx.platform.systemContext().first(T.catalog, `title=${title}^sys_id!=${cur.sysId}`);
      if (dup) cur.abort(`A catalog named "${title}" already exists`);
    },
  },
  {
    name: 'Category: catalog follows parent',
    table: T.category,
    when: 'before',
    actions: ['insert', 'update'],
    condition: (cur) => cur.isNew() || cur.changed('parent') || cur.changed('sc_catalog'),
    run(cur, _prev, ctx) {
      const sys = ctx.platform.systemContext();
      const parentId = cur.str('parent');
      if (parentId) {
        if (parentId === cur.sysId) {
          cur.abort('A category cannot be its own parent');
          return;
        }
        const parent = sys.get(T.category, parentId);
        if (parent) {
          if (!cur.str('sc_catalog')) cur.setRaw('sc_catalog', parent.str('sc_catalog'));
          else if (parent.str('sc_catalog') && cur.str('sc_catalog') !== parent.str('sc_catalog')) {
            cur.abort('A category must belong to the same catalog as its parent');
            return;
          }
        }
      }
      if (!cur.str('sc_catalog')) {
        const d = defaultCatalogId(ctx);
        if (d) cur.setRaw('sc_catalog', d);
      }
    },
  },
  {
    name: 'Catalog item: default catalog',
    table: T.item,
    when: 'before',
    actions: ['insert', 'update'],
    condition: (cur) => !cur.str('sc_catalogs'),
    run(cur, _prev, ctx) {
      const fromCategory = cur.str('category')
        ? ctx.platform.systemContext().get(T.category, cur.str('category'))?.str('sc_catalog')
        : '';
      const catalog = fromCategory || defaultCatalogId(ctx);
      if (catalog) cur.setRaw('sc_catalogs', catalog);
    },
  },
  {
    name: 'Record producer: valid target table',
    table: T.producer,
    when: 'before',
    actions: ['insert', 'update'],
    condition: (cur) => cur.isNew() || cur.changed('table_name'),
    run(cur, _prev, ctx) {
      const table = cur.str('table_name');
      if (!table) return;
      if (isForbiddenTarget(ctx.platform, table)) {
        cur.abort('Record producers cannot create requests, requested items or catalog tasks');
        return;
      }
      if (!ctx.platform.registry.has(table)) cur.abort(`Table ${table} does not exist`);
    },
  },
  {
    name: 'Variable: owner and name',
    table: T.variable,
    when: 'before',
    actions: ['insert', 'update'],
    run(cur, _prev, ctx) {
      if (cur.str('cat_item') && cur.str('variable_set')) {
        cur.abort('A variable belongs to either a catalog item or a variable set, not both');
        return;
      }
      if (cur.str('name') || NO_NAME_TYPES.has(cur.num('type') ?? 0)) return;
      const base = variableName(cur.str('question_text'));
      const owner = ownerQuery(cur);
      const sys = ctx.platform.systemContext();
      let name = base;
      for (let i = 2; owner && sys.first(T.variable, `${owner}^name=${name}^sys_id!=${cur.sysId}`); i++)
        name = `${base}_${i}`;
      cur.setRaw('name', name);
    },
  },
  {
    name: 'Order guide rule: guide items only',
    table: T.guideRule,
    when: 'before',
    actions: ['insert', 'update'],
    condition: (cur) => cur.str('item') === cur.str('guide'),
    run(cur) {
      cur.abort('An order guide cannot include itself');
    },
  },

  // ---------------------------------------------------------- catalog tasks
  {
    name: 'Catalog task: copy request fields',
    table: T.task,
    when: 'before',
    actions: ['insert', 'update'],
    order: 50,
    condition: (cur) => cur.isNew() || cur.changed('request_item'),
    run(cur, _prev, ctx) {
      const ritm = cur.str('request_item')
        ? ctx.platform.systemContext().get(T.ritm, cur.str('request_item'))
        : null;
      if (!ritm) return;
      cur.setRaw('request', ritm.str('request') || null);
      cur.setRaw('cat_item', ritm.str('cat_item') || null);
      cur.setRaw('sc_catalog', ritm.str('sc_catalog') || null);
      if (cur.isNew()) {
        if (!cur.str('short_description'))
          cur.setRaw('short_description', ritm.ref('cat_item')?.str('name') || ritm.str('short_description'));
        if (!cur.str('assignment_group')) {
          const group = ritm.ref('cat_item')?.str('group') || ritm.str('assignment_group');
          if (group) cur.setRaw('assignment_group', group);
        }
      }
    },
  },
  {
    name: 'Catalog task: advance fulfillment when closed',
    table: T.task,
    when: 'after',
    actions: ['update'],
    order: 200,
    condition: (cur, prev) => !cur.bool('active') && !!prev?.bool('active'),
    run(cur, _prev, ctx) {
      fulfillment(ctx).onTaskClosed(ctx, cur);
    },
  },
  {
    name: 'Catalog task: assignment events',
    table: T.task,
    when: 'after',
    actions: ['insert', 'update'],
    order: 300,
    run(cur, prev, ctx) {
      const assignee = cur.str('assigned_to');
      if (assignee && (!prev || prev.str('assigned_to') !== assignee))
        ctx.queueEvent('sc_task.assigned.to.user', cur, assignee, cur.str('assignment_group'));
      const group = cur.str('assignment_group');
      if (group && !assignee && (!prev || prev.str('assignment_group') !== group))
        ctx.queueEvent('sc_task.assigned.to.group', cur, group, null);
    },
  },

  // ------------------------------------------------------- start of fulfillment
  {
    name: 'Request: start fulfillment',
    table: T.request,
    when: 'async',
    actions: ['insert'],
    description:
      'Request approval (when configured) and start of every requested item, after the order commits',
    run(cur, _prev, ctx) {
      fulfillment(ctx).startRequest(ctx, cur.sysId);
    },
  },
  {
    name: 'Requested item: start when added to an approved request',
    table: T.ritm,
    when: 'async',
    actions: ['insert'],
    description: 'Items created outside checkout (Table API, routing) start once their request is approved',
    run(cur, _prev, ctx) {
      const req = cur.str('request') ? ctx.platform.systemContext().get(T.request, cur.str('request')) : null;
      if (!req || req.str('request_state') === REQ_STATE.inProcess)
        fulfillment(ctx).startItem(ctx, cur.sysId);
    },
  },

  // -------------------------------------------------------- requested items
  {
    name: 'Requested item: approval decided',
    table: T.ritm,
    when: 'after',
    actions: ['update'],
    order: 100,
    condition: (cur) =>
      cur.changed('approval') &&
      (cur.str('approval') === APPROVAL.approved || cur.str('approval') === APPROVAL.rejected) &&
      cur.str('stage') === STAGE.waiting &&
      cur.bool('active') &&
      !cur.str('flow_context'),
    run(cur, _prev, ctx) {
      fulfillment(ctx).onItemDecision(ctx, cur.sysId, cur.str('approval') as 'approved' | 'rejected');
    },
  },
  {
    name: 'Requested item: roll up to request',
    table: T.ritm,
    when: 'after',
    actions: ['update'],
    order: 500,
    condition: (cur) =>
      !!cur.str('request') &&
      ['state', 'stage', 'active', 'price', 'quantity', 'estimated_delivery'].some((f) => cur.changed(f)),
    run(cur, _prev, ctx) {
      fulfillment(ctx).rollupRequest(ctx, cur.str('request'));
    },
  },
  {
    name: 'Requested item: recalculate request after delete',
    table: T.ritm,
    when: 'after',
    actions: ['delete'],
    condition: (cur) => !!cur.str('request'),
    run(cur, _prev, ctx) {
      fulfillment(ctx).rollupRequest(ctx, cur.str('request'));
    },
  },
  {
    name: 'Requested item: events',
    table: T.ritm,
    when: 'after',
    actions: ['update'],
    order: 600,
    run(cur, _prev, ctx) {
      if (cur.str('assigned_to') && cur.changed('assigned_to'))
        ctx.queueEvent('sc_req_item.assigned', cur, cur.str('assigned_to'), null);
      if (cur.changedTo('stage', STAGE.delivery))
        ctx.queueEvent('sc_req_item.delivery', cur, cur.str('requested_for'), null);
      if (cur.changed('comments')) ctx.queueEvent('sc_req_item.commented', cur, ctx.user.sysId, null);
    },
  },

  // --------------------------------------------------------------- requests
  {
    name: 'Request: approval decided',
    table: T.request,
    when: 'after',
    actions: ['update'],
    order: 100,
    condition: (cur) =>
      cur.changed('approval') &&
      (cur.str('approval') === APPROVAL.approved || cur.str('approval') === APPROVAL.rejected) &&
      cur.str('request_state') === REQ_STATE.requested &&
      cur.bool('active'),
    run(cur, _prev, ctx) {
      fulfillment(ctx).onRequestDecision(ctx, cur.sysId, cur.str('approval') as 'approved' | 'rejected');
    },
  },
  {
    name: 'Request: events',
    table: T.request,
    when: 'after',
    actions: ['update'],
    order: 600,
    run(cur, _prev, ctx) {
      if (cur.str('assigned_to') && cur.changed('assigned_to'))
        ctx.queueEvent('sc_request.assigned', cur, cur.str('assigned_to'), null);
      if (cur.changedTo('approval', APPROVAL.approved))
        ctx.queueEvent('sc_request.approved', cur, cur.str('opened_by'), null);
      if (cur.changed('request_state'))
        ctx.queueEvent('sc_request.updated', cur, cur.str('request_state'), cur.str('opened_by'));
    },
  },

  // ---------------------------------------------------------------- answers
  {
    name: 'Variable ownership: delete orphan answers',
    table: T.optionLink,
    when: 'after',
    actions: ['delete'],
    run(cur, _prev, ctx) {
      const sys = ctx.elevated();
      const optionId = cur.str('sc_item_option');
      if (!optionId || sys.count(T.optionLink, `sc_item_option=${optionId}`) > 0) return;
      const opt = sys.get(T.option, optionId);
      if (opt) sys.delete(opt);
    },
  },
];

/** Requesters see their own requests, items and assigned catalog tasks in lists (spec 11). */
export const CATALOG_QUERY_RULES: BusinessRuleDef[] = [
  {
    name: 'Request: requesters see their own',
    table: T.request,
    when: 'before',
    actions: ['query'],
    query(qb, ctx) {
      if (!ctx.enforceAcl || ctx.user.isSystem || ctx.hasAnyRole([...REQUEST_READ_ROLES, 'admin'])) return;
      const me = ctx.user.sysId;
      qb.addEncodedQuery(me ? `opened_by=${me}^ORrequested_for=${me}^ORwatch_listLIKE${me}` : 'sys_id=-1');
    },
  },
  {
    name: 'Requested item: requesters see their own',
    table: T.ritm,
    when: 'before',
    actions: ['query'],
    query(qb, ctx) {
      if (!ctx.enforceAcl || ctx.user.isSystem || ctx.hasAnyRole([...REQUEST_READ_ROLES, 'admin'])) return;
      const me = ctx.user.sysId;
      qb.addEncodedQuery(
        me
          ? `opened_by=${me}^ORrequested_for=${me}^ORrequest.requested_for=${me}^ORwatch_listLIKE${me}`
          : 'sys_id=-1',
      );
    },
  },
  {
    name: 'Catalog task: assignees only',
    table: T.task,
    when: 'before',
    actions: ['query'],
    query(qb, ctx) {
      if (!ctx.enforceAcl || ctx.user.isSystem || ctx.hasAnyRole([...REQUEST_READ_ROLES, 'admin'])) return;
      const me = ctx.user.sysId;
      qb.addEncodedQuery(me ? `assigned_to=${me}` : 'sys_id=-1');
    },
  },
  {
    name: 'Cart: own carts',
    table: T.cart,
    when: 'before',
    actions: ['query'],
    query(qb, ctx) {
      if (!ctx.enforceAcl || ctx.user.isSystem || ctx.hasAnyRole([ROLES.admin, 'admin'])) return;
      qb.addEncodedQuery(ctx.user.sysId ? `user=${ctx.user.sysId}` : 'sys_id=-1');
    },
  },
  {
    name: 'Cart item: own carts',
    table: T.cartItem,
    when: 'before',
    actions: ['query'],
    query(qb, ctx) {
      if (!ctx.enforceAcl || ctx.user.isSystem || ctx.hasAnyRole([ROLES.admin, 'admin'])) return;
      qb.addEncodedQuery(ctx.user.sysId ? `cart.user=${ctx.user.sysId}` : 'sys_id=-1');
    },
  },
];

/** Catalogs the user manages (manager) or edits (editors list). */
export function catalogRoleScope(ctx: Context, catalogId: string, level: 'manager' | 'editor'): boolean {
  const me = ctx.user.sysId;
  if (!me || !catalogId) return false;
  const cat = ctx.platform.systemContext().get(T.catalog, catalogId);
  if (!cat) return false;
  if (cat.str('manager') === me && ctx.hasRole(ROLES.manager)) return true;
  return level === 'editor' && ctx.hasRole(ROLES.editor) && splitList(cat.str('editors')).includes(me);
}
