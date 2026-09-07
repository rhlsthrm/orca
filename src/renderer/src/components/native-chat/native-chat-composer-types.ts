import type { AgentSessionConversationCommand } from '../../../../shared/agent-session-conversation-command'
import type { AgentSessionSlashCommand } from '../../../../shared/agent-session-wire'
import type { AgentType } from '../../../../shared/agent-status-types'
<<<<<<< HEAD
import type {
  OmpRpcChatSendBehavior,
  OmpRpcChatSendResult
} from '../../../../shared/omp-rpc-chat-ipc-contract'
||||||| 8fa1b3c16c
=======
import type { StructuredAgentSessionCommandOutcome } from '../../../../shared/structured-agent-session-composer'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import type {
  OmpRpcChatSendBehavior,
  OmpRpcChatSendResult
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcSlashCommand } from '../../../../shared/omp-rpc-protocol'
import type { OmpRpcChatPaneConsumedFailure } from '../../store/slices/omp-rpc-chat-pane-failure-notice'
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
<<<<<<< HEAD
import type { NativeChatCommandMarkerOutcome } from './native-chat-command-marker'

/** The slice of a pane's RPC chat session the composer needs to route a send
 *  through it (D6). `isOwned:false` keeps every send on the PTY path. */
export type NativeChatComposerOmpRpcBinding = {
  isOwned: boolean
  isTurnWorking: boolean
  send: (args: {
    message: string
    behavior: OmpRpcChatSendBehavior
  }) => Promise<OmpRpcChatSendResult>
||||||| 8fa1b3c16c
=======
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { OmpRpcExecutableCommands } from './omp-rpc-command-catalog'

export type NativeChatOptionPickerRequest = {
  id: string
  sequence: number
}

export type NativeChatStructuredComposerTransport = {
  conversationCommands?: readonly AgentSessionConversationCommand[]
  send: (text: string, attachments: readonly NativeChatComposerImageAttachment[]) => boolean
  dispatchCommand: (text: string) => Promise<StructuredAgentSessionCommandOutcome>
  optionsSurface: SessionOptionsSurface
  optionSnapshot: SessionOptionDescriptor[]
  optionPickerRequest?: NativeChatOptionPickerRequest | null
  /** The `/` surface the running session reports. Absent keeps the curated
   *  per-agent catalog, which is what an older host leaves the client with. */
  sessionCommands?: readonly AgentSessionSlashCommand[]
  worktreeId?: string
  onError: (message: string | null) => void
  runtime: 'local' | 'remote'
  /** The session behind this composer; a real user send relinquishes orchestration ownership. */
  sessionId: string
  /** Owning runtime for that report; null is the local runtime. */
  runtimeEnvironmentId: string | null
}
export type NativeChatComposerOmpRpcBinding = {
  isOwned: boolean
  isTurnWorking: boolean
  send: (args: {
    message: string
    behavior: OmpRpcChatSendBehavior
    /** The wire `id` a command send is correlated under, so its later
     *  `prompt_result` frame can be attributed to that run alone. */
    requestId?: string
    /** The generation the send was dispatched on, checked against the live
     *  session so a queued command cannot land in one that replaced it. */
    expectedGeneration?: number
    /** Run only once the transport's own gates admit the send. */
    onAuthorized?: () => void
  }) => Promise<OmpRpcChatSendResult>
  /** Retires the previous slash command's captured output before the next
   *  one's frames arrive, under the id correlating that run. Absent for a pane
   *  with no RPC session. */
  onCommandDispatched?: (commandRunId: string) => void
  /** Suppresses that captured output once the command's own response reports
   *  it started an agent turn, unless a later run already owns the slot. */
  onCommandAgentInvoked?: (commandRunId: string) => void
  /** Pane-owned failure feedback for a command whose dispatch outlived the
   *  composing surface. Read and cleared by whichever composer remounts. */
  commandFailureMessage?: string | null
  /** That notice describes an already-replaced session, so it yields to a live
   *  one this composer is showing rather than relabelling it. */
  commandFailureSuperseded?: boolean
  /** Distinguishes one notice occurrence from the next, including a repeat
   *  failure whose wording is identical. */
  commandFailureId?: number | null
  clearCommandFailure?: (consumed: OmpRpcChatPaneConsumedFailure) => void
  reportCommandFailure?: (command: string, expectedGeneration?: number) => void
  /** Same, for an ordinary message whose send outlived the composer. */
  reportMessageFailure?: (expectedGeneration: number) => void
  /** What the owning session will actually dispatch, from OMP's published RPC
   *  catalog. Null while no catalog has arrived, which is not permission to
   *  send — the session route needs positive proof. */
  executableCommands?: OmpRpcExecutableCommands | null
  /** The owning session's published catalog, which outranks the cwd-cached
   *  probe snapshot for the `/` menu (see `selectOmpRpcLiveCommands`). */
  commands?: readonly OmpRpcSlashCommand[] | null
  /** Identifies the RPC session bound to the pane, so a completion that
   *  outlives a rebind can be discarded. */
  sessionGeneration?: number
  /** Stable pane-plus-generation identity for the RPC command queue. */
  commandQueueKey?: string
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
}

export type NativeChatComposerProps = {
  /** Tab hosting the agent; used to resolve the live ptyId + runtime settings. */
  terminalTabId: string
  /** Stable split-leaf identity; unlike a PTY id, this survives reconnects. */
  paneKey: string
  /** Specific split-pane PTY this chat view owns. */
  targetPtyId: string | null
  agent: AgentType
  /** Guard desktop sends while a mobile client owns the terminal input lease. */
  canSend?: boolean
  /** True while the hosted TUI reports an in-flight turn; swaps Send to Stop. */
  isWorking?: boolean
  /** Interrupt the hosted agent, usually by sending ESC into the PTY. */
  onStop?: () => void
  /** Render an optimistic echo until the real transcript turn lands. */
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  /** Remove an optimistic echo when its delayed submit is canceled. */
  onOptimisticSendCanceled?: (pendingId: string) => void
  /** Record a dispatched slash command that does not create a chat turn.
   *  `outcome` is present only for commands Orca ran over RPC (OMP `/usage`),
   *  carrying the output to render and whether the model was invoked. */
  onSlashCommand?: (command: string, outcome?: NativeChatCommandMarkerOutcome) => void
  /** Picker-only agent commands continue in the hosted TUI after dispatch. */
  onSwitchToTerminal?: () => void
  /** Reads the hosted TUI's current rendered screen when chat is entered. */
  readTerminalScreen?: () => string | null
  /** The tab's launch seed as this pane sees it. */
  launchSeed?: NativeChatLaunchSeed
  /** Structured journal transport; absent keeps the existing PTY path unchanged. */
  structuredTransport?: NativeChatStructuredComposerTransport
  /** Session-scoped OMP RPC transport; absent keeps the PTY path unchanged. */
  ompRpcChat?: NativeChatComposerOmpRpcBinding
}

/** Launch context prefilled into the TUI input as an unsent draft, plus the two
 *  facts that decide its fate in this pane's composer. */
export type NativeChatLaunchSeed = {
  launchDraft: NativeChatLaunchDraft | null
  /** True once the transcript shows the TUI-side draft was submitted or cleared. */
<<<<<<< HEAD
  launchDraftResolved?: boolean
  /** RPC-owned session binding for this pane (W2-4); omitted keeps every send
   *  on today's PTY keystroke path unchanged. */
  ompRpcChat?: NativeChatComposerOmpRpcBinding
||||||| 8fa1b3c16c
  launchDraftResolved?: boolean
=======
  launchDraftResolved: boolean
  /** False for every pane of a split tab; gates adopting the seed, not cleanup. */
  ownsTabWideLaunchDraft: boolean
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
}

export type NativeChatComposerHandle = {
  focus: () => boolean
  insertTypedText: (text: string) => boolean
  /** Routes pane-level paste events back to the composer field. */
  handlePasteEvent: (event: {
    clipboardData: DataTransfer | null
    preventDefault: () => void
    defaultPrevented: boolean
  }) => void
  /** Pastes clipboard content when no DOM paste event is available. */
  pasteFromClipboard: () => void
}
