// Per-pane registry of RPC-owned OMP chat sessions (milestone 1: streaming
// turns over RPC). Acquisition is proof-gated through
// OmpRpcSessionOwner.handoffFromPty: OMP has no single-writer enforcement, so
// RPC may only take a session whose PTY is verifiably NOT running — never a
// live one. `provePtyExit` is a read-only liveness query (never a kill), so
// this registry only ever adopts a session whose PTY already exited on its
// own; it never terminates a running PTY to make room for RPC.
//
// Scoped to its OWN ClaimedAgentPtyOwnerRegistry + ephemeral claim signer,
// deliberately NOT the runtime's global PTY-claim registry (which is used for
// cross-host/mobile execution claims, not plain local panes — plain local OMP
// panes never register a claim there today). Real dual-writer safety comes
// from the liveness check above, not from cross-registry conflict detection.
// See docs/omp-rpc-chat-adapter-plan.md for the full scoping rationale.

import type { AgentSessionExecutionClaim } from '../../shared/agent-session-host-authority'
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type { OmpRpcBaseSpawnOptions } from '../../shared/omp-rpc-protocol'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import {
  canonicalizeAgentSessionIdentity,
  createEphemeralAgentSessionClaimSigner,
  type AgentSessionClaimSigner,
  type ProviderExecutionNamespace
} from '../runtime/agent-session-claim-identity'
import { OmpRpcChatSession } from './omp-rpc-chat-session'
import { OmpRpcSessionOwner, type OmpRpcOwnerExitVerdict } from './omp-rpc-session-owner'

// Why: this feature is local-runtime-only this milestone (remote is OUT); the
// namespace only needs to be internally stable, not globally meaningful, since
// the dedicated registry above is never compared against a remote claim.
const LOCAL_NAMESPACE: ProviderExecutionNamespace = {
  machine: 'local',
  principal: 'local',
  container: 'local',
  providerRoot: 'local'
}
const LOCAL_WORKTREE_SCOPE = 'omp-rpc-chat-session'

export type OmpRpcChatAcquireArgs = {
  paneKey: string
  ptyId: string
  cwd: string
  executablePath: string
  sessionFile: string
  /** Read-only liveness query for `ptyId` — true/false/null (unverifiable),
   *  matching the SSH execution boundary's live/unverifiable/exited vocabulary. */
  isPtyAlive: (ptyId: string) => boolean | null
}

export type OmpRpcChatAcquireResult =
  | { status: 'acquired'; session: OmpRpcChatSession }
  | { status: 'live' }
  | { status: 'unverifiable'; reason: string }
  | { status: 'conflict' }
  | { status: 'spawn-failed'; reason: string }

export type OmpRpcChatReleaseResult = {
  released: boolean
  sessionFile?: string
  sessionId?: string
  launchCommand?: string
}

function ptyExitVerdict(
  ptyId: string,
  isPtyAlive: (ptyId: string) => boolean | null
): OmpRpcOwnerExitVerdict {
  const alive = isPtyAlive(ptyId)
  if (alive === true) {
    return { status: 'live', reason: 'pty still running' }
  }
  if (alive === null) {
    return { status: 'unverifiable', reason: 'pty liveness could not be determined' }
  }
  return { status: 'exited' }
}

export class OmpRpcChatSessionRegistry {
  private readonly ptyOwnerRegistry = new ClaimedAgentPtyOwnerRegistry()
  private readonly claimSigner: AgentSessionClaimSigner =
    createEphemeralAgentSessionClaimSigner('omp-rpc-chat')
  private readonly owner: OmpRpcSessionOwner
  private readonly sessionsByPaneKey = new Map<string, OmpRpcChatSession>()
  private readonly claimsByPaneKey = new Map<string, AgentSessionExecutionClaim>()

  constructor(
    dependencies: {
      spawnClient?: ConstructorParameters<typeof OmpRpcSessionOwner>[0]['spawnClient']
    } = {}
  ) {
    this.owner = new OmpRpcSessionOwner({
      registry: this.ptyOwnerRegistry,
      spawnClient: dependencies.spawnClient
    })
  }

  get(paneKey: string): OmpRpcChatSession | null {
    return this.sessionsByPaneKey.get(paneKey) ?? null
  }

  async acquire(args: OmpRpcChatAcquireArgs): Promise<OmpRpcChatAcquireResult> {
    const existing = this.sessionsByPaneKey.get(args.paneKey)
    if (existing) {
      return { status: 'acquired', session: existing }
    }
    let claim: AgentSessionExecutionClaim
    try {
      const identity = canonicalizeAgentSessionIdentity('omp', {
        key: 'session_id',
        id: args.sessionFile
      })
      claim = this.claimSigner.createClaim({
        namespace: LOCAL_NAMESPACE,
        identity,
        canonicalWorktreeId: LOCAL_WORKTREE_SCOPE
      })
    } catch (error) {
      return {
        status: 'spawn-failed',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
    const spawnOptions: OmpRpcBaseSpawnOptions = {
      executablePath: args.executablePath,
      cwd: args.cwd
    }
    const result = await this.owner.handoffFromPty({
      claim,
      sessionFile: args.sessionFile,
      spawnOptions,
      provePtyExit: () => Promise.resolve(ptyExitVerdict(args.ptyId, args.isPtyAlive))
    })
    if (result.status === 'acquired') {
      const session = new OmpRpcChatSession(result.session)
      this.sessionsByPaneKey.set(args.paneKey, session)
      this.claimsByPaneKey.set(args.paneKey, claim)
      return { status: 'acquired', session }
    }
    if (result.status === 'live' || result.status === 'unverifiable') {
      return result
    }
    if (result.status === 'conflict' || result.status === 'ownership-unknown') {
      return { status: 'conflict' }
    }
    return { status: 'spawn-failed', reason: result.reason }
  }

  /** Always disposes the RPC child, proof-gated: never leaves an RPC child
   *  holding the session hostage after the pane stops watching it. */
  async release(
    paneKey: string,
    resumeContext?: { baseCommand: string; shell: AgentStartupShell }
  ): Promise<OmpRpcChatReleaseResult> {
    const session = this.sessionsByPaneKey.get(paneKey)
    if (!session) {
      return { released: false }
    }
    this.sessionsByPaneKey.delete(paneKey)
    this.claimsByPaneKey.delete(paneKey)
    const result = await this.owner.handoffToPty({
      session: session.owned,
      baseCommand: resumeContext?.baseCommand ?? 'omp',
      shell: resumeContext?.shell ?? (process.platform === 'win32' ? 'cmd' : 'posix')
    })
    // Why: handoffToPty's early-return paths (a settle-wait or getState that
    // never proves settlement) can leave the underlying client undisposed and
    // its claim still held. Force both unconditionally so leaving chat view
    // never leaks a connected RPC child or permanently blocks a future
    // acquisition of the same session identity; releaseRpc is a safe no-op
    // when handoffToPty already released it via the 'exited' path.
    session.owned.client.dispose()
    this.ptyOwnerRegistry.releaseRpc(session.owned.owner)
    session.dispose()
    if (result.status === 'exited') {
      return {
        released: true,
        sessionFile: result.sessionFile,
        sessionId: result.sessionId,
        launchCommand: result.launchCommand
      }
    }
    return { released: true }
  }

  disposeAll(): void {
    for (const session of this.sessionsByPaneKey.values()) {
      session.dispose()
    }
    this.sessionsByPaneKey.clear()
    this.claimsByPaneKey.clear()
  }
}
