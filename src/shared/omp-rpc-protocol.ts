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

/** Frames this integration understands today; everything else stays OmpRpcUnknownFrame. */
export type OmpRpcKnownServerFrame =
  | OmpRpcReadyFrame
  | OmpRpcAvailableCommandsUpdateFrame
  | OmpRpcCommandOutputFrame
  | OmpRpcPromptResultFrame
  | OmpRpcChunkFrame
  | OmpRpcResponseFrame

/** Lossless fallback: an unrecognized-but-parsed JSON frame. Never dropped silently. */
export type OmpRpcUnknownFrame = { type: string } & Record<string, unknown>

export type OmpRpcServerFrame = OmpRpcKnownServerFrame | OmpRpcUnknownFrame

/** Client->server commands consumed by this integration. */
export type OmpRpcCommand =
  | { id?: string; type: 'negotiate_protocol'; protocolVersion: number }
  | { id?: string; type: 'get_available_commands' }
  | { id?: string; type: 'get_state' }
  | { id?: string; type: 'switch_session'; sessionPath: string }
  | { id?: string; type: 'prompt'; message: string }
  | { id?: string; type: 'abort' }

/** Events the main-process client emits to consumers (IPC layer, tests). */
export type OmpRpcClientEvent =
  | { kind: 'ready'; ready: OmpRpcReadyFrame; negotiatedProtocolVersion: number }
  | { kind: 'commands'; commands: OmpRpcSlashCommand[] }
  | { kind: 'command-output'; text: string }
  | { kind: 'prompt-result'; id?: string; agentInvoked: boolean }
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
   *  and any command_output arrives as 'command-output' events before settlement. */
  prompt(message: string): Promise<{ agentInvoked: boolean }>
  on(listener: (event: OmpRpcClientEvent) => void): () => void
  dispose(): void
}

export type OmpSessionOwningRpcClient = OmpRpcClientLike & {
  getState(): Promise<OmpRpcSessionState>
  switchSession(sessionPath: string): Promise<void>
  abort(): Promise<void>
  whenExited(): Promise<OmpRpcExit>
}
