import type { Context } from '../../engine/context.js';
import { DEFAULT_STATE_MAPPING, DEFAULT_SURVEY, OVERALL_METRIC, T } from './constants.js';
import { q } from './util.js';

/** Reference data: UR state mapping, the IT department and its services, the satisfaction survey. */
export function seedPortal(ctx: Context): void {
  for (const m of DEFAULT_STATE_MAPPING) {
    for (const state of m.states) {
      if (ctx.first(T.urMapping, `primary_table=${m.table}^primary_state=${q(state)}`)) continue;
      ctx.insert(T.urMapping, {
        primary_table: m.table,
        primary_state: state,
        ur_state: m.ur,
        ur_state_reason: m.reason ?? '',
        active: true,
      });
    }
  }

  const it =
    ctx.first(T.urDepartment, 'name=IT') ??
    ctx.insert(T.urDepartment, {
      name: 'IT',
      description: 'Devices, software, accounts, network and workplace technology',
      active: true,
    });
  for (const s of [
    { name: 'IT incident', table: 'incident' },
    { name: 'IT request', table: 'sc_req_item' },
  ]) {
    if (!ctx.first(T.urService, `name=${q(s.name)}`))
      ctx.insert(T.urService, { name: s.name, department: it.sysId, table_name: s.table, active: true });
  }

  const survey =
    ctx.first(T.survey, `name=${q(DEFAULT_SURVEY)}`) ??
    ctx.insert(T.survey, {
      name: DEFAULT_SURVEY,
      description: 'Short satisfaction survey sent to the requester when a ticket closes.',
      evaluation_method: 'survey',
      due_days: 14,
      active: true,
    });
  const questions = [
    {
      name: OVERALL_METRIC,
      question: 'Overall, how satisfied are you with how your request was handled?',
      datatype: 'scale',
      mandatory: true,
      order: 10,
    },
    {
      name: 'Met expectations',
      question: 'Did the outcome meet your expectations?',
      datatype: 'boolean',
      mandatory: false,
      order: 20,
    },
    {
      name: 'Comments',
      question: 'Anything you would like to tell us?',
      datatype: 'string',
      mandatory: false,
      order: 30,
    },
  ];
  for (const qn of questions) {
    if (ctx.first(T.question, `metric_type=${survey.sysId}^name=${q(qn.name)}`)) continue;
    ctx.insert(T.question, {
      ...qn,
      metric_type: survey.sysId,
      scale_min: 1,
      scale_max: 5,
      weight: 1,
      active: true,
    });
  }
  const triggers = [
    { table: 'incident', condition: 'state=7', user_field: 'caller_id' },
    { table: 'sc_req_item', condition: 'state=3', user_field: 'requested_for' },
    { table: T.ur, condition: 'state=4', user_field: 'opened_for' },
  ];
  for (const tr of triggers) {
    if (ctx.first(T.trigger, `metric_type=${survey.sysId}^table=${tr.table}`)) continue;
    ctx.insert(T.trigger, {
      ...tr,
      metric_type: survey.sysId,
      probability: 100,
      repeat_interval_days: 0,
      active: true,
    });
  }
}
