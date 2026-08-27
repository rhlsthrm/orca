// IPC-level contract between the renderer and the main-process RPC chat
// session registry (milestone 1: streaming turns over RPC). Separate from
// omp-rpc-protocol.ts (the frozen OMP wire contract) and from
// omp-rpc-ipc-contract.ts (the session-less probe): this file describes only
// the session-scoped acquire/release/send/subscribe surface that crosses
// Orca's IPC boundary. Every handler is fail-closed — never throws across IPC.

import type {
  OmpRpcClientEvent,
  OmpRpcExtensionUiResponse,
  OmpRpcImageContent,
  OmpRpcStreamingBehavior
} from './omp-rpc-protocol'

/** Resolves an OMP pane's session identity from OMP's own on-disk state
 *  (terminal breadcrumb, then newest-by-mtime cwd bucket) — bypasses the
 *  broken agent-status hook chain entirely (Decision 2,
 *  docs/omp-rpc-chat-adapter-plan.md). Called before `acquire`; a null
 *  result means "nothing to resume" and the caller must not acquire. */
export type OmpRpcChatResolveSessionIdentityArgs = {
  ptyId: string
  cwd: string
}

export type OmpRpcChatSessionIdentitySource = 'breadcrumb' | 'mtime-fallback'

export type OmpRpcChatResolveSessionIdentityResult = {
  sessionId: string
  source: OmpRpcChatSessionIdentitySource
} | null

export type OmpRpcChatAcquireArgs = {
  paneKey: string
  ptyId: string
  cwd: string
  sessionFile: string
}

/** Fail-closed reasons the renderer degrades to PTY+transcript on (D1) —
 *  every one of them means "chat keeps today's behavior", never a crash. */
export type OmpRpcChatAcquireFailureReason =
  | 'live'
  | 'unverifiable'
  | 'conflict'
  | 'spawn-failed'
  | 'executable-not-found'

export type OmpRpcChatAcquireResult =
  | { ok: true }
  | { ok: false; reason: OmpRpcChatAcquireFailureReason }

export type OmpRpcChatReleaseArgs = { paneKey: string }
export type OmpRpcChatReleaseResult = { released: boolean }

export type OmpRpcChatSendBehavior = 'idle' | OmpRpcStreamingBehavior

export type OmpRpcChatSendArgs = {
  paneKey: string
  message: string
  images?: OmpRpcImageContent[]
  behavior: OmpRpcChatSendBehavior
}

export type OmpRpcChatSendResult =
  | { ok: true; agentInvoked: boolean }
  | { ok: false; reason: string }

export type OmpRpcChatAbortArgs = { paneKey: string }

export type OmpRpcChatRespondExtensionUiArgs = {
  paneKey: string
  response: OmpRpcExtensionUiResponse
}

export type OmpRpcChatSubscribeArgs = { paneKey: string; subscriptionId: string }
export type OmpRpcChatUnsubscribeArgs = { subscriptionId: string }

/** Pushed on `ompRpcChat:event`, filtered by the renderer by `subscriptionId`
 *  (same pattern as `nativeChat:appended`). */
export type OmpRpcChatEventPayload = {
  subscriptionId: string
  event: OmpRpcClientEvent
}
