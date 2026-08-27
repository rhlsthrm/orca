// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { createInitialOmpRpcTurnState, type OmpRpcTurnState } from './omp-rpc-turn-reducer'
import type { OmpRpcChatSessionHandle } from './use-omp-rpc-chat-session'

const send = vi.fn()
const abort = vi.fn()
const respondExtensionUi = vi.fn()
let sessionHandle: OmpRpcChatSessionHandle

vi.mock('./use-omp-rpc-chat-session', () => ({
  useOmpRpcChatSession: () => sessionHandle
}))

import { useNativeChatOmpRpcIntegration } from './use-native-chat-omp-rpc-integration'

function handle(overrides: {
  isOwned: boolean
  turnState: OmpRpcTurnState
}): OmpRpcChatSessionHandle {
  return {
    status: overrides.isOwned ? 'acquired' : 'live',
    isOwned: overrides.isOwned,
    turnState: overrides.turnState,
    send,
    abort,
    respondExtensionUi
  }
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
  agent: 'omp' as const,
  paneKey: 'tab-1:leaf-1',
  ptyId: 'pty-1',
  cwd: '/work/a',
  sessionFile: 'session-1',
  isVisible: true,
  runtimeEnvironmentId: null,
  transcriptMessages: [] as NativeChatMessage[],
  hookPreview: undefined as string | null | undefined
}

describe('useNativeChatOmpRpcIntegration', () => {
  it('is a no-op when the pane is not RPC-owned: no overlay, no status override, hook preview passes through', () => {
    sessionHandle = handle({ isOwned: false, turnState: createInitialOmpRpcTurnState() })
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
    sessionHandle = handle({
      isOwned: true,
      turnState: { ...createInitialOmpRpcTurnState(), status: 'working' }
    })
    const { result } = renderHook(() =>
      useNativeChatOmpRpcIntegration({ ...ARGS, hookPreview: 'stale hook preview' })
    )

    expect(result.current.effectiveHookPreview).toBeNull()
  })

  it('overrides status to working only while the RPC turn is active (D5)', () => {
    sessionHandle = handle({
      isOwned: true,
      turnState: { ...createInitialOmpRpcTurnState(), status: 'working' }
    })
    const working = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))
    expect(working.result.current.statusOverride).toBe('working')
    expect(working.result.current.isRpcTurnWorking).toBe(true)

    // F2 regression: a turn that already completed must not still read as
    // "working" just because its content (assistantText/blocks) survives for
    // the leads-vs-transcript compare — status is the lifecycle fact.
    sessionHandle = handle({
      isOwned: true,
      turnState: { ...createInitialOmpRpcTurnState(), status: 'idle', assistantText: 'hi there' }
    })
    const postTurn = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))
    expect(postTurn.result.current.statusOverride).toBeNull()
    expect(postTurn.result.current.isRpcTurnWorking).toBe(false)
  })

  it('never surfaces an overlay message the transcript already covers (D4)', () => {
    sessionHandle = handle({
      isOwned: true,
      turnState: { ...createInitialOmpRpcTurnState(), status: 'working', assistantText: 'done' }
    })
    const { result } = renderHook(() =>
      useNativeChatOmpRpcIntegration({ ...ARGS, transcriptMessages: transcript('done') })
    )

    expect(result.current.overlayMessages).toEqual([])
  })

  it('surfaces the overlay while it leads the transcript', () => {
    sessionHandle = handle({
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
    sessionHandle = handle({
      isOwned: false,
      turnState: { ...createInitialOmpRpcTurnState(), pendingExtensionUiRequest: request }
    })
    expect(
      renderHook(() => useNativeChatOmpRpcIntegration(ARGS)).result.current
        .pendingExtensionUiRequest
    ).toBeNull()

    sessionHandle = handle({
      isOwned: true,
      turnState: { ...createInitialOmpRpcTurnState(), pendingExtensionUiRequest: request }
    })
    expect(
      renderHook(() => useNativeChatOmpRpcIntegration(ARGS)).result.current
        .pendingExtensionUiRequest
    ).toEqual(request)
  })

  it('forwards send/abort/respondExtensionUi to the underlying session', () => {
    sessionHandle = handle({ isOwned: true, turnState: createInitialOmpRpcTurnState() })
    const { result } = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))

    expect(result.current.sendChat).toBe(send)
    expect(result.current.abortChat).toBe(abort)
    expect(result.current.answerExtensionUi).toBe(respondExtensionUi)
  })
})
