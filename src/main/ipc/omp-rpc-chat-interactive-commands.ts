// The `ompRpcChat:*` interactive-command surface — the model / thinking /
// queue-mode / compaction / session / auth verbs a native chat card drives,
// one channel per OMP verb.
//
// Split out of omp-rpc-chat.ts (at its line budget), which keeps the ownership
// lifecycle (acquire/release/send/abort/subscribe) and calls the single
// registrar below exactly once, from the same place it calls the resume
// enumerator's — the channel manifest a renderer relies on is the registration
// order of all three, so this family stays in the position it was registered in
// when it lived there.
//
// Fail-closed on the same terms as every other channel in the family (D1):
// every handler here resolves an `OmpRpcChatCommandResult` and never rejects
// across the IPC boundary.
import { ipcMain } from 'electron'
import {
  OMP_RPC_CHAT_NO_OWNED_SESSION_REASON,
  type OmpRpcChatBranchArgs,
  type OmpRpcChatCommandResult,
  type OmpRpcChatCustomInstructionsArgs,
  type OmpRpcChatExportHtmlArgs,
  type OmpRpcChatLoginArgs,
  type OmpRpcChatNewSessionArgs,
  type OmpRpcChatPaneArgs,
  type OmpRpcChatSetEnabledArgs,
  type OmpRpcChatSetInterruptModeArgs,
  type OmpRpcChatSetModelArgs,
  type OmpRpcChatSetQueueModeArgs,
  type OmpRpcChatSetSessionNameArgs,
  type OmpRpcChatSetThinkingLevelArgs,
  type OmpRpcChatSetTodosArgs,
  type OmpRpcChatSwitchSessionArgs
} from '../../shared/omp-rpc-chat-ipc-contract'
import type {
  OmpRpcBranchResult,
  OmpRpcCompactionResult,
  OmpRpcExportedHtml,
  OmpRpcFastModeState,
  OmpRpcHandoffResult,
  OmpRpcLoginResult,
  OmpRpcModel,
  OmpRpcNewSessionResult,
  OmpRpcTodoPhase,
  OmpSessionOwningRpcClient
} from '../../shared/omp-rpc-protocol'

/** The one round trip this family is allowed to make on the session a pane
 *  owns. `movesSession` is the session's own post-command identity read-back,
 *  not something this module implements. */
export type OmpRpcChatInteractiveCommandSession = {
  runCommand<T>(args: {
    movesSession?: boolean
    run: (client: OmpSessionOwningRpcClient) => Promise<T>
  }): Promise<OmpRpcChatCommandResult<T>>
}

/** The only registry lookup this module is allowed to make. Structural, so
 *  `registerOmpRpcChatInteractiveCommandHandlers(getRegistry)` passes the real
 *  registry unchanged while nothing in this family can acquire, transfer or
 *  widen ownership. */
export type OmpRpcChatInteractiveCommandRegistryView = {
  /** The session this pane owns, or null when the registry does not hold the
   *  pane at all — the ownership gate every channel here shares. */
  get(paneKey: string): OmpRpcChatInteractiveCommandSession | null
}

/** Binds the registry lookup once, so every row of the table below is just its
 *  channel and its verb.
 *
 *  One interactive-command channel. The pane key is the whole authorization:
 *  the registry only ever holds panes that passed the locality-gated,
 *  proof-gated acquire, so a key it does not know is refused here and nothing
 *  in this family can acquire, transfer or widen ownership.
 *
 *  `movesSession` is forwarded to the session so the verbs that change the
 *  child's session file (`branch`, `new_session`, `handoff`) go through the
 *  same post-command identity read-back the slash-command send route uses;
 *  upstream announces that move on no frame, and without the read-back main
 *  keeps claiming a session nobody writes. */
function interactiveCommandRegistrar(getRegistry: () => OmpRpcChatInteractiveCommandRegistryView) {
  return function registerInteractiveCommand<Args extends OmpRpcChatPaneArgs, T>(
    channel: string,
    command: {
      movesSession?: boolean
      run: (client: OmpSessionOwningRpcClient, args: Args) => Promise<T>
    }
  ): void {
    ipcMain.handle(channel, async (_event, args: Args): Promise<OmpRpcChatCommandResult<T>> => {
      const session = getRegistry().get(args?.paneKey ?? '')
      if (!session) {
        return { ok: false, reason: OMP_RPC_CHAT_NO_OWNED_SESSION_REASON }
      }
      return session.runCommand({
        ...(command.movesSession === true ? { movesSession: true } : {}),
        run: (client) => command.run(client, args)
      })
    })
  }
}

/** The interactive-command surface a native chat card drives. Channel names
 *  follow the existing `ompRpcChat:*` convention; each maps to exactly one OMP
 *  verb, with the wire shape and response validation owned by the client. */
export function registerOmpRpcChatInteractiveCommandHandlers(
  getRegistry: () => OmpRpcChatInteractiveCommandRegistryView
): void {
  const registerInteractiveCommand = interactiveCommandRegistrar(getRegistry)
  registerInteractiveCommand('ompRpcChat:getState', { run: (client) => client.getState() })
  registerInteractiveCommand('ompRpcChat:getAvailableModels', {
    run: (client) => client.getAvailableModels()
  })
  registerInteractiveCommand<OmpRpcChatSetModelArgs, OmpRpcModel>('ompRpcChat:setModel', {
    run: (client, args) => client.setModel({ provider: args.provider, modelId: args.modelId })
  })
  registerInteractiveCommand('ompRpcChat:cycleModel', { run: (client) => client.cycleModel() })
  registerInteractiveCommand<OmpRpcChatSetThinkingLevelArgs, void>('ompRpcChat:setThinkingLevel', {
    run: (client, args) => client.setThinkingLevel(args.level)
  })
  registerInteractiveCommand('ompRpcChat:cycleThinkingLevel', {
    run: (client) => client.cycleThinkingLevel()
  })
  registerInteractiveCommand<OmpRpcChatSetQueueModeArgs, void>('ompRpcChat:setSteeringMode', {
    run: (client, args) => client.setSteeringMode(args.mode)
  })
  registerInteractiveCommand<OmpRpcChatSetQueueModeArgs, void>('ompRpcChat:setFollowUpMode', {
    run: (client, args) => client.setFollowUpMode(args.mode)
  })
  registerInteractiveCommand<OmpRpcChatSetInterruptModeArgs, void>('ompRpcChat:setInterruptMode', {
    run: (client, args) => client.setInterruptMode(args.mode)
  })
  registerInteractiveCommand<OmpRpcChatSetEnabledArgs, OmpRpcFastModeState>(
    'ompRpcChat:setFastMode',
    { run: (client, args) => client.setFastMode(args.enabled) }
  )
  registerInteractiveCommand<OmpRpcChatCustomInstructionsArgs, OmpRpcCompactionResult>(
    'ompRpcChat:compact',
    {
      run: (client, args) =>
        client.compact(
          args.customInstructions === undefined
            ? {}
            : { customInstructions: args.customInstructions }
        )
    }
  )
  registerInteractiveCommand<OmpRpcChatSetEnabledArgs, void>('ompRpcChat:setAutoCompaction', {
    run: (client, args) => client.setAutoCompaction(args.enabled)
  })
  registerInteractiveCommand<OmpRpcChatSetEnabledArgs, void>('ompRpcChat:setAutoRetry', {
    run: (client, args) => client.setAutoRetry(args.enabled)
  })
  registerInteractiveCommand('ompRpcChat:abortRetry', { run: (client) => client.abortRetry() })
  // The FOUR session-moving verbs. `movesSession` is not optional decoration
  // here: without it the pane's claim and its cross-pane session-file exclusion
  // keep pointing at the session the child just left.
  //
  // `switchSession` is the `/resume` route and deliberately NOT the acquire
  // path: re-acquiring releases the pane's existing registration first, and an
  // empty `ptyId` then proves no PTY exit, so the pane would lose RPC ownership
  // and get no terminal back. This moves the child the pane ALREADY owns, so
  // registry semantics are unchanged. The client half refuses a non-absolute
  // `sessionPath` before any frame goes out (a bare id no-ops upstream, F12),
  // which arrives here as an ordinary `ok:false`.
  registerInteractiveCommand<OmpRpcChatSwitchSessionArgs, void>('ompRpcChat:switchSession', {
    movesSession: true,
    run: (client, args) => client.switchSession(args.sessionPath)
  })
  registerInteractiveCommand<OmpRpcChatBranchArgs, OmpRpcBranchResult>('ompRpcChat:branch', {
    movesSession: true,
    run: (client, args) => client.branch(args.entryId)
  })
  registerInteractiveCommand('ompRpcChat:getBranchMessages', {
    run: (client) => client.getBranchMessages()
  })
  registerInteractiveCommand<OmpRpcChatSetSessionNameArgs, void>('ompRpcChat:setSessionName', {
    run: (client, args) => client.setSessionName(args.name)
  })
  registerInteractiveCommand<OmpRpcChatCustomInstructionsArgs, OmpRpcHandoffResult>(
    'ompRpcChat:handoff',
    {
      movesSession: true,
      run: (client, args) =>
        client.handoff(
          args.customInstructions === undefined
            ? {}
            : { customInstructions: args.customInstructions }
        )
    }
  )
  registerInteractiveCommand<OmpRpcChatNewSessionArgs, OmpRpcNewSessionResult>(
    'ompRpcChat:newSession',
    {
      movesSession: true,
      run: (client, args) =>
        client.newSession(
          args.parentSession === undefined ? {} : { parentSession: args.parentSession }
        )
    }
  )
  registerInteractiveCommand('ompRpcChat:getSessionStats', {
    run: (client) => client.getSessionStats()
  })
  registerInteractiveCommand<OmpRpcChatExportHtmlArgs, OmpRpcExportedHtml>(
    'ompRpcChat:exportHtml',
    {
      run: (client, args) =>
        client.exportHtml(args.outputPath === undefined ? {} : { outputPath: args.outputPath })
    }
  )
  registerInteractiveCommand('ompRpcChat:getLoginProviders', {
    run: (client) => client.getLoginProviders()
  })
  registerInteractiveCommand<OmpRpcChatLoginArgs, OmpRpcLoginResult>('ompRpcChat:login', {
    run: (client, args) => client.login(args.providerId)
  })
  registerInteractiveCommand('ompRpcChat:getMessages', { run: (client) => client.getMessages() })
  registerInteractiveCommand('ompRpcChat:getSubagents', { run: (client) => client.getSubagents() })
  registerInteractiveCommand<OmpRpcChatSetTodosArgs, OmpRpcTodoPhase[]>('ompRpcChat:setTodos', {
    run: (client, args) => client.setTodos(args.phases)
  })
}
