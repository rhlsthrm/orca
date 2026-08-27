// Resolves a parsed OMP RPC server frame into the client event it emits, for
// every frame type beyond the bare transport frames OmpRpcClient still
// handles directly (rpc_chunk reassembly, response correlation).

import type { OmpRpcClientEvent } from '../../shared/omp-rpc-protocol'
import {
  parseOmpRpcAgentEndFrame,
  parseOmpRpcCommands,
  parseOmpRpcExtensionUiRequestFrame,
  parseOmpRpcMessageUpdateFrame
} from './omp-rpc-frame-validation'

/** Frame types forwarded as-is via a plain `{kind, frame}` event: their field
 *  shapes beyond a `type` tag are UNKNOWN at byte level (D3 floor) — pass the
 *  whole parsed object through rather than pretending to validate it. */
const PASSTHROUGH_FRAME_KINDS: Record<string, OmpRpcClientEvent['kind']> = {
  agent_start: 'agent-start',
  turn_start: 'turn-start',
  turn_end: 'turn-end',
  message_start: 'message-start',
  message_end: 'message-end',
  tool_execution_start: 'tool-execution-start',
  tool_execution_update: 'tool-execution-update',
  tool_execution_end: 'tool-execution-end'
}

export type OmpRpcServerFrameResolution = { event: OmpRpcClientEvent } | { fault: string } | null

export function resolveOmpRpcServerFrameEvent(
  frame: Record<string, unknown> & { type: string }
): OmpRpcServerFrameResolution {
  if (frame.type === 'available_commands_update') {
    try {
      return { event: { kind: 'commands', commands: parseOmpRpcCommands(frame.commands) } }
    } catch (error) {
      return { fault: error instanceof Error ? error.message : 'OMP RPC command catalog failed' }
    }
  }
  if (frame.type === 'command_output') {
    return typeof frame.text === 'string'
      ? { event: { kind: 'command-output', text: frame.text } }
      : { fault: 'OMP RPC command_output frame was malformed' }
  }
  if (frame.type === 'prompt_result') {
    if (
      typeof frame.agentInvoked !== 'boolean' ||
      (frame.id !== undefined && typeof frame.id !== 'string')
    ) {
      return { fault: 'OMP RPC prompt_result frame was malformed' }
    }
    return {
      event: {
        kind: 'prompt-result',
        id: frame.id as string | undefined,
        agentInvoked: frame.agentInvoked
      }
    }
  }
  if (frame.type === 'message_update') {
    const messageUpdate = parseOmpRpcMessageUpdateFrame(frame)
    return messageUpdate
      ? { event: { kind: 'message-update', frame: messageUpdate } }
      : { fault: 'OMP RPC message_update frame was malformed' }
  }
  if (frame.type === 'agent_end') {
    const agentEnd = parseOmpRpcAgentEndFrame(frame)
    return agentEnd
      ? { event: { kind: 'agent-end', frame: agentEnd } }
      : { fault: 'OMP RPC agent_end frame was malformed' }
  }
  if (frame.type === 'extension_ui_request') {
    const request = parseOmpRpcExtensionUiRequestFrame(frame)
    return request
      ? { event: { kind: 'extension-ui-request', frame: request } }
      : { fault: 'OMP RPC extension_ui_request frame was malformed' }
  }
  const passthroughKind = PASSTHROUGH_FRAME_KINDS[frame.type]
  if (!passthroughKind) {
    return null
  }
  // Why: rpc.md names these frame types but does not spell out their full
  // field shape (D3 floor) — forward the parsed object as-is.
  return { event: { kind: passthroughKind, frame } as OmpRpcClientEvent }
}
