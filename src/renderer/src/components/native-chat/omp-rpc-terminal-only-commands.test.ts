import { describe, expect, it, vi } from 'vitest'

// Real interpolation, so a notice that forgets a placeholder (or renders the
// wrong platform's chord) fails here instead of reading as prose.
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/gu, (_match, name: string) => String(options?.[name] ?? ''))
}))

import { hasOmpRpcInteractiveCommandCard } from './omp-rpc-interactive-command-registry'
import {
  findOmpRpcTerminalOnlyCommand,
  OMP_RPC_TERMINAL_ONLY_COMMANDS,
  ompRpcTerminalOnlyCommandNotice,
  type OmpRpcTerminalOnlyCommand
} from './omp-rpc-terminal-only-commands'

const ENTRY: OmpRpcTerminalOnlyCommand = { command: 'settings', surface: 'the settings menu' }

describe('findOmpRpcTerminalOnlyCommand', () => {
  it('claims a bare invocation and refuses an argumented one, so /plan add auth keeps its route', () => {
    const table = [ENTRY, { command: 'plan', surface: 'the plan-mode toggle' }]
    expect(findOmpRpcTerminalOnlyCommand('/settings', table)?.command).toBe('settings')
    expect(findOmpRpcTerminalOnlyCommand('  /settings  ', table)?.command).toBe('settings')
    expect(findOmpRpcTerminalOnlyCommand('/plan add auth', table)).toBeNull()
  })

  it('matches an alias, because OMP resolves it to the same TUI-only surface', () => {
    const table = [{ command: 'setup', aliases: ['providers'], surface: 'provider setup' }]
    expect(findOmpRpcTerminalOnlyCommand('/providers', table)?.command).toBe('setup')
  })

  it('ignores text that is not a slash invocation', () => {
    const table = [ENTRY]
    expect(findOmpRpcTerminalOnlyCommand('settings', table)).toBeNull()
    expect(findOmpRpcTerminalOnlyCommand('open /settings please', table)).toBeNull()
    expect(findOmpRpcTerminalOnlyCommand('/', table)).toBeNull()
  })

  // The precedence that keeps this table from rotting: the day a card lands for
  // `/agents`, a stale row here must not keep answering "go to the terminal".
  it('yields to a registered card even when a row claims the same command', () => {
    const shadowing = [{ command: 'switch', surface: 'the model picker' }]
    expect(hasOmpRpcInteractiveCommandCard('/switch')).toBe(true)
    expect(findOmpRpcTerminalOnlyCommand('/switch', shadowing)).toBeNull()
  })
})

describe('OMP_RPC_TERMINAL_ONLY_COMMANDS', () => {
  it('registers no invocation a card already drives', () => {
    const carded = OMP_RPC_TERMINAL_ONLY_COMMANDS.flatMap((entry) =>
      [entry.command, ...(entry.aliases ?? [])].filter((name) =>
        hasOmpRpcInteractiveCommandCard(`/${name}`)
      )
    )
    expect(carded).toEqual([])
  })

  it('registers every invocation exactly once, so no row can shadow another', () => {
    const seen = new Map<string, string>()
    for (const entry of OMP_RPC_TERMINAL_ONLY_COMMANDS) {
      for (const name of [entry.command, ...(entry.aliases ?? [])]) {
        expect(seen.get(name), `${name} registered twice`).toBeUndefined()
        seen.set(name, entry.command)
      }
    }
    expect(seen.size).toBeGreaterThan(0)
  })

  it('finds every registered row through the default table', () => {
    for (const entry of OMP_RPC_TERMINAL_ONLY_COMMANDS) {
      for (const name of [entry.command, ...(entry.aliases ?? [])]) {
        expect(findOmpRpcTerminalOnlyCommand(`/${name}`)?.command).toBe(entry.command)
      }
    }
  })
})

describe('ompRpcTerminalOnlyCommandNotice', () => {
  it('names the command and its surface, with the platform-correct toggle chord', () => {
    expect(ompRpcTerminalOnlyCommandNotice(ENTRY, false)).toBe(
      '`/settings` opens the settings menu, which OMP only draws in the terminal view. Press Ctrl+Shift+J to switch to it.'
    )
    expect(ompRpcTerminalOnlyCommandNotice(ENTRY, true)).toContain('⌘⇧J')
    expect(ompRpcTerminalOnlyCommandNotice(ENTRY, true)).not.toContain('Ctrl+Shift+J')
  })
})
