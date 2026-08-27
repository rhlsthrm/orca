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

function appendTextBlock(blocks: NativeChatBlock[], delta: string): NativeChatBlock[] {
  const last = blocks.at(-1)
  if (last?.type === 'text') {
    return [...blocks.slice(0, -1), { type: 'text', text: last.text + delta }]
  }
  return [...blocks, { type: 'text', text: delta }]
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

function reduceExtensionUiRequest(
  state: OmpRpcTurnState,
  request: OmpRpcExtensionUiRequestFrame
): OmpRpcTurnState {
  if (request.method === 'cancel') {
    return dismissExtensionUiRequest(state, request.id)
  }
  if (!CARD_METHODS.has(request.method)) {
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
          assistantText: state.assistantText + delta,
          blocks: appendTextBlock(state.blocks, delta)
        }
      }
      if (
        assistantMessageEvent.type === 'thinking_delta' &&
        typeof assistantMessageEvent.delta === 'string'
      ) {
        return { ...state, reasoningText: state.reasoningText + assistantMessageEvent.delta }
      }
      return state
    }
    case 'tool-execution-start': {
      const name = event.frame.toolName ?? 'tool'
      return {
        ...state,
        blocks: [...state.blocks, { type: 'tool-call', name, input: event.frame.input }]
      }
    }
    case 'tool-execution-end': {
      const output =
        typeof event.frame.content === 'string'
          ? event.frame.content
          : JSON.stringify(event.frame.content ?? '')
      return {
        ...state,
        blocks: [
          ...state.blocks,
          { type: 'tool-result', output, isError: event.frame.isError === true }
        ]
      }
    }
    case 'extension-ui-request':
      return reduceExtensionUiRequest(state, event.frame)
    // Why: no-op — these carry nothing this milestone's overlay renders.
    // Transport/session-owner frames (ready/commands/command-output/
    // prompt-result/protocol-fault/exit/session-event/unknown-frame) never
    // reach the reducer as turn actions in the first place.
    case 'message-start':
    case 'message-end':
    case 'turn-start':
    case 'turn-end':
    case 'tool-execution-update':
    case 'ready':
    case 'commands':
    case 'command-output':
    case 'prompt-result':
    case 'protocol-fault':
    case 'exit':
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
 *  i.e. any message/turn frame has been observed since the last reset. Used to
 *  gate D5's "status from frames, not hooks" without a separate flag. */
export function isOmpRpcTurnActive(state: OmpRpcTurnState): boolean {
  return state.status === 'working' || state.assistantText.length > 0 || state.blocks.length > 0
}

/** In-progress overlay messages to render, gated by the same leads-vs-
 *  transcript rule as the hook preview bubble (never double-rendered). Order:
 *  reasoning before the reply, matching how a "thinking" bubble reads before
 *  the assistant's answer. */
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
  const hasContent = state.blocks.length > 0
  const leads =
    state.assistantText.trim().length > 0
      ? nativeChatOverlayLeadsTranscript({
          messages: transcriptMessages,
          overlayText: state.assistantText,
          working
        })
      : working && hasContent
  if (hasContent && leads) {
    messages.push({
      id: OMP_RPC_OVERLAY_ASSISTANT_ID,
      role: 'assistant',
      blocks: state.blocks,
      timestamp: null,
      source: 'rpc'
    })
  }
  return messages
}
