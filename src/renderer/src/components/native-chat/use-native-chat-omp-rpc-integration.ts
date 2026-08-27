// Composes the RPC chat session (use-omp-rpc-chat-session.ts) with the wave-1
// overlay/status projections (omp-rpc-turn-reducer.ts) into the exact set of
// values NativeChatView needs, so the view itself stays a thin consumer. Kept
// separate from the session hook so the merge/exclusivity rules below —
// "never both" (hook preview vs. RPC overlay) and "status only when active"
// (D5) — are unit-testable without mounting the acquisition effect.

import { useMemo } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type {
  OmpRpcChatSendResult,
  OmpRpcChatSendBehavior
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import type {
  OmpRpcExtensionUiRequestFrame,
  OmpRpcExtensionUiResponse
} from '../../../../shared/omp-rpc-protocol'
import { isOmpRpcTurnActive, selectOmpRpcOverlayMessages } from './omp-rpc-turn-reducer'
import { useOmpRpcChatSession } from './use-omp-rpc-chat-session'

export type UseNativeChatOmpRpcIntegrationArgs = {
  agent: AgentType
  paneKey: string
  ptyId: string | null
  cwd: string | null
  sessionFile: string | null
  isVisible: boolean
  runtimeEnvironmentId: string | null
  transcriptMessages: readonly NativeChatMessage[]
  /** The hook-preview bubble's raw source text, before RPC exclusivity. */
  hookPreview: string | null | undefined
}

export type NativeChatOmpRpcIntegration = {
  isRpcOwned: boolean
  /** Whether the RPC session's current turn is actively streaming. */
  isRpcTurnWorking: boolean
  /** Spliced into the message list at the streaming bubble's position. */
  overlayMessages: NativeChatMessage[]
  /** `session.status` override for D5 — 'working' only while the RPC turn is
   *  in flight; null leaves the transcript/hook-derived status untouched. */
  statusOverride: 'working' | null
  /** `hookPreview` forced to null while RPC owns the pane, so the hook-preview
   *  bubble and the RPC overlay can never render at the same time. */
  effectiveHookPreview: string | null | undefined
  pendingExtensionUiRequest: OmpRpcExtensionUiRequestFrame | null
  answerExtensionUi: (response: OmpRpcExtensionUiResponse) => void
  sendChat: (args: {
    message: string
    behavior: OmpRpcChatSendBehavior
  }) => Promise<OmpRpcChatSendResult>
  abortChat: () => Promise<OmpRpcChatSendResult>
}

export function useNativeChatOmpRpcIntegration(
  args: UseNativeChatOmpRpcIntegrationArgs
): NativeChatOmpRpcIntegration {
  const session = useOmpRpcChatSession(args)
  const isRpcOwned = session.isOwned

  const overlayMessages = useMemo(
    () =>
      isRpcOwned ? selectOmpRpcOverlayMessages(session.turnState, args.transcriptMessages) : [],
    [isRpcOwned, session.turnState, args.transcriptMessages]
  )

  return {
    isRpcOwned,
    isRpcTurnWorking: isRpcOwned && session.turnState.status === 'working',
    overlayMessages,
    statusOverride: isRpcOwned && isOmpRpcTurnActive(session.turnState) ? 'working' : null,
    effectiveHookPreview: isRpcOwned ? null : args.hookPreview,
    pendingExtensionUiRequest: isRpcOwned ? session.turnState.pendingExtensionUiRequest : null,
    answerExtensionUi: session.respondExtensionUi,
    sendChat: session.send,
    abortChat: session.abort
  }
}
