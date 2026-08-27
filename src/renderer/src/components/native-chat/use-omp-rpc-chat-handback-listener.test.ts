// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OmpRpcChatHandbackPayload } from '../../../../shared/omp-rpc-chat-ipc-contract'

const { respawnPtyForOmpRpcChatHandback } = vi.hoisted(() => ({
  respawnPtyForOmpRpcChatHandback: vi.fn()
}))

vi.mock('./omp-rpc-chat-handback', () => ({ respawnPtyForOmpRpcChatHandback }))

import { useOmpRpcChatHandbackListener } from './use-omp-rpc-chat-handback-listener'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'

const onHandback = vi.fn<(onEvent: (payload: OmpRpcChatHandbackPayload) => void) => () => void>()

function fireHandback(payload: OmpRpcChatHandbackPayload): void {
  const listener = onHandback.mock.calls.at(-1)?.[0]
  if (!listener) {
    throw new Error('onHandback was never subscribed')
  }
  listener(payload)
}

beforeEach(() => {
  vi.clearAllMocks()
  onHandback.mockReturnValue(vi.fn())
  respawnPtyForOmpRpcChatHandback.mockResolvedValue({ ok: true, ptyId: 'pty-resumed' })
  ;(window as unknown as { api: unknown }).api = { ompRpcChat: { onHandback } }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('useOmpRpcChatHandbackListener', () => {
  it('respawns for a payload whose paneKey belongs to this tab', () => {
    renderHook(() => useOmpRpcChatHandbackListener('tab-1'))

    fireHandback({
      paneKey: `tab-1:${LEAF_ID}`,
      replacedPtyId: 'pty-1',
      cwd: '/work/a',
      sessionId: 'session-1'
    })

    expect(respawnPtyForOmpRpcChatHandback).toHaveBeenCalledWith({
      paneKey: `tab-1:${LEAF_ID}`,
      replacedPtyId: 'pty-1',
      cwd: '/work/a',
      sessionId: 'session-1'
    })
  })

  // Why: the push event is a broadcast, not scoped per subscriber like
  // `ompRpcChat:subscribe` — every mounted TerminalPane's listener fires and
  // must filter out payloads belonging to a sibling tab itself.
  it('ignores a payload for a different tab', () => {
    renderHook(() => useOmpRpcChatHandbackListener('tab-1'))

    fireHandback({
      paneKey: `tab-2:${OTHER_LEAF_ID}`,
      replacedPtyId: 'pty-2',
      cwd: '/work/b',
      sessionId: 'session-2'
    })

    expect(respawnPtyForOmpRpcChatHandback).not.toHaveBeenCalled()
  })

  it('ignores a malformed paneKey rather than throwing', () => {
    renderHook(() => useOmpRpcChatHandbackListener('tab-1'))

    expect(() =>
      fireHandback({
        paneKey: 'not-a-valid-pane-key',
        replacedPtyId: 'pty-1',
        cwd: '/work/a',
        sessionId: 'session-1'
      })
    ).not.toThrow()
    expect(respawnPtyForOmpRpcChatHandback).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount', () => {
    const unsubscribe = vi.fn()
    onHandback.mockReturnValue(unsubscribe)
    const { unmount } = renderHook(() => useOmpRpcChatHandbackListener('tab-1'))

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when window.api.ompRpcChat is unavailable', () => {
    delete (window as unknown as { api?: unknown }).api
    expect(() => renderHook(() => useOmpRpcChatHandbackListener('tab-1'))).not.toThrow()
    expect(respawnPtyForOmpRpcChatHandback).not.toHaveBeenCalled()
  })
})
