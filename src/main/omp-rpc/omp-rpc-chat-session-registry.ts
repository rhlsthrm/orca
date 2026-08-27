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
  /** OMP resumes by session id (#8962) — this is the claim identity, never
   *  passed to the wire protocol directly. */
  sessionFile: string
  /** F12 live probe (ORCA_OMP_RPC_LIVE=1, omp-rpc-live.test.ts): `omp`'s
   *  `switch_session` requires the absolute session FILE path — a bare
   *  session id does not throw, but silently fails to switch (`sessionFile`
   *  on the resulting `get_state()` never matches). Resolved by the IPC
   *  handler from `sessionFile` via `resolveSessionFilePath`. */
  sessionFilePath: string
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

/** Why: `launchCommand`/`sessionFile`/`sessionId` used to be built here on the
 *  `exited` path, but no caller ever threaded a real `resumeContext` or read
 *  them (F10) — PTY auto-resume-on-release is a separate, still-pending
 *  product decision. Re-add them only alongside a real consumer. */
export type OmpRpcChatReleaseResult = {
  released: boolean
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
  // Why (finding C, cross-lab review): exposed via `claimedSessionFilePaths()`
  // so the identity resolver's mtime fallback (omp-terminal-session-identity.ts)
  // can exclude a session another live pane already claimed, before a second
  // pane sharing the same cwd bucket is ever offered it.
  private readonly sessionFilePathsByPaneKey = new Map<string, string>()
  // Why (F5): acquire/release for one paneKey must never race each other or
  // themselves — an in-flight release holds the RPC claim up to the 15s
  // settle+exit-proof window, and React StrictMode double-mounts fire two
  // concurrent acquires for the same identity. `generationByPaneKey` lets a
  // slower acquire that started against a since-superseded identity (an
  // in-flight rebind, not just a release) detect it lost and dispose itself
  // instead of publishing a stale session over a newer one.
  private readonly pendingAcquireByPaneKey = new Map<
    string,
    { identityKey: string; promise: Promise<OmpRpcChatAcquireResult> }
  >()
  private readonly pendingReleaseByPaneKey = new Map<string, Promise<OmpRpcChatReleaseResult>>()
  private readonly generationByPaneKey = new Map<string, number>()

  constructor(
    dependencies: Omit<ConstructorParameters<typeof OmpRpcSessionOwner>[0], 'registry'> = {}
  ) {
    this.owner = new OmpRpcSessionOwner({
      registry: this.ptyOwnerRegistry,
      ...dependencies
    })
  }

  get(paneKey: string): OmpRpcChatSession | null {
    return this.sessionsByPaneKey.get(paneKey) ?? null
  }

  /** Session file paths currently claimed by a live pane (finding C) — read
   *  by the identity resolver's mtime-fallback candidate scan so a session
   *  another pane already owns is never offered to a second pane sharing
   *  the same cwd bucket. */
  claimedSessionFilePaths(): ReadonlySet<string> {
    return new Set(this.sessionFilePathsByPaneKey.values())
  }

  async acquire(args: OmpRpcChatAcquireArgs): Promise<OmpRpcChatAcquireResult> {
    const pendingRelease = this.pendingReleaseByPaneKey.get(args.paneKey)
    if (pendingRelease) {
      await pendingRelease
    }
    const existing = this.sessionsByPaneKey.get(args.paneKey)
    if (existing) {
      return { status: 'acquired', session: existing }
    }
    const identityKey = args.sessionFile
    const pendingAcquire = this.pendingAcquireByPaneKey.get(args.paneKey)
    if (pendingAcquire && pendingAcquire.identityKey === identityKey) {
      return pendingAcquire.promise
    }
    const generation = (this.generationByPaneKey.get(args.paneKey) ?? 0) + 1
    this.generationByPaneKey.set(args.paneKey, generation)
    const promise = this.performAcquire(args, generation)
    this.pendingAcquireByPaneKey.set(args.paneKey, { identityKey, promise })
    try {
      return await promise
    } finally {
      if (this.pendingAcquireByPaneKey.get(args.paneKey)?.promise === promise) {
        this.pendingAcquireByPaneKey.delete(args.paneKey)
      }
    }
  }

  private async performAcquire(
    args: OmpRpcChatAcquireArgs,
    generation: number
  ): Promise<OmpRpcChatAcquireResult> {
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
      sessionFile: args.sessionFilePath,
      spawnOptions,
      provePtyExit: () => Promise.resolve(ptyExitVerdict(args.ptyId, args.isPtyAlive))
    })
    if (result.status === 'acquired') {
      const session = new OmpRpcChatSession(result.session)
      // Why: a slower acquire for a paneKey whose identity has since been
      // rebound or released must never overwrite the newer session — dispose
      // the loser instead (F5 / cross-lab HIGH_2).
      if (this.generationByPaneKey.get(args.paneKey) !== generation) {
        session.owned.client.dispose()
        this.ptyOwnerRegistry.releaseRpc(session.owned.owner)
        session.dispose()
        return { status: 'conflict' }
      }
      this.sessionsByPaneKey.set(args.paneKey, session)
      this.claimsByPaneKey.set(args.paneKey, claim)
      this.sessionFilePathsByPaneKey.set(args.paneKey, args.sessionFilePath)
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

  /** Proof-gated: disposes the RPC child and releases the claim only once
   *  `handoffToPty` proves the turn settled and the child genuinely exited
   *  (Critical B, wave 5) — never unconditionally, which would silently
   *  kill a still-streaming turn. A release that cannot prove this fails
   *  closed (`released: false`), keeping the session registered. Tracked
   *  in `pendingReleaseByPaneKey` so a concurrent `acquire` for the same
   *  pane waits for this to finish instead of racing it into a spurious
   *  `agent_session_conflict` (F5) — the claim stays held for the whole
   *  settle+exit-proof window below, not just until this method returns. */
  async release(paneKey: string): Promise<OmpRpcChatReleaseResult> {
    const promise = this.performRelease(paneKey)
    this.pendingReleaseByPaneKey.set(paneKey, promise)
    try {
      return await promise
    } finally {
      if (this.pendingReleaseByPaneKey.get(paneKey) === promise) {
        this.pendingReleaseByPaneKey.delete(paneKey)
      }
    }
  }

  private async performRelease(paneKey: string): Promise<OmpRpcChatReleaseResult> {
    const session = this.sessionsByPaneKey.get(paneKey)
    if (!session) {
      return { released: false }
    }
    const result = await this.owner.handoffToPty({
      session: session.owned,
      baseCommand: 'omp',
      shell: process.platform === 'win32' ? 'cmd' : 'posix'
    })
    if (result.status !== 'exited') {
      // Why (Critical B, cross-lab review): fail closed. A turn that never
      // proves settled/exited within handoffToPty's bounded wait must keep
      // holding the RPC claim, not have its (possibly still-streaming)
      // child force-disposed out from under it — the OLD code disposed and
      // released unconditionally here regardless of this result, which is
      // exactly the "silently kill live work" bug this wave fixes. The
      // session stays registered so a later release attempt, or a
      // returning acquire (which finds and reuses it), can still act on it.
      return { released: false }
    }
    // handoffToPty's 'exited' path already disposed the client and released
    // the ptyOwner claim (dispose -> proveExit -> releaseRpc) before
    // returning — nothing left to force here.
    this.sessionsByPaneKey.delete(paneKey)
    this.claimsByPaneKey.delete(paneKey)
    this.sessionFilePathsByPaneKey.delete(paneKey)
    session.dispose()
    return { released: true }
  }

  /** Unlike `release` (which now waits on `handoffToPty`'s settle-then-exit
   *  ordering and can fail closed, keeping the claim), app quit cannot wait
   *  — dispose the transport (the only thing that SIGTERMs the child),
   *  release the claim, then the session's own listener teardown, so an app
   *  quit mid-turn cannot orphan an `omp --mode rpc` child that keeps
   *  writing the session (F4/D2). */
  disposeAll(): void {
    for (const session of this.sessionsByPaneKey.values()) {
      session.owned.client.dispose()
      this.ptyOwnerRegistry.releaseRpc(session.owned.owner)
      session.dispose()
    }
    this.sessionsByPaneKey.clear()
    this.claimsByPaneKey.clear()
    this.sessionFilePathsByPaneKey.clear()
  }
}
