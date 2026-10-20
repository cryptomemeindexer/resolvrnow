/**
 * The AI engine registered as `platform.services.get('ai')`: implements the shared
 * AiService contract and gives access to predictions, similarity, generative skills
 * and the virtual agent.
 */
import type { Context } from '../../engine/context.js';
import type { Platform } from '../../engine/platform.js';
import type { Rec } from '../../engine/record.js';
import type { AiCompletion, AiService } from '../contracts.js';
import { type Effort, llmSettings, PROP, type ProviderId } from './config.js';
import { AnthropicProvider } from './llm/anthropic.js';
import { OpenAiCompatibleProvider } from './llm/openai.js';
import {
  AiRefusalError,
  estimateTokens,
  LlmError,
  type LlmProvider,
  type LlmResult,
  OfflineProvider,
} from './llm/provider.js';
import { Predictor } from './ml/predictor.js';
import { SimilarityService } from './ml/similarity.js';
import { truncate } from './ml/text.js';
import { stripSecrets } from './skills/guard.js';
import { SkillRunner } from './skills/runner.js';
import { VirtualAgent } from './va/engine.js';

export interface UsageEntry {
  skill: string;
  record?: Rec | null;
  provider: string;
  model: string;
  status: string;
  latencyMs: number;
  truncated?: boolean;
  output?: string;
  message?: string | null;
  inputHash?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

export class AiEngine implements AiService {
  readonly predictor: Predictor;
  readonly similarity: SimilarityService;
  readonly skills: SkillRunner;
  readonly va: VirtualAgent;
  private readonly anthropic: AnthropicProvider;
  private readonly openai: OpenAiCompatibleProvider;
  private readonly offline = new OfflineProvider();
  private override: LlmProvider | null = null;

  constructor(readonly platform: Platform) {
    const settings = () => llmSettings(platform);
    this.anthropic = new AnthropicProvider(settings);
    this.openai = new OpenAiCompatibleProvider(settings);
    this.predictor = new Predictor(platform);
    this.similarity = new SimilarityService(platform);
    this.skills = new SkillRunner(this);
    this.va = new VirtualAgent(this);
  }

  /** Replaces the configured LLM provider (tests, embedding); null restores the configuration. */
  setProvider(provider: LlmProvider | null): void {
    this.override = provider;
  }

  providerFor(id: ProviderId): LlmProvider {
    if (id === 'offline') return this.offline;
    if (this.override) return this.override;
    return id === 'openai_compatible' ? this.openai : this.anthropic;
  }

  /** The provider selected by resolvr.ai.provider. */
  provider(): LlmProvider {
    return this.providerFor(llmSettings(this.platform).provider);
  }

  llmAvailable(): boolean {
    const s = llmSettings(this.platform);
    return s.enabled && this.providerFor(s.provider).available();
  }

  /**
   * Calls the configured provider with a stable system prompt, logging the usage.
   * Returns null when no LLM is available; throws AiRefusalError when the model declines
   * and LlmError when the provider fails.
   */
  async generate(
    ctx: Context | null,
    skill: string,
    system: string,
    prompt: string,
    opts: { maxTokens?: number; effort?: Effort } = {},
  ): Promise<(LlmResult & { provider: string }) | null> {
    if (!this.llmAvailable()) return null;
    const s = llmSettings(this.platform);
    const provider = this.provider();
    const started = Date.now();
    const safePrompt = stripSecrets(prompt);
    let res: LlmResult;
    try {
      res = await provider.generate({
        skill,
        system,
        prompt: safePrompt,
        maxTokens: opts.maxTokens ?? s.maxOutputTokens,
        effort: opts.effort ?? s.effort,
      });
    } catch (e) {
      this.logUsage(ctx, {
        skill,
        provider: provider.id,
        model: provider.model,
        status: e instanceof LlmError && e.kind === 'timeout' ? 'timeout' : 'error',
        latencyMs: Date.now() - started,
        message: e instanceof Error ? e.message : String(e),
        inputTokens: estimateTokens(safePrompt),
      });
      throw e;
    }
    const refused = res.stop === 'refusal';
    this.logUsage(ctx, {
      skill,
      provider: provider.id,
      model: res.model,
      status: refused ? 'refused_fallback' : 'success',
      latencyMs: Date.now() - started,
      output: res.text,
      message: refused ? 'The model declined the request.' : null,
      inputTokens: res.usage.input,
      outputTokens: res.usage.output,
      cachedTokens: res.usage.cached,
    });
    if (refused) throw new AiRefusalError(res.refusalCategory ?? null);
    return { ...res, provider: provider.id };
  }

  /** AiService contract: one completion from the configured provider. */
  async complete(system: string, prompt: string, opts: { maxTokens?: number } = {}): Promise<AiCompletion> {
    const res = await this.generate(null, 'api_complete', system, prompt, opts);
    if (!res) throw new LlmError('unavailable', 'No LLM provider is configured');
    return { text: res.text, provider: res.provider, model: res.model };
  }

  /** Writes a row in the generative AI usage log; returns its sys_id. */
  logUsage(ctx: Context | null, e: UsageEntry): string | null {
    if (!this.platform.registry.has('sys_generative_ai_log')) return null;
    const writer = (ctx ?? this.platform.systemContext()).elevated();
    const row = writer.insert('sys_generative_ai_log', {
      skill: e.skill,
      table: e.record?.className ?? null,
      document: e.record?.sysId ?? null,
      user: ctx?.user.sysId ?? null,
      provider: e.provider,
      model: e.model,
      input_hash: e.inputHash ?? null,
      input_tokens: e.inputTokens ?? 0,
      output_tokens: e.outputTokens ?? 0,
      cached_tokens: e.cachedTokens ?? 0,
      latency_ms: Math.max(0, Math.round(e.latencyMs)),
      status: e.status,
      truncated: !!e.truncated,
      output: e.output ? truncate(e.output, 65_000) : null,
      message: e.message ? truncate(e.message, 1000) : null,
    });
    return row.sysId;
  }

  /** Summary for GET /api/app/ai/status. */
  status(ctx: Context): Record<string, unknown> {
    const s = llmSettings(this.platform);
    const provider = this.providerFor(s.provider);
    const available = s.enabled && provider.available();
    const p = this.platform.properties;
    const solutions = this.predictor.definitions().filter((d) => d.solutionId);
    return {
      provider: available ? provider.id : 'offline',
      configured_provider: s.provider,
      model: available ? (this.override ? provider.model : s.model) : 'offline',
      configured_model: s.model,
      llm_available: available,
      effort: s.effort,
      server_fallback: s.serverFallback,
      skills: this.skills.available(ctx),
      enabled_skills: this.skills
        .available(ctx)
        .filter((x) => x.active)
        .map((x) => x.id),
      predictive: {
        solutions: solutions.map((d) => ({
          sys_id: d.sysId,
          name: d.name,
          table: d.table,
          field: d.outputField,
          preference: d.preference,
        })),
      },
      virtual_agent: { enabled: p.getBool(PROP.vaEnabled, true), topics: this.va.topicList() },
      mcp: {
        enabled: p.getBool(PROP.mcpEnabled, false),
        path: '/api/app/mcp',
        tool_names: p.get(PROP.mcpToolNames) ?? 'underscore',
      },
    };
  }
}

export function aiEngineOf(platform: Platform): AiEngine | undefined {
  const s = platform.services.get('ai');
  return s instanceof AiEngine ? s : undefined;
}
