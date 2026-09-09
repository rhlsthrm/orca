// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  useOmpRpcInteractiveCard,
  type OmpRpcInteractiveCardResolution
} from './use-omp-rpc-interactive-card'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

type FakeChatApi = Record<string, ReturnType<typeof vi.fn>>

function seedApi(api: FakeChatApi): void {
  // Test seam: the cards reach the preload bridge through `window.api`, and a
  // fake with only the probed verbs cannot satisfy the full PreloadApi type.
  const bridge = { ompRpcChat: api } as unknown as typeof window.api
  window.api = bridge
}

afterEach(() => {
  Reflect.deleteProperty(window, 'api')
})

const MODEL = { id: 'gpt-6-astra', name: 'GPT-6 Astra', provider: 'openai-codex' }
const OPUS = { id: 'opus-5', name: 'Opus 5', provider: 'anthropic' }

function renderCard(
  overrides: {
    command?: string
    confirmGate?: (command: string) => boolean
  } = {}
) {
  const onApplied = vi.fn<(resolution: OmpRpcInteractiveCardResolution) => void>()
  const onDismiss = vi.fn<() => void>()
  const confirmGate = vi.fn(overrides.confirmGate ?? (() => true))
  const hook = renderHook(() =>
    useOmpRpcInteractiveCard({
      open: { cardId: 'card-1', command: overrides.command ?? 'switch' },
      paneKey: 'pane-1',
      cwd: '/repo',
      confirmGate,
      onApplied,
      onDismiss
    })
  )
  return { hook, onApplied, onDismiss, confirmGate }
}

describe('useOmpRpcInteractiveCard', () => {
  it('loads a bare /switch into a model picker that marks the current model', async () => {
    seedApi({
      getAvailableModels: vi.fn().mockResolvedValue({ ok: true, data: [MODEL, OPUS] }),
      getState: vi.fn().mockResolvedValue({ ok: true, data: { model: OPUS } })
    })
    const { hook } = renderCard()

    expect(hook.result.current.view.phase).toBe('loading')
    await waitFor(() => expect(hook.result.current.view.phase).toBe('ready'))
    const view = hook.result.current.view
    if (view.phase !== 'ready' || view.model.kind !== 'select') {
      throw new Error('expected a ready select card')
    }
    expect(view.model.options.map((option) => option.label)).toEqual(['GPT-6 Astra', 'Opus 5'])
    expect(view.model.options.filter((option) => option.current === true)).toHaveLength(1)
    expect(view.model.options[1]?.current).toBe(true)
  })

  it('dispatches the picked model as the exact provider + modelId the row named', async () => {
    const setModel = vi.fn().mockResolvedValue({ ok: true, data: OPUS })
    seedApi({
      getAvailableModels: vi.fn().mockResolvedValue({ ok: true, data: [MODEL, OPUS] }),
      getState: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      setModel
    })
    const { hook, onApplied, onDismiss } = renderCard()
    await waitFor(() => expect(hook.result.current.view.phase).toBe('ready'))
    const view = hook.result.current.view
    if (view.phase !== 'ready' || view.model.kind !== 'select') {
      throw new Error('expected a ready select card')
    }

    const optionIds = view.model.options.map((option) => option.id)

    await act(async () => {
      hook.result.current.choose({ kind: 'select', optionId: optionIds[1] ?? '' })
    })

    expect(setModel).toHaveBeenCalledWith({
      paneKey: 'pane-1',
      provider: 'anthropic',
      modelId: 'opus-5'
    })
    expect(onApplied).toHaveBeenCalledWith({
      command: 'switch',
      message: 'Model set to Opus 5 (anthropic).',
      invokesAgent: false
    })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('renders the refusal instead of an empty picker when the verb cannot answer', async () => {
    seedApi({
      getAvailableModels: vi.fn().mockResolvedValue({ ok: false, reason: 'omp_rpc_not_owned' }),
      getState: vi.fn().mockResolvedValue({ ok: false, reason: 'omp_rpc_not_owned' })
    })
    const { hook } = renderCard()

    await waitFor(() => expect(hook.result.current.view.phase).toBe('error'))
    const view = hook.result.current.view
    expect(view.phase === 'error' ? view.message : '').toContain('omp_rpc_not_owned')
  })

  it('keeps the card open with the refusal when an apply is declined', async () => {
    seedApi({
      getAvailableModels: vi.fn().mockResolvedValue({ ok: true, data: [MODEL] }),
      getState: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      setModel: vi.fn().mockResolvedValue({ ok: false, reason: 'omp_rpc_command_refused' })
    })
    const { hook, onApplied } = renderCard()
    await waitFor(() => expect(hook.result.current.view.phase).toBe('ready'))

    await act(async () => {
      hook.result.current.choose({
        kind: 'select',
        optionId: '["openai-codex","gpt-6-astra"]'
      })
    })

    const view = hook.result.current.view
    expect(view.phase === 'ready' ? view.failure : '').toContain('omp_rpc_command_refused')
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('answers a destructive card with no verb by re-sending its own command text', async () => {
    // `/session delete` has no verb upstream: the confirm IS the guard, and the
    // send it gates is the one the unguarded draft would have made.
    seedApi({
      getState: vi
        .fn()
        .mockResolvedValue({ ok: true, data: { sessionId: 's-1', sessionFile: '/s/s-1.jsonl' } })
    })
    const confirmGate = vi.fn(() => true)
    const { hook, onDismiss, onApplied } = renderCard({ command: 'session delete', confirmGate })
    await waitFor(() => expect(hook.result.current.view.phase).not.toBe('loading'))

    await act(async () => {
      hook.result.current.choose({ kind: 'confirm' })
    })

    expect(confirmGate).toHaveBeenCalledWith('session delete')
    expect(onDismiss).toHaveBeenCalledTimes(1)
    // The gated send records its own marker; a second one would double-report.
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('keeps a gate card open when the send could not be made', async () => {
    seedApi({
      getState: vi
        .fn()
        .mockResolvedValue({ ok: true, data: { sessionId: 's-1', sessionFile: '/s/s-1.jsonl' } })
    })
    const { hook, onDismiss } = renderCard({
      command: 'session delete',
      confirmGate: vi.fn(() => false)
    })
    await waitFor(() => expect(hook.result.current.view.phase).not.toBe('loading'))

    await act(async () => {
      hook.result.current.choose({ kind: 'confirm' })
    })

    const view = hook.result.current.view
    expect(view.phase === 'ready' ? view.failure : '').toContain('could not send')
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
