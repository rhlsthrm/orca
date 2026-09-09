import type {
  OmpRpcCommand,
  OmpRpcClientEvent,
  OmpRpcExtensionUiResponse,
  OmpRpcReadyFrame,
  OmpRpcSlashCommand,
  OmpRpcSpawnOptions,
  OmpSessionOwningRpcClient
} from '../../shared/omp-rpc-protocol'
import { OmpRpcClientEventFanout } from './omp-rpc-client-event-fanout'
import {
  armOmpRpcResponseDeadline,
  rejectAllOmpRpcPendingResponses,
  resolveOmpRpcRequestId,
  type OmpRpcPendingResponse
} from './omp-rpc-command-correlation'
import { parseOmpRpcCommandsData } from './omp-rpc-frame-validation'
import { OmpRpcInboundFrameRouter } from './omp-rpc-inbound-frame-router'
import { OmpRpcProcessTransport } from './omp-rpc-process-transport'
import { OmpRpcProcessExit } from './omp-rpc-process-exit'
import { OmpRpcSessionCommands } from './omp-rpc-session-commands'
import { OmpRpcTurnCommands } from './omp-rpc-turn-commands'

type ReadyResult = {
  ready: OmpRpcReadyFrame
  negotiatedProtocolVersion: number
}

export class OmpRpcClient implements OmpSessionOwningRpcClient {
  private readonly transport: OmpRpcProcessTransport
  // Retains the first fatal frame for a subscriber that attaches after it —
  // see the module note there (XLR-R6-001).
  private readonly fanout = new OmpRpcClientEventFanout()
  private readonly readyPromise: Promise<ReadyResult>
  private resolveReady!: (result: ReadyResult) => void
  private rejectReady!: (error: Error) => void
  private readonly processExit: OmpRpcProcessExit
  private readonly frameRouter: OmpRpcInboundFrameRouter
  private readonly pendingResponses = new Map<string, OmpRpcPendingResponse>()
  private readonly issuedRequestIds = new Set<string>()
  private requestNumber = 0
  private isProtocolV2 = false
  private hasProtocolFault = false
  private isDisposed = false
  readonly getState: OmpSessionOwningRpcClient['getState']
  readonly getMessagesPage: OmpSessionOwningRpcClient['getMessagesPage']
  readonly fetchHistory: OmpSessionOwningRpcClient['fetchHistory']
  readonly setSubagentSubscription: OmpSessionOwningRpcClient['setSubagentSubscription']
  readonly switchSession: OmpSessionOwningRpcClient['switchSession']
  readonly abort: OmpSessionOwningRpcClient['abort']
  readonly whenExited: OmpSessionOwningRpcClient['whenExited']
  readonly prompt: OmpSessionOwningRpcClient['prompt']
  readonly steer: OmpSessionOwningRpcClient['steer']
  readonly followUp: OmpSessionOwningRpcClient['followUp']
  readonly respondExtensionUi: OmpSessionOwningRpcClient['respondExtensionUi']
  // Interactive-command verbs. Same shape as the five above: the wire shape,
  // the readiness gate and the response validation all live in
  // OmpRpcSessionCommands, and the contract type is the single source for
  // every signature — a verb whose helper drifts from it stops compiling here.
  readonly getAvailableModels: OmpSessionOwningRpcClient['getAvailableModels']
  readonly setModel: OmpSessionOwningRpcClient['setModel']
  readonly cycleModel: OmpSessionOwningRpcClient['cycleModel']
  readonly setThinkingLevel: OmpSessionOwningRpcClient['setThinkingLevel']
  readonly cycleThinkingLevel: OmpSessionOwningRpcClient['cycleThinkingLevel']
  readonly setSteeringMode: OmpSessionOwningRpcClient['setSteeringMode']
  readonly setFollowUpMode: OmpSessionOwningRpcClient['setFollowUpMode']
  readonly setInterruptMode: OmpSessionOwningRpcClient['setInterruptMode']
  readonly setFastMode: OmpSessionOwningRpcClient['setFastMode']
  readonly compact: OmpSessionOwningRpcClient['compact']
  readonly setAutoCompaction: OmpSessionOwningRpcClient['setAutoCompaction']
  readonly setAutoRetry: OmpSessionOwningRpcClient['setAutoRetry']
  readonly abortRetry: OmpSessionOwningRpcClient['abortRetry']
  readonly branch: OmpSessionOwningRpcClient['branch']
  readonly getBranchMessages: OmpSessionOwningRpcClient['getBranchMessages']
  readonly setSessionName: OmpSessionOwningRpcClient['setSessionName']
  readonly handoff: OmpSessionOwningRpcClient['handoff']
  readonly newSession: OmpSessionOwningRpcClient['newSession']
  readonly getSessionStats: OmpSessionOwningRpcClient['getSessionStats']
  readonly exportHtml: OmpSessionOwningRpcClient['exportHtml']
  readonly getLoginProviders: OmpSessionOwningRpcClient['getLoginProviders']
  readonly login: OmpSessionOwningRpcClient['login']
  readonly getMessages: OmpSessionOwningRpcClient['getMessages']
  readonly getSubagents: OmpSessionOwningRpcClient['getSubagents']
  readonly setTodos: OmpSessionOwningRpcClient['setTodos']

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
      rejectPendingResponses: (error) =>
        rejectAllOmpRpcPendingResponses(this.pendingResponses, error),
      emit: (event) => this.emit(event),
      clearListeners: () => this.fanout.clear()
    })
    this.whenExited = this.processExit.whenExited
    const sessionCommands = new OmpRpcSessionCommands({
      whenReady: () => this.whenReady(),
      sendCommand: (command) => this.sendCommand(command)
    })
    this.getState = sessionCommands.getState
    this.getMessagesPage = sessionCommands.getMessagesPage
    this.fetchHistory = sessionCommands.fetchHistory
    this.setSubagentSubscription = sessionCommands.setSubagentSubscription
    this.switchSession = sessionCommands.switchSession
    this.abort = sessionCommands.abort
    this.getAvailableModels = sessionCommands.getAvailableModels
    this.setModel = sessionCommands.setModel
    this.cycleModel = sessionCommands.cycleModel
    this.setThinkingLevel = sessionCommands.setThinkingLevel
    this.cycleThinkingLevel = sessionCommands.cycleThinkingLevel
    this.setSteeringMode = sessionCommands.setSteeringMode
    this.setFollowUpMode = sessionCommands.setFollowUpMode
    this.setInterruptMode = sessionCommands.setInterruptMode
    this.setFastMode = sessionCommands.setFastMode
    this.compact = sessionCommands.compact
    this.setAutoCompaction = sessionCommands.setAutoCompaction
    this.setAutoRetry = sessionCommands.setAutoRetry
    this.abortRetry = sessionCommands.abortRetry
    this.branch = sessionCommands.branch
    this.getBranchMessages = sessionCommands.getBranchMessages
    this.setSessionName = sessionCommands.setSessionName
    this.handoff = sessionCommands.handoff
    this.newSession = sessionCommands.newSession
    this.getSessionStats = sessionCommands.getSessionStats
    this.exportHtml = sessionCommands.exportHtml
    this.getLoginProviders = sessionCommands.getLoginProviders
    this.login = sessionCommands.login
    this.getMessages = sessionCommands.getMessages
    this.getSubagents = sessionCommands.getSubagents
    this.setTodos = sessionCommands.setTodos
    const turnCommands = new OmpRpcTurnCommands({
      whenReady: () => this.whenReady(),
      sendCommand: (command, requestId) => this.sendCommand(command, requestId),
      writeRaw: (frame) => this.writeRawFrame(frame)
    })
    this.prompt = turnCommands.prompt
    this.steer = turnCommands.steer
    this.followUp = turnCommands.followUp
    this.respondExtensionUi = turnCommands.respondExtensionUi
    this.frameRouter = new OmpRpcInboundFrameRouter({
      emit: (event) => this.emit(event),
      protocolFault: (message) => this.protocolFault(message),
      sendCommand: (command) => this.sendCommand(command),
      pendingResponses: this.pendingResponses,
      setMaxLineBytes: (maxFrameBytes) => this.transport.setMaxLineBytes(maxFrameBytes),
      hasProtocolFault: () => this.hasProtocolFault,
      isProtocolV2: () => this.isProtocolV2,
      markProtocolV2: () => {
        this.isProtocolV2 = true
      },
      resolveReady: (result) => this.resolveReady(result)
    })
    this.transport = new OmpRpcProcessTransport(options, {
      onLine: this.frameRouter.handleLine,
      onLineOverflow: (message) => this.protocolFault(message),
      onInvalidUtf8: (message) => this.protocolFault(message),
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

  on(listener: (event: OmpRpcClientEvent) => void): () => void {
    return this.fanout.on(listener)
  }

  dispose(): void {
    if (this.isDisposed) {
      return
    }
    this.isDisposed = true
    const disposedError = new Error('OMP RPC client was disposed')
    rejectAllOmpRpcPendingResponses(this.pendingResponses, disposedError)
    if (!this.isProtocolV2) {
      this.rejectReady(disposedError)
    }
    this.transport.dispose()
  }

  private sendCommand(command: OmpRpcCommand, requestId?: string): Promise<unknown> {
    if (this.isDisposed || this.processExit.hasExited || this.hasProtocolFault) {
      return Promise.reject(new Error('OMP RPC client is not available'))
    }
    const id = resolveOmpRpcRequestId(
      requestId,
      ++this.requestNumber,
      (candidate) => this.pendingResponses.has(candidate) || this.issuedRequestIds.has(candidate)
    )
    if (typeof id !== 'string') {
      return Promise.reject(new Error(id.error))
    }
    return new Promise((resolve, reject) => {
      const pending: OmpRpcPendingResponse = { command: command.type, resolve, reject }
      this.pendingResponses.set(id, pending)
      this.issuedRequestIds.add(id)
      if (!this.transport.write({ ...command, id })) {
        this.pendingResponses.delete(id)
        this.issuedRequestIds.delete(id)
        reject(new Error('OMP RPC process stdin is unavailable'))
        return
      }
      armOmpRpcResponseDeadline(this.pendingResponses, id, pending)
    })
  }

  /** Raw stdin write bypassing command correlation — used only to answer an
   *  extension_ui_request by its own `id`, never for a client-initiated command. */
  private writeRawFrame(frame: OmpRpcExtensionUiResponse): boolean {
    if (this.isDisposed || this.processExit.hasExited) {
      return false
    }
    return this.transport.write(frame)
  }

  private readonly handleStreamError = (error: Error): void => {
    this.protocolFault(`OMP RPC stream error: ${error.message}`)
  }

  private protocolFault(message: string): void {
    if (this.hasProtocolFault) {
      return
    }
    this.hasProtocolFault = true
    const error = new Error(message)
    this.emit({ kind: 'protocol-fault', message })
    rejectAllOmpRpcPendingResponses(this.pendingResponses, error)
    if (!this.isProtocolV2) {
      this.rejectReady(error)
    }
    // The protocol owner must retire a faulted child: it cannot safely service
    // this pane, but remains a writer until its process has exited.
    this.dispose()
  }

  private emit(event: OmpRpcClientEvent): void {
    this.fanout.emit(event)
  }
}

export function spawnOmpRpcClient(options: OmpRpcSpawnOptions): OmpRpcClient {
  return new OmpRpcClient(options)
}
