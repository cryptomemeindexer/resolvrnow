/** Provider abstraction for generative calls (Anthropic, OpenAI-compatible endpoints, test fakes). */
import type { Effort } from '../config.js';

export interface LlmRequest {
  /** Skill or feature making the call (for logs). */
  skill: string;
  /** Stable system prompt: no timestamps, ids or record data, so it can be cached. */
  system: string;
  /** User message holding the task and the delimited record data. */
  prompt: string;
  maxTokens: number;
  effort: Effort;
  /** Model override (per-skill configuration); defaults to the provider's configured model. */
  model?: string;
}

export interface LlmUsage {
  input: number;
  output: number;
  cached: number;
}

export interface LlmResult {
  /** Generated text; always empty when `stop` is `refusal`. */
  text: string;
  stop: 'end' | 'max_tokens' | 'refusal';
  model: string;
  usage: LlmUsage;
  /** Policy category reported with a refusal, when the provider gives one. */
  refusalCategory?: string | null;
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  /** True only when the provider is configured (API key, base URL...). */
  available(): boolean;
  generate(req: LlmRequest): Promise<LlmResult>;
}

export type LlmErrorKind = 'rate_limit' | 'auth' | 'timeout' | 'api' | 'network' | 'unavailable';

/** Provider failure normalised across SDKs, so callers can fall back to offline output. */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Raised by AiService.complete() when the model declines a request. */
export class AiRefusalError extends Error {
  constructor(readonly category: string | null = null) {
    super('The AI model declined to answer this request.');
    this.name = 'AiRefusalError';
  }
}

/** Provider used when nothing is configured: reports itself unavailable. */
export class OfflineProvider implements LlmProvider {
  readonly id = 'offline';
  readonly model = 'offline';
  available(): boolean {
    return false;
  }
  async generate(): Promise<LlmResult> {
    throw new LlmError('unavailable', 'No LLM provider is configured');
  }
}

/** Rough token estimate (4 characters per token) for logs when the provider gives no usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
