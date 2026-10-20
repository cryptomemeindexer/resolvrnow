# How ResolvrNow was reverse engineered

ResolvrNow is a **clean-room** reimplementation of the IT Service Management (ITSM) capabilities
of a well-known commercial platform. This document explains how the target was studied, what
evidence was collected, what the evidence established, and the rules that kept the work clean.

The investigation used **[REA – Reverse Engineer Anything](https://github.com/morluto/rea)**
(`rea-agents` 6.7.0), an evidence-first reverse-engineering toolkit. Every conclusion below is
tied to a REA Evidence record (`ev_…` identifiers), so the reasoning can be audited.

> ServiceNow is a trademark of ServiceNow, Inc. ResolvrNow is independent and not affiliated
> with, endorsed or sponsored by ServiceNow, Inc. The product is referenced only to describe
> compatibility.

## 1. Questions the investigation had to answer

| # | Question | Evidence needed | Status |
|---|---|---|---|
| Q1 | Which capabilities make up the ITSM product, and how are they packaged? | Official product pages | Answered |
| Q2 | What is the data model (tables, inheritance, fields, types, numbering)? | First-party machine-readable schema | Answered (186 tables) |
| Q3 | How do the processes behave (state models, rules, approvals, SLAs)? | Public product documentation | Answered for core processes; residual unknowns marked *Inferred* in the specs |
| Q4 | What is the external API contract (Table, Aggregate, Attachment, Import, Change, Catalog, CMDB, Knowledge APIs, encoded queries)? | Public API reference | Answered |
| Q5 | What do the agent workspace and employee portal look like and do? | Product pages, documentation | Answered at screen level |
| Q6 | Does the clone behave correctly in a real browser? | Runtime captures of ResolvrNow itself | Answered; two bugs found and fixed |

## 2. Method

### 2.1 Runtime observation of public product pages (REA browser scenarios)

REA's `capture-browser-scenario` drove a Chrome browser through the public product pages and
captured the accessibility tree, DOM, screenshots and network events as Evidence.

**Finding: bot protection.** The first headless capture returned `403 Access Denied` from the
site's CDN (`ev_25959c79…`). Re-running the same scenario with a visible (headed) browser
succeeded (`ev_c9ae02dd…`). All later captures used headed mode.

| Capture | What it established | Evidence |
|---|---|---|
| Products-by-category page (headless) | CDN blocks headless browsers | `ev_25959c79f3cb80b4c4cbbe377c38ef2e0c502cf8813c085453e25dc973734b2a` |
| Products-by-category page (headed) | ITSM's place in the portfolio | `ev_c9ae02dd392978f22afa49ac31bce045329016bbe063d34fdaf296128fed9958` |
| ITSM product page | Positioning: incidents, problems, changes and requests on one platform and one data model | `ev_ccccebad6f319b81a5377a91a13df3e5546cc40c5c76a1f4f82de1bf1d315fb3` |
| ITSM capability tabs (6 scripted tab clicks) | The six pillars: incident resolution, agent productivity, self-service, service predictability, change management, issue identification, each linked to its documentation | `ev_8594c0f1880ff1bd98a43a5952abc93c5a3f8e1d394e9b321912f7aa1eea34e5` |
| Plans & packages page (accessibility tree) | Three editions and the capability comparison table | `ev_84e89f840379051ec7490d4cb5f0858d99f341bdfa5dc471c477bd883aa074d5` |
| Plans & packages page (DOM) | Per-edition availability and descriptions hidden in tooltips | `ev_baf1084c4e126b9802178b9f966ab357033cab8584d5c9f53e0d20621e7ad465` |
| A documentation page | The docs portal's JSON content API (section 2.2) | `ev_a5da4833ba66f6c4d9f1d9f4f6cd6da309df751d0b2ca24f4eeb608c9a5b47c7` |
| 14 capability pages (incident, problem, change, request, knowledge, CMDB, employee center, virtual agent, predictive intelligence, walk-up service desk, getting started, DevOps change, asset management, AI assistant) | Feature inventories per capability | `ev_ef76ba63…`, `ev_d39b6b1f…`, `ev_8061662e…`, `ev_436cffc8…`, `ev_ab8d6d25…`, `ev_c236180d…`, `ev_6ab5ae24…`, `ev_6c134484…`, `ev_db51a3ea…`, `ev_e33bae4e…`, `ev_5d23eac2…`, `ev_5036e23f…`, `ev_8daa7a84…`, `ev_47f44120…` |

The scenarios are in [`tooling/scenarios/`](tooling/scenarios); the capture helper is
[`tooling/capture.sh`](tooling/capture.sh).

### 2.2 Discovering the documentation API (REA network evidence)

The network events in `ev_a5da4833…` showed that the public documentation site is a
single-page app reading topics from a JSON API:

```
GET /docs/api/khub/maps                                   list of documentation "maps" (books)
GET /docs/api/khub/maps/{mapId}/toc                       table of contents (topic tree)
GET /docs/api/khub/maps/{mapId}/topics/{contentId}/content   topic HTML
```

Using those endpoints (rate-limited, sequential), the publicly readable documentation for the
relevant books was downloaded into a **private, local research corpus**: 3,441 topics across
ITSM, platform capabilities (CMDB, knowledge, catalog), platform administration, workflow,
API reference, UI, AI, analytics and asset management. The corpus was only read; it is **not
redistributed** in this repository. Tooling: [`tooling/fetch_docs.py`](tooling/fetch_docs.py).

### 2.3 Static analysis of the vendor's MIT-licensed SDK (REA application graph)

The vendor publishes `@servicenow/sdk-core` on npm under the MIT License. REA's
`analyze-javascript-application` parsed the package (2,155 files, 1,615 JavaScript sources,
8,995 graph nodes) into an authenticated application graph (`ev_570189c6e28db514ced75bcf667d92b0ea953c48e61812d2f2dd655fd9e27844`).
The graph located the package's table definition modules. An AST extractor
([`tooling/extract_tables.mjs`](tooling/extract_tables.mjs)) then read them **without executing
the package**. It produced the schema of 186 platform tables (task, incident, problem,
change_request, sc_req_item, kb_knowledge, cmdb_ci, task_sla, sys_user…): labels, inheritance,
auto-number prefixes, column names, types, reference targets and choice lists.

The derived schema ships as `server/src/schema/sdk/sdk-tables.json`, with attribution and the
MIT notice in [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md). Matching table and field
names is what makes existing API clients work against ResolvrNow unchanged.

### 2.4 From evidence to specifications

Seven research passes turned the corpus into implementation specs in `docs/spec/`. Each spec
is written in our own words, cites the public source URL of each section, and marks every
statement **[Documented]** or **[Inferred]**:

- REST API and encoded queries: [`rest-api.md`](../spec/rest-api.md), [`encoded-query.md`](../spec/encoded-query.md)
- [Incident](../spec/incident.md), [problem](../spec/problem.md), [change](../spec/change.md) and the [change API](../spec/change-api.md)
- [Service catalog](../spec/service-catalog.md), [knowledge](../spec/knowledge.md), [portal and virtual agent](../spec/portal-and-virtual-agent.md)
- [CMDB](../spec/cmdb.md), [SLA](../spec/sla.md), [schedules](../spec/schedules.md), [on-call](../spec/on-call.md), [asset](../spec/asset.md)
- [Platform core](../spec/platform-core.md), [notifications and events](../spec/notifications-events.md), [approvals and flows](../spec/approvals-flows.md)
- [AI](../spec/ai.md), [analytics](../spec/analytics.md), [agent workspace](../spec/agent-workspace.md)

Each spec ends with Given/When/Then acceptance tests; the server test suite implements them.

### 2.5 Verifying the clone with REA

The same REA scenario runner was pointed at ResolvrNow running locally. It drove login, the
workspace and record pages and captured screenshots, accessibility trees and network events.
Secrets were passed as environment-backed secret references, which REA redacts in its Evidence.

| Run | Result | Evidence |
|---|---|---|
| Login → workspace | **Bug found**: the Sign in click did nothing | `ev_d929acf89c59a818bad88807ace149362048e401501c86bbc0e866ef902ba673` |
| Enter-key login | **Root cause**: the first `/api/app/me` request never finished, because the 401's `WWW-Authenticate: Basic` header made the browser open its native login dialog | `ev_4d2aee09760bb233bcff9a27b4e325cad43e4f9f3565c1134dcaa5b07d645926` |
| Login → record page after the fix (no Basic challenge for browser requests) | Login and navigation work | `ev_07e88789376bd6ce3ac4177a644d6f899c9d6a479e90f9b7f5a0dbf2c31d8eb1` |
| Record page render | Form, badges and activity stream render; no page errors | `ev_3954ac2e9719b44bddcbf9faeb727eb021e91c06f9a04fb84911d37994e39346` |

## 3. Findings

### 3.1 Capability map and editions

The packaging evidence (`ev_84e89f84…`, `ev_baf1084c…`) shows three cumulative editions.
In our own words:

| Capability | Entry edition | Mid edition | Top edition | ResolvrNow module |
|---|:---:|:---:|:---:|---|
| Incident management | ✓ | ✓ | ✓ | `incident` |
| Request management and service catalog | ✓ | ✓ | ✓ | `catalog`, `portal` |
| Asset management and CMDB | ✓ | ✓ | ✓ | `asset`, `cmdb` |
| Knowledge management | ✓ | ✓ | ✓ | `knowledge` |
| Employee self-service portal | ✓ | ✓ | ✓ | `portal` |
| Virtual agent (chatbot) | ✓ | ✓ | ✓ | `ai` |
| Predictive intelligence (ML classification) | ✓ | ✓ | ✓ | `ai` |
| Workflow automation | ✓ | ✓ | ✓ | `flow`, `approvals` |
| Generative AI assist (summaries, drafts) | ✓ | ✓ | ✓ | `ai` |
| Problem management | | ✓ | ✓ | `problem` |
| Change management | | ✓ | ✓ | `change` |
| Major incident management | | ✓ | ✓ | `incident` |
| On-call scheduling | | ✓ | ✓ | `oncall` |
| Advanced analytics and dashboards | | ✓ | ✓ | `analytics` |
| Walk-up service desk | | ✓ | ✓ | partial (portal) |
| DevOps-driven change (pipeline integration) | | | ✓ | `change` (pipeline API) |
| AI agents / autonomous L1 specialist | | | ✓ | `ai` (agent tools via MCP) |

ResolvrNow ships every row in all deployments; there are no editions.

### 3.2 Architecture conclusions that shaped the design

- **One metadata-driven platform.** Every application is tables plus dictionary, rules, access
  controls and UI metadata on a shared engine. ResolvrNow mirrors this with a module system on a
  dictionary-driven engine (`server/src/engine`).
- **Table inheritance.** Incidents, problems, changes, requests and catalog tasks extend `task`,
  and all CI classes extend `cmdb_ci`. ResolvrNow stores each hierarchy in one physical table
  (table-per-hierarchy), so querying `task` returns every subclass.
- **Encoded queries everywhere.** List filters, reference qualifiers, rule conditions, ACL
  conditions and REST `sysparm_query` all share one condition language. ResolvrNow has one
  parser with two back ends: a SQL compiler and an in-memory matcher.
- **API shape.** All Table API values are strings, references are `{link, value}`, and
  `sysparm_display_value` has three modes. Pagination uses `X-Total-Count` and `Link`; errors use a
  `{"error":{message,detail},"status":"failure"}` body. ResolvrNow reproduces these.

### 3.3 Residual unknowns

Behaviour the public material doesn't fully document is listed in each spec's "open questions"
and marked *Inferred*. The largest are:
- some numeric choice codes
- exact error message wording
- deeper workspace screens
- internal steps of AI agent workflows

A compatibility test suite against a live developer instance, run by the project owner on their
own sandbox, is the planned way to close them.

## 4. Clean-room rules that were followed

1. **No vendor code was copied or executed.** The SDK was analyzed statically. Only factual schema
   metadata was derived from it, under its MIT license with attribution.
2. **No private systems were probed.** All observation targeted public marketing pages and the
   public documentation site, plus ResolvrNow itself. No customer instance or authenticated
   vendor system was accessed.
3. **Documentation was read, not republished.** Specs and code comments are written in our own
   words. Facts needed for interoperability are used as facts: table and field names, choice
   values, endpoint paths and parameter names.
4. **Original content only.** Demo data (the fictional "Northwind Labs"), knowledge articles and
   UI copy are original. The UI has its own visual design and does not reuse vendor assets, fonts
   or trade dress.

## 5. Reproducing the investigation

```bash
# REA needs Node >= 22.19 (or 24.11+)
npm install --prefix ./rea-cli rea-agents@6.7.0
export REA_WORKDIR=$PWD/rea-work
# Public product pages (opens a visible Chrome window; the CDN blocks headless browsers)
docs/reverse-engineering/tooling/capture.sh c01-itsm https://www.servicenow.com/products/itsm.html 7000
# Scripted interaction captured as Evidence
./rea-cli/node_modules/.bin/rea capture-browser-scenario docs/reverse-engineering/tooling/scenarios/itsm-capability-tabs.json --format json
# Static analysis of the MIT SDK
npm pack @servicenow/sdk-core@4.13.6 && tar xzf servicenow-sdk-core-4.13.6.tgz
./rea-cli/node_modules/.bin/rea analyze-javascript-application "$PWD/package" --format json > sdk-core.evidence.json
```
