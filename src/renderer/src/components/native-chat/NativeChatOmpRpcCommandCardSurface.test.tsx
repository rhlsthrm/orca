// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatOmpRpcCommandCardSurface } from './NativeChatOmpRpcCommandCardSurface'
import type { NativeChatOmpRpcIntegration } from './use-native-chat-omp-rpc-integration'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const MODEL = { id: 'gpt-6-astra', name: 'GPT-6 Astra', provider: 'openai-codex' }
const OPUS = { id: 'opus-5', name: 'Opus 5', provider: 'anthropic' }

type FakeChatApi = Record<string, ReturnType<typeof vi.fn>>

function seedApi(api: FakeChatApi): void {
  // Test seam: the cards reach the preload bridge through `window.api`, and a
  // fake carrying only the probed verbs cannot satisfy the full PreloadApi.
  const bridge = { ompRpcChat: api } as unknown as typeof window.api
  window.api = bridge
}

function integration(
  overrides: Partial<NativeChatOmpRpcIntegration> = {}
): NativeChatOmpRpcIntegration {
  // Only the fields this surface reads are provided; the rest of the
  // integration describes overlays and history the card never touches.
  const partial = {
    isRpcOwned: true,
    interactiveCard: { cardId: 'card-1', command: 'switch' },
    dismissInteractiveCard: vi.fn(),
    openInteractiveCard: vi.fn(),
    rpcExecutableCommands: null,
    sessionGeneration: 3,
    commandQueueKey: 'pane-1:3',
    sendChat: vi.fn().mockResolvedValue({ ok: true }),
    onCommandDispatched: vi.fn(),
    onCommandAgentInvoked: vi.fn(),
    reportCommandFailure: vi.fn(),
    ...overrides
  } as unknown as NativeChatOmpRpcIntegration
  return partial
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

describe('NativeChatOmpRpcCommandCardSurface', () => {
  it('renders the open /switch card, dispatches the picked model, and records a local marker', async () => {
    const setModel = vi.fn().mockResolvedValue({ ok: true, data: OPUS })
    seedApi({
      getAvailableModels: vi.fn().mockResolvedValue({ ok: true, data: [MODEL, OPUS] }),
      getState: vi.fn().mockResolvedValue({ ok: true, data: { model: MODEL } }),
      setModel
    })
    const onSlashCommand = vi.fn()
    const ompRpc = integration()

    render(
      <NativeChatOmpRpcCommandCardSurface
        agent="omp"
        paneKey="pane-1"
        cwd="/repo"
        ompRpc={ompRpc}
        onSlashCommand={onSlashCommand}
      />
    )

    // The card names the command and the title comes from the registry.
    expect(await screen.findByText('Model')).toBeInTheDocument()
    expect(screen.getByText('/switch')).toBeInTheDocument()
    const current = await waitFor(() => screen.getByRole('button', { name: /GPT-6 Astra/ }))
    expect(current).toHaveAttribute('data-current', 'true')
    expect(screen.getByRole('button', { name: /Opus 5/ })).not.toHaveAttribute('data-current')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Opus 5/ }))
    })

    expect(setModel).toHaveBeenCalledWith({
      paneKey: 'pane-1',
      provider: 'anthropic',
      modelId: 'opus-5'
    })
    expect(onSlashCommand).toHaveBeenCalledWith('/switch', {
      outputText: 'Model set to Opus 5 (anthropic).',
      agentInvoked: false
    })
    expect(ompRpc.dismissInteractiveCard).toHaveBeenCalledWith('card-1')
    // Nothing was put on the prompt wire: the verb did the work.
    expect(ompRpc.sendChat).not.toHaveBeenCalled()
  })

  it('renders nothing when the pane has no card open', () => {
    seedApi({})
    const { container } = render(
      <NativeChatOmpRpcCommandCardSurface
        agent="omp"
        paneKey="pane-1"
        cwd="/repo"
        ompRpc={integration({ interactiveCard: null })}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('marks a compaction as agent-invoking so the marker cannot claim otherwise', async () => {
    seedApi({
      getState: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      compact: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          summary: 'long',
          shortSummary: 'API decisions kept',
          firstKeptEntryId: 'e',
          tokensBefore: 1
        }
      })
    })
    const onSlashCommand = vi.fn()

    render(
      <NativeChatOmpRpcCommandCardSurface
        agent="omp"
        paneKey="pane-1"
        cwd="/repo"
        ompRpc={integration({ interactiveCard: { cardId: 'card-2', command: 'compact' } })}
        onSlashCommand={onSlashCommand}
      />
    )

    const field = await screen.findByRole('textbox')
    await act(async () => {
      fireEvent.change(field, { target: { value: 'keep the API decisions' } })
      fireEvent.keyDown(field, { key: 'Enter' })
    })

    expect(onSlashCommand).toHaveBeenCalledWith('/compact', {
      outputText: 'Context compacted: API decisions kept',
      agentInvoked: true
    })
  })
})
