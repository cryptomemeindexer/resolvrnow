/**
 * Differential API compatibility suite.
 *
 * Runs the same REST requests against a reference instance (e.g. your own developer
 * instance of the platform ResolvrNow is compatible with) and against ResolvrNow, then
 * compares status codes, headers, response shapes, query semantics and choice lists.
 *
 * Credentials are read from an env file and never printed:
 *   SN_INSTANCE_URL, SN_USERNAME, SN_PASSWORD          reference instance
 *   RN_URL (default http://localhost:8080), RN_USERNAME, RN_PASSWORD   ResolvrNow
 *
 * Usage:
 *   npx tsx server/compat/run.ts [--env-file ~/.config/resolvrnow/servicenow.env] [--out docs/compat]
 *
 * Records created during the run are tagged and deleted at the end on both sides.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

interface Target {
  name: string;
  base: string;
  auth: string;
}

interface Res {
  status: number;
  headers: Headers;
  body: unknown;
}

interface CheckResult {
  id: string;
  title: string;
  ok: boolean;
  details: string[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadEnvFile(): Record<string, string> {
  const candidates = [
    arg('env-file'),
    join(homedir(), '.config/resolvrnow/servicenow.env'),
  ].filter(Boolean) as string[];
  const file = candidates.map((c) => resolve(c.replace(/^~/, homedir()))).find((c) => existsSync(c));
  const env: Record<string, string> = {};
  if (file) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return { ...env, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(SN|RN)_/.test(k)) as [string, string][]) };
}

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

async function call(t: Target, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${t.base}${path}`, {
    method,
    headers: { Authorization: t.auth, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

/** Structural signature of a JSON value: object keys and leaf types, ignoring values. */
function shape(v: unknown, depth = 0): unknown {
  if (depth > 4) return '…';
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = shape((v as Record<string, unknown>)[k], depth + 1);
    return out;
  }
  return typeof v;
}

function diffShapes(a: unknown, b: unknown, path = '$', out: string[] = []): string[] {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: reference ${JSON.stringify(a)} vs resolvrnow ${JSON.stringify(b)}`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length && b.length) diffShapes(a[0], b[0], `${path}[0]`, out);
    return out;
  }
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    for (const k of ka) if (!kb.includes(k)) out.push(`${path}.${k}: missing in resolvrnow`);
    for (const k of kb) if (!ka.includes(k)) out.push(`${path}.${k}: extra in resolvrnow`);
    for (const k of ka) if (kb.includes(k)) diffShapes((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
    return out;
  }
  if (a !== b) out.push(`${path}: reference ${String(a)} vs resolvrnow ${String(b)}`);
  return out;
}

const KEY_FIELDS = ['number', 'short_description', 'state', 'priority', 'impact', 'urgency', 'caller_id', 'assigned_to', 'active', 'sys_id', 'sys_created_on'];

async function main(): Promise<void> {
  const env = loadEnvFile();
  if (!env.SN_INSTANCE_URL || !env.SN_USERNAME || !env.SN_PASSWORD) {
    console.error('Reference instance credentials missing. Create ~/.config/resolvrnow/servicenow.env with SN_INSTANCE_URL, SN_USERNAME, SN_PASSWORD.');
    process.exit(2);
  }
  const ref: Target = { name: 'reference', base: env.SN_INSTANCE_URL.replace(/\/$/, ''), auth: basic(env.SN_USERNAME, env.SN_PASSWORD) };
  const rn: Target = {
    name: 'resolvrnow',
    base: (env.RN_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
    auth: basic(env.RN_USERNAME ?? 'admin', env.RN_PASSWORD ?? 'admin'),
  };
  const tag = `rn-compat-${Date.now().toString(36)}`;
  const results: CheckResult[] = [];
  const created: { t: Target; table: string; id: string }[] = [];
  const check = async (id: string, title: string, fn: () => Promise<string[]>) => {
    try {
      const details = await fn();
      results.push({ id, title, ok: details.length === 0, details });
    } catch (e) {
      results.push({ id, title, ok: false, details: [`error: ${(e as Error).message}`] });
    }
    process.stdout.write(results[results.length - 1].ok ? '.' : 'F');
  };
  const both = async (method: string, path: string, body?: unknown) => Promise.all([call(ref, method, path, body), call(rn, method, path, body)]);

  // --- connectivity
  await check('auth.ok', 'Both instances accept Basic auth', async () => {
    const [a, b] = await both('GET', '/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id');
    return [a.status !== 200 ? `reference status ${a.status}` : '', b.status !== 200 ? `resolvrnow status ${b.status}` : ''].filter(Boolean);
  });
  await check('auth.401', 'Unauthenticated request returns 401 with the same error shape', async () => {
    const [a, b] = await Promise.all([fetch(`${ref.base}/api/now/table/incident?sysparm_limit=1`), fetch(`${rn.base}/api/now/table/incident?sysparm_limit=1`)]);
    const out: string[] = [];
    if (a.status !== b.status) out.push(`status reference ${a.status} vs resolvrnow ${b.status}`);
    diffShapes(shape(await a.json().catch(() => null)), shape(await b.json().catch(() => null)), '$', out);
    return out;
  });

  // --- create fixtures on both sides
  const incidents: Record<string, { ref: string; rn: string }> = {};
  for (const [k, body] of Object.entries({
    p1: { short_description: `${tag} database outage`, impact: '1', urgency: '1' },
    p3: { short_description: `${tag} printer jam`, impact: '2', urgency: '2' },
    p5: { short_description: `${tag} wallpaper request`, impact: '3', urgency: '3' },
  })) {
    const [a, b] = await both('POST', '/api/now/table/incident', body);
    const ra = (a.body as { result?: Record<string, unknown> })?.result;
    const rb = (b.body as { result?: Record<string, unknown> })?.result;
    if (ra?.sys_id) created.push({ t: ref, table: 'incident', id: String(ra.sys_id) });
    if (rb?.sys_id) created.push({ t: rn, table: 'incident', id: String(rb.sys_id) });
    incidents[k] = { ref: String(ra?.sys_id ?? ''), rn: String(rb?.sys_id ?? '') };
    await check(`post.incident.${k}`, `POST incident (${k}) status, shape and computed priority`, async () => {
      const out: string[] = [];
      if (a.status !== b.status) out.push(`status reference ${a.status} vs resolvrnow ${b.status}`);
      for (const f of ['priority', 'state', 'active', 'impact', 'urgency']) {
        if (String(ra?.[f]) !== String(rb?.[f])) out.push(`${f}: reference ${String(ra?.[f])} vs resolvrnow ${String(rb?.[f])}`);
      }
      const keysA = Object.keys(ra ?? {});
      const keysB = Object.keys(rb ?? {});
      const missing = keysA.filter((x) => !keysB.includes(x));
      if (missing.length) out.push(`fields missing in resolvrnow: ${missing.slice(0, 40).join(', ')}${missing.length > 40 ? ` (+${missing.length - 40})` : ''}`);
      if (!/^INC\d{7}$/.test(String(rb?.number ?? ''))) out.push(`resolvrnow number format ${String(rb?.number)}`);
      return out;
    });
  }

  // --- display value modes and reference shapes
  for (const mode of ['false', 'true', 'all']) {
    await check(`get.display.${mode}`, `GET with sysparm_display_value=${mode} has identical field shapes`, async () => {
      const [a, b] = await Promise.all([
        call(ref, 'GET', `/api/now/table/incident/${incidents.p1.ref}?sysparm_display_value=${mode}&sysparm_fields=${KEY_FIELDS.join(',')}`),
        call(rn, 'GET', `/api/now/table/incident/${incidents.p1.rn}?sysparm_display_value=${mode}&sysparm_fields=${KEY_FIELDS.join(',')}`),
      ]);
      return diffShapes(shape(a.body), shape(b.body));
    });
  }
  await check('get.exclude_reference_link', 'sysparm_exclude_reference_link flattens references identically', async () => {
    const [a, b] = await Promise.all([
      call(ref, 'GET', `/api/now/table/incident/${incidents.p1.ref}?sysparm_exclude_reference_link=true&sysparm_fields=caller_id,opened_by`),
      call(rn, 'GET', `/api/now/table/incident/${incidents.p1.rn}?sysparm_exclude_reference_link=true&sysparm_fields=caller_id,opened_by`),
    ]);
    return diffShapes(shape(a.body), shape(b.body));
  });

  // --- encoded query semantics on the tagged fixtures
  const queries = [
    `short_descriptionSTARTSWITH${tag}`,
    `short_descriptionSTARTSWITH${tag}^priority=1`,
    `short_descriptionSTARTSWITH${tag}^priority=1^ORpriority=5`,
    `short_descriptionSTARTSWITH${tag}^priorityIN3,5`,
    `short_descriptionSTARTSWITH${tag}^priority!=1`,
    `short_descriptionSTARTSWITH${tag}^short_descriptionLIKEprinter`,
    `short_descriptionSTARTSWITH${tag}^short_descriptionNOT LIKEprinter`,
    `short_descriptionSTARTSWITH${tag}^priority<=3`,
    `short_descriptionSTARTSWITH${tag}^assigned_toISEMPTY`,
    `short_descriptionSTARTSWITH${tag}^sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()`,
    `short_descriptionSTARTSWITH${tag}^NQshort_descriptionSTARTSWITH${tag}^priority=1`,
  ];
  for (const q of queries) {
    await check(`query.${q.replace(tag, 'TAG').slice(0, 60)}`, `Encoded query count: ${q.replace(tag, '<tag>')}`, async () => {
      const [a, b] = await both('GET', `/api/now/table/incident?sysparm_query=${encodeURIComponent(q)}&sysparm_fields=sys_id`);
      const ca = ((a.body as { result?: unknown[] })?.result ?? []).length;
      const cb = ((b.body as { result?: unknown[] })?.result ?? []).length;
      return ca === cb ? [] : [`reference ${ca} vs resolvrnow ${cb}`];
    });
  }

  // --- pagination headers
  await check('paging.headers', 'X-Total-Count and Link rel set match', async () => {
    const path = `/api/now/table/incident?sysparm_query=${encodeURIComponent(`short_descriptionSTARTSWITH${tag}`)}&sysparm_limit=1&sysparm_offset=1`;
    const [a, b] = await both('GET', path);
    const rels = (h: Headers) => [...(h.get('link') ?? '').matchAll(/rel="(\w+)"/g)].map((m) => m[1]).sort().join(',');
    const out: string[] = [];
    if (a.headers.get('x-total-count') !== b.headers.get('x-total-count'))
      out.push(`X-Total-Count reference ${a.headers.get('x-total-count')} vs resolvrnow ${b.headers.get('x-total-count')}`);
    if (rels(a.headers) !== rels(b.headers)) out.push(`Link rels reference [${rels(a.headers)}] vs resolvrnow [${rels(b.headers)}]`);
    return out;
  });

  // --- errors
  await check('error.invalid_table', 'Unknown table error status and shape', async () => {
    const [a, b] = await both('GET', '/api/now/table/not_a_real_table_xyz');
    const out: string[] = [];
    if (a.status !== b.status) out.push(`status reference ${a.status} vs resolvrnow ${b.status}`);
    diffShapes(shape(a.body), shape(b.body), '$', out);
    return out;
  });
  await check('error.not_found', 'Missing record error status and shape', async () => {
    const [a, b] = await both('GET', '/api/now/table/incident/00000000000000000000000000000000');
    const out: string[] = [];
    if (a.status !== b.status) out.push(`status reference ${a.status} vs resolvrnow ${b.status}`);
    diffShapes(shape(a.body), shape(b.body), '$', out);
    return out;
  });

  // --- update and state machine
  await check('patch.state.resolve', 'Resolving an incident (state 6) sets resolution fields the same way', async () => {
    const body = { state: '6', close_code: 'Solution provided', close_notes: 'compat check' };
    const [a, b] = await Promise.all([
      call(ref, 'PATCH', `/api/now/table/incident/${incidents.p3.ref}`, body),
      call(rn, 'PATCH', `/api/now/table/incident/${incidents.p3.rn}`, body),
    ]);
    const ra = (a.body as { result?: Record<string, string> })?.result ?? {};
    const rb = (b.body as { result?: Record<string, string> })?.result ?? {};
    const out: string[] = [];
    if (a.status !== b.status) out.push(`status reference ${a.status} vs resolvrnow ${b.status}`);
    for (const f of ['state', 'incident_state', 'active']) if (ra[f] !== rb[f]) out.push(`${f}: reference ${ra[f]} vs resolvrnow ${rb[f]}`);
    for (const f of ['resolved_at', 'resolved_by']) if (!!ra[f] !== !!rb[f]) out.push(`${f} set: reference ${!!ra[f]} vs resolvrnow ${!!rb[f]}`);
    return out;
  });

  // --- aggregate API
  await check('stats.count', 'Aggregate API count by priority', async () => {
    const q = encodeURIComponent(`short_descriptionSTARTSWITH${tag}`);
    const [a, b] = await both('GET', `/api/now/stats/incident?sysparm_query=${q}&sysparm_count=true&sysparm_group_by=priority`);
    const norm = (x: unknown) =>
      ((x as { result?: { stats: { count: string }; groupby_fields: { value: string }[] }[] })?.result ?? [])
        .map((r) => `${r.groupby_fields?.[0]?.value}:${r.stats?.count}`)
        .sort()
        .join(' ');
    return norm(a.body) === norm(b.body) ? [] : [`reference ${norm(a.body)} vs resolvrnow ${norm(b.body)}`];
  });

  // --- metadata facts: choice lists of key fields
  for (const [table, element] of [
    ['incident', 'state'],
    ['incident', 'close_code'],
    ['incident', 'hold_reason'],
    ['task', 'priority'],
    ['problem', 'state'],
    ['change_request', 'state'],
    ['change_request', 'type'],
    ['sc_req_item', 'stage'],
    ['kb_knowledge', 'workflow_state'],
    ['cmdb_ci', 'operational_status'],
  ]) {
    await check(`choices.${table}.${element}`, `Choice list ${table}.${element}`, async () => {
      const path = `/api/now/table/sys_choice?sysparm_query=${encodeURIComponent(`name=${table}^element=${element}^inactive=false^language=en^ORDERBYsequence`)}&sysparm_fields=value,label`;
      const [a, b] = await both('GET', path);
      const fmt = (x: unknown) =>
        ((x as { result?: { value: string; label: string }[] })?.result ?? [])
          .map((c) => `${c.value}=${c.label}`)
          .sort();
      const ca = fmt(a.body);
      const cb = fmt(b.body);
      const missing = ca.filter((c) => !cb.includes(c));
      const extra = cb.filter((c) => !ca.includes(c));
      return [...missing.map((m) => `missing in resolvrnow: ${m}`), ...extra.map((m) => `extra in resolvrnow: ${m}`)];
    });
  }

  // --- cleanup
  for (const c of created) await call(c.t, 'DELETE', `/api/now/table/${c.table}/${c.id}`).catch(() => undefined);

  const passed = results.filter((r) => r.ok).length;
  const lines = [
    `# API compatibility report`,
    '',
    `Run: ${new Date().toISOString()} · ${passed}/${results.length} checks passed`,
    '',
    '| Check | Result | Differences |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.title.replace(/\|/g, '\\|')} | ${r.ok ? 'pass' : '**fail**'} | ${r.details.map((d) => d.replace(/\|/g, '\\|')).join('<br>')} |`),
    '',
    'Reference values are compared structurally; no record contents from the reference instance are stored in this report except choice values and labels.',
  ];
  const out = resolve(arg('out') ?? 'docs/compat');
  mkdirSync(out, { recursive: true });
  const file = join(out, `report-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  console.log(`\n${passed}/${results.length} checks passed. Report: ${file}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
