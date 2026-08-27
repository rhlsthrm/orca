// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OmpRpcChatResolveSessionIdentityArgs,
  OmpRpcChatResolveSessionIdentityResult
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import {
  useOmpPaneSessionIdentity,
  type UseOmpPaneSessionIdentityArgs
} from './use-omp-pane-session-identity'

const resolveSessionIdentity =
  vi.fn<
    (args: OmpRpcChatResolveSessionIdentityArgs) => Promise<OmpRpcChatResolveSessionIdentityResult>
  >()

const BASE_ARGS: UseOmpPaneSessionIdentityArgs = {
  agent: 'omp',
  ptyId: 'pty-1',
  cwd: '/work/a',
  runtimeEnvironmentId: null,
  isVisible: true
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { api: unknown }).api = {
    ompRpcChat: { resolveSessionIdentity }
  }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('useOmpPaneSessionIdentity', () => {
  it('resolves the session id once ptyId/cwd/visibility are known', async () => {
    resolveSessionIdentity.mockResolvedValue({ sessionId: 'session-1', source: 'breadcrumb' })
    const { result } = renderHook(() => useOmpPaneSessionIdentity(BASE_ARGS))

    await waitFor(() => expect(result.current).toBe('session-1'))
    expect(resolveSessionIdentity).toHaveBeenCalledWith({ ptyId: 'pty-1', cwd: '/work/a' })
  })

  it('returns null and never calls the resolver when ineligible', () => {
    const { result } = renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, ptyId: null }))
    expect(result.current).toBeNull()
    expect(resolveSessionIdentity).not.toHaveBeenCalled()

    renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, agent: 'claude' }))
    renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, isVisible: false }))
    renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, runtimeEnvironmentId: 'runtime-1' }))
    expect(resolveSessionIdentity).not.toHaveBeenCalled()
  })

  it('returns null when the resolver finds nothing to resume', async () => {
    resolveSessionIdentity.mockResolvedValue(null)
    const { result } = renderHook(() => useOmpPaneSessionIdentity(BASE_ARGS))

    await waitFor(() => expect(resolveSessionIdentity).toHaveBeenCalledTimes(1))
    expect(result.current).toBeNull()
  })

  it('re-resolves once on an identity rebind (ptyId change) and drops the stale value meanwhile', async () => {
    resolveSessionIdentity.mockResolvedValueOnce({ sessionId: 'session-1', source: 'breadcrumb' })
    const { result, rerender } = renderHook(
      (props: UseOmpPaneSessionIdentityArgs) => useOmpPaneSessionIdentity(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(result.current).toBe('session-1'))

    const { promise, resolve } = Promise.withResolvers<OmpRpcChatResolveSessionIdentityResult>()
    resolveSessionIdentity.mockReturnValueOnce(promise)
    rerender({ ...BASE_ARGS, ptyId: 'pty-2' })

    // The stale value must not leak across the identity rebind while the new
    // resolution is in flight.
    expect(result.current).toBeNull()
    resolve({ sessionId: 'session-2', source: 'mtime-fallback' })
    await waitFor(() => expect(result.current).toBe('session-2'))
    expect(resolveSessionIdentity).toHaveBeenCalledTimes(2)
  })

  it('does not re-resolve on a bare visibility toggle once already resolved', async () => {
    resolveSessionIdentity.mockResolvedValue({ sessionId: 'session-1', source: 'breadcrumb' })
    const { result, rerender } = renderHook(
      (props: UseOmpPaneSessionIdentityArgs) => useOmpPaneSessionIdentity(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(result.current).toBe('session-1'))

    rerender({ ...BASE_ARGS, isVisible: false })
    rerender({ ...BASE_ARGS, isVisible: true })

    expect(result.current).toBe('session-1')
    expect(resolveSessionIdentity).toHaveBeenCalledTimes(1)
  })

  it('degrades to null when the IPC call rejects', async () => {
    resolveSessionIdentity.mockRejectedValue(new Error('ipc down'))
    const { result } = renderHook(() => useOmpPaneSessionIdentity(BASE_ARGS))

    await waitFor(() => expect(resolveSessionIdentity).toHaveBeenCalledTimes(1))
    expect(result.current).toBeNull()
  })
})
