// Renderer-owned, paneKey-scoped publication of OMP RPC chat ownership
// (Decision 1). Written exclusively by the acquire/hold hook mounted at
// TerminalPane — use-omp-rpc-chat-pane-ownership.ts — which anchors
// ownership to the pane's life, not a Chat-view mount. NativeChatView reads
// this slice as a pure remountable subscriber, mirroring the existing
// agentStatusByPaneKey pattern: the component that renders the state is not
// the component that owns its lifecycle.
//
// send/abort/respondExtensionUi are plain paneKey-scoped actions here, not
// callbacks returned by a hook instance — a remounted NativeChatView has no
// live reference to the TerminalPane-anchored hook's closure, and none is
// needed: every call re-reads the current status from this slice and goes
// straight to the IPC surface (window.api.ompRpcChat), exactly as the former
// hook-returned callbacks did.

import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  OmpRpcChatAcquireFailureReason,
  OmpRpcChatSendBehavior,
  OmpRpcChatSendResult
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import type {
  OmpRpcExtensionUiResponse,
  OmpRpcImageContent
} from '../../../../shared/omp-rpc-protocol'
import {
  createInitialOmpRpcTurnState,
  ompRpcTurnReducer,
  type OmpRpcTurnAction,
  type OmpRpcTurnState
} from '../../components/native-chat/omp-rpc-turn-reducer'

export type OmpRpcChatPaneOwnershipStatus =
  | 'idle'
  | 'pending'
  | 'acquired'
  // Why (F3): the RPC child exited or protocol-faulted mid-turn — a terminal
  // failure distinct from 'acquired' so `isOwned` flips false and sends fall
  // back to PTY (D1), instead of staying stuck claiming a dead session.
  | 'faulted'
  | OmpRpcChatAcquireFailureReason

export type OmpRpcChatPaneOwnershipEntry = {
  status: OmpRpcChatPaneOwnershipStatus
  turnState: OmpRpcTurnState
}

const NOT_OWNED_RESULT: OmpRpcChatSendResult = {
  ok: false,
  reason: 'no RPC-owned session for this pane'
}

export type OmpRpcChatPaneOwnershipSlice = {
  ompRpcChatOwnershipByPaneKey: Record<string, OmpRpcChatPaneOwnershipEntry>
  setOmpRpcChatPaneStatus: (paneKey: string, status: OmpRpcChatPaneOwnershipStatus) => void
  /** Applies one turn-lifecycle action to the paneKey's turn state, creating
   *  an idle entry first if none exists yet (a frame can arrive the same
   *  tick ownership is first published). */
  dispatchOmpRpcChatTurnAction: (paneKey: string, action: OmpRpcTurnAction) => void
  /** Drops the pane's ownership row entirely. Called by the owning hook's
   *  effect cleanup on every run's end — pane/tab close, identity rebind, or
   *  app quit — never a bare Terminal<->Chat toggle. */
  clearOmpRpcChatPaneOwnership: (paneKey: string) => void
  sendOmpRpcChatPane: (
    paneKey: string,
    args: { message: string; images?: OmpRpcImageContent[]; behavior: OmpRpcChatSendBehavior }
  ) => Promise<OmpRpcChatSendResult>
  abortOmpRpcChatPane: (paneKey: string) => Promise<OmpRpcChatSendResult>
  respondOmpRpcChatExtensionUi: (paneKey: string, response: OmpRpcExtensionUiResponse) => void
}

export const createOmpRpcChatPaneOwnershipSlice: StateCreator<
  AppState,
  [],
  [],
  OmpRpcChatPaneOwnershipSlice
> = (set, get) => ({
  ompRpcChatOwnershipByPaneKey: {},
  setOmpRpcChatPaneStatus: (paneKey, status) => {
    set((s) => {
      const current = s.ompRpcChatOwnershipByPaneKey[paneKey]
      if (current?.status === status) {
        return s
      }
      return {
        ompRpcChatOwnershipByPaneKey: {
          ...s.ompRpcChatOwnershipByPaneKey,
          [paneKey]: { status, turnState: current?.turnState ?? createInitialOmpRpcTurnState() }
        }
      }
    })
  },
  dispatchOmpRpcChatTurnAction: (paneKey, action) => {
    set((s) => {
      const current = s.ompRpcChatOwnershipByPaneKey[paneKey]
      const turnState = ompRpcTurnReducer(
        current?.turnState ?? createInitialOmpRpcTurnState(),
        action
      )
      return {
        ompRpcChatOwnershipByPaneKey: {
          ...s.ompRpcChatOwnershipByPaneKey,
          [paneKey]: { status: current?.status ?? 'idle', turnState }
        }
      }
    })
  },
  clearOmpRpcChatPaneOwnership: (paneKey) => {
    set((s) => {
      if (!(paneKey in s.ompRpcChatOwnershipByPaneKey)) {
        return s
      }
      const next = { ...s.ompRpcChatOwnershipByPaneKey }
      delete next[paneKey]
      return { ompRpcChatOwnershipByPaneKey: next }
    })
  },
  sendOmpRpcChatPane: (paneKey, args) => {
    const api = window.api?.ompRpcChat
    if (get().ompRpcChatOwnershipByPaneKey[paneKey]?.status !== 'acquired' || !api) {
      return Promise.resolve(NOT_OWNED_RESULT)
    }
    return api.send({ paneKey, ...args })
  },
  abortOmpRpcChatPane: (paneKey) => {
    const api = window.api?.ompRpcChat
    if (get().ompRpcChatOwnershipByPaneKey[paneKey]?.status !== 'acquired' || !api) {
      return Promise.resolve(NOT_OWNED_RESULT)
    }
    return api.abort({ paneKey })
  },
  respondOmpRpcChatExtensionUi: (paneKey, response) => {
    // Dispatch unconditionally: the reducer's dismiss is a local UI concern
    // independent of whether the IPC round trip below can still land.
    get().dispatchOmpRpcChatTurnAction(paneKey, {
      type: 'extension-ui-answered',
      requestId: response.id
    })
    // Why (F7): fire-and-forget, but a rejected IPC round trip must not
    // become an unhandled promise rejection.
    void window.api?.ompRpcChat?.respondExtensionUi({ paneKey, response })?.catch(() => {})
  }
})
