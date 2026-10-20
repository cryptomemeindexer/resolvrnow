# ResolvrNow spec: AI for ITSM (generative skills, agents, MCP server, predictive intelligence)

Status: draft 1 (2026-10-21). Parity target: ServiceNow "Brazil" public documentation (September 2026 revision).
Audience: engineers building `server/src/ai/*`, `server/src/ml/*`, `server/src/mcp/*` and the AI surfaces of the workspace.
Companion files: `analytics.md` (KPIs, dashboards), `agent-workspace.md` (where AI output surfaces), `data/ai-analytics.json` (choices, extra tables, `genaiSkills`, `mcpTools`, `kpis`).
Related specs: `encoded-query.md` (condition syntax), `service-catalog.md` (catalog states), `on-call.md` (rosters used by on-call tools).

## 0. Conventions and sources

- **[Documented]**: the fact (name, value, behaviour) is stated in the public ServiceNow page cited for the section. Text here is a paraphrase.
- **[Inferred]**: our reading, a widely known platform behaviour that is absent from the cited pages, or a ResolvrNow design decision. Items marked "verify" need a live-instance check before freezing.
- In tables, the Basis column says `Documented` or `Inferred` with the same meaning.
- ServiceNow renamed Now Assist to "ServiceNow Otto" (documented as a Zurich Patch 12 rename); both names occur in doc text and in technical names (`sn_nowassist_*`). ResolvrNow UI uses neutral wording ("AI assist") and never copies ServiceNow UI strings.
- Conditions use the encoded query syntax of `encoded-query.md`.

Source prefixes used in the "Sources" line of each section:

| Prefix | URL |
|---|---|
| `[otto]` | https://www.servicenow.com/docs/r/it-service-management/now-assist-for-it-service-management-itsm/ |
| `[itsm]` | https://www.servicenow.com/docs/r/it-service-management/ |
| `[ti]` | https://www.servicenow.com/docs/r/it-service-management/task-intelligence-for-itsm/ |
| `[pi]` | https://www.servicenow.com/docs/r/intelligent-experiences/predictive-intelligence/ |
| `[sow]` | https://www.servicenow.com/docs/r/it-service-management/service-operations-workspace/ |

## 1. Capability map

Sources: [otto]exploring-now-assist-itsm.html, [otto]supporting-information-now-assist-itsm.html, [itsm]machine-learning-itsm.html, [ti]components-installed-ti-itsm.html, [itsm]itsm-mcp-server-overview.html

| ServiceNow capability (plugin id) | Purpose | ResolvrNow module | Basis |
|---|---|---|---|
| Otto for ITSM (`sn_itsm_gen_ai`) | Generative skills on incident, change, request, interaction; agentic workflows | `ai/skills`, `ai/agents` | Documented |
| Otto for Knowledge Management (`sn_km_gen_ai`), Knowledge in UI Builder (`sn_km_uib`) | KB article drafting used by the incident KB skill | `ai/skills/kb` | Documented |
| IT Service Management AI Agent Collection (`sn_itsm_aia`, 5.1) | AI agents, L1 Service Desk AI Specialist, Service Desk Manager role | `ai/agents`, `ai/worker` | Documented |
| Model Context Protocol Server (`sn_mcp_server`) + ITSM MCP Server (`sn_itsm_mcp_server`) | Expose ITSM tools to external MCP clients | `mcp` | Documented |
| Task Intelligence for ITSM (`com.snc.itsm_ml_task`), TI Admin Console (`com.sn_ti_admin`), Advanced Recommended Actions (`com.snc.uib.sow_itsm_ra_advanced`) | No-code field prediction and similar records in the workspace side panel | `ml/ti`, workspace recommendations | Documented |
| Predictive Intelligence (`com.glide.platform_ml`), PI for Incident Management (`com.snc.incident.ml_solution`), PI for MIM (`com.snc.incident.mim.ml_solution`), PI for Contextual Search (`com.snc.contextual_search_ml`), PI for Incident (`com.snc.incident.ml`) | Classification, similarity, clustering (regression legacy) | `ml/pi` | Documented |
| Voice AI agents (`sn_itsm_voice_aia`), DEX agents, release notes (DPR) | Voice ticketing, device diagnostics, release notes | Out of scope for ResolvrNow v1 | Documented |

## 2. Shared generative-skill framework

Sources: [otto]configure-now-assist-for-itsm.html, [otto]cust-now-assist-itsm-skill.html, [otto]cust-now-assist-itsm-record-summ-skill.html, [otto]supporting-information-now-assist-itsm.html, [otto]using-now-assist-for-itsm.html, [otto]now-assist-itsm-skills.html

### 2.1 Skill administration lifecycle

| Step | Behaviour | Basis |
|---|---|---|
| Activate | Admin opens AI Admin Hub > AI Skills > Technology > ITSM, picks a feature card, activates a skill. Some skills are on by default for new installs; upgrades keep prior activation. | Documented |
| Copy | A skill may be duplicated before activation; only summarization skills and the change risk explanation skill can be copied, other skills show read-only values. | Documented |
| General details | Name and description. | Documented |
| Choose input data | Per input template (record state New, WIP, Resolved, Closed by default; a rule condition picks the template): base input fields each with a natural-language field description; extra data sources: Related Table (table, field, description), Relationship, Activity: Email, Activity: Attachment. | Documented |
| Customize prompt | Pick output sections per template, reorder, Run Test against a chosen record, edit the raw prompt in the skill kit (role `sn_skill_builder.admin`). | Documented |
| Define availability | Always available, or a condition builder filter on the record. | Documented |
| Select display | In-product (forms and workspaces) and/or the AI panel, each with role lists. | Documented |
| Define access | Roles allowed to run the skill; many ITSM skills call a client-callable script include whose ACL requires `itil` or `sn_incident_read`. | Documented |
| Review and activate | Final confirmation. Admin role for the hub: `sn_nowassist_admin.nsa_admin`. | Documented |

ResolvrNow: one `sn_nowassist_skill_config` row per skill (see JSON `tables`), editable in an admin page with the same steps. Prompt templates are versioned files in the repo; admins may override the template text per skill. **[Inferred]**

### 2.2 Providers, security, logging

| Topic | Rule | Basis |
|---|---|---|
| Providers | Skills and agents may run on the vendor LLM service, Azure OpenAI, Google Gemini or Anthropic Claude (on AWS); the allowed set is governed centrally and chosen per skill. | Documented |
| Data access | Retrieval of record data runs with the caller's ACLs; the LLM output is then filtered again by "role masking" for the active role. | Documented |
| Domain separation | Skills use only data in the caller's domain; the shared AI service does not persist prompts or responses. Suggested steps does not support domain separation; the L1 specialist has no domain support. | Documented |
| Feedback | Thumbs up/down on each generated output is stored in the generative AI log (`sys_generative_ai_log`). | Documented |
| Sensitive data | A sensitive data handler masks configured patterns in Virtual Agent conversations. | Documented |
| ResolvrNow | Input builder reads fields through the same ACL layer as the Table API, drops fields the user cannot read, applies configurable PII redaction, then post-checks the output for strings from dropped fields. | Inferred |

### 2.3 Common UI affordances

| Affordance | Behaviour | Basis |
|---|---|---|
| Summary card | Generated on demand (Summarize), with refresh, expand/collapse, copy to clipboard, more-info, thumbs up/down, and Share as work notes (opens an editable dialog, then Save to work notes). | Documented |
| Context menu on fields | An AI icon inside a text field (chat composer, email body, work notes, comments, resolution notes, KB editor) opens a menu: generate, Refine (Shorten, Elaborate, change tone), Insert, Replace; refined versions can be toggled. | Documented |
| AI panel | Conversational side panel opened from the header icon; can request summaries, resolution notes, incident Q&A, add comments or work notes, and receive "agent finished" notifications. | Documented |
| Review prompt | Generated text that lands in a field is editable before save; screens remind the user to verify AI output. | Documented |

### 2.4 Global guardrails

| Guardrail | Rule | Basis |
|---|---|---|
| Minimum content | Resolution notes need at least 50 relevant words across short description, description, work notes and comments, otherwise an insufficient-activity error and no output. | Documented |
| State gating | Change summary is not offered in New or Canceled; risk explanation only after risk is calculated; KB generation only in configured incident states and when no KB article is attached. | Documented |
| Token budget | When child incidents overflow the context, that section shows a "too much information" notice instead of content. | Documented |
| Long jobs | KB generation cannot be cancelled once started and continues if the dialog closes. | Documented |
| ResolvrNow budget | Each skill has `max_input_tokens`; the input builder truncates oldest journal entries first and records `truncated=true` in the log. | Inferred |
| ResolvrNow injection defence | Journal text, emails and attachments are wrapped as quoted data with an instruction that they are untrusted; tool calls proposed by the model on the basis of record text require the user's permission. | Inferred |

## 3. Generative skill catalogue

Sources: [otto]now-assist-itsm-skills.html, [otto]using-now-assist-for-itsm.html and the per-skill pages cited below.

### 3.0 Master list

| ResolvrNow id | ServiceNow skill | Record | Trigger | Surface | Default | Basis |
|---|---|---|---|---|---|---|
| `incident_summarization` | Incident summarization | incident | User (Summarize); assign modal on reassignment | Overview card, Details tab, banner, panel | On | Documented |
| `incident_reassignment_summary` | Incident reassignment summarization | incident | Save with changed assignment group/assignee | Assign dialog | Off | Documented |
| `resolution_notes_generation` | Resolution notes generation | incident | Auto on Resolve, or user icon in field | Resolve dialog | On | Documented |
| `chat_summarization` | Chat summarization | interaction | VA handoff, `/summarize`, chat end, task creation | Active chat, interaction fields | On | Documented |
| `sidebar_summarization` | Sidebar discussion summarization | any Sidebar-enabled task | `/summarize` quick action | Discussion modal | Off | Documented |
| `chat_reply_recommendation` | Chat reply recommendation | interaction | User icon in chat composer | Composer menu | Off | Documented |
| `email_response_generation` | Email response generation | incident | User icon in email composer | Email composer | Off | Documented |
| `incident_activity_response` | Incident activity response recommendation | incident | User icon in work notes or comments | Composer menu | Off | Documented |
| `request_activity_response` (and `ritm_`, `sc_task_` variants) | Request/RITM/catalog task activity response | sc_request, sc_req_item, sc_task | User icon in journal fields | Composer menu | Off | Documented |
| `kb_article_generation` | Knowledge article generation | incident | Create Knowledge action | KB editor | Off | Documented |
| `change_summarization` | Change request summarization | change_request | User (Summarize) | Overview card, banner | On | Documented |
| `change_risk_explanation` | Change request risk explanation | change_request | User icon on Explain Risk | Popover | Off | Documented |
| `change_risk_assessment_answers` | Change risk assessment answer generator | change_request | Generate Answers in risk dialog | Assessment form | On | Documented |
| `request_summarization` (and `ritm_`, `sc_task_` variants) | Request/RITM/catalog task summarization | sc_request, sc_req_item, sc_task | User (Summarize) | Details tab, banner | Off | Documented |
| `mim_email_recommendation` | Major Incident email content recommendation | incident (major) | Compose in Communicate tab | Email composer | Off | Documented |
| `incident_qa` | Incident Q&A / incident assist (deprecated in favour of an agentic workflow) | incident | Panel question | AI panel | Off | Documented |
| `sentiment_analysis` | Sentiment analysis | incident | Scheduled job and manual refresh | List column, form field popover | Off | Documented |
| `suggested_steps` | Suggested steps generation (deprecated, replaced by LEAP) | incident | Recommendations icon | Recommendations popup | Off | Documented |
| `portal_deflection` | Incident deflection with self-service, in-form deflection | portal record producer | Leaving the description field | Portal form | Off | Documented |
| `trend_summary` | AI summary of an incident trend category | incident clusters | Dashboard drill-in | Insights dashboard | Off | Documented |
| `problem_rca_assist` | (no ITSM skill documented) | problem | User | Problem Overview, panel | Off | Inferred |
| `catalog_item_draft` | (not in ITSM docs) | sc_cat_item | Admin | Catalog admin | Off | Inferred |

Default column: ServiceNow states that some skills are on by default for new customers; the exact list is not given per skill. The values above are the ResolvrNow defaults. **[Inferred]**

### 3.1 Incident summarization

Sources: [otto]summarize-incident-now-assist.html, [otto]now-assist-itsm-skills.html, [otto]cust-now-assist-itsm-record-summ-skill.html, [otto]cust-now-assist-itsm-skill.html

| Aspect | Specification | Basis |
|---|---|---|
| Inputs | `short_description`, `description`, `work_notes`, `comments`, email activity; the usage page also lists `state`, `priority`, and `close_notes` for resolved records | Documented |
| Templates | New, WIP, Resolved, Closed, selected by state rule | Documented |
| Output sections | Issue (all); Key Actions Taken (WIP, Resolved, Closed); Resolution (Resolved, Closed); optional Affected CIs and Impacted Services, Service Level Agreement, Child Incidents (WIP and later) | Documented |
| Attachments | New attachments of type PNG, JPEG/JPG, PDF, DOCX can be summarized (document intelligence); content languages English, Dutch, French, German, Portuguese, Spanish; not on child incidents; older attachments are only processed after a new one is added | Documented |
| Reassignment variant | When the assignment group or assignee changes on save, the assign dialog shows a handoff summary of actions so far | Documented |
| Surfaces | Workspace Overview tab (also Details tab, can be hidden), classic form banner, AI panel | Documented |
| ResolvrNow output schema | `{issue: string, key_actions: string[], resolution?: string, affected_cis?: string, sla?: string, child_incidents?: string}` rendered as headed sections | Inferred |

### 3.2 Resolution notes generation

Sources: [otto]resolve-incident-now-assist.html, [otto]cust-now-assist-itsm-gen-resolution-notes-skill.html

| Aspect | Specification | Basis |
|---|---|---|
| Inputs | `short_description`, `description`, `state`, `work_notes`, `comments` | Documented |
| Trigger | Automatic by default: the Resolve dialog opens with resolution notes prefilled; "User triggered" mode requires clicking the AI icon inside the notes field | Documented |
| Context menu config | Table fixed to incident; target field default `close_notes`; action "Generate resolution notes"; refine Shorten/Elaborate; Insert on by default | Documented |
| Output | Notes text describing cause and steps taken; the agent still picks the resolution code and confirms Resolve; state becomes Resolved | Documented |
| Guardrail | Under 50 relevant words: error, no output. Changing the configured "resolution choice" output to anything but none is unsupported | Documented |
| ResolvrNow output schema | `{cause: string, steps: string[], resolution: string, suggested_close_code?: string}`; the close code is only a suggestion, never auto-set | Inferred |

### 3.3 Chat summarization and chat reply recommendation

Sources: [otto]generate-chat-summary-interaction-now-assist-itsm.html, [otto]now-assist-itsm-chat-recommendation.html, [otto]now-assist-itsm-skills.html

| Aspect | Specification | Basis |
|---|---|---|
| Summary triggers | VA-to-live-agent handoff (summary of the bot conversation shown when the agent accepts), `/summarize` quick action, chat wrap-up (End Chat writes the interaction Chat Summary), Short description update at end, task creation (new incident gets short description and description from the summary) | Documented |
| Incident from chat | Before chat end: incident short description and description filled and saved. After chat end: interaction chat summary updated and incident fields filled | Documented |
| Display option | Bulleted list property | Documented |
| Reply recommendation | Empty composer + AI icon: draft a reply from the conversation so far. Typed text + icon: refine options (Shorten, Elaborate). Result in a modal with Refine, Insert, version toggle; the agent sends | Documented |
| Reply config fields | Button props, refine actions, dialog props, component id (`agent-chat`), default preset action, table, timeout message, preset actions | Documented |
| ResolvrNow | Summary schema `{reason_for_contact, steps_already_tried[], details_collected[], outcome}`; reply returns plain text max 600 characters | Inferred |

### 3.4 Sidebar discussion summarization

Sources: [otto]now-assist-itsm-sidebar-discussion.html. Any task table with Sidebar collaboration enabled; `/summarize` or the quick-action icon produces a summary modal with Share to Work notes and feedback; Teams-mirrored discussions are supported; bulleted-list property. **[Documented]** ResolvrNow implements it on its record discussion threads (see `agent-workspace.md` §8). **[Inferred]**

### 3.5 Email response generation and activity responses

Sources: [otto]now-assist-itsm-email-recommendation.html, [otto]now-assist-itsm-activities-response-generation.html, [otto]cust-now-assist-itsm-activity-response-skill.html, [otto]summarize-request-related-activity-response-generation.html

| Aspect | Specification | Basis |
|---|---|---|
| Email entry points | More actions > Email, or reply to an email in the activity stream | Documented |
| Email behaviour | Select at least six words then the icon to refine; empty body generates a reply from incident and email context; works for new, forward, draft; template suggestions while composing; Replace, Insert, Send, Discard | Documented |
| Activity response inputs | incident: `short_description`, `description`, `priority`, `state`, `work_notes`, `comments`; request family adds `updated` | Documented |
| Activity response options | Acknowledge task, Post response, Summarize actions taken, Follow up | Documented |
| Defaults per field | Work notes: Summarize actions, Post response. Additional comments: Follow up, Post response, Acknowledge task | Documented |
| Refine | Elaborate, shorten, change tone; Insert puts text in the field; the user edits, then Post | Documented |
| Access | itil by default; inactive by default | Documented |
| ResolvrNow guard | Text generated for the customer-visible comments field never quotes work notes verbatim; the prompt receives work notes only for the work-notes field options | Inferred |

### 3.6 Knowledge article generation from incidents

Sources: [otto]Now-Assist-generate-article-SOW-itsm.html, [otto]now-assist-itsm-skills.html, [otto]cust-now-assist-itsm-skill.html

| Aspect | Specification | Basis |
|---|---|---|
| Inputs | `short_description`, `description`, `close_notes` (resolution notes), `work_notes`, `comments` | Documented |
| Allowed states | Resolved and Closed by default; property `com.snc.incident.create_knowledge.multistate.enable` lists other state numbers (1 New, 2 In Progress, 3 On Hold, 6 Resolved, 7 Closed, 8 Canceled) | Documented |
| Preconditions | Incident only; no KB article already attached; the knowledge base named by `glide.knowman.task_kb` is active; AI Search active for multi-incident drafting | Documented |
| Flow | Create Knowledge action, then an interceptor page to choose knowledge base and template (skipped when the KCS incident plugin `com.snc.incident.knowledge` is installed), then the editor with an AI draft | Documented |
| Templates | "Incident-KCS article - HTML" or Standard; the Standard template copies Description, Resolution and Additional comments into body sections | Documented |
| Multi-incident | Workspace: clear the canvas and type an incident number (uses that incident) or a short description (finds the top three similar incidents). Classic: choose up to five similar incidents. The article is attached to every source incident | Documented |
| After save | AI badge disappears on save; LLM failure shows an error; "Edit knowledge article" appears when exactly one writable article is attached | Documented |
| ResolvrNow output schema | `{title, symptoms, cause, resolution_steps[], keywords[]}` mapped to `kb_knowledge.short_description` and HTML `text`; article saved as `workflow_state=draft` | Inferred |

### 3.7 Change summarization, risk explanation, risk assessment answers

Sources: [otto]summarize-change-now-assist.html, [otto]change-risk-exp-now-assist.html, [otto]cust-now-assist-itsm-change-risk-skill.html, [otto]generate-change-risk-assessment-answers-now-assist.html, [otto]cust-now-assist-itsm-change-risk-assessment-skill.html

| Aspect | Specification | Basis |
|---|---|---|
| Summary inputs | `short_description`, `description`, `work_notes`, `comments`, `risk`, `impact`, `justification`, `implementation_plan`, `risk_impact_analysis`, `test_plan`, `backout_plan`, `close_code`, `close_notes`, `service_offering`, `state`, `conflict_status`, `type`; related inputs by default: Change Risk Details, Conflict, Applied Change Policy, Impacted CIs, Affected CIs | Documented |
| Summary templates | Assess, Authorize & Scheduled, Implement & Review, Closed. Sections Objective, Plan, Risk, Affected CIs, Impacted services (all templates); Close notes and Incidents caused by change (Closed only). Not offered in New or Canceled; custom states need the summary card added to the overview container | Documented |
| Risk explanation inputs | `short_description`, `implementation_plan`, `assignment_group`, `risk`, `description`, `backout_plan`, model type; similar changes and the incidents they caused (needs AI Search; can be toggled off); the risk condition that matched; the risk assessment, using the top five normalized risk values in descending order, ties broken by lower order | Documented |
| Risk explanation UI | AI icon next to Explain Risk; hidden until risk is calculated; popover with Refine (Elaborate/Shorten), copy, feedback; lists contributing similar changes | Documented |
| Answer generator trigger | Generate Answers in the risk assessment dialog (classic: Related Links > Risk Assessment; workspace 9.2+: Risk Evaluation > Assess Risk); Skip generation opens an empty assessment | Documented |
| Answer generator inputs | Change fields named in property `sn_itsm_gen_ai.com.snc.asmt_answer_generator.change_request_fields` (comma list); every dynamic-schema field on the form; "AI Risk Data Sources" records (six defaults: affected CIs, impacted services, impacted business applications, service offerings, active change tasks, outages); a source is either Change Request Related Records (related table, reference field to the change, max records up to 100, optional expand reference field, source condition) or Knowledge Articles (condition) | Documented |
| Answer generator output | For each Likert-scale question: suggested option plus a Reasoning text; non-Likert questions are left blank without reasoning; Submit completes the assessment; regenerate replaces earlier answers; edit opens a plain copy without reasoning | Documented |
| Roles | Use: `sn_change_write`, `change_manager`; customize sources: `sn_change_manager` | Documented |

### 3.8 Request, requested item and catalog task summarization

Sources: [otto]summarize-request-related-skill.html, [otto]now-assist-itsm-skills.html

| Record | Input fields | Basis |
|---|---|---|
| sc_request | number, description, short_description, opened_at, due_date, comments, work_notes, priority, urgency, approval, state, opened_by, requested_for, requested_for.department, parent, price, request_state | Documented |
| sc_req_item | cat_item.name, cat_item.description, requested_for.name, requested_for.department, stage, state, urgency, priority, quantity, price, recurring_price, recurring_frequency, due_date, work_notes, comments | Documented |
| sc_task | number, short_description, description, assignment_group, assigned_to, state, due_date, priority, request_item.number, request_item.cat_item, request_item.requested_for, request_item.opened_by, comments, work_notes, approval | Documented |

Output: concise status summary shown in the workspace Details tab (classic: banner), with copy, feedback and Share to work notes. **[Documented]** ResolvrNow schema `{status, what_was_requested, approvals, open_tasks, blockers, next_step}`. **[Inferred]**

### 3.9 Major incident email content recommendation

Sources: [otto]now-assist-itsm-mim-email-recommendation.html, [otto]now-assist-itsm-skills.html

Role `major_incident_manager`, plugin `com.snc.incident.mim`. In the major incident Communicate tab, Compose on an email-channel communication task opens the template; four AI plans exist by default: Ad hoc AI, Business user AI, End user AI, Technical AI (persona-specific tone). Inputs: incident short description, description, comments, work notes, activities, business impact, resolution notes, priority, CI; `task_sla` target, stage, actual and business time left, has breached, pause duration and time; optionally `sys_cs_collab_message.payload` (must be selected explicitly). **[Documented]** ResolvrNow: templates contain placeholders like `{{ai.business_impact_summary}}` filled by one LLM call returning a JSON object keyed by placeholder. **[Inferred]**

### 3.10 Incident Q&A (incident assist) and the AI panel

Sources: [otto]now-assist-itsm-incident-assist.html, [otto]request-gen-ai-capabilities-itsm-now-assist-panel.html

| Topic | Rule | Basis |
|---|---|---|
| Caller's assets | Requires a caller; incident number needed unless asked from the record | Documented |
| Caller's recent incidents | Past 7 days; requires a caller | Documented |
| On-call experts | Any support group; members come from on-call schedules | Documented |
| Similar resolved incidents | Resolved or closed only; uses search indexes over incident, problem, change | Documented |
| Lifecycle | The skill is deprecated; an "Incident assist" agentic workflow (two agents) replaces it | Documented |
| Panel extras | Ask for chat summary, incident summary, resolution notes; add a comment or work note conversationally (work notes need itil); notified when an AI agent finishes | Documented |

ResolvrNow implements the topics as deterministic tools (`caller_assets`, `caller_recent_incidents`, `who_is_on_call`, `similar_records`) that the panel's LLM calls; offline, the panel shows the four topics as buttons. **[Inferred]**

### 3.11 Sentiment analysis

Sources: [otto]sentiment-analysis-now-assist-itsm.html, [otto]now-assist-itsm-skills.html. Inputs: `short_description`, `description`, `priority`, `state`, created date, `comments`, related `task_sla`. Outputs: sentiment (Positive, Neutral, Negative), trend (Improving, Declining, Stable), reasoning text. A scheduled job ("Sentiment analysis scheduled job (incident)", on by default) refreshes changed incidents; after a new comment the workspace shows a red dot on the info icon and the user can refresh; lists can sort by sentiment and trend; the field must be added to the form layout. **[Documented]** ResolvrNow columns `incident.sentiment`, `sentiment_trend`, `sentiment_reasoning`, `sentiment_updated_at` (names Inferred).

### 3.12 Suggested steps (deprecated) and portal deflection

Sources: [otto]resolution-steps-generation-now-assist-itsm.html, [otto]deflect-incidents-now-assist-itsm.html, [otto]now-assist-itsm-deflection-overview.html

- Suggested steps clusters closed incidents by short description (default: closed in the last 6 months), needs at least 2000 records, no domain separation; opened from a Recommendations icon on non-closed incidents and may take minutes; deprecated in favour of LEAP. **[Documented]** ResolvrNow reuses its clustering (§7.6) to produce "steps that resolved similar incidents" without an LLM. **[Inferred]**
- Portal deflection: a record producer runs the search when the user leaves the description field and returns KB and catalog suggestions; "Solution found" ends the flow, "Proceed with incident creation" reveals urgency and attachments, Submit assigns the incident, Save as Draft is possible. In-form deflection rewrites the query with the user's hardware and location (skipped for generic questions), adapts tone to detected frustration, and classifies incident vs request to return troubleshooting steps or a catalog item. **[Documented]**

### 3.13 Search Q&A and conversational catalog (Virtual Agent)

Sources: [otto]config-genai-va-itsm.html. Virtual Agent skills: multi-turn catalog ordering, Q&A over search results ("Genius results"), AI topics. Conversation features: contextual follow-up questions, slot filling from free text, answering questions about the item, exit at any point; reference, lookup select box, lookup multiple choice, requested for, attachment and choice lists over 10 options are asked without natural-language parsing; uploads of text, PDF, Word, JPEG, PNG. **[Documented]** ResolvrNow v1 offers Q&A in the portal search box (retrieve top KB passages, answer with citations, "no answer" when similarity below threshold). **[Inferred]**

### 3.14 Gaps filled by ResolvrNow

| ResolvrNow skill | Rationale | Inputs | Output | Basis |
|---|---|---|---|---|
| `problem_rca_assist` | No problem/RCA skill in the ITSM skill list; the post-incident review agent covers major incidents only | problem fields (`short_description`, `description`, `cause_notes`, `workaround`, `fix_notes`), linked incidents (summaries), linked changes, clustering hints | `{problem_statement, timeline[], probable_causes[{cause, evidence[]}], workaround, suggested_known_error_article}` | Inferred |
| `catalog_item_draft` | Catalog generation is a platform builder feature outside the ITSM docs | free text or an incident cluster | `{name, short_description, variables[{name, type, mandatory, choices[]}]}` saved as inactive item | Inferred |

## 4. Agentic workflows and AI agents

Sources: [otto]now-assist-itsm-ai-agents-use-cases.html, [otto]important-considerations-itsm-agentic-ai.html, [otto]now-assist-using-agentic-workflows-in-itsm.html, [otto]using-agentic-workflows.html, [otto]using-agentic-ai-workflow-im.html, [otto]itsm-va-ai-agents.html, [otto]now-assist-itsm-aiagents-voice.html, [itsm]agents-ai-native-it-service-desk.html

### 4.1 Platform rules

| Rule | Basis |
|---|---|
| Installed workflows and agents are read-only; to run them autonomously, duplicate the workflow, activate it and all its agents, and activate a trigger (each workflow needs a unique trigger); manual invocation needs no trigger. | Documented |
| Agents run under ACLs with a "run as" identity: the dynamic (invoking) user or a dedicated AI user; role masking restricts which users may invoke which agents. | Documented |
| Azure OpenAI is recommended for ITSM agentic workflows; other providers are allowed. | Documented |
| An AI agent can be published as an MCP tool: set A2A auth scope on the MCP server, set the agent communication mode to Synchronous, allow third-party access on the agent. | Documented |

### 4.2 Catalogue

| Workflow | Agents | Purpose | Basis |
|---|---|---|---|
| Triage and categorize ITSM incidents | Categorize ITSM incident; Classify service and CI; Link major incident and link problem | Set category, subcategory, service, offering, CI; link to an active major incident or known problem | Documented |
| Investigate and resolve ITSM incidents | ITSM incident resolution plan investigation | Build a resolution plan from catalog items, KB and past incidents and send it to the user | Documented |
| Incident assist | Incident context; Additional incident context | Answer questions about an open incident (assets, recent incidents, similar resolved, on-call) | Documented |
| Wrap-up and resolve incident | Incident resolution details; Incident knowledge article; Incident known error article | Generate notes and pick code; attach or draft KB; attach known error article when code is Known Error; update duplicate info when code is Duplicate | Documented |
| Generate post incident reviews | Post-incident review | Post-incident report for a major incident, notify the fulfiller | Documented |
| Generate change request plans | Change request plans | Implementation, test and backout plan plus risk/impact analysis and justification for a change number | Documented |
| Assess conflicts for a change request | Change conflict assessor | Run conflict detection; explain affected CIs and services | Documented |
| Assess quality of a change request | Change quality assessor | Compare a new change against closed changes with similar descriptions | Documented |
| Explain SLA | Explain SLA | Explain SLA priority, assignment, pause/resume history on incident, problem, case, change | Documented |
| Schedule a change | Schedule Change Request | Find free schedule slots | Documented |
| Suggest configuration items | Change CI suggestion | Recommend CIs at change creation | Documented |
| Create outages for a change request | Change outage assistant | Create outages for the change | Documented |
| Create standard change request | Standard change template recommender | Create standard, normal or emergency change conversationally | Documented |
| Create standard change template proposal | Standard change template proposal | Propose a template from similar changes | Documented |
| Who is On Call | On Call Retrieval | Roster lookup for shift, group, period | Documented |
| Notify users with Twilio; Manage Microsoft 365 group members; DEX diagnosis and resolution | Twilio SMS; M365 membership; DEX diagnosis, DEX resolution plan | Messaging, directory, device diagnostics | Documented (ResolvrNow v1: out of scope) |
| Employee agents (Simplified ITSM) | Create Incident; Approval Assistance; Request Status | Self-service issue resolution and ticket creation; approval checklists and decisions; status, comments, attachments on own tickets | Documented |
| Voice agents | Create incidents; Manage tickets; Password reset (+ primers) | Voice ticketing | Documented (out of scope) |

### 4.3 Step-by-step behaviour (ResolvrNow reference flows)

The documentation names the agents and their goals but not their internal steps. The flows below are the ResolvrNow design, built from the documented goals. **[Inferred]**

**Triage and categorize** (trigger: incident created with empty category, or manual):
1. Load incident text fields and caller context (department, location, assets).
2. Category agent: run the PI classifiers for `category` and `subcategory` (§7); if confidence is below threshold, ask the LLM to choose from the active choice list; never invent values.
3. Service/CI agent: rank `business_service`, `service_offering`, `cmdb_ci` from PI and the caller's assets; fill only empty fields unless override is enabled (mirrors the L1 "override existing values" switch).
4. Link agent: similarity search over active major incidents (state not resolved, `major_incident_state=accepted`) and over open problems with known errors; if the best score passes its threshold, set `parent_incident` or `problem_id` and add a work note naming the evidence.
5. Write one work note summarizing what changed and the confidence of each change.

**Investigate and resolve**: (1) build a query from short description and description; (2) search KB (published only), similar resolved incidents (last 12 months), active catalog items; (3) LLM drafts a resolution plan citing sources; (4) post to the caller as a customer-visible comment only when the plan cites at least one source and the plan confidence passes the threshold, otherwise post as a work note for the agent.

**Wrap-up and resolve**: (1) generate resolution notes (§3.2) and suggest a close code; (2) if code is Known Error, find the problem's known error article and attach it; if Duplicate, ask for or detect the original and set `parent_incident`; (3) search KB for an article matching the resolution; attach it, or create a draft via §3.6; (4) set state Resolved only after the user confirms in the dialog.

**Post incident review**: gather the major incident timeline (state changes, communications, work notes, child incidents, SLA), generate `{summary, impact, timeline[], root_cause, what_went_well[], improvements[], action_items[]}`, write it into the post incident report, notify the major incident manager.

**Change request plans**: from the change and its CIs, generate implementation, test and backout plans plus risk and impact analysis and justification; write into the empty fields only, existing text is kept and the draft is offered for review.

**Change quality assessor**: find closed changes with similar short description; compare completeness of plans, test evidence and close codes; return a score 0 to 100 with missing items.

**Agent runtime in ResolvrNow**: an agent is `{name, instructions, tools[], run_as: invoker|ai_user, trigger, requires_confirmation[]}`; workflows chain agents; every step is logged in `resolvr_agent_run` and `resolvr_agent_step`; tools are the same registry as the MCP server (§6), so permissions behave identically.

## 5. L1 IT Service Desk AI Specialist

Sources: [itsm]l1-service-desk-ai-specialist.html, [itsm]exploring-l1-sd-ai-specialist.html, [itsm]autonomous-supervised.html, [itsm]config-tasks-l1-sd-ai-spec-sow.html, [itsm]config-profile-l1-sd-ai-spec-sow.html, [itsm]config-details-l1-sd-ai-spec-sow.html, [itsm]work-assign-l1-sd-ai-spec.html, [itsm]catalog-variable-collection-slot-fill-l1-sd-ai-spec.html, [itsm]catalog-request-states-l1-sd-ai-spec.html, [itsm]catalog-request-cancellation-l1-sd-ai-spec.html, [itsm]catalog-cleanup-abandoned-cart-l1-sd-ai-spec.html, [itsm]qa-l1-sd-ai-spec.html, [itsm]perf-overview-l1-sd-ai-spec.html, [itsm]perf-detailed-view-l1-sd-ai-spec.html, [itsm]perf-kbarticle.html, [itsm]catalog-tab-l1-sd-ai-spec.html, [itsm]collect-emp-consent.html, [itsm]test-l1-sd-ai-spec-sow.html, [itsm]roles-required-l1-sd-ai-spec.html, [itsm]inc-prediction-l1-sd-ai-spec.html

### 5.1 Concept and roles

An autonomous worker assigned incidents like a team member: it triages, searches knowledge and history, talks to the requester only through the incident activity stream, proposes or applies solutions and hands off to humans when confidence is low. It cannot assign work to itself. **[Documented]**

| Role | Name | Holds | Basis |
|---|---|---|---|
| Service Desk Agent | `sn_itsm_common.sn_service_desk_agent` | Sees the specialist's work in the workspace | Documented |
| Service Desk Manager | `sn_itsm_common.sn_service_desk_manager` (one page writes `sn_sow_itsm_common.`; treat as alias) | Agent + `sn_aia.worker_manager`; onboards, configures, tests, monitors | Documented |
| AI Worker Manager | `sn_aia.worker_manager` | Activate and onboard specialists | Documented |
| Coaching | `sn_coaching.coach`, `sn_coaching.trainee` (contained in the manager role) | Read quality assessments | Documented |

Requires `sn_itsm_aia` 5.1 and workspace 8.4. Upgrades grant the manager role to group managers of service desk agents by fix script. **[Documented]**

### 5.2 Configuration (guided setup: Profile, Tasks, Test)

| Section | Setting | Values / rule | Basis |
|---|---|---|---|
| Basic | Assignment groups, roles, language (read-only), name, icon, department, description | Removing a group stops work for that team | Documented |
| Profile | First/last name, title, department, user id, description, assignment groups, source, language | Saved explicitly; unsaved changes are lost on navigation | Documented |
| Classify and assign | Table; fields to predict when empty: category, subcategory, service, service offering, CI; similar-records search profile; override existing values (service, offering, CI) | Predictions from LLM providers or PI | Documented |
| Triage and diagnose | Fields to use; use attachment content; map specialist states to record states (for example Awaiting info to On Hold); default routing decision; routing criteria "Attempt resolution for" and "Reassign for" (conditions) | First matching criterion wins, else default | Documented (order rule Inferred) |
| Investigate and resolve | Knowledge sources (one or more search profiles, at least one); auto-create KB feedback tasks when a proposed solution cited no article; research depth low/medium/high; pre-resolution condition (encoded query that must hold before resolving); execution mode autonomous/supervised; auto-submit catalog requests; flag high-risk resolution steps (elevated access, backend change, irreversible: route to an agent instead of the requester) | Specialist can only search tables its roles can read | Documented |
| Response formatting | Inbound channels (activity stream); outbound channels (activity stream, email, portal, phone) and format (HTML, plain); internal note when confidence is low; per-state response mode for Follow up, Propose a solution, Reassign to human: Template (default, rich text) or Dynamic (instruction-guided generation, no placeholders) | Modes keep their own saved content | Documented |
| Reassign | Max interactions before escalation (integer above zero, default 3); reassign on follow-up question; stuck monitor filter; reassignment target (group or person); cross-group reassignment Off or Recommend only (post a recommendation and unassign itself, never change the group) | | Documented |

### 5.3 Execution modes

| Step | Autonomous (default) | Supervised | Basis |
|---|---|---|---|
| 1 | Incident assigned to the specialist | same | Documented |
| 2 | Triage: description, attachments, context | same | Documented |
| 3 | Search KB, past incidents, known errors, catalog items; may ask follow-up questions in comments | same | Documented |
| 4 | Post the solution to the requester; state goes to Solution Proposed then Resolved without requester confirmation | Present the solution to a human fulfiller for acceptance | Documented |
| 5 | No reply after the configured number of actions (default 3): reassign to a human | Accepted: post solution, Solution Proposed. Rejected: back to investigation | Documented |
| Email | The specialist never sends email itself; existing state/comment notifications still fire | same | Documented |

ResolvrNow maps "Solution Proposed" to `state=6 Resolved` preceded by a `resolvr_ai_worker_engagement.state=proposed` record, because the incident state model has no such state. **[Inferred]**

### 5.4 Catalog drafting, variable collection and cancellation

| Rule | Basis |
|---|---|
| When an incident matches a catalog item, required variables are auto-filled only when confirmable from incident, requester profile or history; unknown is preferred to wrong. | Documented |
| Missing variables are asked one question per comment; the requester has 24 hours per question; conditional variables are re-evaluated after each answer. | Documented |
| Auto-submit on and all mandatory filled (or none): submit, incident On Hold (Awaiting Caller). Auto-submit on, a mandatory variable unknown: ask directly. Auto-submit off: draft and send a link; when the requester submits, the incident resolves with code "Resolved by catalog request". | Documented |
| Escalation to a human for any reason closes every request item the specialist created for the incident as Closed Incomplete, with a customer-visible note. | Documented |
| A negative requester comment moves the incident from On Hold to In Progress; if escalation follows, the request is cancelled. | Documented |
| A daily job deletes unsubmitted drafts whose source incident is closed, cancelled or missing; drafts of active incidents stay. | Documented |
| Device remedial actions (DEX): actions not listed in `sn_itsm_aia.consent_bypass_actions` need employee consent in the activity stream; incident On Hold (Awaiting Caller) until answer or timeout `sn_itsm_aia.engagement_timeout_minutes` (default 1440). | Documented (ResolvrNow v1: out of scope) |

### 5.5 Assignment, testing, deactivation

Work reaches the specialist by manual assignment (Assigned to), assignment rules (lowest order wins), or Advanced Work Assignment (agent needs `awa_agent`; rule options "Include AI agents", "Prioritize AI agents", capacity override). Test runs on a real open record and really changes it (not a simulation). Deactivate from the homepage card menu, or remove its groups. **[Documented]**

### 5.6 Quality assessment skill

Each handled incident gets an automated assessment against a coaching rubric. Inputs: incident number, short description, description; specialist comments, work notes, close notes, cited articles and catalog items. Metrics: Resolution Step Quality (scored), Executable Resolution (scored: judge verdict Yes 100, Partial 50, No 0), Knowledge Accuracy (diagnostic), Root Cause of Failure (diagnostic). Composite = mean of the two scored metrics, floored at 0. Tiers: 85 to 100 Excellent, 70 to 84 Good, 50 to 69 Partial, 0 to 49 Poor. **[Documented]**

### 5.7 Performance views

| View | Metrics | Basis |
|---|---|---|
| Overview | Durable auto-resolve rate (resolved without human reassignment and not reopened); coverage rate (assigned incidents it attempted); routing journey (closed in eligible groups, assigned to specialist, attempted); outcomes (resolved, reassigned, reopened); mean time to resolution; mean time to first response (creation to first specialist comment); reassignment reasons and their trend; routing-criteria reassignments over time; follow-up rate and count | Documented |
| Detailed | Outcomes by service; reassignment reasons (low confidence, failed execution, time-out) by service; average exchanges for resolved incidents; proposed-solution similarity (AI judge score of proposed vs final resolution) by service | Documented |
| Value and feedback | Aggregated sentiment; adoption coverage (groups with a specialist); thumbs counts | Documented |
| KB articles | Articles used, records resolved with a retrieved article, shown in citations, retrieved only, unused; per-article usage frequency and reopen rate | Documented |
| Catalog | Incidents with drafts, items used, drafted, submitted (by specialist vs requester), zero-touch drafts, drafts with incomplete variables, abandoned, cancelled after submit, reassigned to agent; per-item abandonment and cancellation rates | Documented |

ResolvrNow formulas for these are in `analytics.md` §5.8.

## 6. ITSM MCP Server

Sources: [itsm]itsm-mcp-server-overview.html, [itsm]set-up-itsm-mcp-server.html, [itsm]itsm-mcp-server-tools-reference.html, [itsm]manage-incidents-itsm-mcp-server.html, [itsm]manage-change-requests-itsm-mcp-server.html, [itsm]manage-employee-experience-itsm-mcp-server.html, [itsm]manage-on-call-schedule-itsm-mcp-server.html, [itsm]configure-ai-agent-as-mcp-tool.html, https://www.servicenow.com/docs/r/build-workflows/workflow-studio/playbook-as-mcp-tool.html

### 6.1 Activation, authentication, connection (ServiceNow behaviour)

| Item | Detail | Basis |
|---|---|---|
| Plugins | `sn_itsm_gen_ai`, `sn_mcp_server`, `sn_itsm_mcp_server` | Documented |
| Admin role | `sn_mcp_server.admin` or `admin`; OAuth client setup needs `oauth_admin` or `admin` | Documented |
| Console | All > MCP Server Console > Configuration > Servers > ITSM MCP Server (scope "ITSM MCP Server"); set Auth scope `a2aauthscope` (enables REST A2A access to agent-backed tools); switch Deactivate to Activate | Documented |
| Default state | Inactive; activation exposes every registered tool at once | Documented |
| OAuth | Activation creates an OAuth client entry named after the integration, for example `sn_itsm_mcp_server.itsm_default`; the authorization code grant form is then prefilled (name, provider, redirect URLs, client id, secret) | Documented |
| Base role | `sn_mcp_server.viewer` for any ITSM MCP tool | Documented |
| Request flow | Client sends the question via MCP; server authenticates the user against platform roles; retrieves or acts; returns results; client renders | Documented |
| Clients | Any MCP client; examples given: Moveworks, Claude | Documented |
| Tool hygiene | Only the documented tools should be listed; extra tools indicate skipped update records to resolve | Documented |
| Transport, endpoint path, resources, prompts | Not documented | n/a |

### 6.2 Tool reference (complete)

ServiceNow names are exact. The ResolvrNow name is the default exposed name (§6.4).

| ServiceNow tool | ResolvrNow name | Operations / behaviour | Who | Basis |
|---|---|---|---|---|
| `sn_itsm_mcp_server.incident.get_details` | `incident_get_details` | Fields of one incident by number. Fulfillers get the full record incl. assignment, CI, work notes; a requester gets a reduced field set and comments-only activity for own incidents, 404 for others | itil, `sn_incident_read`, owner | Documented |
| `sn_itsm_mcp_server.incident.modify` | `incident_modify` | Update work notes, comments, assignee, group, any writable field (fulfiller); business rules run. Requester on own incident: add comment, escalate (`escalate`, `escalation_reason`, sent alone), resolve an active incident; other fields 403, not owned 404 | itil, `sn_incident_write`, owner | Documented |
| `sn_itsm_mcp_server.incident.search_similar` | `incident_search_similar` | Semantic search from an incident or free text; ranked results | itil, `sn_incident_read` | Documented |
| `sn_itsm_mcp_server.lookup_assignment_groups` | `lookup_assignment_groups` | Groups and their members | itil, `sn_incident_read` | Documented |
| `sn_itsm_mcp_server.lookup_users` | `lookup_users` | Users by name, role or group | itil, `sn_incident_read` | Documented |
| `sn_itsm_mcp_server.incident.search_similar_kb` | `incident_search_similar_kb` | Inputs `query` or `incident_number`; active published articles only; each hit: number, relevance score, knowledge base, title, URL | itil, `sn_incident_read` | Documented (doc page shows a stray space in the name) |
| `sn_itsm_mcp_server.incident.get_kb_details` | `incident_get_kb_details` | One published article by number or sys_id: title, knowledge base, state, publish date, full body | itil, `sn_incident_read` | Documented |
| `sn_itsm_mcp_server.incident.attach_kb` | `incident_attach_kb` | Link a published article to an incident (numbers or sys_ids); returns `{status:"attached", incident, kb_number, message}` | itil, `sn_incident_write` | Documented |
| `sn_itsm_mcp_server.change.lifecycle` | `change_lifecycle` | `operation`: `create` (from model, template or type), `update` (fields, state transition, journal), `calculate_risk` (risk calculator incl. questionnaire flow), `upsert_task`, `planned_outage` | itil | Documented |
| `sn_itsm_mcp_server.change.analyze` | `change_analyze` | `suggest_assignment_groups` (similar changes, team history, keywords), `get_risk_and_impact_data` (risk score, blast radius), `suggest_cis` (ranked by confidence), `suggest_models_and_templates` | itil | Documented |
| `sn_itsm_mcp_server.change.query` | `change_query` | `read` (by number, with summaries), `search` (paged, filters or text), `similar_change_and_issues` (needs incident read), `aggregate_by` (cross-tab or independent counts), `get_state_info` (state, valid next states, mandatory fields), `check_schedules_and_conflicts` (with freshness indicator), `data_quality` (score and guidance) | `sn_change_read` | Documented |
| `sn_itsm_mcp_server.change.relation` | `change_relation` | `list_tasks`, `list_affected_cis` (and impacted services), `list_approvals` (caller's pending or all), `list_incidents` (fixed by, caused by, on affected CIs), `list_problems`, `list_outages`, `list_change_policies` (grouped, first/last applied dates) | `sn_change_read` | Documented |
| `sn_itsm_mcp_server.requester.create_incident` | `requester_create_incident` | Multi-step: KB deflection, catalog redirection, duplicate detection among the requester's open incidents, field review, create; returns incident number and portal link, or a RITM number. Backed by the Create Incident AI agent | authenticated user | Documented |
| `sn_itsm_mcp_server.requester.check_status` | `requester_check_status` | Own incident or RITM by number or natural reference ("my latest request"). Incident: number, short description, description, priority, urgency, impact, state, created by, created on. RITM: number, approval, state, stage, estimated delivery, whether caller is requested-for | authenticated user | Documented |
| `sn_itsm_mcp_server.request.modify` | `request_modify` | Customer-visible comment on own RITM; incident numbers rejected; closed or cancelled RITMs rejected | authenticated user | Documented |
| `sn_itsm_mcp_server.oncall.on_call_lookup` | `oncall_on_call_lookup` | `who_is_on_call` (by group or shift: names, contacts); `my_next_shift` (next or active shift: group, shift, times, responder level; one entry per roster) | itil, roster_admin, rota_admin, rota_manager, oc_read (+ roles in `com.snc.on_call_rotation.calendar_read_roles`) | Documented (inactive by default) |
| `sn_itsm_mcp_server.oncall.timeoff_request` | `oncall_timeoff_request` | `analyze` (read-only: affected groups, PTO policy, coverage needs, eligible covers, conflicts) then `create` with the confirmed coverage plan; never submits without explicit user confirmation | same | Documented |
| `sn_itsm_mcp_server.itsm_knowledge_graph` | `itsm_knowledge_graph` | Structured natural-language questions over ITSM data: incidents and changes not Closed Complete; active request and catalog items | per data ACL | Documented |
| `sn_itsm_mcp_server.get_session_timezone` | `get_session_timezone` | No input; returns session time zone and current local date-time; to be called before interpreting dates | any | Documented |
| `sn_itsm_mcp_server.task_approval_decision` | `task_approval_decision` | Records an approve or reject decision on the oldest approval waiting for the caller (change or RITM) | approver | Documented |

Documented incident rules: escalation needs a reason and is refused when the incident is Resolved, Closed or Canceled, when urgency is already High, or when it was escalated in the last 24 hours. Requesters never see work notes. **[Documented]** The "Manage change requests" page still describes older tool names (`change.create`, `change.check_status`, `change.modify`); ResolvrNow registers those as deprecated aliases of `change_lifecycle`/`change_query` only in `servicenow` naming mode. **[Inferred]**

### 6.3 Role matrix for incident tools

| Role | get_details, search_similar, search_similar_kb, get_kb_details, lookup_* | modify, attach_kb | Basis |
|---|---|---|---|
| `itil` | yes | yes | Documented |
| `sn_incident_read` | yes | no | Documented |
| `sn_incident_write` | yes | yes | Documented |
| requester (no role) | get_details on own incidents only | modify on own incidents (comment, escalate, resolve) | Documented |

### 6.4 ResolvrNow MCP server design

| Aspect | ResolvrNow decision | Basis |
|---|---|---|
| SDK | Official MCP TypeScript SDK; tools registered from the shared ResolvrNow tool registry (same handlers as agents) | Inferred |
| Transports | stdio (`resolvrnow mcp --stdio`, for desktop clients and local agents); Streamable HTTP at `/mcp` (POST JSON-RPC, optional SSE stream, `Mcp-Session-Id` header, `MCP-Protocol-Version` header, Origin check). The legacy HTTP+SSE transport is not offered. Target the latest stable MCP revision (2025-06-18 or later, verify at build) | Inferred |
| Activation | Disabled by default (`resolvr.mcp.enabled=false`), mirroring the documented default; enabling exposes all tools the caller's roles allow | Inferred |
| HTTP auth | OAuth 2.1 authorization code with PKCE; ResolvrNow is the authorization server by default; protected resource metadata at `/.well-known/oauth-protected-resource`; 401 with `WWW-Authenticate` pointing to it; audience-bound tokens with scope `resolvr.mcp` (counterpart of `a2aauthscope`); no token passthrough to other services | Inferred |
| Headless auth | Personal access tokens (`Authorization: Bearer`) bound to a user, scoped `resolvr.mcp`, revocable | Inferred |
| stdio auth | `RESOLVRNOW_URL` + `RESOLVRNOW_TOKEN` environment variables; the process acts as that user | Inferred |
| Base role | `mcp_user` (counterpart of `sn_mcp_server.viewer`); `tools/list` hides tools the user cannot call | Inferred |
| Naming | `resolvr.mcp.tool_names = underscore` (default, names in §6.2 ResolvrNow column, safe for clients that reject dots) or `servicenow` (exact dotted names) | Inferred |
| Results | `structuredContent` plus a JSON text copy; each tool declares `outputSchema`; annotations: `readOnlyHint` on get, search, lookup, query, relation, analyze, check_status, timezone; `destructiveHint=false`, `idempotentHint=false` on modify and lifecycle | Inferred |
| Errors | Business errors are tool results with `isError: true` and `{code, message}` where code is one of `NOT_FOUND`, `FORBIDDEN`, `INVALID_STATE`, `VALIDATION`, `CONFIRMATION_REQUIRED`; NOT_FOUND and FORBIDDEN reproduce the documented 404/403 semantics; protocol errors use JSON-RPC codes | Inferred |
| Confirmation | `oncall_timeoff_request` create, `task_approval_decision`, change state transitions and requester `resolve` require a `confirmation_token` returned by a prior preview call; when the client supports elicitation, the server asks inline instead | Inferred |
| Resources (ResolvrNow extension) | `resolvrnow://incident/{number}`, `resolvrnow://change/{number}`, `resolvrnow://kb/{number}`, `resolvrnow://user/me` (read-only JSON) | Inferred |
| Prompts (ResolvrNow extension) | `summarize_incident`, `draft_resolution_notes`, `triage_incident` | Inferred |
| Audit | Every call writes `resolvr_mcp_call_log` (user, tool, arguments hash, record touched, outcome, duration) | Inferred |

Input schemas for every tool are in `data/ai-analytics.json` (`constants.mcpTools`).

Example client configuration (stdio): `{"mcpServers": {"resolvrnow": {"command": "resolvrnow", "args": ["mcp", "--stdio"], "env": {"RESOLVRNOW_URL": "https://resolvr.example.com", "RESOLVRNOW_TOKEN": "<pat>"}}}}`. HTTP clients register `https://resolvr.example.com/mcp` and complete the OAuth flow. **[Inferred]**

## 7. Task Intelligence and Predictive Intelligence

Sources: [pi]predictive-intelligence.html, [pi]predictive-intelligence-frameworks.html, [pi]training-ml-solutions.html, [pi]create-solution-definition.html, [pi]create-similarity-solution.html, [pi]create-clustering-solution.html, [pi]create-regression-solution.html, [pi]predictive-intelligence-properties.html, [pi]configuring-advanced-settings-ml-solutions.html, [pi]using-ml-apis.html, [pi]troubleshooting-predictive-intelligence.html, [pi]review-prediction-results.html, [pi]using-predictive-intelligence.html, [itsm]predictive-intelligence-for-incident.html, [itsm]pi-for-incident.html, [ti]exploring-task-intel-itsm.html, [ti]using-task-intelligence-itsm.html, [ti]set-up-model.html, [ti]set-up-similar-records-prediction-model.html, [ti]edit-your-model.html, [ti]task-intel-monitor-analystics.html, [ti]components-installed-ti-itsm.html, [sow]recommendation-framework-sow.html

### 7.1 Concepts

| Term | Meaning | Basis |
|---|---|---|
| Solution definition | Training records (table + filter), input fields, output field, retraining frequency | Documented |
| Solution | The trained artifact (versioned); metrics: precision (share of predictions that are correct), coverage (share of eligible records that receive a prediction), classes (possible outputs, each with precision, coverage, distribution) | Documented |
| Frameworks | Classification, similarity, clustering; regression can only be retrained, not created | Documented |
| Workflow solutions | Pre-trained text models replace the word corpus for new solutions | Documented |

### 7.2 Solution definition fields

| Framework | Fields | Basis |
|---|---|---|
| Classification | Label, Name (generated), Table, Output field (choice or finite string, causally linked to inputs), Fields (string, reference, choice, HTML; available at creation, rarely blank), Filter, Processing language (English always added), Stopwords, Training frequency (Run once up to Every 180 days; default run once), advanced settings | Documented |
| Similarity | Label, Name, Table (source records), Test table (records to match, may equal Table), Fields, Test fields (journal type unsupported), Filter (no script includes, use database views), Processing language, Training frequency, Update frequency (for example every 15 minutes for open incidents, every day for KB) | Documented |
| Clustering | Label, Name, Table, Fields (dot-walk to a property for references), Use Group By + Group By, Purity fields, Filter, Processing language, Stopwords, Update frequency (assign new records to existing clusters or form new ones), Training frequency (discard and rebuild: daily, every 3 days, weekly, monthly, or once), Minimum records per cluster (at least 2) | Documented |
| Regression (legacy) | Table, numeric output, string/nominal/numeric inputs; statistics MAE, SMAPE, range accuracy, average interval width; prediction with a confidence level (default 95) returns point estimate and bounds | Documented |

### 7.3 Training data rules and limits

| Rule | Value | Basis |
|---|---|---|
| Recommended training size | 30,000 to 300,000 records; above 300,000 the most recent 300,000 are used | Documented |
| Classification minimum | 10,000 records (`glide.platform_ml.api.csv_min_line`); maximum 300,000 (`csv_max_line`) | Documented |
| Small classes | Classes with fewer than 30 records are excluded and listed after training | Documented |
| Clustering size | Aim for at least 2,000; max 300,000 per definition page; property `max_clustering_records` default 100,000 (conflict: ResolvrNow uses 100,000) | Documented (conflict noted) |
| Similarity window | `max_similarity_window_records` default 100,000 | Documented |
| Training timeout | `glide.platform_ml.training_timeout` 21,600,000 ms | Documented |
| Request split | `csv_split_days` 30 days per data request | Documented |
| Scheduler limit | 50 new training requests per 24 hours per instance (scheduled retrains and similarity/cluster updates excluded) | Documented |
| Filter advice | Inactive, resolved or closed records; exclude retired output values; relative dates only; remove null inputs; 80/20 train/evaluation split | Documented |
| Default incident filter | Incident Categorization: created in last 12 months AND active false AND state in Resolved, Closed | Documented |

### 7.4 ITSM solution templates

| Template | Type | Input -> output | Plugins | Basis |
|---|---|---|---|---|
| Incident Assignment | Classification | short_description -> assignment_group | com.glide.platform_ml, com.snc.incident.ml_solution | Documented |
| Incident Categorization | Classification | short_description -> category | same | Documented |
| Incident Service | Classification | short_description -> business_service | same | Documented |
| Incident Configuration Item | Classification | short_description -> cmdb_ci | same | Documented |
| Major Incident Detection / Recommendation | Similarity | Active major incidents to link to; similar incidents to propose a major incident | com.snc.contextual_search_ml, com.snc.incident.mim.ml_solution | Documented |
| Similar Incidents (MIM) | Similarity | Incidents not yet children of the major incident | com.glide.platform_ml, com.snc.incident.mim.ml_solution | Documented |
| Similar Incidents / Open / Closed / Resolved | Similarity | short_description + description | com.snc.contextual_search_ml, com.snc.incident.mim.ml_solution | Documented |
| Similar Knowledge Articles | Similarity | Incident text -> kb_knowledge | same | Documented |
| Similar Open Problems, Similar Open Change Requests | Similarity (inactive by default) | Incident -> problem / change to link | com.snc.incident.ml | Documented |
| Priority prediction | Classification | short_description, description -> priority | ResolvrNow template | Inferred |

### 7.5 Prediction output, thresholds and auto-apply

| Item | Rule | Basis |
|---|---|---|
| Prediction result | Ordered candidates `{confidence (0-100), threshold, predictedValue, predictedSysId}`; options `top_n` and `apply_threshold` | Documented |
| Class threshold | Each class carries estimated precision and coverage and a confidence threshold; a candidate below its class threshold is not applied (API callers can still see it) | Documented |
| Tuning | Adjust class precision/coverage targets to trade coverage for precision; optional class recall target and advanced algorithms (TF-IDF, XGBoost, LightGBM, top-N labels, min records per label, drop "others" under 1 percent, DBSCAN/HDBSCAN/connected components for clustering) | Documented |
| Applying on records | A business rule template calls the predictor for named solutions; the "Update Prediction Results" rule runs when an incident closes and updates precision and coverage statistics | Documented |
| Task Intelligence preferences | Per output field: Autofill (write the best value), Recommendations (show top values to accept or reject; count configured in Recommended Actions), Monitor only (predict in background, store results), Turn off | Documented |
| Workspace field recommendations | Assignment group, CI, Service show predicted values on the Details tab; when the configured threshold is met, the value can be stamped automatically | Documented |
| Base models | Similar Incidents, Similar open Change Requests, Similar open Problems, Major Incident Recommendation are trained and deployed automatically in monitor mode; admins get an analytics link within four weeks | Documented |
| ResolvrNow auto-apply | On insert (and on update while the field is empty), for each active classification solution on the table: predict; if `confidence >= class threshold` and preference is autofill, set the field, add a work note "Predicted by <solution> (<confidence>)" and log `ml_predictor_results(applied=true)`; recommendations are stored in `resolvr_recommendation` and never auto-written; a human-set value is never overwritten | Inferred |

### 7.6 Task Intelligence admin flow

| Stage | Behaviour | Basis |
|---|---|---|
| Setup | Cards: "Predict incident field choices" and "Surface similar records"; roles `sn_ti_admin.tia_admin` or `sn_itsm_ml_task.ti_admin` | Documented |
| Train | Name, output table, conditions, output fields (several), input table, input fields, record count preview, Launch training (email on completion) | Documented |
| Assess | Estimated number of autofilled fields, sample results with comparison view, per-field preference | Documented |
| Deploy | Review then Deploy; next: configure Recommended Actions (context, resource generator mapped to the model, active rule) | Documented |
| Edit | View current results (no change) or retrain (new data/fields), compare old and new results, re-set preferences, changes highlighted, Redeploy replaces the model; Discard possible | Documented |
| Export | Move a model to another instance without rebuilding | Documented |
| Monitoring | Predictions over time; incident MTTR trend; predictions accepted, replaced, skipped; table of mean correct/incorrect/skipped per model and field; daily stacked bars with percentage toggle and baseline from training data | Documented |
| Roles | `sn_itsm_ml_task.ti_admin`, `ti_analyst`, `ti_user` (each contains `sn_incident_read`) | Documented |
| ResolvrNow clustering for problems | Daily: cluster incidents of the last 30 days without `problem_id`; a cluster with at least 5 members and category purity at least 0.6 becomes a "problem candidate" recommendation listing members and top terms | Inferred |

### 7.7 Monitoring definitions

Coverage: predictions that produced an outcome divided by predictions attempted. Precision: predictions equal to the final field value at closure. Recall (as documented): correct predictions divided by attempts. Shown as a 30-day average and daily. **[Documented]** ResolvrNow computes them from `ml_predictor_results` (see `analytics.md` §5.8). **[Inferred]**

## 8. Evaluating quality

Sources: [itsm]qa-l1-sd-ai-spec.html, [itsm]perf-detailed-view-l1-sd-ai-spec.html, [pi]troubleshooting-predictive-intelligence.html, [pi]review-prediction-results.html, [ti]task-intel-monitor-analystics.html

| Capability | Offline evaluation (before release) | Online metric (production) | Gate | Basis |
|---|---|---|---|---|
| Classification | 80/20 time-ordered split; per-class precision, coverage, recall; precision-coverage curve; confusion matrix | Accepted, replaced, skipped rates; precision at closure; drift (30-day precision drop) | Activate version only if solution precision >= target (default 80) at coverage >= 30 percent | Documented metrics; gates Inferred |
| Similarity | Hit@5 using known links (problem_id, parent_incident, attached KB) as ground truth | Click-through and "attach" rate of suggestions | Hit@5 >= 0.5 on golden set | Inferred |
| Clustering | Purity on purity fields; silhouette; manual review of 20 clusters | Candidates converted to problems | Purity >= 0.6 | Documented purity; values Inferred |
| Summaries and notes | Golden set of 50 records per skill; LLM judge rubric: faithfulness (every claim traceable to an input field), coverage of mandatory sections, no leaked work notes in customer text, length | Thumbs up rate, edit distance between generated and saved text, insert rate | Faithfulness >= 0.95, helpful >= 70 percent | Inferred |
| Resolution proposals (worker) | Judge scoring like the documented assessment: step quality, executable resolution (100/50/0), knowledge accuracy, failure cause | Durable auto-resolve rate, reopen rate, proposed-vs-final similarity, follow-up rate, reassignment reasons | Executable resolution mean >= 70 before autonomous mode | Documented rubric; gates Inferred |
| Safety | Prompt-injection suite (instructions hidden in comments, emails, attachments), PII leakage, role masking (user without work-notes access) | Refusal and fallback counts | Zero leaks on suite | Inferred |
| Cost and latency | Token counts per skill on golden set | p95 latency, tokens per call | Summary p95 < 8 s | Inferred |

## 9. ResolvrNow implementation plan

Sources: ResolvrNow design (all rows **[Inferred]**), built on sections 2 to 8; Anthropic API behaviour per the vendor SDK documentation.

### 9.1 Module layout

| Module | Responsibility |
|---|---|
| `server/src/ai/provider/` | `LlmProvider` interface; adapters `anthropic`, `openai_compatible`, `ollama`, `offline` |
| `server/src/ai/skills/` | One folder per skill: `input.ts` (ACL-aware input builder), `prompt.md` (template), `schema.ts` (output JSON schema), `render.ts`, `fallback.ts` (offline) |
| `server/src/ai/agents/` | Agent and workflow runtime, triggers, run logs |
| `server/src/ai/worker/` | L1 AI worker state machine and scheduler |
| `server/src/ml/` | Tokenizer, TF-IDF, classifiers, similarity index, clustering, training jobs, predictor, auto-apply rule |
| `server/src/mcp/` | MCP server (stdio, Streamable HTTP), OAuth endpoints, tool adapters |
| `server/src/tools/` | Shared tool registry used by agents, AI panel and MCP |

### 9.2 LLM provider abstraction

```ts
interface LlmProvider {
  id: 'anthropic' | 'openai_compatible' | 'ollama' | 'offline';
  generate(req: LlmRequest): Promise<LlmResult>;
  supports: { tools: boolean; jsonSchema: boolean; promptCache: boolean; streaming: boolean };
}
interface LlmRequest {
  skill: string; system: string; messages: LlmMessage[];
  tools?: ToolSpec[]; responseSchema?: object; maxOutputTokens: number;
  effort?: 'low' | 'medium' | 'high'; timeoutMs: number; recordRef?: { table: string; sysId: string };
}
interface LlmResult { text?: string; json?: unknown; toolCalls?: ToolCall[]; stop: 'end' | 'tool' | 'max_tokens' | 'refusal' | 'error'; usage: { input: number; output: number; cached: number }; model: string }
```

| Provider | Defaults and rules | Basis |
|---|---|---|
| Anthropic (default) | Official `@anthropic-ai/sdk`; API key from `ANTHROPIC_API_KEY`; default model `claude-opus-5-5` for every skill; admins may pick another model per skill (for example `claude-haiku-5-5` for bulk sentiment); structured output through `output_config.format` (JSON schema); `output_config.effort` low for summaries and classification, medium otherwise; tools with `strict: true` and `tool_choice: auto` (forced tool choice is not accepted by the default model); stable system prompt and tool list first with a `cache_control` breakpoint, record data after it; streaming for KB articles and long outputs; handle `stop_reason: "refusal"` by falling back to the offline path with a notice; opt into the API's server-side refusal fallback (`fallbacks: "default"` with beta `server-side-fallback-2026-07-01`) when enabled in config; never send `thinking: {type: "disabled"}` (rejected by the default model), control depth and cost with effort instead | Inferred |
| OpenAI-compatible | Any `/v1/chat/completions` endpoint; JSON schema response format when supported, else JSON-mode plus validation and one repair retry | Inferred |
| Ollama | Local base URL; JSON format option; tool calling only for models that support it, otherwise agents run in deterministic mode | Inferred |
| Offline | Always available; deterministic algorithms per skill (table below); `stop='end'`, `model='offline'` | Inferred |

Every call writes `sys_generative_ai_log` (skill, record, user, provider, model, tokens, latency, status, output, input hash, feedback). Identical input hash within 10 minutes returns the cached output. **[Inferred]**

### 9.3 Capability to implementation mapping

| Capability | LLM path | Local / offline path |
|---|---|---|
| Incident, change, request summaries | Template + JSON schema sections | Extractive: Issue = short description + first sentence of description; Key actions = first sentence of up to 5 latest distinct work notes (oldest first); Resolution = close notes; change Objective/Plan = justification/implementation plan first sentences |
| Reassignment summary | Same as summary, "handoff" section order | Same extractive output |
| Resolution notes | Template; 50-word input gate | Template "Cause / Steps / Resolution" from journals; same gate |
| Chat summary | Transcript in, schema out | First requester message as reason; last 3 agent messages as steps |
| Reply, email, activity responses | Short generation with tone presets | Fixed templates (acknowledge, follow up, resolution) with field substitution |
| KB article | Schema to KB template | Field mapping of the Standard template (description, close notes, comments) |
| Change risk explanation | Prompt over risk conditions, top 5 assessment answers, similar changes | Deterministic bullet list of the same facts |
| Risk assessment answers | One call per assessment, JSON keyed by question | Not offered offline |
| Sentiment | Classification prompt with reasoning | Lexicon score on last 3 comments (positive > 0.2, negative < -0.2) and trend vs earlier comments |
| Incident Q&A, AI panel | Tool-calling chat over shared tools | Topic buttons calling tools directly |
| Category, group, priority, service, CI prediction | LLM only as fallback when PI confidence is low (agents) | TF-IDF + linear classifier (§9.4) |
| Similar incidents, KB suggestions, major incident detection | Optional rerank by LLM | TF-IDF cosine similarity |
| Problem candidates, suggested steps | Optional cluster naming by LLM | Clustering with top-term concepts |
| Agents and workflows | Tool-calling loop | Deterministic pipelines using PI + rules |
| L1 worker | LLM investigation and response writing | Disabled offline (worker refuses assignment and reassigns) |
| MCP server | Not needed (client brings the LLM) | Fully local |

### 9.4 Local machine learning

| Part | Design |
|---|---|
| Text pipeline | Concatenate input fields (short description weighted twice); lowercase, Unicode normalize, strip HTML, split on non-alphanumerics; stopwords per processing language plus English; light stemming for English; word unigrams and bigrams, min document frequency 2, vocabulary cap 50,000; TF-IDF with sublinear tf and L2 norm |
| Classifiers | Multinomial Naive Bayes baseline and one-vs-rest logistic regression (SGD, L2); pick the better macro precision on the evaluation split; temperature scaling on the evaluation split turns scores into confidence 0-100 |
| Class thresholds | For each class, smallest confidence threshold whose evaluation precision reaches the solution target (default 80); none reaches it: threshold 100 (class never auto-applied); store estimated precision, coverage, distribution in `ml_class` |
| Similarity | Sparse TF-IDF vectors in an inverted index; cosine top-k; window capped at 100,000 records; incremental refresh per update frequency; score reported 0-100; default minimum 30 |
| Clustering | Spherical k-means on TF-IDF (k from record count, about one cluster per 25 records, bounded 2 to 500) for full training; incremental updates assign new records to the nearest centroid when cosine >= 0.35, leftovers form new clusters when they reach the minimum size; concept = top 5 centroid terms; purity = share of the most common purity-field value |
| Regression | Not in v1 (legacy upstream); a ridge model for time-to-resolve may follow |
| Artifacts | JSON (vocabulary, idf, weights) in `ml_solution.artifact`; each training creates a new version; the active version switches only when gates pass; previous version kept for rollback |
| Jobs | `ml.train` per training frequency; `ml.similarity.refresh` and `ml.cluster.update` per update frequency; `ml.prediction_results` at incident close; limit 50 new trainings per day |

### 9.5 Delivery phases

| Phase | Content |
|---|---|
| P1 | Provider abstraction + offline path; incident summarization, resolution notes, KB generation, activity responses; generative log and feedback; PI classification (category, group, priority) with autofill/recommend; similar incidents and KB in side panel |
| P2 | Change summary, risk explanation, request summaries, chat summary, sentiment; clustering and problem candidates; MCP server (incident, KB, requester, common tools) |
| P3 | Agents (triage, investigate, wrap-up), change MCP tools, on-call MCP tools, L1 worker in supervised mode; quality dashboards |
| P4 | L1 autonomous mode with catalog drafting; risk assessment answers; MIM email recommendation |

## 10. Acceptance tests

1. Given incident INC1 in state In Progress with 3 work notes, when an itil user runs `incident_summarization`, then the output has sections Issue and Key Actions Taken and no Resolution section.
2. Given INC1 is Resolved with close notes, when summarized, then the Resolution section is present and contains text derived from `close_notes`.
3. Given a summary is displayed, when the user chooses Share as work notes, edits the text and saves, then exactly one work note with the edited text is added and the log row gets `shared=true`.
4. Given an incident whose short description, description, work notes and comments total 40 words, when resolution notes are requested, then the skill returns error `insufficient_activity` and the Resolve dialog field stays empty.
5. Given resolution notes trigger mode is automatic, when the user opens the Resolve dialog on an incident with 120 words of activity, then `close_notes` is prefilled and `close_code` is not set.
6. Given property `com.snc.incident.create_knowledge.multistate.enable` is empty and incident INC2 is In Progress, when the user opens the action menu, then Create Knowledge is not offered.
7. Given INC3 is Resolved with no attached article, when the user creates knowledge with the Standard template, then a draft `kb_knowledge` is created from description, close notes and comments and linked to INC3.
8. Given change CHG1 in state New, when the record opens, then the Summarize action is hidden.
9. Given CHG2 has no calculated risk, when the record opens, then the risk explanation icon is hidden; after risk is calculated it appears.
10. Given property `sn_itsm_gen_ai.com.snc.asmt_answer_generator.change_request_fields` lists `start_date`, when answers are generated, then the prompt input contains the change's `start_date` and each Likert question gets an answer and a reasoning.
11. Given a user without access to `work_notes`, when they summarize an incident, then no text from work notes appears in the output (role masking).
12. Given provider is offline, when any summary skill runs, then a deterministic extractive summary is returned with `model='offline'` and the call is logged.
13. Given the Anthropic provider returns `stop_reason` refusal, when a summary is requested, then the offline summary is shown with a notice and the log status is `refused_fallback`.
14. Given a trained Incident Categorization solution with class "network" threshold 60, when a new incident is predicted "network" at confidence 72 and preference is autofill, then `category=network` is set, a work note names the solution, and `ml_predictor_results.applied=true`.
15. Given the same solution and confidence 55, when the incident is inserted, then `category` stays empty and a monitor-only result is logged.
16. Given a user set `category` manually, when the prediction rule runs on update, then the value is not overwritten.
17. Given an incident with an applied prediction, when it closes with a different category, then the prediction result is marked incorrect and solution precision is recomputed.
18. Given a classification definition whose filter returns 8,000 records, when training is submitted, then training fails with `insufficient_records` (minimum 10,000).
19. Given a class with 20 training records, when training completes, then that class is excluded and listed in the solution statistics.
20. Given 51 new training requests in 24 hours, when the 51st is submitted, then it is rejected while scheduled retraining still runs.
21. Given the MCP server is disabled, when a client calls `tools/list` over HTTP, then the server answers 404 for `/mcp`.
22. Given an HTTP request to `/mcp` without a token, when it arrives, then the response is 401 with a `WWW-Authenticate` header that references the protected resource metadata URL.
23. Given a user with only `sn_incident_read`, when they call `incident_modify`, then the tool returns `isError` with code FORBIDDEN and nothing changes.
24. Given requester R who is caller on INC4 but not on INC5, when R calls `incident_get_details` for INC5, then the result is NOT_FOUND; for INC4 the result contains comments but no work notes.
25. Given INC4 has urgency High, when R calls `incident_modify` with `escalate=true`, then the result is INVALID_STATE and urgency is unchanged.
26. Given RITM1 is Closed Complete, when R calls `request_modify` with a comment, then the call is rejected; given an incident number, it is rejected with a hint to use `incident_modify`.
27. Given `oncall_timeoff_request` with `operation=create` and no confirmation token, when called, then the result is CONFIRMATION_REQUIRED and no time-off record exists.
28. Given naming mode `servicenow`, when `tools/list` is called by an itil user, then the list contains `sn_itsm_mcp_server.incident.get_details` and does not contain `incident_get_details`.
29. Given the L1 worker in supervised mode proposes a solution, when the human rejects it, then no customer comment is posted and the engagement returns to investigation.
30. Given the L1 worker in autonomous mode asked 3 follow-up questions with no reply, when the third timeout passes, then the incident is reassigned to the configured group and every catalog draft it created is Closed Incomplete with a customer note.
31. Given auto-submit on and all mandatory variables known, when the worker matches a catalog item, then the request is submitted and the incident is On Hold (Awaiting Caller).
32. Given an assessment with Resolution Step Quality 80 and Executable Resolution Partial, when scored, then the composite is 65 and the tier is Partial.
