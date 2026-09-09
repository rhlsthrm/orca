// Binds the composer's `/` and skill picker to the command catalog for this
// pane: the static/structured catalog, the live OMP RPC commands that outrank
// it, and the probe cwd those RPC lookups key on. The pane also runs local RPC
// commands against that cwd, so it is returned alongside the picker rather than
// re-derived by the caller.

import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { OmpRpcSlashCommand } from '../../../../shared/omp-rpc-protocol'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { useNativeChatComposerCatalog } from './use-native-chat-composer-catalog'
import { useOmpRpcCommands, useOmpRpcProbeCwd } from './use-omp-rpc-commands'
import {
  useNativeChatPickerState,
  type NativeChatPickerState
} from './use-native-chat-picker-state'

export type NativeChatComposerCommandPicker = {
  picker: NativeChatPickerState
  /** Working directory the RPC command probe keyed on; null when this pane has
   *  no local RPC route. */
  ompRpcCwd: string | null
}

export function useNativeChatComposerCommandPicker(args: {
  agent: AgentType
  terminalTabId: string
  /** Stable pane identity scoping picker dismissals to this composer. */
  draftScopeKey: string
  draft: string
  caret: number
  structuredTransport?: NativeChatStructuredComposerTransport
  /** Catalog published by the RPC session owning this pane, if any. */
  sessionCommands?: readonly OmpRpcSlashCommand[] | null
  textareaRef: RefObject<HTMLTextAreaElement | null>
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  setActiveSuggestion: Dispatch<SetStateAction<number>>
}): NativeChatComposerCommandPicker {
  const {
    agent,
    terminalTabId,
    draftScopeKey,
    draft,
    caret,
    structuredTransport,
    sessionCommands,
    textareaRef,
    setDraft,
    setCaret,
    setActiveSuggestion
  } = args
  const { agentCommands: staticAgentCommands, sessionSkillNames } = useNativeChatComposerCatalog(
    agent,
    structuredTransport
  )
  const agentCommands = useOmpRpcCommands(
    agent,
    terminalTabId,
    staticAgentCommands,
    sessionCommands
  )
  const ompRpcCwd = useOmpRpcProbeCwd(agent, terminalTabId)
  const picker = useNativeChatPickerState({
    agent,
    terminalTabId,
    draftScopeKey,
    draft,
    caret,
    agentCommands,
    sessionSkillNames,
    textareaRef,
    setDraft,
    setCaret,
    setActiveSuggestion
  })
  return { picker, ompRpcCwd }
}
