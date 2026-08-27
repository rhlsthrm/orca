import type {
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
