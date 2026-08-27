// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OmpRpcChatAcquireArgs,
  OmpRpcChatAcquireResult,
  OmpRpcChatReleaseArgs,
  OmpRpcChatReleaseResult,
  OmpRpcChatRespondExtensionUiArgs,
  OmpRpcChatSendArgs,
  OmpRpcChatSendResult,
  OmpRpcChatSubscribeArgs
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'

const acquire = vi.fn<(args: OmpRpcChatAcquireArgs) => Promise<OmpRpcChatAcquireResult>>()
const release = vi.fn<(args: OmpRpcChatReleaseArgs) => Promise<OmpRpcChatReleaseResult>>()
const send = vi.fn<(args: OmpRpcChatSendArgs) => Promise<OmpRpcChatSendResult>>()
const abort = vi.fn<(args: { paneKey: string }) => Promise<OmpRpcChatSendResult>>()
const respondExtensionUi = vi.fn<(args: OmpRpcChatRespondExtensionUiArgs) => void>()
const subscribe =
  vi.fn<
    (args: OmpRpcChatSubscribeArgs, onEvent: (event: OmpRpcClientEvent) => void) => () => void
  >()
const ptyKill = vi.fn<(id: string, opts?: { keepHistory?: boolean }) => Promise<void>>()
const { respawnPtyForOmpRpcChatHandback } = vi.hoisted(() => ({
  respawnPtyForOmpRpcChatHandback: vi.fn()
}))

vi.mock('./omp-rpc-chat-handback', () => ({ respawnPtyForOmpRpcChatHandback }))

import {
  isOmpRpcChatSessionEligible,
  useOmpRpcChatSession,
  type UseOmpRpcChatSessionArgs
} from './use-omp-rpc-chat-session'

const BASE_ARGS: UseOmpRpcChatSessionArgs = {
  agent: 'omp',
  paneKey: 'tab-1:leaf-1',
  ptyId: 'pty-1',
  cwd: '/work/a',
  sessionFile: 'session-1',
  isVisible: true,
  runtimeEnvironmentId: null
}

function lastSubscribedListener(): (event: OmpRpcClientEvent) => void {
  const call = subscribe.mock.calls.at(-1)
  if (!call) {
    throw new Error('subscribe was never called')
  }
  return call[1]
}

beforeEach(() => {
  vi.clearAllMocks()
  release.mockResolvedValue({ released: true })
  subscribe.mockReturnValue(vi.fn())
  ptyKill.mockResolvedValue(undefined)
  respawnPtyForOmpRpcChatHandback.mockResolvedValue({ ok: true, ptyId: 'pty-resumed' })
  ;(window as unknown as { api: unknown }).api = {
    ompRpcChat: { acquire, release, send, abort, respondExtensionUi, subscribe },
    pty: { kill: ptyKill }
  }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('isOmpRpcChatSessionEligible', () => {
  it('requires every gate: visible, omp, local, and a known pty/cwd/session', () => {
    expect(
      isOmpRpcChatSessionEligible({
        agent: 'omp',
        isVisible: true,
        runtimeEnvironmentId: null,
        ptyId: 'pty-1',
        cwd: '/work/a',
        sessionFile: 'session-1'
      })
    ).toBe(true)
  })

  it.each([
    { isVisible: false },
    { agent: 'claude' as const },
    { runtimeEnvironmentId: 'runtime-1' },
    { ptyId: null },
    { cwd: null },
    { sessionFile: null }
  ])('fails closed when %o overrides an otherwise-eligible pane', (overrides) => {
    expect(
      isOmpRpcChatSessionEligible({
        agent: 'omp',
        isVisible: true,
        runtimeEnvironmentId: null,
        ptyId: 'pty-1',
        cwd: '/work/a',
        sessionFile: 'session-1',
        ...overrides
      })
    ).toBe(false)
  })
})

describe('useOmpRpcChatSession', () => {
  it('acquires, subscribes, and feeds pushed frames through the turn reducer', async () => {
    acquire.mockResolvedValue({ ok: true })
    const { result } = renderHook(() => useOmpRpcChatSession(BASE_ARGS))

    await waitFor(() => expect(result.current.status).toBe('acquired'))
    // Decision 1: the pane's PTY is killed before acquiring — the trigger
    // that closes the "no live pane ever acquires" gate — and keeps
    // scrollback for the eventual hand-back.
    expect(ptyKill).toHaveBeenCalledWith('pty-1', { keepHistory: true })
    expect(ptyKill.mock.invocationCallOrder[0]).toBeLessThan(acquire.mock.invocationCallOrder[0])
    expect(acquire).toHaveBeenCalledWith({
      paneKey: 'tab-1:leaf-1',
      ptyId: 'pty-1',
      cwd: '/work/a',
      sessionFile: 'session-1'
    })
    expect(subscribe).toHaveBeenCalledTimes(1)

    act(() => {
      lastSubscribedListener()({ kind: 'agent-start', frame: { type: 'agent_start' } })
    })
    expect(result.current.turnState.status).toBe('working')
    expect(result.current.isOwned).toBe(true)
  })

  it('still acquires when the kill call rejects (best-effort — the registry liveness gate is the real proof)', async () => {
    ptyKill.mockRejectedValue(new Error('already gone'))
    acquire.mockResolvedValue({ ok: true })
    const { result } = renderHook(() => useOmpRpcChatSession(BASE_ARGS))

    await waitFor(() => expect(result.current.status).toBe('acquired'))
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  it.each(['live', 'unverifiable', 'conflict', 'spawn-failed', 'executable-not-found'] as const)(
    'degrades to the PTY path exactly as today when acquire returns "%s"',
    async (reason) => {
      acquire.mockResolvedValue({ ok: false, reason })
      const { result } = renderHook(() => useOmpRpcChatSession(BASE_ARGS))

      await waitFor(() => expect(result.current.status).toBe(reason))
      expect(result.current.isOwned).toBe(false)
      expect(subscribe).not.toHaveBeenCalled()
      // The degraded pane's own turn state never leaves idle/empty, so any
      // overlay/status-override consumer sees exactly today's behavior.
      expect(result.current.turnState.status).toBe('idle')
    }
  )

  it('never acquires for a non-omp agent, a hidden pane, or a runtime-owned pane', () => {
    renderHook(() => useOmpRpcChatSession({ ...BASE_ARGS, agent: 'claude' }))
    renderHook(() => useOmpRpcChatSession({ ...BASE_ARGS, isVisible: false }))
    renderHook(() => useOmpRpcChatSession({ ...BASE_ARGS, runtimeEnvironmentId: 'runtime-1' }))

    expect(acquire).not.toHaveBeenCalled()
  })

  it('releases and unsubscribes on unmount, leaving no listener or session behind', async () => {
    acquire.mockResolvedValue({ ok: true })
    const unsubscribe = vi.fn()
    subscribe.mockReturnValue(unsubscribe)
    const { result, unmount } = renderHook(() => useOmpRpcChatSession(BASE_ARGS))
    await waitFor(() => expect(result.current.status).toBe('acquired'))

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith({ paneKey: 'tab-1:leaf-1' })
  })

  // F9: a visibility toggle (Chat -> Terminal and back) must never abort or
  // release an already-acquired session — only unmount, pane close, or a
  // genuine identity rebind may release.
  it('holds the acquired session across a visibility toggle (view-away then back)', async () => {
    acquire.mockResolvedValue({ ok: true })
    const { result, rerender } = renderHook(
      (props: UseOmpRpcChatSessionArgs) => useOmpRpcChatSession(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(result.current.status).toBe('acquired'))

    rerender({ ...BASE_ARGS, isVisible: false })
    rerender({ ...BASE_ARGS, isVisible: true })

    expect(result.current.status).toBe('acquired')
    expect(release).not.toHaveBeenCalled()
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  it('resets turn state and re-acquires on an identity rebind (ptyId change)', async () => {
    acquire.mockResolvedValue({ ok: true })
    const { result, rerender } = renderHook(
      (props: UseOmpRpcChatSessionArgs) => useOmpRpcChatSession(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(result.current.status).toBe('acquired'))
    act(() => {
      lastSubscribedListener()({ kind: 'agent-start', frame: { type: 'agent_start' } })
    })
    expect(result.current.turnState.status).toBe('working')

    rerender({ ...BASE_ARGS, ptyId: 'pty-2' })

    expect(result.current.turnState.status).toBe('idle')
    expect(release).toHaveBeenCalledWith({ paneKey: 'tab-1:leaf-1' })
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(2))
    expect(acquire).toHaveBeenLastCalledWith({
      paneKey: 'tab-1:leaf-1',
      ptyId: 'pty-2',
      cwd: '/work/a',
      sessionFile: 'session-1'
    })
  })

  it('never leaks a session acquired after unmount already ran', async () => {
    const { promise, resolve: resolveAcquire } = Promise.withResolvers<OmpRpcChatAcquireResult>()
    acquire.mockReturnValue(promise)
    const { unmount } = renderHook(() => useOmpRpcChatSession(BASE_ARGS))

    unmount()
    resolveAcquire({ ok: true })
    await waitFor(() => expect(release).toHaveBeenCalledWith({ paneKey: 'tab-1:leaf-1' }))
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('routes send/abort through the acquired session and fails closed when not acquired', async () => {
    acquire.mockResolvedValue({ ok: false, reason: 'live' })
    const { result } = renderHook(() => useOmpRpcChatSession(BASE_ARGS))
    await waitFor(() => expect(result.current.status).toBe('live'))

    const sendResult = await result.current.send({ message: 'hi', behavior: 'idle' })
    const abortResult = await result.current.abort()

    expect(sendResult.ok).toBe(false)
    expect(abortResult.ok).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(abort).not.toHaveBeenCalled()
  })

  it('sends and aborts through the API once acquired', async () => {
    acquire.mockResolvedValue({ ok: true })
    send.mockResolvedValue({ ok: true, agentInvoked: true })
    abort.mockResolvedValue({ ok: true, agentInvoked: true })
    const { result } = renderHook(() => useOmpRpcChatSession(BASE_ARGS))
    await waitFor(() => expect(result.current.status).toBe('acquired'))

    await result.current.send({ message: 'hi', behavior: 'steer' })
    await result.current.abort()

    expect(send).toHaveBeenCalledWith({
      paneKey: 'tab-1:leaf-1',
      message: 'hi',
      behavior: 'steer'
    })
    expect(abort).toHaveBeenCalledWith({ paneKey: 'tab-1:leaf-1' })
  })

  it('answers extension UI by dispatching the reducer action and forwarding the reply', async () => {
    acquire.mockResolvedValue({ ok: true })
    const { result } = renderHook(() => useOmpRpcChatSession(BASE_ARGS))
    await waitFor(() => expect(result.current.status).toBe('acquired'))
    act(() => {
      lastSubscribedListener()({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'req-1', method: 'confirm' }
      })
    })
    expect(result.current.turnState.pendingExtensionUiRequest?.id).toBe('req-1')

    act(() => {
      result.current.respondExtensionUi({
        type: 'extension_ui_response',
        id: 'req-1',
        confirmed: true
      })
    })

    expect(respondExtensionUi).toHaveBeenCalledWith({
      paneKey: 'tab-1:leaf-1',
      response: { type: 'extension_ui_response', id: 'req-1', confirmed: true }
    })
    expect(result.current.turnState.pendingExtensionUiRequest).toBeNull()
  })

  // F3 (HIGH): a protocol-fault or exit frame mid-turn must flip isOwned
  // false and release the dead session so the caller's send path falls back
  // to PTY, instead of staying stuck claiming a session that will never
  // stream another frame.
  it.each(['protocol-fault', 'exit'] as const)(
    'flips to faulted and releases on a "%s" frame, so isOwned goes false',
    async (kind) => {
      acquire.mockResolvedValue({ ok: true })
      const { result } = renderHook(() => useOmpRpcChatSession(BASE_ARGS))
      await waitFor(() => expect(result.current.status).toBe('acquired'))

      act(() => {
        lastSubscribedListener()({ kind: 'agent-start', frame: { type: 'agent_start' } })
      })
      act(() => {
        lastSubscribedListener()({
          kind: 'message-update',
          frame: {
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', delta: 'partial' }
          }
        })
      })
      act(() => {
        lastSubscribedListener()(
          kind === 'protocol-fault'
            ? { kind: 'protocol-fault', message: 'boom' }
            : { kind: 'exit', code: 1, signal: null }
        )
      })

      expect(result.current.status).toBe('faulted')
      expect(result.current.isOwned).toBe(false)
      await waitFor(() => expect(release).toHaveBeenCalledWith({ paneKey: 'tab-1:leaf-1' }))

      const sendResult = await result.current.send({ message: 'hi', behavior: 'idle' })
      expect(sendResult.ok).toBe(false)
      expect(send).not.toHaveBeenCalled()
    }
  )

  // F5 (HIGH): a conflict is very often the release-in-flight or
  // StrictMode-double-mount race — retry once with bounded backoff before
  // surfacing failure.
  it('retries once on an acquire "conflict" and succeeds on the retry', async () => {
    acquire.mockResolvedValueOnce({ ok: false, reason: 'conflict' })
    acquire.mockResolvedValueOnce({ ok: true })
    const { result } = renderHook(() => useOmpRpcChatSession(BASE_ARGS))

    await waitFor(() => expect(result.current.status).toBe('acquired'))
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  // F7 (MEDIUM): a rejected acquire IPC call must degrade to a fail-closed
  // status, never an unhandled rejection that leaves `status` pinned at
  // 'pending' forever.
  it('degrades to a fail-closed status when acquire rejects', async () => {
    acquire.mockRejectedValue(new Error('ipc channel not registered'))
    const { result } = renderHook(() => useOmpRpcChatSession(BASE_ARGS))

    await waitFor(() => expect(result.current.status).toBe('spawn-failed'))
    expect(result.current.isOwned).toBe(false)
  })

  // Decision 1's hand-back, reconciled with F9: leaving Chat view while
  // idle releases and respawns after the initial deferral tick; a live
  // turn must settle first (never abort-and-release), and a fleeting
  // flip back to Chat view before either fires cancels the hand-back
  // entirely rather than wasting a kill+respawn.
  describe('hand-back to Terminal view', () => {
    it('releases and respawns once idle after leaving Chat view', async () => {
      acquire.mockResolvedValue({ ok: true })
      const { result, rerender } = renderHook(
        (props: UseOmpRpcChatSessionArgs) => useOmpRpcChatSession(props),
        { initialProps: BASE_ARGS }
      )
      await waitFor(() => expect(result.current.status).toBe('acquired'))

      rerender({ ...BASE_ARGS, isVisible: false })

      await waitFor(() => expect(release).toHaveBeenCalledWith({ paneKey: 'tab-1:leaf-1' }), {
        timeout: 2000
      })
      await waitFor(
        () =>
          expect(respawnPtyForOmpRpcChatHandback).toHaveBeenCalledWith({
            paneKey: 'tab-1:leaf-1',
            replacedPtyId: 'pty-1',
            cwd: '/work/a',
            sessionId: 'session-1'
          }),
        { timeout: 2000 }
      )
      await waitFor(() => expect(result.current.status).toBe('idle'))
    })

    it('defers hand-back until an in-flight turn settles, never aborting it', async () => {
      acquire.mockResolvedValue({ ok: true })
      const { result, rerender } = renderHook(
        (props: UseOmpRpcChatSessionArgs) => useOmpRpcChatSession(props),
        { initialProps: BASE_ARGS }
      )
      await waitFor(() => expect(result.current.status).toBe('acquired'))
      act(() => {
        lastSubscribedListener()({ kind: 'agent-start', frame: { type: 'agent_start' } })
      })
      expect(result.current.turnState.status).toBe('working')

      rerender({ ...BASE_ARGS, isVisible: false })

      // Give the initial deferral tick + at least one settle-poll tick a
      // real chance to elapse; the turn is still working, so release must
      // not have fired yet — Decision 1 never aborts a live turn.
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(release).not.toHaveBeenCalled()
      expect(result.current.turnState.status).toBe('working')

      act(() => {
        lastSubscribedListener()({
          kind: 'agent-end',
          frame: { type: 'agent_end', isTerminal: true }
        })
      })

      await waitFor(() => expect(release).toHaveBeenCalledWith({ paneKey: 'tab-1:leaf-1' }), {
        timeout: 2000
      })
      await waitFor(() => expect(respawnPtyForOmpRpcChatHandback).toHaveBeenCalledTimes(1), {
        timeout: 2000
      })
    })

    it('cancels the pending hand-back when the pane returns to Chat view first', async () => {
      acquire.mockResolvedValue({ ok: true })
      const { result, rerender } = renderHook(
        (props: UseOmpRpcChatSessionArgs) => useOmpRpcChatSession(props),
        { initialProps: BASE_ARGS }
      )
      await waitFor(() => expect(result.current.status).toBe('acquired'))

      rerender({ ...BASE_ARGS, isVisible: false })
      rerender({ ...BASE_ARGS, isVisible: true })

      // Wait well past the deferral tick to prove the cancellation held, not
      // just that the assertion ran before the tick fired.
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(release).not.toHaveBeenCalled()
      expect(respawnPtyForOmpRpcChatHandback).not.toHaveBeenCalled()
      expect(result.current.status).toBe('acquired')
    })

    it('does not respawn when release reports it was already unowned', async () => {
      acquire.mockResolvedValue({ ok: true })
      release.mockResolvedValue({ released: false })
      const { result, rerender } = renderHook(
        (props: UseOmpRpcChatSessionArgs) => useOmpRpcChatSession(props),
        { initialProps: BASE_ARGS }
      )
      await waitFor(() => expect(result.current.status).toBe('acquired'))

      rerender({ ...BASE_ARGS, isVisible: false })

      await waitFor(() => expect(release).toHaveBeenCalledWith({ paneKey: 'tab-1:leaf-1' }), {
        timeout: 2000
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(respawnPtyForOmpRpcChatHandback).not.toHaveBeenCalled()
    })

    it('never fires hand-back on unmount — pane close must not spawn a new PTY', async () => {
      acquire.mockResolvedValue({ ok: true })
      const { result, unmount } = renderHook(() => useOmpRpcChatSession(BASE_ARGS))
      await waitFor(() => expect(result.current.status).toBe('acquired'))

      unmount()

      expect(release).toHaveBeenCalledWith({ paneKey: 'tab-1:leaf-1' })
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(respawnPtyForOmpRpcChatHandback).not.toHaveBeenCalled()
    })
  })
})
