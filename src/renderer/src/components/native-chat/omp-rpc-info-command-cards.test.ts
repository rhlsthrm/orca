// Informational/auth cards: that a picker shows exactly the rows OMP returned,
// that a dashboard reports OMP's own numbers and an honest error (never zeros)
// when the read fails, and that an export reports the path the child actually
// wrote rather than the one that was asked for.

import { describe, expect, it, vi } from 'vitest'
import type {
  OmpRpcLoginProvider,
  OmpRpcSessionState,
  OmpRpcSessionStats,
  OmpRpcSubagentSnapshot
} from '../../../../shared/omp-rpc-protocol'
import type {
  OmpRpcChatCardApi,
  OmpRpcInteractiveCardChoice,
  OmpRpcInteractiveCardModel,
  OmpRpcInteractiveCommandCard,
  OmpRpcInteractiveCommandContext
} from './omp-rpc-interactive-command-registry'
import { OMP_RPC_INFO_COMMAND_CARDS } from './omp-rpc-info-command-cards'

const PANE_KEY = 'pane-1'

function card(command: string): OmpRpcInteractiveCommandCard {
  const found = OMP_RPC_INFO_COMMAND_CARDS.find((entry) => entry.command === command)
  if (!found) {
    throw new Error(`no info card registered for /${command}`)
  }
  return found
}

/** A context over a fake of only the verbs the card under test calls: an
 *  unexpected verb is absent, so a card reaching for one fails loudly. */
function context(api: Partial<OmpRpcChatCardApi>): OmpRpcInteractiveCommandContext {
  // `cwd` is null on purpose: no card in this module reads it, so a card that
  // started depending on a directory would have to say so here.
  return { paneKey: PANE_KEY, cwd: null, api: api as OmpRpcChatCardApi }
}

function rowsOf(model: OmpRpcInteractiveCardModel | { error: string }): Record<string, string> {
  if ('error' in model || model.kind !== 'dashboard') {
    throw new Error(`expected a dashboard, got ${JSON.stringify(model)}`)
  }
  return Object.fromEntries(model.rows.map((row) => [row.label, row.value]))
}

function provider(overrides: Partial<OmpRpcLoginProvider>): OmpRpcLoginProvider {
  return { id: 'anthropic', name: 'Anthropic', available: true, authenticated: false, ...overrides }
}

function sessionState(overrides: Partial<OmpRpcSessionState>): OmpRpcSessionState {
  return {
    sessionFile: '/tmp/session.jsonl',
    sessionId: 'session-1',
    isStreaming: false,
    isCompacting: false,
    queuedMessageCount: 0,
    ...overrides
  }
}

function stats(overrides: Partial<OmpRpcSessionStats> = {}): OmpRpcSessionStats {
  return {
    sessionId: 'session-1',
    userMessages: 4,
    assistantMessages: 5,
    toolCalls: 12,
    toolResults: 11,
    totalMessages: 21,
    tokens: {
      input: 120_000,
      output: 3400,
      reasoning: 900,
      cacheRead: 45_000,
      cacheWrite: 2000,
      total: 171_300
    },
    premiumRequests: 3,
    cost: 1.2345,
    ...overrides
  }
}

function subagent(overrides: Partial<OmpRpcSubagentSnapshot>): OmpRpcSubagentSnapshot {
  return {
    id: 'sub-1',
    index: 1,
    agent: 'scout',
    agentSource: 'bundled',
    status: 'running',
    lastUpdate: 1,
    ...overrides
  }
}

const SELECT: (optionId: string) => OmpRpcInteractiveCardChoice = (optionId) => ({
  kind: 'select',
  optionId
})

describe('/login card', () => {
  it('offers exactly the providers the verb returned, in order', async () => {
    const getLoginProviders = vi.fn().mockResolvedValue({
      ok: true,
      data: [
        provider({ id: 'anthropic', name: 'Anthropic', authenticated: true }),
        provider({ id: 'openai', name: 'OpenAI' }),
        provider({ id: 'google', name: 'Google', available: false })
      ]
    })

    const model = await card('login').load(context({ getLoginProviders }))

    if ('error' in model || model.kind !== 'select') {
      throw new Error('expected a select card')
    }
    expect(model.options.map((option) => option.id)).toEqual(['anthropic', 'openai', 'google'])
    expect(model.options.map((option) => option.label)).toEqual(['Anthropic', 'OpenAI', 'Google'])
    // An unavailable provider is visible but cannot be picked; nothing is
    // marked `current`, since OMP reports per-provider authentication rather
    // than one active selection.
    expect(model.options.map((option) => option.disabled ?? false)).toEqual([false, false, true])
    expect(model.options.some((option) => option.current)).toBe(false)
    expect(getLoginProviders).toHaveBeenCalledWith({ paneKey: PANE_KEY })
  })

  it('reports the read failure instead of an empty picker', async () => {
    const model = await card('login').load(
      context({ getLoginProviders: vi.fn().mockResolvedValue({ ok: false, reason: 'no session' }) })
    )

    expect(model).toEqual({ error: 'OMP could not list login providers: no session' })
  })

  it('refuses to open a picker OMP gave no rows for', async () => {
    const model = await card('login').load(
      context({ getLoginProviders: vi.fn().mockResolvedValue({ ok: true, data: [] }) })
    )

    expect('error' in model && model.error).toBe(
      'OMP reported no login providers for this session.'
    )
  })

  it('logs in with the chosen provider id and reports the credential OMP stored', async () => {
    const login = vi.fn().mockResolvedValue({ ok: true, data: { providerId: 'openai-codex' } })

    const applied = await card('login').apply?.(context({ login }), SELECT('openai'))

    expect(login).toHaveBeenCalledWith({ paneKey: PANE_KEY, providerId: 'openai' })
    // The message names the provider the RESULT carries, not the row clicked:
    // upstream persists the credential it resolved, which can differ.
    expect(applied).toEqual({ ok: true, message: 'OMP stored the credential for openai-codex.' })
  })

  it('never claims a sign-in the result did not report', async () => {
    const applied = await card('login').apply?.(
      context({ login: vi.fn().mockResolvedValue({ ok: false, reason: 'oauth timed out' }) }),
      SELECT('openai')
    )

    expect(applied).toEqual({ ok: false, message: 'Login failed: oauth timed out' })
  })
})

describe('/context card', () => {
  it('reports the context numbers OMP sent', async () => {
    const model = await card('context').load(
      context({
        getState: vi.fn().mockResolvedValue({
          ok: true,
          data: sessionState({
            contextUsage: { tokens: 42_137, contextWindow: 200_000, percent: 21.0685 },
            model: {
              id: 'claude-opus-5',
              name: 'Claude Opus 5',
              provider: 'anthropic'
            }
          })
        })
      })
    )

    expect(rowsOf(model)).toEqual({
      'Tokens used': '42,137',
      'Context window': '200,000',
      Used: '21.1%',
      Model: 'Claude Opus 5 (anthropic/claude-opus-5)'
    })
  })

  it('says the usage is missing rather than rendering zeros', async () => {
    const absent = await card('context').load(
      context({ getState: vi.fn().mockResolvedValue({ ok: true, data: sessionState({}) }) })
    )
    const failed = await card('context').load(
      context({ getState: vi.fn().mockResolvedValue({ ok: false, reason: 'pane not owned' }) })
    )

    expect(absent).toEqual({ error: 'OMP reported no context usage for this session.' })
    expect(failed).toEqual({ error: 'OMP could not report context usage: pane not owned' })
  })
})

describe('/stats card', () => {
  it('reports the stats OMP sent', async () => {
    const model = await card('stats').load(
      context({
        getSessionStats: vi.fn().mockResolvedValue({
          ok: true,
          data: stats({
            sessionFile: '/tmp/session.jsonl',
            credits: { cost: 0.5, committedCost: 0.75, acuCost: 12 },
            routedModels: { 'gpt-6-astra': 7 },
            contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 0.5 }
          })
        })
      })
    )

    expect(rowsOf(model)).toEqual({
      Session: 'session-1',
      'Session file': '/tmp/session.jsonl',
      Messages: '21 total · 4 user · 5 assistant',
      Tools: '12 calls · 11 results',
      Tokens: '171,300',
      'Tokens in / out': '120,000 in · 3,400 out',
      'Reasoning tokens': '900',
      'Cache read / write': '45,000 read · 2,000 written',
      'Premium requests': '3',
      Cost: '$1.23',
      Credits: '$0.50 · $0.75 committed · 12 ACU',
      'Routed · gpt-6-astra': '7 turns',
      Context: '1,000 / 200,000 · 0.5%'
    })
  })

  it('omits the provider-conditional rows OMP did not send and says usage is absent', async () => {
    const model = await card('stats').load(
      context({ getSessionStats: vi.fn().mockResolvedValue({ ok: true, data: stats() }) })
    )

    const rows = rowsOf(model)
    expect(Object.keys(rows)).not.toContain('Credits')
    expect(Object.keys(rows)).not.toContain('Context')
    expect(Object.keys(rows).some((label) => label.startsWith('Routed'))).toBe(false)
    expect('note' in model && model.note).toBe(
      'OMP reported no context-window usage with these stats.'
    )
  })

  it('surfaces a failed read as an error', async () => {
    const model = await card('stats').load(
      context({
        getSessionStats: vi.fn().mockResolvedValue({ ok: false, reason: 'session busy' })
      })
    )

    expect(model).toEqual({ error: 'OMP could not report session stats: session busy' })
  })
})

describe('subagents card', () => {
  it('reports each subagent OMP listed with its live progress', async () => {
    const model = await card('subagents').load(
      context({
        getSubagents: vi.fn().mockResolvedValue({
          ok: true,
          data: [
            subagent({
              index: 1,
              agent: 'scout',
              description: 'Map the RPC verbs',
              progress: {
                id: 'sub-1',
                index: 1,
                agent: 'scout',
                status: 'running',
                task: 'Map the RPC verbs',
                currentTool: 'grep',
                toolCount: 14,
                tokens: 31_500
              }
            }),
            subagent({ id: 'sub-2', index: 2, agent: 'reviewer', status: 'completed' })
          ]
        })
      })
    )

    expect(rowsOf(model)).toEqual({
      '#1 scout': 'running · Map the RPC verbs · in grep · 14 tools · 31,500 tokens',
      '#2 reviewer': 'completed'
    })
  })

  it('says there are none rather than pretending the read failed', async () => {
    const model = await card('subagents').load(
      context({ getSubagents: vi.fn().mockResolvedValue({ ok: true, data: [] }) })
    )

    expect(rowsOf(model)).toEqual({})
    expect('note' in model && model.note).toBe('OMP reported no subagents for this session.')
  })
})

describe('/export card', () => {
  it('exports to the typed path and reports the path the child wrote', async () => {
    const exportHtml = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { path: '/Users/me/exports/session-1.html' } })

    const applied = await card('export').apply?.(context({ exportHtml }), {
      kind: 'input',
      text: '  ~/exports/session.html  '
    })

    expect(exportHtml).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      outputPath: '~/exports/session.html'
    })
    // The written path, not the requested one: OMP resolves and may relocate it.
    expect(applied).toEqual({ ok: true, message: 'Exported to /Users/me/exports/session-1.html' })
  })

  it('lets OMP choose the file when no path was typed', async () => {
    const exportHtml = vi.fn().mockResolvedValue({ ok: true, data: { path: '/tmp/omp.html' } })

    await card('export').apply?.(context({ exportHtml }), { kind: 'input', text: '   ' })

    expect(exportHtml).toHaveBeenCalledWith({ paneKey: PANE_KEY })
  })

  it('admits it when the result carries no path', async () => {
    const applied = await card('export').apply?.(
      context({ exportHtml: vi.fn().mockResolvedValue({ ok: true, data: { path: '' } }) }),
      { kind: 'input', text: '' }
    )

    expect(applied).toEqual({
      ok: true,
      message: 'OMP exported the transcript but reported no output path.'
    })
  })

  it('reports an export failure', async () => {
    const applied = await card('export').apply?.(
      context({ exportHtml: vi.fn().mockResolvedValue({ ok: false, reason: 'write denied' }) }),
      { kind: 'input', text: '/root/x.html' }
    )

    expect(applied).toEqual({ ok: false, message: 'Export failed: write denied' })
  })
})
