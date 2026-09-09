import { useCallback, useRef } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatCommandMarkerOutcome } from './native-chat-command-marker'
import { NativeChatOmpRpcCommandCard } from './NativeChatOmpRpcCommandCard'
import type { NativeChatOmpRpcIntegration } from './use-native-chat-omp-rpc-integration'
import { useOmpRpcCommandSend } from './use-omp-rpc-command-send'
import {
  useOmpRpcInteractiveCard,
  type OmpRpcInteractiveCardResolution
} from './use-omp-rpc-interactive-card'

export type NativeChatOmpRpcCommandCardSurfaceProps = {
  agent: AgentType
  paneKey: string
  /** The pane's working directory, for the verbs that take one. */
  cwd: string | null
  ompRpc: NativeChatOmpRpcIntegration
  /** Records the command marker for a card that resolved locally. */
  onSlashCommand?: (command: string, outcome?: NativeChatCommandMarkerOutcome) => void
}

/**
 * Mounts the pane's one open Orca-originated command card and closes the loop
 * on its answer: a verb-backed card dispatches its verb and records a command
 * marker; a destructive card with no verb behind it re-sends the command's own
 * text through the same session route (and the same command queue) the draft
 * would have taken unguarded, which is the only thing that turns OMP's
 * confirm-less text path into a confirmed one.
 *
 * The card is Orca-originated, so unlike `NativeChatExtensionUiCard` it does
 * NOT replace the composer: nothing in the child is blocked on it.
 */
export function NativeChatOmpRpcCommandCardSurface({
  agent,
  paneKey,
  cwd,
  ompRpc,
  onSlashCommand
}: NativeChatOmpRpcCommandCardSurfaceProps): React.JSX.Element | null {
  const open = ompRpc.interactiveCard
  // Names the gate command a durable failure report belongs to. A confirmed
  // gate dismisses this surface immediately, so by the time an async decline
  // lands there is no card left to show it on.
  const gateCommandRef = useRef<string | null>(null)
  // Why the composer's own hook rather than a bare store send: its
  // module-level per-session queue keeps two commands' `command_output` frames
  // (which carry no correlation id) out of one capture slot, and its
  // generation fencing stops a confirmed gate landing in a session that
  // replaced the one the user confirmed against.
  const dispatchGateCommand = useOmpRpcCommandSend({
    agent,
    isRpcOwned: ompRpc.isRpcOwned,
    executableCommands: ompRpc.rpcExecutableCommands,
    sessionGeneration: ompRpc.sessionGeneration,
    commandQueueKey: ompRpc.commandQueueKey,
    sendChat: ompRpc.sendChat,
    onCommandDispatched: ompRpc.onCommandDispatched,
    onCommandAgentInvoked: ompRpc.onCommandAgentInvoked,
    onCommandFailed: ompRpc.reportCommandFailure,
    onSlashCommand,
    onSendFailed: () =>
      ompRpc.reportCommandFailure(gateCommandRef.current ?? '', ompRpc.sessionGeneration)
  })
  const dismissInteractiveCard = ompRpc.dismissInteractiveCard
  const openCardId = open?.cardId ?? null
  const dismiss = useCallback(() => {
    if (openCardId) {
      dismissInteractiveCard(openCardId)
    }
  }, [dismissInteractiveCard, openCardId])
  const confirmGate = useCallback(
    (command: string) => {
      const text = `/${command}`
      gateCommandRef.current = text
      return dispatchGateCommand(text)
    },
    [dispatchGateCommand]
  )
  const applied = useCallback(
    (resolution: OmpRpcInteractiveCardResolution) => {
      // The marker is the pane's record that the command ran; `invokesAgent`
      // decides whether it may also claim the agent was never invoked.
      onSlashCommand?.(`/${resolution.command}`, {
        outputText: resolution.message ?? '',
        agentInvoked: resolution.invokesAgent
      })
      dismiss()
    },
    [dismiss, onSlashCommand]
  )
  const { card, view, choose } = useOmpRpcInteractiveCard({
    open,
    paneKey,
    cwd,
    confirmGate,
    onApplied: applied,
    onDismiss: dismiss
  })
  if (!open) {
    return null
  }
  return (
    <NativeChatOmpRpcCommandCard
      // Why the key: a newer invocation reuses this slot, and an input card's
      // draft must not carry over to the command that replaced it.
      key={open.cardId}
      command={open.command}
      title={card?.title ?? open.command}
      destructive={card?.destructive === true}
      view={view}
      onChoose={choose}
      onDismiss={dismiss}
    />
  )
}
