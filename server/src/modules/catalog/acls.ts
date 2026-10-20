/**
 * Access controls (spec section 11): catalog administrators, managers and editors
 * manage definitions; every internal user browses visible items and orders;
 * requesters see their own requests; fulfillers (itil) work catalog tasks.
 */
import type { Context } from '../../engine/context.js';
import type { Rec } from '../../engine/record.js';
import type { AclDef, AclOperation } from '../../engine/services/acl.js';
import { CatalogAccess, splitList } from './access.js';
import { REQUEST_READ_ROLES, REQUEST_WRITE_ROLES, ROLES, T, VT } from './constants.js';
import { catalogRoleScope } from './rules.js';

const ME = 'javascript:gs.getUserID()';
const INTERNAL = ['snc_internal'];
const FULFILLERS = [...REQUEST_WRITE_ROLES, ROLES.admin];

const ops = (name: string, operations: AclOperation[], extra: Partial<AclDef>): AclDef[] =>
  operations.map((operation) => ({ name, operation, ...extra }));

// ------------------------------------------------------------------ helpers

function itemCatalogs(ctx: Context, item: Rec): string[] {
  const ids = new Set(splitList(item.str('sc_catalogs')));
  const sys = ctx.platform.systemContext();
  if (item.str('category')) {
    const c = sys.get(T.category, item.str('category'))?.str('sc_catalog');
    if (c) ids.add(c);
  }
  if (!item.isNew())
    for (const l of sys.query(T.itemCatalog, { query: `sc_cat_item=${item.sysId}` }))
      ids.add(l.str('sc_catalog'));
  return [...ids];
}

/** Catalog admins, and managers / editors of one of the item's catalogs. */
export function canManageItem(ctx: Context, item: Rec | null, level: 'manager' | 'editor'): boolean {
  if (ctx.hasRole(ROLES.admin)) return true;
  if (!item) return ctx.hasAnyRole(level === 'manager' ? [ROLES.manager] : [ROLES.manager, ROLES.editor]);
  return itemCatalogs(ctx, item).some((c) => catalogRoleScope(ctx, c, level));
}

function itemOf(ctx: Context, id: string): Rec | null {
  return id ? ctx.platform.systemContext().get(T.item, id) : null;
}

/** Records hanging off an item (variables, links, steps): managed with the item. */
const viaItem =
  (field: string, level: 'manager' | 'editor') =>
  (rec: Rec | null, ctx: Context): boolean => {
    if (ctx.hasRole(ROLES.admin)) return true;
    if (!rec) return ctx.hasAnyRole([ROLES.manager, ROLES.editor]);
    const itemId = rec.str(field);
    return !!itemId && canManageItem(ctx, itemOf(ctx, itemId), level);
  };

function categoryScope(ctx: Context, cat: Rec | null, level: 'manager' | 'editor'): boolean {
  if (ctx.hasRole(ROLES.admin)) return true;
  if (!cat) return ctx.hasAnyRole([ROLES.manager, ROLES.editor]);
  let catalog = cat.str('sc_catalog');
  if (!catalog && cat.str('parent'))
    catalog = ctx.platform.systemContext().get(T.category, cat.str('parent'))?.str('sc_catalog') ?? '';
  return catalogRoleScope(ctx, catalog, level);
}

const isOwnRequest = (rec: Rec | null, ctx: Context): boolean => {
  const me = ctx.user.sysId;
  if (!rec || !me) return false;
  if (rec.str('opened_by') === me || rec.str('requested_for') === me) return true;
  if (rec.has('request') && rec.str('request')) {
    const req = ctx.platform.systemContext().get(T.request, rec.str('request'));
    if (req && req.str('requested_for') === me) return true;
  }
  return false;
};

/** Approvers (and their delegates) read the record they are asked to approve. */
const isApprover = (rec: Rec | null, ctx: Context): boolean => {
  const me = ctx.user.sysId;
  if (!rec || !me || !ctx.platform.registry.has(T.approval)) return false;
  const rows = ctx.platform.systemContext().query(T.approval, { query: `document_id=${rec.sysId}` });
  if (rows.some((r) => r.str('approver') === me)) return true;
  if (!ctx.platform.registry.has('sys_user_delegate')) return false;
  const approvers = new Set(rows.map((r) => r.str('approver')));
  return ctx.platform
    .systemContext()
    .query('sys_user_delegate', { query: `delegate=${me}` })
    .some((d) => approvers.has(d.str('user')));
};

/** Answers (sc_item_option) are readable with the requested item or cart line they belong to. */
const optionOwnerReadable = (optionId: string, ctx: Context): boolean => {
  const sys = ctx.platform.systemContext();
  for (const link of sys.query(T.optionLink, { query: `sc_item_option=${optionId}` })) {
    if (link.str('request_item') && ctx.get(T.ritm, link.str('request_item'))) return true;
    if (
      link.str('cart_item') &&
      sys.get(T.cartItem, link.str('cart_item'))?.ref('cart')?.str('user') === ctx.user.sysId
    )
      return true;
  }
  return false;
};

/** Masked answers are revealed to catalog_view_masked holders and to the requester. */
const maskedReadable = (rec: Rec | null, ctx: Context, owner: () => Rec | null): boolean => {
  if (!rec) return true;
  const q = rec.ref(rec.has('question') ? 'question' : 'item_option_new');
  if (!q || q.num('type') !== VT.masked) return true;
  if (ctx.hasRole(ROLES.viewMasked)) return true;
  const o = owner();
  const me = ctx.user.sysId;
  return (
    !!o &&
    !!me &&
    (o.str('opened_by') === me ||
      (o.has('requested_for') && o.str('requested_for') === me) ||
      (o.has('caller_id') && o.str('caller_id') === me) ||
      (o.has('user') && o.str('user') === me))
  );
};

function optionOwner(ctx: Context, optionId: string): Rec | null {
  const sys = ctx.platform.systemContext();
  const link = sys.first(T.optionLink, `sc_item_option=${optionId}`);
  if (!link) return null;
  if (link.str('request_item')) return sys.get(T.ritm, link.str('request_item'));
  return link.ref('cart_item')?.ref('cart') ?? null;
}

const targetReadable =
  (tableField: string, idField: string) =>
  (rec: Rec | null, ctx: Context): boolean => {
    if (!rec) return true;
    const table = rec.str(tableField);
    return !!table && ctx.platform.registry.has(table) && !!ctx.get(table, rec.str(idField));
  };

// --------------------------------------------------------------------- ACLs

/** Catalog definition tables that hang off an item through a reference field. */
const ITEM_CHILDREN: [string, string][] = [
  [T.variable, 'cat_item'],
  [T.setItem, 'sc_cat_item'],
  [T.itemCategory, 'sc_cat_item'],
  [T.itemCatalog, 'sc_cat_item'],
  [T.itemAvailable, 'sc_cat_item'],
  [T.itemNotAvailable, 'sc_cat_item'],
  [T.appUser, 'sc_cat_item'],
  [T.appGroup, 'sc_cat_item'],
  [T.uiPolicy, 'catalog_item'],
  [T.clientScript, 'cat_item'],
  [T.step, 'cat_item'],
  [T.guideRule, 'guide'],
];

const definitionAcls: AclDef[] = [
  // Catalogs and categories: readable by every internal user (item visibility is enforced per item).
  { name: T.catalog, operation: 'read', roles: INTERNAL },
  { name: T.catalog, operation: 'create', roles: [ROLES.admin] },
  { name: T.catalog, operation: 'write', roles: [ROLES.admin] },
  {
    name: T.catalog,
    operation: 'write',
    script: (rec, ctx) => !!rec && catalogRoleScope(ctx, rec.sysId, 'editor'),
    description: 'Managers and editors of the catalog',
  },
  { name: T.catalog, operation: 'delete', roles: [ROLES.admin] },
  {
    name: T.catalog,
    operation: 'delete',
    script: (rec, ctx) => !!rec && catalogRoleScope(ctx, rec.sysId, 'manager'),
    description: 'Manager of the catalog',
  },
  {
    name: `${T.catalog}.manager`,
    operation: 'write',
    script: (rec, ctx) => ctx.hasRole(ROLES.admin) || (!!rec && catalogRoleScope(ctx, rec.sysId, 'manager')),
    description: 'Only catalog admins and the current manager hand the catalog over',
  },
  { name: T.category, operation: 'read', roles: INTERNAL },
  ...ops(T.category, ['create', 'write'], {
    script: (rec, ctx) => categoryScope(ctx, rec, 'editor'),
    description: 'Catalog admins, managers and editors',
  }),
  {
    name: T.category,
    operation: 'delete',
    script: (rec, ctx) => categoryScope(ctx, rec, 'manager'),
    description: 'Catalog admins and managers',
  },

  // Items: visible items for everyone, all items for catalog staff and fulfillers.
  { name: T.item, operation: 'read', roles: [ROLES.admin, ROLES.manager, ROLES.editor, 'itil'] },
  {
    name: T.item,
    operation: 'read',
    script: (rec, ctx) => !rec || new CatalogAccess(ctx).canViewItem(rec, { view: 'both' }),
    description: 'Items the user may order (user criteria)',
  },
  ...ops(T.item, ['create', 'write'], {
    script: (rec, ctx) => canManageItem(ctx, rec, 'editor'),
    description: 'Catalog admins, managers and editors of the item catalogs',
  }),
  {
    name: T.item,
    operation: 'delete',
    script: (rec, ctx) => canManageItem(ctx, rec, 'manager'),
    description: 'Catalog admins and managers of the item catalogs',
  },

  // Variables, links and steps follow their item.
  ...ITEM_CHILDREN.flatMap(([table, field]): AclDef[] => [
    { name: table, operation: 'read', roles: [ROLES.admin, ROLES.manager, ROLES.editor, 'itil'] },
    ...ops(table, ['create', 'write'], { script: viaItem(field, 'editor') }),
    { name: table, operation: 'delete', script: viaItem(field, 'manager') },
  ]),
  // Variables and their choices are part of every orderable form.
  { name: T.variable, operation: 'read', roles: INTERNAL },
  { name: T.uiPolicy, operation: 'read', roles: INTERNAL },
  { name: T.clientScript, operation: 'read', roles: INTERNAL },
  { name: T.setItem, operation: 'read', roles: INTERNAL },
  { name: T.choice, operation: 'read', roles: INTERNAL },
  ...ops(T.choice, ['create', 'write', 'delete'], {
    script: (rec, ctx) => {
      if (ctx.hasRole(ROLES.admin)) return true;
      if (!rec) return ctx.hasAnyRole([ROLES.manager, ROLES.editor]);
      const q = rec.ref('question');
      return !!q && !!q.str('cat_item') && canManageItem(ctx, itemOf(ctx, q.str('cat_item')), 'editor');
    },
  }),
  { name: T.uiPolicyAction, operation: 'read', roles: INTERNAL },
  ...ops(T.uiPolicyAction, ['create', 'write', 'delete'], {
    script: (rec, ctx) => {
      if (ctx.hasRole(ROLES.admin)) return true;
      const p = rec?.ref('ui_policy');
      return (
        !!p && !!p.str('catalog_item') && canManageItem(ctx, itemOf(ctx, p.str('catalog_item')), 'editor')
      );
    },
  }),
  // Variable sets and user criteria: shared building blocks, created by catalog admins only.
  { name: T.variableSet, operation: 'read', roles: INTERNAL },
  ...ops(T.variableSet, ['create', 'write', 'delete'], { roles: [ROLES.admin] }),
  { name: T.criteria, operation: 'read', roles: [ROLES.admin, ROLES.manager, ROLES.editor] },
  ...ops(T.criteria, ['create', 'write', 'delete'], { roles: [ROLES.admin, 'user_criteria_admin'] }),
  { name: T.software, operation: 'read', roles: INTERNAL },
  ...ops(T.software, ['create', 'write', 'delete'], { roles: [ROLES.admin] }),
  ...[T.deliveryPlan, T.deliveryTask].flatMap((t): AclDef[] => [
    { name: t, operation: 'read', roles: [ROLES.admin, ROLES.manager, ROLES.editor, 'itil'] },
    ...ops(t, ['create', 'write', 'delete'], { roles: [ROLES.admin] }),
  ]),
];

const requestAcls: AclDef[] = [
  // Requests
  { name: T.request, operation: 'read', roles: REQUEST_READ_ROLES },
  {
    name: T.request,
    operation: 'read',
    condition: `opened_by=${ME}`,
    description: 'Openers read their requests',
  },
  {
    name: T.request,
    operation: 'read',
    condition: `requested_for=${ME}`,
    description: 'Requested-for users read their requests',
  },
  { name: T.request, operation: 'read', condition: `watch_listLIKE${ME}`, description: 'Watch list members' },
  { name: T.request, operation: 'read', script: isApprover, description: 'Approvers of the request' },
  { name: T.request, operation: 'write', roles: FULFILLERS },
  {
    name: T.request,
    operation: 'write',
    script: (rec, ctx) => !!rec && rec.bool('active') && isOwnRequest(rec, ctx),
    description: 'Requesters comment on their open requests',
  },
  { name: T.request, operation: 'create', roles: FULFILLERS },
  { name: T.request, operation: 'delete', roles: ['admin'] },
  { name: `${T.request}.*`, operation: 'write', roles: FULFILLERS },
  {
    name: `${T.request}.watch_list`,
    operation: 'write',
    script: (rec, ctx) => ctx.hasAnyRole(FULFILLERS) || isOwnRequest(rec, ctx),
  },
  {
    name: `${T.request}.special_instructions`,
    operation: 'write',
    script: (rec, ctx) => ctx.hasAnyRole(FULFILLERS) || isOwnRequest(rec, ctx),
  },
  { name: `${T.request}.work_notes`, operation: 'read', roles: REQUEST_READ_ROLES },

  // Requested items
  { name: T.ritm, operation: 'read', roles: REQUEST_READ_ROLES },
  { name: T.ritm, operation: 'read', condition: `opened_by=${ME}`, description: 'Openers read their items' },
  {
    name: T.ritm,
    operation: 'read',
    condition: `requested_for=${ME}`,
    description: 'Requested-for users read their items',
  },
  {
    name: T.ritm,
    operation: 'read',
    condition: `request.requested_for=${ME}`,
    description: 'The request owner reads its items',
  },
  { name: T.ritm, operation: 'read', condition: `watch_listLIKE${ME}`, description: 'Watch list members' },
  { name: T.ritm, operation: 'read', condition: `assigned_to=${ME}` },
  { name: T.ritm, operation: 'read', script: isApprover, description: 'Approvers of the item' },
  { name: T.ritm, operation: 'write', roles: FULFILLERS },
  {
    name: T.ritm,
    operation: 'write',
    script: (rec, ctx) => !!rec && rec.bool('active') && isOwnRequest(rec, ctx),
    description: 'Requesters comment on their open items',
  },
  { name: T.ritm, operation: 'create', roles: FULFILLERS },
  { name: T.ritm, operation: 'delete', roles: ['admin'] },
  { name: `${T.ritm}.*`, operation: 'write', roles: FULFILLERS },
  {
    name: `${T.ritm}.watch_list`,
    operation: 'write',
    script: (rec, ctx) => ctx.hasAnyRole(FULFILLERS) || isOwnRequest(rec, ctx),
  },
  {
    name: `${T.ritm}.quantity`,
    operation: 'write',
    script: (rec, ctx) => {
      if (!ctx.hasAnyRole(FULFILLERS)) return false;
      if (rec?.str('approval') !== 'approved') return true;
      return (
        !ctx.platform.properties.getBool('glide.sc.restrict.quantity.changes', true) ||
        ctx.hasRole(ROLES.admin)
      );
    },
    description:
      'Quantity is locked after approval except for catalog admins (glide.sc.restrict.quantity.changes)',
  },
  { name: `${T.ritm}.work_notes`, operation: 'read', roles: REQUEST_READ_ROLES },

  // Catalog tasks: fulfillers, and the person a task is assigned to.
  { name: T.task, operation: 'read', roles: REQUEST_READ_ROLES },
  {
    name: T.task,
    operation: 'read',
    condition: `assigned_to=${ME}`,
    description: 'Assignees read their tasks',
  },
  { name: T.task, operation: 'write', roles: FULFILLERS },
  {
    name: T.task,
    operation: 'write',
    condition: `assigned_to=${ME}`,
    description: 'Assignees work their tasks',
  },
  { name: T.task, operation: 'create', roles: FULFILLERS },
  { name: T.task, operation: 'delete', roles: ['admin'] },
  { name: `${T.task}.*`, operation: 'write', roles: FULFILLERS },
  ...['state', 'close_notes', 'work_notes', 'comments'].map(
    (f): AclDef => ({ name: `${T.task}.${f}`, operation: 'write', roles: FULFILLERS }),
  ),
  ...['state', 'close_notes'].map(
    (f): AclDef => ({
      name: `${T.task}.${f}`,
      operation: 'write',
      condition: `assigned_to=${ME}`,
      description: 'Assignees close their tasks',
    }),
  ),
];

const cartAcls: AclDef[] = [
  ...ops(T.cart, ['read', 'write', 'create', 'delete'], {
    condition: `user=${ME}`,
    description: 'Users own their carts',
  }),
  ...ops(T.cart, ['read', 'write', 'create', 'delete'], { roles: [ROLES.admin] }),
  ...ops(T.cartItem, ['read', 'write', 'create', 'delete'], {
    condition: `cart.user=${ME}`,
    description: 'Lines of the user carts',
  }),
  ...ops(T.cartItem, ['read', 'write', 'create', 'delete'], { roles: [ROLES.admin] }),

  // Answers
  { name: T.option, operation: 'read', roles: [...REQUEST_READ_ROLES] },
  {
    name: T.option,
    operation: 'read',
    script: (rec, ctx) => !rec || optionOwnerReadable(rec.sysId, ctx),
    description: 'Answers of readable requested items and own cart lines',
  },
  ...ops(T.option, ['write', 'create'], { roles: FULFILLERS }),
  { name: T.option, operation: 'delete', roles: [ROLES.admin] },
  {
    name: `${T.option}.value`,
    operation: 'read',
    script: (rec, ctx) => maskedReadable(rec, ctx, () => (rec ? optionOwner(ctx, rec.sysId) : null)),
    description: 'Masked answers',
  },
  { name: T.optionLink, operation: 'read', roles: [...REQUEST_READ_ROLES] },
  {
    name: T.optionLink,
    operation: 'read',
    script: (rec, ctx) => !rec || optionOwnerReadable(rec.str('sc_item_option'), ctx),
  },
  ...ops(T.optionLink, ['write', 'create', 'delete'], { roles: [ROLES.admin] }),
  { name: T.answer, operation: 'read', roles: [...REQUEST_READ_ROLES] },
  {
    name: T.answer,
    operation: 'read',
    script: targetReadable('table_name', 'table_sys_id'),
    description: 'Answers of readable records',
  },
  ...ops(T.answer, ['write', 'create'], { roles: FULFILLERS }),
  { name: T.answer, operation: 'delete', roles: [ROLES.admin] },
  {
    name: `${T.answer}.value`,
    operation: 'read',
    script: (rec, ctx) =>
      maskedReadable(rec, ctx, () =>
        rec && ctx.platform.registry.has(rec.str('table_name'))
          ? ctx.platform.systemContext().get(rec.str('table_name'), rec.str('table_sys_id'))
          : null,
      ),
  },
  { name: T.mrvsAnswer, operation: 'read', roles: [...REQUEST_READ_ROLES] },
  { name: T.mrvsAnswer, operation: 'read', script: targetReadable('parent_table_name', 'parent_id') },
  ...ops(T.mrvsAnswer, ['write', 'create'], { roles: FULFILLERS }),
  { name: T.mrvsAnswer, operation: 'delete', roles: [ROLES.admin] },
  { name: T.produced, operation: 'read', roles: [...REQUEST_READ_ROLES] },
  ...ops(T.produced, ['write', 'create', 'delete'], { roles: [ROLES.admin] }),
];

export const CATALOG_ACLS: AclDef[] = [...definitionAcls, ...requestAcls, ...cartAcls];
