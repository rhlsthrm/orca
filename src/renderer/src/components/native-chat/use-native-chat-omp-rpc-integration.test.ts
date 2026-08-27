// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { createInitialOmpRpcTurnState, type OmpRpcTurnState } from './omp-rpc-turn-reducer'
import { useNativeChatOmpRpcIntegration } from './use-native-chat-omp-rpc-integration'

const acquire = vi.fn()
const send = vi.fn()
const abort = vi.fn()
const respondExtensionUi = vi.fn()

const PANE_KEY = 'tab-1:leaf-1'

function seedOwnership(overrides: { isOwned: boolean; turnState: OmpRpcTurnState }): void {
  useAppStore.setState({
    ompRpcChatOwnershipByPaneKey: {
      [PANE_KEY]: {
        status: overrides.isOwned ? 'acquired' : 'live',
        turnState: overrides.turnState
      }
    }
  })
}

const transcript = (text: string): NativeChatMessage[] => [
  {
    id: 't-1',
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
]

const ARGS = {
  paneKey: PANE_KEY,
  transcriptMessages: [] as NativeChatMessage[],
  hookPreview: undefined as string | null | undefined
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState(useAppStore.getInitialState(), true)
  send.mockResolvedValue({ ok: true, agentInvoked: true })
  abort.mockResolvedValue({ ok: true, agentInvoked: true })
  ;(window as unknown as { api: unknown }).api = {
    ompRpcChat: { acquire, send, abort, respondExtensionUi }
  }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('useNativeChatOmpRpcIntegration', () => {
  it('is a no-op when the pane has no ownership row: no overlay, no status override, hook preview passes through', () => {
    const { result } = renderHook(() =>
      useNativeChatOmpRpcIntegration({ ...ARGS, hookPreview: 'typing…' })
    )

    expect(result.current.isRpcOwned).toBe(false)
    expect(result.current.overlayMessages).toEqual([])
    expect(result.current.statusOverride).toBeNull()
    expect(result.current.effectiveHookPreview).toBe('typing…')
    expect(result.current.pendingExtensionUiRequest).toBeNull()
  })

  it('suppresses the hook preview whenever RPC owns the pane, so the two overlays never both render', () => {
    seedOwnership({
      isOwned: true,
      turnState: { ...createInitialOmpRpcTurnState(), status: 'working' }
    })
    const { result } = renderHook(() =>
      useNativeChatOmpRpcIntegration({ ...ARGS, hookPreview: 'stale hook preview' })
    )

    expect(result.current.effectiveHookPreview).toBeNull()
  })

  it('overrides status to working only while the RPC turn is active (D5)', () => {
    seedOwnership({
      isOwned: true,
      turnState: { ...createInitialOmpRpcTurnState(), status: 'working' }
    })
    const working = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))
    expect(working.result.current.statusOverride).toBe('working')
    expect(working.result.current.isRpcTurnWorking).toBe(true)

    // F2 regression: a turn that already completed must not still read as
    // "working" just because its content (assistantText/blocks) survives for
    // the leads-vs-transcript compare — status is the lifecycle fact.
    seedOwnership({
      isOwned: true,
      turnState: { ...createInitialOmpRpcTurnState(), status: 'idle', assistantText: 'hi there' }
    })
    const postTurn = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))
    expect(postTurn.result.current.statusOverride).toBeNull()
    expect(postTurn.result.current.isRpcTurnWorking).toBe(false)
  })

  it('never surfaces an overlay message the transcript already covers (D4)', () => {
    seedOwnership({
      isOwned: true,
      turnState: { ...createInitialOmpRpcTurnState(), status: 'working', assistantText: 'done' }
    })
    const { result } = renderHook(() =>
      useNativeChatOmpRpcIntegration({ ...ARGS, transcriptMessages: transcript('done') })
    )

    expect(result.current.overlayMessages).toEqual([])
  })

  it('surfaces the overlay while it leads the transcript', () => {
    seedOwnership({
      isOwned: true,
      turnState: {
        ...createInitialOmpRpcTurnState(),
        status: 'working',
        assistantText: 'a longer in-progress reply',
        blocks: [{ type: 'text', text: 'a longer in-progress reply' }]
      }
    })
    const { result } = renderHook(() =>
      useNativeChatOmpRpcIntegration({ ...ARGS, transcriptMessages: transcript('a longer') })
    )

    expect(result.current.overlayMessages).toHaveLength(1)
    expect(result.current.overlayMessages[0]?.source).toBe('rpc')
  })

  it('surfaces the pending extension UI request only when RPC-owned', () => {
    const request = { type: 'extension_ui_request' as const, id: 'req-1', method: 'confirm' }
    seedOwnership({
      isOwned: false,
      turnState: { ...createInitialOmpRpcTurnState(), pendingExtensionUiRequest: request }
    })
    expect(
      renderHook(() => useNativeChatOmpRpcIntegration(ARGS)).result.current
        .pendingExtensionUiRequest
    ).toBeNull()

    seedOwnership({
      isOwned: true,
      turnState: { ...createInitialOmpRpcTurnState(), pendingExtensionUiRequest: request }
    })
    expect(
      renderHook(() => useNativeChatOmpRpcIntegration(ARGS)).result.current
        .pendingExtensionUiRequest
    ).toEqual(request)
  })

  it('forwards send/abort/respondExtensionUi to the paneKey-scoped store actions', async () => {
    seedOwnership({ isOwned: true, turnState: createInitialOmpRpcTurnState() })
    const { result } = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))

    await result.current.sendChat({ message: 'hi', behavior: 'idle' })
    await result.current.abortChat()
    act(() => {
      result.current.answerExtensionUi({
        type: 'extension_ui_response',
        id: 'req-1',
        confirmed: true
      })
    })

    expect(send).toHaveBeenCalledWith({ paneKey: PANE_KEY, message: 'hi', behavior: 'idle' })
    expect(abort).toHaveBeenCalledWith({ paneKey: PANE_KEY })
    expect(respondExtensionUi).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      response: { type: 'extension_ui_response', id: 'req-1', confirmed: true }
    })
  })

  // W6-2 regression guard: ownership acquisition lives entirely in the
  // TerminalPane-anchored use-omp-rpc-chat-pane-ownership.ts hook, published
  // into this store slice — this integration hook (mounted inside the
  // remountable NativeChatView) must never itself acquire anything. A
  // remount (an ordinary Terminal<->Chat toggle) performing zero RPC IPC is
  // exactly what makes the toggle instant again.
  it('never acquires anything itself: mount, rerender, and unmount perform zero RPC IPC', () => {
    const { rerender, unmount } = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))
    rerender()
    unmount()

    expect(acquire).not.toHaveBeenCalled()
  })
})
