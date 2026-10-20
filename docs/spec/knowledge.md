# ResolvrNow Spec: Knowledge Management

Status: draft v1 (clean-room). Parity target: ServiceNow "Brazil" public documentation.
Companion data file: `docs/spec/data/catalog-knowledge.json` (choices, extra tables, properties).

## 0. Conventions

- **[Documented]**: stated in the public docs cited in the section (names, values, rules). Compatibility requirement.
- **[Inferred]**: gap filled by us (probable platform value or ResolvrNow design). May be revised, but consistently.
- `kb_knowledge_base`, `kb_knowledge`, `kb_category`, `kb_version`, `kb_knowledge_summary`, `kb_uc_*_mtom`, `kb_article_checklist_summary`, `user_criteria` and `topic` are already in the SDK JSON (`server/src/schema/sdk/sdk-tables.json`). The HTTP layer of the Knowledge API is also covered by `rest-api.md` section 9; section 16 here adds the knowledge semantics. Everything else (feedback, use log, search log, templates, feedback task, submissions, m2m tables) is declared in the companion JSON.
- Template tables (`kb_template_*`) extend `kb_knowledge`; ResolvrNow stores them in the `kb_knowledge` table (table-per-hierarchy by `sys_class_name`), so search and lists treat every article uniformly **[Inferred]**.

## 1. Scope

| In scope (v1) | Out of scope (v1) |
|---|---|
| Knowledge bases, categories, articles, templates (standard, FAQ, How To, What Is, KCS, Known Error, Incident KCS) | Knowledge blocks, AQI checklists (schema only), demand insights, Self-Service Analytics |
| Lifecycle, publish and retire flows, scheduled publish, recall, republish, replacement on retire | Microsoft Word add-in, external content integration, translation management (only `language` field) |
| Versioning (major/minor), checkout, make current, minor edits | Social Q&A, AI Search, Now Assist generation |
| Feedback (helpful, rating, comments, flags), feedback tasks, ownership groups | Subscriptions (v2; properties recorded) |
| View/use counts, attach to task, read/contribute access via user criteria | Domain separation, scoped knowledge bases |
| Knowledge from incident/problem (checkbox, KCS create, known error) | |
| Search behaviour and logs, roles, notifications, Knowledge REST API | |

## 2. Data model

Sources: https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/Installed-with-km-core.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/knowledge-article-templates.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/km-view-logs.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/km-search-logs.html

```
kb_knowledge_base 1..* kb_category (parent_table/parent_id: base or another category)
kb_knowledge_base 1..* kb_knowledge (kb_knowledge_base, kb_category)
kb_knowledge_summary 1..* kb_knowledge   (all versions of one article share a summary and number)
kb_knowledge 1..1 kb_version (current version row) ; kb_version keeps version history
kb_knowledge_base *..* user_criteria  via kb_uc_can_read_mtom / kb_uc_cannot_read_mtom / kb_uc_can_contribute_mtom / kb_uc_cannot_contribute_mtom
kb_knowledge.can_read_user_criteria / cannot_read_user_criteria (glide_list user_criteria)
kb_knowledge 1..* kb_feedback (helpful, rating, comment, flag) ; kb_feedback 1..* m2m_kb_feedback_likes
kb_knowledge 1..* kb_use (view/use log) ; ts_query_kb (search log) 1..* kb_use (search_id)
kb_knowledge *..* task via m2m_kb_task (attached to task) ; kb_knowledge.source -> task (origin task)
kb_knowledge *..* kb_knowledge via kb_2_kb (related) ; *..* sc_cat_item via kb_2_sc (related items)
kb_feedback_task (extends task) -> kb_knowledge (feedback, article)
```

| Table | Purpose | Defined in |
|---|---|---|
| kb_knowledge_base | Knowledge base | SDK JSON **[Documented]** |
| kb_category | Category tree inside a base | SDK JSON **[Documented]** |
| kb_knowledge | Article (prefix KB, numbers from 10000) | SDK JSON **[Documented]** |
| kb_version, kb_knowledge_summary | Version rows and the cross-version summary | SDK JSON **[Documented]** |
| kb_feedback | Feedback entries (flag comments stored here, not in live feed) | companion **[Documented]** table, **[Inferred]** columns |
| kb_feedback_task | Actionable feedback work item (extends task, prefix KBFT **[Inferred]**) | companion |
| kb_use | View and use log (article, user, viewed, used, times_viewed, search_id, session_id) | companion, columns **[Documented]** (View Log) |
| ts_query_kb | Search log (search term, results, user, sort order, final search term, highest click rank, session) | companion, columns **[Documented]** (Search Log) |
| m2m_kb_task | Article attached to task | companion **[Documented]** table |
| kb_2_kb, kb_2_sc, m2m_kb_ci, m2m_kb_feedback_likes, kb_keyword, kb_knowledge_keyword | Related articles, related catalog items, affected products, comment likes, featured keywords | companion **[Documented]** tables |
| kb_article_template, kb_article_template_definition | Template registry and template fields | companion **[Documented]** tables |
| kb_template_faq, kb_template_how_to, kb_template_what_is, kb_template_kcs_article, kb_template_known_error_article, kb_template_incident_kcs_article | Template article classes (extend kb_knowledge) | companion **[Documented]** tables |
| kb_submission | Knowledge submission (when the submission workflow is on) | companion **[Inferred]** name |
| csm_table_map, csm_field_map | Source-to-article field mapping (incident or case to KCS article) | companion **[Documented]** tables |

## 3. Knowledge bases

Sources: https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/create-a-knowledgebase.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/r_KnowledgeWorkflows.html

| Field | Behaviour | Basis |
|---|---|---|
| title | Unique name | Documented |
| owner (mandatory) | Full read and contribute rights; edits the base and its user criteria | Documented |
| kb_managers (glide_list) | Same rights as owner; selected managers receive the `knowledge_manager` role automatically | Documented |
| kb_publish_flow / workflow, kb_retire_flow / retire_workflow | Publish and retire processes; only one engine (flow or workflow) per base; ResolvrNow uses flows only | Documented (both fields), Inferred (ResolvrNow) |
| article_validity (days) | Default `valid_to` = creation date + N days; blank gives 2100-01-01 | Documented |
| disable_commenting, disable_suggesting (hides Flag Article), disable_rating, disable_mark_as_helpful, disable_category_editing (only managers edit categories) | Feedback switches | Documented |
| active | Inactive base: only admin and knowledge admins can create, search or view its articles | Documented |
| template (default field values), mandatory_fields, card_color, icon, description, order | Presentation and defaults | Documented fields |
| kb_version | Release version, default 3 (read-only) | Documented (SDK) |
| Related lists | Can Read, Cannot Read, Can Contribute, Cannot Contribute, Article Templates (if non-empty, only those templates may be used), Featured Content, Categories | Documented |

Seed data **[Inferred]**: bases "IT" (approval publish, approval retire), "Known Error" (approval publish), "Knowledge" (instant publish). Property `glide.knowman.task_kb` points at "IT".

## 4. Categories

`kb_category`: `label` (mandatory), `value`, `parent_table` (`kb_knowledge_base` or `kb_category`), `parent_id`, `full_category` (computed path such as `Network > VPN` **[Inferred]** separator), `active`. Inactive categories cannot receive new articles but existing articles keep them **[Documented]**. Articles without a category appear under an empty category on the KB home **[Documented]**. When `disable_category_editing` is set, only managers create or edit categories **[Documented]**.

## 5. Articles

Sources: https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/create-knowledge-article.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/article-validity.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/article-versioning-changes.html

| Field | Behaviour | Basis |
|---|---|---|
| number | `KB` + 7 digits; shared by all versions of one article | Documented |
| display_number | `<number> v<version>`, for example `KB0010004 v1.02`; used in all references when versioning is on | Documented |
| short_description (mandatory, 100 chars) | Title | Documented |
| text (HTML, 65000) | Body for standard template; template classes add their own fields | Documented |
| article_type | `text` (HTML, default) or `wiki`; visible on standard template only | Documented (HTML or wiki), Inferred values |
| kb_knowledge_base (mandatory), kb_category | One base per article; category requires the base first | Documented |
| workflow_state | Lifecycle (section 6); read-only on the form | Documented |
| author (default current user), revised_by, ownership_group | Authorship and group ownership | Documented |
| valid_to | Expiry; expired or blank articles are excluded from search; default from base validity | Documented |
| scheduled_publish_date | Must be at least 24 hours ahead; earlier publishing uses Publish | Documented |
| published, retired | Dates stamped on transition | Documented fields, Inferred stamping |
| version, base_version, latest, summary, article_id | Versioning links (section 7) | Documented fields |
| can_read_user_criteria, cannot_read_user_criteria, roles | Article-level read access (section 11) | Documented |
| source (task) | Origin task when created from incident/problem/case | Documented |
| sys_view_count, use_count, helpful_count, rating, flagged | Counters (sections 9, 10) | Documented fields |
| display_attachments, direct (Attachment link) | Show attachments below body; or download first attachment instead of opening the article (search links only) | Documented |
| meta, meta_description | Search tags and SEO text | Documented |
| replacement_article | Target used when a retired article is opened | Documented |
| language, parent | Language of this translation and its base-language parent | Documented |
| confidence, governance | KCS fields (section 8) | Documented |
| cmdb_ci, taxonomy_topic, image, disable_commenting, disable_suggesting, view_as_allowed | Misc | Documented (SDK) |

Delete: only `admin` can delete a published article **[Documented]**. Moving an article to another base recomputes `valid_to` using the target base's validity (blank keeps the old date) **[Documented]**.

## 6. Lifecycle (workflow_state)

Sources: https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/knowledge-article-states.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/r_KnowledgeWorkflows.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/schedule-article-publishing.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/recall-article-in-review.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/c_RetiredKnowledgeArticles.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/republish-retired-article.html

### 6.1 States

| Value | Label | Meaning | Basis |
|---|---|---|---|
| draft | Draft | Being written; editable by author/reviser with contribute access, base owner, admin, knowledge_admin, ownership group members | Documented (value `draft` documented) |
| review | Review | Submitted; awaiting approval | Documented (value `review` documented) |
| scheduled_publish | Scheduled for publish | Approved (or instant) with a future publish date | Label Documented, value Inferred |
| published | Published | Live; publishing makes previously published versions outdated | Documented |
| pending_retirement | Pending retirement | Retire requested, awaiting approval | Label Documented, value Inferred |
| retired | Retired | Removed from search; only admin and knowledge_admin can view | Label Documented, value Inferred |
| outdated | Outdated | Superseded by a newer published version, or past `valid_to`; still readable by end users | Label Documented, value Inferred |

### 6.2 Transitions

| From | Action (who) | To | Rule |
|---|---|---|---|
| (new) | Create (contributor) | draft | version 0.01 |
| draft | Publish with instant publish flow | published (or scheduled_publish if a future date is set) | no approval |
| draft | Publish with approval publish flow | review | approvals created for base managers, or ownership group members when the article has a group |
| review | Approve (approver) | published, or scheduled_publish when the date is in the future | if approval completes after the scheduled date, publish immediately |
| review | Reject (approver) | draft | flow cancelled; author notified |
| review / scheduled_publish | Recall (author; with ownership groups also group manager and members; knowledge_admin; admin) | draft | minor version bump |
| scheduled_publish | Scheduler reaches `scheduled_publish_date` | published | job runs at least every 5 minutes **[Inferred]** |
| published | Retire with instant retire flow | retired | only knowledge_admin, knowledge_manager, latest publisher; not kcs_candidate / kcs_contributor |
| published | Retire with approval retire flow | pending_retirement then retired on approval | rejection returns to published |
| published (older version) | Newer version published | outdated | automatic |
| published | `valid_to` passes | outdated | nightly job **[Inferred]** schedule |
| retired | Republish (admin, knowledge_admin) | published | no approval; republishes the last published version |
| outdated | Make this current (knowledge_admin, knowledge_manager, ownership group members) | new draft version | version = latest + 0.01; only when nothing is checked out |

Other rules **[Documented]**: a retired article number is never reused; retiring a parent article does not retire its translations; with versioning on, retire does not create a version; a retired article with `replacement_article` redirects there with HTTP 301 and a notice, otherwise the article page answers 404 "Knowledge record not found" (controlled by `glide.knowman.enable_article_replacement_on_retire`, default true); approval records of knowledge flows cannot be deleted, only approved or rejected.

### 6.3 Publish and retire flows (ResolvrNow flow engine mapping) **[Inferred]** structure, **[Documented]** outcomes

| Seeded flow | Trigger | Steps |
|---|---|---|
| Knowledge - Instant Publish | Publish action on a draft | if `scheduled_publish_date` > now: set scheduled_publish; else set published, stamp `published`, outdate prior versions, bump major version |
| Knowledge - Approval Publish | Publish action on a draft | set review (minor bump); approval step: approvers = ownership group members if group set, else `kb_managers` (fallback knowledge_admin users); any one approval approves, any rejection rejects; approved -> as instant publish; rejected -> draft (minor bump), notify author |
| Knowledge - Instant Retire | Retire action | set retired, stamp `retired`, apply replacement |
| Knowledge - Approval Retire | Retire action | set pending_retirement; approval by same approvers; approved -> retired; rejected -> published |
| Publish Knowledge / Retire Knowledge | Subflows | reusable state change steps for custom flows |

Approver override hook: a TypeScript function `getApprovers(article)` replaces the platform's `KBWorkflow.getApprovers()` customisation point **[Documented]** concept. Approval emails are sent when `glide.knowman.enable_approval_notification` is true (default true) **[Documented]**. Self-approval by ownership group members is allowed unless `glide.knowman.ownership_group.allow_self_approval` is false **[Documented]**.

## 7. Versioning

Sources: https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/article-versioning.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/knowledge-article-version-numbers.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/create-new-article-version.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/revert-previous-article-to-current.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/article-versioning-feedback.html

Enabled by `glide.knowman.versioning.enabled` (default true) **[Documented]**.

Version number rules **[Documented]**:
- Format `<major>.<minor>` with minor steps of 0.01 (`0.01`, `0.02`, ... `1.0`, `1.01`).
- Every workflow_state change adds 0.01, except changes into or out of pending_retirement, retired, outdated.
- Publishing jumps to the next whole number (`0.07` -> `1.0`, `1.03` -> `2.0`).
- Saving edits without a state change keeps the number.

Worked sequence (from the docs): create 0.01 draft; submit 0.02 review; recall 0.03 draft; submit 0.04; reject 0.05 draft; submit 0.06; approve 0.07 scheduled; publish 1.0; checkout 1.01 draft; submit 1.02; approve 1.03; publish 2.0 (1.0 becomes outdated).

Storage model **[Inferred]**:
- One `kb_knowledge` row per major line (each checkout or make-current creates a new row with the same `number` and `summary`, `base_version` pointing at the source row, `revised_by` = actor, `latest = true` moved to the new row).
- A `kb_version` row is written on every version change (`knowledge`, `version` string, `modified_by`, `modified_on`, `snapshot` = sys_mod_count); `kb_knowledge.version` references the current one.
- Only one checked-out (draft or review or scheduled) row may exist per summary at a time; Checkout and Make this current are hidden otherwise **[Documented]**.
- Checkout copies attachments to the new version and rewrites relative attachment links **[Documented]**; `valid_to` is reset from the base validity **[Documented]**.
- Minor edits: when `glide.knowman.versioning.enable_minor_edits` is true, base owners/managers may edit the fields listed in `glide.knowman.versioning.minor_edit_fields` (default `valid_to`; `attachments` allowed) on a published row without a new version **[Documented]**.

Feedback across versions **[Documented]**: average rating and helpfulness carry to the new version; flags reset to false on checkout or make current; view and use counts carry forward (a view of an older version also counts for later published versions, not the reverse); comments of earlier versions stay visible unless live feed is used.

Visibility of versions **[Documented]**: readers see the latest published version and earlier major versions; contributors also see draft/review versions. Opening an outdated version shows a banner linking to the latest. Portal URLs address a version as `sys_id=KB0000005%20V1.0` or by `sys_kb_id`.

## 8. Templates and KCS

Sources: https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/knowledge-article-templates.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/managing-kcs-article-states.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/known-error-article-form.html

| Template | Class (table) | Fields (column) | SEO description source |
|---|---|---|---|
| Standard (always active) | kb_knowledge | Text (`text`) | Text |
| FAQ | kb_template_faq | Question, Answer (`kb_question`, `kb_answer`) | Question |
| How To | kb_template_how_to | Introduction, Instructions (`kb_introduction`, `kb_instructions`) | Introduction |
| What Is | kb_template_what_is | Introduction, Explanation (`kb_introduction`, `kb_explanation`) | Introduction |
| KCS Article | kb_template_kcs_article | Issue, Environment, Cause, Resolution (`kb_issue`, `kb_environment`, `kb_cause`, `kb_resolution`) | Issue |
| Known Error | kb_template_known_error_article | Description, Workaround, Cause (`kb_description`, `kb_workaround`, `kb_cause`) | Description |
| Incident KCS | kb_template_incident_kcs_article | as KCS Article | Issue |

Basis: template names, tables and field labels **[Documented]**; column names other than `kb_issue`, `kb_cause`, `kb_resolution` **[Inferred]**; Incident KCS fields **[Inferred]**.

Rules **[Documented]**: templates other than Standard are inactive until a knowledge_admin activates them; templates cannot be deleted (only deactivated); a base whose Article Templates list is non-empty only allows those templates; the create flow is "choose base, then template, then form". ResolvrNow renders the article body as the template fields in order, each with its label as a heading **[Inferred]**.

KCS (plugin-gated in the platform; always on in ResolvrNow) **[Documented]** values, **[Inferred]** codes:
- `confidence`: set automatically: Draft/Review/Scheduled -> Work in Progress; Published -> Validated if the publisher has knowledge_coach, kcs_contributor or kcs_publisher, else Not Validated; Pending retirement/Outdated keep the published value; Retired -> Archived. Only knowledge_coach, knowledge_admin, kcs_contributor, kcs_publisher may edit it.
- `governance`: Experience Based or Compliance Based; editable by contributors.
- kcs_candidate and kcs_contributor (non-admin) cannot retire.

## 9. Feedback

Sources: https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/r_KnowledgeFeedback.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/actionable-knowledge-feedback.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/review-reassign-feedback-task.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/r_KnowledgeProperties.html

### 9.1 Feedback kinds

| Kind | UI | Stored as | Effect on article | Disable switch |
|---|---|---|---|---|
| Helpful yes/no | "Helpful?" Yes/No buttons at the bottom; always clickable, last answer wins per user **[Inferred]** | `kb_feedback` with `useful` = yes / no | `helpful_count` = number of yes answers; portal shows percentage yes / (yes+no) | base `disable_mark_as_helpful`; properties `glide.knowman.show_yn_rating(.roles)` |
| Star rating 1..5 | Five stars under the title | `kb_feedback.rating` | `rating` = average of latest rating per user (decimal) **[Inferred]** formula | base `disable_rating`; `glide.knowman.show_star_rating(.roles)` |
| Comment | Comment thread with replies, likes, attachments (unauthenticated and snc_external users cannot attach) | `kb_feedback.comments` (+ `parent` for replies, `m2m_kb_feedback_likes`) | none | base `disable_commenting`; `glide.knowman.show_user_feedback(.roles)`; display cap `glide.knowman.feedback.display_threshold`; daily cap `glide.knowman.max_comments_per_user_daily` |
| Flag | "Flag Article" opens a dialog for the suggested change and reason | `kb_feedback` with `flagged = true` | `flagged = true` on the article; listed under All Flagged / My Flagged | base `disable_suggesting` hides the button; `glide.knowman.show_flag(.roles)` |

Visibility of flag comments **[Documented]**: not shown on the article page to ordinary readers; visible to the author, admin, knowledge_admin, knowledge_manager; other users see only their own flags.

Master switch: `glide.knowman.show_rating_options` and its roles property gate the whole rating block **[Documented]**.

### 9.2 Actionable feedback tasks (`kb_feedback_task`)

Creation triggers **[Documented]** properties and defaults:

| Property | Default | Creates a task when |
|---|---|---|
| glide.knowman.feedback.enable_actionable_feedback_for_flag | true | the article is flagged |
| glide.knowman.feedback.enable_actionable_feedback_for_helpful | false | the article is marked not helpful |
| glide.knowman.feedback.enable_actionable_feedback_for_rating | none (off) | rating is at or below the configured value (1..5) |
| glide.knowman.feedback.enable_explicit_feedback | false | (when true) only if the user typed feedback details |

Assignment **[Documented]**: article with ownership group -> group manager (who may reassign; members may self-assign); otherwise the author or reviser.

Task fields: `feedback` (kb_feedback), `article`, `reason`, `description` (details, or a generated "not helpful" / "rated N" note when blank), `resolution_code`, `close_notes`, plus task fields **[Documented]** labels, **[Inferred]** column names.

States **[Documented]** labels, **[Inferred]** values: 1 Open, 2 Work in Progress, 3 Awaiting Information, 6 Resolved, 7 Closed (plus 8 Cancelled **[Inferred]**).

| Transition | Side effect |
|---|---|
| -> Awaiting Information | assignee's additional comment emails the submitter |
| -> Resolved (resolution_code required: Updated article, Created article, Updated search configuration, No action, Others) | email to submitter with the article portal link where they accept or reject the resolution |
| Submitter accepts | task -> Closed automatically |
| Submitter rejects | task -> Work in Progress, reassigned to previous assignee **[Inferred]** |
| -> Closed by assignee | allowed without submitter acceptance |

## 10. Views, use and attach to task

Sources: https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/km-view-logs.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/r_KnowledgeProperties.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/knowledge-service-portal-view.html

- Each article view by a user writes or updates a `kb_use` row (`viewed = true`, `times_viewed`, `search_id` when opened from a search result, `session_id`) **[Documented]** columns. Preview from the form ("View Article" related link) does not count **[Documented]**.
- `sys_view_count` is recomputed periodically as the sum of views within the last `glide.knowman.view_age.days` days (default 30; 0 = all time) **[Documented]**. ResolvrNow job: hourly **[Inferred]**. The portal also shows a total view count including repeat views by the same user **[Documented]**.
- Attach to task: from a task form knowledge search, "Attach to Task" copies the article number and content into the field named by `glide.knowman.attach.fields` (usually comments or work notes), inserts `m2m_kb_task` (article, task), writes `kb_use` with `used = true`, and increments `use_count` **[Documented]** (copy behaviour, tables), **[Inferred]** (counter increment timing).
- The article page lists recent tasks the article was attached to when `glide.knowman.recent_tasks.display` is on, limited by `glide.knowman.recent_tasks` **[Documented]**.

## 11. Access control

Sources: https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/user-access-knowledge.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/t_SelectUCArticle.html

### 11.1 Algorithm (ResolvrNow implements exactly this order)

```
isPrivileged(u, kb) = u has knowledge_admin (non-scoped kb) OR u is kb.owner OR u in kb.kb_managers
canContributeKB(u, kb):
  if isPrivileged -> true
  if u matches any Cannot Contribute criterion -> false
  if kb has Can Contribute criteria -> return u matches one of them
  if property block_access_with_no_user_criteria (default true) -> false
  else -> u has at least one role (other than snc_internal when explicit roles exist)
canReadKB(u, kb):
  if isPrivileged or canContributeKB -> true
  if u matches any Cannot Read criterion -> false
  if kb has Can Read criteria -> return u matches one of them
  return NOT block_access_with_no_user_criteria          (false means everyone, even guests, can read)
canReadArticle(u, a):
  if u in a.ownership_group -> true
  if canContributeKB(u, a.kb) and NOT apply_article_read_criteria (default false) -> true
  if NOT canReadKB(u, a.kb) -> false
  if u matches any a.cannot_read_user_criteria -> false
  if a.can_read_user_criteria non-empty -> return u matches one of them
  if a.roles non-empty and apply_role_based_security (default true) -> u has one of a.roles
  return true
canContributeArticle(u, a) = canContributeKB(u, a.kb) AND (NOT apply_article_read_criteria OR canReadArticle(u, a))
  plus: ownership group members can edit, approve and retire their articles;
        with versioning, managers cannot edit other authors' drafts
```

Basis: the four criteria types, "both match means deny", privileged users bypassing criteria, the two properties and their effects are **[Documented]**; the exact evaluation order and the roles fallback are **[Inferred]** but consistent with the documented tables.

### 11.2 State-based visibility

| State | Who can read |
|---|---|
| published, outdated | Anyone passing `canReadArticle` |
| draft, review, scheduled_publish | Contributors to the base (author, revisers, privileged users, ownership group); ResolvrNow ignores the legacy `glide.knowman.section.view_roles.*` portal properties **[Inferred]** |
| pending_retirement | Readers as published until retired **[Inferred]** |
| retired | admin and knowledge_admin only **[Documented]** |

Inactive base: only admin and knowledge_admin **[Documented]**.

## 12. Knowledge from incidents and problems

Sources: https://www.servicenow.com/docs/r/it-service-management/incident-management/create-knowledge-incident.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/t_ApproveKnowledgeSubmission.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/table-mapping-knowledge-incident.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/t_UseTheKnowledgeCheckBox.html, https://www.servicenow.com/docs/r/it-service-management/problem-management/create-known-error-from-problem.html

| Path | Trigger | Result | Basis |
|---|---|---|---|
| Knowledge check box (incident) | `task.knowledge = true` and the incident moves to Closed | Business rule "Incident Create Knowledge" inserts a draft in `glide.knowman.task_kb`: short_description <- incident short description; text <- additional comments (customer-visible resolution); source <- incident | Documented |
| Knowledge check box (problem) | `knowledge = true` and the problem closes | Business rule "Problem Create Knowledge": short_description <- problem short description; text <- problem work notes; draft | Documented |
| Submission workflow | `glide.knowman.submission.workflow = true` | Instead of a draft, a `kb_submission` is created; a knowledge user reviews it and "Create Article" makes the draft; notifications `kb.submission.closed_created`, `kb.submission.closed_duplicate`, `kb.submission.closed_invalid` | Documented |
| KCS create (incident) | "Create Knowledge" on a Resolved incident with no existing article for it; requires `enable_kcs_incident = true` and the `incident_kcs_article` table map | Opens a draft of the KCS template prefilled via `csm_table_map` / `csm_field_map` (Sys ID -> Source Task, Short description -> Short description, Resolution notes -> Resolution; first comment -> Issue via advanced mapping); when this path is active the checkbox rule does not run | Documented |
| Known error (problem) | "Create Known Error Article" when the problem has no primary known error article | Draft in `kb_template_known_error_article`, base "Known Error", category from problem, source = problem; "Search for Duplicates" checks short description, category, topic | Documented |

ResolvrNow implementation **[Inferred]**: one async business rule on `task` (classes incident, problem) after update when `knowledge` is true and `state` changes to closed; idempotent (skip when an article with `source = task` exists). The draft is attached back through `m2m_kb_task` so the task's Knowledge related list shows it.

## 13. Search

Sources: https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/knowledge-service-portal-search.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/r_KnowledgeProperties.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/km-search-logs.html, https://www.servicenow.com/docs/r/api-reference/rest-apis/knowledge-api.html

| Aspect | Rule | Basis |
|---|---|---|
| Corpus | `workflow_state = published`, `active = true`, `valid_to >= today` (blank excluded), not a knowledge block, readable by the user (`glide.knowman.search.apply_acls` default true) | Documented |
| Matched text | short description, body (all template fields), attachment text; `meta` tags (ignored by AI search) | Documented |
| Multi-word operator | `glide.knowman.search.operator`: OR, or AND then OR (fall back to OR when AND finds nothing) | Documented |
| Sort | Relevancy (default for text queries), Views (`sys_view_count`), Newest (updated/published date), Alphabetical (short description); last choice remembered per user | Documented |
| Facets | Language, Knowledge Base, Category (optionally hierarchical), Author, Tags, Resource type, Rating (N stars and up), Last Modified (past week/month/year), View Count | Documented |
| Language | Session language by default, multi-language search when enabled (`glide.knowman.enable_multi_language_search`) | Documented |
| Pinned / featured | Featured articles via `kb_keyword` + `kb_knowledge_keyword` (default keyword `glide.knowman.default_keyword`) shown first on home | Documented |
| Logging | Each query writes `ts_query_kb` (term, result count, user, sort, session); the clicked rank updates `highest_click_rank`; the last successful term in a session is flagged `final_search_term` | Documented |
| Paging | Standard pages or infinite scroll; `glide.knowman.search.articles_per_page` | Documented |

ResolvrNow engine **[Inferred]**: SQLite FTS5 index over (`number`, `short_description`, stripped body, `meta`, attachment text) with BM25 ranking; field weights 4 (short description) : 1 (body) : 2 (meta); snippet with highlighted terms wrapped in `<B>`; index updated by an async rule on article insert/update and attachment change.

## 14. Roles

Sources: https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/r_KnowledgeRoles.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/Installed-with-km-core.html

| Role | Contains | Grants | Basis |
|---|---|---|---|
| knowledge | | Fulfiller contributor: create/edit in bases where contribute access holds; Knowledge menu | Documented |
| knowledge_manager | knowledge | Granted automatically to users listed as base managers; categories, featured/pinned articles, approvals for their bases | Documented |
| knowledge_admin | knowledge | All bases (except scoped): create bases, set criteria, view and republish retired articles, manage templates | Documented |
| knowledge_coach, knowledge_domain_expert | knowledge | Write, edit, review, AQI reviews | Documented |
| knowledge_group_manager | knowledge_group_member | Manage ownership group members; default feedback task assignee | Documented |
| knowledge_group_member | knowledge | Approve and edit articles of their ownership group; self-assign feedback tasks | Documented |
| kcs_candidate, kcs_contributor, kcs_publisher | knowledge | KCS licences; contributor and candidate cannot retire | Documented |
| (no role) | | Read per criteria; rate, mark helpful, comment, flag; cannot create or edit | Documented |
| admin | | Everything, including deleting published articles | Documented |

Note: one installed-components page says knowledge_manager contains knowledge_admin; the roles page says it contains knowledge. ResolvrNow follows the roles page (knowledge_manager contains knowledge only) **[Inferred]** resolution.

## 15. Notifications and events

Sources: https://www.servicenow.com/docs/r/platform-administration/r_BaselineEmailNotifications.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/r_KnowledgeWorkflows.html, https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/article-validity.html

| Notification | Event | Recipient | Basis |
|---|---|---|---|
| Article approval request | approval.inserted (sysapproval on kb_knowledge) | approvers (managers or ownership group) | Documented behaviour, event name Inferred |
| Article approved / rejected | kb.article.approved / kb.article.rejected | author or reviser | Documented behaviour, Inferred event names |
| Articles expiring next month | kb.article.expiry (monthly, first day) | authorised recipients (author, base owner/managers) | Documented schedule, Inferred event |
| Knowledge Closed Created / Duplicate / Invalid | kb.submission.closed_created / closed_duplicate / closed_invalid | submitter | Documented |
| Feedback task awaiting info / resolved | kb_feedback_task.commented / kb_feedback_task.resolved | feedback submitter | Documented behaviour, Inferred events |

Only active users receive approval emails **[Documented]**.

## 16. Knowledge Management REST API

Source: https://www.servicenow.com/docs/r/api-reference/rest-apis/knowledge-api.html. Paths, parameters, fields and statuses are **[Documented]** unless tagged.

### 16.1 Conventions

- Base `/api/sn_km_api/knowledge`, versioned `/api/sn_km_api/{api_version}/knowledge`. Read-only API; parameter names have no `sysparm_` prefix.
- Public by default: publicly readable bases are served to unauthenticated callers; from API version 1.0.1 an endpoint can be flagged to require authentication. ResolvrNow: property `resolvr.km_api.require_auth` (default false) **[Inferred]**.
- Rate limit 500 requests per hour for unauthenticated and `snc_external` callers.
- Envelope `{"result": ...}`; statuses 200, 401, 500 (attachment endpoint adds 404). ResolvrNow also answers 404 for an unknown or unreadable article id on KM-4 **[Inferred]** (the docs list no 404 there).
- Route the literal segments `featured` and `most_viewed` before `{id}`.

### 16.2 Endpoints

| ID | Method and path | Query parameters | Returns |
|---|---|---|---|
| KM-1 | GET /articles | `query` (text), `filter` (encoded query: `=`, `!=`, `LIKE`, `STARTSWITH`, `ENDSWITH`, joined by `^` and `^OR`, case-sensitive), `fields` (comma list or repeated), `kb` (comma list of base sys_ids), `language` (ISO 639-1 list or `all`; default session language, else `en`), `limit` (30), `offset` (0) | `{meta, articles[]}` ranked by score |
| KM-2 | GET /articles/featured | `fields`, `kb`, `language`, `limit` (30), `offset` (0) | featured plus most viewed; `meta.query = "homepage"`, `score = -1`, no `rank` |
| KM-3 | GET /articles/most_viewed | same as KM-2 | published, valid, active, non-block articles with views > 0, ordered by `sys_view_count` desc then short description |
| KM-4 | GET /articles/{id} (`id` = sys_id or KB number) | `fields`, `language` (only with a KB number: returns that translation), `search_id` + `search_rank` (both or neither), `update_view` (presence means true) | article object |
| KM-5 | GET /articles/{article_sys_id}/attachments/{attachment_sys_id} | none | raw file bytes, `Content-Type` = file MIME type |

### 16.3 Shapes

- `meta`: `start, end, fields, query, filter, kb, language, count (total), ts_query_id (KM-1), status {code}`.
- `articles[]`: `id ("kb_knowledge:<sys_id>"), number, title, snippet (hits wrapped in <B>..</B>), link, rank (1-based, KM-1), score, fields{}, tags[] (KM-3)`.
- Field value object: `{display_value, label, name, type, value}` (all strings).
- Links: KM-1 `?sys_kb_id=<id>&id=kb_article_view&sysparm_rank=<rank>&sysparm_tsqueryId=<ts_query_id>`; KM-2/3 `?id=kb_article_view&sys_kb_id=<id>`.
- KM-4 result: `sys_id, number, short_description, content (HTML), template (bool), template_table (when template), display_attachments, attachments[] and embedded_content[] ({sys_id, file_name, size_bytes (string), state: available | available_conditionally | not_available | pending}, only when display_attachments), fields{}, language, languages[{label, language, sys_id}]`.
- View counting: `search_id` + `search_rank` increments the view count and writes `kb_use` linked to the search; `update_view` does the same when the search pair is absent.

```json
GET /api/sn_km_api/knowledge/articles?query=vpn&limit=1&fields=short_description
{"result":{"meta":{"start":0,"end":1,"fields":"short_description","query":"vpn","filter":"","kb":"",
  "language":"en","count":3,"ts_query_id":"5d1c...","status":{"code":200}},
 "articles":[{"id":"kb_knowledge:0a52...","number":"KB0010021","title":"Reconnect the VPN client",
  "snippet":"Open the <B>VPN</B> client and ...","rank":1,"score":7.4,
  "link":"?sys_kb_id=0a52...&id=kb_article_view&sysparm_rank=1&sysparm_tsqueryId=5d1c...",
  "fields":{"short_description":{"display_value":"Reconnect the VPN client","label":"Short description",
  "name":"short_description","type":"string","value":"Reconnect the VPN client"}}}]}}
```

### 16.4 Writes (ResolvrNow, via Table API) **[Inferred]**

The KM API has no write endpoints. ResolvrNow portals write feedback through the Table API with ACLs: `POST /api/now/table/kb_feedback` (any user who can read the article; one helpful and one rating row per user per article version are upserted), `POST /api/now/table/kb_use` is internal only (written by the article page service), article CRUD through `/api/now/table/kb_knowledge` with the contribute checks of section 11, and lifecycle actions through `POST /api/now/table/kb_knowledge/{sys_id}` setting `workflow_state` being rejected (state changes only via action endpoints `POST /api/app/km/articles/{sys_id}/{publish|retire|recall|checkout|make_current|republish}`).

## 17. Properties (selected)

Source: https://www.servicenow.com/docs/r/servicenow-platform/knowledge-management/r_KnowledgeProperties.html. Names and stated defaults **[Documented]**; full list in the companion JSON.

| Property | Default | Use |
|---|---|---|
| glide.knowman.versioning.enabled | true | Versioning |
| glide.knowman.versioning.enable_minor_edits | false | Minor edits on published |
| glide.knowman.versioning.minor_edit_fields | valid_to | Minor-edit field list |
| glide.knowman.view_age.days | 30 | View-count window |
| glide.knowman.block_access_with_no_user_criteria | true | Deny when criteria missing |
| glide.knowman.apply_article_read_criteria | false | Article read criteria override base contribute |
| glide.knowman.search.apply_acls | true | ACLs on search results |
| glide.knowman.enable_approval_notification | true | Approval emails |
| glide.knowman.enable_article_replacement_on_retire | true | Replacement redirect |
| glide.knowman.feedback.enable_actionable_feedback_for_flag | true | Task on flag |
| glide.knowman.feedback.enable_actionable_feedback_for_helpful | false | Task on not helpful |
| glide.knowman.submission.workflow | (false) | Submissions instead of drafts |
| glide.knowman.task_kb | (sys_id) | Base for task-created articles |
| glide.knowman.attach.fields | (comments) | Field receiving attached article text |
| glide.knowman.aqi_pass_score | 70 | AQI pass mark (schema only) |
| glide.knowman.enable_km_subscription.workflow_state | draft,review,published | Subscribable states (v2) |

## 18. Acceptance tests

Fixtures: base IT (owner `olga`, managers `mia`; approval publish, approval retire; validity 365 days; Can Read = "All employees", Can Contribute = "IT staff"); base Public (instant publish/retire, no criteria); users `ann` (knowledge, IT staff), `eve` (no role, employee), `gus` (guest), `kim` (knowledge_admin); `glide.knowman.block_access_with_no_user_criteria = true` unless stated.

| # | Given | When | Then |
|---|---|---|---|
| 1 | ann has contribute access to IT | ann creates an article on 2026-03-01 | workflow_state draft, version 0.01, number with KB prefix, valid_to 2027-03-01 |
| 2 | Base with blank Article Validity | article created | valid_to = 2100-01-01 |
| 3 | Draft 0.01 in IT | ann publishes | state review, version 0.02, one approval per manager (mia) |
| 4 | Article in review | mia approves (no schedule) | state published, version 1.0, `published` date set |
| 5 | Article in review | mia rejects | state draft, version bumped by 0.01, author notified |
| 6 | Article in review | ann recalls | state draft, version +0.01 |
| 7 | Draft with scheduled_publish_date 3 days ahead in Public | ann publishes | state scheduled_publish; after the date passes the scheduler sets published |
| 8 | scheduled_publish_date set 2 hours ahead | save | validation error (must be at least 24 hours ahead) |
| 9 | Published 1.0 | ann checks out | new row version 1.01 draft, same number, `base_version` = 1.0 row, `latest` true on the new row, 1.0 still published |
| 10 | A checked-out 1.01 exists | someone tries Checkout on 1.0 | action unavailable (rejected) |
| 11 | 1.01 goes through review and publish | publish completes | new row is 2.0 published; 1.0 becomes outdated |
| 12 | Outdated 1.0 and current 3.0, nothing checked out | kim chooses Make this current on 1.0 | new draft with version 3.01 |
| 13 | Published article in IT | mia triggers Retire | pending_retirement; on approval retired; on rejection back to published |
| 14 | Retired article with replacement KB2 | eve opens the retired article URL | HTTP 301 to KB2 with a replaced-article notice |
| 15 | Retired article without replacement | eve opens it | 404 "Knowledge record not found" |
| 16 | Retired article | kim republishes | state published (no approval) |
| 17 | kcs_contributor without admin | tries to retire | denied |
| 18 | eve matches IT Can Read | eve searches "vpn" | only published, active, unexpired IT/Public articles are returned; drafts never appear |
| 19 | eve matches IT Can Read and also an article's Cannot Read | eve opens that article | denied |
| 20 | Base with no read criteria and block property true | gus (guest) reads it | denied; with the property false gus can read |
| 21 | ann has contribute on IT and article Cannot Read matches ann; `apply_article_read_criteria = false` | ann opens it | allowed; with the property true it is denied |
| 22 | Article with ownership group G | a member of G (not author) edits and approves it | allowed |
| 23 | eve marks an article helpful twice (yes then no) | feedback read | one effective helpful entry (no) for eve; `helpful_count` excludes her |
| 24 | `enable_actionable_feedback_for_flag = true`, article without ownership group | eve flags it | `kb_feedback` flagged row, article `flagged = true`, one `kb_feedback_task` assigned to the author |
| 25 | `enable_actionable_feedback_for_rating = 2` | eve rates 2 stars | a feedback task is created; rating 3 creates none |
| 26 | Feedback task resolved with code Updated article | eve accepts | task state Closed |
| 27 | Base with `disable_rating` | article page renders | no star control; API POST of a rating row returns 403 |
| 28 | Incident with `knowledge = true` and comments "Restart the agent" | incident is closed | a draft exists in `glide.knowman.task_kb` with short description copied, body containing the comment, `source` = incident; closing again creates no duplicate |
| 29 | `glide.knowman.submission.workflow = true` | same incident closes | a `kb_submission` row instead of a draft |
| 30 | Problem with knowledge checked and work notes | problem closes | draft whose body contains the work notes |
| 31 | Article attached to incident from the task search | Attach to Task | `m2m_kb_task` row, `kb_use.used = true`, incident comments contain the article number, `use_count` +1 |
| 32 | Article viewed 3 times in 40 days, 2 of them in the last 30 | view-count job runs with view_age 30 | `sys_view_count` = 2 |
| 33 | KM-1 call `?query=vpn&limit=1` | response | `meta.count` is total matches, one article with `rank` 1, link contains `sysparm_tsqueryId`, a `ts_query_kb` row exists |
| 34 | KM-4 with `search_id` and `search_rank` | response | view count incremented and `kb_use.search_id` set |
| 35 | KM-4 with a KB number and `language=fr` where a French translation exists | response | returns the French version with `language = fr` |
| 36 | KM-3 | response | only articles with views > 0, ordered by view count descending |
| 37 | Template base list contains only KCS Article | ann creates an article choosing FAQ | rejected; KCS Article accepted |
| 38 | Version 1.0 had rating 4.0 | checkout and publish 2.0 | 2.0 shows the carried average 4.0; `flagged` reset to false |
