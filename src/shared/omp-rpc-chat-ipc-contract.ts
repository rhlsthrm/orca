// IPC-level contract between the renderer and the main-process RPC chat
// session registry (milestone 1: streaming turns over RPC). Separate from
// omp-rpc-protocol.ts (the frozen OMP wire contract) and from
// omp-rpc-ipc-contract.ts (the session-less probe): this file describes only
// the session-scoped acquire/release/send/subscribe surface that crosses
// Orca's IPC boundary. Every handler is fail-closed — never throws across IPC.

import type { NativeChatMessage } from './native-chat-types'
import type {
  OmpRpcClientEvent,
  OmpRpcExtensionUiResponse,
  OmpRpcImageContent,
  OmpRpcInterruptMode,
  OmpRpcQueueMode,
  OmpRpcStreamingBehavior,
  OmpRpcThinkingLevel,
  OmpRpcTodoPhase
} from './omp-rpc-protocol'

/** Resolves an OMP pane's session identity from OMP's own on-disk state
 *  (terminal breadcrumb, then newest-by-mtime cwd bucket) — bypasses the
 *  broken agent-status hook chain entirely (Decision 2,
 *  docs/omp-rpc-chat-adapter-plan.md). Called before `acquire`; a null
 *  result means "nothing to resume" and the caller must not acquire.
 *  `ptyId` is an optional accuracy input (wave 9, Defect 1): a live PTY
 *  needs its terminal breadcrumb or resolves to null; only a missing PTY
 *  (renderer recovery) may use the mtime fallback. `paneKey` scopes the
 *  mtime fallback's already-claimed exclusion set to claims held by other
 *  panes (Defect 2): the asking pane must never be denied its own claim. */
export type OmpRpcChatResolveSessionIdentityArgs = {
  paneKey: string
  ptyId: string | null
  cwd: string
}

export type OmpRpcChatSessionIdentitySource = 'breadcrumb' | 'mtime-fallback'

export type OmpRpcChatResolveSessionIdentityResult = {
  sessionId: string
  source: OmpRpcChatSessionIdentitySource
} | null

export type OmpRpcChatAcquireArgs = {
  paneKey: string
  /** The PTY this pane is handing over, or null when it has none to hand
   *  (XLR-R6-004, cross-lab review): a renderer restarted by Cmd+R or crash
   *  recovery finds the acquisition-created null PTY binding still in place
   *  while main still owns the RPC child, and must be able to adopt or release
   *  it. Absent it, the registry can only REUSE an existing registration for
   *  this pane — the exit-proof gate a fresh spawn needs has no PTY to prove
   *  anything about, so it fails closed. */
  ptyId: string | null
  cwd: string
  sessionFile: string
  /** Optional launch override from the pane's OMP configuration. Older
   *  renderers omit it and main retains the default command behavior. */
  agentCommand?: string
}

/** Whether main still holds an RPC session for this pane. The one question a
 *  restarted renderer cannot answer from its own state, and the gate on
 *  re-engaging a pane whose PTY binding acquisition already cleared
 *  (XLR-R6-004). */
export type OmpRpcChatHasSessionArgs = { paneKey: string }
export type OmpRpcChatHasSessionResult = { sessionFile: string } | null

/** Fail-closed reasons the renderer degrades to PTY+transcript on (D1) —
 *  every one of them means "chat keeps today's behavior", never a crash. */
export type OmpRpcChatAcquireFailureReason =
  | 'live'
  | 'unverifiable'
  /** The pane's PTY is provably exited, but the RPC child main spawned for it
   *  may still be writing the session (XLR-041/XLR-043, cross-lab review). It
   *  must stay distinct from `unverifiable`, which is a verdict on the PTY:
   *  that one entitles the renderer to re-point the pane at the PTY it tried
   *  to kill, and this one is exactly the case where doing so binds the pane
   *  to a dead terminal — while a respawn would add a second writer. */
  | 'rpc-child-unverifiable'
  | 'conflict'
  | 'spawn-failed'
  | 'executable-not-found'

export type OmpRpcChatAcquireResult =
  | { ok: true }
  | { ok: false; reason: OmpRpcChatAcquireFailureReason }

/** Present when the caller (the acquire effect's cleanup, on unmount) wants
 *  a PTY respawned into the exact same pane once release actually settles
 *  and exits — never on a fail-closed release that keeps the claim. Only
 *  echoed back via the `ompRpcChat:handback` push event, never itself
 *  driving the respawn on the main side (Critical B: main owns the
 *  settle-wait and release ordering; the renderer's always-mounted
 *  TerminalPane drives the actual `pty.spawn`, not this hook). */
export type OmpRpcChatHandbackRespawnContext = {
  replacedPtyId: string
  cwd: string
  sessionId: string
}

export type OmpRpcChatReleaseArgs = { paneKey: string; respawn?: OmpRpcChatHandbackRespawnContext }
export type OmpRpcChatReleaseResult = { released: boolean }

/** `idle`/`steer`/`followUp` pick the wire verb for a chat message.
 *  `command` is the slash-command route: it pins the `prompt` verb, because
 *  upstream only `prompt` runs a builtin or skill slash command
 *  (`rpc-mode.ts` calls `tryRunRpcSkillCommand`/`executeAcpBuiltinSlashCommand`
 *  from `case "prompt"` alone) — `steer` and `follow_up` deliver the text to
 *  the model verbatim. */
export type OmpRpcChatSendBehavior = 'idle' | OmpRpcStreamingBehavior | 'command'

export type OmpRpcChatSendArgs = {
  paneKey: string
  message: string
  images?: OmpRpcImageContent[]
  behavior: OmpRpcChatSendBehavior
  /** The wire `id` to send a `prompt` under. The command route supplies its own
   *  capture-slot id so OMP's later `prompt_result` echo (which is the only
   *  authoritative "no agent ran" word) can be attributed to that run and to no
   *  other. Only meaningful for the `prompt` verbs; ignored by steer/follow_up,
   *  which produce no such frame. */
  requestId?: string
}

export type OmpRpcChatSendResult =
  | { ok: true; agentInvoked: boolean }
  | { ok: false; reason: string }

/** Reconnect history hydration for an RPC-owned pane. `limit` is the page size
 *  of the underlying `get_messages_page` walk, not a cap on the result: the
 *  drain always covers the whole snapshot, because a partial walk cannot be
 *  spliced onto a later one without gaps or duplicates. */
export type OmpRpcChatFetchHistoryArgs = { paneKey: string; limit?: number }

/** `session-busy` is upstream refusing to page while streaming or compacting —
 *  a retry-once-idle outcome, distinct from `unavailable` (no owned session, or
 *  a walk that could not be completed), which the caller degrades on (D1). */
export type OmpRpcChatFetchHistoryFailureReason = 'session-busy' | 'unavailable'

export type OmpRpcChatFetchHistoryResult =
  | { ok: true; messages: NativeChatMessage[]; totalMessages: number }
  | { ok: false; reason: OmpRpcChatFetchHistoryFailureReason }

export type OmpRpcChatAbortArgs = { paneKey: string }

export type OmpRpcChatRespondExtensionUiArgs = {
  paneKey: string
  response: OmpRpcExtensionUiResponse
}

/** Result envelope for every interactive-command verb (`ompRpcChat:setModel`,
 *  `ompRpcChat:getAvailableModels`, ...). Fail-closed on the same terms as
 *  `send`: an unowned pane, a rejected wire command, a payload main could not
 *  validate, and an unreadable post-command session identity all arrive as
 *  `ok:false` with the reason, never as a throw across IPC and never as a
 *  half-decoded value. `data` is the verb's own validated payload — verbs
 *  upstream answers with no `data` carry `void`. */
export type OmpRpcChatCommandResult<T> = { ok: true; data: T } | { ok: false; reason: string }

/** The single wording every pane-scoped channel refuses an unheld pane with.
 *  It lives in the contract rather than in one handler module because two
 *  handlers now produce it (the interactive-command family and the resume
 *  enumerator, which cannot import from that family without a cycle), and a
 *  renderer that renders one message per refusal class needs them identical. */
export const OMP_RPC_CHAT_NO_OWNED_SESSION_REASON = 'no RPC-owned session for this pane'

/** Every interactive command is issued against the session the pane ALREADY
 *  owns, so the pane key is the whole authorization: main resolves it in its
 *  own registry and refuses anything it does not hold. No verb here can
 *  acquire, transfer or widen ownership. */
export type OmpRpcChatPaneArgs = { paneKey: string }

/** `provider` + `modelId` are matched against the child's own catalog
 *  upstream; both come from a `getAvailableModels` row, never from user text. */
export type OmpRpcChatSetModelArgs = OmpRpcChatPaneArgs & { provider: string; modelId: string }

export type OmpRpcChatSetThinkingLevelArgs = OmpRpcChatPaneArgs & { level: OmpRpcThinkingLevel }

/** Shared by `setSteeringMode` and `setFollowUpMode` — upstream takes the same
 *  two-member union for both queues. */
export type OmpRpcChatSetQueueModeArgs = OmpRpcChatPaneArgs & { mode: OmpRpcQueueMode }

export type OmpRpcChatSetInterruptModeArgs = OmpRpcChatPaneArgs & { mode: OmpRpcInterruptMode }

/** Shared by the three boolean toggles (`setFastMode`, `setAutoCompaction`,
 *  `setAutoRetry`). */
export type OmpRpcChatSetEnabledArgs = OmpRpcChatPaneArgs & { enabled: boolean }

/** Shared by `compact` and `handoff`: both take optional summarizer guidance. */
export type OmpRpcChatCustomInstructionsArgs = OmpRpcChatPaneArgs & { customInstructions?: string }

/** `entryId` MUST come from a `getBranchMessages` row — upstream throws on an
 *  entry that is not a user message, so there is nothing to synthesize here. */
export type OmpRpcChatBranchArgs = OmpRpcChatPaneArgs & { entryId: string }

export type OmpRpcChatSetSessionNameArgs = OmpRpcChatPaneArgs & { name: string }

export type OmpRpcChatNewSessionArgs = OmpRpcChatPaneArgs & { parentSession?: string }

export type OmpRpcChatExportHtmlArgs = OmpRpcChatPaneArgs & { outputPath?: string }

/** `providerId` comes from a `getLoginProviders` row. */
export type OmpRpcChatLoginArgs = OmpRpcChatPaneArgs & { providerId: string }

export type OmpRpcChatSetTodosArgs = OmpRpcChatPaneArgs & { phases: OmpRpcTodoPhase[] }

/** `sessionPath` is an ABSOLUTE session FILE path, never a bare session id:
 *  upstream answers a bare id with success and keeps writing the session it
 *  was already on (F12), so main refuses a relative value with `ok:false`
 *  instead of sending a frame that silently does nothing. Feed it a
 *  `OmpRpcChatResumableSession.sessionPath`.
 *
 *  This is the `/resume` route: it moves the child the pane ALREADY owns,
 *  which is why it is not the acquire path — re-acquiring releases the pane's
 *  existing registration first, and an empty `ptyId` then proves no PTY exit,
 *  so the pane loses RPC ownership and gets no terminal back. */
export type OmpRpcChatSwitchSessionArgs = OmpRpcChatPaneArgs & { sessionPath: string }

/** Enumeration input for `/resume`. `cwd` scopes the candidate list to the
 *  pane's own worktree bucket; sessions already claimed by ANOTHER pane are
 *  excluded main-side, because switching onto one would put two writers on it. */
export type OmpRpcChatListResumableSessionsArgs = { paneKey: string; cwd: string }

/** One resumable session row.
 *
 *  `sessionPath` is the ABSOLUTE file path `switchSession` takes; `sessionId`
 *  is for display and for correlating against the pane's own current id.
 *
 *  `name` and `startedAt` come from the session file's own header records and
 *  are absent when it carries neither — absent means UNKNOWN, never empty.
 *  There is deliberately no message count: the enumerator reads only a small
 *  header prefix of each candidate file, and counting messages would mean
 *  reading every session in the bucket end to end.
 *
 *  `isCurrent` is computed main-side by comparing `sessionId` against the id
 *  the registry holds for the asking pane. It is trustworthy because the
 *  handler refuses a pane the registry does not hold BEFORE enumerating, so
 *  the pane's own id is always known on the success path — a renderer never
 *  has to guess which row is live. */
export type OmpRpcChatResumableSession = {
  sessionId: string
  sessionPath: string
  name?: string
  /** ISO timestamp from the session header, when it has one. */
  startedAt?: string
  /** Epoch milliseconds, from the stat that also proves the file exists. */
  modifiedAtMs: number
  isCurrent: boolean
}

export type OmpRpcChatSubscribeArgs = { paneKey: string; subscriptionId: string }
export type OmpRpcChatUnsubscribeArgs = { subscriptionId: string }

/** Pushed on `ompRpcChat:event`, filtered by the renderer by `subscriptionId`
 *  (same pattern as `nativeChat:appended`). */
export type OmpRpcChatEventPayload = {
  subscriptionId: string
  event: OmpRpcClientEvent
}

/** Pushed on `ompRpcChat:handback` once a `release({ respawn })` call
 *  genuinely settles+exits (never on a fail-closed release) — a durable,
 *  always-mounted listener (use-omp-rpc-chat-handback-listener.ts, wired
 *  into TerminalPane) performs the actual PTY respawn, since the hook that
 *  requested it may already be unmounted by the time this arrives. The push is
 *  only a NUDGE (XLR-R7-001): main retains the instruction and
 *  `claimPendingHandbacks` is the single consume that authorizes a respawn, so
 *  a renderer that reloaded past the push can still recover its PTY. */
export type OmpRpcChatHandbackPayload = {
  paneKey: string
} & OmpRpcChatHandbackRespawnContext

/** Takes the hand-backs main retained for this tab's panes. Called on every
 *  durable listener's mount as well as on the nudge, because the mount is the
 *  only signal a renderer that missed the push ever produces. */
export type OmpRpcChatClaimPendingHandbacksArgs = { tabId: string }

/** What the preload actually sends. `claimantDocumentId` is minted per page
 *  load there, because the asking `webContents` id cannot identify one claimant
 *  (XLR-R9-001): the same listener claims on mount and again per nudge, so main
 *  would re-lease an outstanding hand-back to a renderer whose respawn is still
 *  in flight. A reload mints a new one, which is what still lets a reloaded
 *  renderer take back the lease its previous document will never settle. */
export type OmpRpcChatClaimPendingHandbacksIpcArgs = OmpRpcChatClaimPendingHandbacksArgs & {
  claimantDocumentId: string
}

/** One leased hand-back. A claim RESERVES the instruction rather than consuming
 *  it (XLR-R8-001): main keeps the payload until `settleHandback` reports a
 *  respawn that actually happened, so a renderer that reloaded, unmounted, or
 *  whose `pty.spawn` rejected leaves the pane recoverable by the next mount
 *  instead of losing the only instruction that recreates its PTY. */
export type OmpRpcChatClaimedHandback = {
  /** Identifies THIS claim. `settleHandback` must present it, so a superseded
   *  claimant's late report can never release an instruction a newer claimant
   *  is still acting on — the single-writer guarantee the take-and-delete used
   *  to provide on its own. */
  token: string
  payload: OmpRpcChatHandbackPayload
}

/** Reports what became of a leased hand-back. `respawned: true` is the only
 *  thing that discards it; anything else returns it to the retained set. */
export type OmpRpcChatSettleHandbackArgs = {
  paneKey: string
  token: string
  respawned: boolean
}
