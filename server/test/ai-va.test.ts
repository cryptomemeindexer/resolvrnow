import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Context } from '../src/engine/context.js';
import { NotFoundError } from '../src/engine/errors.js';
import type { Platform } from '../src/engine/platform.js';
import { clock } from '../src/engine/util.js';
import { aiFixturesModule } from '../src/modules/ai/fixtures.js';
import { type AiEngine, aiEngineOf, aiModule } from '../src/modules/ai/index.js';
import type { LlmProvider, LlmRequest, LlmResult } from '../src/modules/ai/llm/provider.js';
import type { BotMessage, VaResponse } from '../src/modules/ai/va/engine.js';
import { bootPlatform, makeUser } from './helpers.js';

let p: Platform;
let sys: Context;
let engine: AiEngine;
let emma: Context;
let emmaId: string;

const say = (ctx: Context, text: string, conversationId?: string, value?: string) =>
  engine.va.handle(ctx, { conversationId, text, value });
const texts = (r: VaResponse) => r.messages.map((m) => m.text ?? m.card?.title ?? '').join('\n');
const replies = (r: VaResponse) =>
  r.messages.flatMap((m: BotMessage) => m.quickReplies ?? []).map((q) => q.value);

beforeAll(() => {
  p = bootPlatform([aiModule, aiFixturesModule]);
  sys = p.systemContext();
  engine = aiEngineOf(p)!;
  emmaId = makeUser(p, 'emma.employee', []);
  makeUser(p, 'other.employee', []);
  emma = p.contextAs('emma.employee');
  const base = sys.insert('kb_knowledge_base', { title: 'IT' }).sysId;
  sys.insert('kb_knowledge', {
    kb_knowledge_base: base,
    short_description: 'Fix a flickering monitor',
    text: '<p>If your monitor flickers, reseat the display cable and update the display driver.</p>',
    workflow_state: 'published',
  });
  sys.insert('kb_knowledge', {
    kb_knowledge_base: base,
    short_description: 'Set up the VPN client on a laptop',
    text: '<p>Install the VPN client from the software center, then sign in with your work account.</p>',
    workflow_state: 'published',
  });
});

afterEach(() => engine.setProvider(null));

describe('virtual agent', () => {
  it('greets the user with the topic menu', async () => {
    const r = await say(emma, 'hello');
    expect(texts(r)).toMatch(/^Hi emma! I am the ResolvrNow virtual agent\./);
    expect(replies(r)).toEqual([
      'topic:report_issue',
      'topic:check_tickets',
      'topic:search_knowledge',
      'topic:reset_password',
      'topic:talk_to_agent',
    ]);
    expect(r.state).toBe('open');
    expect(r.number).toMatch(/^VAC/);
  });

  it('reports an issue end to end: description, deflection, urgency, confirmation, incident', async () => {
    let r = await say(emma, 'My monitor keeps flickering since this morning');
    const id = r.conversationId;
    expect(r.topic).toBe('report_issue');
    expect(r.messages[0].type).toBe('list');
    expect(r.messages[0].items?.[0].title).toMatch(/Fix a flickering monitor/);
    expect(replies(r)).toEqual(['solved', 'continue']);

    r = await say(emma, 'No, create a ticket', id);
    expect(texts(r)).toBe('How urgent is it?');
    expect(replies(r)).toEqual(['1', '2', '3']);

    r = await say(emma, '', id, '2');
    expect(r.messages[0].type).toBe('card');
    expect(r.messages[0].card?.fields).toContainEqual({ label: 'Urgency', value: '2 - Medium' });
    expect(replies(r)).toEqual(['submit', 'cancel']);

    r = await say(emma, 'Submit', id);
    expect(r.messages[0].card?.title).toMatch(/^Incident INC\d+ created$/);
    expect(r.topic).toBeNull();
    const inc = sys.get('incident', r.messages[0].card!.sys_id!)!;
    expect(inc.str('caller_id')).toBe(emmaId);
    expect(inc.str('opened_by')).toBe(emmaId);
    expect(inc.str('urgency')).toBe('2');
    expect(inc.str('contact_type')).toBe('virtual_agent');
    expect(inc.str('short_description')).toBe('My monitor keeps flickering since this morning');
    expect(inc.str('description')).toContain('Reported through the virtual agent');

    const conv = sys.get('resolvr_va_conversation', id)!;
    expect(conv.str('related_record')).toBe(inc.sysId);
    expect(conv.num('message_count')).toBeGreaterThanOrEqual(8);
    const history = engine.va.history(emma, id);
    expect(history.messages[0]).toMatchObject({
      direction: 'user',
      text: 'My monitor keeps flickering since this morning',
    });
    expect(history.messages.filter((m) => m.direction === 'bot').length).toBeGreaterThanOrEqual(4);
  });

  it('asks for a description when the request is generic, and offers to add to a similar open incident', async () => {
    let r = await say(emma, 'I want to report an issue');
    const id = r.conversationId;
    expect(texts(r)).toMatch(/describe the issue/);
    r = await say(emma, 'The monitor is flickering again', id);
    expect(replies(r)).toEqual(['solved', 'continue']);
    r = await say(emma, '', id, 'continue');
    r = await say(emma, 'high', id);
    expect(replies(r)).toEqual(['submit', 'add_to_existing', 'cancel']);
    expect(texts(r)).toMatch(/You already have a similar open incident, INC\d+/);
    r = await say(emma, '', id, 'add_to_existing');
    expect(r.messages[0].card?.title).toMatch(/^Added to INC\d+$/);
    const existing = sys.get('incident', r.messages[0].card!.sys_id!)!;
    expect(p.history.journal('incident', existing.sysId, ['comments'])[0].value).toContain(
      'The monitor is flickering again',
    );
  });

  it('searches knowledge', async () => {
    const r = await say(emma, 'how do I set up the vpn on my laptop');
    expect(r.topic).toBe('search_knowledge');
    expect(r.messages[0].type).toBe('list');
    expect(r.messages[0].items?.[0].title).toMatch(/Set up the VPN client on a laptop/);
    expect(replies(r)).toContain('solved');
    const done = await say(emma, '', r.conversationId, 'solved');
    expect(done.topic).toBeNull();
  });

  it("lists the user's open tickets", async () => {
    const r = await say(emma, 'what is the status of my tickets');
    expect(r.topic).toBeNull();
    expect(texts(r)).toMatch(/You have \d+ open tickets?:/);
    expect(r.messages[0].items?.every((i) => i.table === 'incident')).toBe(true);
    const other = await say(p.contextAs('other.employee'), 'show my open tickets');
    expect(texts(other)).toBe('You have no open tickets.');
  });

  it('explains password resets and opens a request on demand', async () => {
    let r = await say(emma, 'I forgot my password');
    expect(r.topic).toBe('reset_password');
    expect(texts(r)).toContain('/portal/password-reset');
    r = await say(emma, '', r.conversationId, 'open_request');
    expect(r.messages[0].card?.title).toMatch(/^Request INC\d+ opened$/);
    expect(sys.get('incident', r.messages[0].card!.sys_id!)!.str('short_description')).toMatch(
      /^Password reset assistance requested\./,
    );
  });

  it('hands off to a live agent with the transcript', async () => {
    let r = await say(emma, 'My docking station is broken');
    r = await say(emma, 'talk to an agent', r.conversationId);
    expect(r.state).toBe('handoff');
    expect(texts(r)).toMatch(/Your reference is INC\d+/);
    const conv = sys.get('resolvr_va_conversation', r.conversationId)!;
    const inc = sys.get('incident', conv.str('related_record'))!;
    expect(inc.str('description')).toContain('User: My docking station is broken');
  });

  it('lets the user cancel a topic and switches topics on a clear request', async () => {
    let r = await say(emma, 'report an issue');
    r = await say(emma, 'cancel', r.conversationId);
    expect(texts(r)).toMatch(/^OK, I stopped that/);
    expect(r.topic).toBeNull();
    r = await say(emma, 'report an issue');
    const id = r.conversationId;
    // A description that mentions an "agent" is still a description.
    r = await say(emma, 'The backup agent software crashes at login', id);
    expect(r.topic).toBe('report_issue');
    expect(r.state).toBe('open');
    // An answer that does not fit the step but is a clear request switches topic.
    r = await say(emma, 'I forgot my password', id);
    expect(r.topic).toBe('reset_password');
  });

  it('falls back to knowledge results, then to the menu', async () => {
    const r = await say(emma, 'display driver');
    expect(r.topic).toBeNull();
    expect(r.messages[0].type).toBe('list');
    expect(replies(r)).toContain('topic:report_issue');
    // Choosing "report this as an issue" reuses what the user typed.
    const next = await say(emma, '', r.conversationId, 'topic:report_issue');
    expect(texts(next)).toBe('How urgent is it?');
    const nothing = await say(emma, 'zzqx blorf');
    expect(texts(nothing)).toMatch(/^Sorry, I did not understand that/);
  });

  it('uses the LLM to route free text when one is configured', async () => {
    const calls: LlmRequest[] = [];
    const fake: LlmProvider = {
      id: 'fake',
      model: 'fake-model',
      available: () => true,
      async generate(req: LlmRequest): Promise<LlmResult> {
        calls.push(req);
        return {
          text: 'check_tickets',
          stop: 'end',
          model: 'fake-model',
          usage: { input: 10, output: 2, cached: 0 },
        };
      },
    };
    engine.setProvider(fake);
    const r = await say(emma, 'anything new on the thing I raised yesterday?');
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('<message>');
    expect(texts(r)).toMatch(/open tickets?:/);
  });

  it('closes idle conversations', async () => {
    const r = await say(emma, 'report an issue');
    clock.advance(3 * 3_600_000);
    p.scheduler.runNow('ai.va.close_idle');
    clock.reset();
    expect(sys.get('resolvr_va_conversation', r.conversationId)!.str('state')).toBe('abandoned');
  });

  it('keeps conversations private', async () => {
    const r = await say(emma, 'hi');
    await expect(say(p.contextAs('other.employee'), 'hi', r.conversationId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(() => engine.va.history(p.contextAs('other.employee'), r.conversationId)).toThrow(NotFoundError);
  });
});
