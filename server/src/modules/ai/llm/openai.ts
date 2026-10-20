/**
 * Provider for any OpenAI-compatible `/chat/completions` endpoint (for example a
 * local Ollama at http://localhost:11434/v1). Selected only when an administrator
 * sets resolvr.ai.provider=openai_compatible and a base URL.
 */
import type { LlmSettings } from '../config.js';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResult } from './provider.js';

interface ChatCompletionResponse {
  model?: string;
  choices?: {
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = 'openai_compatible';

  constructor(
    private readonly settings: () => LlmSettings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get model(): string {
    return this.settings().model;
  }

  available(): boolean {
    return /^https?:\/\//i.test(this.settings().baseUrl);
  }

  async generate(req: LlmRequest): Promise<LlmResult> {
    const s = this.settings();
    const url = `${s.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (s.apiKey) headers.authorization = `Bearer ${s.apiKey}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: req.model || s.model,
          max_tokens: req.maxTokens,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.prompt },
          ],
        }),
        signal: AbortSignal.timeout(s.timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'TimeoutError' || name === 'AbortError')
        throw new LlmError('timeout', 'The AI provider did not answer in time');
      throw new LlmError('network', 'The AI provider could not be reached');
    }
    if (res.status === 429) throw new LlmError('rate_limit', 'The AI provider rate limit was reached', 429);
    if (res.status === 401 || res.status === 403)
      throw new LlmError('auth', 'The AI provider rejected the request credentials', res.status);
    if (!res.ok)
      throw new LlmError('api', `The AI provider returned an error (HTTP ${res.status})`, res.status);
    let body: ChatCompletionResponse;
    try {
      body = (await res.json()) as ChatCompletionResponse;
    } catch {
      throw new LlmError('api', 'The AI provider returned an invalid response');
    }
    const choice = body.choices?.[0];
    const usage = {
      input: body.usage?.prompt_tokens ?? 0,
      output: body.usage?.completion_tokens ?? 0,
      cached: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    };
    const model = body.model ?? (req.model || s.model);
    if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) {
      return { text: '', stop: 'refusal', model, usage, refusalCategory: null };
    }
    return {
      text: choice?.message?.content ?? '',
      stop: choice?.finish_reason === 'length' ? 'max_tokens' : 'end',
      model,
      usage,
    };
  }
}
