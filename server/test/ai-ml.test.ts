import { beforeAll, describe, expect, it } from 'vitest';
import type { Context } from '../src/engine/context.js';
import type { Platform } from '../src/engine/platform.js';
import { demoAi } from '../src/modules/ai/demo.js';
import { aiFixturesModule } from '../src/modules/ai/fixtures.js';
import { type AiEngine, aiEngineOf, aiModule } from '../src/modules/ai/index.js';
import { evaluate, LogisticRegression, NaiveBayes, softmax } from '../src/modules/ai/ml/classifiers.js';
import { cluster } from '../src/modules/ai/ml/cluster.js';
import { analyze, stem, tokenize } from '../src/modules/ai/ml/text.js';
import { dot, TfidfVectorizer } from '../src/modules/ai/ml/tfidf.js';
import { bootPlatform, makeUser } from './helpers.js';

/** Synthetic, clearly separable service desk tickets. */
const CORPUS: Record<string, { subjects: string[]; verbs: string[]; extras: string[] }> = {
  network: {
    subjects: ['VPN', 'wifi', 'network connection', 'internet access', 'firewall', 'DNS resolution'],
    verbs: [
      'keeps disconnecting',
      'is very slow',
      'drops every few minutes',
      'cannot connect',
      'times out',
      'is unreachable',
    ],
    extras: ['from the office', 'when working at home', 'on the guest network', 'since this morning'],
  },
  hardware: {
    subjects: ['laptop', 'monitor', 'keyboard', 'docking station', 'mouse', 'laptop battery'],
    verbs: [
      'will not power on',
      'has a cracked screen',
      'is overheating',
      'makes a clicking noise',
      'is physically damaged',
      'does not charge',
    ],
    extras: ['after a fall', 'since the last reboot', 'at my desk', 'during meetings'],
  },
  software: {
    subjects: ['Outlook', 'Excel', 'Teams client', 'browser', 'accounting application', 'PDF reader'],
    verbs: [
      'crashes on startup',
      'shows a license error',
      'freezes when opening files',
      'needs to be installed',
      'fails to update',
      'reports a missing plugin',
    ],
    extras: ['after the update', 'with large spreadsheets', 'on my new laptop', 'every afternoon'],
  },
  database: {
    subjects: [
      'SQL Server',
      'Oracle database',
      'reporting database',
      'database backup',
      'DB2 instance',
      'data warehouse',
    ],
    verbs: [
      'query is running slow',
      'job failed overnight',
      'has a deadlock',
      'returns a timeout error',
      'replication is lagging',
      'table is locked',
    ],
    extras: ['in production', 'during month end', 'for the finance team', 'after the patch'],
  },
};

function ticket(cat: string, i: number): string {
  const v = CORPUS[cat];
  return `${v.subjects[i % 6]} ${v.verbs[(i * 5 + 1) % 6]} ${v.extras[(i * 7 + i) % 4]}`;
}

function dataset(perClass: number): { text: string; label: string }[] {
  const out: { text: string; label: string }[] = [];
  for (let i = 0; i < perClass; i++)
    for (const cat of Object.keys(CORPUS)) out.push({ text: ticket(cat, i), label: cat });
  return out;
}

describe('text pipeline', () => {
  it('stems English words with the Porter rules', () => {
    expect(stem('connection')).toBe('connect');
    expect(stem('connected')).toBe('connect');
    expect(stem('connecting')).toBe('connect');
    expect(stem('connects')).toBe('connect');
    expect(stem('passwords')).toBe('password');
    expect(stem('running')).toBe('run');
    expect(stem('crashes')).toBe('crash');
    expect(stem('relational')).toBe('relat');
    expect(stem('vpn')).toBe('vpn');
  });

  it('tokenizes, drops ticket numbers and stop words', () => {
    expect(tokenize('INC0010001: VPN <b>down</b> since 08:00')).toEqual(['vpn', 'down', 'since', '08', '00']);
    expect(analyze('The VPN is not working for me')).toEqual(['vpn', 'work']);
    expect(analyze('printer jam', { bigrams: true })).toEqual(['printer', 'jam', 'printer_jam']);
  });

  it('builds normalised TF-IDF vectors whose dot product ranks related texts higher', () => {
    const docs = [
      'vpn keeps disconnecting at home',
      'vpn connection drops',
      'printer out of toner',
      'laptop screen cracked',
    ].map((d) => analyze(d));
    const v = TfidfVectorizer.fit(docs);
    const q = v.transform(analyze('my vpn disconnects'));
    const scores = docs.map((d) => dot(q, v.transform(d)));
    expect(scores[0]).toBeGreaterThan(scores[2]);
    expect(scores[1]).toBeGreaterThan(scores[3]);
    const self = v.transform(docs[0]);
    expect(dot(self, self)).toBeCloseTo(1, 6);
    // Round trip through JSON keeps the same vectors.
    const back = TfidfVectorizer.fromJSON(JSON.parse(JSON.stringify(v.toJSON())));
    expect(dot(back.transform(docs[0]), self)).toBeCloseTo(1, 4);
  });
});

describe('similarity queries', () => {
  it('discounts query words the corpus has never seen', () => {
    const docs = [analyze('printer paper jam'), analyze('vpn tunnel down')];
    const v = TfidfVectorizer.fit(docs);
    const target = v.transform(docs[0]);
    const short = dot(v.queryVector(analyze('printer')), target);
    const noisy = dot(v.queryVector(analyze('printer banana forklift orchestra')), target);
    expect(noisy).toBeLessThan(short / 1.5);
    expect(v.queryVector(analyze('banana')).idx).toEqual([]);
  });
});

describe('classifiers', () => {
  const all = dataset(40);
  const labels = Object.keys(CORPUS);
  // Every fourth example of each class is held out.
  const train = all.filter((_, i) => Math.floor(i / labels.length) % 4 !== 0);
  const test = all.filter((_, i) => Math.floor(i / labels.length) % 4 === 0);
  const vec = TfidfVectorizer.fit(train.map((d) => analyze(d.text, { bigrams: true })));
  const X = train.map((d) => vec.transform(analyze(d.text, { bigrams: true })));
  const y = train.map((d) => labels.indexOf(d.label));
  const Xt = test.map((d) => vec.transform(analyze(d.text, { bigrams: true })));
  const yt = test.map((d) => labels.indexOf(d.label));

  it('multinomial Naive Bayes reaches at least 85% accuracy on separable categories', () => {
    const nb = NaiveBayes.train(X, y, labels.length, vec.size);
    expect(evaluate(nb, Xt, yt).accuracy).toBeGreaterThanOrEqual(0.85);
  });

  it('logistic regression reaches at least 85% accuracy and gives calibrated-looking probabilities', () => {
    const lr = LogisticRegression.train(X, y, labels.length, vec.size, { seed: 3 });
    expect(evaluate(lr, Xt, yt).accuracy).toBeGreaterThanOrEqual(0.85);
    const p = softmax(
      lr.scores(vec.transform(analyze('VPN keeps disconnecting at home', { bigrams: true }))),
    );
    expect(labels[p.indexOf(Math.max(...p))]).toBe('network');
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // Serialisation keeps predictions identical.
    const again = LogisticRegression.fromJSON(JSON.parse(JSON.stringify(lr.toJSON())) as never);
    expect(evaluate(again, Xt, yt).accuracy).toBeCloseTo(evaluate(lr, Xt, yt).accuracy, 6);
  });

  it('clusters clearly separated topics into separate groups', () => {
    const docs = [
      ...Array.from(
        { length: 6 },
        (_, i) =>
          `vpn tunnel disconnects remote user ${['again', 'today', 'often', 'hourly', 'twice', 'now'][i]}`,
      ),
      ...Array.from(
        { length: 6 },
        (_, i) => `printer paper jam tray ${['one', 'two', 'three', 'four', 'five', 'six'][i]}`,
      ),
      ...Array.from(
        { length: 6 },
        (_, i) =>
          `mailbox quota full outlook ${['warning', 'error', 'alert', 'notice', 'banner', 'popup'][i]}`,
      ),
    ].map((d) => analyze(d));
    const v = TfidfVectorizer.fit(docs);
    const res = cluster(
      docs.map((d) => v.transform(d)),
      v.size,
    );
    expect(res.k).toBe(3);
    const groups = [0, 6, 12].map((start) => new Set(res.assign.slice(start, start + 6)));
    for (const g of groups) expect(g.size).toBe(1);
    expect(new Set(groups.map((g) => [...g][0])).size).toBe(3);
  });
});

describe('predictive intelligence on platform records', () => {
  let p: Platform;
  let sys: Context;
  let engine: AiEngine;
  const groups: Record<string, string> = {};
  let adminCtx: Context;

  beforeAll(() => {
    p = bootPlatform([aiModule, aiFixturesModule]);
    sys = p.systemContext();
    engine = aiEngineOf(p)!;
    makeUser(p, 'ml.admin', ['ai_admin', 'itil']);
    adminCtx = p.contextAs('ml.admin');
    for (const [cat, name] of Object.entries({
      network: 'Network Team',
      hardware: 'Hardware Team',
      software: 'Application Support',
      database: 'Database Team',
    })) {
      groups[cat] = sys.insert('sys_user_group', { name }).sysId;
    }
    // Resolved, labelled history.
    for (const d of dataset(25)) {
      sys.insert('incident', {
        short_description: d.text,
        category: d.label,
        assignment_group: groups[d.label],
        state: '6',
      });
    }
  });

  function defineSolution(values: Record<string, unknown>): string {
    return sys.insert('ml_solution_definition', {
      capability: 'classification',
      table: 'incident',
      input_fields: 'short_description,description',
      filter: 'state=6',
      confidence_threshold: 40,
      target_precision: 0,
      prediction_preference: 'autofill',
      ...values,
    }).sysId;
  }

  it('trains a categorization solution with holdout metrics and stores the model', () => {
    const id = defineSolution({ label: 'Test categorization', output_field: 'category' });
    const res = engine.predictor.train(adminCtx, id);
    expect(res.state).toBe('solution_complete');
    expect(res.trainingRecords).toBe(100);
    expect(res.accuracy).toBeGreaterThanOrEqual(85);
    expect(res.precision).toBeGreaterThanOrEqual(85);
    expect(res.coverage).toBeGreaterThan(50);
    expect(res.classes.map((c) => c.value).sort()).toEqual(['database', 'hardware', 'network', 'software']);
    const sol = sys.get('ml_solution', res.solution)!;
    expect(sol.str('state')).toBe('solution_complete');
    expect(JSON.parse(sol.str('artifact')).vectorizer.terms.length).toBeGreaterThan(20);
    expect(sys.count('ml_class', `solution=${res.solution}`)).toBe(4);
    expect(sys.get('ml_solution_definition', id)!.str('current_solution')).toBe(res.solution);
    expect(sys.get('ml_solution_definition', id)!.str('name')).toBe('ml_test_categorization');
  });

  it('fills an empty field on insert, adds a work note and logs the prediction', () => {
    const inc = sys.insert('incident', { short_description: 'VPN keeps disconnecting when working at home' });
    expect(inc.str('category')).toBe('network');
    const notes = p.history.journal('incident', inc.sysId, ['work_notes']);
    expect(notes[0].value).toMatch(
      /AI prediction: Category set to "Network" by Test categorization \(confidence \d+(\.\d)?%\)/,
    );
    const result = sys.first('ml_predictor_results', `record=${inc.sysId}^field=category`)!;
    expect(result.bool('applied')).toBe(true);
    expect(result.bool('above_threshold')).toBe(true);
    expect(result.str('predicted_value')).toBe('network');
    expect(result.num('confidence')).toBeGreaterThanOrEqual(40);
  });

  it('never overwrites a value set by a person', () => {
    const inc = sys.insert('incident', {
      short_description: 'VPN keeps disconnecting when working at home',
      category: 'hardware',
    });
    expect(inc.str('category')).toBe('hardware');
    expect(sys.count('ml_predictor_results', `record=${inc.sysId}^field=category`)).toBe(0);
  });

  it('logs but does not apply predictions below the threshold', () => {
    const def = sys.first('ml_solution_definition', 'name=ml_test_categorization')!;
    sys.update(def, { confidence_threshold: 101 });
    const inc = sys.insert('incident', { short_description: 'Excel crashes on startup after the update' });
    expect(inc.str('category')).toBe('inquiry');
    const result = sys.first('ml_predictor_results', `record=${inc.sysId}`)!;
    expect(result.bool('applied')).toBe(false);
    expect(result.bool('above_threshold')).toBe(false);
    expect(result.str('user_action')).toBe('skipped');
    expect(result.str('predicted_value')).toBe('software');
    sys.update(def, { confidence_threshold: 40, prediction_preference: 'monitor_only' });
    const monitored = sys.insert('incident', {
      short_description: 'SQL Server job failed overnight in production',
    });
    expect(monitored.str('category')).toBe('inquiry');
    const r2 = sys.first('ml_predictor_results', `record=${monitored.sysId}`)!;
    expect(r2.bool('above_threshold')).toBe(true);
    expect(r2.bool('applied')).toBe(false);
    sys.update(def, { prediction_preference: 'autofill' });
  });

  it('predicts reference fields such as the assignment group', () => {
    const id = defineSolution({ label: 'Test assignment', output_field: 'assignment_group' });
    expect(engine.predictor.train(adminCtx, id).state).toBe('solution_complete');
    const inc = sys.insert('incident', {
      short_description: 'Oracle database has a deadlock during month end',
    });
    expect(inc.str('assignment_group')).toBe(groups.database);
    expect(inc.display('assignment_group')).toBe('Database Team');
    expect(inc.str('category')).toBe('database');
  });

  it('records the outcome when the record closes', () => {
    const inc = sys.insert('incident', {
      short_description: 'wifi drops every few minutes on the guest network',
    });
    expect(inc.str('category')).toBe('network');
    sys.update(inc, { category: 'hardware' });
    const r = sys.first('ml_predictor_results', `record=${inc.sysId}^field=category`)!;
    expect(r.str('user_action')).toBe('replaced');
    sys.update(inc, { state: '7' });
    const closed = sys.get('ml_predictor_results', r.sysId)!;
    expect(closed.str('outcome')).toBe('incorrect');
    expect(closed.str('final_value')).toBe('hardware');
    const groupResult = sys.first('ml_predictor_results', `record=${inc.sysId}^field=assignment_group`)!;
    expect(sys.get('ml_predictor_results', groupResult.sysId)!.str('outcome')).toBe('correct');
  });

  it('refuses to train with too few records and keeps the previous solution', () => {
    const id = defineSolution({
      label: 'Too small',
      output_field: 'category',
      filter: 'short_descriptionLIKEnothing-matches',
    });
    const res = engine.predictor.train(adminCtx, id);
    expect(res.state).toBe('solution_error');
    expect(res.errorCode).toBe('insufficient_records');
    expect(sys.get('ml_solution_definition', id)!.str('current_solution')).toBe('');
  });

  it('seeds incident solution definitions in monitor-only mode and trains them from the job', () => {
    const seeded = sys.first('ml_solution_definition', 'name=ml_incident_categorization')!;
    expect(seeded.str('prediction_preference')).toBe('monitor_only');
    expect(seeded.str('filter')).toContain('stateIN6,7');
    expect(seeded.str('current_solution')).toBe('');
    const failing = sys.first('ml_solution_definition', 'name=ml_too_small');
    const attemptsBefore = failing ? sys.count('ml_solution', `definition=${failing.sysId}`) : 0;
    p.scheduler.runNow('ai.ml.train');
    expect(sys.get('ml_solution_definition', seeded.sysId)!.str('current_solution')).not.toBe('');
    expect(
      sys.first('ml_solution_definition', 'name=ml_incident_assignment')!.str('current_solution'),
    ).not.toBe('');
    // A definition that failed recently is retried a day later, not on every run.
    if (failing) expect(sys.count('ml_solution', `definition=${failing.sysId}`)).toBe(attemptsBefore);
    // Monitor-only: predictions are logged, fields are left alone.
    sys.update(sys.first('ml_solution_definition', 'name=ml_test_categorization')!, { active: false });
    sys.update(sys.first('ml_solution_definition', 'name=ml_test_assignment')!, { active: false });
    const inc = sys.insert('incident', {
      short_description: 'Teams client crashes on startup every afternoon',
    });
    expect(inc.str('category')).toBe('inquiry');
    expect(inc.str('assignment_group')).toBe('');
    expect(sys.count('ml_predictor_results', `record=${inc.sysId}^applied=false`)).toBe(2);
  });

  it('works on any table, for example the base task table', () => {
    const q = makeUser(p, 'task.agent', ['itil']);
    expect(q).toBeTruthy();
    for (const d of dataset(8))
      sys.insert('task', { short_description: `${d.text}`, assignment_group: groups[d.label], state: '3' });
    const id = sys.insert('ml_solution_definition', {
      label: 'Task routing',
      capability: 'classification',
      table: 'task',
      output_field: 'assignment_group',
      input_fields: 'short_description',
      filter: 'sys_class_name=task',
      confidence_threshold: 30,
      target_precision: 0,
      prediction_preference: 'recommendation',
    }).sysId;
    const res = engine.predictor.train(adminCtx, id);
    expect(res.state).toBe('solution_complete');
    const draft = sys.newRecord('task');
    draft.set('short_description', 'docking station will not power on at my desk');
    const preds = engine.predictor.predictRecord(draft).filter((x) => x.definition === id);
    expect(preds[0].value).toBe(groups.hardware);
    // Recommendation preference: logged, never written.
    const t = sys.insert('task', { short_description: 'docking station will not power on at my desk' });
    expect(t.str('assignment_group')).toBe('');
    expect(sys.first('ml_predictor_results', `record=${t.sysId}^definition=${id}`)!.str('preference')).toBe(
      'recommendation',
    );
  });
});

describe('similarity and clustering', () => {
  let p: Platform;
  let sys: Context;
  let engine: AiEngine;
  const ids: Record<string, string> = {};

  beforeAll(() => {
    p = bootPlatform([aiModule, aiFixturesModule]);
    sys = p.systemContext();
    engine = aiEngineOf(p)!;
    makeUser(p, 'sim.agent', ['itil']);
    const callerId = makeUser(p, 'sim.caller', []);
    const mk = (key: string, sd: string, extra: Record<string, unknown> = {}) => {
      ids[key] = sys.insert('incident', { short_description: sd, ...extra }).sysId;
    };
    mk('vpn1', 'VPN tunnel disconnects for remote users every hour', { category: 'network' });
    mk('vpn2', 'Remote VPN users disconnected again this morning', { category: 'network' });
    mk('vpn3', 'VPN disconnects when connecting from home', { category: 'network', caller_id: callerId });
    mk('vpn4', 'VPN tunnel unstable, remote users disconnected', { category: 'network' });
    mk('prn1', 'Printer on floor 3 has a paper jam', { category: 'hardware' });
    mk('prn2', 'Paper jam in the floor 3 printer again', { category: 'hardware' });
    mk('prn3', 'Floor 3 printer paper jam, cannot print', { category: 'hardware' });
    mk('prn4', 'Printer jammed with paper on third floor', { category: 'hardware' });
    mk('mail1', 'Outlook mailbox full, cannot send email', { category: 'software' });
    mk('mail2', 'Mailbox quota exceeded in Outlook', { category: 'software' });
    mk('mail3', 'Outlook says my mailbox is full', { category: 'software' });
    mk('mail4', 'Email mailbox over quota warning in Outlook', { category: 'software' });
    const kb = sys.insert('kb_knowledge_base', { title: 'IT' }).sysId;
    sys.insert('kb_knowledge', {
      kb_knowledge_base: kb,
      short_description: 'Fix VPN disconnects for remote users',
      text: '<p>If the VPN tunnel disconnects, update the VPN client and switch to the wired network.</p>',
      workflow_state: 'published',
    });
    sys.insert('kb_knowledge', {
      kb_knowledge_base: kb,
      short_description: 'Clear a printer paper jam',
      text: '<p>Open the front tray, remove the jammed paper and restart the printer.</p>',
      workflow_state: 'published',
    });
    sys.insert('kb_knowledge', {
      kb_knowledge_base: kb,
      short_description: 'VPN draft notes',
      text: '<p>VPN tunnel remote users disconnect.</p>',
      workflow_state: 'draft',
    });
  });

  it('ranks similar incidents first and excludes the source record', () => {
    const agent = p.contextAs('sim.agent');
    const src = agent.get('incident', ids.vpn1)!;
    const res = engine.similarity.similarToRecord(agent, src, ['incident', 'kb_knowledge'], { limit: 3 });
    expect(res.incident.map((h) => h.sys_id)).not.toContain(ids.vpn1);
    expect(res.incident.length).toBeGreaterThanOrEqual(2);
    for (const h of res.incident) expect(['vpn2', 'vpn3', 'vpn4'].map((k) => ids[k])).toContain(h.sys_id);
    expect(res.incident[0].score).toBeGreaterThanOrEqual(res.incident[res.incident.length - 1].score);
    // Only published articles are suggested.
    expect(res.kb_knowledge.map((h) => h.title)).toEqual(['Fix VPN disconnects for remote users']);
  });

  it('suggests knowledge articles for free text and sees new records after a change', () => {
    const agent = p.contextAs('sim.agent');
    expect(engine.similarity.suggestKnowledge(agent, 'paper jam in printer')[0].title).toBe(
      'Clear a printer paper jam',
    );
    const draft = sys.first('kb_knowledge', 'short_description=VPN draft notes')!;
    sys.update(draft, { workflow_state: 'published' });
    const titles = engine.similarity
      .suggestKnowledge(agent, 'vpn tunnel remote users disconnect', { limit: 5 })
      .map((h) => h.title);
    expect(titles).toContain('VPN draft notes');
  });

  it('only returns records the caller may read', () => {
    const caller = p.contextAs('sim.caller');
    const hits = engine.similarity.similarToText(caller, 'VPN disconnects remote users', 'incident', {
      limit: 10,
    });
    expect(hits.map((h) => h.sys_id)).toEqual([ids.vpn3]);
  });

  it('clusters open incidents into problem candidates', () => {
    const agent = p.contextAs('sim.agent');
    const res = engine.similarity.clusters(agent, 'incident', { minSize: 3 });
    expect(res.records).toBe(12);
    const candidates = res.clusters.filter((c) => c.problem_candidate);
    expect(candidates.length).toBe(3);
    for (const c of candidates) {
      expect(c.size).toBe(4);
      const purity = c.purity.find((x) => x.field === 'category')!;
      expect(purity.share).toBe(1);
      expect(c.terms.length).toBeGreaterThan(0);
    }
    const vpnCluster = candidates.find((c) => c.members.some((m) => m.sys_id === ids.vpn1))!;
    expect(vpnCluster.concept.toLowerCase()).toContain('vpn');
  });
});

describe('demo setup', () => {
  it('activates every skill, enables MCP and trains the incident solutions on autofill', () => {
    const p = bootPlatform([aiModule, aiFixturesModule]);
    const sys = p.systemContext();
    makeUser(p, 'demo.agent', ['itil']);
    expect(sys.count('sn_nowassist_skill_config', 'active=false')).toBeGreaterThan(0);
    for (const d of dataset(10))
      sys.insert('incident', { short_description: d.text, category: d.label, state: '2' });
    demoAi(sys);
    expect(sys.count('sn_nowassist_skill_config', 'active=false')).toBe(0);
    expect(p.properties.getBool('resolvr.mcp.enabled')).toBe(true);
    expect(p.contextAs('demo.agent').hasRole('mcp_user')).toBe(true);
    const cat = sys.first('ml_solution_definition', 'name=ml_incident_categorization')!;
    expect(cat.str('prediction_preference')).toBe('autofill');
    expect(sys.get('ml_solution', cat.str('current_solution'))!.str('state')).toBe('solution_complete');
    // No assignment groups in this data set: that training fails without breaking the demo.
    const grp = sys.first('ml_solution_definition', 'name=ml_incident_assignment')!;
    expect(grp.str('current_solution')).toBe('');
    expect(sys.first('ml_solution', `definition=${grp.sysId}`)!.str('state')).toBe('solution_error');
    p.close();
  });
});
