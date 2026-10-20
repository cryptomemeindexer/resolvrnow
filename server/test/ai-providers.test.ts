import type { ClientOptions } from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { LlmSettings } from '../src/modules/ai/config.js';
import { aiFixturesModule } from '../src/modules/ai/fixtures.js';
import { aiEngineOf, aiModule } from '../src/modules/ai/index.js';
import { AnthropicProvider } from '../src/modules/ai/llm/anthropic.js';
import { OpenAiCompatibleProvider } from '../src/modules/ai/llm/openai.js';
import { LlmError, type LlmRequest } from '../src/modules/ai/llm/provider.js';
import { bootPlatform } from './helpers.js';

const base: LlmSettings = {
  enabled: true,
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  baseUrl: '',
  apiKey: '',
  effort: 'low',
  timeoutMs: 5000,
  maxOutputTokens: 16000,
  serverFallback: true,
};

const request: LlmRequest = {
  skill: 'test',
  system: 'You are a test system prompt.',
  prompt: 'Task: say hello.',
  maxTokens: 16000,
  effort: 'low',
};

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** A fetch stub standing in for the network: records the request and returns a canned response. */
function stubFetch(respond: (body: Record<string, unknown>) => Response) {
  const calls: Captured[] = [];
  const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, headers: new Headers(init?.headers), body });
    return respond(body);
  };
  return { fetchStub, calls };
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
  });

function message(content: unknown[], stop_reason: string, stop_details: unknown = null) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason,
    stop_sequence: null,
    stop_details,
    usage: {
      input_tokens: 42,
      output_tokens: 7,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 0,
    },
  };
}

function anthropic(settings: Partial<LlmSettings>, fetchStub: ClientOptions['fetch']) {
  return new AnthropicProvider(
    () => ({ ...base, ...settings }),
    {},
    { apiKey: 'test-key', fetch: fetchStub, maxRetries: 0 },
  );
}

describe('Anthropic provider (no network)', () => {
  it('is unavailable without an API key', () => {
    expect(new AnthropicProvider(() => base, {}).available()).toBe(false);
    expect(new AnthropicProvider(() => base, { ANTHROPIC_API_KEY: 'sk-x' }).available()).toBe(true);
  });

  it('sends the documented request shape and returns the text', async () => {
    const { fetchStub, calls } = stubFetch(() =>
      jsonResponse(
        200,
        message(
          [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'there' },
          ],
          'end_turn',
        ),
      ),
    );
    const res = await anthropic({}, fetchStub).generate(request);
    expect(res).toEqual({
      text: 'Hello there',
      stop: 'end',
      model: 'claude-opus-5-5',
      usage: { input: 42, output: 7, cached: 30 },
    });
    const { url, headers, body } = calls[0];
    expect(url).toMatch(/\/v1\/messages\?beta=true$/);
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      fallbacks: 'default',
      output_config: { effort: 'low' },
      cache_control: { type: 'ephemeral' },
      system: 'You are a test system prompt.',
      messages: [{ role: 'user', content: 'Task: say hello.' }],
    });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('uses the configured model and effort, and can turn the server-side fallback off', async () => {
    const { fetchStub, calls } = stubFetch(() =>
      jsonResponse(200, message([{ type: 'text', text: 'ok' }], 'end_turn')),
    );
    await anthropic({ serverFallback: false, model: 'claude-sonnet-5-5' }, fetchStub).generate({
      ...request,
      effort: 'medium',
    });
    expect(calls[0].body.model).toBe('claude-sonnet-5-5');
    expect(calls[0].body.output_config).toEqual({ effort: 'medium' });
    expect(calls[0].body).not.toHaveProperty('fallbacks');
    expect(calls[0].headers.get('anthropic-beta') ?? '').not.toContain('server-side-fallback');
  });

  it('returns no content when the model refuses', async () => {
    const { fetchStub } = stubFetch(() =>
      jsonResponse(
        200,
        message([{ type: 'text', text: 'partial' }], 'refusal', {
          type: 'refusal',
          category: 'cyber',
          explanation: null,
        }),
      ),
    );
    const res = await anthropic({}, fetchStub).generate(request);
    expect(res.stop).toBe('refusal');
    expect(res.text).toBe('');
    expect(res.refusalCategory).toBe('cyber');
  });

  it('maps API errors to typed LlmErrors', async () => {
    const err = (status: number, type: string) => () =>
      jsonResponse(status, { type: 'error', error: { type, message: 'nope' } });
    const kinds: [number, string, string][] = [
      [429, 'rate_limit_error', 'rate_limit'],
      [401, 'authentication_error', 'auth'],
      [500, 'api_error', 'api'],
      [400, 'invalid_request_error', 'api'],
    ];
    for (const [status, type, kind] of kinds) {
      const { fetchStub } = stubFetch(err(status, type));
      const e = await anthropic({}, fetchStub)
        .generate(request)
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LlmError);
      expect((e as LlmError).kind).toBe(kind);
    }
  });
});

describe('OpenAI-compatible provider (no network)', () => {
  const settings =
    (s: Partial<LlmSettings> = {}) =>
    () => ({
      ...base,
      provider: 'openai_compatible' as const,
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434/v1/',
      ...s,
    });
  const completion = (content: string, finish: string) => ({
    model: 'llama3.1',
    choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  });

  it('needs a base URL', () => {
    expect(new OpenAiCompatibleProvider(settings({ baseUrl: '' })).available()).toBe(false);
    expect(new OpenAiCompatibleProvider(settings()).available()).toBe(true);
  });

  it('posts chat completions and maps the response', async () => {
    const { fetchStub, calls } = stubFetch(() => jsonResponse(200, completion('Hi!', 'stop')));
    const provider = new OpenAiCompatibleProvider(settings({ apiKey: 'local-key' }), fetchStub);
    const res = await provider.generate(request);
    expect(res).toEqual({
      text: 'Hi!',
      stop: 'end',
      model: 'llama3.1',
      usage: { input: 12, output: 3, cached: 0 },
    });
    expect(calls[0].url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0].headers.get('authorization')).toBe('Bearer local-key');
    expect(calls[0].body).toEqual({
      model: 'llama3.1',
      max_tokens: 16000,
      messages: [
        { role: 'system', content: 'You are a test system prompt.' },
        { role: 'user', content: 'Task: say hello.' },
      ],
    });
  });

  it('maps length, content filters and errors', async () => {
    const run = (respond: () => Response) =>
      new OpenAiCompatibleProvider(settings(), stubFetch(respond).fetchStub).generate(request);
    expect((await run(() => jsonResponse(200, completion('cut', 'length')))).stop).toBe('max_tokens');
    const refused = await run(() => jsonResponse(200, completion('blocked', 'content_filter')));
    expect(refused).toMatchObject({ stop: 'refusal', text: '' });
    const limited = await run(() => jsonResponse(429, {})).catch((e: unknown) => e);
    expect((limited as LlmError).kind).toBe('rate_limit');
    const down = await new OpenAiCompatibleProvider(settings(), async () => {
      throw new TypeError('fetch failed');
    })
      .generate(request)
      .catch((e: unknown) => e);
    expect((down as LlmError).kind).toBe('network');
  });

  it('is selected only when an administrator configures it', () => {
    const p = bootPlatform([aiModule, aiFixturesModule]);
    const engine = aiEngineOf(p)!;
    const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      expect(engine.provider().id).toBe('anthropic');
      expect(engine.llmAvailable()).toBe(false);
      p.properties.set('resolvr.ai.provider', 'openai_compatible');
      expect(engine.provider().id).toBe('openai_compatible');
      expect(engine.llmAvailable()).toBe(false);
      p.properties.set('resolvr.ai.base_url', 'http://localhost:11434/v1');
      expect(engine.llmAvailable()).toBe(true);
      expect(engine.provider().model).toBe('llama3.1');
      p.properties.set('resolvr.ai.enabled', 'false');
      expect(engine.llmAvailable()).toBe(false);
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
      p.close();
    }
  });
});
