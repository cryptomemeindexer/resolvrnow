import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../../api/http.js';
import type { AppModule } from '../../engine/module.js';
import type { BusinessRuleDef } from '../../engine/rules.js';
import { addMs, nowGlide } from '../../engine/util.js';
import { taskStates } from '../task/index.js';
import { PORTAL_ACLS, PORTAL_QUERY_RULES } from './acls.js';
import { registerPortalApi } from './api.js';
import { PROPS, ROLES, T, UR_REASON, UR_STATE } from './constants.js';
import { registerDemoLinking, seedPortalDemo } from './demo.js';
import { seedPortal } from './seed.js';
import { evaluateSurveyTriggers, expireSurveys, invalidateSurveyTriggers } from './surveys.js';
import { PORTAL_TABLES } from './tables.js';
import { isSelfOrDescendant, topicPath } from './taxonomy.js';
import { PORTAL_UI } from './ui.js';
import { autoCloseUnconfirmed, registerUrHooks } from './ur.js';
import { firstLine } from './util.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const rules: BusinessRuleDef[] = [
  {
    name: 'Topic: parent loop guard',
    table: T.topic,
    when: 'before',
    actions: ['insert', 'update'],
    order: 50,
    condition: (cur) => cur.changed('parent_topic') && !!cur.str('parent_topic'),
    run(cur, _prev, ctx) {
      if (isSelfOrDescendant(ctx, cur.sysId, cur.str('parent_topic')))
        cur.abort('A topic cannot be placed under itself or one of its sub-topics');
    },
  },
  {
    name: 'Topic: maintain path',
    table: T.topic,
    when: 'before',
    actions: ['insert', 'update'],
    order: 100,
    condition: (cur) => cur.isNew() || cur.changed('name') || cur.changed('parent_topic'),
    run(cur, _prev, ctx) {
      cur.setRaw('topic_path', topicPath(ctx, cur));
      if (!cur.str('taxonomy') && cur.str('parent_topic'))
        cur.setRaw('taxonomy', cur.ref('parent_topic')?.str('taxonomy') || null);
    },
  },
  {
    name: 'Topic: refresh sub-topic paths',
    table: T.topic,
    when: 'after',
    actions: ['update'],
    order: 100,
    condition: (cur) => cur.changed('name') || cur.changed('parent_topic'),
    run(cur, _prev, ctx) {
      const sys = ctx.elevated();
      for (const child of sys.query(T.topic, { query: `parent_topic=${cur.sysId}` }))
        sys.update(child, { topic_path: topicPath(sys, child) });
    },
  },
  {
    name: 'Connected content: type and target',
    table: T.content,
    when: 'before',
    actions: ['insert', 'update'],
    order: 100,
    run(cur) {
      if (!cur.str('content_type')) {
        const type = cur.str('catalog_item')
          ? 'catalog'
          : cur.str('knowledge')
            ? 'knowledge'
            : cur.str('quick_link')
              ? 'quick_link'
              : '';
        if (type) cur.setRaw('content_type', type);
      }
      const field = (
        { catalog: 'catalog_item', knowledge: 'knowledge', quick_link: 'quick_link' } as Record<
          string,
          string
        >
      )[cur.str('content_type')];
      if (!field || !cur.str(field))
        cur.abort(
          'Connected content needs a catalog item, a knowledge article or a quick link matching its content type',
        );
    },
  },
  {
    name: 'Favorite: one per user and record',
    table: T.favorite,
    when: 'before',
    actions: ['insert'],
    order: 100,
    run(cur, _prev, ctx) {
      if (ctx.elevated().first(T.favorite, `user=${cur.str('user')}^document=${cur.str('document')}`))
        cur.abort('Already a favorite');
    },
  },
  {
    name: 'Universal request: defaults',
    table: T.ur,
    when: 'before',
    actions: ['insert'],
    order: 50,
    run(cur, _prev, ctx) {
      if (!cur.str('opened_for')) cur.setRaw('opened_for', cur.str('opened_by') || ctx.user.sysId);
      if (!cur.str('short_description') && cur.str('description'))
        cur.setRaw('short_description', firstLine(cur.str('description'), 160));
      if (!cur.str('primary_task') && !cur.str('state_reason') && cur.str('state') === UR_STATE.NEW)
        cur.setRaw('state_reason', UR_REASON.ROUTING);
    },
  },
  {
    name: 'Survey: send when a ticket closes',
    table: 'task',
    when: 'after',
    actions: ['update'],
    order: 1000,
    description: 'Evaluates survey trigger conditions (asmt_condition) and sends a survey to the requester',
    condition: (cur) => cur.changed('state') || cur.changed('active'),
    run(cur, prev, ctx) {
      evaluateSurveyTriggers(ctx, cur, prev);
    },
  },
  {
    name: 'Survey instance: due date',
    table: T.instance,
    when: 'before',
    actions: ['insert'],
    order: 100,
    condition: (cur) => !cur.str('due_date'),
    run(cur) {
      const days = cur.ref('metric_type')?.num('due_days') ?? 14;
      cur.setRaw('due_date', addMs(nowGlide(), days * DAY));
    },
  },
];

/** Employee portal: taxonomy, universal requests, surveys, favorites and the portal APIs. */
export const portalModule: AppModule = {
  id: 'portal',
  name: 'Employee Portal',
  description: 'Self-service portal APIs: taxonomy, universal requests, surveys, favorites.',
  dependsOn: ['task'],
  tables: PORTAL_TABLES,
  roles: [
    {
      name: ROLES.portalAdmin,
      description: 'Administers the employee portal',
      contains: [ROLES.taxonomyAdmin, ROLES.tourAdmin],
    },
    { name: ROLES.taxonomyAdmin, description: 'Maintains portal topics and connected content' },
    { name: ROLES.tourAdmin, description: 'Maintains guided tours' },
    { name: ROLES.routingAgent, description: 'Triages universal requests and routes them to departments' },
    {
      name: ROLES.urAdmin,
      description: 'Configures universal request departments, services and state mapping',
      contains: [ROLES.routingAgent],
    },
    {
      name: ROLES.surveyAdmin,
      description: 'Creates surveys and reviews every answer',
      contains: [ROLES.surveyReader],
    },
    { name: ROLES.surveyReader, description: 'Reads survey results' },
    { name: 'itil', contains: [ROLES.surveyReader] },
  ],
  acls: PORTAL_ACLS,
  rules: [...rules, ...PORTAL_QUERY_RULES],
  properties: [
    {
      name: PROPS.confirmDays,
      value: '5',
      type: 'integer',
      description:
        'Days a requester has to confirm a resolved universal request before it closes automatically',
    },
    {
      name: PROPS.copyFields,
      value: 'caller_id=opened_for',
      description:
        'Fields copied from a universal request to the incident it is routed to (incident_field=ur_field, comma separated)',
    },
    {
      name: PROPS.streamLimit,
      value: '100',
      type: 'integer',
      description: 'Maximum activity entries shown on a portal ticket page',
    },
    {
      name: PROPS.supportPhone,
      value: '',
      description: 'Support phone number shown on the portal home page',
    },
    {
      name: PROPS.supportEmail,
      value: '',
      description: 'Support email address shown on the portal home page',
    },
    { name: PROPS.supportHours, value: '', description: 'Support hours shown on the portal home page' },
    {
      name: PROPS.catalogRequiresTopic,
      value: 'false',
      type: 'boolean',
      description: 'Portal search only returns catalog items connected to a topic',
    },
    {
      name: PROPS.surveysEnabled,
      value: 'true',
      type: 'boolean',
      description: 'Send satisfaction surveys when tickets close',
    },
    {
      name: PROPS.recentItems,
      value: '5',
      type: 'integer',
      description: 'Number of recent items on the portal home page',
    },
    {
      name: PROPS.popularDays,
      value: '90',
      type: 'integer',
      description: 'Days of orders counted for the Popular sort on topic pages',
    },
  ],
  events: [
    {
      name: 'universal_request.routed',
      table: T.ur,
      description:
        'A universal request was routed to a department table (parm1: primary sys_id, parm2: table)',
    },
    {
      name: 'survey.instance.ready',
      table: T.instance,
      description: 'A survey was sent to a user (parm1: user, parm2: ticket number)',
    },
  ],
  jobs: [
    {
      id: 'portal.ur_confirm_autoclose',
      name: 'Close unconfirmed universal requests',
      intervalMs: HOUR,
      description: 'Closes universal requests whose requester did not confirm the outcome in time',
      run: (ctx) => {
        autoCloseUnconfirmed(ctx);
      },
    },
    {
      id: 'portal.survey_expiry',
      name: 'Expire overdue surveys',
      intervalMs: DAY,
      description: 'Cancels survey instances that were not taken before their due date',
      run: (ctx) => {
        expireSurveys(ctx);
      },
    },
  ],
  ui: PORTAL_UI,
  register(platform) {
    taskStates(platform).register(T.ur, {
      closed: [UR_STATE.CLOSED, UR_STATE.CANCELED],
      defaultClosed: UR_STATE.CLOSED,
    });
    registerUrHooks(platform);
    registerDemoLinking(platform);
    platform.hooks.on(['insert', 'update', 'delete'], T.trigger, 'portal: survey trigger cache', () =>
      invalidateSurveyTriggers(platform),
    );
  },
  seedVersion: 1,
  seed: seedPortal,
  demo: seedPortalDemo,
  http(app, deps) {
    registerPortalApi(app as FastifyInstance, deps as ApiDeps);
  },
};
