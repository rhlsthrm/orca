// Composer send-routing for an RPC-owned pane (D6), extracted so it can be
// unit-tested against a stubbed session without mounting the composer.

import { useCallback } from 'react'
import type {
  OmpRpcChatSendBehavior,
  OmpRpcChatSendResult
} from '../../../../shared/omp-rpc-chat-ipc-contract'

export type UseOmpRpcChatSendArgs = {
  isRpcOwned: boolean
  isRpcTurnWorking: boolean
  /** Armed by the composer's "Follow up" affordance (W2-5). */
  followUpRequested: boolean
  sendChat: (args: {
    message: string
    behavior: OmpRpcChatSendBehavior
  }) => Promise<OmpRpcChatSendResult>
  /** Echo the user's own turn immediately, matching the PTY chat path's UX;
   *  the transcript still has to catch up since the RPC child writes the
   *  same session file the PTY did. */
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  /** The RPC round trip itself failed after the draft was already claimed
   *  (rare — acquisition already proved the session live). There is no PTY to
   *  fall back into: the original one already exited, or RPC wouldn't own
   *  this pane (D2). Surface it instead of silently dropping the message. */
  onSendFailed?: () => void
}

/** idle -> `prompt`; a working turn steers by default; the composer's
 *  Follow up affordance switches it to `follow_up` instead (D6). */
export function resolveOmpRpcChatSendBehavior(
  isRpcTurnWorking: boolean,
  followUpRequested: boolean
): OmpRpcChatSendBehavior {
  if (!isRpcTurnWorking) {
    return 'idle'
  }
  return followUpRequested ? 'followUp' : 'steer'
}

/**
 * Mirrors useOmpRpcLocalCommandSend's "claim the draft, return boolean"
 * contract: `false` means the caller must run its normal PTY send path
 * unchanged (D1). Text-only — the composer must not call this when the draft
 * carries image attachments; there is no new image UI for the RPC path.
 */
export function useOmpRpcChatSend(args: UseOmpRpcChatSendArgs): (text: string) => boolean {
  const {
    isRpcOwned,
    isRpcTurnWorking,
    followUpRequested,
    sendChat,
    onOptimisticSend,
    onSendFailed
  } = args
  return useCallback(
    (text: string) => {
      if (!isRpcOwned) {
        return false
      }
      const message = text.trim()
      if (!message) {
        return false
      }
      const behavior = resolveOmpRpcChatSendBehavior(isRpcTurnWorking, followUpRequested)
      onOptimisticSend?.(text, [])
      void sendChat({ message, behavior }).then((result) => {
        if (!result.ok) {
          onSendFailed?.()
        }
      })
      return true
    },
    [isRpcOwned, isRpcTurnWorking, followUpRequested, sendChat, onOptimisticSend, onSendFailed]
  )
}
