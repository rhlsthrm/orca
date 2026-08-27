import type {
  OmpRpcCommand,
  OmpRpcClientEvent,
  OmpRpcChunkFrame,
  OmpRpcReadyFrame,
  OmpRpcSlashCommand,
  OmpRpcSpawnOptions,
  OmpSessionOwningRpcClient
} from '../../shared/omp-rpc-protocol'
import { OmpRpcChunkReassembler } from './omp-rpc-chunk-reassembler'
import { OmpRpcCommandError, type OmpRpcPendingResponse } from './omp-rpc-command-correlation'
import {
  isOmpRpcObject,
  parseOmpRpcCommands,
  parseOmpRpcCommandsData,
  parseOmpRpcReadyFrame
} from './omp-rpc-frame-validation'
import { OmpRpcProcessTransport } from './omp-rpc-process-transport'
import { OmpRpcProcessExit } from './omp-rpc-process-exit'
import { OmpRpcSessionCommands } from './omp-rpc-session-commands'
import { OMP_RPC_PROTOCOL_VERSION } from './omp-rpc-transport-limits'

const MALFORMED_LINE_EXCERPT_CHARS = 200

type ReadyResult = {
  ready: OmpRpcReadyFrame
  negotiatedProtocolVersion: number
}

export class OmpRpcClient implements OmpSessionOwningRpcClient {
  private readonly transport: OmpRpcProcessTransport
  private readonly listeners = new Set<(event: OmpRpcClientEvent) => void>()
  private readonly readyPromise: Promise<ReadyResult>
  private resolveReady!: (result: ReadyResult) => void
  private rejectReady!: (error: Error) => void
  private readonly processExit: OmpRpcProcessExit
  private readyFrame: OmpRpcReadyFrame | null = null
  private readonly pendingResponses = new Map<string, OmpRpcPendingResponse>()
  private readonly chunkReassembler = new OmpRpcChunkReassembler()
  private requestNumber = 0
  private isProtocolV2 = false
  private hasProtocolFault = false
  private isDisposed = false
  readonly getState: OmpSessionOwningRpcClient['getState']
  readonly switchSession: OmpSessionOwningRpcClient['switchSession']
  readonly abort: OmpSessionOwningRpcClient['abort']
  readonly whenExited: OmpSessionOwningRpcClient['whenExited']

  constructor(options: OmpRpcSpawnOptions) {
    this.readyPromise = new Promise<ReadyResult>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.readyPromise.catch(() => {})
    this.processExit = new OmpRpcProcessExit({
      getStderrTail: () => this.stderrTail,
      isProtocolV2: () => this.isProtocolV2,
      rejectReady: (error) => this.rejectReady(error),
      rejectPendingResponses: (error) => this.rejectPendingResponses(error),
      emit: (event) => this.emit(event),
      clearListeners: () => this.listeners.clear()
    })
    this.whenExited = this.processExit.whenExited
    const sessionCommands = new OmpRpcSessionCommands({
      whenReady: () => this.whenReady(),
      sendCommand: (command) => this.sendCommand(command)
    })
    this.getState = sessionCommands.getState
    this.switchSession = sessionCommands.switchSession
    this.abort = sessionCommands.abort
    this.transport = new OmpRpcProcessTransport(options, {
      onLine: this.handleLine,
      onStreamError: this.handleStreamError,
      onExit: this.processExit.handle
    })
  }

  get stderrTail(): string {
    return this.transport.stderrTail
  }

  whenReady(): Promise<ReadyResult> {
    return this.readyPromise
  }

  async getCommands(): Promise<OmpRpcSlashCommand[]> {
    await this.whenReady()
    const data = await this.sendCommand({ type: 'get_available_commands' })
    const commands = parseOmpRpcCommandsData(data)
    this.emit({ kind: 'commands', commands })
    return commands
  }

  async prompt(message: string): Promise<{ agentInvoked: boolean }> {
    await this.whenReady()
    const data = await this.sendCommand({ type: 'prompt', message })
    return {
      agentInvoked:
        isOmpRpcObject(data) && typeof data.agentInvoked === 'boolean' ? data.agentInvoked : true
    }
  }

  on(listener: (event: OmpRpcClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.isDisposed) {
      return
    }
    this.isDisposed = true
    const disposedError = new Error('OMP RPC client was disposed')
    this.rejectPendingResponses(disposedError)
    if (!this.isProtocolV2) {
      this.rejectReady(disposedError)
    }
    this.transport.dispose()
  }

  private readonly handleLine = (line: string): void => {
    if (this.hasProtocolFault) {
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      const excerpt = line.slice(0, MALFORMED_LINE_EXCERPT_CHARS)
      this.protocolFault(`OMP RPC emitted malformed JSON: ${excerpt}`)
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
      this.protocolFault('OMP RPC frame was not a JSON object with a type')
      return
    }
    if (this.chunkReassembler.hasPending && frame.type !== 'rpc_chunk') {
      this.protocolFault('OMP RPC received a non-chunk frame during a pending chunk sequence')
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
    if (frame.type === 'available_commands_update') {
      try {
        this.emit({ kind: 'commands', commands: parseOmpRpcCommands(frame.commands) })
      } catch (error) {
        this.protocolFault(
          error instanceof Error ? error.message : 'OMP RPC command catalog failed'
        )
      }
      return
    }
    if (frame.type === 'command_output') {
      if (typeof frame.text !== 'string') {
        this.protocolFault('OMP RPC command_output frame was malformed')
        return
      }
      this.emit({ kind: 'command-output', text: frame.text })
      return
    }
    if (frame.type === 'prompt_result') {
      if (
        typeof frame.agentInvoked !== 'boolean' ||
        (frame.id !== undefined && typeof frame.id !== 'string')
      ) {
        this.protocolFault('OMP RPC prompt_result frame was malformed')
        return
      }
      this.emit({ kind: 'prompt-result', id: frame.id, agentInvoked: frame.agentInvoked })
      return
    }
    this.emit({ kind: 'unknown-frame', frame: frame as { type: string } & Record<string, unknown> })
  }

  private handleChunk(frame: OmpRpcChunkFrame): void {
    if (!this.isProtocolV2) {
      this.protocolFault('OMP RPC chunk arrived before protocol v2 negotiation')
      return
    }
    const result = this.chunkReassembler.accept(frame)
    if (result.kind === 'fault') {
      this.protocolFault(result.message)
      return
    }
    if (result.kind === 'complete') {
      this.handleFrame(result.frame)
    }
  }

  private handleReadyFrame(frame: unknown): void {
    const ready = parseOmpRpcReadyFrame(frame)
    if (!ready) {
      this.protocolFault('OMP RPC first frame was not a valid ready frame')
      return
    }
    this.readyFrame = ready
    void this.sendCommand({ type: 'negotiate_protocol', protocolVersion: 2 }).then(
      (data) => {
        if (!isOmpRpcObject(data) || data.protocolVersion !== OMP_RPC_PROTOCOL_VERSION) {
          this.protocolFault('OMP RPC protocol v2 negotiation failed')
          return
        }
        const result = {
          ready,
          negotiatedProtocolVersion: OMP_RPC_PROTOCOL_VERSION
        }
        this.emit({ kind: 'ready', ...result })
        this.resolveReady(result)
      },
      (error: Error) =>
        this.protocolFault(`OMP RPC protocol v2 negotiation failed: ${error.message}`)
    )
  }

  private sendCommand(command: OmpRpcCommand): Promise<unknown> {
    if (this.isDisposed || this.processExit.hasExited || this.hasProtocolFault) {
      return Promise.reject(new Error('OMP RPC client is not available'))
    }
    const id = `orca-omp-${++this.requestNumber}`
    return new Promise((resolve, reject) => {
      this.pendingResponses.set(id, { command: command.type, resolve, reject })
      if (!this.transport.write({ ...command, id })) {
        this.pendingResponses.delete(id)
        reject(new Error('OMP RPC process stdin is unavailable'))
      }
    })
  }

  private handleResponse(frame: Record<string, unknown>): void {
    if (typeof frame.id !== 'string') {
      this.emit({
        kind: 'unknown-frame',
        frame: frame as { type: string } & Record<string, unknown>
      })
      return
    }
    const pending = this.pendingResponses.get(frame.id)
    if (!pending || frame.command !== pending.command) {
      this.emit({
        kind: 'unknown-frame',
        frame: frame as { type: string } & Record<string, unknown>
      })
      return
    }
    this.pendingResponses.delete(frame.id)
    if (frame.success === true) {
      if (pending.command === 'negotiate_protocol') {
        if (
          !isOmpRpcObject(frame.data) ||
          frame.data.protocolVersion !== OMP_RPC_PROTOCOL_VERSION
        ) {
          pending.reject(new Error('response did not select protocol v2'))
          return
        }
        this.isProtocolV2 = true
      }
      pending.resolve(frame.data)
      return
    }
    const message = typeof frame.error === 'string' ? frame.error : 'OMP RPC command failed'
    const code = typeof frame.code === 'string' ? frame.code : undefined
    pending.reject(new OmpRpcCommandError(message, code))
  }

  private readonly handleStreamError = (error: Error): void => {
    if (!this.isProtocolV2) {
      this.rejectReady(error)
    }
    this.rejectPendingResponses(error)
  }

  private rejectPendingResponses(error: Error): void {
    const pendingResponses = [...this.pendingResponses.values()]
    this.pendingResponses.clear()
    for (const pending of pendingResponses) {
      pending.reject(error)
    }
  }

  private protocolFault(message: string): void {
    if (this.hasProtocolFault) {
      return
    }
    this.hasProtocolFault = true
    const error = new Error(message)
    this.emit({ kind: 'protocol-fault', message })
    this.rejectPendingResponses(error)
    if (!this.isProtocolV2) {
      this.rejectReady(error)
    }
  }

  private emit(event: OmpRpcClientEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

export function spawnOmpRpcClient(options: OmpRpcSpawnOptions): OmpRpcClient {
  return new OmpRpcClient(options)
}
