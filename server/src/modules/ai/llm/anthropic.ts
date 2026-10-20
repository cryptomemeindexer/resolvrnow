/** Anthropic Claude provider (default), using the official SDK's beta Messages API. */
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import type { LlmSettings } from '../config.js';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResult } from './provider.js';

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  private client: Anthropic | null = null;
  private clientTimeout = 0;

  /**
   * @param clientOptions extra SDK options (tests pass a `fetch` stub here; production uses the defaults,
   *   which read ANTHROPIC_API_KEY from the environment).
   */
  constructor(
    private readonly settings: () => LlmSettings,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly clientOptions: ClientOptions = {},
  ) {}

  get model(): string {
    return this.settings().model;
  }

  /** The SDK reads ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) from the environment. */
  available(): boolean {
    return !!(
      this.clientOptions.apiKey ||
      this.env.ANTHROPIC_API_KEY?.trim() ||
      this.env.ANTHROPIC_AUTH_TOKEN?.trim()
    );
  }

  private getClient(timeoutMs: number): Anthropic {
    if (!this.client || this.clientTimeout !== timeoutMs) {
      this.client = new Anthropic({ timeout: timeoutMs, maxRetries: 2, ...this.clientOptions });
      this.clientTimeout = timeoutMs;
    }
    return this.client;
  }

  async generate(req: LlmRequest): Promise<LlmResult> {
    const s = this.settings();
    try {
      const res = await this.getClient(s.timeoutMs).beta.messages.create({
        model: req.model || s.model,
        max_tokens: req.maxTokens,
        // Server-side refusal fallback (on by default, resolvr.ai.server_fallback=false turns it off).
        ...(s.serverFallback
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
          : {}),
        // Thinking is always on for the default model: depth and cost are controlled by effort only.
        output_config: { effort: req.effort },
        // Caches the stable system prompt prefix; record data only appears in the user message.
        cache_control: { type: 'ephemeral' },
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
      });
      const usage = {
        input: res.usage.input_tokens ?? 0,
        output: res.usage.output_tokens ?? 0,
        cached: res.usage.cache_read_input_tokens ?? 0,
      };
      if (res.stop_reason === 'refusal') {
        // Declined (after any server-side fallback): return no content, only the signal.
        return {
          text: '',
          stop: 'refusal',
          model: res.model,
          usage,
          refusalCategory: res.stop_details?.category ?? null,
        };
      }
      const text = res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return { text, stop: res.stop_reason === 'max_tokens' ? 'max_tokens' : 'end', model: res.model, usage };
    } catch (e) {
      // Most specific first; everything is normalised to LlmError for the offline fallback.
      if (e instanceof Anthropic.RateLimitError)
        throw new LlmError('rate_limit', 'The AI provider rate limit was reached', 429);
      if (e instanceof Anthropic.AuthenticationError)
        throw new LlmError('auth', 'The AI provider rejected the configured API key', 401);
      if (e instanceof Anthropic.APIConnectionTimeoutError)
        throw new LlmError('timeout', 'The AI provider did not answer in time');
      if (e instanceof Anthropic.APIConnectionError)
        throw new LlmError('network', 'The AI provider could not be reached');
      if (e instanceof Anthropic.APIError) {
        throw new LlmError(
          'api',
          `The AI provider returned an error${e.status ? ` (HTTP ${e.status})` : ''}`,
          e.status,
        );
      }
      throw e;
    }
  }
}
