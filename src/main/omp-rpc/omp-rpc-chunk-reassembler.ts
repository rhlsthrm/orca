import type { OmpRpcChunkFrame } from '../../shared/omp-rpc-protocol'
import {
  OMP_RPC_MAX_CHUNK_PAYLOAD_BYTES,
  OMP_RPC_MAX_FRAME_BYTES,
  OMP_RPC_MAX_REASSEMBLED_FRAME_BYTES
} from './omp-rpc-transport-limits'

type PendingChunks = {
  chunkId: string
  count: number
  byteLength: number
  nextIndex: number
  payloads: Buffer[]
  receivedBytes: number
}

export type OmpRpcChunkResult =
  | { kind: 'pending' }
  | { kind: 'complete'; frame: unknown }
  | { kind: 'fault'; message: string }

function decodeBase64(data: string): Buffer | null {
  if (
    data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  ) {
    return null
  }
  const payload = Buffer.from(data, 'base64')
  return payload.toString('base64') === data ? payload : null
}

function validateChunkFrame(frame: OmpRpcChunkFrame): string | null {
  if (
    typeof frame.chunkId !== 'string' ||
    !Number.isInteger(frame.index) ||
    !Number.isInteger(frame.count) ||
    !Number.isInteger(frame.byteLength) ||
    typeof frame.data !== 'string'
  ) {
    return 'OMP RPC chunk metadata was malformed'
  }
  if (frame.count < 2) {
    return 'OMP RPC chunk count must be at least 2'
  }
  if (
    frame.byteLength < OMP_RPC_MAX_FRAME_BYTES ||
    frame.byteLength > OMP_RPC_MAX_REASSEMBLED_FRAME_BYTES
  ) {
    return 'OMP RPC chunk byte length was outside the permitted range'
  }
  return null
}

export class OmpRpcChunkReassembler {
  private pending: PendingChunks | null = null

  get hasPending(): boolean {
    return this.pending !== null
  }

  accept(frame: OmpRpcChunkFrame): OmpRpcChunkResult {
    const validationError = validateChunkFrame(frame)
    if (validationError) {
      return { kind: 'fault', message: validationError }
    }
    if (!this.pending && frame.index !== 0) {
      return { kind: 'fault', message: 'OMP RPC chunk sequence must start at index 0' }
    }
    if (this.pending && !this.matchesPending(frame, this.pending)) {
      return {
        kind: 'fault',
        message: 'OMP RPC chunk metadata or index did not match pending sequence'
      }
    }
    const payload = decodeBase64(frame.data)
    if (!payload) {
      return { kind: 'fault', message: 'OMP RPC chunk data was not valid base64' }
    }
    if (payload.length > OMP_RPC_MAX_CHUNK_PAYLOAD_BYTES) {
      return { kind: 'fault', message: 'OMP RPC chunk payload exceeded 256 KiB' }
    }
    if (!this.pending) {
      this.pending = {
        chunkId: frame.chunkId,
        count: frame.count,
        byteLength: frame.byteLength,
        nextIndex: 0,
        payloads: [],
        receivedBytes: 0
      }
    }
    this.pending.payloads.push(payload)
    this.pending.receivedBytes += payload.length
    this.pending.nextIndex += 1
    if (this.pending.receivedBytes > this.pending.byteLength) {
      return this.fail('OMP RPC chunk byte length exceeded the advertised size')
    }
    if (this.pending.nextIndex < this.pending.count) {
      return { kind: 'pending' }
    }
    return this.complete()
  }

  private matchesPending(frame: OmpRpcChunkFrame, pending: PendingChunks): boolean {
    return (
      frame.chunkId === pending.chunkId &&
      frame.count === pending.count &&
      frame.byteLength === pending.byteLength &&
      frame.index === pending.nextIndex
    )
  }

  private complete(): OmpRpcChunkResult {
    const pending = this.pending
    this.pending = null
    if (!pending || pending.receivedBytes !== pending.byteLength) {
      return { kind: 'fault', message: 'OMP RPC chunk byte length did not match advertised size' }
    }
    const bytes = Buffer.concat(pending.payloads, pending.receivedBytes)
    let json: string
    try {
      json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return { kind: 'fault', message: 'OMP RPC reassembled frame was not valid UTF-8' }
    }
    try {
      return { kind: 'complete', frame: JSON.parse(json) }
    } catch {
      return { kind: 'fault', message: 'OMP RPC reassembled frame was not valid JSON' }
    }
  }

  private fail(message: string): OmpRpcChunkResult {
    this.pending = null
    return { kind: 'fault', message }
  }
}
