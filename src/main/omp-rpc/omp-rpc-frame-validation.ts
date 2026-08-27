import type {
  OmpRpcAgentEndFrame,
  OmpRpcAssistantMessageEvent,
  OmpRpcExtensionUiRequestFrame,
  OmpRpcMessageUpdateFrame,
  OmpRpcReadyFrame,
  OmpRpcSessionState,
  OmpRpcSlashCommand
} from '../../shared/omp-rpc-protocol'
import {
  OMP_RPC_MAX_FRAME_BYTES,
  OMP_RPC_MAX_REASSEMBLED_FRAME_BYTES,
  OMP_RPC_PROTOCOL_VERSION
} from './omp-rpc-transport-limits'

export function isOmpRpcObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseOmpRpcReadyFrame(value: unknown): OmpRpcReadyFrame | null {
  if (!isOmpRpcObject(value) || value.type !== 'ready' || value.protocolVersion !== 1) {
    return null
  }
  if (
    !Array.isArray(value.supportedProtocolVersions) ||
    !value.supportedProtocolVersions.every((version) => typeof version === 'number') ||
    !value.supportedProtocolVersions.includes(OMP_RPC_PROTOCOL_VERSION)
  ) {
    return null
  }
  if (
    value.maxFrameBytes !== OMP_RPC_MAX_FRAME_BYTES ||
    value.maxReassembledFrameBytes !== OMP_RPC_MAX_REASSEMBLED_FRAME_BYTES
  ) {
    return null
  }
  return value as OmpRpcReadyFrame
}

export function parseOmpRpcCommands(value: unknown): OmpRpcSlashCommand[] {
  if (
    !Array.isArray(value) ||
    !value.every((command) => isOmpRpcObject(command) && typeof command.name === 'string')
  ) {
    throw new Error('OMP RPC command catalog was malformed')
  }
  return value as OmpRpcSlashCommand[]
}

export function parseOmpRpcCommandsData(data: unknown): OmpRpcSlashCommand[] {
  if (!isOmpRpcObject(data)) {
    throw new Error('OMP RPC command catalog response was malformed')
  }
  return parseOmpRpcCommands(data.commands)
}

export function parseOmpRpcSessionState(data: unknown): OmpRpcSessionState {
  if (
    !isOmpRpcObject(data) ||
    (typeof data.sessionFile !== 'string' && data.sessionFile !== null) ||
    (typeof data.sessionId !== 'string' && data.sessionId !== null) ||
    typeof data.isStreaming !== 'boolean' ||
    typeof data.isCompacting !== 'boolean' ||
    !Number.isSafeInteger(data.queuedMessageCount) ||
    (data.queuedMessageCount as number) < 0
  ) {
    throw new Error('OMP RPC session state response was malformed')
  }
  return data as OmpRpcSessionState
}

/** Text/thinking triplet members carry their delta at byte level; every other
 *  documented member (start/*_start/*_end/image_end/done/error) is a bare or
 *  loosely-shaped tag. Unknown member types pass through untouched (D3 floor). */
export function parseOmpRpcAssistantMessageEvent(
  value: unknown
): OmpRpcAssistantMessageEvent | null {
  if (!isOmpRpcObject(value) || typeof value.type !== 'string') {
    return null
  }
  if (
    (value.type === 'text_delta' || value.type === 'thinking_delta') &&
    typeof value.delta !== 'string'
  ) {
    return null
  }
  return value as OmpRpcAssistantMessageEvent
}

export function parseOmpRpcMessageUpdateFrame(frame: unknown): OmpRpcMessageUpdateFrame | null {
  if (!isOmpRpcObject(frame) || frame.type !== 'message_update') {
    return null
  }
  const assistantMessageEvent = parseOmpRpcAssistantMessageEvent(frame.assistantMessageEvent)
  if (!assistantMessageEvent) {
    return null
  }
  return { ...frame, type: 'message_update', assistantMessageEvent } as OmpRpcMessageUpdateFrame
}

export function parseOmpRpcAgentEndFrame(frame: unknown): OmpRpcAgentEndFrame | null {
  if (!isOmpRpcObject(frame) || frame.type !== 'agent_end') {
    return null
  }
  if (frame.messages !== undefined && !Array.isArray(frame.messages)) {
    return null
  }
  if (frame.isTerminal !== undefined && typeof frame.isTerminal !== 'boolean') {
    return null
  }
  return frame as OmpRpcAgentEndFrame
}

export function parseOmpRpcExtensionUiRequestFrame(
  frame: unknown
): OmpRpcExtensionUiRequestFrame | null {
  if (
    !isOmpRpcObject(frame) ||
    frame.type !== 'extension_ui_request' ||
    typeof frame.id !== 'string' ||
    typeof frame.method !== 'string'
  ) {
    return null
  }
  if (frame.options !== undefined) {
    if (!Array.isArray(frame.options) || !frame.options.every((o) => typeof o === 'string')) {
      return null
    }
  }
  return frame as OmpRpcExtensionUiRequestFrame
}
