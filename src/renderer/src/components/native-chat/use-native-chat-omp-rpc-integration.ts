// Composes the RPC chat ownership state (published by the TerminalPane-
// anchored use-omp-rpc-chat-pane-ownership.ts) with the wave-1 overlay/status
// projections (omp-rpc-turn-reducer.ts) into the exact set of values
// NativeChatView needs, so the view itself stays a thin, pure, remountable
// subscriber — it owns none of the acquire/hold/release lifecycle and
// performs no IPC of its own; every send/abort/respondExtensionUi call
// re-reads current ownership from the store and goes straight through the
// paneKey-scoped store actions (mirroring the existing agentStatusByPaneKey
// pattern: the component that renders the state is not the component that
// owns its lifecycle). Kept separate from the store slice so the
// merge/exclusivity rules below — "never both" (hook preview vs. RPC
// overlay) and "status only when active" (D5) — are unit-testable without
// touching the store.

import { useMemo } from 'react'
import { useAppStore } from '../../store'
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

export type UseNativeChatOmpRpcIntegrationArgs = {
  paneKey: string
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
  const { paneKey } = args
  const entry = useAppStore((s) => s.ompRpcChatOwnershipByPaneKey[paneKey])
  const sendOmpRpcChatPane = useAppStore((s) => s.sendOmpRpcChatPane)
  const abortOmpRpcChatPane = useAppStore((s) => s.abortOmpRpcChatPane)
  const respondOmpRpcChatExtensionUi = useAppStore((s) => s.respondOmpRpcChatExtensionUi)
  const isRpcOwned = entry?.status === 'acquired'
  const turnState = entry?.turnState

  const overlayMessages = useMemo(
    () =>
      isRpcOwned && turnState
        ? selectOmpRpcOverlayMessages(turnState, args.transcriptMessages)
        : [],
    [isRpcOwned, turnState, args.transcriptMessages]
  )

  return {
    isRpcOwned,
    isRpcTurnWorking: isRpcOwned && turnState?.status === 'working',
    overlayMessages,
    statusOverride: isRpcOwned && turnState && isOmpRpcTurnActive(turnState) ? 'working' : null,
    effectiveHookPreview: isRpcOwned ? null : args.hookPreview,
    pendingExtensionUiRequest: isRpcOwned ? (turnState?.pendingExtensionUiRequest ?? null) : null,
    answerExtensionUi: (response) => respondOmpRpcChatExtensionUi(paneKey, response),
    sendChat: (sendArgs) => sendOmpRpcChatPane(paneKey, sendArgs),
    abortChat: () => abortOmpRpcChatPane(paneKey)
  }
}
