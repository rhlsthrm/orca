// Binds one pane to an RPC-owned OMP chat session (wave 4/5: kill-and-resume
// acquisition, Decision 1). Chat-view activation acquires a live PTY-hosted
// OMP session by killing that PTY and resuming it in an RPC child, holding
// RPC ownership for the pane's life. Leaving Chat view (this hook
// unmounting — TerminalPane.tsx's portal render gate returning null, NOT an
// `isVisible` prop flip on a persistently-mounted instance) fires this same
// acquire effect's cleanup, which asks main to release + hand the pane back
// once any in-flight turn settles. Main owns that settle-wait (wave 5); the
// actual PTY respawn is driven from TerminalPane (an always-mounted
// surface), not from this (un)mountable hook — see
// use-omp-rpc-chat-handback-listener.ts and docs/omp-rpc-chat-adapter-plan.md's
// Decision 1 (wave 5 amendment) for why. Every other agent, and every OMP
// pane that fails to acquire, is a pure no-op here — the caller degrades to
// today's PTY+transcript behavior (D1).

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  OmpRpcChatAcquireFailureReason,
  OmpRpcChatAcquireResult,
  OmpRpcChatSendBehavior,
  OmpRpcChatSendResult
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import type {
  OmpRpcExtensionUiResponse,
  OmpRpcImageContent
} from '../../../../shared/omp-rpc-protocol'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { isOmpRpcCatalogAgent } from './use-omp-rpc-commands'
import {
  createInitialOmpRpcTurnState,
  ompRpcTurnReducer,
  type OmpRpcTurnAction,
  type OmpRpcTurnState
} from './omp-rpc-turn-reducer'

export type OmpRpcChatSessionStatus =
  | 'idle'
  | 'pending'
  | 'acquired'
  // Why (F3): the RPC child exited or protocol-faulted mid-turn — a terminal
  // failure distinct from 'acquired' so `isOwned` flips false and sends fall
  // back to PTY (D1), instead of staying stuck claiming a dead session.
  | 'faulted'
  | OmpRpcChatAcquireFailureReason

export type UseOmpRpcChatSessionArgs = {
  agent: AgentType
  /** Composite `${tabId}:${leafId}` key — the acquisition's identity. */
  paneKey: string
  ptyId: string | null
  cwd: string | null
  /** OMP resumes by session id, not a filesystem path (agent-status-extension-
   *  source.ts #8962): the value that round-trips through OMP's own
   *  `switch_session`/`get_state().sessionFile`. Callers resolve this from
   *  OMP's own on-disk state (use-omp-pane-session-identity.ts, Decision 2 —
   *  bypasses the broken agent-status hook chain), not from the hook, and
   *  pass it here despite the contract's `sessionFile` name. */
  sessionFile: string | null
  isVisible: boolean
  /** Non-null routes the pane to a remote runtime host (Model B); this
   *  milestone is local-only (D2), so a runtime-owned pane never acquires. */
  runtimeEnvironmentId: string | null
}

export type OmpRpcChatSessionSendArgs = {
  message: string
  images?: OmpRpcImageContent[]
  behavior: OmpRpcChatSendBehavior
}

export type OmpRpcChatSessionHandle = {
  status: OmpRpcChatSessionStatus
  isOwned: boolean
  turnState: OmpRpcTurnState
  send: (args: OmpRpcChatSessionSendArgs) => Promise<OmpRpcChatSendResult>
  abort: () => Promise<OmpRpcChatSendResult>
  respondExtensionUi: (response: OmpRpcExtensionUiResponse) => void
}

/** All four conditions the brief names: visible, OMP, a known session
 *  identity, and a local (non-runtime-owned) pane. Exported pure so the
 *  acquisition gate is unit-testable without mounting the hook. */
export function isOmpRpcChatSessionEligible(args: {
  agent: AgentType
  isVisible: boolean
  runtimeEnvironmentId: string | null
  ptyId: string | null
  cwd: string | null
  sessionFile: string | null
}): boolean {
  return (
    args.isVisible &&
    isOmpRpcCatalogAgent(args.agent) &&
    args.runtimeEnvironmentId === null &&
    args.ptyId !== null &&
    args.cwd !== null &&
    args.sessionFile !== null
  )
}

const NOT_OWNED_RESULT: OmpRpcChatSendResult = {
  ok: false,
  reason: 'no RPC-owned session for this pane'
}

let subscriptionCounter = 0
function nextOmpRpcChatSubscriptionId(): string {
  subscriptionCounter += 1
  return `omp-rpc-chat-${subscriptionCounter}-${Date.now()}`
}

/** Lives outside the effect: react-doctor's effect-needs-cleanup
 *  false-positives on `subscribe` calls inside an effect body (see the
 *  identical note in useDashboardPopoutBridge.ts); the effect's own returned
 *  cleanup below still owns and calls the unsubscribe this returns.
 *  `onFatalFrame` fires for `exit`/`protocol-fault` (F3): the reducer itself
 *  stays a pure state machine, but the hook is the D1 fallback boundary — a
 *  dead transport must flip `isOwned` false so sends route back to PTY. */
function subscribeOmpRpcChatFrames(
  api: NonNullable<typeof window.api.ompRpcChat>,
  paneKey: string,
  dispatch: (action: OmpRpcTurnAction) => void,
  onFatalFrame: () => void
): () => void {
  const subscriptionId = nextOmpRpcChatSubscriptionId()
  return api.subscribe({ paneKey, subscriptionId }, (event) => {
    dispatch({ type: 'frame', event })
    if (event.kind === 'exit' || event.kind === 'protocol-fault') {
      onFatalFrame()
    }
  })
}

/** Bounded backoff before retrying a single `agent_session_conflict` (F5):
 *  covers the release-in-flight and StrictMode-double-acquire windows without
 *  looping forever on a genuine, persistent conflict. */
const CONFLICT_RETRY_DELAY_MS = 250

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/** Decision 1's acquire trigger: kill the pane's live PTY (scrollback kept
 *  for the eventual hand-back) so the registry's existing exit-proof gate —
 *  unchanged — sees it as exited and proceeds. Best-effort: an already-dead
 *  PTY or a transient kill failure must not block acquisition; the registry's
 *  liveness check is the actual proof gate and fails closed on its own.
 *
 *  Why (Critical A, cross-lab review): every OTHER intentional-kill site in
 *  this codebase (codex-detached-pane-restart.ts, the hibernation/sleep
 *  flows) suppresses the pty:exit before killing a PTY it means to replace,
 *  so pty-exit-hibernate.ts's onExit lands on its suppressed branch instead
 *  of the "process died" teardown, which — for the ordinary single-pane tab
 *  — closes the whole tab (`panes.length <= 1` -> `onPtyExitRef.current` ->
 *  `closeTerminalTab`). This function used to skip suppression entirely.
 *  The suppression flag is left ARMED here, not self-consumed: onExit
 *  itself must be the one to consume it once the real exit round-trips
 *  back — self-consuming now would leave that later, real exit unsuppressed
 *  and fall through to the same tab-close bug. `clearTabPtyId` is also
 *  called proactively, putting the tab into a well-defined "RPC-owned, no
 *  PTY" state immediately rather than waiting on the kill's async round
 *  trip — onExit's own cleanup would eventually do this too (gated only on
 *  `preserveRendererBinding`, which this never sets), just not until the
 *  daemon confirms the exit. */
async function killPtyBeforeOmpRpcAcquire(paneKey: string, ptyId: string): Promise<void> {
  const store = useAppStore.getState()
  store.suppressPtyExit(ptyId)
  const parsed = parsePaneKey(paneKey)
  if (parsed) {
    store.clearTabPtyId(parsed.tabId, ptyId)
  }
  try {
    await window.api?.pty?.kill(ptyId, { keepHistory: true })
  } catch {
    // Ignored — see doc comment above.
  }
}

export function useOmpRpcChatSession(args: UseOmpRpcChatSessionArgs): OmpRpcChatSessionHandle {
  const { agent, paneKey, ptyId, cwd, sessionFile, isVisible, runtimeEnvironmentId } = args
  const [status, setStatus] = useState<OmpRpcChatSessionStatus>('idle')
  const [turnState, dispatch] = useReducer(
    ompRpcTurnReducer,
    undefined,
    createInitialOmpRpcTurnState
  )
  // Read inside stable callbacks below without adding `status` to their deps.
  const statusRef = useRef(status)
  statusRef.current = status
  // Why (F9): visibility gates the FIRST acquisition (don't spawn an RPC
  // child for a pane whose Chat view has never been opened) but must never
  // trigger release on its own afterward — toggling Chat -> Terminal and
  // back must not abort a live turn. The latch remembers "has this identity
  // ever been visible" and only resets on a genuine identity rebind.
  const identityKey = `${paneKey}:${ptyId ?? ''}:${cwd ?? ''}:${sessionFile ?? ''}`
  const visibilityLatchRef = useRef<{ key: string; wasVisible: boolean }>({
    key: identityKey,
    wasVisible: false
  })
  if (visibilityLatchRef.current.key !== identityKey) {
    visibilityLatchRef.current = { key: identityKey, wasVisible: false }
  }
  if (isVisible) {
    visibilityLatchRef.current.wasVisible = true
  }
  // Why (F5): every effect run gets a new generation; a callback whose
  // generation the ref has since moved past was superseded by a later
  // effect run (StrictMode's double mount, or a rapid rebind) and must do
  // nothing — the newer run alone owns the acquire/release lifecycle for
  // this identity, so both callbacks racing to act on the same promise can
  // never both mutate state or both release.
  const generationRef = useRef(0)

  const identityEligible =
    isOmpRpcCatalogAgent(agent) &&
    runtimeEnvironmentId === null &&
    ptyId !== null &&
    cwd !== null &&
    sessionFile !== null
  const eligible = identityEligible && visibilityLatchRef.current.wasVisible

  useEffect(() => {
    // Every identity rebind (including going eligible -> ineligible) starts
    // the next turn's overlay from empty, so a previous pane's content can
    // never bleed into this one.
    dispatch({ type: 'reset' })
    generationRef.current += 1
    const generation = generationRef.current
    if (!eligible) {
      setStatus('idle')
      return
    }
    const api = window.api?.ompRpcChat
    if (!api) {
      setStatus('spawn-failed')
      return
    }
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    let acquiredThisEffect = false
    setStatus('pending')

    // Critical B: expresses hand-back intent to main alongside every
    // release this effect fires — whether from cleanup (unmount: leave
    // Chat view, pane close, app quit) or from the cancelled-before-acquired
    // race below. Main decides whether a respawn actually happens (only
    // once release genuinely settles+exits, via the `ompRpcChat:handback`
    // push event); this hook never waits for or drives the respawn itself —
    // see use-omp-rpc-chat-handback-listener.ts, which TerminalPane (an
    // always-mounted surface) subscribes to for exactly that reason.
    const respawnContext = {
      replacedPtyId: ptyId as string,
      cwd: cwd as string,
      sessionId: sessionFile as string
    }

    const acquireOnce = (): Promise<OmpRpcChatAcquireResult> =>
      api
        .acquire({
          paneKey,
          ptyId: ptyId as string,
          cwd: cwd as string,
          sessionFile: sessionFile as string
        })
        // Why (F7): a rejection crossing the IPC boundary (e.g. the main
        // handler's executable resolution throwing) must degrade to a
        // fail-closed result, not an unhandled rejection that leaves
        // `status` pinned at 'pending' forever.
        .catch((): OmpRpcChatAcquireResult => ({ ok: false, reason: 'spawn-failed' }))

    const onFatalFrame = (): void => {
      if (generation !== generationRef.current) {
        return
      }
      setStatus('faulted')
      unsubscribe?.()
      unsubscribe = null
      acquiredThisEffect = false
      // Why no respawn context: a protocol fault/exit means the RPC child
      // itself already died — there is no live turn to hand back, only a
      // dead claim to release, so this stays a bare release.
      void api.release({ paneKey }).catch(() => {})
    }

    void (async () => {
      // Decision 1: the PTY is very likely still live (that is the normal
      // case now — chat-view activation is the trigger, not a PTY that
      // happened to exit on its own). Kill it first so the unchanged
      // exit-proof gate inside acquireOnce() sees a genuinely exited PTY.
      if (!cancelled) {
        await killPtyBeforeOmpRpcAcquire(paneKey, ptyId as string)
      }
      let result = await acquireOnce()
      if (!result.ok && result.reason === 'conflict' && !cancelled) {
        // Why (F5): a conflict is very often a transient race — an in-flight
        // release still holding the claim, or StrictMode's double mount —
        // not a real double-owner. Retry once with bounded backoff before
        // surfacing failure.
        await delay(CONFLICT_RETRY_DELAY_MS)
        if (generation === generationRef.current) {
          result = await acquireOnce()
        }
      }
      if (generation !== generationRef.current) {
        // Superseded by a later effect run, which owns this identity's
        // lifecycle now — never release out from under it.
        return
      }
      if (cancelled) {
        // The pane unmounted, went invisible-before-ever-visible, or
        // rebound identity while the acquisition was in flight — never
        // leave a just-acquired child holding the session hostage, and
        // never strand the pane without a PTY: its live one was already
        // killed above, so ask for the same hand-back a normal unmount
        // would.
        if (result.ok) {
          void api.release({ paneKey, respawn: respawnContext }).catch(() => {})
        }
        return
      }
      if (!result.ok) {
        setStatus(result.reason)
        return
      }
      acquiredThisEffect = true
      setStatus('acquired')
      unsubscribe = subscribeOmpRpcChatFrames(api, paneKey, dispatch, onFatalFrame)
    })()

    return () => {
      cancelled = true
      unsubscribe?.()
      unsubscribe = null
      if (acquiredThisEffect) {
        acquiredThisEffect = false
        void api.release({ paneKey, respawn: respawnContext }).catch(() => {})
      }
    }
  }, [eligible, paneKey, ptyId, cwd, sessionFile])

  const send = useCallback(
    (sendArgs: OmpRpcChatSessionSendArgs): Promise<OmpRpcChatSendResult> => {
      const api = window.api?.ompRpcChat
      if (statusRef.current !== 'acquired' || !api) {
        return Promise.resolve(NOT_OWNED_RESULT)
      }
      return api.send({ paneKey, ...sendArgs })
    },
    [paneKey]
  )

  const abort = useCallback((): Promise<OmpRpcChatSendResult> => {
    const api = window.api?.ompRpcChat
    if (statusRef.current !== 'acquired' || !api) {
      return Promise.resolve(NOT_OWNED_RESULT)
    }
    return api.abort({ paneKey })
  }, [paneKey])

  const respondExtensionUi = useCallback(
    (response: OmpRpcExtensionUiResponse): void => {
      // Dispatch unconditionally: the reducer's dismiss is a local UI concern
      // independent of whether the IPC round trip below can still land.
      dispatch({ type: 'extension-ui-answered', requestId: response.id })
      // Why (F7): fire-and-forget, but a rejected IPC round trip must not
      // become an unhandled promise rejection.
      void window.api?.ompRpcChat?.respondExtensionUi({ paneKey, response })?.catch(() => {})
    },
    [paneKey]
  )

  return { status, isOwned: status === 'acquired', turnState, send, abort, respondExtensionUi }
}
