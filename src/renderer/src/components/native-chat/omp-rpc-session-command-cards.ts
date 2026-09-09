// Session-family interactive command cards.
//
// `/resume` and `/branch` are TUI-only builtins: OMP does not advertise them
// over RPC at all, so today their raw text is handed to the model as a prompt.
// `/session` IS advertised and degrades to three lines of text
// (`Session: …` / `Title: …` / `CWD: …`) instead of its dashboard.
//
// The destructive half of this file is a defect fix, not a nicety. OMP's
// text-mode `/session delete` deletes on the spot — `sessionManager.dropSession`
// behind nothing but an `isStreaming` guard (oh-my-pi
// packages/coding-agent/src/slash-commands/builtin-session.ts:206-224) — while
// its TUI path confirms first (`showHookConfirm("Delete Session", "This will
// permanently delete the current session.")`,
// modes/controllers/selector-controller.ts:1784-1792). Orca's chat drives the
// text path, so `/session delete` there destroys a session with no
// confirmation at all. Upstream exposes no delete verb, so a card cannot
// perform the deletion — it GATES it: `destructive: true` with no `apply` makes
// the framework re-send the original command only after an affirmative
// confirm. The confirm names the exact session, and refuses to open when OMP
// could not name it, because a confirm that cannot say what it destroys is not
// a confirmation.
//
// Two rules from the contract run through every card here. An `ok: false` verb
// renders an honest inline error, never an empty picker. And nothing is
// reported that OMP did not send: an absent name, an absent count and an
// unreadable state are absent, not blank, zero, or guessed.

import type { OmpRpcChatResumableSession } from '../../../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcSessionState, OmpRpcSessionStats } from '../../../../shared/omp-rpc-protocol'
import { formatUiRelativeTime } from '../../i18n/relative-time-format'
import type {
  OmpRpcInteractiveCardOption,
  OmpRpcInteractiveCardRow,
  OmpRpcInteractiveCommandCard
} from './omp-rpc-interactive-command-registry'

const NO_CWD_ERROR =
  "Orca could not resolve this pane's working directory, so OMP's sessions for it cannot be listed."

/** Enough of a session name or a first user message to recognize a row by.
 *  Long enough to be distinguishing, short enough for one line. */
const MAX_ROW_LABEL_LENGTH = 120

function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed
}

/** A session's row label: its own name when it has one, else its id. Never a
 *  fabricated title — an unnamed session is shown as the id it really has. */
function resumableSessionLabel(session: OmpRpcChatResumableSession): string {
  return session.name ? truncate(session.name, MAX_ROW_LABEL_LENGTH) : session.sessionId
}

/** Only facts OMP itself recorded: when the session started (its own header
 *  timestamp, absent on a session whose header carries none) and when it was
 *  last written (the mtime of the stat that proved the file exists). */
function resumableSessionDescription(session: OmpRpcChatResumableSession): string {
  const startedAtMs = session.startedAt ? Date.parse(session.startedAt) : Number.NaN
  const parts = [
    ...(Number.isFinite(startedAtMs)
      ? [`started ${formatUiRelativeTime(startedAtMs - Date.now())}`]
      : []),
    `last used ${formatUiRelativeTime(session.modifiedAtMs - Date.now())}`
  ]
  if (session.name) {
    parts.push(session.sessionId)
  }
  if (session.isCurrent) {
    parts.push('this pane is on it now')
  }
  return parts.join(' · ')
}

/** The row id is the ABSOLUTE session file path `switchSession` requires: a
 *  bare id is answered with success upstream while the child keeps writing the
 *  session it was already on (F12), so the path is the only safe payload and
 *  carrying it as the id is what makes `apply` unable to send anything else. */
function resumableSessionOption(session: OmpRpcChatResumableSession): OmpRpcInteractiveCardOption {
  return {
    id: session.sessionPath,
    label: resumableSessionLabel(session),
    description: resumableSessionDescription(session),
    // Switching onto the session the pane is already on is a no-op that still
    // costs a session move and a claim reconciliation.
    ...(session.isCurrent ? { current: true, disabled: true } : {})
  }
}

/**
 * `/resume`: the session picker OMP shows in its TUI and offers over RPC not at
 * all. Rows are the sessions main found in this pane's own cwd bucket — every
 * one stat-verified to exist, and a session another live pane already claims
 * withheld main-side, because switching onto one would put two writers on the
 * same file.
 */
const RESUME_CARD: OmpRpcInteractiveCommandCard = {
  command: 'resume',
  title: 'Resume a session',
  kind: 'select',
  async load(ctx) {
    if (!ctx.cwd) {
      return { error: NO_CWD_ERROR }
    }
    const sessions = await ctx.api.listResumableSessions({ paneKey: ctx.paneKey, cwd: ctx.cwd })
    if (!sessions.ok) {
      return { error: `OMP's sessions for this directory could not be listed: ${sessions.reason}` }
    }
    if (sessions.data.length === 0) {
      return {
        error:
          'OMP has no saved sessions for this directory. A session another pane is using is not offered.'
      }
    }
    return {
      kind: 'select',
      options: sessions.data.map(resumableSessionOption),
      note: 'Most recently used first. Sessions another pane is using are not listed.'
    }
  },
  async apply(ctx, choice) {
    if (choice.kind !== 'select') {
      return { ok: false, message: 'The resume card needs a session row.' }
    }
    const result = await ctx.api.switchSession({
      paneKey: ctx.paneKey,
      sessionPath: choice.optionId
    })
    return result.ok
      ? { ok: true, message: 'Resumed that session.' }
      : { ok: false, message: `That session could not be resumed: ${result.reason}` }
  }
}

/**
 * `/branch`: OMP's user-message selector, which over RPC is not a command at
 * all. Rewinding to an earlier user message forks the session tree rather than
 * discarding anything, so this is a plain picker and not a confirm.
 */
const BRANCH_CARD: OmpRpcInteractiveCommandCard = {
  command: 'branch',
  title: 'Branch from a message',
  kind: 'select',
  async load(ctx) {
    const messages = await ctx.api.getBranchMessages({ paneKey: ctx.paneKey })
    if (!messages.ok) {
      return { error: `OMP could not list this session's messages: ${messages.reason}` }
    }
    if (messages.data.length === 0) {
      return { error: 'This session has no user message to branch from yet.' }
    }
    return {
      kind: 'select',
      options: messages.data.map((message, index) => ({
        id: message.entryId,
        label: truncate(message.text, MAX_ROW_LABEL_LENGTH) || `Message ${index + 1}`
      })),
      note: 'Branching forks the session at that message; nothing already sent is deleted.'
    }
  },
  async apply(ctx, choice) {
    if (choice.kind !== 'select') {
      return { ok: false, message: 'The branch card needs a message row.' }
    }
    const result = await ctx.api.branch({ paneKey: ctx.paneKey, entryId: choice.optionId })
    if (!result.ok) {
      return { ok: false, message: `OMP could not branch this session: ${result.reason}` }
    }
    // `cancelled` is the child declining the rewind, and `text` is meaningless
    // then — reporting success on it would claim a branch that never happened.
    return result.data.cancelled
      ? { ok: false, message: 'OMP declined to branch this session.' }
      : { ok: true, message: 'Branched from that message.' }
  }
}

function numberRow(label: string, value: number | undefined): OmpRpcInteractiveCardRow[] {
  return typeof value === 'number' && Number.isFinite(value)
    ? [{ label, value: value.toLocaleString('en-US') }]
    : []
}

/** Rows for whatever the two reads actually returned. An absent number is
 *  ABSENT, never rendered as zero: a session dashboard that shows `0 tokens`
 *  for "OMP did not say" is a false statement about the session. */
function sessionDashboardRows(
  state: OmpRpcSessionState | null,
  stats: OmpRpcSessionStats | null
): OmpRpcInteractiveCardRow[] {
  const sessionId = state?.sessionId ?? stats?.sessionId
  const sessionFile = state?.sessionFile ?? stats?.sessionFile
  const context = state?.contextUsage ?? stats?.contextUsage
  return [
    ...(sessionId ? [{ label: 'Session', value: sessionId }] : []),
    ...(state?.sessionName ? [{ label: 'Name', value: state.sessionName }] : []),
    ...(sessionFile ? [{ label: 'File', value: sessionFile }] : []),
    ...numberRow('Messages', stats?.totalMessages ?? state?.messageCount),
    ...numberRow('From you', stats?.userMessages),
    ...numberRow('From OMP', stats?.assistantMessages),
    ...numberRow('Tool calls', stats?.toolCalls),
    ...numberRow('Tokens', stats?.tokens.total),
    ...numberRow('Premium requests', stats?.premiumRequests),
    ...(typeof stats?.cost === 'number' && Number.isFinite(stats.cost)
      ? [{ label: 'Cost', value: `$${stats.cost.toFixed(2)}` }]
      : []),
    ...(context
      ? [
          {
            label: 'Context',
            value: `${context.percent.toFixed(0)}% of ${context.contextWindow.toLocaleString('en-US')} tokens`
          }
        ]
      : [])
  ]
}

/**
 * `/session` and `/session info`: the dashboard OMP's TUI shows, in place of the
 * three lines its text handler prints. Read-only, so it has no `apply`.
 */
const SESSION_INFO_CARD: OmpRpcInteractiveCommandCard = {
  command: 'session',
  aliases: ['session info'],
  title: 'Session',
  kind: 'dashboard',
  async load(ctx) {
    const [state, stats] = await Promise.all([
      ctx.api.getState({ paneKey: ctx.paneKey }),
      ctx.api.getSessionStats({ paneKey: ctx.paneKey })
    ])
    if (!state.ok && !stats.ok) {
      return { error: `OMP could not report this session: ${state.reason}` }
    }
    const rows = sessionDashboardRows(state.ok ? state.data : null, stats.ok ? stats.data : null)
    if (rows.length === 0) {
      return { error: 'OMP reported nothing about this session.' }
    }
    return {
      kind: 'dashboard',
      rows,
      ...(stats.ok ? {} : { note: `OMP's session statistics could not be read: ${stats.reason}` })
    }
  }
}

/**
 * `/session rename` and `/rename`: OMP advertises `/rename` with the hint
 * `<title>` (live-probed, omp 18.1.15), and its own text handler is the same
 * `setSessionName` this verb drives — but only when it is given the title
 * inline. A BARE `/rename` prints `Usage: /rename <title>` and nothing else
 * (builtin-lifecycle.ts:550-560), so the bare form is what this card claims,
 * while `/rename <title>` stays on the straight-to-RPC path it already works
 * on.
 */
const SESSION_RENAME_CARD: OmpRpcInteractiveCommandCard = {
  command: 'session rename',
  aliases: ['rename'],
  title: 'Rename session',
  kind: 'input',
  async load(ctx) {
    const state = await ctx.api.getState({ paneKey: ctx.paneKey })
    const currentName = state.ok ? state.data.sessionName : undefined
    return {
      kind: 'input',
      label: 'Session name',
      placeholder: 'A name for this session',
      submitLabel: 'Rename',
      ...(currentName ? { initialValue: currentName } : {}),
      ...(state.ok ? {} : { note: `OMP's current session name could not be read: ${state.reason}` })
    }
  },
  async apply(ctx, choice) {
    if (choice.kind !== 'input') {
      return { ok: false, message: 'The rename card needs a name.' }
    }
    const name = choice.text.trim()
    if (!name) {
      return { ok: false, message: 'A session name cannot be empty.' }
    }
    const result = await ctx.api.setSessionName({ paneKey: ctx.paneKey, name })
    return result.ok
      ? { ok: true, message: `Session renamed to ${name}.` }
      : { ok: false, message: `The session could not be renamed: ${result.reason}` }
  }
}

/** What the confirm must be able to say before it is offered at all. */
function describeDeletionTarget(state: OmpRpcSessionState): string | null {
  if (!state.sessionFile) {
    return null
  }
  const name = state.sessionName ? `“${state.sessionName}”` : null
  const id = state.sessionId
  const identity = [name, id].filter((part): part is string => part !== null).join(' ')
  return identity ? `${identity}\n${state.sessionFile}` : state.sessionFile
}

/**
 * `/session delete`: the confirm gate in front of OMP's text handler, which
 * deletes with no confirmation of its own (see the file header). No `apply` —
 * upstream has no delete verb, so an affirmative confirm is what lets the
 * framework send the original command, and a cancel sends nothing.
 */
const SESSION_DELETE_CARD: OmpRpcInteractiveCommandCard = {
  command: 'session delete',
  title: 'Delete session',
  kind: 'confirm',
  destructive: true,
  async load(ctx) {
    const state = await ctx.api.getState({ paneKey: ctx.paneKey })
    if (!state.ok) {
      // Refusing to open is the point: OMP deletes the moment the command
      // reaches it, so a confirm that cannot name its target must not exist.
      return { error: `OMP could not say which session would be deleted: ${state.reason}` }
    }
    const target = describeDeletionTarget(state.data)
    if (!target) {
      // Upstream's own answer for this case ("No session file to delete
      // (in-memory session)"), reached before anything is sent.
      return { error: 'This session has no file on disk, so there is nothing to delete.' }
    }
    if (state.data.isStreaming) {
      // OMP refuses mid-stream anyway; saying so beats a confirm that is
      // answered and then rejected.
      return { error: 'OMP cannot delete a session while it is streaming a response.' }
    }
    return {
      kind: 'confirm',
      prompt: `Permanently delete this session?\n\n${target}`,
      confirmLabel: 'Delete session',
      note: 'This cannot be undone. Its transcript and artifacts are removed from disk.'
    }
  }
}

export const OMP_RPC_SESSION_COMMAND_CARDS: readonly OmpRpcInteractiveCommandCard[] = [
  RESUME_CARD,
  BRANCH_CARD,
  SESSION_INFO_CARD,
  SESSION_RENAME_CARD,
  SESSION_DELETE_CARD
]
