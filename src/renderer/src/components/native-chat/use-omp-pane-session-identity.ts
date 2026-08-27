// Decision 2: resolve an OMP pane's session identity from OMP's own on-disk
// state (main-process `ompRpcChat:resolveSessionIdentity`, backed by
// omp-terminal-session-identity.ts) instead of the broken agent-status hook
// chain. This is the value `useOmpRpcChatSession` expects as `sessionFile`
// (despite the name, always a bare session id for omp — see that hook's own
// doc comment); a null return means "nothing to resume yet", which correctly
// keeps that hook's eligibility gate closed rather than guessing.

import { useEffect, useRef, useState } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { isOmpRpcCatalogAgent } from './use-omp-rpc-commands'

export type UseOmpPaneSessionIdentityArgs = {
  agent: AgentType
  ptyId: string | null
  cwd: string | null
  runtimeEnvironmentId: string | null
  isVisible: boolean
}

type ResolvedForIdentity = { identityKey: string; sessionId: string | null }

export function useOmpPaneSessionIdentity(args: UseOmpPaneSessionIdentityArgs): string | null {
  const { agent, ptyId, cwd, runtimeEnvironmentId, isVisible } = args
  const identityKey = `${ptyId ?? ''}:${cwd ?? ''}`
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
    isOmpRpcCatalogAgent(agent) && runtimeEnvironmentId === null && ptyId !== null && cwd !== null
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
    void api
      .resolveSessionIdentity({ ptyId: ptyId as string, cwd: cwd as string })
      .then((result) => {
        if (!cancelled) {
          setResolved({ identityKey, sessionId: result?.sessionId ?? null })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolved({ identityKey, sessionId: null })
        }
      })
    return () => {
      cancelled = true
    }
  }, [eligible, identityKey, ptyId, cwd])

  return resolved.identityKey === identityKey ? resolved.sessionId : null
}
