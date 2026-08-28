// Decision 2: resolve an OMP pane's session identity from OMP's own on-disk
// state (main-process `ompRpcChat:resolveSessionIdentity`, backed by
// omp-terminal-session-identity.ts) instead of the broken agent-status hook
// chain. This is the value `useOmpRpcChatSession` expects as `sessionFile`
// (despite the name, always a bare session id for omp — see that hook's own
// doc comment); a null return means "nothing to resume yet", which correctly
// keeps that hook's eligibility gate closed rather than guessing.
//
// Standing rule (wave 9, Defect 1): nothing on this path may require or key
// on a live `ptyId`. Decision 1's acquisition kills the pane's PTY on
// success, so gating identity eligibility on `ptyId !== null` — or including
// it in the cache key — makes the feature's own success discard the
// identity it just resolved. `cwd` + agent + local-runtime is the real
// precondition; `ptyId` is an optional accuracy input (it unlocks the
// breadcrumb path, strictly better when available) whose absence degrades
// to the mtime fallback, never to ineligibility.

import { useEffect, useRef, useState } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { isOmpRpcCatalogAgent } from './use-omp-rpc-commands'

export type UseOmpPaneSessionIdentityArgs = {
  agent: AgentType | null
  paneKey: string | null
  ptyId: string | null
  cwd: string | null
  runtimeEnvironmentId: string | null
  isVisible: boolean
}

type ResolvedForIdentity = { identityKey: string; sessionId: string | null }

export function useOmpPaneSessionIdentity(args: UseOmpPaneSessionIdentityArgs): string | null {
  const { agent, paneKey, ptyId, cwd, runtimeEnvironmentId, isVisible } = args
  // Stable for the pane's life — a PTY dying, being cleared by acquisition,
  // or being respawned by hand-back must never invalidate an
  // already-resolved identity. `paneKey` (not `ptyId`) is the thing that is
  // actually stable across that churn.
  const identityKey = `${paneKey ?? ''}:${cwd ?? ''}`
  const [resolved, setResolved] = useState<ResolvedForIdentity>({
    identityKey: '',
    sessionId: null
  })
  // Why a latch, not raw `isVisible`, gates the fetch effect: resolution
  // should run once per identity the first time the pane is ever visible,
  // then stay resolved across later visibility toggles — a bare glance at
  // Terminal view and back must never cost a second IPC round trip (mirrors
  // the identical latch in use-omp-rpc-chat-session.ts, F9).
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
  const identityEligible =
    isOmpRpcCatalogAgent(agent) && runtimeEnvironmentId === null && paneKey !== null && cwd !== null
  const eligible = identityEligible && visibilityLatchRef.current.wasVisible

  useEffect(() => {
    if (!eligible) {
      return
    }
    const api = window.api?.ompRpcChat
    if (!api) {
      return
    }
    let cancelled = false
    // Sticky merge (Defect 1 fix requirement): re-resolution — e.g.
    // retried because `ptyId` just appeared and can upgrade a
    // mtime-fallback guess to a breadcrumb hit — may only ever CONFIRM an
    // already-resolved non-null id for this identity, never downgrade it
    // to null and never silently swap it for a different session. A
    // genuine rebind changes `identityKey` instead, which resets this
    // state naturally on the next render.
    const mergeSticky = (sessionId: string | null): void => {
      if (cancelled) {
        return
      }
      setResolved((prev) => {
        if (prev.identityKey === identityKey && prev.sessionId !== null) {
          return prev
        }
        return { identityKey, sessionId }
      })
    }
    void api
      .resolveSessionIdentity({ paneKey: paneKey as string, ptyId, cwd: cwd as string })
      .then((result) => mergeSticky(result?.sessionId ?? null))
      .catch(() => mergeSticky(null))
    return () => {
      cancelled = true
    }
  }, [eligible, identityKey, paneKey, ptyId, cwd])

  return resolved.identityKey === identityKey ? resolved.sessionId : null
}
