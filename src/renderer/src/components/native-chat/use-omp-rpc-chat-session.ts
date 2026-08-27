// Binds one pane to an RPC-owned OMP chat session (milestone 1 wave 2):
// acquires ownership when eligible, feeds every pushed frame through the wave-1
// turn reducer, and guarantees the acquisition never outlives the pane. Every
// other agent, and every OMP pane that fails to acquire, is a pure no-op here —
// the caller degrades to today's PTY+transcript behavior (D1).

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  OmpRpcChatAcquireFailureReason,
  OmpRpcChatSendBehavior,
  OmpRpcChatSendResult
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import type {
  OmpRpcExtensionUiResponse,
  OmpRpcImageContent
} from '../../../../shared/omp-rpc-protocol'
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
  | OmpRpcChatAcquireFailureReason

export type UseOmpRpcChatSessionArgs = {
  agent: AgentType
  /** Composite `${tabId}:${leafId}` key — the acquisition's identity. */
  paneKey: string
  ptyId: string | null
  cwd: string | null
  /** OMP resumes by session id, not a filesystem path (agent-status-extension-
   *  source.ts #8962): the hook's `providerSession.id` is the value that round-
   *  trips through OMP's own `switch_session`/`get_state().sessionFile`, so
   *  callers pass the pane's resolved sessionId here despite the contract's
   *  `sessionFile` name. */
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
 *  cleanup below still owns and calls the unsubscribe this returns. */
function subscribeOmpRpcChatFrames(
  api: NonNullable<typeof window.api.ompRpcChat>,
  paneKey: string,
  dispatch: (action: OmpRpcTurnAction) => void
): () => void {
  const subscriptionId = nextOmpRpcChatSubscriptionId()
  return api.subscribe({ paneKey, subscriptionId }, (event) => {
    dispatch({ type: 'frame', event })
  })
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

  const eligible = isOmpRpcChatSessionEligible({
    agent,
    isVisible,
    runtimeEnvironmentId,
    ptyId,
    cwd,
    sessionFile
  })

  useEffect(() => {
    // Every identity rebind (including going eligible -> ineligible) starts
    // the next turn's overlay from empty, so a previous pane's content can
    // never bleed into this one.
    dispatch({ type: 'reset' })
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
    void api
      .acquire({
        paneKey,
        ptyId: ptyId as string,
        cwd: cwd as string,
        sessionFile: sessionFile as string
      })
      .then((result) => {
        if (cancelled) {
          // The pane unmounted, went invisible, or rebound identity while the
          // acquisition was in flight — never leave a just-acquired child
          // holding the session hostage.
          if (result.ok) {
            void api.release({ paneKey })
          }
          return
        }
        if (!result.ok) {
          setStatus(result.reason)
          return
        }
        acquiredThisEffect = true
        setStatus('acquired')
        unsubscribe = subscribeOmpRpcChatFrames(api, paneKey, dispatch)
      })
    return () => {
      cancelled = true
      unsubscribe?.()
      unsubscribe = null
      if (acquiredThisEffect) {
        void api.release({ paneKey })
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
      window.api?.ompRpcChat?.respondExtensionUi({ paneKey, response })
    },
    [paneKey]
  )

  return { status, isOwned: status === 'acquired', turnState, send, abort, respondExtensionUi }
}
