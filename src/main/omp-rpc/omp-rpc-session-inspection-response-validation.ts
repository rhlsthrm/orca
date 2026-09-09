// Response readers for the verbs that REPORT on the child without changing
// its selection: get_session_stats, get_messages, get_subagents, and the
// set_todos read-back. The model/thinking family lives in
// omp-rpc-command-response-validation.ts, which also re-exports these so call
// sites keep one import surface.
//
// Strictness follows the same rule as the rest of the family: a counter or a
// roster row this integration cannot read must reject rather than reach the
// renderer half-decoded, because every number here is shown as fact.

import type {
  OmpRpcHistoryMessage,
  OmpRpcSessionStats,
  OmpRpcSubagentSnapshot,
  OmpRpcTodoPhase
} from '../../shared/omp-rpc-protocol'
import { OMP_RPC_SUBAGENT_STATUSES } from '../../shared/omp-rpc-subagent-protocol'
import { malformedOmpRpcResponse } from './omp-rpc-malformed-response-error'
import {
  isOmpRpcObject,
  parseOmpRpcContextUsage,
  parseOmpRpcTodoPhases
} from './omp-rpc-wire-value-readers'

function parseTokenTotals(value: unknown): OmpRpcSessionStats['tokens'] | undefined {
  if (!isOmpRpcObject(value)) {
    return undefined
  }
  const keys = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'total'] as const
  if (keys.some((key) => typeof value[key] !== 'number')) {
    return undefined
  }
  return {
    input: value.input as number,
    output: value.output as number,
    reasoning: value.reasoning as number,
    cacheRead: value.cacheRead as number,
    cacheWrite: value.cacheWrite as number,
    total: value.total as number
  }
}

/** The optional credit block, kept only when every field reads as a number —
 *  a partially-decoded cost line is a wrong number on a spend dashboard. */
function parseCreditTotals(value: unknown): OmpRpcSessionStats['credits'] | undefined {
  if (
    !isOmpRpcObject(value) ||
    typeof value.cost !== 'number' ||
    typeof value.committedCost !== 'number' ||
    typeof value.acuCost !== 'number'
  ) {
    return undefined
  }
  return { cost: value.cost, committedCost: value.committedCost, acuCost: value.acuCost }
}

/** Upstream `SessionStats`. The counters are the whole point of the dashboard
 *  this backs, so every one of them is required; `credits`/`routedModels` are
 *  provider-conditional and absent on most sessions. */
export function parseOmpRpcSessionStats(data: unknown): OmpRpcSessionStats {
  const counters = [
    'userMessages',
    'assistantMessages',
    'toolCalls',
    'toolResults',
    'totalMessages'
  ] as const
  if (
    !isOmpRpcObject(data) ||
    typeof data.sessionId !== 'string' ||
    counters.some((key) => !Number.isSafeInteger(data[key])) ||
    typeof data.premiumRequests !== 'number' ||
    typeof data.cost !== 'number'
  ) {
    throw malformedOmpRpcResponse('get_session_stats')
  }
  const tokens = parseTokenTotals(data.tokens)
  if (!tokens) {
    throw malformedOmpRpcResponse('get_session_stats')
  }
  const credits = parseCreditTotals(data.credits)
  const routedModels = isOmpRpcObject(data.routedModels) ? data.routedModels : undefined
  const contextUsage = parseOmpRpcContextUsage(data.contextUsage)
  return {
    sessionId: data.sessionId,
    ...(typeof data.sessionFile === 'string' ? { sessionFile: data.sessionFile } : {}),
    userMessages: data.userMessages as number,
    assistantMessages: data.assistantMessages as number,
    toolCalls: data.toolCalls as number,
    toolResults: data.toolResults as number,
    totalMessages: data.totalMessages as number,
    tokens,
    premiumRequests: data.premiumRequests,
    cost: data.cost,
    ...(credits === undefined ? {} : { credits }),
    ...(routedModels && Object.values(routedModels).every((turns) => Number.isSafeInteger(turns))
      ? { routedModels: routedModels as Record<string, number> }
      : {}),
    ...(contextUsage === undefined ? {} : { contextUsage })
  }
}

/** `{ messages: AgentMessage[] }`. Entry shape stays unvalidated for the same
 *  reason as a history page: the decoder that renders it is transcript-shaped,
 *  not wire-shaped (D3 floor). */
export function parseOmpRpcMessages(data: unknown): OmpRpcHistoryMessage[] {
  if (
    !isOmpRpcObject(data) ||
    !Array.isArray(data.messages) ||
    !data.messages.every(isOmpRpcObject)
  ) {
    throw malformedOmpRpcResponse('get_messages')
  }
  return data.messages as OmpRpcHistoryMessage[]
}

/** `{ subagents: RpcSubagentSnapshot[] }` — the pull equivalent of the
 *  forwarded subagent frames, so it is checked to the same depth those are
 *  (omp-rpc-subagent-frames.ts): the roster keys and orders on
 *  `id`/`index`/`agent`/`status`, and a nested `progress` carries its own
 *  `id`/`status` that a row cannot be projected without. Fields past those
 *  pass through untouched (D3 floor). */
export function parseOmpRpcSubagentSnapshots(data: unknown): OmpRpcSubagentSnapshot[] {
  if (!isOmpRpcObject(data) || !Array.isArray(data.subagents)) {
    throw malformedOmpRpcResponse('get_subagents')
  }
  return data.subagents.map((row) => {
    if (
      !isOmpRpcObject(row) ||
      typeof row.id !== 'string' ||
      !Number.isSafeInteger(row.index) ||
      (row.index as number) < 0 ||
      typeof row.agent !== 'string' ||
      !Number.isFinite(row.lastUpdate) ||
      (row.agentSource !== 'bundled' &&
        row.agentSource !== 'user' &&
        row.agentSource !== 'project') ||
      !isSubagentStatus(row.status)
    ) {
      throw malformedOmpRpcResponse('get_subagents')
    }
    if (
      row.progress !== undefined &&
      (!isOmpRpcObject(row.progress) ||
        typeof row.progress.id !== 'string' ||
        !isSubagentStatus(row.progress.status))
    ) {
      throw malformedOmpRpcResponse('get_subagents')
    }
    return row as unknown as OmpRpcSubagentSnapshot
  })
}

function isSubagentStatus(value: unknown): boolean {
  return (
    typeof value === 'string' && (OMP_RPC_SUBAGENT_STATUSES as readonly string[]).includes(value)
  )
}

/** `{ todoPhases }` — read back off the child's own response, never echoed
 *  from the request, so a phase list the child rejected is not reported as
 *  applied. */
export function parseOmpRpcTodoPhasesResponse(data: unknown): OmpRpcTodoPhase[] {
  const phases = parseOmpRpcTodoPhases(isOmpRpcObject(data) ? data.todoPhases : undefined)
  if (!phases) {
    throw malformedOmpRpcResponse('set_todos')
  }
  return phases
}
