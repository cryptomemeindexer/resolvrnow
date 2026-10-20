import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../../api/http.js';
import type { AppModule } from '../../engine/module.js';
import type { AclDef } from '../../engine/services/acl.js';
import { SERVICES } from '../contracts.js';
import { registerAiApi } from './api.js';
import { AI_PROPERTIES } from './config.js';
import { demoAi, seedAi } from './demo.js';
import { registerMcpHttp } from './mcp/http.js';
import { AiEngine, aiEngineOf } from './service.js';
import { AI_TABLES } from './tables.js';

const ADMIN_ROLES = ['ai_admin'];

function adminAcls(table: string): AclDef[] {
  return (['read', 'write', 'create', 'delete'] as const).map((operation) => ({
    name: table,
    operation,
    roles: ADMIN_ROLES,
  }));
}

const ME = 'javascript:gs.getUserID()';

/**
 * Predictive intelligence (local TF-IDF classifiers, similarity, clustering),
 * generative skills with offline fallbacks, the MCP server and the virtual agent.
 * Works on table names generically: ITSM tables are used when installed.
 */
export const aiModule: AppModule = {
  id: 'ai',
  name: 'AI & Predictive Intelligence',
  description:
    'Predictive classification, similarity, generative assist skills, MCP server and virtual agent.',
  dependsOn: ['task'],
  tables: AI_TABLES,
  roles: [
    {
      name: 'ai_admin',
      description: 'Configures AI skills, ML solutions and the virtual agent, and reads AI usage logs',
    },
    {
      name: 'mcp_user',
      description: 'May connect MCP clients (desktop assistants, IDE agents) to ResolvrNow',
    },
  ],
  properties: AI_PROPERTIES,
  acls: [
    ...adminAcls('ml_solution_definition'),
    { name: 'ml_solution_definition', operation: 'read', roles: ['itil'] },
    ...adminAcls('ml_solution'),
    { name: 'ml_solution', operation: 'read', roles: ['itil'] },
    {
      name: 'ml_solution.artifact',
      operation: 'read',
      roles: ADMIN_ROLES,
      description: 'Model weights are only shown to AI administrators',
    },
    ...adminAcls('ml_class'),
    { name: 'ml_class', operation: 'read', roles: ['itil'] },
    ...adminAcls('ml_predictor_results'),
    { name: 'ml_predictor_results', operation: 'read', roles: ['itil'] },
    ...adminAcls('sn_nowassist_skill_config'),
    { name: 'sn_nowassist_skill_config', operation: 'read', roles: ['itil'] },
    { name: 'sys_generative_ai_log', operation: 'read', roles: ADMIN_ROLES },
    {
      name: 'sys_generative_ai_log',
      operation: 'read',
      condition: `user=${ME}`,
      description: 'Users see their own AI usage',
    },
    { name: 'sys_generative_ai_log', operation: 'write', roles: ADMIN_ROLES },
    {
      name: 'sys_generative_ai_log',
      operation: 'write',
      condition: `user=${ME}`,
      description: 'Users give feedback on their own outputs',
    },
    { name: 'sys_generative_ai_log', operation: 'delete', roles: ADMIN_ROLES },
    { name: 'sys_generative_ai_log.*', operation: 'write', roles: ADMIN_ROLES },
    ...['feedback', 'feedback_comment', 'inserted', 'shared', 'edit_distance'].map((f) => ({
      name: `sys_generative_ai_log.${f}`,
      operation: 'write' as const,
      condition: `user=${ME}`,
    })),
    { name: 'resolvr_va_conversation', operation: 'read', roles: ADMIN_ROLES },
    { name: 'resolvr_va_conversation', operation: 'read', condition: `user=${ME}` },
    { name: 'resolvr_va_conversation', operation: 'write', roles: ADMIN_ROLES },
    { name: 'resolvr_va_conversation', operation: 'delete', roles: ADMIN_ROLES },
    { name: 'resolvr_va_message', operation: 'read', roles: ADMIN_ROLES },
    { name: 'resolvr_va_message', operation: 'read', condition: `conversation.user=${ME}` },
    { name: 'resolvr_va_message', operation: 'delete', roles: ADMIN_ROLES },
    { name: 'resolvr_mcp_call_log', operation: 'read', roles: ADMIN_ROLES },
    { name: 'resolvr_mcp_call_log', operation: 'read', condition: `user=${ME}` },
    { name: 'resolvr_mcp_call_log', operation: 'delete', roles: ADMIN_ROLES },
  ],
  rules: [
    {
      name: 'AI: solution definition name from label',
      table: 'ml_solution_definition',
      when: 'before',
      actions: ['insert', 'update'],
      condition: (cur) => !cur.str('name') && !!cur.str('label'),
      run(cur) {
        cur.setRaw(
          'name',
          `ml_${cur
            .str('label')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '')}`.slice(0, 100),
        );
      },
    },
    {
      name: 'AI: predict empty fields on insert',
      table: 'global',
      when: 'before',
      actions: ['insert'],
      // Runs before default-setting rules so a prediction is not mistaken for a human value.
      order: 5,
      description:
        'Fills empty output fields of active classification solutions when the confidence passes the threshold, and logs every prediction.',
      condition: (cur, _prev, ctx) => aiEngineOf(ctx.platform)?.predictor.hasSolutionsFor(cur.table) ?? false,
      run(cur, _prev, ctx) {
        aiEngineOf(ctx.platform)?.predictor.applyOnInsert(cur, ctx);
      },
    },
  ],
  jobs: [
    {
      id: 'ai.ml.train',
      name: 'Train due ML solutions',
      intervalMs: 6 * 3_600_000,
      initialDelayMs: 10 * 60_000,
      description:
        'Trains classification solutions that were never trained or whose training frequency has elapsed.',
      run(ctx) {
        aiEngineOf(ctx.platform)?.predictor.trainDue(ctx);
      },
    },
    {
      id: 'ai.va.close_idle',
      name: 'Close idle virtual agent conversations',
      intervalMs: 3_600_000,
      run(ctx) {
        aiEngineOf(ctx.platform)?.va.closeIdle(ctx);
      },
    },
  ],
  ui: {
    navigation: [
      {
        id: 'ai_automation',
        title: 'AI & Automation',
        icon: 'sparkles',
        roles: ['admin', 'ai_admin', 'itil', 'mcp_user'],
        order: 880,
        modules: [
          { title: 'Solution Definitions', table: 'ml_solution_definition', roles: ADMIN_ROLES },
          {
            title: 'Trained Solutions',
            table: 'ml_solution',
            query: 'ORDERBYDESCsys_created_on',
            roles: ADMIN_ROLES,
          },
          {
            title: 'Prediction Results',
            table: 'ml_predictor_results',
            query: 'ORDERBYDESCsys_created_on',
            roles: ['itil', 'ai_admin'],
          },
          { title: 'AI Skills', table: 'sn_nowassist_skill_config', roles: ADMIN_ROLES, separator: true },
          {
            title: 'AI Usage Log',
            table: 'sys_generative_ai_log',
            query: 'ORDERBYDESCsys_created_on',
            roles: ADMIN_ROLES,
          },
          {
            title: 'Virtual Agent Conversations',
            table: 'resolvr_va_conversation',
            query: 'ORDERBYDESCsys_updated_on',
            roles: ADMIN_ROLES,
            separator: true,
          },
          {
            title: 'MCP Call Log',
            table: 'resolvr_mcp_call_log',
            query: 'ORDERBYDESCsys_created_on',
            roles: ADMIN_ROLES,
            separator: true,
          },
          {
            title: 'MCP Access Tokens',
            table: 'sys_api_token',
            query: `user=${ME}`,
            roles: ['mcp_user', 'ai_admin'],
          },
        ],
      },
    ],
    lists: [
      {
        table: 'ml_solution_definition',
        columns: [
          'label',
          'name',
          'capability',
          'table',
          'output_field',
          'prediction_preference',
          'confidence_threshold',
          'active',
          'current_solution',
        ],
      },
      {
        table: 'ml_solution',
        columns: [
          'name',
          'definition',
          'version',
          'state',
          'algorithm',
          'training_records',
          'accuracy',
          'precision',
          'coverage',
          'trained_at',
        ],
      },
      {
        table: 'ml_class',
        columns: [
          'solution',
          'display_value',
          'training_records',
          'distribution',
          'estimated_precision',
          'estimated_coverage',
          'threshold',
        ],
      },
      {
        table: 'ml_predictor_results',
        columns: [
          'sys_created_on',
          'table',
          'record',
          'field',
          'predicted_display',
          'confidence',
          'threshold',
          'applied',
          'user_action',
          'outcome',
        ],
      },
      {
        table: 'sn_nowassist_skill_config',
        columns: ['name', 'skill_id', 'table', 'active', 'roles', 'provider', 'model', 'effort'],
      },
      {
        table: 'sys_generative_ai_log',
        columns: [
          'sys_created_on',
          'skill',
          'user',
          'document',
          'provider',
          'model',
          'status',
          'latency_ms',
          'input_tokens',
          'output_tokens',
          'feedback',
        ],
      },
      {
        table: 'resolvr_va_conversation',
        columns: ['number', 'user', 'state', 'topic', 'message_count', 'related_record', 'last_activity'],
      },
      {
        table: 'resolvr_va_message',
        columns: ['conversation', 'sequence', 'direction', 'text', 'topic', 'sys_created_on'],
      },
      {
        table: 'resolvr_mcp_call_log',
        columns: [
          'sys_created_on',
          'user',
          'tool',
          'operation',
          'outcome',
          'record',
          'duration_ms',
          'transport',
        ],
      },
    ],
    forms: [
      {
        table: 'ml_solution_definition',
        highlights: ['capability', 'prediction_preference', 'current_solution'],
        sections: [
          {
            left: ['label', 'name', 'capability', 'table', 'active'],
            right: [
              'output_field',
              'prediction_preference',
              'confidence_threshold',
              'target_precision',
              'current_solution',
            ],
          },
          {
            caption: 'Training data',
            fields: [
              'input_fields',
              'filter',
              'processing_language',
              'training_frequency',
              'update_frequency',
            ],
          },
          { caption: 'Clustering', fields: ['purity_fields', 'min_records_per_cluster'] },
          { caption: 'Advanced', fields: ['advanced_settings'] },
        ],
        relatedLists: [
          {
            table: 'ml_solution',
            field: 'definition',
            label: 'Solution versions',
            columns: [
              'version',
              'state',
              'algorithm',
              'training_records',
              'precision',
              'coverage',
              'trained_at',
            ],
          },
        ],
      },
      {
        table: 'ml_solution',
        highlights: ['state', 'precision', 'coverage'],
        sections: [
          {
            left: ['name', 'definition', 'version', 'state', 'algorithm'],
            right: ['training_records', 'accuracy', 'precision', 'coverage', 'recall', 'trained_at'],
          },
          { fields: ['excluded_classes', 'error'] },
        ],
        relatedLists: [
          {
            table: 'ml_class',
            field: 'solution',
            label: 'Classes',
            columns: [
              'display_value',
              'training_records',
              'distribution',
              'estimated_precision',
              'estimated_coverage',
              'threshold',
            ],
          },
          {
            table: 'ml_predictor_results',
            field: 'solution',
            label: 'Predictions',
            columns: ['sys_created_on', 'record', 'predicted_display', 'confidence', 'applied', 'outcome'],
          },
        ],
      },
      {
        table: 'sn_nowassist_skill_config',
        highlights: ['active', 'provider'],
        sections: [
          {
            left: ['name', 'skill_id', 'table', 'active', 'trigger_mode', 'display'],
            right: ['roles', 'provider', 'model', 'effort', 'max_input_tokens', 'max_output_tokens'],
          },
          { fields: ['description', 'availability', 'prompt_override'] },
        ],
      },
      {
        table: 'sys_generative_ai_log',
        highlights: ['status', 'provider', 'feedback'],
        sections: [
          {
            left: ['skill', 'table', 'document', 'user', 'status', 'message'],
            right: [
              'provider',
              'model',
              'latency_ms',
              'input_tokens',
              'output_tokens',
              'cached_tokens',
              'truncated',
            ],
          },
          { fields: ['output'] },
          {
            caption: 'Feedback',
            left: ['feedback', 'feedback_comment'],
            right: ['inserted', 'shared', 'edit_distance'],
          },
        ],
      },
      {
        table: 'resolvr_va_conversation',
        highlights: ['state', 'topic'],
        sections: [
          {
            left: ['number', 'user', 'state', 'channel'],
            right: ['topic', 'step', 'opened_at', 'last_activity', 'related_record'],
          },
          { fields: ['summary'] },
        ],
        relatedLists: [
          {
            table: 'resolvr_va_message',
            field: 'conversation',
            label: 'Messages',
            columns: ['sequence', 'direction', 'text', 'topic'],
          },
        ],
      },
    ],
    uiActions: [
      {
        id: 'ai.ml.train',
        table: 'ml_solution_definition',
        label: 'Train',
        style: 'primary',
        roles: ADMIN_ROLES,
        condition: 'capability=classification^active=true',
        run(rec, ctx) {
          const engine = aiEngineOf(ctx.platform);
          if (!engine) return { error: 'The AI module is not initialised' };
          const res = engine.predictor.train(ctx, rec.sysId);
          if (res.state !== 'solution_complete') return { error: res.error ?? 'Training failed' };
          return {
            message: `Trained ${res.name} on ${res.trainingRecords} records (${res.algorithm}): precision ${res.precision ?? '-'}%, coverage ${res.coverage ?? '-'}%.`,
            record: { table: 'ml_solution', sys_id: res.solution },
          };
        },
      },
    ],
  },
  register(platform) {
    const engine = new AiEngine(platform);
    platform.services.set(SERVICES.ai, engine);
    const ev = ['insert', 'update', 'delete'] as const;
    platform.hooks.on([...ev], 'ml_solution_definition', 'ai-ml-definitions', () =>
      engine.predictor.invalidate(),
    );
    platform.hooks.on([...ev], 'ml_solution', 'ai-ml-solutions', () => engine.predictor.invalidate());
    platform.hooks.on('insert', '*', 'ai-index-insert', (rec) => engine.similarity.noteChange(rec, 'insert'));
    platform.hooks.on('delete', '*', 'ai-index-delete', (rec) => engine.similarity.noteChange(rec, 'delete'));
    platform.hooks.on('update', '*', 'ai-index-update', (rec, _prev, ctx) => {
      engine.similarity.noteChange(rec, 'update');
      engine.predictor.trackOutcome(rec, ctx);
    });
  },
  seedVersion: 1,
  seed: seedAi,
  demo: demoAi,
  http(app, deps) {
    registerAiApi(app as FastifyInstance, deps as ApiDeps);
    registerMcpHttp(app as FastifyInstance, deps as ApiDeps);
  },
};

export { AiEngine, aiEngineOf } from './service.js';
