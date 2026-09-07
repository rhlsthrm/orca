<<<<<<< HEAD
// Routes the milestone-1 local command (`/usage`) off the PTY keystroke path and
// onto the RPC probe. Everything else keeps today's behavior verbatim.

import type { AgentType } from '../../../../shared/agent-status-types'
import type { OmpRpcRunLocalCommandResult } from '../../../../shared/omp-rpc-ipc-contract'
import { isAllowedOmpRpcLocalCommand } from '../../../../shared/omp-rpc-ipc-contract'
import { isOmpRpcCatalogAgent } from './use-omp-rpc-commands'

/** The outcome the composer records as a command marker. */
export type OmpRpcLocalCommandOutcome = {
  outputText: string
  agentInvoked: boolean
  truncated?: boolean
}

/** True when this exact draft must bypass the PTY and run over RPC. The draft
 *  must be the bare command — `/usage --json` is not allowlisted and keeps the
 *  existing typed path. */
export function shouldRouteOmpLocalCommand(agent: AgentType, text: string): boolean {
  return isOmpRpcCatalogAgent(agent) && isAllowedOmpRpcLocalCommand(text)
||||||| 8fa1b3c16c
=======
// Decides which of Orca's three OMP command transports a draft belongs on, and
// runs the session-less probe branch. The probe branch (`/usage`) is milestone
// 1; the session branch routes every other catalog command through the RPC
// child that already owns the pane, because that pane's PTY was killed on
// acquire and the keystroke path no longer exists for it.

import type { AgentType } from '../../../../shared/agent-status-types'
import type { OmpRpcRunLocalCommandResult } from '../../../../shared/omp-rpc-ipc-contract'
import { isAllowedOmpRpcLocalCommand } from '../../../../shared/omp-rpc-ipc-contract'
import {
  isOmpRpcCatalogAgent,
  isOmpRpcExecutableCommand,
  type OmpRpcExecutableCommands
} from './omp-rpc-command-catalog'

/** The outcome the composer records as a command marker. */
export type OmpRpcLocalCommandOutcome = {
  outputText: string
  agentInvoked: boolean
  truncated?: boolean
}

/** `probe` = the session-less RPC child; `session` = the RPC child owning this
 *  pane; `pty` = today's keystroke path. */
export type OmpRpcCommandRoute = 'probe' | 'session' | 'pty'

export type OmpRpcCommandRouteArgs = {
  agent: AgentType
  text: string
  isRpcOwned: boolean
  /** OMP's published RPC catalog reduced to its dispatch names. */
  executableCommands?: OmpRpcExecutableCommands | null
}

/**
 * Ordering is the contract, and proof of execution comes first: a command the
 * owning session's published catalog names is sent there, because that session
 * is alive by definition of ownership and is the one the answer is about — the
 * probe child is spawned session-less (`noSession`) and would report on a
 * session the pane is not in. Only when the catalog cannot prove the session
 * runs it does the allowlisted `/usage` fall through to that probe, which needs
 * no ownership and cannot contend for the owner's session file.
 *
 * The session route is gated on the catalog because OMP only runs a command on
 * `prompt` when its own lookup resolves: a TUI-only builtin (`/clear`) or
 * unknown slash text would otherwise be sent as a prompt and silently reach
 * the model instead. No catalog means no proof, so no session route — see
 * `isOmpRpcExecutableCommand`.
 */
export function resolveOmpRpcCommandRoute(args: OmpRpcCommandRouteArgs): OmpRpcCommandRoute {
  if (!isOmpRpcCatalogAgent(args.agent)) {
    return 'pty'
  }
  if (args.isRpcOwned && isOmpRpcExecutableCommand(args.text, args.executableCommands)) {
    return 'session'
  }
  if (isAllowedOmpRpcLocalCommand(args.text)) {
    return 'probe'
  }
  return 'pty'
}

/** True when this exact draft must bypass the PTY and run on the session-less
 *  probe. The draft must be the bare command — `/usage --json` is not
 *  allowlisted and keeps the existing typed path. Ownership is optional so a
 *  caller with no RPC session can keep asking the two-argument question. */
export function shouldRouteOmpLocalCommand(
  agent: AgentType,
  text: string,
  ownership?: Pick<OmpRpcCommandRouteArgs, 'isRpcOwned' | 'executableCommands'>
): boolean {
  return (
    resolveOmpRpcCommandRoute({
      agent,
      text,
      isRpcOwned: ownership?.isRpcOwned ?? false,
      executableCommands: ownership?.executableCommands
    }) === 'probe'
  )
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
}

/** Runs the command on the probe. Resolves null whenever the caller should fall
 *  back to the PTY path (no cwd, no handler, probe unavailable). */
export async function runOmpLocalCommand(
  cwd: string | null,
  command: string
): Promise<OmpRpcLocalCommandOutcome | null> {
  if (!cwd) {
    return null
  }
  let result: OmpRpcRunLocalCommandResult | undefined
  try {
    result = await window.api?.ompRpc?.runLocalCommand({ cwd, command: command.trim() })
  } catch {
    return null
  }
  if (!result?.ok) {
    return null
  }
  return {
    outputText: result.outputText,
    agentInvoked: result.agentInvoked,
    ...(result.truncated ? { truncated: true as const } : {})
  }
}
