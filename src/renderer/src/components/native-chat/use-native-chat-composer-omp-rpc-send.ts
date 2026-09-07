// Bundles the composer's RPC send routing (W2-4) with the "Follow up"
// affordance (W2-5) into one hook, extracted so NativeChatComposer.tsx stays
// under the file's line ratchet.

<<<<<<< HEAD
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
||||||| 8fa1b3c16c
=======
import { useCallback, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatCommandMarkerOutcome } from './native-chat-command-marker'
import type { NativeChatComposerOmpRpcBinding } from './native-chat-composer-types'
import { useOmpRpcChatSend } from './use-omp-rpc-chat-send'
import { useOmpRpcCommandSend } from './use-omp-rpc-command-send'

export const OMP_RPC_CHAT_DISABLED: NativeChatComposerOmpRpcBinding = {
  isOwned: false,
  isTurnWorking: false,
  send: () => Promise.resolve({ ok: false, reason: 'not-available' })
}

export type NativeChatComposerFollowUp = { active: boolean; onToggle: () => void }

export type UseNativeChatComposerOmpRpcSendArgs = {
  agent: AgentType
  ompRpcChat: NativeChatComposerOmpRpcBinding
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  /** Pane-cache-backed retraction of one echo, so a failed RPC send stops
   *  rendering as delivered even when this composer is gone. */
  onOptimisticSendCanceled?: (pendingId: string) => void
  onSlashCommand?: (command: string, outcome?: NativeChatCommandMarkerOutcome) => void
  /** Owns the user-visible failure text so the composer only wires a setter. */
  setNotice: (value: string | null) => void
}

export type NativeChatComposerOmpRpcSend = {
  sendOmpRpcChat: (text: string) => boolean
  /** Routes a catalog slash command through the owning session (open item 4). */
  sendOmpRpcCommand: (text: string) => boolean
  /** Present only while an RPC-owned pane's turn is streaming. The toggle
   *  applies to one send, then clears before another message can inherit it. */
  followUp: NativeChatComposerFollowUp | null
}

export function useNativeChatComposerOmpRpcSend(
  args: UseNativeChatComposerOmpRpcSendArgs
): NativeChatComposerOmpRpcSend {
  const {
    agent,
    ompRpcChat,
    onOptimisticSend,
    onOptimisticSendCanceled,
    onSlashCommand,
    setNotice
  } = args
  const [followUpRequested, setFollowUpRequested] = useState(false)
  const onSendFailed = useCallback(
    () =>
      setNotice(
        translate(
          'components.native-chat.composer.ompRpcSendFailed',
          'Message could not be sent to the agent.'
        )
      ),
    [setNotice]
  )

  const routeOmpRpcChat = useOmpRpcChatSend({
    isRpcOwned: ompRpcChat.isOwned,
    isRpcTurnWorking: ompRpcChat.isTurnWorking,
    followUpRequested,
    sessionGeneration: ompRpcChat.sessionGeneration ?? 0,
    sendChat: ompRpcChat.send,
    onOptimisticSend,
    onOptimisticSendCanceled,
    onSendFailed,
    onMessageFailed: ompRpcChat.reportMessageFailure
  })
  const sendOmpRpcChat = (text: string): boolean => {
    const claimed = routeOmpRpcChat(text)
    if (claimed) {
      setFollowUpRequested(false)
    }
    return claimed
  }

  const sendOmpRpcCommand = useOmpRpcCommandSend({
    agent,
    isRpcOwned: ompRpcChat.isOwned,
    executableCommands: ompRpcChat.executableCommands,
    sessionGeneration: ompRpcChat.sessionGeneration ?? 0,
    commandQueueKey: ompRpcChat.commandQueueKey ?? '',
    sendChat: ompRpcChat.send,
    onCommandDispatched: ompRpcChat.onCommandDispatched,
    onCommandAgentInvoked: ompRpcChat.onCommandAgentInvoked,
    onCommandFailed: ompRpcChat.reportCommandFailure,
    onSlashCommand,
    onSendFailed
  })

  const followUp =
    ompRpcChat.isOwned && ompRpcChat.isTurnWorking
      ? { active: followUpRequested, onToggle: () => setFollowUpRequested((value) => !value) }
      : null

  return { sendOmpRpcChat, sendOmpRpcCommand, followUp }
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
}
