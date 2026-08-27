// A single RPC-owned OMP chat session for one pane: forwards raw turn-lifecycle
// frames to registered listeners and exposes a fail-closed send surface
// (prompt/steer/follow_up/abort/respondExtensionUi) for the IPC layer to drive.

import type {
  OmpRpcClientEvent,
  OmpRpcExtensionUiResponse,
  OmpRpcImageContent,
  OmpRpcStreamingBehavior
} from '../../shared/omp-rpc-protocol'
import type { OmpRpcOwnedSession } from './omp-rpc-session-owner'

export type OmpRpcChatSendBehavior = 'idle' | OmpRpcStreamingBehavior

export type OmpRpcChatSendResult =
  | { ok: true; agentInvoked: boolean }
  | { ok: false; reason: string }

export class OmpRpcChatSession {
  private readonly listeners = new Set<(event: OmpRpcClientEvent) => void>()
  private readonly unsubscribeClient: () => void
  private isDisposed = false

  constructor(readonly owned: OmpRpcOwnedSession) {
    this.unsubscribeClient = owned.client.on((event) => this.emit(event))
  }

  on(listener: (event: OmpRpcClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Idle sends `prompt`; `steer` interrupts the in-progress turn; `follow_up`
   *  queues for after it settles. Matches OMP TUI send conventions (D6). */
  async send(args: {
    message: string
    images?: OmpRpcImageContent[]
    behavior: OmpRpcChatSendBehavior
  }): Promise<OmpRpcChatSendResult> {
    try {
      const result =
        args.behavior === 'idle'
          ? await this.owned.client.prompt(args.message, { images: args.images })
          : args.behavior === 'steer'
            ? await this.owned.client.steer(args.message, args.images)
            : await this.owned.client.followUp(args.message, args.images)
      return { ok: true, agentInvoked: result.agentInvoked }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async abort(): Promise<OmpRpcChatSendResult> {
    try {
      await this.owned.client.abort()
      return { ok: true, agentInvoked: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Fire-and-forget: false only means the transport can't accept writes right
   *  now (disposed/exited) — OMP resolves a pending dialog to a default on its
   *  own timeout, so a dropped reply is safe by design, not a hang. Wrapped
   *  in try/catch to match `send`/`abort`'s fail-closed contract (F7) rather
   *  than relying on every layer below independently never throwing. */
  respondExtensionUi(response: OmpRpcExtensionUiResponse): boolean {
    try {
      return this.owned.client.respondExtensionUi(response)
    } catch {
      return false
    }
  }

  dispose(): void {
    if (this.isDisposed) {
      return
    }
    this.isDisposed = true
    this.unsubscribeClient()
    this.listeners.clear()
  }

  private emit(event: OmpRpcClientEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
