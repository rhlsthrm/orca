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
  paneKey: 'tab-1:leaf-1',
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
  it('resolves the session id once paneKey/cwd/visibility are known', async () => {
    resolveSessionIdentity.mockResolvedValue({ sessionId: 'session-1', source: 'breadcrumb' })
    const { result } = renderHook(() => useOmpPaneSessionIdentity(BASE_ARGS))

    await waitFor(() => expect(result.current).toBe('session-1'))
    expect(resolveSessionIdentity).toHaveBeenCalledWith({
      paneKey: 'tab-1:leaf-1',
      ptyId: 'pty-1',
      cwd: '/work/a'
    })
  })

  // Wave 9, Defect 1: `ptyId` is an optional accuracy input, never a
  // precondition — resolution must proceed via the mtime fallback with no
  // live `ptyId` at all.
  it('resolves with no ptyId at all via the mtime fallback', async () => {
    resolveSessionIdentity.mockResolvedValue({ sessionId: 'session-1', source: 'mtime-fallback' })
    const { result } = renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, ptyId: null }))

    await waitFor(() => expect(result.current).toBe('session-1'))
    expect(resolveSessionIdentity).toHaveBeenCalledWith({
      paneKey: 'tab-1:leaf-1',
      ptyId: null,
      cwd: '/work/a'
    })
  })

  it('returns null and never calls the resolver when ineligible', () => {
    const { result } = renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, paneKey: null }))
    expect(result.current).toBeNull()
    expect(resolveSessionIdentity).not.toHaveBeenCalled()

    renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, agent: 'claude' }))
    renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, isVisible: false }))
    renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, runtimeEnvironmentId: 'runtime-1' }))
    renderHook(() => useOmpPaneSessionIdentity({ ...BASE_ARGS, cwd: null }))
    expect(resolveSessionIdentity).not.toHaveBeenCalled()
  })

  it('returns null when the resolver finds nothing to resume', async () => {
    resolveSessionIdentity.mockResolvedValue(null)
    const { result } = renderHook(() => useOmpPaneSessionIdentity(BASE_ARGS))

    await waitFor(() => expect(resolveSessionIdentity).toHaveBeenCalledTimes(1))
    expect(result.current).toBeNull()
  })

  // Wave 9, Defect 1, acceptance criterion 1 (the deadlock this wave
  // fixes): Decision 1's acquisition kills the pane's live PTY on success,
  // nulling `ptyId`. That must never discard an already-resolved identity
  // or flip the hook back to ineligible.
  it('survives ptyId going null after acquisition kills the pty (Defect 1: no deadlock)', async () => {
    resolveSessionIdentity.mockResolvedValueOnce({ sessionId: 'session-1', source: 'breadcrumb' })
    const { result, rerender } = renderHook(
      (props: UseOmpPaneSessionIdentityArgs) => useOmpPaneSessionIdentity(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(result.current).toBe('session-1'))

    rerender({ ...BASE_ARGS, ptyId: null })

    expect(result.current).toBe('session-1')
  })

  // A later re-resolution attempt (e.g. retried when `ptyId` reappears)
  // may only ever CONFIRM the already-resolved id, never downgrade it to
  // null or silently swap it for a different session.
  it('never downgrades or swaps an already-resolved id on a later re-resolution', async () => {
    resolveSessionIdentity.mockResolvedValueOnce({ sessionId: 'session-1', source: 'breadcrumb' })
    const { result, rerender } = renderHook(
      (props: UseOmpPaneSessionIdentityArgs) => useOmpPaneSessionIdentity(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(result.current).toBe('session-1'))

    resolveSessionIdentity.mockResolvedValueOnce(null)
    rerender({ ...BASE_ARGS, ptyId: 'pty-2' })
    await waitFor(() => expect(resolveSessionIdentity).toHaveBeenCalledTimes(2))
    expect(result.current).toBe('session-1')

    resolveSessionIdentity.mockResolvedValueOnce({
      sessionId: 'session-9',
      source: 'mtime-fallback'
    })
    rerender({ ...BASE_ARGS, ptyId: 'pty-3' })
    await waitFor(() => expect(resolveSessionIdentity).toHaveBeenCalledTimes(3))
    expect(result.current).toBe('session-1')
  })

  it('re-resolves on a genuine identity rebind (paneKey change) and drops the stale value meanwhile', async () => {
    resolveSessionIdentity.mockResolvedValueOnce({ sessionId: 'session-1', source: 'breadcrumb' })
    const { result, rerender } = renderHook(
      (props: UseOmpPaneSessionIdentityArgs) => useOmpPaneSessionIdentity(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(result.current).toBe('session-1'))

    const { promise, resolve } = Promise.withResolvers<OmpRpcChatResolveSessionIdentityResult>()
    resolveSessionIdentity.mockReturnValueOnce(promise)
    rerender({ ...BASE_ARGS, paneKey: 'tab-1:leaf-2' })

    // The stale value must not leak across the identity rebind while the
    // new resolution is in flight.
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
