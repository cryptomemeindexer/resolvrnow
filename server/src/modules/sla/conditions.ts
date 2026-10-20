import type { MacroEnv } from '../../engine/query/macros.js';
import { type MatchSubject, matches } from '../../engine/query/matcher.js';
import { type ParsedQuery, parseEncodedQuery } from '../../engine/query/parser.js';
import type { Rec } from '../../engine/record.js';
import type { SchemaRegistry } from '../../engine/registry.js';
import { recSubject } from '../../engine/rules.js';

export const CONDITION_CLASSES = {
  base: 'SLAConditionBase',
  simple: 'SLAConditionSimple',
} as const;

const parsedCache = new Map<string, ParsedQuery>();

function parsed(q: string): ParsedQuery {
  let p = parsedCache.get(q);
  if (!p) {
    if (parsedCache.size > 2000) parsedCache.clear();
    p = parseEncodedQuery(q);
    parsedCache.set(q, p);
  }
  return p;
}

/**
 * Matcher subject over a task version. On insert every field counts as changed, which the
 * engine's own subject cannot know once the record has been committed.
 */
export function taskSubject(
  task: Rec,
  previous: Rec | null,
  isNew: boolean,
  registry: SchemaRegistry,
): MatchSubject {
  return { ...recSubject(task, previous, registry), isNew: () => isNew };
}

/** The six lifecycle hooks of an SLA definition (sla.md section 5). */
export class SlaConditions {
  constructor(
    private def: Rec,
    private subject: MatchSubject,
    private env: MacroEnv,
    private simple: boolean,
  ) {}

  /** An empty condition never matches. */
  private m(field: string): boolean {
    const q = this.def.str(field).trim();
    return q !== '' && matches(parsed(q), this.subject, this.env);
  }

  private get cancelPolicy(): string {
    return this.def.str('when_to_cancel') || 'on_condition';
  }

  private get resumePolicy(): string {
    return this.def.str('when_to_resume') || 'on_condition';
  }

  attach(): boolean {
    if (this.simple) return this.m('start_condition');
    return (
      this.m('start_condition') &&
      !this.m('stop_condition') &&
      !(this.cancelPolicy === 'on_condition' && this.m('cancel_condition'))
    );
  }

  complete(): boolean {
    return this.m('stop_condition');
  }

  reattach(): boolean {
    if (this.simple) return this.m('reset_condition');
    return this.m('reset_condition') && this.m('start_condition');
  }

  cancel(): boolean {
    if (this.simple) return this.m('cancel_condition');
    switch (this.cancelPolicy) {
      case 'no_match':
        return !this.m('start_condition');
      case 'never':
        return false;
      default:
        return this.m('cancel_condition');
    }
  }

  pause(): boolean {
    if (this.simple) return this.m('pause_condition');
    return this.m('pause_condition') && !(this.resumePolicy === 'on_condition' && this.m('resume_condition'));
  }

  resume(): boolean {
    if (this.simple) return this.m('resume_condition');
    return this.resumePolicy === 'no_match' ? !this.m('pause_condition') : this.m('resume_condition');
  }
}
