// The commands OMP only implements as a terminal surface, and the honest
// notice Orca answers them with.
//
// OMP's unified registry gives each builtin a text-mode `handle`, a TUI-only
// `handleTui`, or both. Its RPC layer advertises (and dispatches) ONLY the
// entries carrying `handle`: `available-commands.ts` skips the rest with
// `if (!command.handle) continue`, and `executeAcpBuiltinSlashCommand` returns
// `false` for them, after which `rpc-mode.ts` forwards the raw text to
// `session.prompt()`. So a bare `/settings` over RPC is not a command at all —
// it is a prompt, and the model answers it. Verified against the running
// binary (omp/18.1.15): every entry below returns a `prompt` response with no
// `agentInvoked` field and starts an agent turn, while `/tools`,
// `/marketplace` and `/computer` — which DO carry a text handler — answer
// locally with `agentInvoked: false` and are therefore absent from this table.
//
// The answer is a local notice, not a card and not a wire send: Orca cannot
// drive these surfaces (there is no verb behind a full-screen selector), so
// the only true thing to say is which surface it is and where it lives. The
// notice is Orca-originated output; it is NOT an `extension_ui_request`, and
// nothing is dispatched on the child's behalf.

import { translate } from '@/i18n/i18n'
import { nativeChatToggleShortcutLabel } from './native-chat-shortcut'
import {
  hasOmpRpcInteractiveCommandCard,
  normalizeOmpRpcCommandInvocation
} from './omp-rpc-interactive-command-registry'

export type OmpRpcTerminalOnlyCommand = {
  /** The invocation this row claims, slash-less and whitespace-collapsed.
   *  Matched exactly, so an argumented invocation keeps its existing route. */
  command: string
  aliases?: readonly string[]
  /** What the terminal view actually opens, phrased to complete "… opens
   *  {{surface}}". Sourced from OMP's own command description, which the `/`
   *  menu already shows verbatim and untranslated. */
  surface: string
}

/**
 * Every OMP builtin that has `handleTui` and no `handle`, restricted to the
 * surfaces Orca has no card for. Ordering is presentational only — lookup is
 * an exact match, so no row can shadow another.
 *
 * Deliberately NOT here: `/branch`, `/login`, `/resume`, `/session*` (cards
 * own them — and `findOmpRpcTerminalOnlyCommand` refuses a carded invocation
 * anyway); `/clear`, `/new`, `/drop`, `/exit`, `/quit`, `/restart` (session
 * and process lifecycle, which Orca answers with its own affordances);
 * `/btw`, `/tan`, `/omfg`, `/cleanse` (they dispatch agent work rather than
 * open a surface); `/collab`, `/join`, `/leave`, `/live`, `/open` (relay and
 * voice flows whose terminal surface is not the whole story).
 */
export const OMP_RPC_TERMINAL_ONLY_COMMANDS: readonly OmpRpcTerminalOnlyCommand[] = [
  { command: 'settings', surface: 'the settings menu' },
  { command: 'setup', aliases: ['providers'], surface: 'provider setup' },
  { command: 'git', surface: 'the git UI (split diff viewer, staging, commit composer)' },
  { command: 'agents', surface: 'the agents hub (per-agent model, prewalk, and advisor)' },
  { command: 'hub', surface: 'the live Agent Hub' },
  { command: 'extensions', aliases: ['status'], surface: 'the Extension Control Center dashboard' },
  { command: 'debug', surface: 'the debug tools selector' },
  { command: 'tree', surface: 'the session tree navigator' },
  { command: 'hotkeys', surface: 'the keyboard shortcut reference' },
  { command: 'logout', surface: 'the OAuth provider logout picker' },
  { command: 'copy', surface: 'the picker for copying text or code from the conversation' },
  { command: 'fork', surface: 'the message picker for forking the session' },
  { command: 'pause', surface: 'the freeze control for every agent (main, subagents, advisor)' },
  { command: 'plan', surface: 'the plan-mode toggle' },
  { command: 'plan-review', surface: 'the review of the latest plan' },
  { command: 'vibe', surface: 'the vibe-mode toggle' },
  { command: 'goal', surface: 'the goal-mode toggle' },
  { command: 'guided-goal', surface: 'the guided goal-mode interview' },
  { command: 'loop', surface: 'the loop-mode toggle' },
  { command: 'queue', surface: 'the queued-message editor' }
]

/**
 * The terminal-only row a draft names, or null for every draft that must keep
 * its existing route.
 *
 * A registered CARD always wins: Orca driving the surface natively is strictly
 * better than telling the user to leave, and this ordering is what stops a
 * stale row here from shadowing a card added later for the same command.
 *
 * Matching is the card registry's rule — exact match on the whole normalized
 * invocation — so `/plan` is claimed and `/plan add auth` keeps the passthrough
 * path it works on today.
 */
export function findOmpRpcTerminalOnlyCommand(
  text: string,
  table: readonly OmpRpcTerminalOnlyCommand[] = OMP_RPC_TERMINAL_ONLY_COMMANDS
): OmpRpcTerminalOnlyCommand | null {
  const invocation = normalizeOmpRpcCommandInvocation(text)
  if (!invocation || hasOmpRpcInteractiveCommandCard(text)) {
    return null
  }
  return (
    table.find(
      (entry) => entry.command === invocation || entry.aliases?.includes(invocation) === true
    ) ?? null
  )
}

/** The notice text rendered as the command's local output. `isMac` is passed
 *  in rather than probed so the caller owns the one platform read and the
 *  string stays testable without a user-agent stub. */
export function ompRpcTerminalOnlyCommandNotice(
  entry: OmpRpcTerminalOnlyCommand,
  isMac: boolean
): string {
  return translate(
    'components.native-chat.terminalOnlyCommand.notice',
    '`/{{command}}` opens {{surface}}, which OMP only draws in the terminal view. Press {{shortcut}} to switch to it.',
    {
      command: entry.command,
      surface: entry.surface,
      shortcut: nativeChatToggleShortcutLabel(isMac)
    }
  )
}
