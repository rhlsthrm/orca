// Response readers for OMP's interactive-command verbs. This module owns the
// model / thinking / fast-mode family — the verbs that read or move the
// child's inference selection — and is the single import surface for the whole
// family set: the session-lifecycle readers (compact / branch / handoff /
// new_session / export_html), the session-inspection readers (stats /
// messages / subagents / todos) and the auth readers live in the sibling
// modules re-exported at the bottom.
//
// The frame side is omp-rpc-frame-validation.ts (SERVER-PUSHED shapes) and the
// per-value readers all of these build on are omp-rpc-wire-value-readers.ts;
// the dependency runs one way.
//
// Every reader in the family is strict on purpose. These payloads back a
// picker or a toggle whose entire job is to show the child's real state, so a
// shape this integration cannot read must reject and let the caller fail
// closed — the one thing it must never do is hand the renderer `unknown` and
// let a card render whatever happens to be there. Field names are verbatim
// upstream wire names (rpc-types.ts `RpcResponse`); the only member with no
// `data` at all is the bare-success family (set_thinking_level, the three
// queue modes, set_auto_compaction, set_auto_retry, abort_retry,
// set_session_name), which has nothing to read and therefore no reader.

import type {
  OmpRpcCycledModel,
  OmpRpcCycledThinkingLevel,
  OmpRpcFastModeState,
  OmpRpcModel
} from '../../shared/omp-rpc-protocol'
import { malformedOmpRpcResponse } from './omp-rpc-malformed-response-error'
import {
  isOmpRpcObject,
  parseOmpRpcModel,
  parseOmpRpcThinkingEffort,
  parseOmpRpcThinkingLevel
} from './omp-rpc-wire-value-readers'

/** `{ models: Model[] }`. One unreadable catalog row is dropped rather than
 *  failing the whole read — discovery-backed providers (proxy, ollama) publish
 *  rows this integration has never seen. But a NON-EMPTY catalog that decodes
 *  to nothing is a protocol change, not a data quirk, and rejects: silently
 *  reporting "no models" would send the picker to an empty list forever. */
export function parseOmpRpcAvailableModels(data: unknown): OmpRpcModel[] {
  if (!isOmpRpcObject(data) || !Array.isArray(data.models)) {
    throw malformedOmpRpcResponse('get_available_models')
  }
  const models: OmpRpcModel[] = []
  for (const row of data.models) {
    const model = parseOmpRpcModel(row)
    if (model) {
      models.push(model)
    }
  }
  if (models.length === 0 && data.models.length > 0) {
    throw malformedOmpRpcResponse('get_available_models')
  }
  return models
}

/** `set_model` answers with the selected `Model` itself, not a wrapper. */
export function parseOmpRpcSelectedModel(data: unknown): OmpRpcModel {
  const model = parseOmpRpcModel(data)
  if (!model) {
    throw malformedOmpRpcResponse('set_model')
  }
  return model
}

/** `{ model, thinkingLevel, isScoped } | null`. `null` means there was nothing
 *  to cycle to, which is a real outcome and not an error. */
export function parseOmpRpcCycledModel(data: unknown): OmpRpcCycledModel {
  if (data === null || data === undefined) {
    return null
  }
  if (!isOmpRpcObject(data) || typeof data.isScoped !== 'boolean') {
    throw malformedOmpRpcResponse('cycle_model')
  }
  const model = parseOmpRpcModel(data.model)
  if (!model) {
    throw malformedOmpRpcResponse('cycle_model')
  }
  const thinkingLevel = parseOmpRpcThinkingLevel(data.thinkingLevel)
  return {
    model,
    isScoped: data.isScoped,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel })
  }
}

/** `{ level: Effort } | null`. `null` means the current model cannot reason. */
export function parseOmpRpcCycledThinkingLevel(data: unknown): OmpRpcCycledThinkingLevel {
  if (data === null || data === undefined) {
    return null
  }
  const level = parseOmpRpcThinkingEffort(isOmpRpcObject(data) ? data.level : undefined)
  if (!level) {
    throw malformedOmpRpcResponse('cycle_thinking_level')
  }
  return { level }
}

/** `{ enabled, active }`. Both halves are required: a model that cannot serve
 *  fast mode still accepts `enabled`, and `active` is the only field that says
 *  whether it actually took. */
export function parseOmpRpcFastModeState(data: unknown): OmpRpcFastModeState {
  if (
    !isOmpRpcObject(data) ||
    typeof data.enabled !== 'boolean' ||
    typeof data.active !== 'boolean'
  ) {
    throw malformedOmpRpcResponse('set_fast_mode')
  }
  return { enabled: data.enabled, active: data.active }
}

export {
  parseOmpRpcBranchMessages,
  parseOmpRpcBranchResult,
  parseOmpRpcCompactionResult,
  parseOmpRpcExportedHtml,
  parseOmpRpcHandoffResult,
  parseOmpRpcNewSessionResult
} from './omp-rpc-session-lifecycle-response-validation'
export {
  parseOmpRpcMessages,
  parseOmpRpcSessionStats,
  parseOmpRpcSubagentSnapshots,
  parseOmpRpcTodoPhasesResponse
} from './omp-rpc-session-inspection-response-validation'
export {
  parseOmpRpcLoginProviders,
  parseOmpRpcLoginResult
} from './omp-rpc-login-response-validation'
