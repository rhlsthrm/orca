// Load/apply state machine for the pane's one open Orca-originated command
// card. The reducer owns WHICH card is open (`openInteractiveCard`); this hook
// owns what that card currently shows, which is deliberately not reducer state:
// it is a per-render read of one RPC verb, and a remount should re-read the
// child rather than replay a snapshot that may have gone stale.

import { useEffect, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { NativeChatOmpRpcCommandCardView } from './NativeChatOmpRpcCommandCard'
import {
  applyOmpRpcInteractiveCard,
  createOmpRpcInteractiveCommandContext,
  findOmpRpcInteractiveCommandCard,
  isOmpRpcInteractiveCardError,
  loadOmpRpcInteractiveCard,
  type OmpRpcInteractiveCardChoice,
  type OmpRpcInteractiveCardLoadResult,
  type OmpRpcInteractiveCommandCard
} from './omp-rpc-interactive-command-registry'
import type { OmpRpcOpenInteractiveCard } from './omp-rpc-turn-reducer'

/** What an applied card reports back so the pane can record its marker. */
export type OmpRpcInteractiveCardResolution = {
  command: string
  /** The verb's own answer, e.g. the model the child actually selected. */
  message?: string
  /** True when the dispatch made the model work, so the marker must not say
   *  the agent was left uninvoked. */
  invokesAgent: boolean
}

export type UseOmpRpcInteractiveCardArgs = {
  open: OmpRpcOpenInteractiveCard | null
  paneKey: string
  /** The pane's working directory; some verbs take it as an argument. */
  cwd: string | null
  /** Affirmative answer to a destructive card that has no verb behind it: the
   *  command's own text goes to the session route it would have taken anyway.
   *  `false` means nothing was sent. */
  confirmGate: (command: string) => boolean
  onApplied: (resolution: OmpRpcInteractiveCardResolution) => void
  onDismiss: () => void
}

export type UseOmpRpcInteractiveCardResult = {
  card: OmpRpcInteractiveCommandCard | null
  view: NativeChatOmpRpcCommandCardView
  choose: (choice: OmpRpcInteractiveCardChoice) => void
}

type LoadedCardModel = { cardId: string; result: OmpRpcInteractiveCardLoadResult }

export function useOmpRpcInteractiveCard(
  args: UseOmpRpcInteractiveCardArgs
): UseOmpRpcInteractiveCardResult {
  const { open, paneKey, cwd, confirmGate, onApplied, onDismiss } = args
  const cardId = open?.cardId ?? null
  const command = open?.command ?? null
  const card = useMemo(
    () => (command ? findOmpRpcInteractiveCommandCard(`/${command}`) : null),
    [command]
  )
  const [loaded, setLoaded] = useState<LoadedCardModel | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // The card the pane holds RIGHT NOW, readable from a completion that closed
  // over an older one: a newer invocation replaces the card, and the
  // superseded apply must not report into its successor.
  const liveCardId = useRef(cardId)
  liveCardId.current = cardId

  useEffect(() => {
    if (!cardId || !card) {
      return
    }
    setPending(false)
    setFailure(null)
    const ctx = createOmpRpcInteractiveCommandContext(paneKey, cwd)
    if (!ctx) {
      setLoaded({
        cardId,
        result: {
          error: translate(
            'components.native-chat.ompRpcCommandCard.bridgeUnavailable',
            'This command needs the desktop agent connection, which is not available here.'
          )
        }
      })
      return
    }
    void loadOmpRpcInteractiveCard(card, ctx).then((result) => {
      if (liveCardId.current === cardId) {
        setLoaded({ cardId, result })
      }
    })
  }, [card, cardId, cwd, paneKey])

  const choose = (choice: OmpRpcInteractiveCardChoice): void => {
    if (!card || !cardId) {
      return
    }
    // A destructive card with no verb is a pure gate: OMP exposes no verb for
    // the action, so confirming performs the command send that would have
    // happened unguarded, and cancelling (which never reaches here) sends
    // nothing. The send records its own marker, so this reports none.
    if (!card.apply && card.destructive === true) {
      if (confirmGate(card.command)) {
        onDismiss()
        return
      }
      setFailure(
        translate(
          'components.native-chat.ompRpcCommandCard.gateSendFailed',
          'Orca could not send this command over the agent connection.'
        )
      )
      return
    }
    const ctx = createOmpRpcInteractiveCommandContext(paneKey, cwd)
    if (!ctx) {
      setFailure(
        translate(
          'components.native-chat.ompRpcCommandCard.bridgeUnavailable',
          'This command needs the desktop agent connection, which is not available here.'
        )
      )
      return
    }
    setPending(true)
    setFailure(null)
    void applyOmpRpcInteractiveCard(card, ctx, choice).then((result) => {
      if (liveCardId.current !== cardId) {
        return
      }
      setPending(false)
      if (!result.ok) {
        setFailure(
          result.message ??
            translate(
              'components.native-chat.ompRpcCommandCard.applyRefused',
              'The agent refused this change.'
            )
        )
        return
      }
      onApplied({
        command: card.command,
        ...(result.message ? { message: result.message } : {}),
        invokesAgent: card.invokesAgent === true
      })
    })
  }

  return { card, view: selectView({ card, cardId, loaded, pending, failure }), choose }
}

function selectView(state: {
  card: OmpRpcInteractiveCommandCard | null
  cardId: string | null
  loaded: LoadedCardModel | null
  pending: boolean
  failure: string | null
}): NativeChatOmpRpcCommandCardView {
  if (!state.card) {
    // Only reachable if a registered command disappears while its card is
    // open — an honest dead end beats a card that answers nothing.
    return {
      phase: 'error',
      message: translate(
        'components.native-chat.ompRpcCommandCard.unknownCommand',
        'This command no longer has a card in this build.'
      )
    }
  }
  if (!state.loaded || state.loaded.cardId !== state.cardId) {
    return { phase: 'loading' }
  }
  if (isOmpRpcInteractiveCardError(state.loaded.result)) {
    return { phase: 'error', message: state.loaded.result.error }
  }
  return {
    phase: 'ready',
    model: state.loaded.result,
    pending: state.pending,
    ...(state.failure ? { failure: state.failure } : {})
  }
}
