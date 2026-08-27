// Bundles the composer's RPC send routing (W2-4) with the "Follow up"
// affordance (W2-5) into one hook, extracted so NativeChatComposer.tsx stays
// under the file's line ratchet.

import { useRef, useState } from 'react'
import type { NativeChatComposerOmpRpcBinding } from './native-chat-composer-types'
import { useOmpRpcChatSend } from './use-omp-rpc-chat-send'

export type NativeChatComposerFollowUp = { active: boolean; onToggle: () => void }

export type UseNativeChatComposerOmpRpcSendArgs = {
  ompRpcChat: NativeChatComposerOmpRpcBinding
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  onSendFailed: () => void
}

export type NativeChatComposerOmpRpcSend = {
  sendOmpRpcChat: (text: string) => boolean
  /** Present only while an RPC-owned pane's turn is streaming (W2-5); a
   *  sticky toggle that self-clears the instant that turn settles, so it can
   *  never leak into the pane's next unrelated turn. */
  followUp: NativeChatComposerFollowUp | null
}

export function useNativeChatComposerOmpRpcSend(
  args: UseNativeChatComposerOmpRpcSendArgs
): NativeChatComposerOmpRpcSend {
  const { ompRpcChat, onOptimisticSend, onSendFailed } = args
  const [followUpRequested, setFollowUpRequested] = useState(false)
  // Clear the armed toggle the instant the turn it was armed for settles, so
  // it can never leak into the pane's next unrelated turn. Adjusted during
  // render (not an effect) so the reset lands in the same paint as the status
  // flip, matching the identical pattern in NativeChatComposer.tsx's
  // draft-scope-key reset.
  const previousTurnWorkingRef = useRef(ompRpcChat.isTurnWorking)
  if (previousTurnWorkingRef.current !== ompRpcChat.isTurnWorking) {
    previousTurnWorkingRef.current = ompRpcChat.isTurnWorking
    if (!ompRpcChat.isTurnWorking && followUpRequested) {
      setFollowUpRequested(false)
    }
  }

  const sendOmpRpcChat = useOmpRpcChatSend({
    isRpcOwned: ompRpcChat.isOwned,
    isRpcTurnWorking: ompRpcChat.isTurnWorking,
    followUpRequested,
    sendChat: ompRpcChat.send,
    onOptimisticSend,
    onSendFailed
  })

  const followUp =
    ompRpcChat.isOwned && ompRpcChat.isTurnWorking
      ? { active: followUpRequested, onToggle: () => setFollowUpRequested((value) => !value) }
      : null

  return { sendOmpRpcChat, followUp }
}
