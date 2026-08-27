// Shared derivation for the in-flight "streaming" assistant bubble. While an
// agent works, its hook preview (lastAssistantMessage) is shown as a synthetic
// assistant message so the user sees the reply build in real time, before the
// completed turn is flushed to the transcript. Desktop and mobile both use this
// so the show/hide rule can't drift between platforms.

import type { NativeChatMessage } from './native-chat-types'

/** The synthetic streaming bubble's stable id (kept stable so the list keys it
 *  consistently across ticks and the real turn can replace it cleanly). */
export const NATIVE_CHAT_STREAMING_ID = 'streaming'

/** Concatenated text of an assistant message's text blocks, trimmed. */
export function nativeChatAssistantText(message: NativeChatMessage | undefined): string {
  if (!message || message.role !== 'assistant') {
    return ''
  }
  return message.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim()
}

/**
 * Content-only leads comparison: whether the overlay text is longer than
 * (and not already contained in) the last assistant turn's text. No
 * liveness gate — pure content coverage. For a caller whose overlay must
 * keep rendering past a lifecycle boundary (e.g. a just-completed RPC turn)
 * until the transcript demonstrably catches up, not merely until the turn
 * ends — see native-chat/omp-rpc-turn-reducer.ts, which uses this directly
 * instead of `nativeChatOverlayLeadsTranscript`.
 */
export function nativeChatOverlayLeadsTranscriptContent(args: {
  messages: readonly NativeChatMessage[]
  overlayText: string
}): boolean {
  const { messages, overlayText } = args
  const text = overlayText.trim()
  if (!text) {
    return false
  }
  const lastText = nativeChatAssistantText(messages.at(-1))
  return !(lastText.includes(text) || text.length <= lastText.length)
}

/**
 * Decide the streaming text to show, or null to show nothing: gated on
 * `working` outright (a stale preview from a finished turn never shows),
 * then on `nativeChatOverlayLeadsTranscriptContent`'s content comparison.
 * The RPC turn-stream overlay (native-chat/omp-rpc-turn-reducer.ts) calls
 * `nativeChatOverlayLeadsTranscriptContent` directly instead, since its
 * overlay must persist past `working` flipping false until the transcript
 * catches up.
 */
export function deriveNativeChatStreamingText(args: {
  messages: readonly NativeChatMessage[]
  previewText: string | null | undefined
  working: boolean
}): string | null {
  const { messages, previewText, working } = args
  if (!working) {
    return null
  }
  const text = previewText?.trim() ?? ''
  return nativeChatOverlayLeadsTranscriptContent({ messages, overlayText: text }) ? text : null
}

/** Build the synthetic streaming assistant message for the given text. */
export function nativeChatStreamingMessage(text: string): NativeChatMessage {
  return {
    id: NATIVE_CHAT_STREAMING_ID,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'hook'
  }
}
