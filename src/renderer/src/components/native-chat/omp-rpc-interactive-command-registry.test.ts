import { describe, expect, it } from 'vitest'
import {
  applyOmpRpcInteractiveCard,
  findOmpRpcInteractiveCommandCard,
  loadOmpRpcInteractiveCard,
  OMP_RPC_INTERACTIVE_COMMAND_CARDS,
  type OmpRpcInteractiveCommandCard,
  type OmpRpcInteractiveCommandContext
} from './omp-rpc-interactive-command-registry'

const CTX = {
  paneKey: 'pane-1',
  cwd: '/repo',
  api: {}
} as unknown as OmpRpcInteractiveCommandContext

function card(overrides: Partial<OmpRpcInteractiveCommandCard> = {}): OmpRpcInteractiveCommandCard {
  return {
    command: 'switch',
    title: 'Model',
    kind: 'select',
    load: () => Promise.resolve({ kind: 'select', options: [] }),
    ...overrides
  }
}

describe('findOmpRpcInteractiveCommandCard', () => {
  it('claims a bare invocation and refuses an argumented one, so /switch <model> keeps its wire route', () => {
    const cards = [card()]
    expect(findOmpRpcInteractiveCommandCard('/switch', cards)?.command).toBe('switch')
    expect(findOmpRpcInteractiveCommandCard('  /switch  ', cards)?.command).toBe('switch')
    expect(findOmpRpcInteractiveCommandCard('/switch gpt-6-astra', cards)).toBeNull()
  })

  it('matches an alias and a multi-word registration, collapsing whitespace', () => {
    const cards = [
      card({ command: 'switch', aliases: ['model'] }),
      card({ command: 'session delete', kind: 'confirm', destructive: true })
    ]
    expect(findOmpRpcInteractiveCommandCard('/model', cards)?.command).toBe('switch')
    expect(findOmpRpcInteractiveCommandCard('/session   delete', cards)?.command).toBe(
      'session delete'
    )
    // A different argument to the same head is not a registered invocation.
    expect(findOmpRpcInteractiveCommandCard('/session pin acme', cards)).toBeNull()
  })

  it('ignores text that is not a slash command', () => {
    const cards = [card()]
    expect(findOmpRpcInteractiveCommandCard('switch', cards)).toBeNull()
    expect(findOmpRpcInteractiveCommandCard('please /switch', cards)).toBeNull()
    expect(findOmpRpcInteractiveCommandCard('/', cards)).toBeNull()
  })
})

describe('OMP_RPC_INTERACTIVE_COMMAND_CARDS', () => {
  // Three independently authored families share one namespace, and a collision
  // silently shadows the losing card (lookup takes the first match).
  it('registers every invocation exactly once across the families', () => {
    const seen = new Map<string, string>()
    const collisions: string[] = []
    for (const entry of OMP_RPC_INTERACTIVE_COMMAND_CARDS) {
      for (const invocation of [entry.command, ...(entry.aliases ?? [])]) {
        const owner = seen.get(invocation)
        if (owner) {
          collisions.push(`${invocation}: ${owner} and ${entry.command}`)
        }
        seen.set(invocation, entry.command)
      }
    }
    expect(collisions).toEqual([])
  })

  it('gives every card an apply unless it is a read-only dashboard or a confirm gate', () => {
    const actionable = OMP_RPC_INTERACTIVE_COMMAND_CARDS.filter(
      (entry) => !entry.apply && entry.kind !== 'dashboard' && entry.destructive !== true
    ).map((entry) => entry.command)
    expect(actionable).toEqual([])
  })
})

describe('loadOmpRpcInteractiveCard / applyOmpRpcInteractiveCard', () => {
  it('turns an adapter throw into an error model instead of leaving the card loading', async () => {
    const thrown = card({
      load: () => {
        throw new Error('verb blew up')
      }
    })
    await expect(loadOmpRpcInteractiveCard(thrown, CTX)).resolves.toEqual({
      error: '/switch could not be read: verb blew up'
    })
  })

  it('turns an apply throw into a refusal the card can show', async () => {
    const thrown = card({
      apply: () => Promise.reject(new Error('wire closed'))
    })
    await expect(
      applyOmpRpcInteractiveCard(thrown, CTX, { kind: 'select', optionId: 'x' })
    ).resolves.toEqual({ ok: false, message: '/switch failed: wire closed' })
  })

  it('refuses to answer a card that has no action', async () => {
    await expect(applyOmpRpcInteractiveCard(card(), CTX, { kind: 'confirm' })).resolves.toEqual({
      ok: false,
      message: '/switch has no action to apply.'
    })
  })
})
