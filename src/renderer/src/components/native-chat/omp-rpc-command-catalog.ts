// Merges OMP's live slash-command catalog into the composer's static one.
// Live commands arrive over a wire, so unlike the curated per-agent catalogs
// they are untrusted input: a name IS the dispatch token typed into the PTY,
// so anything that isn't a single safe token is dropped rather than sanitized.

import type { OmpRpcSlashCommand } from '../../../../shared/omp-rpc-protocol'
import type { SlashCommandSuggestion } from '../../../../shared/native-chat-slash-commands'
import {
  isSafeDisplayCharacter,
  stripUnsafeDisplayCharacters
} from '../../../../shared/skill-display-text'

const MAX_COMMAND_NAME_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 240

function isTokenSafeCommandName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_COMMAND_NAME_LENGTH &&
    !/\s/u.test(name) &&
    [...name].every(isSafeDisplayCharacter)
  )
}

/** OMP may publish names with or without the leading slash; the composer's
 *  catalog is slash-less and re-adds it at dispatch. */
function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, '')
}

function describe(command: OmpRpcSlashCommand): string | undefined {
  const description = command.description?.trim() ?? ''
  const hint = command.input?.hint?.trim() ?? ''
  const combined = hint ? (description ? `${description} — ${hint}` : hint) : description
  return combined
    ? stripUnsafeDisplayCharacters(combined).slice(0, MAX_DESCRIPTION_LENGTH)
    : undefined
}

/** Live catalog wins per name; static entries survive only where live has no
 *  command of that name, so enabling RPC can never shrink the menu. */
export function mergeOmpRpcCommands(
  staticCommands: readonly SlashCommandSuggestion[],
  liveCommands: readonly OmpRpcSlashCommand[] | null
): readonly SlashCommandSuggestion[] {
  if (!liveCommands || liveCommands.length === 0) {
    return staticCommands
  }
  const merged = new Map<string, SlashCommandSuggestion>()
  for (const command of liveCommands) {
    const name = normalizeCommandName(command.name ?? '')
    if (!isTokenSafeCommandName(name) || merged.has(name)) {
      continue
    }
    const description = describe(command)
    merged.set(name, { name, ...(description ? { description } : {}) })
  }
  if (merged.size === 0) {
    return staticCommands
  }
  for (const command of staticCommands) {
    if (!merged.has(command.name)) {
      merged.set(command.name, command)
    }
  }
  return [...merged.values()]
}
