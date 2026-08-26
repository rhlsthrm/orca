// The composer's `/usage` branch: run the command on the RPC probe and hand its
// output back as a command-marker outcome, falling back to the keystroke path
// whenever the probe cannot answer. Extracted from NativeChatComposer so the
// composer stays inside the max-lines ratchet.

import { useCallback } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { sendNativeChatMessage } from './native-chat-runtime-send'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import type { NativeChatCommandMarkerOutcome } from './native-chat-command-marker'
import { runOmpLocalCommand, shouldRouteOmpLocalCommand } from './omp-rpc-local-command-route'

/** Returns a dispatcher that reports whether it claimed the draft. `false`
 *  means the caller must run its normal send path unchanged. */
export function useOmpRpcLocalCommandSend(args: {
  agent: AgentType
  ompRpcCwd: string | null
  resolveTarget: () => NativeChatResolvedTarget | null
  onSlashCommand?: (command: string, outcome?: NativeChatCommandMarkerOutcome) => void
}): (text: string) => boolean {
  const { agent, ompRpcCwd, resolveTarget, onSlashCommand } = args
  return useCallback(
    (text: string) => {
      if (!shouldRouteOmpLocalCommand(agent, text)) {
        return false
      }
      const command = text.trim()
      void runOmpLocalCommand(ompRpcCwd, command).then((outcome) => {
        if (outcome) {
          onSlashCommand?.(command, outcome)
          return
        }
        // Probe unavailable: fall back to the keystroke path so the command still
        // runs, just without rendered output.
        const target = resolveTarget()
        if (target) {
          sendNativeChatMessage(target.settings, target.ptyId, command)
          onSlashCommand?.(command)
        }
      })
      return true
    },
    [agent, ompRpcCwd, onSlashCommand, resolveTarget]
  )
}
