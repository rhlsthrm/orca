// IPC surface for per-pane RPC chat sessions (milestone 1: streaming turns
// over RPC). Acquire/release/send/abort/respond are request/response; the
// frame stream is a session-scoped push channel, following the
// `nativeChat:subscribe`-style pattern (ipcMain.on + webContents.send,
// listener-based unsubscribe in preload) rather than ipcMain.handle.
// Every handler is fail-closed — degrades the caller to PTY behavior (D1)
// instead of throwing across the IPC boundary.

import { app, ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import type {
  OmpRpcChatAbortArgs,
  OmpRpcChatAcquireArgs,
  OmpRpcChatAcquireResult,
  OmpRpcChatEventPayload,
  OmpRpcChatReleaseArgs,
  OmpRpcChatReleaseResult,
  OmpRpcChatRespondExtensionUiArgs,
  OmpRpcChatSendArgs,
  OmpRpcChatSendResult,
  OmpRpcChatSubscribeArgs,
  OmpRpcChatUnsubscribeArgs
} from '../../shared/omp-rpc-chat-ipc-contract'
import { OmpRpcChatSessionRegistry } from '../omp-rpc/omp-rpc-chat-session-registry'
import { ptyOwnership } from './pty/provider/ownership-state'
import { tryGetProviderForPty } from './pty/provider/registry'
import { parseAppSshPtyId } from '../providers/ssh-pty-id'
import { resolveOmpExecutablePath } from './omp-rpc'

let registry: OmpRpcChatSessionRegistry | null = null

function getRegistry(): OmpRpcChatSessionRegistry {
  registry ??= new OmpRpcChatSessionRegistry()
  return registry
}

/** Read-only, local-only PTY liveness query — never kills anything. Explicitly
 *  refuses an SSH-owned id (returns null/unverifiable) rather than assuming
 *  local, per this milestone's local-runtime-only scope (AGENTS.md: gate
 *  cross-platform/remote behavior explicitly, never assume local). */
function isLocalPtyAlive(ptyId: string): boolean | null {
  const connectionId = ptyOwnership.get(ptyId)
  const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
  if (connectionId || parsedSshId) {
    return null
  }
  const provider = tryGetProviderForPty(ptyId)
  if (!provider?.hasPty) {
    return null
  }
  try {
    return provider.hasPty(ptyId)
  } catch {
    return null
  }
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

function handleSubscribe(event: IpcMainEvent, args: OmpRpcChatSubscribeArgs): void {
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

export function registerOmpRpcChatHandlers(): void {
  ipcMain.handle(
    'ompRpcChat:acquire',
    async (_event, args: OmpRpcChatAcquireArgs): Promise<OmpRpcChatAcquireResult> => {
      const paneKey = args?.paneKey?.trim()
      const ptyId = args?.ptyId?.trim()
      const cwd = args?.cwd?.trim()
      const sessionFile = args?.sessionFile?.trim()
      if (!paneKey || !ptyId || !cwd || !sessionFile) {
        return { ok: false, reason: 'spawn-failed' }
      }
      const executablePath = await resolveOmpExecutablePath()
      if (!executablePath) {
        return { ok: false, reason: 'executable-not-found' }
      }
      const result = await getRegistry().acquire({
        paneKey,
        ptyId,
        cwd,
        executablePath,
        sessionFile,
        isPtyAlive: isLocalPtyAlive
      })
      if (result.status === 'acquired') {
        return { ok: true }
      }
      if (result.status === 'live' || result.status === 'unverifiable') {
        return { ok: false, reason: result.status }
      }
      return { ok: false, reason: result.status === 'conflict' ? 'conflict' : 'spawn-failed' }
    }
  )

  ipcMain.handle(
    'ompRpcChat:release',
    async (_event, args: OmpRpcChatReleaseArgs): Promise<OmpRpcChatReleaseResult> => {
      const paneKey = args?.paneKey?.trim()
      if (!paneKey) {
        return { released: false }
      }
      const result = await getRegistry().release(paneKey)
      return { released: result.released }
    }
  )

  ipcMain.handle(
    'ompRpcChat:send',
    async (_event, args: OmpRpcChatSendArgs): Promise<OmpRpcChatSendResult> => {
      const session = getRegistry().get(args?.paneKey ?? '')
      if (!session) {
        return { ok: false, reason: 'no RPC-owned session for this pane' }
      }
      return session.send({ message: args.message, images: args.images, behavior: args.behavior })
    }
  )

  ipcMain.handle(
    'ompRpcChat:abort',
    async (_event, args: OmpRpcChatAbortArgs): Promise<OmpRpcChatSendResult> => {
      const session = getRegistry().get(args?.paneKey ?? '')
      if (!session) {
        return { ok: false, reason: 'no RPC-owned session for this pane' }
      }
      return session.abort()
    }
  )

  ipcMain.handle(
    'ompRpcChat:respondExtensionUi',
    async (_event, args: OmpRpcChatRespondExtensionUiArgs): Promise<boolean> => {
      const session = getRegistry().get(args?.paneKey ?? '')
      if (!session) {
        return false
      }
      return session.respondExtensionUi(args.response)
    }
  )

  ipcMain.on('ompRpcChat:subscribe', (event, args: OmpRpcChatSubscribeArgs) => {
    handleSubscribe(event, args)
  })
  ipcMain.on('ompRpcChat:unsubscribe', (event, args: OmpRpcChatUnsubscribeArgs) => {
    teardownSubscription(event.sender.id, args.subscriptionId)
  })

  app.once('will-quit', () => registry?.disposeAll())
}

/** Test-only: drop all live subscriptions and the registry between runs. */
export function clearOmpRpcChatHandlersForTests(): void {
  for (const senderId of subscriptionsBySender.keys()) {
    teardownAllForSender(senderId)
  }
  senderCleanupRegistered.clear()
  registry?.disposeAll()
  registry = null
}
