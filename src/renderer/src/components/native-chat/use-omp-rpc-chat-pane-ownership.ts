// Anchors RPC ownership (Decision 1, wave 4/5's kill-and-resume acquisition)
// to the pane's life, not a Chat-view mount. Mounted once in TerminalPane —
// which the codebase already keeps deliberately mounted through the
// Chat-view unmount for exactly this reason (wave 5 put the hand-back
// listener there, use-omp-rpc-chat-handback-listener.ts) — this hook never
// unmounts on an ordinary Terminal<->Chat toggle, only on pane/tab close,
// an identity rebind, or app quit. It publishes status/turnState into the
// ompRpcChatPaneOwnership store slice (paneKey-scoped, mirroring
// agentStatusByPaneKey) instead of returning React state: NativeChatView is
// a pure remountable subscriber to that slice and owns none of this
// lifecycle (use-native-chat-omp-rpc-integration.ts).
//
// Composes use-omp-pane-session-identity.ts (Decision 2) internally, so the
// session-id resolution that acquisition depends on lives on the same
// pane-anchored lifecycle as the acquisition itself.

import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { OmpRpcChatAcquireResult } from '../../../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { isOmpRpcCatalogAgent } from './use-omp-rpc-commands'
import { useOmpPaneSessionIdentity } from './use-omp-pane-session-identity'

export type UseOmpRpcChatPaneOwnershipArgs = {
  agent: AgentType | null
  /** Composite `${tabId}:${leafId}` key of the pane currently designated as
   *  the tab's chat leaf; null when no leaf has ever been chosen. */
  paneKey: string | null
  ptyId: string | null
  cwd: string | null
  /** True only while the Chat view is actually showing this leaf and the
   *  tab is rendered — the trigger for the FIRST acquisition. Later drops
   *  to false on an ordinary Terminal<->Chat toggle without releasing
   *  (F9's latch below), which is the entire point of anchoring this hook
   *  here instead of inside the (un)mountable chat surface. */
  isVisible: boolean
  /** Non-null routes the pane to a remote runtime host (Model B); this
   *  milestone is local-only (D2), so a runtime-owned pane never acquires. */
  runtimeEnvironmentId: string | null
}

/** All four conditions the brief names: visible, OMP, a known session
 *  identity, and a local (non-runtime-owned) pane. Exported pure so the
 *  acquisition gate is unit-testable without mounting the hook. */
export function isOmpRpcChatSessionEligible(args: {
  agent: AgentType | null
  isVisible: boolean
  runtimeEnvironmentId: string | null
  paneKey: string | null
  ptyId: string | null
  cwd: string | null
  sessionFile: string | null
}): boolean {
  return (
    args.isVisible &&
    isOmpRpcCatalogAgent(args.agent) &&
    args.runtimeEnvironmentId === null &&
    args.paneKey !== null &&
    args.ptyId !== null &&
    args.cwd !== null &&
    args.sessionFile !== null
  )
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
 *  dead transport must flip status away from 'acquired' so sends route back
 *  to PTY. */
function subscribeOmpRpcChatFrames(
  api: NonNullable<typeof window.api.ompRpcChat>,
  paneKey: string,
  dispatchTurnAction: (paneKey: string, event: OmpRpcClientEvent) => void,
  onFatalFrame: () => void
): () => void {
  const subscriptionId = nextOmpRpcChatSubscriptionId()
  return api.subscribe({ paneKey, subscriptionId }, (event) => {
    dispatchTurnAction(paneKey, event)
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

/** Acquires (and holds, for the pane's life) an RPC-owned OMP chat session,
 *  publishing status/turnState into the ompRpcChatOwnershipByPaneKey store
 *  slice. Returns void — every consumer reads the slice, never this hook's
 *  own return value, so remounting the chat surface never re-triggers
 *  acquisition or loses in-flight state. */
export function useOmpRpcChatPaneOwnership(args: UseOmpRpcChatPaneOwnershipArgs): void {
  const { agent, paneKey, ptyId, cwd, isVisible, runtimeEnvironmentId } = args
  // Decision 2: resolved from OMP's own on-disk state, on the same
  // pane-anchored lifecycle as acquisition itself now — see that hook's own
  // doc comment for why a null return correctly keeps acquisition closed.
  const sessionFile = useOmpPaneSessionIdentity({
    agent,
    ptyId,
    cwd,
    runtimeEnvironmentId,
    isVisible
  })
  const setOmpRpcChatPaneStatus = useAppStore((s) => s.setOmpRpcChatPaneStatus)
  const dispatchOmpRpcChatTurnAction = useAppStore((s) => s.dispatchOmpRpcChatTurnAction)
  const clearOmpRpcChatPaneOwnership = useAppStore((s) => s.clearOmpRpcChatPaneOwnership)
  // Why (F9): visibility gates the FIRST acquisition (don't spawn an RPC
  // child for a pane whose Chat view has never been opened) but must never
  // trigger release on its own afterward — toggling Chat -> Terminal and
  // back must not abort a live turn. The latch remembers "has this identity
  // ever been visible" and only resets on a genuine identity rebind.
  const identityKey = `${paneKey ?? ''}:${ptyId ?? ''}:${cwd ?? ''}:${sessionFile ?? ''}`
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
    paneKey !== null &&
    isOmpRpcCatalogAgent(agent) &&
    runtimeEnvironmentId === null &&
    ptyId !== null &&
    cwd !== null &&
    sessionFile !== null
  const eligible = identityEligible && visibilityLatchRef.current.wasVisible

  useEffect(() => {
    generationRef.current += 1
    const generation = generationRef.current
    if (paneKey === null) {
      return
    }
    // Every identity rebind (including going eligible -> ineligible) starts
    // the next turn's overlay from empty, so a previous pane's content can
    // never bleed into this one.
    setOmpRpcChatPaneStatus(paneKey, 'idle')
    dispatchOmpRpcChatTurnAction(paneKey, { type: 'reset' })
    if (!eligible) {
      return () => {
        clearOmpRpcChatPaneOwnership(paneKey)
      }
    }
    const api = window.api?.ompRpcChat
    if (!api) {
      setOmpRpcChatPaneStatus(paneKey, 'spawn-failed')
      return () => {
        clearOmpRpcChatPaneOwnership(paneKey)
      }
    }
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    let acquiredThisEffect = false
    setOmpRpcChatPaneStatus(paneKey, 'pending')

    // Critical B: expresses hand-back intent to main alongside every
    // release this effect fires — whether from cleanup (identity rebind,
    // pane/tab close, app quit) or from the cancelled-before-acquired race
    // below. Main decides whether a respawn actually happens (only once
    // release genuinely settles+exits, via the `ompRpcChat:handback` push
    // event); this hook never waits for or drives the respawn itself — see
    // use-omp-rpc-chat-handback-listener.ts, which TerminalPane subscribes
    // to for exactly that reason.
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
        // status pinned at 'pending' forever.
        .catch((): OmpRpcChatAcquireResult => ({ ok: false, reason: 'spawn-failed' }))

    const onFatalFrame = (): void => {
      if (generation !== generationRef.current) {
        return
      }
      setOmpRpcChatPaneStatus(paneKey, 'faulted')
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
        setOmpRpcChatPaneStatus(paneKey, result.reason)
        return
      }
      acquiredThisEffect = true
      setOmpRpcChatPaneStatus(paneKey, 'acquired')
      unsubscribe = subscribeOmpRpcChatFrames(
        api,
        paneKey,
        (key, event) => dispatchOmpRpcChatTurnAction(key, { type: 'frame', event }),
        onFatalFrame
      )
    })()

    return () => {
      cancelled = true
      unsubscribe?.()
      unsubscribe = null
      if (acquiredThisEffect) {
        acquiredThisEffect = false
        void api.release({ paneKey, respawn: respawnContext }).catch(() => {})
      }
      clearOmpRpcChatPaneOwnership(paneKey)
    }
  }, [
    eligible,
    paneKey,
    ptyId,
    cwd,
    sessionFile,
    setOmpRpcChatPaneStatus,
    dispatchOmpRpcChatTurnAction,
    clearOmpRpcChatPaneOwnership
  ])
}
