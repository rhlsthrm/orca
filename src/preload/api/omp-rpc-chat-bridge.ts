import { ipcRenderer } from 'electron'
import type {
  OmpRpcChatAbortArgs,
  OmpRpcChatAcquireArgs,
  OmpRpcChatAcquireResult,
  OmpRpcChatBranchArgs,
  OmpRpcChatClaimPendingHandbacksArgs,
  OmpRpcChatClaimPendingHandbacksIpcArgs,
  OmpRpcChatClaimedHandback,
  OmpRpcChatCommandResult,
  OmpRpcChatCustomInstructionsArgs,
  OmpRpcChatEventPayload,
  OmpRpcChatExportHtmlArgs,
  OmpRpcChatFetchHistoryArgs,
  OmpRpcChatFetchHistoryResult,
  OmpRpcChatHandbackPayload,
  OmpRpcChatHasSessionArgs,
  OmpRpcChatHasSessionResult,
  OmpRpcChatListResumableSessionsArgs,
  OmpRpcChatLoginArgs,
  OmpRpcChatNewSessionArgs,
  OmpRpcChatPaneArgs,
  OmpRpcChatReleaseArgs,
  OmpRpcChatReleaseResult,
  OmpRpcChatResolveSessionIdentityArgs,
  OmpRpcChatResolveSessionIdentityResult,
  OmpRpcChatRespondExtensionUiArgs,
  OmpRpcChatResumableSession,
  OmpRpcChatSendArgs,
  OmpRpcChatSendResult,
  OmpRpcChatSetEnabledArgs,
  OmpRpcChatSetInterruptModeArgs,
  OmpRpcChatSetModelArgs,
  OmpRpcChatSetQueueModeArgs,
  OmpRpcChatSetSessionNameArgs,
  OmpRpcChatSetThinkingLevelArgs,
  OmpRpcChatSetTodosArgs,
  OmpRpcChatSettleHandbackArgs,
  OmpRpcChatSubscribeArgs,
  OmpRpcChatSwitchSessionArgs
} from '../../shared/omp-rpc-chat-ipc-contract'
import type {
  OmpRpcBranchMessage,
  OmpRpcBranchResult,
  OmpRpcClientEvent,
  OmpRpcCompactionResult,
  OmpRpcCycledModel,
  OmpRpcCycledThinkingLevel,
  OmpRpcExportedHtml,
  OmpRpcFastModeState,
  OmpRpcHandoffResult,
  OmpRpcHistoryMessage,
  OmpRpcLoginProvider,
  OmpRpcLoginResult,
  OmpRpcModel,
  OmpRpcNewSessionResult,
  OmpRpcSessionState,
  OmpRpcSessionStats,
  OmpRpcSubagentSnapshot,
  OmpRpcTodoPhase
} from '../../shared/omp-rpc-protocol'
import type { PreloadApi } from '../api-types'

/** Identifies THIS document to main's hand-back lease (XLR-R9-001). Minted at
 *  preload scope, so it is reborn on every page load and shared by every
 *  claim the loaded document makes — which is exactly the discrimination main
 *  needs: a reload may take back a lease its predecessor will never settle, but
 *  one live listener claiming on mount and again per nudge may not, or two
 *  `omp --resume` children end up writing one session file. */
const HANDBACK_CLAIMANT_DOCUMENT_ID = crypto.randomUUID()

export const ompRpcChatApi = {
  resolveSessionIdentity: (
    args: OmpRpcChatResolveSessionIdentityArgs
  ): Promise<OmpRpcChatResolveSessionIdentityResult> =>
    ipcRenderer.invoke('ompRpcChat:resolveSessionIdentity', args),
  acquire: (args: OmpRpcChatAcquireArgs): Promise<OmpRpcChatAcquireResult> =>
    ipcRenderer.invoke('ompRpcChat:acquire', args),
  hasSession: (args: OmpRpcChatHasSessionArgs): Promise<OmpRpcChatHasSessionResult> =>
    ipcRenderer.invoke('ompRpcChat:hasSession', args),
  release: (args: OmpRpcChatReleaseArgs): Promise<OmpRpcChatReleaseResult> =>
    ipcRenderer.invoke('ompRpcChat:release', args),
  fetchHistory: (args: OmpRpcChatFetchHistoryArgs): Promise<OmpRpcChatFetchHistoryResult> =>
    ipcRenderer.invoke('ompRpcChat:fetchHistory', args),
  send: (args: OmpRpcChatSendArgs): Promise<OmpRpcChatSendResult> =>
    ipcRenderer.invoke('ompRpcChat:send', args),
  abort: (args: OmpRpcChatAbortArgs): Promise<OmpRpcChatSendResult> =>
    ipcRenderer.invoke('ompRpcChat:abort', args),
  respondExtensionUi: (args: OmpRpcChatRespondExtensionUiArgs): Promise<boolean> =>
    ipcRenderer.invoke('ompRpcChat:respondExtensionUi', args),
  subscribe: (
    args: OmpRpcChatSubscribeArgs,
    onEvent: (event: OmpRpcClientEvent) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: OmpRpcChatEventPayload) => {
      if (payload.subscriptionId === args.subscriptionId) {
        onEvent(payload.event)
      }
    }
    ipcRenderer.on('ompRpcChat:event', listener)
    ipcRenderer.send('ompRpcChat:subscribe', args)
    return () => {
      ipcRenderer.removeListener('ompRpcChat:event', listener)
      ipcRenderer.send('ompRpcChat:unsubscribe', { subscriptionId: args.subscriptionId })
    }
  },
  onHandback: (onEvent: (payload: OmpRpcChatHandbackPayload) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: OmpRpcChatHandbackPayload
    ): void => onEvent(payload)
    ipcRenderer.on('ompRpcChat:handback', listener)
    return () => ipcRenderer.removeListener('ompRpcChat:handback', listener)
  },
  claimPendingHandbacks: (
    args: OmpRpcChatClaimPendingHandbacksArgs
  ): Promise<OmpRpcChatClaimedHandback[]> => {
    const ipcArgs: OmpRpcChatClaimPendingHandbacksIpcArgs = {
      ...args,
      claimantDocumentId: HANDBACK_CLAIMANT_DOCUMENT_ID
    }
    return ipcRenderer.invoke('ompRpcChat:claimPendingHandbacks', ipcArgs)
  },
  settleHandback: (args: OmpRpcChatSettleHandbackArgs): Promise<void> =>
    ipcRenderer.invoke('ompRpcChat:settleHandback', args),
  // Interactive-command surface. Every method is one `invoke` onto the
  // matching `ompRpcChat:*` channel; the arg and result types come from the
  // IPC contract, so a channel renamed on one side stops compiling on the
  // other. Main fails these closed into `OmpRpcChatCommandResult`, so none of
  // them rejects on an unowned pane or a refused wire command.
  getState: (args: OmpRpcChatPaneArgs): Promise<OmpRpcChatCommandResult<OmpRpcSessionState>> =>
    ipcRenderer.invoke('ompRpcChat:getState', args),
  getAvailableModels: (args: OmpRpcChatPaneArgs): Promise<OmpRpcChatCommandResult<OmpRpcModel[]>> =>
    ipcRenderer.invoke('ompRpcChat:getAvailableModels', args),
  setModel: (args: OmpRpcChatSetModelArgs): Promise<OmpRpcChatCommandResult<OmpRpcModel>> =>
    ipcRenderer.invoke('ompRpcChat:setModel', args),
  cycleModel: (args: OmpRpcChatPaneArgs): Promise<OmpRpcChatCommandResult<OmpRpcCycledModel>> =>
    ipcRenderer.invoke('ompRpcChat:cycleModel', args),
  setThinkingLevel: (
    args: OmpRpcChatSetThinkingLevelArgs
  ): Promise<OmpRpcChatCommandResult<void>> =>
    ipcRenderer.invoke('ompRpcChat:setThinkingLevel', args),
  cycleThinkingLevel: (
    args: OmpRpcChatPaneArgs
  ): Promise<OmpRpcChatCommandResult<OmpRpcCycledThinkingLevel>> =>
    ipcRenderer.invoke('ompRpcChat:cycleThinkingLevel', args),
  setSteeringMode: (args: OmpRpcChatSetQueueModeArgs): Promise<OmpRpcChatCommandResult<void>> =>
    ipcRenderer.invoke('ompRpcChat:setSteeringMode', args),
  setFollowUpMode: (args: OmpRpcChatSetQueueModeArgs): Promise<OmpRpcChatCommandResult<void>> =>
    ipcRenderer.invoke('ompRpcChat:setFollowUpMode', args),
  setInterruptMode: (
    args: OmpRpcChatSetInterruptModeArgs
  ): Promise<OmpRpcChatCommandResult<void>> =>
    ipcRenderer.invoke('ompRpcChat:setInterruptMode', args),
  setFastMode: (
    args: OmpRpcChatSetEnabledArgs
  ): Promise<OmpRpcChatCommandResult<OmpRpcFastModeState>> =>
    ipcRenderer.invoke('ompRpcChat:setFastMode', args),
  compact: (
    args: OmpRpcChatCustomInstructionsArgs
  ): Promise<OmpRpcChatCommandResult<OmpRpcCompactionResult>> =>
    ipcRenderer.invoke('ompRpcChat:compact', args),
  setAutoCompaction: (args: OmpRpcChatSetEnabledArgs): Promise<OmpRpcChatCommandResult<void>> =>
    ipcRenderer.invoke('ompRpcChat:setAutoCompaction', args),
  setAutoRetry: (args: OmpRpcChatSetEnabledArgs): Promise<OmpRpcChatCommandResult<void>> =>
    ipcRenderer.invoke('ompRpcChat:setAutoRetry', args),
  abortRetry: (args: OmpRpcChatPaneArgs): Promise<OmpRpcChatCommandResult<void>> =>
    ipcRenderer.invoke('ompRpcChat:abortRetry', args),
  getBranchMessages: (
    args: OmpRpcChatPaneArgs
  ): Promise<OmpRpcChatCommandResult<OmpRpcBranchMessage[]>> =>
    ipcRenderer.invoke('ompRpcChat:getBranchMessages', args),
  branch: (args: OmpRpcChatBranchArgs): Promise<OmpRpcChatCommandResult<OmpRpcBranchResult>> =>
    ipcRenderer.invoke('ompRpcChat:branch', args),
  setSessionName: (args: OmpRpcChatSetSessionNameArgs): Promise<OmpRpcChatCommandResult<void>> =>
    ipcRenderer.invoke('ompRpcChat:setSessionName', args),
  handoff: (
    args: OmpRpcChatCustomInstructionsArgs
  ): Promise<OmpRpcChatCommandResult<OmpRpcHandoffResult>> =>
    ipcRenderer.invoke('ompRpcChat:handoff', args),
  newSession: (
    args: OmpRpcChatNewSessionArgs
  ): Promise<OmpRpcChatCommandResult<OmpRpcNewSessionResult>> =>
    ipcRenderer.invoke('ompRpcChat:newSession', args),
  getSessionStats: (
    args: OmpRpcChatPaneArgs
  ): Promise<OmpRpcChatCommandResult<OmpRpcSessionStats>> =>
    ipcRenderer.invoke('ompRpcChat:getSessionStats', args),
  exportHtml: (
    args: OmpRpcChatExportHtmlArgs
  ): Promise<OmpRpcChatCommandResult<OmpRpcExportedHtml>> =>
    ipcRenderer.invoke('ompRpcChat:exportHtml', args),
  getLoginProviders: (
    args: OmpRpcChatPaneArgs
  ): Promise<OmpRpcChatCommandResult<OmpRpcLoginProvider[]>> =>
    ipcRenderer.invoke('ompRpcChat:getLoginProviders', args),
  login: (args: OmpRpcChatLoginArgs): Promise<OmpRpcChatCommandResult<OmpRpcLoginResult>> =>
    ipcRenderer.invoke('ompRpcChat:login', args),
  getMessages: (
    args: OmpRpcChatPaneArgs
  ): Promise<OmpRpcChatCommandResult<OmpRpcHistoryMessage[]>> =>
    ipcRenderer.invoke('ompRpcChat:getMessages', args),
  getSubagents: (
    args: OmpRpcChatPaneArgs
  ): Promise<OmpRpcChatCommandResult<OmpRpcSubagentSnapshot[]>> =>
    ipcRenderer.invoke('ompRpcChat:getSubagents', args),
  setTodos: (args: OmpRpcChatSetTodosArgs): Promise<OmpRpcChatCommandResult<OmpRpcTodoPhase[]>> =>
    ipcRenderer.invoke('ompRpcChat:setTodos', args),
  // Resume surface. `listResumableSessions` is answered from main's registry
  // and the filesystem, never from the pane's RPC child, so it works while the
  // child is streaming; `switchSession` is the session-moving half.
  listResumableSessions: (
    args: OmpRpcChatListResumableSessionsArgs
  ): Promise<OmpRpcChatCommandResult<OmpRpcChatResumableSession[]>> =>
    ipcRenderer.invoke('ompRpcChat:listResumableSessions', args),
  switchSession: (args: OmpRpcChatSwitchSessionArgs): Promise<OmpRpcChatCommandResult<void>> =>
    ipcRenderer.invoke('ompRpcChat:switchSession', args)
} satisfies PreloadApi['ompRpcChat']
