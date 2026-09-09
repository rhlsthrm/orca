import type {
  OmpRpcChatAbortArgs,
  OmpRpcChatAcquireArgs,
  OmpRpcChatAcquireResult,
  OmpRpcChatBranchArgs,
  OmpRpcChatClaimedHandback,
  OmpRpcChatClaimPendingHandbacksArgs,
  OmpRpcChatCommandResult,
  OmpRpcChatCustomInstructionsArgs,
  OmpRpcChatExportHtmlArgs,
  OmpRpcChatFetchHistoryArgs,
  OmpRpcChatFetchHistoryResult,
  OmpRpcChatHandbackPayload,
  OmpRpcChatHasSessionArgs,
  OmpRpcChatHasSessionResult,
  OmpRpcChatListResumableSessionsArgs,
  OmpRpcChatLoginArgs,
  OmpRpcChatNewSessionArgs,
  OmpRpcChatPaneArgs,
  OmpRpcChatReleaseArgs,
  OmpRpcChatReleaseResult,
  OmpRpcChatResolveSessionIdentityArgs,
  OmpRpcChatResolveSessionIdentityResult,
  OmpRpcChatResumableSession,
  OmpRpcChatRespondExtensionUiArgs,
  OmpRpcChatSendArgs,
  OmpRpcChatSendResult,
  OmpRpcChatSetEnabledArgs,
  OmpRpcChatSetInterruptModeArgs,
  OmpRpcChatSetModelArgs,
  OmpRpcChatSetQueueModeArgs,
  OmpRpcChatSetSessionNameArgs,
  OmpRpcChatSetThinkingLevelArgs,
  OmpRpcChatSetTodosArgs,
  OmpRpcChatSubscribeArgs,
  OmpRpcChatSettleHandbackArgs,
  OmpRpcChatSwitchSessionArgs
} from '../../shared/omp-rpc-chat-ipc-contract'
import type {
  OmpRpcBranchMessage,
  OmpRpcBranchResult,
  OmpRpcClientEvent,
  OmpRpcCompactionResult,
  OmpRpcCycledModel,
  OmpRpcCycledThinkingLevel,
  OmpRpcExportedHtml,
  OmpRpcFastModeState,
  OmpRpcHandoffResult,
  OmpRpcHistoryMessage,
  OmpRpcLoginProvider,
  OmpRpcLoginResult,
  OmpRpcModel,
  OmpRpcNewSessionResult,
  OmpRpcSessionState,
  OmpRpcSessionStats,
  OmpRpcSubagentSnapshot,
  OmpRpcTodoPhase
} from '../../shared/omp-rpc-protocol'

export type OmpRpcChatApi = {
  /** Resolves a pane's OMP session identity from OMP's own on-disk state
   *  (terminal breadcrumb, then newest-by-mtime cwd bucket) — bypasses the
   *  broken agent-status hook chain. Null means nothing to resume. */
  resolveSessionIdentity: (
    args: OmpRpcChatResolveSessionIdentityArgs
  ) => Promise<OmpRpcChatResolveSessionIdentityResult>
  /** Proof-gated acquisition of RPC ownership for a pane's OMP session.
   *  Fail-closed: `ok:false` means the caller must keep today's PTY behavior. */
  acquire: (args: OmpRpcChatAcquireArgs) => Promise<OmpRpcChatAcquireResult>
  /** Whether main still holds an RPC session for this pane — what lets a
   *  restarted renderer re-engage a pane whose PTY binding acquisition already
   *  cleared, instead of leaving the child with no owner (XLR-R6-004). */
  hasSession: (args: OmpRpcChatHasSessionArgs) => Promise<OmpRpcChatHasSessionResult>
  /** Always disposes the RPC child if one is held for this pane. */
  release: (args: OmpRpcChatReleaseArgs) => Promise<OmpRpcChatReleaseResult>
  /** Drains the owned session's paged history for reconnect hydration, decoded
   *  into the same message shape the transcript reader produces. Fail-closed:
   *  `session-busy` is retry-once-idle, `unavailable` degrades to transcript
   *  only. */
  fetchHistory: (args: OmpRpcChatFetchHistoryArgs) => Promise<OmpRpcChatFetchHistoryResult>
  send: (args: OmpRpcChatSendArgs) => Promise<OmpRpcChatSendResult>
  abort: (args: OmpRpcChatAbortArgs) => Promise<OmpRpcChatSendResult>
  respondExtensionUi: (args: OmpRpcChatRespondExtensionUiArgs) => Promise<boolean>
  /** Start receiving turn-lifecycle frames for an already-acquired pane.
   *  Returns an unsubscribe fn that closes the watcher (nativeChat.subscribe
   *  pattern: ipcMain.on + webContents.send, listener-based unsubscribe here). */
  subscribe: (
    args: OmpRpcChatSubscribeArgs,
    onEvent: (event: OmpRpcClientEvent) => void
  ) => () => void
  /** Pushed once a `release({ respawn })` genuinely settles+exits (Critical
   *  B, wave 5) — a durable listener (TerminalPane, via
   *  use-omp-rpc-chat-handback-listener.ts) performs the actual PTY
   *  respawn, since the hook that requested release may already be
   *  unmounted by the time this arrives. Not scoped like `subscribe`: every
   *  window listens and filters by `paneKey` itself. */
  onHandback: (onEvent: (payload: OmpRpcChatHandbackPayload) => void) => () => void
  /** Takes the hand-backs main retained for this tab's panes — the consume that
   *  authorizes a respawn (XLR-R7-001). `onHandback` is only a nudge: a
   *  completed release must not lose the pane's PTY just because the requesting
   *  renderer reloaded, so the durable listener claims on mount as well. */
  claimPendingHandbacks: (
    args: OmpRpcChatClaimPendingHandbacksArgs
  ) => Promise<OmpRpcChatClaimedHandback[]>
  /** Reports what became of a leased hand-back (XLR-R8-001). Until this says a
   *  respawn happened, main keeps the instruction, so a reload or a rejected
   *  `pty.spawn` leaves the pane recoverable by the next mount's claim. */
  settleHandback: (args: OmpRpcChatSettleHandbackArgs) => Promise<void>

  // ===================================================================
  // Interactive-command surface
  //
  // Every one of these is issued against the session the pane ALREADY owns:
  // the pane key is the whole authorization, main refuses a key its registry
  // does not hold, and nothing here can acquire, transfer or widen ownership.
  // All fail closed into `OmpRpcChatCommandResult` — an unowned pane, a
  // rejected wire command, a payload main could not validate and an unreadable
  // post-command session identity all arrive as `ok:false` with a reason, so a
  // card never has to distinguish a throw from a refusal.
  //
  // Nothing here synthesizes data OMP did not send. A surface that needs a
  // list no verb below provides has no backing verb and is out of scope.
  // ===================================================================

  /** The child's live selection and toggle state — what a picker highlights
   *  and a toggle displays. Every interactive field is optional: absent means
   *  OMP sent nothing this reader could trust, which is NOT `false`. */
  getState: (args: OmpRpcChatPaneArgs) => Promise<OmpRpcChatCommandResult<OmpRpcSessionState>>
  /** The model picker's rows. */
  getAvailableModels: (args: OmpRpcChatPaneArgs) => Promise<OmpRpcChatCommandResult<OmpRpcModel[]>>
  /** `provider`/`modelId` must come from a `getAvailableModels` row; resolves
   *  with the model the child selected, not the one requested. */
  setModel: (args: OmpRpcChatSetModelArgs) => Promise<OmpRpcChatCommandResult<OmpRpcModel>>
  /** `data: null` means there was nothing to cycle to. */
  cycleModel: (args: OmpRpcChatPaneArgs) => Promise<OmpRpcChatCommandResult<OmpRpcCycledModel>>
  setThinkingLevel: (args: OmpRpcChatSetThinkingLevelArgs) => Promise<OmpRpcChatCommandResult<void>>
  /** `data: null` means the current model cannot reason. */
  cycleThinkingLevel: (
    args: OmpRpcChatPaneArgs
  ) => Promise<OmpRpcChatCommandResult<OmpRpcCycledThinkingLevel>>
  setSteeringMode: (args: OmpRpcChatSetQueueModeArgs) => Promise<OmpRpcChatCommandResult<void>>
  setFollowUpMode: (args: OmpRpcChatSetQueueModeArgs) => Promise<OmpRpcChatCommandResult<void>>
  setInterruptMode: (args: OmpRpcChatSetInterruptModeArgs) => Promise<OmpRpcChatCommandResult<void>>
  /** `active` is the half that says whether the model could actually serve it. */
  setFastMode: (
    args: OmpRpcChatSetEnabledArgs
  ) => Promise<OmpRpcChatCommandResult<OmpRpcFastModeState>>
  /** Runs the child's summarizer: minutes, not milliseconds, and deliberately
   *  exempt from the correlated-response deadline. */
  compact: (
    args: OmpRpcChatCustomInstructionsArgs
  ) => Promise<OmpRpcChatCommandResult<OmpRpcCompactionResult>>
  setAutoCompaction: (args: OmpRpcChatSetEnabledArgs) => Promise<OmpRpcChatCommandResult<void>>
  /** Write-only by necessity: `get_state` carries no `autoRetryEnabled`, so
   *  there is no verb that reads this setting back. A card that claims to show
   *  the current value would be guessing. */
  setAutoRetry: (args: OmpRpcChatSetEnabledArgs) => Promise<OmpRpcChatCommandResult<void>>
  abortRetry: (args: OmpRpcChatPaneArgs) => Promise<OmpRpcChatCommandResult<void>>
  /** The branch picker's rows: the user messages this session can rewind to. */
  getBranchMessages: (
    args: OmpRpcChatPaneArgs
  ) => Promise<OmpRpcChatCommandResult<OmpRpcBranchMessage[]>>
  /** Rewinds to a `getBranchMessages` entry. MOVES the child's session, so main
   *  reconciles the pane's claim before this resolves; `cancelled` means the
   *  child declined and `text` is then meaningless. */
  branch: (args: OmpRpcChatBranchArgs) => Promise<OmpRpcChatCommandResult<OmpRpcBranchResult>>
  setSessionName: (args: OmpRpcChatSetSessionNameArgs) => Promise<OmpRpcChatCommandResult<void>>
  /** Writes a handoff document and resets the agent. Refused upstream while a
   *  response is in progress. MOVES the child's session. */
  handoff: (
    args: OmpRpcChatCustomInstructionsArgs
  ) => Promise<OmpRpcChatCommandResult<OmpRpcHandoffResult>>
  /** MOVES the child's session. */
  newSession: (
    args: OmpRpcChatNewSessionArgs
  ) => Promise<OmpRpcChatCommandResult<OmpRpcNewSessionResult>>
  /** The session dashboard's numbers. */
  getSessionStats: (
    args: OmpRpcChatPaneArgs
  ) => Promise<OmpRpcChatCommandResult<OmpRpcSessionStats>>
  /** Resolves with the file the child actually wrote. */
  exportHtml: (
    args: OmpRpcChatExportHtmlArgs
  ) => Promise<OmpRpcChatCommandResult<OmpRpcExportedHtml>>
  /** The login picker's rows. */
  getLoginProviders: (
    args: OmpRpcChatPaneArgs
  ) => Promise<OmpRpcChatCommandResult<OmpRpcLoginProvider[]>>
  /** Drives an OAuth flow: the URL and any code prompt arrive as
   *  `extension-ui-request` events on `subscribe`, so a caller MUST already be
   *  answering those through `respondExtensionUi` or the login stalls until
   *  upstream's own 600s input timeout. */
  login: (args: OmpRpcChatLoginArgs) => Promise<OmpRpcChatCommandResult<OmpRpcLoginResult>>
  /** The child's whole unpaged message list. `fetchHistory` is the paged walk
   *  and the right default; this is for a caller whose cursors were just
   *  invalidated by a branch or a session move. */
  getMessages: (
    args: OmpRpcChatPaneArgs
  ) => Promise<OmpRpcChatCommandResult<OmpRpcHistoryMessage[]>>
  /** Point-in-time subagent roster, the pull equivalent of the forwarded
   *  subagent frame stream. */
  getSubagents: (
    args: OmpRpcChatPaneArgs
  ) => Promise<OmpRpcChatCommandResult<OmpRpcSubagentSnapshot[]>>
  /** Resolves with the phases the child is holding afterwards, read off its own
   *  response rather than echoing the request. */
  setTodos: (args: OmpRpcChatSetTodosArgs) => Promise<OmpRpcChatCommandResult<OmpRpcTodoPhase[]>>

  // ===================================================================
  // Resume surface (`/resume`)
  //
  // NOT the acquire path, deliberately. Re-acquiring a pane releases its
  // existing registration first, and an empty `ptyId` then proves no PTY exit,
  // so the pane would lose RPC ownership AND get no terminal back. These two
  // move the child the pane ALREADY owns, so registry semantics are unchanged.
  // ===================================================================

  /** The `/resume` picker's rows: OMP sessions in this pane's own cwd bucket,
   *  with sessions another pane already claims excluded main-side (switching
   *  onto one would put two writers on it). Never a client call, so it answers
   *  even while the child is streaming. */
  listResumableSessions: (
    args: OmpRpcChatListResumableSessionsArgs
  ) => Promise<OmpRpcChatCommandResult<OmpRpcChatResumableSession[]>>
  /** Moves the child onto another session. MOVES SESSION, so main reconciles
   *  the pane's claim before this resolves. `sessionPath` must be a row's
   *  ABSOLUTE `sessionPath` — a bare session id is refused with `ok:false`
   *  before any frame goes out, because upstream answers one with success and
   *  keeps writing the session it was already on (F12). */
  switchSession: (args: OmpRpcChatSwitchSessionArgs) => Promise<OmpRpcChatCommandResult<void>>
}
