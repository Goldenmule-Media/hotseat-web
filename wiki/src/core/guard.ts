/**
 * In-house FSM guard. typescript-fsm-inspired, ZERO dependency.
 * Pure functions over a declarative transition table. The event log — not any
 * `_current` field — is the source of truth for status; this only answers
 * "is this transition legal?" and "what's the resulting status?".
 */
import type { ITransition } from "../api";

export type { ITransition } from "../api";

/** Build a transition. */
export const t = <S extends string, C extends string>(
  fromState: S,
  event: C,
  toState: S,
  meta?: ITransition<S, C>["meta"],
): ITransition<S, C> => ({ fromState, event, toState, ...(meta ? { meta } : {}) });

export interface Guard<S extends string, C extends string> {
  /** Is `command` permitted from `status`? */
  can(status: S, command: C): boolean;
  /** Resulting status, or undefined if not permitted. */
  next(status: S, command: C): S | undefined;
  /** All commands legal from `status` (deduped) — powers availableMutations(). */
  available(status: S): C[];
  /** The transition's optional metadata, if the transition exists. */
  meta(status: S, command: C): ITransition<S, C>["meta"] | undefined;
  /** All distinct states referenced by the table. */
  states(): S[];
  /** Mermaid lifecycle diagram for docs. */
  toMermaid(title?: string): string;
  readonly transitions: readonly ITransition<S, C>[];
}

export function makeGuard<S extends string, C extends string>(
  transitions: readonly ITransition<S, C>[],
): Guard<S, C> {
  const find = (status: S, command: C) =>
    transitions.find((x) => x.fromState === status && x.event === command);
  return {
    transitions,
    can: (status, command) => find(status, command) !== undefined,
    next: (status, command) => find(status, command)?.toState,
    available: (status) => [
      ...new Set(transitions.filter((x) => x.fromState === status).map((x) => x.event)),
    ],
    meta: (status, command) => find(status, command)?.meta,
    states: () => [
      ...new Set(transitions.flatMap((x) => [x.fromState, x.toState])),
    ],
    toMermaid: (title) => renderMermaid(transitions, title),
  };
}

/** Render a transition table as a Mermaid `stateDiagram-v2`. */
export function renderMermaid<S extends string, C extends string>(
  transitions: readonly ITransition<S, C>[],
  title?: string,
): string {
  const lines: string[] = ["stateDiagram-v2"];
  if (title) lines.push(`  title: ${title}`);
  const states = [...new Set(transitions.flatMap((x) => [x.fromState, x.toState]))];
  if (states.length > 0) lines.push(`  [*] --> ${states[0]}`);
  for (const x of transitions) {
    lines.push(`  ${x.fromState} --> ${x.toState}: ${x.event}`);
  }
  return lines.join("\n") + "\n";
}
