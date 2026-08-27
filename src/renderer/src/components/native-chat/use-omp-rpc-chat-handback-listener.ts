// Durable "leave Chat view" hand-back listener (Critical B, wave 5).
// use-omp-rpc-chat-session.ts's acquire effect can only ask main to release
// + hand back a pane's PTY; it cannot drive the respawn itself, because the
// real trigger for "leave Chat view" (TerminalPane.tsx's portal render gate
// returning null) unmounts that hook along with NativeChatView. TerminalPane
// itself stays mounted underneath NativeChatView (Terminal.tsx renders one
// TerminalPane per tab, independent of Chat/Terminal view mode), so it is
// where main's `ompRpcChat:handback` push event must land and drive the
// actual `pty.spawn` + layout rebind — see omp-rpc-chat-handback.ts, whose
// existing respawn/rebind logic (including its tab-closed orphan reap) is
// reused verbatim here, just invoked from a surface that cannot be
// unmounted by the very action that triggers it.
import { useEffect } from 'react'
import type { OmpRpcChatHandbackPayload } from '../../../../shared/omp-rpc-chat-ipc-contract'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { respawnPtyForOmpRpcChatHandback } from './omp-rpc-chat-handback'

/** Subscribed once per tab's TerminalPane instance. The push event is not
 *  scoped to a subscriber (unlike `ompRpcChat:subscribe`'s per-pane
 *  channel) — every window's listener fires and filters by `tabId` itself,
 *  since `chatLeafId` may already be null (the user left Chat view) by the
 *  time this arrives and cannot be relied on to identify the target leaf. */
export function useOmpRpcChatHandbackListener(tabId: string): void {
  useEffect(() => {
    const api = window.api?.ompRpcChat
    if (!api) {
      return
    }
    return api.onHandback((payload: OmpRpcChatHandbackPayload) => {
      const parsed = parsePaneKey(payload.paneKey)
      if (!parsed || parsed.tabId !== tabId) {
        return
      }
      void respawnPtyForOmpRpcChatHandback({
        paneKey: payload.paneKey,
        replacedPtyId: payload.replacedPtyId,
        cwd: payload.cwd,
        sessionId: payload.sessionId
      })
    })
  }, [tabId])
}
