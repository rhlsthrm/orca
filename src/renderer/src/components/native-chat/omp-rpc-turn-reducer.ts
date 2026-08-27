// Pure reducer turning OMP RPC turn-lifecycle events into an in-progress-turn
// overlay for NativeChat. Verified live against omp 18.0.6: the assistant
// `message` object RPC frames carry has NO id corresponding to any transcript
// entry id (transcript entries use their own short hex ids; RPC frames carry
// none at the message level, only `toolCall.id` inside content). Because of
// this, RPC-sourced content is NEVER id-merged into the transcript list (D4) —
// it renders as a separate overlay, generalizing the existing hook-preview
// "leads" suppression (native-chat-streaming.ts) so the overlay disappears the
// instant the transcript already covers it. Double-rendering a turn is not an
// acceptable outcome.
//
// Also verified live: `message_start`/`message_update`/`message_end` frames
// are not assistant-only at the frame-type level — the outgoing user turn is
// also echoed through the same three frame types, with `message.role ===
// 'user'` and no `assistantMessageEvent`. This reducer never needs to filter
// for it: `message_start`/`message_end` are unused (not reducer boundaries —
// `agent_start`/`agent_end` bracket the whole prompt, including any tool-call
// round trips, and are the only reset points), and `message_update`'s
// `assistantMessageEvent` stream is assistant-only by construction.

import type { NativeChatBlock, NativeChatMessage } from '../../../../shared/native-chat-types'
import { nativeChatOverlayLeadsTranscript } from '../../../../shared/native-chat-streaming'
import type {
  OmpRpcClientEvent,
  OmpRpcExtensionUiRequestFrame
} from '../../../../shared/omp-rpc-protocol'

export const OMP_RPC_OVERLAY_ASSISTANT_ID = 'omp-rpc-overlay-assistant'
export const OMP_RPC_OVERLAY_REASONING_ID = 'omp-rpc-overlay-reasoning'

/** Extension-UI methods rendered as an inline card (D7). Every other method
 *  (notify/setStatus/setWidget/setTitle/set_editor_text/open_url/...) is
 *  logged-and-ignored per this milestone's minimal scope. */
const CARD_METHODS = new Set(['select', 'confirm', 'input', 'editor'])

export type OmpRpcTurnStatus = 'idle' | 'working'

export type OmpRpcTurnState = {
  status: OmpRpcTurnStatus
  assistantText: string
  reasoningText: string
  blocks: NativeChatBlock[]
  pendingExtensionUiRequest: OmpRpcExtensionUiRequestFrame | null
  queuedExtensionUiRequests: OmpRpcExtensionUiRequestFrame[]
}

export function createInitialOmpRpcTurnState(): OmpRpcTurnState {
  return {
    status: 'idle',
    assistantText: '',
    reasoningText: '',
    blocks: [],
    pendingExtensionUiRequest: null,
    queuedExtensionUiRequests: []
  }
}

export type OmpRpcTurnAction =
  | { type: 'frame'; event: OmpRpcClientEvent }
  | { type: 'extension-ui-answered'; requestId: string }
  | { type: 'reset' }

/** Byte budget for a single retained tool-result output; a tool that returns
 *  a large file read or command log must not grow renderer state unbounded
 *  (F11). Matches the head/tail-window precedent in
 *  omp-rpc-process-transport.ts's `STDERR_TAIL_BYTES`. */
const TOOL_OUTPUT_MAX_BYTES = 65_536
/** Character budget for the retained overlay text (assistantText/
 *  reasoningText) — one turn's streamed prose is capped to a head/tail
 *  window rather than growing without bound. */
const OVERLAY_TEXT_MAX_CHARS = 32_768
/** Max retained overlay blocks; oldest blocks are dropped once exceeded so a
 *  turn with hundreds of tool calls cannot grow the array unboundedly. */
const OVERLAY_MAX_BLOCKS = 500
const TRUNCATION_MARKER = '\n…[truncated]…\n'

/** Cap a string to a byte/char budget by keeping a head and tail window and
 *  marking the cut, rather than growing without bound (F11). */
function capOverlayText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  const half = Math.floor((maxLength - TRUNCATION_MARKER.length) / 2)
  return text.slice(0, half) + TRUNCATION_MARKER + text.slice(text.length - half)
}

/** Cap the retained block count, dropping the oldest once exceeded. */
function capOverlayBlocks(blocks: NativeChatBlock[]): NativeChatBlock[] {
  return blocks.length > OVERLAY_MAX_BLOCKS
    ? blocks.slice(blocks.length - OVERLAY_MAX_BLOCKS)
    : blocks
}

function appendTextBlock(blocks: NativeChatBlock[], delta: string): NativeChatBlock[] {
  const last = blocks.at(-1)
  if (last?.type === 'text') {
    return capOverlayBlocks([
      ...blocks.slice(0, -1),
      { type: 'text', text: capOverlayText(last.text + delta, OVERLAY_TEXT_MAX_CHARS) }
    ])
  }
  return capOverlayBlocks([...blocks, { type: 'text', text: delta }])
}

function withoutRequest(
  requests: OmpRpcExtensionUiRequestFrame[],
  id: string
): OmpRpcExtensionUiRequestFrame[] {
  return requests.filter((request) => request.id !== id)
}

function dismissExtensionUiRequest(state: OmpRpcTurnState, id: string): OmpRpcTurnState {
  if (state.pendingExtensionUiRequest?.id === id) {
    const [next, ...rest] = state.queuedExtensionUiRequests
    return { ...state, pendingExtensionUiRequest: next ?? null, queuedExtensionUiRequests: rest }
  }
  return {
    ...state,
    queuedExtensionUiRequests: withoutRequest(state.queuedExtensionUiRequests, id)
  }
}

function isActionableExtensionUiRequest(request: OmpRpcExtensionUiRequestFrame): boolean {
  // Why (F6): a `select` whose `options` are absent/empty is a valid frame
  // shape the validator accepts, but it renders zero buttons — promoting it
  // would wedge the pane (the composer is unmounted for a pending request)
  // with no way out. Fall through to log-and-ignore instead.
  if (request.method === 'select') {
    return (request.options ?? []).length > 0
  }
  return true
}

function reduceExtensionUiRequest(
  state: OmpRpcTurnState,
  request: OmpRpcExtensionUiRequestFrame
): OmpRpcTurnState {
  if (request.method === 'cancel') {
    return dismissExtensionUiRequest(state, request.id)
  }
  if (!CARD_METHODS.has(request.method) || !isActionableExtensionUiRequest(request)) {
    // Why: notify/setStatus/setWidget/setTitle/... are log-and-ignore this
    // milestone (scope item 7) — the caller is expected to log, not the reducer.
    return state
  }
  if (!state.pendingExtensionUiRequest) {
    return { ...state, pendingExtensionUiRequest: request }
  }
  if (state.pendingExtensionUiRequest.id === request.id) {
    return state
  }
  return {
    ...state,
    queuedExtensionUiRequests: [
      ...withoutRequest(state.queuedExtensionUiRequests, request.id),
      request
    ]
  }
}

function reduceFrame(state: OmpRpcTurnState, event: OmpRpcClientEvent): OmpRpcTurnState {
  switch (event.kind) {
    case 'agent-start':
      // Why: a fresh prompt/steer/follow_up turn starts a new overlay; without
      // this reset, the previous turn's content would bleed into the next.
      return { ...createInitialOmpRpcTurnState(), status: 'working' }
    case 'agent-end':
      return { ...state, status: event.frame.isTerminal === false ? 'working' : 'idle' }
    case 'message-update': {
      const assistantMessageEvent = event.frame.assistantMessageEvent
      // Why: absent means this is OMP's echo of the user's own turn (no
      // assistant content) — valid and non-fatal, nothing to render, but the
      // stream is live: register 'working' for a turn that starts without an
      // explicit agent_start.
      if (!assistantMessageEvent) {
        return state.status === 'working' ? state : { ...state, status: 'working' }
      }
      // Why: the union's D3 catch-all member (`{type:string} & Record<...>`)
      // widens `.delta` back to `unknown` for TS even after the `type` check,
      // since a literal-typed member and the wide-string fallback both match —
      // the client's frame validator already proved `delta` is a string.
      if (
        assistantMessageEvent.type === 'text_delta' &&
        typeof assistantMessageEvent.delta === 'string'
      ) {
        const delta = assistantMessageEvent.delta
        return {
          ...state,
          status: 'working',
          assistantText: capOverlayText(state.assistantText + delta, OVERLAY_TEXT_MAX_CHARS),
          blocks: appendTextBlock(state.blocks, delta)
        }
      }
      if (
        assistantMessageEvent.type === 'thinking_delta' &&
        typeof assistantMessageEvent.delta === 'string'
      ) {
        return {
          ...state,
          status: 'working',
          reasoningText: capOverlayText(
            state.reasoningText + assistantMessageEvent.delta,
            OVERLAY_TEXT_MAX_CHARS
          )
        }
      }
      return state.status === 'working' ? state : { ...state, status: 'working' }
    }
    case 'tool-execution-start': {
      const name = event.frame.toolName ?? 'tool'
      const toolCallId = event.frame.toolCallId
      return {
        ...state,
        status: 'working',
        blocks: capOverlayBlocks([
          ...state.blocks,
          {
            type: 'tool-call',
            name,
            input: event.frame.input,
            ...(toolCallId ? { toolCallId } : {})
          }
        ])
      }
    }
    case 'tool-execution-end': {
      const rawOutput =
        typeof event.frame.content === 'string'
          ? event.frame.content
          : JSON.stringify(event.frame.content ?? '')
      const output = capOverlayText(rawOutput, TOOL_OUTPUT_MAX_BYTES)
      const toolCallId = event.frame.toolCallId
      return {
        ...state,
        blocks: capOverlayBlocks([
          ...state.blocks,
          {
            type: 'tool-result',
            output,
            isError: event.frame.isError === true,
            ...(toolCallId ? { toolCallId } : {})
          }
        ])
      }
    }
    case 'extension-ui-request':
      return reduceExtensionUiRequest(state, event.frame)
    // Why: the transport is dead — no further frames will arrive for this
    // turn, so it can no longer be "working" (the session hook is
    // responsible for the D1 fallback-to-PTY reaction; see
    // use-omp-rpc-chat-session.ts).
    case 'protocol-fault':
    case 'exit':
      return state.status === 'idle' ? state : { ...state, status: 'idle' }
    // Why: no-op — these carry nothing this milestone's overlay renders.
    case 'message-start':
    case 'message-end':
    case 'turn-start':
    case 'turn-end':
    case 'tool-execution-update':
    case 'ready':
    case 'commands':
    case 'command-output':
    case 'prompt-result':
    case 'session-event':
    case 'unknown-frame':
      return state
  }
}

export function ompRpcTurnReducer(
  state: OmpRpcTurnState,
  action: OmpRpcTurnAction
): OmpRpcTurnState {
  if (action.type === 'reset') {
    return createInitialOmpRpcTurnState()
  }
  if (action.type === 'extension-ui-answered') {
    return dismissExtensionUiRequest(state, action.requestId)
  }
  return reduceFrame(state, action.event)
}

/** True while the RPC frame stream should drive the pane's live chat status —
 *  a lifecycle fact (D5), not a content fact: derived from `status` alone so
 *  it clears the instant a turn ends, even though `assistantText`/`blocks`
 *  deliberately survive past `agent-end` for the leads-vs-transcript compare
 *  in `selectOmpRpcOverlayMessages`. */
export function isOmpRpcTurnActive(state: OmpRpcTurnState): boolean {
  return state.status === 'working'
}

/** toolCallIds already present anywhere in the transcript, so an overlay tool
 *  block that the transcript tailer has already surfaced is never rendered
 *  twice (F8) — checked per block, never as a single all-or-nothing decision
 *  from concatenated text. */
function transcriptToolCallIds(messages: readonly NativeChatMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const block of message.blocks) {
      if ((block.type === 'tool-call' || block.type === 'tool-result') && block.toolCallId) {
        ids.add(block.toolCallId)
      }
    }
  }
  return ids
}

/** In-progress overlay messages to render, gated by the same leads-vs-
 *  transcript rule as the hook preview bubble (never double-rendered). Order:
 *  reasoning before the reply, matching how a "thinking" bubble reads before
 *  the assistant's answer. Text and tool blocks are gated independently
 *  (F8): a tool-first turn (empty assistantText) still shows its in-flight
 *  tool blocks, and a text-length tie against the transcript hides only the
 *  text block, not tool blocks the transcript hasn't caught up to yet. */
export function selectOmpRpcOverlayMessages(
  state: OmpRpcTurnState,
  transcriptMessages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  const working = state.status === 'working'
  const messages: NativeChatMessage[] = []
  if (
    state.reasoningText.trim() &&
    nativeChatOverlayLeadsTranscript({
      messages: transcriptMessages,
      overlayText: state.reasoningText,
      working
    })
  ) {
    messages.push({
      id: OMP_RPC_OVERLAY_REASONING_ID,
      role: 'reasoning',
      blocks: [{ type: 'text', text: state.reasoningText }],
      timestamp: null,
      source: 'rpc'
    })
  }
  const textLeads =
    state.assistantText.trim().length > 0 &&
    nativeChatOverlayLeadsTranscript({
      messages: transcriptMessages,
      overlayText: state.assistantText,
      working
    })
  const knownToolCallIds = transcriptToolCallIds(transcriptMessages)
  const visibleBlocks = working
    ? state.blocks.filter((block) => {
        if (block.type === 'text') {
          return textLeads
        }
        if (block.type === 'tool-call' || block.type === 'tool-result') {
          return !(block.toolCallId && knownToolCallIds.has(block.toolCallId))
        }
        return true
      })
    : []
  if (visibleBlocks.length > 0) {
    messages.push({
      id: OMP_RPC_OVERLAY_ASSISTANT_ID,
      role: 'assistant',
      blocks: visibleBlocks,
      timestamp: null,
      source: 'rpc'
    })
  }
  return messages
}
