// Live slash-command catalog for OMP panes. Reads the main-process RPC probe
// once per (pane cwd) and merges the result over the static catalog; every
// failure path silently keeps today's static commands, because an unreachable
// probe must never empty the composer's `/` menu.

import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { OmpRpcSlashCommand } from '../../../../shared/omp-rpc-protocol'
import type { SlashCommandSuggestion } from '../../../../shared/native-chat-slash-commands'
import { resolveNativeChatTranscriptAgent } from '../../../../shared/native-chat-agent-support'
import {
  resolveNativeChatSkillDiscoveryCwd,
  selectNativeChatSkillStateInputs
} from './native-chat-skill-discovery-context'
import { mergeOmpRpcCommands } from './omp-rpc-command-catalog'

/** True when this pane's agent is OMP, the only agent with an RPC catalog.
 *  Accepts null: a caller (e.g. the TerminalPane-anchored ownership hook)
 *  may not have resolved an agent for the pane yet, which is never OMP. */
export function isOmpRpcCatalogAgent(agent: AgentType | null): boolean {
  return resolveNativeChatTranscriptAgent(agent) === 'omp'
}

// Shared across panes: two OMP panes in one workspace ask the same probe.
const catalogCache = new Map<string, OmpRpcSlashCommand[]>()
const inFlight = new Map<string, Promise<OmpRpcSlashCommand[] | null>>()

/** The pane's working directory, which keys the probe. Null for non-OMP panes,
 *  panes with no resolved agent yet, and panes whose workspace cannot be
 *  resolved — all three mean "no RPC". */
export function useOmpRpcProbeCwd(agent: AgentType | null, terminalTabId: string): string | null {
  const inputs = useAppStore(useShallow(selectNativeChatSkillStateInputs))
  const enabled = isOmpRpcCatalogAgent(agent)
  return useMemo(
    () => (enabled ? resolveNativeChatSkillDiscoveryCwd(inputs, terminalTabId) : null),
    [enabled, inputs, terminalTabId]
  )
}

export function useOmpRpcCommands(
  agent: AgentType,
  terminalTabId: string,
  staticCommands: readonly SlashCommandSuggestion[]
): readonly SlashCommandSuggestion[] {
  const enabled = isOmpRpcCatalogAgent(agent)
  const cwd = useOmpRpcProbeCwd(agent, terminalTabId)
  const [live, setLive] = useState<OmpRpcSlashCommand[] | null>(() =>
    cwd ? (catalogCache.get(cwd) ?? null) : null
  )

  useEffect(() => {
    if (!cwd) {
      setLive(null)
      return
    }
    const cached = catalogCache.get(cwd)
    if (cached) {
      setLive(cached)
      return
    }
    let cancelled = false
    void loadOmpRpcCommands(cwd).then((commands) => {
      if (!cancelled) {
        setLive(commands)
      }
    })
    return () => {
      cancelled = true
    }
  }, [cwd])

  return useMemo(
    () => (enabled ? mergeOmpRpcCommands(staticCommands, live) : staticCommands),
    [enabled, live, staticCommands]
  )
}

function loadOmpRpcCommands(cwd: string): Promise<OmpRpcSlashCommand[] | null> {
  const existing = inFlight.get(cwd)
  if (existing) {
    return existing
  }
  const request = Promise.resolve(window.api?.ompRpc?.getCommands({ cwd }))
    .then((result) => {
      if (!result?.ok) {
        return null
      }
      catalogCache.set(cwd, result.commands)
      return result.commands
    })
    // Why: a missing handler or a dead probe is a fallback, not an error the
    // composer surfaces — the static catalog already answers the `/` menu.
    .catch(() => null)
    .finally(() => {
      if (inFlight.get(cwd) === request) {
        inFlight.delete(cwd)
      }
    })
  inFlight.set(cwd, request)
  return request
}

export function resetOmpRpcCommandCacheForTests(): void {
  catalogCache.clear()
  inFlight.clear()
}
