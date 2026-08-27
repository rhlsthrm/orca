// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  resolveOmpRpcChatSendBehavior,
  useOmpRpcChatSend,
  type UseOmpRpcChatSendArgs
} from './use-omp-rpc-chat-send'

function args(overrides: Partial<UseOmpRpcChatSendArgs> = {}): UseOmpRpcChatSendArgs {
  return {
    isRpcOwned: true,
    isRpcTurnWorking: false,
    followUpRequested: false,
    sendChat: vi.fn().mockResolvedValue({ ok: true, agentInvoked: true }),
    ...overrides
  }
}

describe('resolveOmpRpcChatSendBehavior', () => {
  it('sends idle as prompt', () => {
    expect(resolveOmpRpcChatSendBehavior(false, false)).toBe('idle')
    expect(resolveOmpRpcChatSendBehavior(false, true)).toBe('idle')
  })

  it('defaults a working turn to steer', () => {
    expect(resolveOmpRpcChatSendBehavior(true, false)).toBe('steer')
  })

  it('routes to follow_up only when the Follow up affordance is armed', () => {
    expect(resolveOmpRpcChatSendBehavior(true, true)).toBe('followUp')
  })
})

describe('useOmpRpcChatSend', () => {
  it('does not claim the draft when the pane is not RPC-owned (D1 degrade)', () => {
    const { result } = renderHook(() => useOmpRpcChatSend(args({ isRpcOwned: false })))
    expect(result.current('hello')).toBe(false)
  })

  it('does not claim a blank draft', () => {
    const { result } = renderHook(() => useOmpRpcChatSend(args()))
    expect(result.current('   ')).toBe(false)
  })

  it('claims an idle send as prompt and echoes an optimistic bubble', () => {
    const sendChat = vi.fn().mockResolvedValue({ ok: true, agentInvoked: true })
    const onOptimisticSend = vi.fn()
    const { result } = renderHook(() => useOmpRpcChatSend(args({ sendChat, onOptimisticSend })))

    expect(result.current('hello')).toBe(true)

    expect(onOptimisticSend).toHaveBeenCalledWith('hello', [])
    expect(sendChat).toHaveBeenCalledWith({ message: 'hello', behavior: 'idle' })
  })

  it('steers a working turn by default', () => {
    const sendChat = vi.fn().mockResolvedValue({ ok: true, agentInvoked: true })
    const { result } = renderHook(() =>
      useOmpRpcChatSend(args({ isRpcTurnWorking: true, sendChat }))
    )

    result.current('interject')

    expect(sendChat).toHaveBeenCalledWith({ message: 'interject', behavior: 'steer' })
  })

  it('routes to follow_up when the composer armed the affordance', () => {
    const sendChat = vi.fn().mockResolvedValue({ ok: true, agentInvoked: true })
    const { result } = renderHook(() =>
      useOmpRpcChatSend(args({ isRpcTurnWorking: true, followUpRequested: true, sendChat }))
    )

    result.current('later')

    expect(sendChat).toHaveBeenCalledWith({ message: 'later', behavior: 'followUp' })
  })

  it('reports a failed send after already claiming the draft, without a PTY fallback', async () => {
    const sendChat = vi.fn().mockResolvedValue({ ok: false, reason: 'disposed' })
    const onSendFailed = vi.fn()
    const { result } = renderHook(() => useOmpRpcChatSend(args({ sendChat, onSendFailed })))

    const claimed = result.current('hello')

    expect(claimed).toBe(true)
    await waitFor(() => expect(onSendFailed).toHaveBeenCalledTimes(1))
  })
})
