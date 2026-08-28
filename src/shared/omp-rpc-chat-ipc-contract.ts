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
 *  result means "nothing to resume" and the caller must not acquire.
 *  `ptyId` is an optional accuracy input (wave 9, Defect 1): non-null
 *  unlocks the breadcrumb path, but its absence degrades to the mtime
 *  fallback — never to a rejected/ineligible call. `paneKey` scopes the
 *  mtime fallback's already-claimed exclusion set to claims held by other
 *  panes (Defect 2): the asking pane must never be denied its own claim. */
export type OmpRpcChatResolveSessionIdentityArgs = {
  paneKey: string
  ptyId: string | null
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

/** Present when the caller (the acquire effect's cleanup, on unmount) wants
 *  a PTY respawned into the exact same pane once release actually settles
 *  and exits — never on a fail-closed release that keeps the claim. Only
 *  echoed back via the `ompRpcChat:handback` push event, never itself
 *  driving the respawn on the main side (Critical B: main owns the
 *  settle-wait and release ordering; the renderer's always-mounted
 *  TerminalPane drives the actual `pty.spawn`, not this hook). */
export type OmpRpcChatHandbackRespawnContext = {
  replacedPtyId: string
  cwd: string
  sessionId: string
}

export type OmpRpcChatReleaseArgs = { paneKey: string; respawn?: OmpRpcChatHandbackRespawnContext }
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

/** Pushed on `ompRpcChat:handback` once a `release({ respawn })` call
 *  genuinely settles+exits (never on a fail-closed release) — a durable,
 *  always-mounted listener (use-omp-rpc-chat-handback-listener.ts, wired
 *  into TerminalPane) performs the actual PTY respawn, since the hook that
 *  requested it may already be unmounted by the time this arrives. */
export type OmpRpcChatHandbackPayload = {
  paneKey: string
} & OmpRpcChatHandbackRespawnContext
