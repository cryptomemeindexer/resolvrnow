/** Properties of the AI module and helpers that read them. */
import type { Platform } from '../../engine/platform.js';
import type { PropertyDef } from '../../engine/services/properties.js';

export const PROP = {
  enabled: 'resolvr.ai.enabled',
  provider: 'resolvr.ai.provider',
  model: 'resolvr.ai.model',
  baseUrl: 'resolvr.ai.base_url',
  apiKey: 'resolvr.ai.api_key',
  effort: 'resolvr.ai.effort',
  maxContextChars: 'resolvr.ai.max_context_chars',
  maxOutputTokens: 'resolvr.ai.max_output_tokens',
  timeoutMs: 'resolvr.ai.timeout_ms',
  cacheMinutes: 'resolvr.ai.cache_minutes',
  serverFallback: 'resolvr.ai.server_fallback',
  mlMinRecords: 'resolvr.ml.min_training_records',
  mlMinClassRecords: 'resolvr.ml.min_class_records',
  mlMaxRecords: 'resolvr.ml.max_training_records',
  mlMaxFeatures: 'resolvr.ml.max_features',
  simWindow: 'resolvr.ml.similarity.window',
  simMinScore: 'resolvr.ml.similarity.min_score',
  mcpEnabled: 'resolvr.mcp.enabled',
  mcpToolNames: 'resolvr.mcp.tool_names',
  mcpRequiredRole: 'resolvr.mcp.required_role',
  vaEnabled: 'resolvr.va.enabled',
  vaThreshold: 'resolvr.va.discovery_confidence_threshold',
  vaPasswordResetUrl: 'resolvr.va.password_reset_url',
} as const;

/** Default model for the Anthropic provider (overridable by property or RESOLVRNOW_AI_MODEL). */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
export const DEFAULT_OPENAI_COMPATIBLE_MODEL = 'llama3.1';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const AI_PROPERTIES: PropertyDef[] = [
  {
    name: PROP.enabled,
    value: 'true',
    type: 'boolean',
    description:
      'Allow generative AI calls to the configured LLM provider (false forces the offline fallbacks)',
  },
  {
    name: PROP.provider,
    value: 'anthropic',
    type: 'choicelist',
    choices: 'anthropic,openai_compatible,offline',
    description:
      'LLM provider: anthropic (reads ANTHROPIC_API_KEY), openai_compatible (needs resolvr.ai.base_url, e.g. a local Ollama), or offline',
  },
  {
    name: PROP.model,
    value: '',
    description:
      'Model id. Empty: RESOLVRNOW_AI_MODEL, else claude-opus-5-5 (anthropic) or llama3.1 (openai_compatible)',
  },
  {
    name: PROP.baseUrl,
    value: '',
    description: 'Base URL of an OpenAI-compatible API, for example http://localhost:11434/v1',
  },
  {
    name: PROP.apiKey,
    value: '',
    type: 'password',
    description: 'Optional API key sent as a bearer token to the OpenAI-compatible endpoint',
  },
  {
    name: PROP.effort,
    value: 'low',
    type: 'choicelist',
    choices: EFFORTS.join(','),
    description: 'Default reasoning effort for generative skills (a skill configuration may override it)',
  },
  {
    name: PROP.maxContextChars,
    value: '24000',
    type: 'integer',
    description:
      'Maximum characters of record context sent to the LLM (oldest journal entries are dropped first)',
  },
  {
    name: PROP.maxOutputTokens,
    value: '16000',
    type: 'integer',
    description: 'Default maximum output tokens per generative call',
  },
  {
    name: PROP.timeoutMs,
    value: '60000',
    type: 'integer',
    description: 'LLM request timeout in milliseconds',
  },
  {
    name: PROP.cacheMinutes,
    value: '10',
    type: 'integer',
    description: 'Reuse an identical generated output for this many minutes (0 disables)',
  },
  {
    name: PROP.serverFallback,
    value: 'true',
    type: 'boolean',
    description: 'Ask the Anthropic API to retry refused requests on its default fallback model',
  },
  {
    name: PROP.mlMinRecords,
    value: '20',
    type: 'integer',
    description: 'Minimum labelled records needed to train a classification solution',
  },
  {
    name: PROP.mlMinClassRecords,
    value: '3',
    type: 'integer',
    description: 'Classes with fewer training records are excluded from a solution',
  },
  {
    name: PROP.mlMaxRecords,
    value: '100000',
    type: 'integer',
    description: 'Maximum records used for one training run (most recent first)',
  },
  {
    name: PROP.mlMaxFeatures,
    value: '20000',
    type: 'integer',
    description: 'Maximum vocabulary size of a classification model',
  },
  {
    name: PROP.simWindow,
    value: '5000',
    type: 'integer',
    description: 'Most recent records indexed per table for similarity search',
  },
  {
    name: PROP.simMinScore,
    value: '20',
    type: 'integer',
    description: 'Minimum similarity score (0-100) for similar records and knowledge suggestions',
  },
  {
    name: PROP.mcpEnabled,
    value: 'false',
    type: 'boolean',
    description: 'Expose the MCP server over HTTP at /api/app/mcp',
  },
  {
    name: PROP.mcpToolNames,
    value: 'underscore',
    type: 'choicelist',
    choices: 'underscore,dotted',
    description: 'MCP tool naming: underscore (default) or dotted compatibility names',
  },
  {
    name: PROP.mcpRequiredRole,
    value: 'mcp_user',
    description: 'Role required to use the MCP server (empty: any authenticated user)',
  },
  { name: PROP.vaEnabled, value: 'true', type: 'boolean', description: 'Enable the virtual agent chat API' },
  {
    name: PROP.vaThreshold,
    value: '0.6',
    description: 'Minimum topic discovery score (0-1) before the virtual agent starts a topic',
  },
  {
    name: PROP.vaPasswordResetUrl,
    value: '/portal/password-reset',
    description: 'Self-service password reset page offered by the virtual agent',
  },
];

export type ProviderId = 'anthropic' | 'openai_compatible' | 'offline';

export interface LlmSettings {
  enabled: boolean;
  provider: ProviderId;
  model: string;
  baseUrl: string;
  apiKey: string;
  effort: Effort;
  timeoutMs: number;
  maxOutputTokens: number;
  serverFallback: boolean;
}

export function asEffort(v: string | undefined | null, fallback: Effort = 'low'): Effort {
  return (EFFORTS as readonly string[]).includes(String(v)) ? (v as Effort) : fallback;
}

export function llmSettings(platform: Platform, env: NodeJS.ProcessEnv = process.env): LlmSettings {
  const p = platform.properties;
  const raw = (p.get(PROP.provider) ?? 'anthropic').trim();
  const provider: ProviderId =
    raw === 'openai_compatible' || raw === 'ollama'
      ? 'openai_compatible'
      : raw === 'offline'
        ? 'offline'
        : 'anthropic';
  const configured = (p.get(PROP.model) ?? '').trim() || (env.RESOLVRNOW_AI_MODEL ?? '').trim();
  const model =
    configured ||
    (provider === 'openai_compatible' ? DEFAULT_OPENAI_COMPATIBLE_MODEL : DEFAULT_ANTHROPIC_MODEL);
  let baseUrl = (p.get(PROP.baseUrl) ?? '').trim();
  if (!baseUrl && raw === 'ollama') baseUrl = 'http://localhost:11434/v1';
  return {
    enabled: p.getBool(PROP.enabled, true),
    provider,
    model,
    baseUrl,
    apiKey: (p.get(PROP.apiKey) ?? '').trim(),
    effort: asEffort(p.get(PROP.effort), 'low'),
    timeoutMs: p.getNumber(PROP.timeoutMs, 60_000),
    maxOutputTokens: p.getNumber(PROP.maxOutputTokens, 16_000),
    serverFallback: p.getBool(PROP.serverFallback, true),
  };
}
