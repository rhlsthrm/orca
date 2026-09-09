// Everything OMP writes to stdout enters here: JSON decode, the first-frame
// ready/negotiation handshake, chunk reassembly, response correlation handoff
// and server-frame dispatch. Split out of OmpRpcClient, which keeps the
// transport, the command side, the fault latch and the ready promise — this
// router reaches them only through the dependencies below.

import type {
  OmpRpcChunkFrame,
  OmpRpcClientEvent,
  OmpRpcCommand,
  OmpRpcReadyFrame
} from '../../shared/omp-rpc-protocol'
import { OmpRpcChunkReassembler } from './omp-rpc-chunk-reassembler'
import type { OmpRpcPendingResponse } from './omp-rpc-command-correlation'
import { resolveOmpRpcServerFrameEvent } from './omp-rpc-frame-dispatch'
import { isOmpRpcObject, parseOmpRpcReadyFrame } from './omp-rpc-frame-validation'
import {
  handleOmpRpcResponseFrame,
  settleOmpRpcTurnTerminal
} from './omp-rpc-turn-response-settlement'
import { OMP_RPC_PROTOCOL_VERSION } from './omp-rpc-transport-limits'

const MALFORMED_LINE_EXCERPT_CHARS = 200

type OmpRpcInboundFrameRouterDependencies = {
  emit: (event: OmpRpcClientEvent) => void
  /** Terminal: the client latches the fault, rejects everything and disposes. */
  protocolFault: (message: string) => void
  sendCommand: (command: OmpRpcCommand) => Promise<unknown>
  pendingResponses: Map<string, OmpRpcPendingResponse>
  /** Resizes the transport's line limit to the envelope the ready frame advertised. */
  setMaxLineBytes: (maxFrameBytes: number) => void
  hasProtocolFault: () => boolean
  isProtocolV2: () => boolean
  markProtocolV2: () => void
  resolveReady: (result: { ready: OmpRpcReadyFrame; negotiatedProtocolVersion: number }) => void
}

export class OmpRpcInboundFrameRouter {
  private readyFrame: OmpRpcReadyFrame | null = null
  /** Sized from the ready frame's advertised envelope; null until it arrives.
   *  A chunk before then is already a fault (chunks need protocol v2). */
  private chunkReassembler: OmpRpcChunkReassembler | null = null

  constructor(private readonly dependencies: OmpRpcInboundFrameRouterDependencies) {}

  readonly handleLine = (line: string): void => {
    if (this.dependencies.hasProtocolFault()) {
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      const excerpt = line.slice(0, MALFORMED_LINE_EXCERPT_CHARS)
      this.dependencies.protocolFault(`OMP RPC emitted malformed JSON: ${excerpt}`)
      return
    }
    if (!this.readyFrame) {
      this.handleReadyFrame(frame)
      return
    }
    this.handleFrame(frame)
  }

  private handleFrame(frame: unknown): void {
    if (!isOmpRpcObject(frame) || typeof frame.type !== 'string') {
      this.dependencies.protocolFault('OMP RPC frame was not a JSON object with a type')
      return
    }
    if (this.chunkReassembler?.hasPending && frame.type !== 'rpc_chunk') {
      this.dependencies.protocolFault(
        'OMP RPC received a non-chunk frame during a pending chunk sequence'
      )
      return
    }
    if (frame.type === 'rpc_chunk') {
      this.handleChunk(frame as OmpRpcChunkFrame)
      return
    }
    if (frame.type === 'response') {
      this.handleResponse(frame)
      return
    }
    const resolution = resolveOmpRpcServerFrameEvent(
      frame as Record<string, unknown> & { type: string }
    )
    if (resolution) {
      if ('fault' in resolution) {
        this.dependencies.protocolFault(resolution.fault)
      } else {
        if (resolution.event.kind === 'prompt-result') {
          settleOmpRpcTurnTerminal(this.dependencies.pendingResponses, {
            id: resolution.event.id,
            agentInvoked: resolution.event.agentInvoked
          })
        }
        if (resolution.event.kind === 'agent-end' && resolution.event.frame.isTerminal !== false) {
          settleOmpRpcTurnTerminal(this.dependencies.pendingResponses, {})
        }
        this.dependencies.emit(resolution.event)
      }
      return
    }
    this.dependencies.emit({
      kind: 'unknown-frame',
      frame: frame as { type: string } & Record<string, unknown>
    })
  }

  private handleChunk(frame: OmpRpcChunkFrame): void {
    if (!this.dependencies.isProtocolV2() || !this.chunkReassembler) {
      this.dependencies.protocolFault('OMP RPC chunk arrived before protocol v2 negotiation')
      return
    }
    const result = this.chunkReassembler.accept(frame)
    if (result.kind === 'fault') {
      this.dependencies.protocolFault(result.message)
      return
    }
    if (result.kind === 'complete') {
      this.handleFrame(result.frame)
    }
  }

  private handleReadyFrame(frame: unknown): void {
    const ready = parseOmpRpcReadyFrame(frame)
    if (!ready) {
      this.dependencies.protocolFault('OMP RPC first frame was not a valid ready frame')
      return
    }
    this.readyFrame = ready
    this.chunkReassembler = new OmpRpcChunkReassembler(ready)
    this.dependencies.setMaxLineBytes(ready.maxFrameBytes)
    // handleResponse already rejects a negotiate_protocol reply that did not
    // select v2, so reaching the resolve path is itself the version proof.
    void this.dependencies.sendCommand({ type: 'negotiate_protocol', protocolVersion: 2 }).then(
      () => {
        const result = {
          ready,
          negotiatedProtocolVersion: OMP_RPC_PROTOCOL_VERSION
        }
        this.dependencies.emit({ kind: 'ready', ...result })
        this.dependencies.resolveReady(result)
      },
      (error: Error) =>
        this.dependencies.protocolFault(`OMP RPC protocol v2 negotiation failed: ${error.message}`)
    )
  }

  private handleResponse(frame: Record<string, unknown>): void {
    handleOmpRpcResponseFrame(
      this.dependencies.pendingResponses,
      frame,
      () =>
        this.dependencies.emit({
          kind: 'unknown-frame',
          frame: frame as { type: string } & Record<string, unknown>
        }),
      () => {
        this.dependencies.markProtocolV2()
      }
    )
  }
}
