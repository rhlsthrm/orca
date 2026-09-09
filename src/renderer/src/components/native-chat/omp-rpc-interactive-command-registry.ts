// The interactive-command card framework for the RPC-owned chat pane.
//
// OMP builtins carry a text-mode `handle` and/or a rich `handleTui` overlay.
// A command with both DEGRADES over RPC: `/switch` prints
// `Current model: openai-codex/gpt-6-astra` instead of opening the model
// picker, and a command OMP does not advertise at all (`/thinking`) is not
// even a command over the wire — its raw text reaches the model as a prompt.
// This module is the registry that gives those commands a native equivalent:
// a card, rendered by Orca, driving the matching RPC verb.
//
// Three facts shape the type below:
//   * A card is Orca-originated. It is NOT an `extension_ui_request` — the
//     child is not blocked on it and never sees the answer, so it lives in its
//     own state slot (`openInteractiveCard`) and answering one can never
//     resolve a child request.
//   * `load` may fail. Every verb fails closed into
//     `{ ok: false, reason }`, so a card's model is `CardModel | { error }` and
//     an unreadable state renders an honest error rather than an empty picker.
//   * A card must never synthesize a value OMP did not send. `current` marks
//     the child's reported selection only; when `get_state` omits the field
//     the card renders no marker and says so in `note`.

import type { OmpRpcChatApi } from '../../../../preload/api/omp-rpc-chat-api'
import { OMP_RPC_INFO_COMMAND_CARDS } from './omp-rpc-info-command-cards'
import { OMP_RPC_SESSION_COMMAND_CARDS } from './omp-rpc-session-command-cards'
import { OMP_RPC_SETTINGS_COMMAND_CARDS } from './omp-rpc-settings-command-cards'

/** Everything on the chat API that is NOT an interactive verb: the pane's
 *  ownership lifecycle and its frame/prompt transports. Written as
 *  `keyof Pick<…>` rather than a bare union so a renamed method fails to
 *  compile here instead of silently widening what a card can reach. */
type OmpRpcChatNonCardMethod = keyof Pick<
  OmpRpcChatApi,
  | 'resolveSessionIdentity'
  | 'acquire'
  | 'hasSession'
  | 'release'
  | 'fetchHistory'
  | 'send'
  | 'abort'
  | 'respondExtensionUi'
  | 'subscribe'
  | 'onHandback'
  | 'claimPendingHandbacks'
  | 'settleHandback'
>

/** The verbs a card may call. Derived by subtraction so a newly added
 *  interactive verb is reachable the moment it lands on the API, while a card
 *  still cannot acquire, release, transfer or widen the pane's ownership, nor
 *  put a prompt on the wire. */
export type OmpRpcChatCardApi = Omit<OmpRpcChatApi, OmpRpcChatNonCardMethod>

export type OmpRpcInteractiveCardKind = 'select' | 'confirm' | 'input' | 'dashboard'

/** One row of a select card. `current` is reserved for the selection OMP
 *  itself reported; `disabled` is a row that exists but cannot be chosen
 *  (a login provider the session cannot serve). */
export type OmpRpcInteractiveCardOption = {
  id: string
  label: string
  description?: string
  current?: boolean
  disabled?: boolean
}

export type OmpRpcInteractiveCardRow = { label: string; value: string }

export type OmpRpcInteractiveCardModel =
  | { kind: 'select'; options: readonly OmpRpcInteractiveCardOption[]; note?: string }
  | { kind: 'confirm'; prompt: string; confirmLabel?: string; note?: string }
  | {
      kind: 'input'
      label: string
      placeholder?: string
      initialValue?: string
      submitLabel?: string
      note?: string
    }
  | { kind: 'dashboard'; rows: readonly OmpRpcInteractiveCardRow[]; note?: string }

/** `{ error }` is a load that could not answer — a refused verb, an unowned
 *  pane, a payload main could not validate. It is rendered as inline card
 *  text; it never becomes an empty picker. */
export type OmpRpcInteractiveCardLoadResult = OmpRpcInteractiveCardModel | { error: string }

/** What the user did. A cancel dismisses the card and never reaches `apply`,
 *  which is why `confirm` carries no boolean: reaching `apply` IS the
 *  confirmation. A dashboard has no choice to make. */
export type OmpRpcInteractiveCardChoice =
  | { kind: 'select'; optionId: string }
  | { kind: 'confirm' }
  | { kind: 'input'; text: string }

/** `cwd` is the pane's working directory, which some verbs need as their own
 *  argument (`list_resumable_sessions` enumerates a cwd bucket). Nullable
 *  because a pane whose tab has no resolved worktree genuinely has none — a
 *  card that needs it answers `{ error }` rather than guessing a directory. */
export type OmpRpcInteractiveCommandContext = {
  paneKey: string
  cwd: string | null
  api: OmpRpcChatCardApi
}

export type OmpRpcInteractiveCardApplyResult = { ok: boolean; message?: string }

export type OmpRpcInteractiveCommandCard = {
  /** The invocation this card claims, slash-less and whitespace-collapsed
   *  (`'switch'`, `'session delete'`). Matched exactly: an argumented
   *  invocation such as `/switch gpt-6-astra` keeps the straight-to-RPC path. */
  command: string
  aliases?: readonly string[]
  title: string
  kind: OmpRpcInteractiveCardKind
  /** Irreversible on the child's side. A destructive card with NO `apply` is a
   *  pure GATE: OMP exposes no verb for the action (deleting a session), so
   *  confirming it performs the straight-to-RPC command send that would have
   *  happened anyway, and cancelling sends nothing. That is the whole fix for
   *  a text-path builtin that destroys without confirming. */
  destructive?: boolean
  /** True when dispatching makes the model do work (`compact`, `handoff`), so
   *  the command marker must NOT claim the agent was left uninvoked. */
  invokesAgent?: boolean
  load(ctx: OmpRpcInteractiveCommandContext): Promise<OmpRpcInteractiveCardLoadResult>
  /** Absent on a read-only dashboard: there is nothing to dispatch. */
  apply?(
    ctx: OmpRpcInteractiveCommandContext,
    choice: OmpRpcInteractiveCardChoice
  ): Promise<OmpRpcInteractiveCardApplyResult>
}

/** Settings first: `/switch` and `/model` are the commands this branch exists
 *  for, and a duplicate registration resolves to the first match. */
export const OMP_RPC_INTERACTIVE_COMMAND_CARDS: readonly OmpRpcInteractiveCommandCard[] = [
  ...OMP_RPC_SETTINGS_COMMAND_CARDS,
  ...OMP_RPC_SESSION_COMMAND_CARDS,
  ...OMP_RPC_INFO_COMMAND_CARDS
]

/** The invocation a draft names, or null when the draft is not slash text.
 *  Whitespace runs collapse so `/session   delete` and `/session delete` are
 *  the same invocation; case is preserved because OMP's own command lookup is
 *  a case-sensitive Map. */
export function normalizeOmpRpcCommandInvocation(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) {
    return null
  }
  const invocation = trimmed.replace(/^\/+/u, '').replace(/\s+/gu, ' ').trim()
  return invocation || null
}

/**
 * The card a draft opens, or null for every draft that must keep its existing
 * route. Exact match on the whole normalized invocation, which is what makes
 * the bare-vs-argumented rule fall out: `/switch` matches the model card,
 * `/switch gpt-6-astra` matches nothing and stays on the straight-to-RPC path
 * it already works on, and a multi-word registration (`session delete`) can
 * still claim its own argumented form.
 */
export function findOmpRpcInteractiveCommandCard(
  text: string,
  cards: readonly OmpRpcInteractiveCommandCard[] = OMP_RPC_INTERACTIVE_COMMAND_CARDS
): OmpRpcInteractiveCommandCard | null {
  const invocation = normalizeOmpRpcCommandInvocation(text)
  if (!invocation) {
    return null
  }
  return (
    cards.find(
      (card) => card.command === invocation || card.aliases?.includes(invocation) === true
    ) ?? null
  )
}

/** True when a draft has a card, i.e. when routing must open one instead of
 *  putting the command's text on the wire. */
export function hasOmpRpcInteractiveCommandCard(text: string): boolean {
  return findOmpRpcInteractiveCommandCard(text) !== null
}

export function isOmpRpcInteractiveCardError(
  result: OmpRpcInteractiveCardLoadResult
): result is { error: string } {
  return 'error' in result
}

/** The pane-scoped context a card's `load`/`apply` runs in, or null when the
 *  preload bridge is absent (a web client, a renderer without the API). */
export function createOmpRpcInteractiveCommandContext(
  paneKey: string,
  cwd: string | null
): OmpRpcInteractiveCommandContext | null {
  const api = window.api?.ompRpcChat
  return api ? { paneKey, cwd, api } : null
}

/** Why the wrappers: `load`/`apply` are authored per command family, and a
 *  throw from one of them would otherwise become an unhandled rejection with
 *  the card stuck on its loading state. The verbs themselves never reject —
 *  they fail closed into `{ ok: false }` — so anything caught here is a bug in
 *  an adapter, and the card says so instead of hanging. */
export async function loadOmpRpcInteractiveCard(
  card: OmpRpcInteractiveCommandCard,
  ctx: OmpRpcInteractiveCommandContext
): Promise<OmpRpcInteractiveCardLoadResult> {
  try {
    return await card.load(ctx)
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : 'unexpected error'
    return { error: `/${card.command} could not be read: ${detail}` }
  }
}

export async function applyOmpRpcInteractiveCard(
  card: OmpRpcInteractiveCommandCard,
  ctx: OmpRpcInteractiveCommandContext,
  choice: OmpRpcInteractiveCardChoice
): Promise<OmpRpcInteractiveCardApplyResult> {
  if (!card.apply) {
    return { ok: false, message: `/${card.command} has no action to apply.` }
  }
  try {
    return await card.apply(ctx, choice)
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : 'unexpected error'
    return { ok: false, message: `/${card.command} failed: ${detail}` }
  }
}
