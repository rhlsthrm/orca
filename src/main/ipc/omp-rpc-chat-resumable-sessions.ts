// `ompRpcChat:listResumableSessions` — the `/resume` picker's rows.
//
// Split out of omp-rpc-chat.ts (at its line budget) and deliberately NOT a
// `registerInteractiveCommand`: enumeration never touches the RPC child. It
// reads OMP's own on-disk session layout, so it answers while the child is
// streaming or compacting, and a wedged child cannot make `/resume`
// unavailable — which is precisely when a user reaches for it.
//
// The pane key is still the whole authorization: the registry only ever holds
// panes that passed the locality-gated, proof-gated acquire, so a key it does
// not hold is refused before any disk is read. That refusal is also what makes
// `isCurrent` trustworthy — the pane's own session id is always known on the
// success path, so no renderer has to guess which row is live.
import { ipcMain } from 'electron'
import {
  OMP_RPC_CHAT_NO_OWNED_SESSION_REASON,
  type OmpRpcChatCommandResult,
  type OmpRpcChatListResumableSessionsArgs,
  type OmpRpcChatResumableSession
} from '../../shared/omp-rpc-chat-ipc-contract'
import { listOmpResumableSessions } from '../native-chat/omp-resumable-sessions'

/** Only the two read-only registry lookups this handler is allowed to make.
 *  Structural, so `registerOmpRpcChatResumableSessionHandlers(getRegistry)`
 *  passes the real registry unchanged while this module stays unable to
 *  acquire, transfer or widen ownership. */
export type OmpRpcChatResumableSessionRegistryView = {
  /** The bare session id of the session this pane owns, or null when the
   *  registry does not hold the pane at all — the ownership gate and the
   *  `isCurrent` input in one lookup. */
  getSessionFile(paneKey: string): string | null
  /** Session file paths held by OTHER panes; switching onto one would put two
   *  writers on the same file. Never withholds the asking pane's own claim. */
  claimedSessionFilePathsExcluding(paneKey: string): ReadonlySet<string>
}

export function registerOmpRpcChatResumableSessionHandlers(
  getRegistry: () => OmpRpcChatResumableSessionRegistryView
): void {
  ipcMain.handle(
    'ompRpcChat:listResumableSessions',
    async (
      _event,
      args: OmpRpcChatListResumableSessionsArgs
    ): Promise<OmpRpcChatCommandResult<OmpRpcChatResumableSession[]>> => {
      const paneKey = args?.paneKey?.trim()
      const cwd = args?.cwd?.trim()
      if (!paneKey || !cwd) {
        return { ok: false, reason: 'a pane key and cwd are required' }
      }
      const registry = getRegistry()
      const currentSessionId = registry.getSessionFile(paneKey)
      if (!currentSessionId) {
        return { ok: false, reason: OMP_RPC_CHAT_NO_OWNED_SESSION_REASON }
      }
      try {
        const sessions = await listOmpResumableSessions(
          { cwd, currentSessionId },
          { claimedSessionFilePaths: registry.claimedSessionFilePathsExcluding(paneKey) }
        )
        return { ok: true, data: sessions }
      } catch (error) {
        // Fail closed on the same terms as every other channel here (D1): a
        // filesystem failure is an honest `ok:false` the card renders as an
        // error, never a throw across IPC and never an empty picker that
        // implies this directory has nothing to resume.
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
