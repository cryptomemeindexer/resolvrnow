import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../../api/http.js';
import type { Context } from '../../engine/context.js';
import type { AppModule, RoleDef } from '../../engine/module.js';
import type { PropertyDef } from '../../engine/services/properties.js';
import { SERVICES } from '../contracts.js';
import { taskStates } from '../task/index.js';
import { CATALOG_ACLS } from './acls.js';
import { registerServiceCatalogApi } from './api.js';
import { PROP, T } from './constants.js';
import { seedCatalogDemo } from './demo.js';
import { registerPortalCatalogApi } from './portal.js';
import { CATALOG_QUERY_RULES, CATALOG_RULES } from './rules.js';
import { CatalogService } from './service.js';
import { CATALOG_TABLES } from './tables.js';
import { CATALOG_UI, pruneCatalogRelatedLists } from './ui.js';

export { CatalogAccess } from './access.js';
export type { CheckoutOptions, LineInput, OrderResult } from './ordering.js';
export { CatalogService } from './service.js';

const roles: RoleDef[] = [
  {
    name: 'catalog_admin',
    description: 'Manages catalogs, categories, items, variables, variable sets and user criteria',
    contains: ['catalog', 'user_criteria_admin', 'catalog_lookup_admin'],
  },
  { name: 'catalog_manager', description: 'Manages the catalogs where the user is the manager' },
  { name: 'catalog_editor', description: 'Edits the catalogs where the user is an editor' },
  { name: 'catalog', description: 'Member of a catalog fulfillment group' },
  { name: 'catalog_view_masked', description: 'Can reveal masked catalog variable values' },
  { name: 'catalog_lookup_admin', description: 'Maintains catalog lookup data' },
  { name: 'user_criteria_admin', description: 'Maintains user criteria' },
  { name: 'sn_request_read', description: 'Reads requests, requested items and catalog tasks' },
  {
    name: 'sn_request_write',
    description: 'Works requests, requested items and catalog tasks',
    contains: ['sn_request_read'],
  },
  { name: 'sn_request_comment_write', description: 'Comments on requests' },
  {
    name: 'sn_service_desk_agent',
    description: 'Service desk agent for requests',
    contains: ['sn_request_write'],
  },
];

const p = (
  name: string,
  value: string,
  description: string,
  type: PropertyDef['type'] = 'string',
): PropertyDef => ({ name, value, type, description });

const properties: PropertyDef[] = [
  p(
    'glide.sc.checkout.twostep',
    'false',
    'Two-step checkout: checkout returns a review summary and submit_order places the order',
    'boolean',
  ),
  p(
    'glide.sc.enable_order_now',
    'true',
    'Order Now uses a temporary cart and leaves the default cart untouched',
    'boolean',
  ),
  p(
    'glide.sc.use_user_criteria',
    'true',
    'Use Available For / Not Available For user criteria for catalog access',
    'boolean',
  ),
  p(
    'glide.sc.producer.redirect_url',
    'generated_record',
    'Where users land after submitting a record producer (generated_record or catalog_home)',
  ),
  p(
    'glide.sc.item.not_normal_cart_item',
    'sc_cat_item_guide,sc_cat_item_producer,sc_cat_item_wizard',
    'Item classes that never become cart lines',
  ),
  p(
    'glide.sc.item.cannot_add_to_request',
    'sc_cat_item_guide,sc_cat_item_producer,sc_cat_item_wizard',
    'Item classes that cannot be added to an existing request',
  ),
  p(
    'glide.sc.item.cannot_show_price',
    'sc_cat_item_guide,sc_cat_item_producer',
    'Item classes whose price is never shown',
  ),
  p(
    'glide.sc.item.order_guide_exclusion',
    'sc_cat_item_guide,sc_cat_item_content',
    'Item classes order guides never include',
  ),
  p('glide.sc.allow.quantity', '', 'Roles allowed to change the quantity (blank: everyone)'),
  p(
    'glide.sc.restrict.quantity.changes',
    'true',
    'Lock the quantity of approved requested items except for catalog admins',
    'boolean',
  ),
  p('glide.sc.price.display', 'nonzero', 'When prices are shown: always, nonzero or never'),
  p('glide.sc.req_for.roles', '', 'Roles allowed to request items for other users'),
  p(
    'glide.sc.req_for.roles.default',
    'allow',
    'When glide.sc.req_for.roles is blank: allow or deny requesting for others',
  ),
  p(
    'glide.sc.remove_inactive_cat_items_from_cart',
    'false',
    'Remove inactive items from carts when they are read',
    'boolean',
  ),
  p(
    'glide.sc.round.delivery.times',
    'false',
    'Round delivery estimates over one day to whole days',
    'boolean',
  ),
  p(
    'glide.sc.ui_policy.variable_set_run_first',
    'false',
    'Run variable set UI policies before item UI policies',
    'boolean',
  ),
  p(PROP.currency, 'USD', 'Currency code used for catalog prices'),
  p(
    PROP.requestApprovalThreshold,
    '-1',
    "Requests whose total price exceeds this amount need the requested-for user's manager approval (-1 disables)",
  ),
  p(PROP.defaultCatalog, '', 'sys_id of the default catalog'),
  p(
    PROP.maskedKey,
    '',
    'Instance key for masked variable encryption (generated; RESOLVRNOW_ENCRYPTION_KEY overrides it)',
    'password',
  ),
];

const events = [
  {
    name: 'sc_request.requested_for',
    table: T.request,
    description: 'A request was opened on behalf of another user (parm1: that user)',
  },
  { name: 'sc_request.approved', table: T.request, description: 'A request was approved' },
  { name: 'sc_request.assigned', table: T.request, description: 'A request was assigned' },
  {
    name: 'sc_request.updated',
    table: T.request,
    description: 'The request state changed (parm1: new request_state)',
  },
  { name: 'sc_req_item.assigned', table: T.ritm, description: 'A requested item was assigned' },
  { name: 'sc_req_item.delivery', table: T.ritm, description: 'A requested item reached the delivery stage' },
  { name: 'sc_req_item.commented', table: T.ritm, description: 'A comment was added to a requested item' },
  { name: 'sc_task.assigned.to.user', table: T.task, description: 'A catalog task was assigned to a person' },
  { name: 'sc_task.assigned.to.group', table: T.task, description: 'A catalog task was assigned to a group' },
];

/** Required reference data: the default catalog. */
function seedCatalog(ctx: Context): void {
  const catalog =
    ctx.first(T.catalog, 'title=Service Catalog') ??
    ctx.insert(T.catalog, {
      title: 'Service Catalog',
      description: 'Order products and services',
      active: true,
    });
  if (!ctx.platform.properties.get(PROP.defaultCatalog))
    ctx.platform.properties.set(PROP.defaultCatalog, catalog.sysId);
}

/** Catalogs, items, variables, cart, requests and fulfillment. */
export const catalogModule: AppModule = {
  id: 'catalog',
  name: 'Service Catalog & Request Management',
  description: 'Catalogs, items, variables, cart, requests and fulfillment.',
  dependsOn: ['task'],
  tables: CATALOG_TABLES,
  roles,
  acls: CATALOG_ACLS,
  rules: [...CATALOG_RULES, ...CATALOG_QUERY_RULES],
  properties,
  events,
  ui: CATALOG_UI,
  register(platform) {
    const states = taskStates(platform);
    for (const t of [T.request, T.ritm, T.task])
      states.register(t, { closed: ['3', '4', '7'], defaultClosed: '3' });
    platform.services.set(SERVICES.catalog, new CatalogService(platform));
    pruneCatalogRelatedLists(platform);
  },
  afterBoot(platform) {
    const svc = platform.service<CatalogService>(SERVICES.catalog);
    svc.fulfillment.registerApprovalHandlers();
    svc.fulfillment.registerFlowActions();
  },
  seedVersion: 1,
  seed: seedCatalog,
  demo: seedCatalogDemo,
  http(app, deps) {
    registerServiceCatalogApi(app as FastifyInstance, deps as ApiDeps);
    registerPortalCatalogApi(app as FastifyInstance, deps as ApiDeps);
  },
};
