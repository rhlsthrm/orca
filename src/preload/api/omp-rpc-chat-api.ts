import type {
  OmpRpcChatAbortArgs,
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
} from '../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcClientEvent } from '../../shared/omp-rpc-protocol'

export type OmpRpcChatApi = {
  /** Resolves a pane's OMP session identity from OMP's own on-disk state
   *  (terminal breadcrumb, then newest-by-mtime cwd bucket) — bypasses the
   *  broken agent-status hook chain. Null means nothing to resume. */
  resolveSessionIdentity: (
    args: OmpRpcChatResolveSessionIdentityArgs
  ) => Promise<OmpRpcChatResolveSessionIdentityResult>
  /** Proof-gated acquisition of RPC ownership for a pane's OMP session.
   *  Fail-closed: `ok:false` means the caller must keep today's PTY behavior. */
  acquire: (args: OmpRpcChatAcquireArgs) => Promise<OmpRpcChatAcquireResult>
  /** Always disposes the RPC child if one is held for this pane. */
  release: (args: OmpRpcChatReleaseArgs) => Promise<OmpRpcChatReleaseResult>
  send: (args: OmpRpcChatSendArgs) => Promise<OmpRpcChatSendResult>
  abort: (args: OmpRpcChatAbortArgs) => Promise<OmpRpcChatSendResult>
  respondExtensionUi: (args: OmpRpcChatRespondExtensionUiArgs) => Promise<boolean>
  /** Start receiving turn-lifecycle frames for an already-acquired pane.
   *  Returns an unsubscribe fn that closes the watcher (nativeChat.subscribe
   *  pattern: ipcMain.on + webContents.send, listener-based unsubscribe here). */
  subscribe: (
    args: OmpRpcChatSubscribeArgs,
    onEvent: (event: OmpRpcClientEvent) => void
  ) => () => void
}
