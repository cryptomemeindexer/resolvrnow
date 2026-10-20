/**
 * Minimal ITSM tables (incident, problem, change, knowledge) built from the shared
 * schema, so the AI module can be exercised without the ITSM application modules.
 * Used by the AI tests only; never part of ALL_MODULES.
 */
import type { AppModule } from '../../engine/module.js';
import type { ChoiceDef } from '../../engine/types.js';
import { sdkTable } from '../../schema/sdk.js';
import { taskStates } from '../task/index.js';

const c = (value: string, label: string, sequence: number): ChoiceDef => ({ value, label, sequence });

export const aiFixturesModule: AppModule = {
  id: 'ai_fixtures',
  name: 'AI test fixtures',
  dependsOn: ['task'],
  tables: [
    sdkTable('incident', { audit: true }),
    sdkTable('problem', { audit: true }),
    sdkTable('change_request', { audit: true }),
    sdkTable('kb_knowledge_base'),
    sdkTable('kb_knowledge'),
    {
      name: 'm2m_kb_task',
      label: 'Knowledge Applied to Tasks',
      columns: [
        { name: 'kb_knowledge', label: 'Article', type: 'reference', reference: 'kb_knowledge' },
        { name: 'task', label: 'Task', type: 'reference', reference: 'task' },
      ],
    },
  ],
  choices: {
    'incident.state': [
      c('1', 'New', 1),
      c('2', 'In Progress', 2),
      c('3', 'On Hold', 3),
      c('6', 'Resolved', 4),
      c('7', 'Closed', 5),
      c('8', 'Canceled', 6),
    ],
    'incident.category': [
      c('inquiry', 'Inquiry / Help', 1),
      c('software', 'Software', 2),
      c('hardware', 'Hardware', 3),
      c('network', 'Network', 4),
      c('database', 'Database', 5),
    ],
    'incident.close_code': [
      c('Solved (Permanently)', 'Solved (Permanently)', 1),
      c('Solved (Work Around)', 'Solved (Work Around)', 2),
      c('Resolved by caller', 'Resolved by caller', 3),
    ],
    'problem.state': [
      c('101', 'New', 1),
      c('102', 'Assess', 2),
      c('103', 'Root Cause Analysis', 3),
      c('104', 'Fix in Progress', 4),
      c('106', 'Resolved', 5),
      c('107', 'Closed', 6),
    ],
    'change_request.state': [
      c('-5', 'New', 1),
      c('-4', 'Assess', 2),
      c('-3', 'Authorize', 3),
      c('-2', 'Scheduled', 4),
      c('-1', 'Implement', 5),
      c('0', 'Review', 6),
      c('3', 'Closed', 7),
      c('4', 'Canceled', 8),
    ],
    'change_request.type': [
      c('normal', 'Normal', 1),
      c('standard', 'Standard', 2),
      c('emergency', 'Emergency', 3),
    ],
    'change_request.risk': [
      c('1', 'Very High', 1),
      c('2', 'High', 2),
      c('3', 'Moderate', 3),
      c('4', 'Low', 4),
    ],
    'kb_knowledge.workflow_state': [
      c('draft', 'Draft', 1),
      c('review', 'Review', 2),
      c('published', 'Published', 3),
      c('retired', 'Retired', 4),
    ],
  },
  acls: [
    // Incident-level ACLs replace the task ones, so agents need their own entries here.
    { name: 'incident', operation: 'read', roles: ['itil', 'sn_incident_read'] },
    { name: 'incident', operation: 'read', condition: 'caller_id=javascript:gs.getUserID()' },
    { name: 'incident', operation: 'write', roles: ['itil', 'sn_incident_write'] },
    { name: 'incident', operation: 'create', roles: ['itil'] },
    { name: 'incident', operation: 'delete', roles: ['admin'] },
    { name: 'kb_knowledge', operation: 'read', roles: ['snc_internal'] },
    { name: 'kb_knowledge', operation: 'create', roles: ['itil'] },
    { name: 'kb_knowledge', operation: 'write', roles: ['itil'] },
    { name: 'kb_knowledge_base', operation: 'read', roles: ['snc_internal'] },
    { name: 'm2m_kb_task', operation: 'read', roles: ['itil'] },
  ],
  register(platform) {
    taskStates(platform).register('incident', { closed: ['7', '8'], resolved: ['6'], defaultClosed: '7' });
    taskStates(platform).register('problem', { closed: ['107'], resolved: ['106'], defaultClosed: '107' });
    taskStates(platform).register('change_request', { closed: ['3', '4'], defaultClosed: '3' });
  },
};
