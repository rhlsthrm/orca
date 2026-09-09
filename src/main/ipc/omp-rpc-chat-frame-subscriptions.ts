// `ompRpcChat:subscribe` / `ompRpcChat:unsubscribe` — the session-scoped frame
// stream and the per-sender bookkeeping that bounds its lifetime.
//
// Split out of omp-rpc-chat.ts (at its line budget). This is the one half of
// the family that is a PUSH channel rather than request/response: it follows
// the `nativeChat:subscribe` pattern (ipcMain.on + webContents.send,
// listener-based unsubscribe in preload) instead of ipcMain.handle, and it is
// the only part of the surface that owns state whose lifetime is a renderer's
// rather than a pane's. Everything it needs from the ownership lifecycle is
// one read-only session lookup, so it cannot acquire, transfer or widen
// ownership.
import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import type {
  OmpRpcChatEventPayload,
  OmpRpcChatSubscribeArgs,
  OmpRpcChatUnsubscribeArgs
} from '../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcClientEvent } from '../../shared/omp-rpc-protocol'

/** The only thing this module does to a pane's session: attach a frame
 *  listener and keep the unsubscribe it hands back. */
export type OmpRpcChatFrameSubscriptionSession = {
  on(listener: (event: OmpRpcClientEvent) => void): () => void
}

/** The only registry lookup this module is allowed to make. Structural, so
 *  `registerOmpRpcChatFrameSubscriptionHandlers(getRegistry)` passes the real
 *  registry unchanged while this module stays unable to acquire, transfer or
 *  widen ownership. */
export type OmpRpcChatFrameSubscriptionRegistryView = {
  get(paneKey: string): OmpRpcChatFrameSubscriptionSession | null
}

// Why: live subscriptions are keyed by (webContents.id, subscriptionId), same
// shape as native-chat.ts's transcript subscriptions, so one renderer can
// watch several panes and a destroyed window tears down all of its watchers.
const subscriptionsBySender = new Map<number, Map<string, () => void>>()
const senderCleanupRegistered = new Set<number>()

function teardownSubscription(senderId: number, subscriptionId: string): void {
  const bySubId = subscriptionsBySender.get(senderId)
  const unsubscribe = bySubId?.get(subscriptionId)
  if (!unsubscribe) {
    return
  }
  unsubscribe()
  bySubId?.delete(subscriptionId)
  if (bySubId && bySubId.size === 0) {
    subscriptionsBySender.delete(senderId)
  }
}

function teardownAllForSender(senderId: number): void {
  const bySubId = subscriptionsBySender.get(senderId)
  if (!bySubId) {
    return
  }
  for (const unsubscribe of bySubId.values()) {
    unsubscribe()
  }
  subscriptionsBySender.delete(senderId)
}

function registerSenderCleanup(sender: WebContents): void {
  if (senderCleanupRegistered.has(sender.id)) {
    return
  }
  senderCleanupRegistered.add(sender.id)
  sender.once('destroyed', () => {
    teardownAllForSender(sender.id)
    senderCleanupRegistered.delete(sender.id)
  })
}

function handleSubscribe(
  getRegistry: () => OmpRpcChatFrameSubscriptionRegistryView,
  event: IpcMainEvent,
  args: OmpRpcChatSubscribeArgs
): void {
  const sender = event.sender
  if (sender.isDestroyed()) {
    return
  }
  teardownSubscription(sender.id, args.subscriptionId)
  const session = getRegistry().get(args.paneKey)
  if (!session) {
    return
  }
  registerSenderCleanup(sender)
  const unsubscribe = session.on((rpcEvent) => {
    if (sender.isDestroyed()) {
      return
    }
    const payload: OmpRpcChatEventPayload = { subscriptionId: args.subscriptionId, event: rpcEvent }
    sender.send('ompRpcChat:event', payload)
  })
  const bySubId = subscriptionsBySender.get(sender.id) ?? new Map<string, () => void>()
  bySubId.set(args.subscriptionId, unsubscribe)
  subscriptionsBySender.set(sender.id, bySubId)
}

export function registerOmpRpcChatFrameSubscriptionHandlers(
  getRegistry: () => OmpRpcChatFrameSubscriptionRegistryView
): void {
  ipcMain.on('ompRpcChat:subscribe', (event, args: OmpRpcChatSubscribeArgs) => {
    handleSubscribe(getRegistry, event, args)
  })
  ipcMain.on('ompRpcChat:unsubscribe', (event, args: OmpRpcChatUnsubscribeArgs) => {
    teardownSubscription(event.sender.id, args.subscriptionId)
  })
}

/** Test-only: drop all live subscriptions between runs. */
export function clearOmpRpcChatFrameSubscriptionsForTests(): void {
  for (const senderId of subscriptionsBySender.keys()) {
    teardownAllForSender(senderId)
  }
  senderCleanupRegistered.clear()
}
