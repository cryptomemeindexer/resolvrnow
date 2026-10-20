# Writing a ResolvrNow module

ResolvrNow is a metadata-driven platform: every application (Incident, Change, Catalog...)
is a **module** that contributes tables, choices, business rules, access controls, UI metadata,
scheduled jobs, HTTP routes and data. This guide is the contract for module authors.

Read first: `server/src/engine/types.ts`, `server/src/engine/module.ts`,
`server/src/engine/context.ts`, `server/src/engine/record.ts`,
`server/src/modules/task/index.ts` (a complete small module) and `server/src/modules/contracts.ts`.

## Layout and commands

```
server/src/modules/<id>/index.ts     # exports `<id>Module: AppModule`
server/src/modules/<id>/*.ts         # tables.ts, rules.ts, api.ts, demo.ts ... as you like
server/test/<id>.test.ts             # vitest tests for the module
```

- `cd server && npx tsc -p tsconfig.json --noEmit` — typecheck (must stay clean)
- `cd server && npx vitest run test/<id>.test.ts` — run your tests
- Only edit files inside your module folder and your test files, unless your task says otherwise.
  `server/src/modules/index.ts` already registers every module.

## Clean-room rule

Behaviour comes from the specs in `docs/spec/*.md` (written in our own words from public docs).
Use the real table and field names (compatibility), but never paste vendor documentation or code.
Comments and UI text are our own.

## Tables

```ts
import { sdkTable } from '../../schema/sdk.js';           // schemas derived from the MIT SDK
sdkTable('incident', { audit: true, patch: { state: { choices } }, exclude: ['x'] })
// or a hand-written definition
{ name: 'incident_task', label: 'Incident Task', extends: 'task', number: { prefix: 'TASK', start: 1000000 },
  columns: [{ name: 'incident', label: 'Incident', type: 'reference', reference: 'incident' }] }
```

- `hasSdkTable(name)` / `sdkColumnNames(name)` tell you what the SDK schema has
  (`server/src/schema/sdk/sdk-tables.json`). Prefer `sdkTable()` when the table exists there.
- Storage is table-per-hierarchy: a table that `extends: 'task'` lives in the `task` SQL table.
  Querying `task` returns all subclasses; querying `incident` only incidents.
- Field types: see `FieldType` in `types.ts`. Journal fields (`comments`, `work_notes`) are not
  stored on the row; setting them appends a journal entry.
- Choices: put them on the column (`choices: [{ value, label, sequence, dependentValue }]`) or in
  the module's `choices: { 'table.field': [...] }` map (use this to override inherited lists, e.g.
  `incident.state`). Child tables inherit the parent's list unless they define their own.
- Numbering: `number: { prefix: 'INC', start: 10000 }` gives INC0010001, INC0010002...
- `displayField` is what references show (defaults to `number`, then `name`).
- Product-specific tables that have no platform equivalent use the `resolvr_` prefix; product
  properties use the `resolvr.` prefix. Never put "ServiceNow" in names.

## Records and contexts

```ts
const ctx = platform.systemContext();            // no ACLs; actions attributed to "system"
const ctx2 = platform.contextAs('abel.agent');   // a user's context (ACLs enforced)
const inc = ctx.insert('incident', { short_description: 'VPN down', caller_id: userId, impact: 1 });
inc.str('number'); inc.num('priority'); inc.bool('active'); inc.display('state'); inc.ref('caller_id')
ctx.update(inc, { state: '2', work_notes: 'Investigating' });
ctx.query('incident', { query: 'active=true^priority=1', limit: 10, orderBy: [{ field: 'number', desc: true }] });
ctx.query('incident', 'active=true');            // shorthand
ctx.get('incident', sysId); ctx.first('incident', 'number=INC0010001'); ctx.count('incident', 'active=true');
ctx.delete(rec);
ctx.elevated();      // same user, no ACL checks (use inside automation that must see everything)
ctx.queueEvent('incident.assigned', inc, parm1, parm2);
ctx.addInfoMessage('Problem PRB0040001 created');
```

`Rec` API: `get/str/num/bool`, `set(field, value)` (coerces, resolves display values for
references/choices), `setRaw(field, storedValue)` (no coercion — use inside business rules),
`changed(f)`, `changedTo(f, v)`, `changedFrom(f, v)`, `prev(f)`, `isNew()`, `display(f)`,
`ref(f)`, `abort(message)`, `className`, `sysId`.

Stored representations: integers/booleans are numbers (booleans 0/1), date-times are UTC strings
`YYYY-MM-DD HH:MM:SS` (`nowGlide()`, `addMs()`, `diffMs()` in `engine/util.ts`), durations are
milliseconds. Use `clock.now()` (never `Date.now()`) so tests can freeze/advance time.

## Business rules

```ts
rules: [{
  name: 'Incident: resolve sets resolved_at', table: 'incident',
  when: 'before', actions: ['insert', 'update'], order: 100,
  condition: (cur, prev, ctx) => cur.changedTo('state', 6),   // or an encoded query string
  run(cur, prev, ctx) { cur.setRaw('resolved_at', nowGlide()); },
}]
```

- `before` rules mutate `cur` (no explicit save). `after` rules see the saved record; to change
  *other* records call `ctx.update(...)`. To change the *same* record in an after rule, prefer a
  before rule instead (avoid recursion).
- Rules on a parent table run for child tables (rules on `task` run for incidents).
- `cur.abort('message')` in a before rule cancels the operation (REST returns 403 "Operation Failed").
- `async` rules run after the transaction (tests: call `platform.drain()`).
- Query rules: `{ when: 'before', actions: ['query'], query(qb, ctx) { if (!ctx.hasRole('itil')) qb.addEncodedQuery('caller_id=javascript:gs.getUserID()') } }`.
- String conditions support `CHANGES` operators: `stateCHANGESTO6`, `assigned_toVALCHANGES`.

## Access control

```ts
acls: [
  { name: 'incident', operation: 'read', roles: ['itil'] },
  { name: 'incident', operation: 'read', condition: 'caller_id=javascript:gs.getUserID()' },
  { name: 'incident.close_code', operation: 'write', roles: ['itil'] },
  { name: 'incident', operation: 'write', script: (rec, ctx) => !!rec && rec.bool('active') },
]
```

First matching name level decides (table → parent tables → `*`); any ACL at that level passing
grants access. Admin passes unless `adminOverrides: false`. Default is deny. Field ACLs:
`table.field`, `parent.field`, `*.field`, `table.*`, `*.*`.

## UI metadata

```ts
ui: {
  navigation: [{ id: 'incident', title: 'Incident', icon: 'flame', roles: ['itil'], order: 20,
    modules: [{ title: 'Open', table: 'incident', query: 'active=true' }, { title: 'Create New', table: 'incident', route: '/workspace/record/incident/-1' }] }],
  lists: [{ table: 'incident', columns: ['number', 'short_description', 'caller_id', 'priority', 'state', 'assignment_group', 'assigned_to'] }],
  forms: [{ table: 'incident', highlights: ['priority', 'state', 'assigned_to'],
    sections: [{ left: ['number', 'caller_id', 'category'], right: ['state', 'impact', 'urgency', 'priority'] },
               { fields: ['short_description', 'description'] }, { caption: 'Notes', fields: ['comments', 'work_notes'] }],
    relatedLists: [{ table: 'incident_task', field: 'incident' }] }],
  uiActions: [{ id: 'incident.resolve', table: 'incident', label: 'Resolve', style: 'primary',
    condition: 'active=true^state!=6', prompt: [{ field: 'close_code', mandatory: true }, { field: 'close_notes', mandatory: true }],
    run(rec, ctx, input) { ctx.update(rec, { state: '6', ...input }); return { message: 'Incident resolved' }; } }],
  uiPolicies: [{ id: 'incident.on_hold_reason', table: 'incident', name: 'Hold reason mandatory when on hold',
    condition: 'state=3', reverseIfFalse: true, actions: [{ field: 'hold_reason', mandatory: true, visible: true }] }],
}
```

Icons are lucide icon names (kebab-case). Workspace routes: `/workspace/list/<table>?query=...`,
`/workspace/record/<table>/<sys_id>` (`-1` = new). UI actions run server-side via
`POST /api/app/action/<table>/<sys_id>/<actionId>`.

## Events, jobs, properties, services

```ts
events: [{ name: 'incident.assigned', table: 'incident', description: '...' }],
eventHandlers: [{ event: 'incident.assigned', name: 'notify assignee', run(ev, rec, ctx) { ... } }],
jobs: [{ id: 'incident.autoclose', name: 'Auto-close resolved incidents', intervalMs: 3600_000, run(ctx) { ... } }],
properties: [{ name: 'glide.ui.autoclose.time', value: '7', type: 'integer', description: '...' }],
register(platform) { platform.services.set('approvals', new ApprovalEngine(platform)); platform.hooks.on('update', 'task', 'sla', (rec, prev, ctx) => ...) },
```

Cross-module calls go through `server/src/modules/contracts.ts` (`optionalService<T>(platform, SERVICES.x)`).
If the provider is missing, degrade gracefully.

## Seeds and demo data

- `seed(ctx)`: required reference data (roles are created automatically from `roles`), e.g. groups,
  catalogs, SLA definitions. Runs once per `seedVersion`.
- `demo(ctx)`: realistic sample data loaded when `RESOLVRNOW_DEMO=true` (and in the demo build).
  Write original sample content (fictional company "Northwind Labs"), never vendor demo data.

## HTTP routes (module APIs)

```ts
http(app, deps) { registerChangeApi(app as FastifyInstance, deps as ApiDeps); }
```
Use helpers from `server/src/api/http.ts` (`ctxOf`, `nowRoute`, `HttpError`, `intParam`, `baseUrl`)
and `serializeRecord` from `server/src/api/serialize.ts`. Platform-compatible APIs keep their
original paths (e.g. `/api/sn_chg_rest/change`); product APIs live under `/api/app/<module>/...`.

## Tests

```ts
import { bootPlatform, makeUser } from './helpers.js';
const p = bootPlatform([cmdbModule, incidentModule]);   // platform + task are always included
const agent = makeUser(p, 'abel.agent', ['itil'], ['Service Desk']);
const ctx = p.contextAs('abel.agent');
clock.freeze('2026-01-05 09:00:00'); clock.advance(3_600_000);   // from engine/util.js
p.drain();               // run async rules + queued events
p.scheduler.runNow('incident.autoclose');
```
Boot only the modules you need. Cover the spec's acceptance tests that apply to the engine.
