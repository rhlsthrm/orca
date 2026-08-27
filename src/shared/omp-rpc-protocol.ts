// OMP JSONL RPC v2 wire contract (subset Orca consumes), verified against
// omp 18.0.6 and the published rpc-types.d.ts. Shared so desktop main, the
// renderer, and tests validate identically. Field names are verbatim wire names.

/** First frame OMP emits on stdout; protocolVersion is literally 1 pre-negotiation. */
export type OmpRpcReadyFrame = {
  type: 'ready'
  protocolVersion: 1
  supportedProtocolVersions: number[]
  maxFrameBytes: number
  maxReassembledFrameBytes: number
}

/** One entry of the live slash-command catalog. */
export type OmpRpcSlashCommand = {
  name: string
  aliases?: string[]
  description?: string
  input?: { hint?: string }
  subcommands?: { name: string; description?: string; usage?: string }[]
  source?: string
}

/** Server-pushed catalog; also the get_available_commands response payload shape. */
export type OmpRpcAvailableCommandsUpdateFrame = {
  type: 'available_commands_update'
  commands: OmpRpcSlashCommand[]
}

/** Complete output of a slash command (e.g. /usage). Untyped upstream; text is markdown-ish. */
export type OmpRpcCommandOutputFrame = {
  type: 'command_output'
  text: string
}

/** Terminal marker for a prompt: agentInvoked=false means a local command completed
 *  without invoking the model — the UI must not fabricate an assistant turn. */
export type OmpRpcPromptResultFrame = {
  type: 'prompt_result'
  id?: string
  agentInvoked: boolean
}

/** v2 transport chunk for one oversized logical frame (strictly in-order). */
export type OmpRpcChunkFrame = {
  type: 'rpc_chunk'
  chunkId: string
  index: number
  count: number
  byteLength: number
  data: string
}

/** Correlated command response envelope (success and error branches). */
export type OmpRpcResponseFrame = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
  code?: string
}

export type OmpRpcSessionState = {
  sessionFile: string | null
  sessionId: string | null
  isStreaming: boolean
  isCompacting: boolean
  queuedMessageCount: number
}

export type OmpRpcExit = {
  code: number | null
  signal: string | null
}

/** One image attachment on a prompt-like command. Wire shape per rpc.md's
 *  `ImageContent`; only what this integration sends is typed. */
export type OmpRpcImageContent = { type: 'image'; mimeType: string; data: string }

/** How a prompt-like command interacts with an in-progress turn. OMP requires
 *  this on `prompt` while the session is actively streaming (omitted -> the
 *  command fails); `steer`/`follow_up` are its dedicated-verb equivalents. */
export type OmpRpcStreamingBehavior = 'steer' | 'followUp'

/** Raw provider-normalized assistant stream event carried by `message_update`
 *  (field name verified via sdk.md: `event.assistantMessageEvent`). Text and
 *  thinking triplets are typed at byte level; `toolcall_*` member fields beyond
 *  `type` are UNKNOWN in the docs, so they stay optional-tolerant passthrough —
 *  a floor, not a ceiling, per the plan's D3. */
export type OmpRpcAssistantMessageEvent =
  | { type: 'start' }
  | { type: 'text_start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'text_end' }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_end' }
  | ({ type: 'toolcall_start' } & Record<string, unknown>)
  | ({ type: 'toolcall_delta' } & Record<string, unknown>)
  | ({ type: 'toolcall_end' } & Record<string, unknown>)
  | { type: 'image_end' }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse' }
  | { type: 'error'; reason: 'aborted' | 'error' }
  | ({ type: string } & Record<string, unknown>)

/** Turn/agent lifecycle frames. `isTerminal:false` on agent_end means
 *  maintenance/async work will resume the session before it truly settles;
 *  treat only `isTerminal !== false` (absent counts as terminal) as done. */
export type OmpRpcAgentStartFrame = { type: 'agent_start' } & Record<string, unknown>
export type OmpRpcAgentEndFrame = {
  type: 'agent_end'
  messages?: unknown[]
  isTerminal?: boolean
} & Record<string, unknown>
export type OmpRpcTurnStartFrame = { type: 'turn_start' } & Record<string, unknown>
export type OmpRpcTurnEndFrame = { type: 'turn_end' } & Record<string, unknown>

/** Message lifecycle frames wrapping the assistant-message-in-progress. */
export type OmpRpcMessageStartFrame = {
  type: 'message_start'
  message?: unknown
} & Record<string, unknown>
export type OmpRpcMessageUpdateFrame = {
  type: 'message_update'
  assistantMessageEvent: OmpRpcAssistantMessageEvent
  message?: unknown
} & Record<string, unknown>
export type OmpRpcMessageEndFrame = {
  type: 'message_end'
  message?: unknown
} & Record<string, unknown>

/** Tool execution frames. rpc.md names these three types but does not spell
 *  out their byte-level field shape; the closest documented shape is the
 *  extension hook's tool_call/tool_result payload (toolName/toolCallId/input,
 *  content/isError) — typed as a floor, everything else passes through. */
export type OmpRpcToolExecutionStartFrame = {
  type: 'tool_execution_start'
  toolCallId?: string
  toolName?: string
  input?: unknown
} & Record<string, unknown>
export type OmpRpcToolExecutionUpdateFrame = {
  type: 'tool_execution_update'
  toolCallId?: string
} & Record<string, unknown>
export type OmpRpcToolExecutionEndFrame = {
  type: 'tool_execution_end'
  toolCallId?: string
  toolName?: string
  content?: unknown
  isError?: boolean
} & Record<string, unknown>

/** Extension UI sub-protocol: the only surface tool approval / questions /
 *  notifications arrive on (no dedicated approval frame exists). Method-
 *  specific fields are all optional so unhandled methods (notify/setStatus/
 *  setWidget/setTitle/...) still decode for log-and-ignore handling. */
export type OmpRpcExtensionUiRequestFrame = {
  type: 'extension_ui_request'
  id: string
  method: string
  title?: string
  message?: string
  timeout?: number
  options?: string[]
  optionDetails?: { description?: string }[]
} & Record<string, unknown>

/** Client->server reply to an extension_ui_request. Shape depends on the
 *  request's method (select/input/editor use `value`, confirm uses
 *  `confirmed`, cancel/timeout uses `cancelled`). Unknown-id replies are
 *  silently ignored server-side. */
export type OmpRpcExtensionUiResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true; timedOut?: boolean }

/** Frames this integration understands today; everything else stays OmpRpcUnknownFrame. */
export type OmpRpcKnownServerFrame =
  | OmpRpcReadyFrame
  | OmpRpcAvailableCommandsUpdateFrame
  | OmpRpcCommandOutputFrame
  | OmpRpcPromptResultFrame
  | OmpRpcChunkFrame
  | OmpRpcResponseFrame
  | OmpRpcAgentStartFrame
  | OmpRpcAgentEndFrame
  | OmpRpcTurnStartFrame
  | OmpRpcTurnEndFrame
  | OmpRpcMessageStartFrame
  | OmpRpcMessageUpdateFrame
  | OmpRpcMessageEndFrame
  | OmpRpcToolExecutionStartFrame
  | OmpRpcToolExecutionUpdateFrame
  | OmpRpcToolExecutionEndFrame
  | OmpRpcExtensionUiRequestFrame

/** Lossless fallback: an unrecognized-but-parsed JSON frame. Never dropped silently. */
export type OmpRpcUnknownFrame = { type: string } & Record<string, unknown>

export type OmpRpcServerFrame = OmpRpcKnownServerFrame | OmpRpcUnknownFrame

/** Client->server commands consumed by this integration. */
export type OmpRpcCommand =
  | { id?: string; type: 'negotiate_protocol'; protocolVersion: number }
  | { id?: string; type: 'get_available_commands' }
  | { id?: string; type: 'get_state' }
  | { id?: string; type: 'switch_session'; sessionPath: string }
  | {
      id?: string
      type: 'prompt'
      message: string
      images?: OmpRpcImageContent[]
      streamingBehavior?: OmpRpcStreamingBehavior
    }
  | { id?: string; type: 'steer'; message: string; images?: OmpRpcImageContent[] }
  | { id?: string; type: 'follow_up'; message: string; images?: OmpRpcImageContent[] }
  | { id?: string; type: 'abort' }

/** Events the main-process client emits to consumers (IPC layer, tests). */
export type OmpRpcClientEvent =
  | { kind: 'ready'; ready: OmpRpcReadyFrame; negotiatedProtocolVersion: number }
  | { kind: 'commands'; commands: OmpRpcSlashCommand[] }
  | { kind: 'command-output'; text: string }
  | { kind: 'prompt-result'; id?: string; agentInvoked: boolean }
  | { kind: 'agent-start'; frame: OmpRpcAgentStartFrame }
  | { kind: 'agent-end'; frame: OmpRpcAgentEndFrame }
  | { kind: 'turn-start'; frame: OmpRpcTurnStartFrame }
  | { kind: 'turn-end'; frame: OmpRpcTurnEndFrame }
  | { kind: 'message-start'; frame: OmpRpcMessageStartFrame }
  | { kind: 'message-update'; frame: OmpRpcMessageUpdateFrame }
  | { kind: 'message-end'; frame: OmpRpcMessageEndFrame }
  | { kind: 'tool-execution-start'; frame: OmpRpcToolExecutionStartFrame }
  | { kind: 'tool-execution-update'; frame: OmpRpcToolExecutionUpdateFrame }
  | { kind: 'tool-execution-end'; frame: OmpRpcToolExecutionEndFrame }
  | { kind: 'extension-ui-request'; frame: OmpRpcExtensionUiRequestFrame }
  | { kind: 'unknown-frame'; frame: OmpRpcUnknownFrame }
  | { kind: 'session-event'; frame: OmpRpcUnknownFrame }
  | { kind: 'protocol-fault'; message: string }
  | { kind: 'exit'; code: number | null; signal: string | null }

export function isOmpRpcReadyFrame(frame: OmpRpcServerFrame): frame is OmpRpcReadyFrame {
  return frame.type === 'ready'
}

export function isOmpRpcChunkFrame(frame: OmpRpcServerFrame): frame is OmpRpcChunkFrame {
  return frame.type === 'rpc_chunk'
}

/** Launch options for a main-process OMP RPC child. Session-less is the safe
 *  default; owning a real session requires the explicit session-owning mode. */
export type OmpRpcBaseSpawnOptions = {
  executablePath: string
  cwd: string
  extraArgs?: string[]
}

export type OmpRpcSpawnOptions = OmpRpcBaseSpawnOptions &
  (
    | { sessionMode: 'session-owning'; noSession?: never }
    | { sessionMode?: 'session-less'; noSession?: true }
  )

/** Contract between the IPC layer and the concrete client in src/main/omp-rpc/.
 *  The IPC layer codes against this type only. */
export type OmpRpcClientLike = {
  /** Resolves after the ready frame is validated and protocol v2 is negotiated. */
  whenReady(): Promise<{ ready: OmpRpcReadyFrame; negotiatedProtocolVersion: number }>
  /** Correlated get_available_commands; also emitted as a 'commands' event. */
  getCommands(): Promise<OmpRpcSlashCommand[]>
  /** Correlated prompt. For a local command the result carries agentInvoked=false
   *  and any command_output arrives as 'command-output' events before settlement.
   *  `streamingBehavior` is required by OMP while the session is streaming. */
  prompt(
    message: string,
    options?: { images?: OmpRpcImageContent[]; streamingBehavior?: OmpRpcStreamingBehavior }
  ): Promise<{ agentInvoked: boolean }>
  /** Interrupt path: a queued steering message that can affect the in-progress turn. */
  steer(message: string, images?: OmpRpcImageContent[]): Promise<{ agentInvoked: boolean }>
  /** Post-turn path: queued to run only after the current turn settles. */
  followUp(message: string, images?: OmpRpcImageContent[]): Promise<{ agentInvoked: boolean }>
  /** Fire-and-forget reply to an extension_ui_request. False when the transport
   *  cannot accept writes (disposed/exited) — the dialog then simply times out
   *  server-side, which is safe by design (rpc.md: server resolves a default). */
  respondExtensionUi(response: OmpRpcExtensionUiResponse): boolean
  on(listener: (event: OmpRpcClientEvent) => void): () => void
  dispose(): void
}

export type OmpSessionOwningRpcClient = OmpRpcClientLike & {
  getState(): Promise<OmpRpcSessionState>
  switchSession(sessionPath: string): Promise<void>
  abort(): Promise<void>
  whenExited(): Promise<OmpRpcExit>
}
