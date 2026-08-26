import { describe, expect, it } from 'vitest'
import type { OmpRpcSlashCommand } from '../../../../shared/omp-rpc-protocol'
import { mergeOmpRpcCommands } from './omp-rpc-command-catalog'

const STATIC = [
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'help', description: 'Show available commands' }
] as const

describe('mergeOmpRpcCommands', () => {
  it('falls back to the static catalog when the probe returned nothing', () => {
    expect(mergeOmpRpcCommands(STATIC, null)).toBe(STATIC)
    expect(mergeOmpRpcCommands(STATIC, [])).toBe(STATIC)
  })

  it('prefers the live entry for a name the static catalog also has', () => {
    const merged = mergeOmpRpcCommands(STATIC, [
      { name: 'help', description: 'Live help text' },
      { name: 'usage', description: 'Show account usage' }
    ])
    expect(merged).toEqual([
      { name: 'help', description: 'Live help text' },
      { name: 'usage', description: 'Show account usage' },
      { name: 'clear', description: 'Clear the conversation' }
    ])
  })

  it('keeps static commands the live catalog omits, so enabling RPC never shrinks the menu', () => {
    const names = mergeOmpRpcCommands(STATIC, [{ name: 'usage' }]).map((command) => command.name)
    expect(names).toEqual(['usage', 'clear', 'help'])
  })

  it('strips a leading slash and folds the input hint into the description', () => {
    expect(
      mergeOmpRpcCommands(
        [],
        [{ name: '/model', description: 'Pick a model', input: { hint: '<name>' } }]
      )
    ).toEqual([{ name: 'model', description: 'Pick a model — <name>' }])
    expect(mergeOmpRpcCommands([], [{ name: 'side', input: { hint: '<topic>' } }])).toEqual([
      { name: 'side', description: '<topic>' }
    ])
  })

  it('omits the description entirely when the live entry has none', () => {
    expect(mergeOmpRpcCommands([], [{ name: 'usage' }])).toEqual([{ name: 'usage' }])
  })

  it('drops live names that are not a single safe token', () => {
    // The name IS the token typed into the PTY, so wire text can never be
    // sanitized into one; an unsafe name is dropped, not repaired.
    const unsafe: OmpRpcSlashCommand[] = [
      { name: 'two words' },
      { name: '' },
      { name: '/' },
      { name: 'bell' },
      { name: 'x'.repeat(201) },
      { name: 'safe' }
    ]
    expect(mergeOmpRpcCommands([], unsafe)).toEqual([{ name: 'safe' }])
  })

  it('keeps the first entry when the live catalog repeats a name', () => {
    expect(
      mergeOmpRpcCommands(
        [],
        [
          { name: 'usage', description: 'first' },
          { name: 'usage', description: 'second' }
        ]
      )
    ).toEqual([{ name: 'usage', description: 'first' }])
  })

  it('falls back to static when every live name was rejected', () => {
    expect(mergeOmpRpcCommands(STATIC, [{ name: 'two words' }])).toBe(STATIC)
  })

  it('merges a large live catalog without truncating (the picker caps rendering)', () => {
    const live = Array.from({ length: 487 }, (_, index) => ({ name: `cmd${index}` }))
    expect(mergeOmpRpcCommands(STATIC, live)).toHaveLength(489)
  })
})
