import type {
  AgentSessionExecutionClaim,
  AgentSessionRpcOwnerBinding
} from '../../shared/agent-session-host-authority'
import type { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import { ClaimedAgentRpcSpawnError } from '../../shared/claimed-agent-rpc-owner'
import { getAgentResumeArgv } from '../../shared/agent-session-resume'
import { buildAgentResumeLaunchCommand } from '../../shared/agent-resume-launch-command'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import type {
  OmpRpcBaseSpawnOptions,
  OmpRpcSessionState,
  OmpSessionOwningRpcClient
} from '../../shared/omp-rpc-protocol'
import { spawnOmpRpcClient } from './omp-rpc-client'

const OMP_RPC_SETTLE_TIMEOUT_MS = 10_000
const OMP_RPC_SETTLE_POLL_MS = 25
const OMP_RPC_EXIT_PROOF_TIMEOUT_MS = 5_000

export type OmpRpcOwnerExitVerdict =
  | { status: 'live'; reason: string }
  | { status: 'unverifiable'; reason: string }
  | { status: 'exited' }

export type OmpRpcOwnedSession = {
  client: OmpSessionOwningRpcClient
  owner: AgentSessionRpcOwnerBinding & { phase: 'live' }
}

export type OmpRpcSessionAcquireResult =
  | { status: 'acquired'; session: OmpRpcOwnedSession }
  | { status: 'conflict'; reason: 'agent_session_conflict' }
  | { status: 'ownership-unknown'; reason: string }
  | {
      status: 'spawn-failed'
      reason: string
      exitVerdict?: OmpRpcOwnerExitVerdict
    }

export type OmpRpcSettleResult = { status: 'settled' } | { status: 'unverifiable'; reason: string }

export type OmpRpcToPtyHandoffResult =
  | {
      status: 'exited'
      sessionFile: string
      sessionId: string
      launchCommand: string
    }
  | Exclude<OmpRpcOwnerExitVerdict, { status: 'exited' }>
  | { status: 'ownership-unknown'; reason: string }

export type OmpRpcFromPtyHandoffResult =
  | OmpRpcSessionAcquireResult
  | Exclude<OmpRpcOwnerExitVerdict, { status: 'exited' }>

type OmpRpcSessionOwnerDependencies = {
  registry: ClaimedAgentPtyOwnerRegistry
  spawnClient?: (
    options: OmpRpcBaseSpawnOptions & { sessionMode: 'session-owning' }
  ) => OmpSessionOwningRpcClient
  proveRpcExit?: (client: OmpSessionOwningRpcClient) => Promise<OmpRpcOwnerExitVerdict>
  waitForSettle?: (client: OmpSessionOwningRpcClient) => Promise<OmpRpcSettleResult>
  buildResumeLaunch?: (args: {
    baseCommand: string
    shell: AgentStartupShell
    sessionFile: string
    sessionId: string
  }) => string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isSettled(state: OmpRpcSessionState): boolean {
  return !state.isStreaming && !state.isCompacting && state.queuedMessageCount === 0
}

async function waitForSettleDefault(
  client: OmpSessionOwningRpcClient
): Promise<OmpRpcSettleResult> {
  const deadline = Date.now() + OMP_RPC_SETTLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      if (isSettled(await client.getState())) {
        return { status: 'settled' }
      }
    } catch (error) {
      return { status: 'unverifiable', reason: errorMessage(error) }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, OMP_RPC_SETTLE_POLL_MS))
  }
  return { status: 'unverifiable', reason: 'OMP RPC session did not settle before timeout' }
}

function proveRpcExitDefault(client: OmpSessionOwningRpcClient): Promise<OmpRpcOwnerExitVerdict> {
  return new Promise((resolve) => {
    let isResolved = false
    const timer = setTimeout(() => {
      isResolved = true
      resolve({
        status: 'unverifiable',
        reason: 'OMP RPC child exit was not proven before timeout'
      })
    }, OMP_RPC_EXIT_PROOF_TIMEOUT_MS)
    timer.unref?.()
    void client.whenExited().then(
      () => {
        if (isResolved) {
          return
        }
        isResolved = true
        clearTimeout(timer)
        resolve({ status: 'exited' })
      },
      (error: unknown) => {
        if (isResolved) {
          return
        }
        isResolved = true
        clearTimeout(timer)
        resolve({ status: 'unverifiable', reason: errorMessage(error) })
      }
    )
  })
}

function buildResumeLaunchDefault(args: {
  baseCommand: string
  shell: AgentStartupShell
  sessionFile: string
  sessionId: string
}): string {
  const resumeArgv = getAgentResumeArgv(
    'omp',
    { key: 'session_id', id: args.sessionId },
    args.sessionFile
  )
  if (!resumeArgv) {
    throw new Error('OMP RPC session identity could not build a PTY resume launch')
  }
  return buildAgentResumeLaunchCommand('omp', args.baseCommand, resumeArgv, args.shell)
}

export class OmpRpcSessionOwner {
  private readonly spawnClient: NonNullable<OmpRpcSessionOwnerDependencies['spawnClient']>
  private readonly proveRpcExit: NonNullable<OmpRpcSessionOwnerDependencies['proveRpcExit']>
  private readonly waitForSettle: NonNullable<OmpRpcSessionOwnerDependencies['waitForSettle']>
  private readonly buildResumeLaunch: NonNullable<
    OmpRpcSessionOwnerDependencies['buildResumeLaunch']
  >

  constructor(private readonly dependencies: OmpRpcSessionOwnerDependencies) {
    this.spawnClient = dependencies.spawnClient ?? spawnOmpRpcClient
    this.proveRpcExit = dependencies.proveRpcExit ?? proveRpcExitDefault
    this.waitForSettle = dependencies.waitForSettle ?? waitForSettleDefault
    this.buildResumeLaunch = dependencies.buildResumeLaunch ?? buildResumeLaunchDefault
  }

  async acquire(args: {
    claim: AgentSessionExecutionClaim
    spawnOptions: OmpRpcBaseSpawnOptions
    sessionFile?: string
  }): Promise<OmpRpcSessionAcquireResult> {
    if (args.claim.agent !== 'omp') {
      return {
        status: 'ownership-unknown',
        reason: 'agent_session_ownership_unknown'
      }
    }
    let claimed: Awaited<ReturnType<ClaimedAgentPtyOwnerRegistry['ensureRpc']>>
    try {
      claimed = await this.dependencies.registry.ensureRpc({
        claim: args.claim,
        spawn: () => this.spawnClient({ ...args.spawnOptions, sessionMode: 'session-owning' })
      })
    } catch (error) {
      return this.failedAcquisition(error)
    }

    const session: OmpRpcOwnedSession = {
      client: claimed.value as OmpSessionOwningRpcClient,
      owner: claimed.owner
    }
    try {
      await session.client.whenReady()
      if (args.sessionFile) {
        await session.client.switchSession(args.sessionFile)
        const state = await session.client.getState()
        if (state.sessionFile !== args.sessionFile) {
          throw new Error('OMP RPC child did not switch to the requested session')
        }
      }
      return { status: 'acquired', session }
    } catch (error) {
      return await this.cleanupFailedSpawn(session, error)
    }
  }

  async handoffToPty(args: {
    session: OmpRpcOwnedSession
    baseCommand: string
    shell: AgentStartupShell
  }): Promise<OmpRpcToPtyHandoffResult> {
    let state: OmpRpcSessionState
    try {
      state = await args.session.client.getState()
      if (state.isStreaming) {
        await args.session.client.abort()
      }
      if (!isSettled(state)) {
        const settled = await this.waitForSettle(args.session.client)
        if (settled.status === 'unverifiable') {
          return settled
        }
        state = await args.session.client.getState()
      }
    } catch (error) {
      return { status: 'unverifiable', reason: errorMessage(error) }
    }

    const sessionFile = state.sessionFile?.trim()
    const sessionId = state.sessionId?.trim()
    if (!sessionFile || !sessionId) {
      return {
        status: 'ownership-unknown',
        reason: 'OMP RPC child did not report a complete session identity'
      }
    }

    args.session.client.dispose()
    const verdict = await this.proveExit(args.session.client)
    if (verdict.status !== 'exited') {
      return verdict
    }
    // Exit proof must precede release or a resumed PTY could overlap the RPC writer.
    if (!this.dependencies.registry.releaseRpc(args.session.owner)) {
      return {
        status: 'ownership-unknown',
        reason: 'OMP RPC session claim changed before handoff release'
      }
    }
    try {
      const launchCommand = this.buildResumeLaunch({
        baseCommand: args.baseCommand,
        shell: args.shell,
        sessionFile,
        sessionId
      })
      return { status: 'exited', sessionFile, sessionId, launchCommand }
    } catch (error) {
      return { status: 'ownership-unknown', reason: errorMessage(error) }
    }
  }

  async handoffFromPty(args: {
    claim: AgentSessionExecutionClaim
    sessionFile: string
    spawnOptions: OmpRpcBaseSpawnOptions
    provePtyExit: () => Promise<OmpRpcOwnerExitVerdict>
  }): Promise<OmpRpcFromPtyHandoffResult> {
    const ptyOwner = this.dependencies.registry.find(args.claim)
    let verdict: OmpRpcOwnerExitVerdict
    try {
      verdict = await args.provePtyExit()
    } catch (error) {
      return { status: 'unverifiable', reason: errorMessage(error) }
    }
    if (verdict.status !== 'exited') {
      return verdict
    }
    if (ptyOwner) {
      this.dependencies.registry.release(ptyOwner.ptyId, ptyOwner.generation)
    }
    return await this.acquire({
      claim: args.claim,
      spawnOptions: args.spawnOptions,
      sessionFile: args.sessionFile
    })
  }

  private failedAcquisition(error: unknown): OmpRpcSessionAcquireResult {
    if (error instanceof ClaimedAgentRpcSpawnError) {
      return { status: 'spawn-failed', reason: error.message }
    }
    const reason = errorMessage(error)
    if (reason === 'agent_session_conflict') {
      return { status: 'conflict', reason }
    }
    if (reason === 'agent_session_ownership_unknown' || reason === 'execution_owner_unavailable') {
      return { status: 'ownership-unknown', reason }
    }
    return { status: 'spawn-failed', reason }
  }

  private async cleanupFailedSpawn(
    session: OmpRpcOwnedSession,
    error: unknown
  ): Promise<OmpRpcSessionAcquireResult> {
    session.client.dispose()
    const exitVerdict = await this.proveExit(session.client)
    if (exitVerdict.status === 'exited') {
      this.dependencies.registry.releaseRpc(session.owner)
    }
    return { status: 'spawn-failed', reason: errorMessage(error), exitVerdict }
  }

  private async proveExit(client: OmpSessionOwningRpcClient): Promise<OmpRpcOwnerExitVerdict> {
    try {
      return await this.proveRpcExit(client)
    } catch (error) {
      return { status: 'unverifiable', reason: errorMessage(error) }
    }
  }
}
