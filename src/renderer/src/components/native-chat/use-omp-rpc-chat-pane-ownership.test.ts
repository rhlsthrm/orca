// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type {
  OmpRpcChatAcquireArgs,
  OmpRpcChatAcquireResult,
  OmpRpcChatReleaseArgs,
  OmpRpcChatReleaseResult,
  OmpRpcChatResolveSessionIdentityArgs,
  OmpRpcChatResolveSessionIdentityResult,
  OmpRpcChatRespondExtensionUiArgs,
  OmpRpcChatSendArgs,
  OmpRpcChatSendResult,
  OmpRpcChatSubscribeArgs
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'

const resolveSessionIdentity =
  vi.fn<
    (args: OmpRpcChatResolveSessionIdentityArgs) => Promise<OmpRpcChatResolveSessionIdentityResult>
  >()
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

import {
  isOmpRpcChatSessionEligible,
  useOmpRpcChatPaneOwnership,
  type UseOmpRpcChatPaneOwnershipArgs
} from './use-omp-rpc-chat-pane-ownership'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

const BASE_ARGS: UseOmpRpcChatPaneOwnershipArgs = {
  agent: 'omp',
  paneKey: PANE_KEY,
  ptyId: 'pty-1',
  cwd: '/work/a',
  isVisible: true,
  runtimeEnvironmentId: null
}

function ownershipEntry(paneKey: string = PANE_KEY) {
  return useAppStore.getState().ompRpcChatOwnershipByPaneKey[paneKey]
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
  resolveSessionIdentity.mockResolvedValue({ sessionId: 'session-1', source: 'breadcrumb' })
  // Why: killPtyBeforeOmpRpcAcquire (Critical A) touches the real store —
  // reset it so one test's suppression/pty-binding state never leaks into
  // the next.
  useAppStore.setState(useAppStore.getInitialState(), true)
  ;(window as unknown as { api: unknown }).api = {
    ompRpcChat: {
      resolveSessionIdentity,
      acquire,
      release,
      send,
      abort,
      respondExtensionUi,
      subscribe
    },
    pty: { kill: ptyKill }
  }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('isOmpRpcChatSessionEligible', () => {
  it('requires every gate: visible, omp, local, a paneKey, and a known pty/cwd/session', () => {
    expect(
      isOmpRpcChatSessionEligible({
        agent: 'omp',
        isVisible: true,
        runtimeEnvironmentId: null,
        paneKey: PANE_KEY,
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
    { paneKey: null },
    { ptyId: null },
    { cwd: null },
    { sessionFile: null }
  ])('fails closed when %o overrides an otherwise-eligible pane', (overrides) => {
    expect(
      isOmpRpcChatSessionEligible({
        agent: 'omp',
        isVisible: true,
        runtimeEnvironmentId: null,
        paneKey: PANE_KEY,
        ptyId: 'pty-1',
        cwd: '/work/a',
        sessionFile: 'session-1',
        ...overrides
      })
    ).toBe(false)
  })
})

describe('useOmpRpcChatPaneOwnership', () => {
  it('acquires, subscribes, and feeds pushed frames through the turn reducer', async () => {
    acquire.mockResolvedValue({ ok: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    // Decision 1: the pane's PTY is killed before acquiring — the trigger
    // that closes the "no live pane ever acquires" gate — and keeps
    // scrollback for the eventual hand-back.
    expect(ptyKill).toHaveBeenCalledWith('pty-1', { keepHistory: true })
    expect(ptyKill.mock.invocationCallOrder[0]).toBeLessThan(acquire.mock.invocationCallOrder[0])
    expect(acquire).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      ptyId: 'pty-1',
      cwd: '/work/a',
      sessionFile: 'session-1'
    })
    expect(subscribe).toHaveBeenCalledTimes(1)

    act(() => {
      lastSubscribedListener()({ kind: 'agent-start', frame: { type: 'agent_start' } })
    })
    expect(ownershipEntry()?.turnState.status).toBe('working')
  })

  it('still acquires when the kill call rejects (best-effort — the registry liveness gate is the real proof)', async () => {
    ptyKill.mockRejectedValue(new Error('already gone'))
    acquire.mockResolvedValue({ ok: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  it.each(['live', 'unverifiable', 'conflict', 'spawn-failed', 'executable-not-found'] as const)(
    'degrades to the PTY path exactly as today when acquire returns "%s"',
    async (reason) => {
      acquire.mockResolvedValue({ ok: false, reason })
      renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

      await waitFor(() => expect(ownershipEntry()?.status).toBe(reason))
      expect(subscribe).not.toHaveBeenCalled()
      // The degraded pane's own turn state never leaves idle/empty, so any
      // overlay/status-override consumer sees exactly today's behavior.
      expect(ownershipEntry()?.turnState.status).toBe('idle')
    }
  )

  it('never acquires for a non-omp agent, a hidden pane, a runtime-owned pane, or no chat leaf yet', () => {
    renderHook(() => useOmpRpcChatPaneOwnership({ ...BASE_ARGS, agent: 'claude' }))
    renderHook(() => useOmpRpcChatPaneOwnership({ ...BASE_ARGS, isVisible: false }))
    renderHook(() =>
      useOmpRpcChatPaneOwnership({ ...BASE_ARGS, runtimeEnvironmentId: 'runtime-1' })
    )
    renderHook(() => useOmpRpcChatPaneOwnership({ ...BASE_ARGS, paneKey: null }))

    expect(acquire).not.toHaveBeenCalled()
  })

  // W6-2: this hook is mounted at TerminalPane, which stays mounted through
  // an ordinary Chat<->Terminal toggle — real unmount only ever means pane
  // close, tab close, or app quit. `rerender()` remains the correct model
  // for the toggle itself (it never unmounts this hook); see the F9 test
  // below for that transition and the trap note in docs/omp-rpc-chat-adapter-plan.md
  // for why the two must never be confused.
  it('releases, unsubscribes, and clears the store entry on unmount (pane/tab close)', async () => {
    acquire.mockResolvedValue({ ok: true })
    const unsubscribe = vi.fn()
    subscribe.mockReturnValue(unsubscribe)
    const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      respawn: { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }
    })
    expect(ownershipEntry()).toBeUndefined()
  })

  // F9: a visibility toggle (Chat -> Terminal and back) must never abort or
  // release an already-acquired session — only unmount, pane close, or a
  // genuine identity rebind may release. This is the real transition for
  // this hook now (TerminalPane stays mounted through it), so `rerender()`
  // is the correct model, not `unmount()`.
  it('holds the acquired session across a visibility toggle (view-away then back)', async () => {
    acquire.mockResolvedValue({ ok: true })
    const { rerender } = renderHook(
      (props: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    rerender({ ...BASE_ARGS, isVisible: false })
    rerender({ ...BASE_ARGS, isVisible: true })

    expect(ownershipEntry()?.status).toBe('acquired')
    expect(release).not.toHaveBeenCalled()
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  it('resets turn state and re-acquires on an identity rebind (ptyId change)', async () => {
    acquire.mockResolvedValue({ ok: true })
    const { rerender } = renderHook(
      (props: UseOmpRpcChatPaneOwnershipArgs) => useOmpRpcChatPaneOwnership(props),
      { initialProps: BASE_ARGS }
    )
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    act(() => {
      lastSubscribedListener()({ kind: 'agent-start', frame: { type: 'agent_start' } })
    })
    expect(ownershipEntry()?.turnState.status).toBe('working')

    rerender({ ...BASE_ARGS, ptyId: 'pty-2' })

    expect(release).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      respawn: { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }
    })
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(2))
    expect(acquire).toHaveBeenLastCalledWith({
      paneKey: PANE_KEY,
      ptyId: 'pty-2',
      cwd: '/work/a',
      sessionFile: 'session-1'
    })
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
  })

  it('never leaks a session acquired after unmount already ran', async () => {
    const { promise, resolve: resolveAcquire } = Promise.withResolvers<OmpRpcChatAcquireResult>()
    acquire.mockReturnValue(promise)
    const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

    // Wait for the async identity resolution + pty-kill sequence to reach
    // the acquire call itself, so unmount genuinely races an in-flight
    // acquisition rather than firing before it ever started.
    await waitFor(() => expect(acquire).toHaveBeenCalled())
    unmount()
    resolveAcquire({ ok: true })
    await waitFor(() =>
      expect(release).toHaveBeenCalledWith({
        paneKey: PANE_KEY,
        respawn: { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }
      })
    )
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('routes send/abort through the store actions and fails closed when not acquired', async () => {
    acquire.mockResolvedValue({ ok: false, reason: 'live' })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('live'))

    const sendResult = await useAppStore
      .getState()
      .sendOmpRpcChatPane(PANE_KEY, { message: 'hi', behavior: 'idle' })
    const abortResult = await useAppStore.getState().abortOmpRpcChatPane(PANE_KEY)

    expect(sendResult.ok).toBe(false)
    expect(abortResult.ok).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(abort).not.toHaveBeenCalled()
  })

  it('sends and aborts through the API once acquired, keyed by paneKey alone', async () => {
    acquire.mockResolvedValue({ ok: true })
    send.mockResolvedValue({ ok: true, agentInvoked: true })
    abort.mockResolvedValue({ ok: true, agentInvoked: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

    await useAppStore.getState().sendOmpRpcChatPane(PANE_KEY, { message: 'hi', behavior: 'steer' })
    await useAppStore.getState().abortOmpRpcChatPane(PANE_KEY)

    expect(send).toHaveBeenCalledWith({ paneKey: PANE_KEY, message: 'hi', behavior: 'steer' })
    expect(abort).toHaveBeenCalledWith({ paneKey: PANE_KEY })
  })

  it('answers extension UI by dispatching the reducer action and forwarding the reply', async () => {
    acquire.mockResolvedValue({ ok: true })
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    act(() => {
      lastSubscribedListener()({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'req-1', method: 'confirm' }
      })
    })
    expect(ownershipEntry()?.turnState.pendingExtensionUiRequest?.id).toBe('req-1')

    act(() => {
      useAppStore.getState().respondOmpRpcChatExtensionUi(PANE_KEY, {
        type: 'extension_ui_response',
        id: 'req-1',
        confirmed: true
      })
    })

    expect(respondExtensionUi).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      response: { type: 'extension_ui_response', id: 'req-1', confirmed: true }
    })
    expect(ownershipEntry()?.turnState.pendingExtensionUiRequest).toBeNull()
  })

  // F3 (HIGH): a protocol-fault or exit frame mid-turn must flip status away
  // from 'acquired' and release the dead session so the caller's send path
  // falls back to PTY, instead of staying stuck claiming a session that will
  // never stream another frame.
  it.each(['protocol-fault', 'exit'] as const)(
    'flips to faulted and releases on a "%s" frame',
    async (kind) => {
      acquire.mockResolvedValue({ ok: true })
      renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
      await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

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

      expect(ownershipEntry()?.status).toBe('faulted')
      await waitFor(() => expect(release).toHaveBeenCalledWith({ paneKey: PANE_KEY }))

      const sendResult = await useAppStore
        .getState()
        .sendOmpRpcChatPane(PANE_KEY, { message: 'hi', behavior: 'idle' })
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
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

    await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  // F7 (MEDIUM): a rejected acquire IPC call must degrade to a fail-closed
  // status, never an unhandled rejection that leaves status pinned at
  // 'pending' forever.
  it('degrades to a fail-closed status when acquire rejects', async () => {
    acquire.mockRejectedValue(new Error('ipc channel not registered'))
    renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

    await waitFor(() => expect(ownershipEntry()?.status).toBe('spawn-failed'))
  })

  // Critical A (cross-lab review, wave 5): killPtyBeforeOmpRpcAcquire used
  // to kill the pane's live PTY without suppressing the exit, so the
  // eventual pty:exit landed on pty-exit-hibernate.ts's "process died"
  // teardown instead of its suppressed branch — closing the whole tab for
  // the common single-pane case. Suppressing (and proactively clearing the
  // tab's pty binding to a well-defined "RPC-owned, no PTY" state) routes
  // that later, real exit to the suppressed branch instead — no tab-close
  // path is reachable from a suppressed exit.
  describe('Critical A — suppressing the pty exit before kill', () => {
    beforeEach(() => {
      useAppStore.setState({
        tabsByWorktree: {
          'wt-1': [
            {
              id: 'tab-1',
              ptyId: 'pty-1',
              worktreeId: 'wt-1',
              title: null,
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              launchAgent: 'omp' as const
            }
          ]
        } as never,
        ptyIdsByTabId: { 'tab-1': ['pty-1'] }
      })
    })

    it('suppresses the exit and clears the tab pty binding before killing', async () => {
      acquire.mockResolvedValue({ ok: true })
      let suppressedBeforeKill = false
      let clearedBeforeKill = false
      ptyKill.mockImplementation(async () => {
        suppressedBeforeKill = useAppStore.getState().suppressedPtyExitIds['pty-1'] === true
        clearedBeforeKill = useAppStore.getState().tabsByWorktree['wt-1']?.[0]?.ptyId === null
      })

      renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))

      await waitFor(() => expect(ptyKill).toHaveBeenCalled())
      expect(suppressedBeforeKill).toBe(true)
      expect(clearedBeforeKill).toBe(true)
      // Left ARMED, not self-consumed: onExit itself must be the one to
      // consume it once the real exit round-trips back — self-consuming
      // here would leave that later, real exit unsuppressed and fall
      // through to the tab-close bug this suppression exists to prevent.
      expect(useAppStore.getState().suppressedPtyExitIds['pty-1']).toBe(true)
    })
  })

  // Critical B (cross-lab review, wave 5), still true after relocation: the
  // actual settle-wait, release ordering, and respawn live on main and in
  // the durable TerminalPane listener (omp-rpc-session-owner.test.ts and
  // use-omp-rpc-chat-handback-listener.test.ts) — this hook only expresses
  // intent and returns.
  describe('hand-back to Terminal view (Critical B)', () => {
    it('requests release with respawn context on real unmount (pane/tab close), and never aborts the turn itself', async () => {
      acquire.mockResolvedValue({ ok: true })
      const { unmount } = renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
      await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))
      act(() => {
        lastSubscribedListener()({ kind: 'agent-start', frame: { type: 'agent_start' } })
      })
      expect(ownershipEntry()?.turnState.status).toBe('working')

      unmount()

      // Why: aborting a live turn is main's call now (handoffToPty's
      // allowAbort opt-in, gated by main owning the settle-wait) — never
      // this hook's. It only expresses intent and returns.
      expect(abort).not.toHaveBeenCalled()
      expect(release).toHaveBeenCalledWith({
        paneKey: PANE_KEY,
        respawn: { replacedPtyId: 'pty-1', cwd: '/work/a', sessionId: 'session-1' }
      })
    })

    it('does not attach respawn context when a protocol fault releases the session', async () => {
      acquire.mockResolvedValue({ ok: true })
      renderHook(() => useOmpRpcChatPaneOwnership(BASE_ARGS))
      await waitFor(() => expect(ownershipEntry()?.status).toBe('acquired'))

      act(() => {
        lastSubscribedListener()({ kind: 'exit', code: 1, signal: null })
      })

      await waitFor(() => expect(release).toHaveBeenCalledWith({ paneKey: PANE_KEY }))
      expect(release).not.toHaveBeenCalledWith(
        expect.objectContaining({ respawn: expect.anything() })
      )
    })
  })
})
