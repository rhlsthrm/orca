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
 * Whether an in-progress overlay's text should still be shown against the
 * settled transcript: only while it leads — i.e. it's longer than (and not
 * already contained in) the last assistant turn. Once the real turn lands with
 * the same (or more) text, the overlay is suppressed so it can't duplicate or
 * flicker as the transcript catches up. `working` gates it outright: a stale
 * overlay from a finished turn never shows. Shared by the hook-preview bubble
 * and the RPC turn-stream overlay (native-chat/omp-rpc-turn-reducer.ts) so the
 * anti-duplication rule can't drift between the two live-preview sources.
 */
export function nativeChatOverlayLeadsTranscript(args: {
  messages: readonly NativeChatMessage[]
  overlayText: string
  working: boolean
}): boolean {
  const { messages, overlayText, working } = args
  if (!working) {
    return false
  }
  const text = overlayText.trim()
  if (!text) {
    return false
  }
  const lastText = nativeChatAssistantText(messages.at(-1))
  return !(lastText.includes(text) || text.length <= lastText.length)
}

/**
 * Decide the streaming text to show, or null to show nothing. See
 * `nativeChatOverlayLeadsTranscript` for the show/hide rule.
 */
export function deriveNativeChatStreamingText(args: {
  messages: readonly NativeChatMessage[]
  previewText: string | null | undefined
  working: boolean
}): string | null {
  const { messages, previewText, working } = args
  const text = previewText?.trim() ?? ''
  return nativeChatOverlayLeadsTranscript({ messages, overlayText: text, working }) ? text : null
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
