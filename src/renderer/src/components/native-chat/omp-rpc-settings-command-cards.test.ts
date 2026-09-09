import { describe, expect, it, vi } from 'vitest'
import type { OmpRpcModel, OmpRpcSessionState } from '../../../../shared/omp-rpc-protocol'
import {
  findOmpRpcInteractiveCommandCard,
  type OmpRpcInteractiveCommandCard,
  type OmpRpcInteractiveCommandContext
} from './omp-rpc-interactive-command-registry'
import { OMP_RPC_SETTINGS_COMMAND_CARDS } from './omp-rpc-settings-command-cards'

function model(overrides: Partial<OmpRpcModel> = {}): OmpRpcModel {
  return { id: 'gpt-6-astra', name: 'GPT-6 Astra', provider: 'openai-codex', ...overrides }
}

function settingsCard(invocation: string): OmpRpcInteractiveCommandCard {
  const card = findOmpRpcInteractiveCommandCard(invocation, OMP_RPC_SETTINGS_COMMAND_CARDS)
  if (!card) {
    throw new Error(`no settings card for ${invocation}`)
  }
  return card
}

type FakeApi = Record<string, ReturnType<typeof vi.fn>>

function context(api: FakeApi): { ctx: OmpRpcInteractiveCommandContext; api: FakeApi } {
  return {
    ctx: { paneKey: 'pane-1', cwd: '/repo', api } as unknown as OmpRpcInteractiveCommandContext,
    api
  }
}

function state(overrides: Partial<OmpRpcSessionState> = {}): OmpRpcSessionState {
  return {
    sessionFile: null,
    sessionId: null,
    isStreaming: false,
    isCompacting: false,
    queuedMessageCount: 0,
    ...overrides
  }
}

describe('/switch + /model', () => {
  it('lists the models the verb returned and marks the one the child reports', async () => {
    const { ctx } = context({
      getAvailableModels: vi
        .fn()
        .mockResolvedValue({
          ok: true,
          data: [model(), model({ id: 'opus-5', name: 'Opus 5', provider: 'anthropic' })]
        }),
      getState: vi
        .fn()
        .mockResolvedValue({
          ok: true,
          data: state({ model: model({ id: 'opus-5', name: 'Opus 5', provider: 'anthropic' }) })
        })
    })

    const loaded = await settingsCard('/switch').load(ctx)

    expect(loaded).toEqual({
      kind: 'select',
      options: [
        {
          id: '["openai-codex","gpt-6-astra"]',
          label: 'GPT-6 Astra',
          description: 'openai-codex'
        },
        {
          id: '["anthropic","opus-5"]',
          label: 'Opus 5',
          description: 'anthropic',
          current: true
        }
      ]
    })
  })

  it('is reachable as /model too', () => {
    expect(settingsCard('/model').command).toBe('switch')
  })

  it('marks nothing current and says so when the child reports no model', async () => {
    const { ctx } = context({
      getAvailableModels: vi.fn().mockResolvedValue({ ok: true, data: [model()] }),
      getState: vi.fn().mockResolvedValue({ ok: false, reason: 'omp_rpc_state_unreadable' })
    })

    const loaded = await settingsCard('/switch').load(ctx)

    expect(loaded).toMatchObject({
      kind: 'select',
      note: expect.stringContaining('did not report')
    })
    expect(loaded).not.toHaveProperty('options.0.current')
  })

  it('reports an error rather than an empty picker when the model list is refused', async () => {
    const { ctx } = context({
      getAvailableModels: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'omp_rpc_command_refused' }),
      getState: vi.fn().mockResolvedValue({ ok: true, data: state() })
    })

    await expect(settingsCard('/switch').load(ctx)).resolves.toEqual({
      error: 'OMP could not list its models: omp_rpc_command_refused'
    })
  })

  it('dispatches the chosen row as an exact provider + modelId pair', async () => {
    const { ctx, api } = context({
      setModel: vi
        .fn()
        .mockResolvedValue({
          ok: true,
          data: model({ id: 'opus-5', name: 'Opus 5', provider: 'anthropic' })
        })
    })

    const applied = await settingsCard('/switch').apply?.(ctx, {
      kind: 'select',
      optionId: '["anthropic","opus-5"]'
    })

    expect(api.setModel).toHaveBeenCalledWith({
      paneKey: 'pane-1',
      provider: 'anthropic',
      modelId: 'opus-5'
    })
    // The message quotes what the CHILD selected, not what was requested.
    expect(applied).toEqual({ ok: true, message: 'Model set to Opus 5 (anthropic).' })
  })

  it('sends nothing for a row id it cannot read back', async () => {
    const { ctx, api } = context({ setModel: vi.fn() })

    const applied = await settingsCard('/switch').apply?.(ctx, {
      kind: 'select',
      optionId: 'openai-codex/gpt-6'
    })

    expect(api.setModel).not.toHaveBeenCalled()
    expect(applied?.ok).toBe(false)
  })

  it('surfaces a refused model change instead of claiming it took', async () => {
    const { ctx } = context({
      setModel: vi.fn().mockResolvedValue({ ok: false, reason: 'omp_rpc_command_refused' })
    })

    await expect(
      settingsCard('/switch').apply?.(ctx, { kind: 'select', optionId: '["anthropic","opus-5"]' })
    ).resolves.toEqual({
      ok: false,
      message: 'Model could not be changed: omp_rpc_command_refused'
    })
  })
})

describe('/thinking', () => {
  it('marks the level the child reports and dispatches the chosen one', async () => {
    const { ctx, api } = context({
      getState: vi.fn().mockResolvedValue({ ok: true, data: state({ thinkingLevel: 'high' }) }),
      setThinkingLevel: vi.fn().mockResolvedValue({ ok: true, data: undefined })
    })
    const card = settingsCard('/thinking')

    const loaded = await card.load(ctx)
    expect(loaded).toMatchObject({ kind: 'select' })
    const options = 'options' in loaded ? loaded.options : []
    expect(options.filter((option) => option.current)).toEqual([
      { id: 'high', label: 'High', current: true }
    ])

    await expect(card.apply?.(ctx, { kind: 'select', optionId: 'minimal' })).resolves.toEqual({
      ok: true,
      message: 'Thinking level set to Minimal.'
    })
    expect(api.setThinkingLevel).toHaveBeenCalledWith({ paneKey: 'pane-1', level: 'minimal' })
  })

  it('refuses a level OMP does not accept without touching the wire', async () => {
    const { ctx, api } = context({ setThinkingLevel: vi.fn() })

    const applied = await settingsCard('/thinking').apply?.(ctx, {
      kind: 'select',
      optionId: 'turbo'
    })

    expect(api.setThinkingLevel).not.toHaveBeenCalled()
    expect(applied?.ok).toBe(false)
  })
})

describe('/fast', () => {
  it('discloses that the child reported fast mode enabled but inactive', async () => {
    const { ctx } = context({
      getState: vi
        .fn()
        .mockResolvedValue({
          ok: true,
          data: state({ fastModeEnabled: true, fastModeActive: false })
        })
    })

    const loaded = await settingsCard('/fast').load(ctx)

    expect(loaded).toMatchObject({ note: expect.stringContaining('not active') })
  })

  it('reports the state the verb answered with rather than the request', async () => {
    const { ctx, api } = context({
      setFastMode: vi.fn().mockResolvedValue({ ok: true, data: { enabled: true, active: false } })
    })

    const applied = await settingsCard('/fast').apply?.(ctx, { kind: 'select', optionId: 'on' })

    expect(api.setFastMode).toHaveBeenCalledWith({ paneKey: 'pane-1', enabled: true })
    expect(applied).toEqual({
      ok: true,
      message: 'Fast mode enabled, but the current model cannot serve it.'
    })
  })
})

describe('/compact', () => {
  it('is the one settings card that invokes the agent', () => {
    expect(settingsCard('/compact').invokesAgent).toBe(true)
    expect(settingsCard('/switch').invokesAgent).toBeUndefined()
  })

  it('passes typed instructions through and omits the field when blank', async () => {
    const { ctx, api } = context({
      compact: vi
        .fn()
        .mockResolvedValue({
          ok: true,
          data: { summary: 's', firstKeptEntryId: 'e1', tokensBefore: 10 }
        })
    })
    const card = settingsCard('/compact')

    await card.apply?.(ctx, { kind: 'input', text: '  keep the API decisions  ' })
    expect(api.compact).toHaveBeenLastCalledWith({
      paneKey: 'pane-1',
      customInstructions: 'keep the API decisions'
    })

    await card.apply?.(ctx, { kind: 'input', text: '   ' })
    expect(api.compact).toHaveBeenLastCalledWith({ paneKey: 'pane-1' })
  })
})

describe('queue and compaction toggles', () => {
  it('marks the reported steering mode and dispatches the chosen one', async () => {
    const { ctx, api } = context({
      getState: vi
        .fn()
        .mockResolvedValue({ ok: true, data: state({ steeringMode: 'one-at-a-time' }) }),
      setSteeringMode: vi.fn().mockResolvedValue({ ok: true, data: undefined })
    })
    const card = settingsCard('/steering')

    const loaded = await card.load(ctx)
    const options = 'options' in loaded ? loaded.options : []
    expect(options.find((option) => option.current)?.id).toBe('one-at-a-time')

    await card.apply?.(ctx, { kind: 'select', optionId: 'all' })
    expect(api.setSteeringMode).toHaveBeenCalledWith({ paneKey: 'pane-1', mode: 'all' })
  })

  it('routes follow-up and interrupt to their own verbs', async () => {
    const { ctx, api } = context({
      setFollowUpMode: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
      setInterruptMode: vi.fn().mockResolvedValue({ ok: true, data: undefined })
    })

    await settingsCard('/follow-up').apply?.(ctx, { kind: 'select', optionId: 'all' })
    await settingsCard('/interrupt').apply?.(ctx, { kind: 'select', optionId: 'wait' })

    expect(api.setFollowUpMode).toHaveBeenCalledWith({ paneKey: 'pane-1', mode: 'all' })
    expect(api.setInterruptMode).toHaveBeenCalledWith({ paneKey: 'pane-1', mode: 'wait' })
  })

  it('leaves automatic compaction unmarked while the child reports nothing', async () => {
    const { ctx, api } = context({
      getState: vi.fn().mockResolvedValue({ ok: true, data: state() }),
      setAutoCompaction: vi.fn().mockResolvedValue({ ok: true, data: undefined })
    })
    const card = settingsCard('/auto-compact')

    const loaded = await card.load(ctx)
    const options = 'options' in loaded ? loaded.options : []
    expect(options.some((option) => option.current)).toBe(false)
    expect(loaded).toMatchObject({ note: expect.stringContaining('did not report') })

    await card.apply?.(ctx, { kind: 'select', optionId: 'off' })
    expect(api.setAutoCompaction).toHaveBeenCalledWith({ paneKey: 'pane-1', enabled: false })
  })
})
