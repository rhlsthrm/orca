// Interactive-command surface of the OMP JSONL RPC v2 wire contract: the closed
// enums a command SENDS, the per-verb payload/result shapes OMP answers with,
// the request-union members carrying them, and the client verbs they type. Split
// out of ./omp-rpc-protocol.ts — which re-exports every name here, so no import
// site distinguishes the two files — because this surface grows one verb at a
// time while the transport/frame core does not. Field names are verbatim wire
// names, and each member mirrors upstream's `RpcCommand`/`RpcResponse` shapes.

import type { OmpRpcSubagentProgress, OmpRpcSubagentStatus } from './omp-rpc-subagent-protocol'

/** The model half of a `config_update`. Upstream this is the catalog's full
 *  `Model` interface (100+ fields); only the three this integration reads are
 *  typed, the rest passes through — a floor, not a ceiling (D3). */
export type OmpRpcConfigModel = {
  id?: string
  name?: string
  provider?: string
} & Record<string, unknown>

/** OMP's `ThinkingLevel` (packages/agent/src/thinking.ts): the two agent-local
 *  selectors plus the six catalog `Effort` levels, in upstream's own order. The
 *  list is re-declared here — not carried as a bare string like
 *  `config_update.thinkingLevel` — because `set_thinking_level` SENDS one, and
 *  an unrecognized level is rejected upstream rather than clamped. */
export const OMP_RPC_THINKING_LEVELS = [
  'inherit',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const
export type OmpRpcThinkingLevel = (typeof OMP_RPC_THINKING_LEVELS)[number]

/** What `cycle_thinking_level` answers with: a catalog `Effort`, which is the
 *  thinking-level list MINUS `inherit`/`off` — cycling never lands on either. */
export const OMP_RPC_THINKING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const
export type OmpRpcThinkingEffort = (typeof OMP_RPC_THINKING_EFFORTS)[number]

/** How the steering and follow-up queues drain one turn's worth of messages. */
export const OMP_RPC_QUEUE_MODES = ['all', 'one-at-a-time'] as const
export type OmpRpcQueueMode = (typeof OMP_RPC_QUEUE_MODES)[number]

/** Whether a steer lands mid-turn or waits for the tool call to finish. */
export const OMP_RPC_INTERRUPT_MODES = ['immediate', 'wait'] as const
export type OmpRpcInterruptMode = (typeof OMP_RPC_INTERRUPT_MODES)[number]

/** A catalog `Model` whose IDENTITY fields have been validated. Same upstream
 *  interface as `OmpRpcConfigModel`; the difference is proof, not shape:
 *  `set_model` must echo `provider`/`id` verbatim and a picker row needs
 *  `name`, so a catalog reader proves those three are strings rather than
 *  handing the renderer optionals it cannot act on. `config_update.model`
 *  stays the weaker shape because OMP pushes it unsolicited. */
export type OmpRpcModel = OmpRpcConfigModel & {
  id: string
  name: string
  provider: string
  /** Whether the model reasons at all — a thinking-level picker is meaningless
   *  for one that does not. Absent means OMP sent no trustworthy value, which
   *  is NOT the same as `false`. */
  reasoning?: boolean
  contextWindow?: number | null
}

/** `cycle_model` answers `null` when there is nothing to cycle to (one model,
 *  or no scoped list) — a legitimate outcome, not a failure. */
export type OmpRpcCycledModel = {
  model: OmpRpcModel
  thinkingLevel?: OmpRpcThinkingLevel
  isScoped: boolean
} | null

/** `cycle_thinking_level` answers `null` when the current model cannot reason. */
export type OmpRpcCycledThinkingLevel = { level: OmpRpcThinkingEffort } | null

/** `set_fast_mode` reports both halves back: a model that does not support fast
 *  mode leaves `active` false even though `enabled` took. */
export type OmpRpcFastModeState = { enabled: boolean; active: boolean }

/** `compact`'s payload is upstream's `CompactionResult`; `details`/
 *  `preserveData` are hook-shaped and deliberately not surfaced. */
export type OmpRpcCompactionResult = {
  summary: string
  shortSummary?: string
  firstKeptEntryId: string
  tokensBefore: number
}

/** One branch point: a user message this session can be rewound to. `entryId`
 *  is what `branch` takes. */
export type OmpRpcBranchMessage = { entryId: string; text: string }

/** `branch`'s payload. `cancelled` means the child declined the rewind (a
 *  busy or unbranchable session), and `text` is then meaningless. */
export type OmpRpcBranchResult = { text: string; cancelled: boolean }

/** `handoff`'s payload. `null` means the child produced no handoff document. */
export type OmpRpcHandoffResult = { savedPath?: string } | null

/** `new_session`'s payload. `cancelled` means the child kept the old session. */
export type OmpRpcNewSessionResult = { cancelled: boolean }

/** `export_html`'s payload: the file the child actually wrote. */
export type OmpRpcExportedHtml = { path: string }

/** Context-window usage as OMP computes it (`ContextUsage`). */
export type OmpRpcContextUsage = { tokens: number; contextWindow: number; percent: number }

/** `get_session_stats`'s payload (upstream `SessionStats`). `credits` and
 *  `routedModels` are provider-conditional and absent on most sessions. */
export type OmpRpcSessionStats = {
  sessionId: string
  sessionFile?: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  premiumRequests: number
  cost: number
  credits?: { cost: number; committedCost: number; acuCost: number }
  /** Concrete provider-routed model ids to finalized turn counts. */
  routedModels?: Record<string, number>
  contextUsage?: OmpRpcContextUsage
}

/** One OAuth provider `login` can target. `available` is whether the provider
 *  can be logged into at all; `authenticated` whether it already is. */
export type OmpRpcLoginProvider = {
  id: string
  name: string
  available: boolean
  authenticated: boolean
}

/** `login`'s payload — the provider whose credential was persisted. */
export type OmpRpcLoginResult = { providerId: string }

export const OMP_RPC_TODO_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'abandoned',
  'blocked'
] as const
export type OmpRpcTodoStatus = (typeof OMP_RPC_TODO_STATUSES)[number]

/** `blocker` is upstream's optional note on what a `blocked` task waits for. */
export type OmpRpcTodoItem = { content: string; status: OmpRpcTodoStatus; blocker?: string }
export type OmpRpcTodoPhase = { name: string; tasks: OmpRpcTodoItem[] }

/** `get_subagents`' snapshot rows (upstream `RpcSubagentSnapshot`) — the
 *  point-in-time equivalent of the forwarded subagent frame stream. */
export type OmpRpcSubagentSnapshot = {
  id: string
  index: number
  agent: string
  agentSource: 'bundled' | 'user' | 'project'
  status: OmpRpcSubagentStatus
  description?: string
  task?: string
  assignment?: string
  sessionFile?: string
  lastUpdate: number
  progress?: OmpRpcSubagentProgress
  parentToolCallId?: string
}

/** `get_state`'s payload. The first five fields are load-bearing for ownership
 *  and are validated strictly; everything below them is what the interactive
 *  command surfaces read to render a CURRENT value, and each is optional on
 *  purpose: OMP omits some of them per release and per model, and a reader that
 *  substituted `false` for "OMP said nothing" would make a toggle misreport the
 *  child's real state. Absent therefore means UNKNOWN, never off. */
export type OmpRpcSessionState = {
  sessionFile: string | null
  sessionId: string | null
  isStreaming: boolean
  isCompacting: boolean
  queuedMessageCount: number
  sessionName?: string
  model?: OmpRpcModel
  thinkingLevel?: OmpRpcThinkingLevel
  steeringMode?: OmpRpcQueueMode
  followUpMode?: OmpRpcQueueMode
  interruptMode?: OmpRpcInterruptMode
  autoCompactionEnabled?: boolean
  fastModeEnabled?: boolean
  fastModeActive?: boolean
  messageCount?: number
  todoPhases?: OmpRpcTodoPhase[]
  contextUsage?: OmpRpcContextUsage
}

// Interactive-command surface. Every member below mirrors upstream's
// `RpcCommand` field-for-field (rpc-types.ts): a mistyped or renamed field is
// not a compile error on the wire, it is a silent no-op — OMP's handler reads
// the property it expects, finds undefined, and answers success anyway.
export type OmpRpcInteractiveCommand =
  | { id?: string; type: 'get_available_models' }
  | { id?: string; type: 'set_model'; provider: string; modelId: string }
  | { id?: string; type: 'cycle_model' }
  | { id?: string; type: 'set_thinking_level'; level: OmpRpcThinkingLevel }
  | { id?: string; type: 'cycle_thinking_level' }
  | { id?: string; type: 'set_steering_mode'; mode: OmpRpcQueueMode }
  | { id?: string; type: 'set_follow_up_mode'; mode: OmpRpcQueueMode }
  | { id?: string; type: 'set_interrupt_mode'; mode: OmpRpcInterruptMode }
  | { id?: string; type: 'set_fast_mode'; enabled: boolean }
  | { id?: string; type: 'compact'; customInstructions?: string }
  | { id?: string; type: 'set_auto_compaction'; enabled: boolean }
  | { id?: string; type: 'set_auto_retry'; enabled: boolean }
  | { id?: string; type: 'abort_retry' }
  | { id?: string; type: 'branch'; entryId: string }
  | { id?: string; type: 'get_branch_messages' }
  | { id?: string; type: 'set_session_name'; name: string }
  | { id?: string; type: 'handoff'; customInstructions?: string }
  | { id?: string; type: 'new_session'; parentSession?: string }
  | { id?: string; type: 'get_session_stats' }
  | { id?: string; type: 'export_html'; outputPath?: string }
  | { id?: string; type: 'get_login_providers' }
  | { id?: string; type: 'login'; providerId: string }
  | { id?: string; type: 'get_messages' }
  | { id?: string; type: 'get_subagents' }
  | { id?: string; type: 'set_todos'; phases: OmpRpcTodoPhase[] }

/** Interactive-command verbs. Each resolves with the payload OMP actually
 *  sent, validated: a malformed or absent payload REJECTS rather than
 *  handing a caller an unusable half-shape, because every one of these backs
 *  a picker or a toggle whose whole purpose is to show the child's real
 *  state. A `void` return means upstream answers with no `data` at all —
 *  success is the response frame itself. `get_messages` is the one verb whose
 *  client method is NOT here: it answers with a history shape, so it sits beside
 *  the other history reads on `OmpSessionOwningRpcClient`. */
export type OmpRpcInteractiveCommandClient = {
  getAvailableModels(): Promise<OmpRpcModel[]>
  /** `provider` and `modelId` are matched verbatim against the child's own
   *  catalog upstream; an unknown pair is an error response, never a silent
   *  no-op. Resolves with the model the child selected. */
  setModel(selection: { provider: string; modelId: string }): Promise<OmpRpcModel>
  cycleModel(): Promise<OmpRpcCycledModel>
  setThinkingLevel(level: OmpRpcThinkingLevel): Promise<void>
  cycleThinkingLevel(): Promise<OmpRpcCycledThinkingLevel>
  setSteeringMode(mode: OmpRpcQueueMode): Promise<void>
  setFollowUpMode(mode: OmpRpcQueueMode): Promise<void>
  setInterruptMode(mode: OmpRpcInterruptMode): Promise<void>
  setFastMode(enabled: boolean): Promise<OmpRpcFastModeState>
  /** Runs the child's summarizer, so it can take far longer than a query —
   *  deliberately exempt from the correlated-response deadline. */
  compact(options?: { customInstructions?: string }): Promise<OmpRpcCompactionResult>
  setAutoCompaction(enabled: boolean): Promise<void>
  setAutoRetry(enabled: boolean): Promise<void>
  abortRetry(): Promise<void>
  /** Rewinds the session to `entryId` (from `getBranchMessages`). MOVES the
   *  child's session, which upstream announces on no frame — a caller holding
   *  a session claim must reconcile the identity afterwards. */
  branch(entryId: string): Promise<OmpRpcBranchResult>
  getBranchMessages(): Promise<OmpRpcBranchMessage[]>
  setSessionName(name: string): Promise<void>
  /** Writes a handoff document and resets the agent. Refused upstream while a
   *  response is in progress; MOVES the child's session, and runs a summarizer
   *  (deadline-exempt for the same reason as `compact`). */
  handoff(options?: { customInstructions?: string }): Promise<OmpRpcHandoffResult>
  /** MOVES the child's session. `parentSession` nests the new session under an
   *  existing one. */
  newSession(options?: { parentSession?: string }): Promise<OmpRpcNewSessionResult>
  getSessionStats(): Promise<OmpRpcSessionStats>
  exportHtml(options?: { outputPath?: string }): Promise<OmpRpcExportedHtml>
  getLoginProviders(): Promise<OmpRpcLoginProvider[]>
  /** Drives an OAuth flow: the URL and any code prompt arrive as
   *  `extension_ui_request` frames, so a caller MUST already be answering
   *  those or the login stalls until upstream's own 600s input timeout.
   *  Deadline-exempt for that reason. */
  login(providerId: string): Promise<OmpRpcLoginResult>
  getSubagents(): Promise<OmpRpcSubagentSnapshot[]>
  /** Resolves with the phases the child is actually holding, read back off its
   *  own response rather than echoing the request. */
  setTodos(phases: OmpRpcTodoPhase[]): Promise<OmpRpcTodoPhase[]>
}
