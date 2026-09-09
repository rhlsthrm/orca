// Session-family cards: that `/resume` offers exactly the sessions main
// returned and switches with the row's own absolute path, that `/branch`
// branches on the chosen entry id, that a failed read is an honest error and
// never an empty picker — and that `/session delete`, which OMP's text handler
// executes with no confirmation of its own, cannot reach the wire without an
// affirmative confirm naming the exact session.

import { describe, expect, it, vi } from 'vitest'
import type {
  OmpRpcChatResumableSession,
  OmpRpcChatSwitchSessionArgs
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcSessionState, OmpRpcSessionStats } from '../../../../shared/omp-rpc-protocol'
import {
  findOmpRpcInteractiveCommandCard,
  type OmpRpcChatCardApi,
  type OmpRpcInteractiveCardLoadResult,
  type OmpRpcInteractiveCardModel,
  type OmpRpcInteractiveCommandCard,
  type OmpRpcInteractiveCommandContext
} from './omp-rpc-interactive-command-registry'
import { OMP_RPC_SESSION_COMMAND_CARDS } from './omp-rpc-session-command-cards'

const PANE_KEY = 'tab-1:leaf-1'
const CWD = '/Users/ada/dev/projects/orca'

function card(command: string): OmpRpcInteractiveCommandCard {
  const found = OMP_RPC_SESSION_COMMAND_CARDS.find((entry) => entry.command === command)
  if (!found) {
    throw new Error(`no session card registered for /${command}`)
  }
  return found
}

/** A context over a fake of only the verbs the card under test calls: an
 *  unexpected verb is absent, so a card reaching for one fails loudly. */
function context(
  api: Partial<OmpRpcChatCardApi>,
  cwd: string | null = CWD
): OmpRpcInteractiveCommandContext {
  return { paneKey: PANE_KEY, cwd, api: api as OmpRpcChatCardApi }
}

function selectOptions(
  model: OmpRpcInteractiveCardLoadResult
): readonly { id: string; label: string; current?: boolean; disabled?: boolean }[] {
  if ('error' in model || model.kind !== 'select') {
    throw new Error(`expected a select card, got ${JSON.stringify(model)}`)
  }
  return model.options
}

function errorOf(model: OmpRpcInteractiveCardLoadResult): string {
  if (!('error' in model)) {
    throw new Error(`expected an error, got ${JSON.stringify(model)}`)
  }
  return model.error
}

function confirmOf(
  model: OmpRpcInteractiveCardLoadResult
): Extract<OmpRpcInteractiveCardModel, { kind: 'confirm' }> {
  if ('error' in model || model.kind !== 'confirm') {
    throw new Error(`expected a confirm card, got ${JSON.stringify(model)}`)
  }
  return model
}

function session(overrides: Partial<OmpRpcChatResumableSession>): OmpRpcChatResumableSession {
  return {
    sessionId: 'session-a',
    sessionPath: '/sessions/-orca/2026-08-01T00-00-00-000Z_session-a.jsonl',
    modifiedAtMs: Date.now() - 60_000,
    isCurrent: false,
    ...overrides
  }
}

function sessionState(overrides: Partial<OmpRpcSessionState> = {}): OmpRpcSessionState {
  return {
    sessionFile: '/sessions/-orca/2026-08-01T00-00-00-000Z_session-a.jsonl',
    sessionId: 'session-a',
    isStreaming: false,
    isCompacting: false,
    queuedMessageCount: 0,
    ...overrides
  }
}

describe('/resume', () => {
  it('offers exactly the sessions main returned, marking the one this pane is on', async () => {
    const listResumableSessions = vi.fn(async () => ({
      ok: true as const,
      data: [
        session({ sessionId: 'other', sessionPath: '/sessions/other.jsonl', name: 'Wire it up' }),
        session({ sessionId: 'mine', sessionPath: '/sessions/mine.jsonl', isCurrent: true })
      ]
    }))

    const model = await card('resume').load(context({ listResumableSessions }))

    expect(listResumableSessions).toHaveBeenCalledWith({ paneKey: PANE_KEY, cwd: CWD })
    expect(selectOptions(model)).toEqual([
      { id: '/sessions/other.jsonl', label: 'Wire it up', description: expect.any(String) },
      {
        id: '/sessions/mine.jsonl',
        label: 'mine',
        description: expect.any(String),
        // The session the pane already writes: marked, and not offerable —
        // switching onto it is a no-op that still costs a session move.
        current: true,
        disabled: true
      }
    ])
  })

  it('switches with the chosen row\u2019s own absolute session path', async () => {
    const switchSession = vi.fn<
      (args: OmpRpcChatSwitchSessionArgs) => Promise<{ ok: true; data: void }>
    >(async () => ({ ok: true, data: undefined }))

    const result = await card('resume').apply?.(context({ switchSession }), {
      kind: 'select',
      optionId: '/sessions/-orca/2026-08-02T00-00-00-000Z_target.jsonl'
    })

    expect(switchSession).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      sessionPath: '/sessions/-orca/2026-08-02T00-00-00-000Z_target.jsonl'
    })
    expect(result).toMatchObject({ ok: true })
  })

  it('surfaces a refused switch instead of reporting a resume that did not happen', async () => {
    const result = await card('resume').apply?.(
      context({ switchSession: async () => ({ ok: false, reason: 'session is streaming' }) }),
      { kind: 'select', optionId: '/sessions/target.jsonl' }
    )

    expect(result).toEqual({
      ok: false,
      message: 'That session could not be resumed: session is streaming'
    })
  })

  it('errors instead of showing an empty picker when the list cannot be read', async () => {
    const model = await card('resume').load(
      context({
        listResumableSessions: async () => ({
          ok: false,
          reason: 'no RPC-owned session for this pane'
        })
      })
    )

    expect(errorOf(model)).toContain('no RPC-owned session for this pane')
  })

  it('errors rather than listing another directory when the pane has no resolved cwd', async () => {
    const listResumableSessions = vi.fn()

    const model = await card('resume').load(context({ listResumableSessions }, null))

    expect(errorOf(model)).toContain('working directory')
    expect(listResumableSessions).not.toHaveBeenCalled()
  })

  it('errors when this directory has no saved session, rather than an empty list', async () => {
    const model = await card('resume').load(
      context({ listResumableSessions: async () => ({ ok: true, data: [] }) })
    )

    expect(errorOf(model)).toContain('no saved sessions')
  })
})

describe('/branch', () => {
  it('branches on the chosen entry id', async () => {
    const branch = vi.fn(async () => ({
      ok: true as const,
      data: { cancelled: false, text: 'hi' }
    }))
    const loaded = await card('branch').load(
      context({
        getBranchMessages: async () => ({
          ok: true,
          data: [
            { entryId: 'entry-1', text: 'first ask' },
            { entryId: 'entry-2', text: 'second ask' }
          ]
        })
      })
    )
    expect(selectOptions(loaded).map((option) => option.id)).toEqual(['entry-1', 'entry-2'])

    const result = await card('branch').apply?.(context({ branch }), {
      kind: 'select',
      optionId: 'entry-2'
    })

    expect(branch).toHaveBeenCalledWith({ paneKey: PANE_KEY, entryId: 'entry-2' })
    expect(result).toMatchObject({ ok: true })
  })

  it('reports a declined branch as a failure rather than a success', async () => {
    const result = await card('branch').apply?.(
      context({ branch: async () => ({ ok: true, data: { cancelled: true, text: 'ignored' } }) }),
      { kind: 'select', optionId: 'entry-1' }
    )

    expect(result).toMatchObject({ ok: false })
  })

  it('errors when the session has no user message to branch from', async () => {
    const model = await card('branch').load(
      context({ getBranchMessages: async () => ({ ok: true, data: [] }) })
    )

    expect(errorOf(model)).toContain('no user message')
  })
})

describe('/session', () => {
  it('reports OMP\u2019s own numbers and omits what it did not send', async () => {
    const model = await card('session').load(
      context({
        getState: async () => ({ ok: true, data: sessionState({ sessionName: 'Adapter work' }) }),
        getSessionStats: async () => ({
          ok: true,
          data: {
            sessionId: 'session-a',
            userMessages: 4,
            assistantMessages: 5,
            toolCalls: 9,
            toolResults: 9,
            totalMessages: 18,
            tokens: {
              input: 10,
              output: 20,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 30
            },
            premiumRequests: 2,
            cost: 1.5
          } satisfies OmpRpcSessionStats
        })
      })
    )

    if ('error' in model || model.kind !== 'dashboard') {
      throw new Error(`expected a dashboard, got ${JSON.stringify(model)}`)
    }
    const rows = Object.fromEntries(model.rows.map((row) => [row.label, row.value]))
    expect(rows).toMatchObject({
      Session: 'session-a',
      Name: 'Adapter work',
      Messages: '18',
      Tokens: '30',
      Cost: '$1.50'
    })
    // OMP sent no context usage, so the dashboard has no Context row at all —
    // an absent number is absent, never rendered as zero.
    expect(rows).not.toHaveProperty('Context')
  })

  it('still reports the state it could read when the statistics read fails, and says so', async () => {
    const model = await card('session').load(
      context({
        getState: async () => ({ ok: true, data: sessionState() }),
        getSessionStats: async () => ({ ok: false, reason: 'session is compacting' })
      })
    )

    if ('error' in model || model.kind !== 'dashboard') {
      throw new Error(`expected a dashboard, got ${JSON.stringify(model)}`)
    }
    expect(model.rows.map((row) => row.label)).toEqual(['Session', 'File'])
    expect(model.note).toContain('session is compacting')
  })

  it('errors when neither read answered', async () => {
    const model = await card('session').load(
      context({
        getState: async () => ({ ok: false, reason: 'no RPC-owned session for this pane' }),
        getSessionStats: async () => ({ ok: false, reason: 'no RPC-owned session for this pane' })
      })
    )

    expect(errorOf(model)).toContain('no RPC-owned session for this pane')
  })

  it('renames through set_session_name, refusing an empty name', async () => {
    const setSessionName = vi.fn(async () => ({ ok: true as const, data: undefined }))
    const ctx = context({ setSessionName })

    await expect(
      card('session rename').apply?.(ctx, { kind: 'input', text: '   ' })
    ).resolves.toMatchObject({ ok: false })
    expect(setSessionName).not.toHaveBeenCalled()

    await expect(
      card('session rename').apply?.(ctx, { kind: 'input', text: '  Adapter work  ' })
    ).resolves.toMatchObject({ ok: true })
    expect(setSessionName).toHaveBeenCalledWith({ paneKey: PANE_KEY, name: 'Adapter work' })
  })
})

describe('/session delete', () => {
  it('claims the argumented invocation, so its text can no longer reach OMP unguarded', () => {
    const matched = findOmpRpcInteractiveCommandCard('/session delete')

    expect(matched?.command).toBe('session delete')
    expect(matched?.destructive).toBe(true)
    // A confirm is the only card kind the router can gate a send behind.
    expect(matched?.kind).toBe('confirm')
  })

  it('names the exact session and dispatches nothing while loading', async () => {
    const getState = vi.fn(async () => ({
      ok: true as const,
      data: sessionState({ sessionName: 'Adapter work' })
    }))

    const model = await card('session delete').load(context({ getState }))

    const confirm = confirmOf(model)
    expect(confirm.prompt).toContain('Adapter work')
    expect(confirm.prompt).toContain('session-a')
    expect(confirm.prompt).toContain('/sessions/-orca/2026-08-01T00-00-00-000Z_session-a.jsonl')
    // The load is a read: the only verb it may touch is the state read, and
    // the fake carries no other, so any dispatch here would throw.
    expect(getState).toHaveBeenCalledTimes(1)
  })

  it('refuses to offer a confirm for a session OMP could not name', async () => {
    const model = await card('session delete').load(
      context({
        getState: async () => ({ ok: false, reason: 'no RPC-owned session for this pane' })
      })
    )

    expect(errorOf(model)).toContain('no RPC-owned session for this pane')
  })

  it('refuses a session with no file on disk instead of sending a delete that cannot work', async () => {
    const model = await card('session delete').load(
      context({ getState: async () => ({ ok: true, data: sessionState({ sessionFile: null }) }) })
    )

    expect(errorOf(model)).toContain('nothing to delete')
  })

  it('refuses while the session is streaming, which OMP would reject anyway', async () => {
    const model = await card('session delete').load(
      context({ getState: async () => ({ ok: true, data: sessionState({ isStreaming: true }) }) })
    )

    expect(errorOf(model)).toContain('streaming')
  })
})

describe('session card invariants', () => {
  it('gates every destructive session command behind a confirm', () => {
    const destructive = OMP_RPC_SESSION_COMMAND_CARDS.filter((entry) => entry.destructive === true)

    expect(destructive.map((entry) => entry.command)).toEqual(['session delete'])
    // A destructive card of any other kind would let a select or an input
    // answer become a destroy with no confirmation step in front of it.
    for (const entry of destructive) {
      expect(entry.kind).toBe('confirm')
    }
  })

  it('keeps an argumented invocation on its existing straight-to-RPC path', () => {
    // `/session pin <account>` has a text handler and no card: it must not be
    // captured by the bare `/session` dashboard.
    expect(findOmpRpcInteractiveCommandCard('/session pin work')).toBeNull()
    expect(findOmpRpcInteractiveCommandCard('/resume 019fced6')).toBeNull()
    // `/rename <title>` is a real advertised OMP command (hint `<title>`,
    // live-probed on 18.1.15) that already works; only its bare form, which
    // prints usage and nothing else, becomes a card.
    expect(findOmpRpcInteractiveCommandCard('/rename Adapter work')).toBeNull()
    expect(findOmpRpcInteractiveCommandCard('/rename')?.command).toBe('session rename')
    expect(findOmpRpcInteractiveCommandCard('/session')?.command).toBe('session')
    expect(findOmpRpcInteractiveCommandCard('/session info')?.command).toBe('session')
  })
})
