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
