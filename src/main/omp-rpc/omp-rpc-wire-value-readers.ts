// Readers for the individual VALUES that ride inside OMP's frames and command
// responses: the object guard every reader starts from, the closed wire enums,
// the toggle booleans, a catalog `Model` row, a context-usage triplet and a
// todo plan. Nothing here knows which frame or verb carried the value, which
// is why the same `Model` reader backs both a pushed `config_update` and a
// `set_model` echo. The frame readers (omp-rpc-frame-validation.ts) and the
// command-response readers (omp-rpc-command-response-validation.ts and its
// per-family siblings) compose these; the dependency runs one way.
//
// The shared rule across every reader below: a value OMP did not send, or sent
// in a shape this integration cannot read, is UNKNOWN — `undefined` — never a
// fabricated default. The interactive-command surfaces render the child's
// CURRENT selection, so `false` or `'all'` invented here is the UI asserting
// something the child never said.

import type {
  OmpRpcContextUsage,
  OmpRpcInterruptMode,
  OmpRpcModel,
  OmpRpcQueueMode,
  OmpRpcThinkingEffort,
  OmpRpcThinkingLevel,
  OmpRpcTodoItem,
  OmpRpcTodoPhase
} from '../../shared/omp-rpc-protocol'
import {
  OMP_RPC_INTERRUPT_MODES,
  OMP_RPC_QUEUE_MODES,
  OMP_RPC_THINKING_EFFORTS,
  OMP_RPC_THINKING_LEVELS,
  OMP_RPC_TODO_STATUSES
} from '../../shared/omp-rpc-protocol'

export function isOmpRpcObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One of a closed wire list, or undefined when the value is absent or is not
 *  a member of it. Never substitutes a member: the interactive-command surfaces
 *  read these to display the child's CURRENT selection, and inventing one
 *  (`'all'` for a mode OMP never sent) makes the UI assert something false. */
function readWireEnum<T extends string>(value: unknown, members: readonly T[]): T | undefined {
  return typeof value === 'string' && (members as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

export function parseOmpRpcThinkingLevel(value: unknown): OmpRpcThinkingLevel | undefined {
  return readWireEnum(value, OMP_RPC_THINKING_LEVELS)
}

export function parseOmpRpcThinkingEffort(value: unknown): OmpRpcThinkingEffort | undefined {
  return readWireEnum(value, OMP_RPC_THINKING_EFFORTS)
}

export function parseOmpRpcQueueMode(value: unknown): OmpRpcQueueMode | undefined {
  return readWireEnum(value, OMP_RPC_QUEUE_MODES)
}

export function parseOmpRpcInterruptMode(value: unknown): OmpRpcInterruptMode | undefined {
  return readWireEnum(value, OMP_RPC_INTERRUPT_MODES)
}

/** The boolean half of the same rule, shared by every toggle-backed field: a
 *  non-boolean is UNKNOWN, not `false`. Inlining it four times is how one of
 *  them eventually reads `Boolean(value)` and silently reports `off`. */
export function readWireBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** A catalog `Model` with its identity proven. `provider`/`id` are what
 *  `set_model` must send back verbatim and `name` is the only human label, so a
 *  row missing any of them cannot drive a picker and is not a model here.
 *  Undefined rather than throwing, so ONE malformed catalog row degrades that
 *  row instead of failing the whole read; callers that need the row (the
 *  `set_model` echo) turn undefined into their own error. */
export function parseOmpRpcModel(value: unknown): OmpRpcModel | undefined {
  if (
    !isOmpRpcObject(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.name !== 'string' ||
    typeof value.provider !== 'string' ||
    value.provider.length === 0
  ) {
    return undefined
  }
  return {
    ...value,
    id: value.id,
    name: value.name,
    provider: value.provider,
    reasoning: readWireBoolean(value.reasoning),
    contextWindow:
      typeof value.contextWindow === 'number' || value.contextWindow === null
        ? value.contextWindow
        : undefined
  }
}

export function parseOmpRpcContextUsage(value: unknown): OmpRpcContextUsage | undefined {
  if (
    !isOmpRpcObject(value) ||
    typeof value.tokens !== 'number' ||
    typeof value.contextWindow !== 'number' ||
    typeof value.percent !== 'number'
  ) {
    return undefined
  }
  return { tokens: value.tokens, contextWindow: value.contextWindow, percent: value.percent }
}

function parseOmpRpcTodoItem(value: unknown): OmpRpcTodoItem | undefined {
  if (!isOmpRpcObject(value) || typeof value.content !== 'string') {
    return undefined
  }
  const status = readWireEnum(value.status, OMP_RPC_TODO_STATUSES)
  if (!status) {
    return undefined
  }
  return {
    content: value.content,
    status,
    ...(typeof value.blocker === 'string' ? { blocker: value.blocker } : {})
  }
}

/** All-or-nothing per read: a partially decodable todo list is a plan with
 *  tasks silently missing, which is worse to render than none at all. */
export function parseOmpRpcTodoPhases(value: unknown): OmpRpcTodoPhase[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const phases: OmpRpcTodoPhase[] = []
  for (const phase of value) {
    if (!isOmpRpcObject(phase) || typeof phase.name !== 'string' || !Array.isArray(phase.tasks)) {
      return undefined
    }
    const tasks: OmpRpcTodoItem[] = []
    for (const task of phase.tasks) {
      const parsed = parseOmpRpcTodoItem(task)
      if (!parsed) {
        return undefined
      }
      tasks.push(parsed)
    }
    phases.push({ name: phase.name, tasks })
  }
  return phases
}
