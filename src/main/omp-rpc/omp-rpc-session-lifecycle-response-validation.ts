// Response readers for the verbs that CHANGE or fork the child's session:
// compact, branch (and its candidate list), handoff, new_session, export_html.
// The model/thinking family lives in omp-rpc-command-response-validation.ts,
// which also re-exports these so call sites keep one import surface.
//
// Every reader here is strict on purpose, for the reason spelled out in that
// module: these payloads back a card whose job is to report what the child
// actually did, so a shape this integration cannot read must reject and let
// the caller fail closed. Field names are verbatim upstream wire names
// (rpc-types.ts `RpcResponse`).

import type {
  OmpRpcBranchMessage,
  OmpRpcBranchResult,
  OmpRpcCompactionResult,
  OmpRpcExportedHtml,
  OmpRpcHandoffResult,
  OmpRpcNewSessionResult
} from '../../shared/omp-rpc-protocol'
import { malformedOmpRpcResponse } from './omp-rpc-malformed-response-error'
import { isOmpRpcObject } from './omp-rpc-wire-value-readers'

/** Upstream `CompactionResult`. `details`/`preserveData` are compaction-hook
 *  shaped (`unknown` upstream) and deliberately not carried across IPC. */
export function parseOmpRpcCompactionResult(data: unknown): OmpRpcCompactionResult {
  if (
    !isOmpRpcObject(data) ||
    typeof data.summary !== 'string' ||
    typeof data.firstKeptEntryId !== 'string' ||
    typeof data.tokensBefore !== 'number'
  ) {
    throw malformedOmpRpcResponse('compact')
  }
  return {
    summary: data.summary,
    firstKeptEntryId: data.firstKeptEntryId,
    tokensBefore: data.tokensBefore,
    ...(typeof data.shortSummary === 'string' ? { shortSummary: data.shortSummary } : {})
  }
}

/** `{ text, cancelled }`. `cancelled` is authoritative: `text` is meaningless
 *  when the child declined the rewind. */
export function parseOmpRpcBranchResult(data: unknown): OmpRpcBranchResult {
  if (
    !isOmpRpcObject(data) ||
    typeof data.text !== 'string' ||
    typeof data.cancelled !== 'boolean'
  ) {
    throw malformedOmpRpcResponse('branch')
  }
  return { text: data.text, cancelled: data.cancelled }
}

/** `{ messages: [{ entryId, text }] }`. All-or-nothing: a branch picker with
 *  rows silently missing offers a rewind to the wrong turn. */
export function parseOmpRpcBranchMessages(data: unknown): OmpRpcBranchMessage[] {
  if (!isOmpRpcObject(data) || !Array.isArray(data.messages)) {
    throw malformedOmpRpcResponse('get_branch_messages')
  }
  return data.messages.map((row) => {
    if (!isOmpRpcObject(row) || typeof row.entryId !== 'string' || typeof row.text !== 'string') {
      throw malformedOmpRpcResponse('get_branch_messages')
    }
    return { entryId: row.entryId, text: row.text }
  })
}

/** `RpcHandoffResult | null`. `null` means the child wrote no handoff document;
 *  a present result may still carry no `savedPath`. */
export function parseOmpRpcHandoffResult(data: unknown): OmpRpcHandoffResult {
  if (data === null || data === undefined) {
    return null
  }
  if (!isOmpRpcObject(data)) {
    throw malformedOmpRpcResponse('handoff')
  }
  if (data.savedPath === undefined) {
    return {}
  }
  if (typeof data.savedPath !== 'string') {
    throw malformedOmpRpcResponse('handoff')
  }
  return { savedPath: data.savedPath }
}

/** `{ cancelled }` — the child kept its old session when true. */
export function parseOmpRpcNewSessionResult(data: unknown): OmpRpcNewSessionResult {
  if (!isOmpRpcObject(data) || typeof data.cancelled !== 'boolean') {
    throw malformedOmpRpcResponse('new_session')
  }
  return { cancelled: data.cancelled }
}

/** `{ path }` — the file the child actually wrote, never the requested one. */
export function parseOmpRpcExportedHtml(data: unknown): OmpRpcExportedHtml {
  if (!isOmpRpcObject(data) || typeof data.path !== 'string' || data.path.length === 0) {
    throw malformedOmpRpcResponse('export_html')
  }
  return { path: data.path }
}
