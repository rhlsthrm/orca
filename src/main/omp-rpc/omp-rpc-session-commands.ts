import { isAbsolute } from 'node:path'
import type {
  OmpRpcBranchMessage,
  OmpRpcBranchResult,
  OmpRpcCommand,
  OmpRpcCompactionResult,
  OmpRpcCycledModel,
  OmpRpcCycledThinkingLevel,
  OmpRpcExportedHtml,
  OmpRpcFastModeState,
  OmpRpcHandoffResult,
  OmpRpcHistoryMessage,
  OmpRpcHistoryResult,
  OmpRpcInterruptMode,
  OmpRpcLoginProvider,
  OmpRpcLoginResult,
  OmpRpcMessagesPage,
  OmpRpcModel,
  OmpRpcNewSessionResult,
  OmpRpcQueueMode,
  OmpRpcSessionState,
  OmpRpcSessionStats,
  OmpRpcSubagentSnapshot,
  OmpRpcThinkingLevel,
  OmpRpcTodoPhase
} from '../../shared/omp-rpc-protocol'
import type { OmpRpcSubagentSubscriptionLevel } from '../../shared/omp-rpc-subagent-protocol'
import { OMP_RPC_SUBAGENT_SUBSCRIPTION_LEVELS } from '../../shared/omp-rpc-subagent-protocol'
import {
  parseOmpRpcAvailableModels,
  parseOmpRpcBranchMessages,
  parseOmpRpcBranchResult,
  parseOmpRpcCompactionResult,
  parseOmpRpcCycledModel,
  parseOmpRpcCycledThinkingLevel,
  parseOmpRpcExportedHtml,
  parseOmpRpcFastModeState,
  parseOmpRpcHandoffResult,
  parseOmpRpcLoginProviders,
  parseOmpRpcLoginResult,
  parseOmpRpcMessages,
  parseOmpRpcNewSessionResult,
  parseOmpRpcSelectedModel,
  parseOmpRpcSessionStats,
  parseOmpRpcSubagentSnapshots,
  parseOmpRpcTodoPhasesResponse
} from './omp-rpc-command-response-validation'
import {
  isOmpRpcObject,
  parseOmpRpcMessagesPage,
  parseOmpRpcSessionState
} from './omp-rpc-frame-validation'
import { drainOmpRpcHistory } from './omp-rpc-history-page'

type OmpRpcSessionCommandDependencies = {
  whenReady: () => Promise<unknown>
  sendCommand: (command: OmpRpcCommand) => Promise<unknown>
}

export class OmpRpcSessionCommands {
  constructor(private readonly dependencies: OmpRpcSessionCommandDependencies) {}

  readonly getState = async (): Promise<OmpRpcSessionState> => {
    await this.dependencies.whenReady()
    return parseOmpRpcSessionState(await this.dependencies.sendCommand({ type: 'get_state' }))
  }

  readonly getMessagesPage = async (
    options: { cursor?: string; limit?: number } = {}
  ): Promise<OmpRpcMessagesPage> => {
    await this.dependencies.whenReady()
    return parseOmpRpcMessagesPage(
      await this.dependencies.sendCommand({
        type: 'get_messages_page',
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(options.limit === undefined ? {} : { limit: options.limit })
      })
    )
  }

  readonly fetchHistory = (options: { limit?: number } = {}): Promise<OmpRpcHistoryResult> =>
    drainOmpRpcHistory((pageOptions) => this.getMessagesPage(pageOptions), options)

  /** Moves the child onto another session. `sessionPath` is a filesystem PATH,
   *  not a session id: F12 (live-verified against omp 18.0.6) is that upstream
   *  answers a bare id with `success: true` and keeps writing the session it
   *  was already on, so the mistake is invisible on the wire and shows up only
   *  as a pane whose claim no longer matches its child. This is the last point
   *  at which the two are distinguishable, so a relative value is refused here
   *  rather than sent as a no-op frame. */
  readonly switchSession = async (sessionPath: string): Promise<void> => {
    const trimmed = sessionPath.trim()
    if (!trimmed) {
      throw new Error('OMP RPC session path is required')
    }
    if (!isAbsolute(trimmed)) {
      throw new Error(`OMP RPC session path must be absolute, got: ${trimmed}`)
    }
    await this.dependencies.whenReady()
    await this.dependencies.sendCommand({ type: 'switch_session', sessionPath: trimmed })
  }

  /** Reports the level the SERVER selected, read back off its own response,
   *  rather than echoing the requested one: forwarding stays off if the level
   *  did not take, and a caller that assumed otherwise would wait forever for
   *  frames that are never coming. */
  readonly setSubagentSubscription = async (
    level: OmpRpcSubagentSubscriptionLevel
  ): Promise<OmpRpcSubagentSubscriptionLevel> => {
    await this.dependencies.whenReady()
    const data = await this.dependencies.sendCommand({
      type: 'set_subagent_subscription',
      level
    })
    const selected = isOmpRpcObject(data) ? data.level : undefined
    if (
      typeof selected !== 'string' ||
      !OMP_RPC_SUBAGENT_SUBSCRIPTION_LEVELS.includes(selected as OmpRpcSubagentSubscriptionLevel)
    ) {
      throw new Error('OMP RPC subagent subscription response was malformed')
    }
    return selected as OmpRpcSubagentSubscriptionLevel
  }

  readonly abort = async (): Promise<void> => {
    await this.dependencies.whenReady()
    await this.dependencies.sendCommand({ type: 'abort' })
  }

  // ===================================================================
  // Interactive-command verbs
  //
  // Each one is `whenReady` -> one correlated command -> one strict reader,
  // exactly like the four above. The readers live in
  // omp-rpc-command-response-validation.ts and reject a payload this
  // integration cannot read, so a caller either gets the real value or an
  // error — never a half-decoded shape. Wire field names are verbatim
  // upstream (`RpcCommand`): a renamed field is not a compile error over a
  // JSONL transport, it is a silent no-op that answers success.
  // ===================================================================

  readonly getAvailableModels = async (): Promise<OmpRpcModel[]> => {
    await this.dependencies.whenReady()
    return parseOmpRpcAvailableModels(
      await this.dependencies.sendCommand({ type: 'get_available_models' })
    )
  }

  /** Resolves with the model the CHILD selected, read off its response — the
   *  requested pair is only a request, and an unknown one is an error upstream
   *  rather than a partial switch. */
  readonly setModel = async (selection: {
    provider: string
    modelId: string
  }): Promise<OmpRpcModel> => {
    const provider = selection.provider.trim()
    const modelId = selection.modelId.trim()
    if (!provider || !modelId) {
      throw new Error('OMP RPC model selection requires a provider and a model id')
    }
    await this.dependencies.whenReady()
    return parseOmpRpcSelectedModel(
      await this.dependencies.sendCommand({ type: 'set_model', provider, modelId })
    )
  }

  readonly cycleModel = async (): Promise<OmpRpcCycledModel> => {
    await this.dependencies.whenReady()
    return parseOmpRpcCycledModel(await this.dependencies.sendCommand({ type: 'cycle_model' }))
  }

  readonly setThinkingLevel = async (level: OmpRpcThinkingLevel): Promise<void> => {
    await this.dependencies.whenReady()
    await this.dependencies.sendCommand({ type: 'set_thinking_level', level })
  }

  readonly cycleThinkingLevel = async (): Promise<OmpRpcCycledThinkingLevel> => {
    await this.dependencies.whenReady()
    return parseOmpRpcCycledThinkingLevel(
      await this.dependencies.sendCommand({ type: 'cycle_thinking_level' })
    )
  }

  readonly setSteeringMode = async (mode: OmpRpcQueueMode): Promise<void> => {
    await this.dependencies.whenReady()
    await this.dependencies.sendCommand({ type: 'set_steering_mode', mode })
  }

  readonly setFollowUpMode = async (mode: OmpRpcQueueMode): Promise<void> => {
    await this.dependencies.whenReady()
    await this.dependencies.sendCommand({ type: 'set_follow_up_mode', mode })
  }

  readonly setInterruptMode = async (mode: OmpRpcInterruptMode): Promise<void> => {
    await this.dependencies.whenReady()
    await this.dependencies.sendCommand({ type: 'set_interrupt_mode', mode })
  }

  readonly setFastMode = async (enabled: boolean): Promise<OmpRpcFastModeState> => {
    await this.dependencies.whenReady()
    return parseOmpRpcFastModeState(
      await this.dependencies.sendCommand({ type: 'set_fast_mode', enabled })
    )
  }

  readonly compact = async (
    options: { customInstructions?: string } = {}
  ): Promise<OmpRpcCompactionResult> => {
    await this.dependencies.whenReady()
    return parseOmpRpcCompactionResult(
      await this.dependencies.sendCommand({
        type: 'compact',
        ...(options.customInstructions === undefined
          ? {}
          : { customInstructions: options.customInstructions })
      })
    )
  }

  readonly setAutoCompaction = async (enabled: boolean): Promise<void> => {
    await this.dependencies.whenReady()
    await this.dependencies.sendCommand({ type: 'set_auto_compaction', enabled })
  }

  readonly setAutoRetry = async (enabled: boolean): Promise<void> => {
    await this.dependencies.whenReady()
    await this.dependencies.sendCommand({ type: 'set_auto_retry', enabled })
  }

  readonly abortRetry = async (): Promise<void> => {
    await this.dependencies.whenReady()
    await this.dependencies.sendCommand({ type: 'abort_retry' })
  }

  /** Rewinds to `entryId`, which MUST come from `getBranchMessages` — upstream
   *  throws on an entry that is not a user message. Moves the child's session. */
  readonly branch = async (entryId: string): Promise<OmpRpcBranchResult> => {
    const trimmed = entryId.trim()
    if (!trimmed) {
      throw new Error('OMP RPC branch requires an entry id')
    }
    await this.dependencies.whenReady()
    return parseOmpRpcBranchResult(
      await this.dependencies.sendCommand({ type: 'branch', entryId: trimmed })
    )
  }

  readonly getBranchMessages = async (): Promise<OmpRpcBranchMessage[]> => {
    await this.dependencies.whenReady()
    return parseOmpRpcBranchMessages(
      await this.dependencies.sendCommand({ type: 'get_branch_messages' })
    )
  }

  /** Trimmed before it leaves, because upstream answers an empty name with an
   *  error rather than a no-op and a whitespace-only rename is that case. */
  readonly setSessionName = async (name: string): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      throw new Error('OMP RPC session name is required')
    }
    await this.dependencies.whenReady()
    await this.dependencies.sendCommand({ type: 'set_session_name', name: trimmed })
  }

  /** Refused upstream while a response is in progress. Moves the child's
   *  session. */
  readonly handoff = async (
    options: { customInstructions?: string } = {}
  ): Promise<OmpRpcHandoffResult> => {
    await this.dependencies.whenReady()
    return parseOmpRpcHandoffResult(
      await this.dependencies.sendCommand({
        type: 'handoff',
        ...(options.customInstructions === undefined
          ? {}
          : { customInstructions: options.customInstructions })
      })
    )
  }

  /** Moves the child's session. */
  readonly newSession = async (
    options: { parentSession?: string } = {}
  ): Promise<OmpRpcNewSessionResult> => {
    await this.dependencies.whenReady()
    return parseOmpRpcNewSessionResult(
      await this.dependencies.sendCommand({
        type: 'new_session',
        ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession })
      })
    )
  }

  readonly getSessionStats = async (): Promise<OmpRpcSessionStats> => {
    await this.dependencies.whenReady()
    return parseOmpRpcSessionStats(
      await this.dependencies.sendCommand({ type: 'get_session_stats' })
    )
  }

  readonly exportHtml = async (
    options: { outputPath?: string } = {}
  ): Promise<OmpRpcExportedHtml> => {
    await this.dependencies.whenReady()
    return parseOmpRpcExportedHtml(
      await this.dependencies.sendCommand({
        type: 'export_html',
        ...(options.outputPath === undefined ? {} : { outputPath: options.outputPath })
      })
    )
  }

  readonly getLoginProviders = async (): Promise<OmpRpcLoginProvider[]> => {
    await this.dependencies.whenReady()
    return parseOmpRpcLoginProviders(
      await this.dependencies.sendCommand({ type: 'get_login_providers' })
    )
  }

  /** The OAuth URL and any code prompt arrive as `extension_ui_request`
   *  frames while this is in flight, so the caller must already be answering
   *  them; upstream's own input timeout (600s) is the only other bound. */
  readonly login = async (providerId: string): Promise<OmpRpcLoginResult> => {
    const trimmed = providerId.trim()
    if (!trimmed) {
      throw new Error('OMP RPC login requires a provider id')
    }
    await this.dependencies.whenReady()
    return parseOmpRpcLoginResult(
      await this.dependencies.sendCommand({ type: 'login', providerId: trimmed })
    )
  }

  /** The child's whole unpaged message list. `fetchHistory` is the paged walk
   *  and the right default; this is for a caller whose cursors were just
   *  invalidated (a branch or a session move). */
  readonly getMessages = async (): Promise<OmpRpcHistoryMessage[]> => {
    await this.dependencies.whenReady()
    return parseOmpRpcMessages(await this.dependencies.sendCommand({ type: 'get_messages' }))
  }

  readonly getSubagents = async (): Promise<OmpRpcSubagentSnapshot[]> => {
    await this.dependencies.whenReady()
    return parseOmpRpcSubagentSnapshots(
      await this.dependencies.sendCommand({ type: 'get_subagents' })
    )
  }

  /** Resolves with the phases the child is holding afterwards, read off its
   *  own response rather than echoing the request. */
  readonly setTodos = async (phases: OmpRpcTodoPhase[]): Promise<OmpRpcTodoPhase[]> => {
    await this.dependencies.whenReady()
    return parseOmpRpcTodoPhasesResponse(
      await this.dependencies.sendCommand({ type: 'set_todos', phases })
    )
  }
}
