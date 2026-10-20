/**
 * JSON flow definition (schema `resolvr.flow/v1`) and the persisted runtime state of
 * a flow execution. See docs/spec/approvals-flows.md sections 9 to 11.
 */
import type { RowData } from '../../engine/types.js';

export interface VariableDef {
  name: string;
  type?: string;
  label?: string;
  mandatory?: boolean;
  default?: unknown;
}

export interface RecordTrigger {
  type: 'record';
  table: string;
  when?: 'created' | 'updated' | 'created_or_updated';
  /** Encoded query; change operators (CHANGESTO, VALCHANGES...) are allowed. */
  condition?: string;
  run?: 'once' | 'each_unique_change' | 'always' | 'if_not_running';
}

export interface ScheduledTrigger {
  type: 'scheduled';
  repeat: 'once' | 'daily' | 'weekly' | 'monthly' | 'interval';
  /** Date-time (once) or time of day (daily, weekly, monthly), system time zone (UTC). */
  at?: string;
  days_of_week?: (number | string)[] | string;
  day_of_month?: number;
  /** ISO-8601 duration for `interval`. */
  every?: string;
}

export interface ApiTrigger {
  type: 'api';
}

export type FlowTrigger = RecordTrigger | ScheduledTrigger | ApiTrigger;

export interface FlowStep {
  id: string;
  type: string;
  label?: string;
  when_error?: 'fail' | 'continue';
  [key: string]: unknown;
}

export interface FlowDefinition {
  schema?: string;
  name?: string;
  internal_name?: string;
  description?: string;
  type?: 'flow' | 'subflow';
  run_as?: 'system' | 'user';
  run_with_roles?: string[];
  trigger?: FlowTrigger;
  inputs?: VariableDef[];
  outputs?: VariableDef[];
  variables?: VariableDef[];
  steps: FlowStep[];
  error_handler?: FlowStep[];
}

/** Persisted reference to a record (pills keep records as references and re-read them). */
export interface RecordRef {
  $table: string;
  $sys_id: string;
}

export type WaitInfo =
  | { kind: 'duration'; step: string; until: string; outputs?: Record<string, unknown> }
  | {
      kind: 'condition';
      step: string;
      table: string;
      sys_id: string;
      /** Encoded query (evaluated against the updated record, previous values included). */
      query?: string;
      /** Any other condition form, re-evaluated by the runner. */
      condition?: unknown;
      timeout_at?: string | null;
      satisfied?: boolean;
      outputs?: Record<string, unknown>;
    }
  | { kind: 'approval'; step: string; approval_step: string; outputs?: Record<string, unknown> }
  | { kind: 'subflow'; step: string; context: string; outputs?: Record<string, unknown> };

export interface LoopFrame {
  step: string;
  kind: 'each' | 'until';
  items?: unknown[];
  index: number;
  as?: string;
}

/** Runtime state stored in `sys_flow_context.attributes`. */
export interface RunState {
  pc: number;
  mode: 'main' | 'error';
  vars: Record<string, unknown>;
  steps: Record<string, Record<string, unknown>>;
  loops: LoopFrame[];
  outputs: Record<string, unknown>;
  wait: WaitInfo | null;
  error: { step: string; code: string; message: string } | null;
  /** A failure detected while resuming (subflow error) handled before the next step. */
  pending_error?: { step: string; message: string } | null;
  executed: number;
  seq: number;
}

/** Trigger data and inputs stored in `sys_flow_context.plan`. */
export interface Plan {
  trigger: {
    table: string | null;
    sys_id: string | null;
    operation: string;
    user: string | null;
    previous: RowData | null;
  };
  inputs: Record<string, unknown>;
  parent?: { context: string; step: string } | null;
  depth?: number;
}
