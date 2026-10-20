import type { Context } from './context.js';
import type { Platform } from './platform.js';
import type { Rec } from './record.js';
import type { BusinessRuleDef } from './rules.js';
import type { AclDef } from './services/acl.js';
import type { EventHandlerDef } from './services/events.js';
import type { PropertyDef } from './services/properties.js';
import type { ScheduledJobDef } from './services/scheduler.js';
import type { ChoiceDef, TableDef } from './types.js';

export interface RoleDef {
  name: string;
  description?: string;
  contains?: string[];
  /** Elevated/privileged role (not granted implicitly by admin in UI listings). */
  elevated?: boolean;
}

export interface NavModuleDef {
  title: string;
  table?: string;
  /** Encoded query for list modules. */
  query?: string;
  /** Workspace route for custom pages (e.g. `/workspace/change-schedule`). */
  route?: string;
  roles?: string[];
  order?: number;
  separator?: boolean;
  icon?: string;
}

export interface NavApplicationDef {
  id: string;
  title: string;
  icon?: string;
  roles?: string[];
  order?: number;
  modules: NavModuleDef[];
}

export interface FormSectionDef {
  caption?: string;
  /** Two-column sections render `left` and `right`; single-column sections use `fields`. */
  left?: string[];
  right?: string[];
  fields?: string[];
}

export interface RelatedListDef {
  /** Child table. */
  table: string;
  /** Field on the child table referencing the parent record (or an encoded query with {sys_id}). */
  field?: string;
  query?: string;
  label?: string;
  columns?: string[];
  /** Many-to-many: relationship table and the field pointing at the other side. */
  via?: { table: string; parentField: string; childField: string };
}

export interface FormLayoutDef {
  table: string;
  view?: string;
  sections: FormSectionDef[];
  relatedLists?: RelatedListDef[];
  /** Fields shown in the record header highlights. */
  highlights?: string[];
}

export interface ListLayoutDef {
  table: string;
  view?: string;
  columns: string[];
  defaultQuery?: string;
  defaultOrder?: string;
}

export interface UiActionResult {
  message?: string;
  error?: string;
  /** Workspace-relative path to navigate to after the action. */
  redirect?: string;
  record?: { table: string; sys_id: string };
}

export interface UiActionDef {
  id: string;
  table: string;
  label: string;
  /** Platform-style action name (e.g. `resolve_incident`). */
  actionName?: string;
  form?: boolean;
  list?: boolean;
  order?: number;
  roles?: string[];
  /** Visible when the encoded query or predicate matches the current record. */
  condition?: string | ((rec: Rec, ctx: Context) => boolean);
  style?: 'primary' | 'default' | 'destructive';
  /** Confirmation prompt shown before running. */
  confirm?: string;
  /** Fields the user must fill (rendered as a dialog) before the action runs. */
  prompt?: { field: string; label?: string; mandatory?: boolean }[];
  /** Save form changes before running (default true). */
  saveFirst?: boolean;
  run: (rec: Rec, ctx: Context, input: Record<string, unknown>) => UiActionResult | void;
}

export interface UiPolicyActionDef {
  field: string;
  mandatory?: boolean;
  visible?: boolean;
  readOnly?: boolean;
}

export interface UiPolicyDef {
  id: string;
  table: string;
  name: string;
  /** Encoded query evaluated in the browser against the form values. */
  condition: string;
  onLoad?: boolean;
  reverseIfFalse?: boolean;
  order?: number;
  actions: UiPolicyActionDef[];
}

export interface ModuleUiDef {
  navigation?: NavApplicationDef[];
  forms?: FormLayoutDef[];
  lists?: ListLayoutDef[];
  uiActions?: UiActionDef[];
  uiPolicies?: UiPolicyDef[];
}

/** A unit of functionality (an "application") contributing tables, logic, data and UI. */
export interface AppModule {
  id: string;
  name: string;
  description?: string;
  dependsOn?: string[];
  tables?: TableDef[];
  /** Extra choices for existing fields: key `table.field`. */
  choices?: Record<string, ChoiceDef[]>;
  roles?: RoleDef[];
  acls?: AclDef[];
  rules?: BusinessRuleDef[];
  properties?: PropertyDef[];
  events?: { name: string; table?: string; description?: string }[];
  eventHandlers?: EventHandlerDef[];
  jobs?: ScheduledJobDef[];
  ui?: ModuleUiDef;
  /** Free-form registration with full platform access (hooks, services). */
  register?: (platform: Platform) => void;
  /** Base data required by the module; re-run when seedVersion increases. */
  seed?: (ctx: Context) => void;
  seedVersion?: number;
  /** Optional demonstration data. */
  demo?: (ctx: Context) => void;
  /** Runs after seeding on every boot (metadata mirroring, cache warm-up). */
  afterBoot?: (platform: Platform) => void;
  /**
   * HTTP routes. Receives the Fastify instance and the server's ApiDeps; typed loosely
   * so the engine does not depend on the HTTP layer (cast inside the module).
   */
  http?: (app: unknown, deps: unknown) => void;
}
