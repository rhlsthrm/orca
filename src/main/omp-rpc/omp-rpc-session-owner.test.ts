import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type {
  OmpRpcClientEvent,
  OmpRpcSessionState,
  OmpSessionOwningRpcClient
} from '../../shared/omp-rpc-protocol'
import { OmpRpcSessionOwner, type OmpRpcOwnerExitVerdict } from './omp-rpc-session-owner'

const settledState: OmpRpcSessionState = {
  sessionFile: '/sessions/current.jsonl',
  sessionId: 'session-current',
  isStreaming: false,
  isCompacting: false,
  queuedMessageCount: 0
}

const surface: AgentSessionSurfaceBinding = {
  worktreeId: 'worktree',
  tabId: 'tab',
  leafId: '12345678-1234-4234-8234-123456789abc',
  terminalHandle: 'term_handle'
}

function claim(): AgentSessionExecutionClaim {
  return {
    digestVersion: 1,
    keyId: 'omp-session',
    identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    agent: 'omp'
  }
}

function fakeClient(overrides: Partial<OmpSessionOwningRpcClient> = {}): OmpSessionOwningRpcClient {
  const listeners = new Set<(event: OmpRpcClientEvent) => void>()
  return {
    whenReady: vi.fn(async () => ({
      ready: {
        type: 'ready' as const,
        protocolVersion: 1 as const,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1_048_576,
        maxReassembledFrameBytes: 67_108_864
      },
      negotiatedProtocolVersion: 2
    })),
    getCommands: vi.fn(async () => []),
    prompt: vi.fn(async () => ({ agentInvoked: true })),
    steer: vi.fn(async () => ({ agentInvoked: true })),
    followUp: vi.fn(async () => ({ agentInvoked: true })),
    respondExtensionUi: vi.fn(() => true),
    getState: vi.fn(async () => settledState),
    switchSession: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    whenExited: vi.fn(async () => ({ code: 0, signal: null })),
    on: vi.fn((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    dispose: vi.fn(),
    ...overrides
  }
}

const spawnOptions = {
  executablePath: 'omp',
  cwd: '/worktree'
}

function acquiredSession(
  result: Awaited<ReturnType<OmpRpcSessionOwner['acquire']>>
): Extract<typeof result, { status: 'acquired' }> {
  expect(result.status).toBe('acquired')
  if (result.status !== 'acquired') {
    throw new Error(`Expected acquisition, received ${result.status}`)
  }
  return result
}

describe('OMP RPC session ownership', () => {
  it('refuses a non-OMP execution claim without spawning', async () => {
    const spawnClient = vi.fn(() => fakeClient())
    const owner = new OmpRpcSessionOwner({
      registry: new ClaimedAgentPtyOwnerRegistry(),
      spawnClient
    })

    await expect(
      owner.acquire({ claim: { ...claim(), agent: 'codex' }, spawnOptions })
    ).resolves.toEqual({
      status: 'ownership-unknown',
      reason: 'agent_session_ownership_unknown'
    })
    expect(spawnClient).not.toHaveBeenCalled()
  })

  it('keeps spawn error provenance when its message resembles a conflict', async () => {
    const owner = new OmpRpcSessionOwner({
      registry: new ClaimedAgentPtyOwnerRegistry(),
      spawnClient: () => {
        throw new Error('agent_session_conflict')
      }
    })

    await expect(owner.acquire({ claim: claim(), spawnOptions })).resolves.toEqual({
      status: 'spawn-failed',
      reason: 'agent_session_conflict'
    })
  })

  it('refuses to spawn when a PTY owns the claim', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    await registry.ensure({
      claim: claim(),
      surface,
      spawn: async () => ({ ptyId: 'pty-1' })
    })
    const spawnClient = vi.fn(() => fakeClient())
    const owner = new OmpRpcSessionOwner({ registry, spawnClient })

    await expect(owner.acquire({ claim: claim(), spawnOptions })).resolves.toEqual({
      status: 'conflict',
      reason: 'agent_session_conflict'
    })
    expect(spawnClient).not.toHaveBeenCalled()
  })

  it('refuses a PTY claim while an RPC child owns the session', async () => {
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient: () => fakeClient()
    })
    acquiredSession(await owner.acquire({ claim: claim(), spawnOptions }))
    const spawnPty = vi.fn(async () => ({ ptyId: 'pty-1' }))

    await expect(registry.ensure({ claim: claim(), surface, spawn: spawnPty })).rejects.toThrow(
      'agent_session_conflict'
    )
    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('disposes, proves exit, releases, then builds the PTY resume launch', async () => {
    const order: string[] = []
    const client = fakeClient({ dispose: vi.fn(() => order.push('dispose')) })
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const originalRelease = registry.releaseRpc.bind(registry)
    vi.spyOn(registry, 'releaseRpc').mockImplementation((binding) => {
      order.push('release')
      return originalRelease(binding)
    })
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient: () => client,
      proveRpcExit: async () => {
        order.push('prove-exit')
        return { status: 'exited' }
      },
      buildResumeLaunch: () => {
        order.push('resume')
        return 'omp --resume /sessions/current.jsonl'
      }
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    await expect(
      owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix' })
    ).resolves.toMatchObject({
      status: 'exited',
      launchCommand: 'omp --resume /sessions/current.jsonl',
      sessionFile: '/sessions/current.jsonl'
    })
    expect(order).toEqual(['dispose', 'prove-exit', 'release', 'resume'])
  })

  it('retains the claim and refuses resume when exit is unverifiable', async () => {
    const client = fakeClient()
    const registry = new ClaimedAgentPtyOwnerRegistry()
    const buildResumeLaunch = vi.fn(() => 'must-not-run')
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient: () => client,
      proveRpcExit: async (): Promise<OmpRpcOwnerExitVerdict> => ({
        status: 'unverifiable',
        reason: 'host stopped responding'
      }),
      buildResumeLaunch
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    await expect(
      owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix' })
    ).resolves.toEqual({
      status: 'unverifiable',
      reason: 'host stopped responding'
    })
    expect(registry.findRpc(claim())).not.toBeNull()
    expect(buildResumeLaunch).not.toHaveBeenCalled()
  })

  // Critical B (cross-lab review, wave 5): handoffToPty used to abort a
  // streaming turn unconditionally — the exact "a mere view toggle silently
  // aborts an in-flight turn" outcome Decision 1/F9 forbid. Default is now
  // never-abort; only an explicit `allowAbort: true` caller may abort.
  it('never aborts a streaming turn by default — waits for it to settle before reading the session path', async () => {
    const order: string[] = []
    const streamingState: OmpRpcSessionState = {
      get sessionFile() {
        order.push('read-stale-path')
        return '/sessions/stale.jsonl'
      },
      sessionId: 'session-current',
      isStreaming: true,
      isCompacting: false,
      queuedMessageCount: 0
    }
    const finalState: OmpRpcSessionState = {
      get sessionFile() {
        order.push('read-path')
        return '/sessions/current.jsonl'
      },
      sessionId: 'session-current',
      isStreaming: false,
      isCompacting: false,
      queuedMessageCount: 0
    }
    const getState = vi
      .fn<() => Promise<OmpRpcSessionState>>()
      .mockResolvedValueOnce(streamingState)
      .mockResolvedValue(finalState)
    const abort = vi.fn(async () => {
      order.push('abort')
    })
    const client = fakeClient({ getState, abort })
    const owner = new OmpRpcSessionOwner({
      registry: new ClaimedAgentPtyOwnerRegistry(),
      spawnClient: () => client,
      waitForSettle: async () => {
        order.push('settle')
        return { status: 'settled' }
      },
      proveRpcExit: async () => ({ status: 'exited' }),
      buildResumeLaunch: () => 'omp --resume /sessions/current.jsonl'
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    await owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix' })

    expect(order).toEqual(['settle', 'read-path'])
    expect(abort).not.toHaveBeenCalled()
  })

  it('aborts and settles streaming work before reading the session path when allowAbort is explicitly set', async () => {
    const order: string[] = []
    const streamingState: OmpRpcSessionState = {
      get sessionFile() {
        order.push('read-stale-path')
        return '/sessions/stale.jsonl'
      },
      sessionId: 'session-current',
      isStreaming: true,
      isCompacting: false,
      queuedMessageCount: 0
    }
    const finalState: OmpRpcSessionState = {
      get sessionFile() {
        order.push('read-path')
        return '/sessions/current.jsonl'
      },
      sessionId: 'session-current',
      isStreaming: false,
      isCompacting: false,
      queuedMessageCount: 0
    }
    const getState = vi
      .fn<() => Promise<OmpRpcSessionState>>()
      .mockResolvedValueOnce(streamingState)
      .mockResolvedValue(finalState)
    const client = fakeClient({
      getState,
      abort: vi.fn(async () => {
        order.push('abort')
      })
    })
    const owner = new OmpRpcSessionOwner({
      registry: new ClaimedAgentPtyOwnerRegistry(),
      spawnClient: () => client,
      waitForSettle: async () => {
        order.push('settle')
        return { status: 'settled' }
      },
      proveRpcExit: async () => ({ status: 'exited' }),
      buildResumeLaunch: () => 'omp --resume /sessions/current.jsonl'
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    await owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix', allowAbort: true })

    expect(order).toEqual(['abort', 'settle', 'read-path'])
  })

  // Critical B: the unmount path (leave Chat view, pane force-close, app
  // quit) must fail closed rather than silently killing live work — a turn
  // that never settles within the bounded wait keeps the claim, and the
  // client is never disposed out from under it.
  it('fails closed without disposing the client when a streaming turn never settles', async () => {
    const streamingState: OmpRpcSessionState = {
      sessionFile: '/sessions/current.jsonl',
      sessionId: 'session-current',
      isStreaming: true,
      isCompacting: false,
      queuedMessageCount: 0
    }
    const client = fakeClient({ getState: vi.fn(async () => streamingState) })
    const owner = new OmpRpcSessionOwner({
      registry: new ClaimedAgentPtyOwnerRegistry(),
      spawnClient: () => client,
      waitForSettle: async () => ({
        status: 'unverifiable',
        reason: 'OMP RPC session did not settle before timeout'
      })
    })
    const session = acquiredSession(await owner.acquire({ claim: claim(), spawnOptions })).session

    await expect(
      owner.handoffToPty({ session, baseCommand: 'omp', shell: 'posix' })
    ).resolves.toEqual({
      status: 'unverifiable',
      reason: 'OMP RPC session did not settle before timeout'
    })
    expect(client.dispose).not.toHaveBeenCalled()
    expect(client.abort).not.toHaveBeenCalled()
  })

  it('proves the PTY exited before spawning and switching the RPC child', async () => {
    const order: string[] = []
    const registry = new ClaimedAgentPtyOwnerRegistry()
    await registry.ensure({
      claim: claim(),
      surface,
      spawn: async () => ({ ptyId: 'pty-1' })
    })
    const originalRelease = registry.release.bind(registry)
    vi.spyOn(registry, 'release').mockImplementation((...args) => {
      order.push('release-pty')
      originalRelease(...args)
    })
    const client = fakeClient({
      switchSession: vi.fn(async () => {
        order.push('switch')
      })
    })
    const spawnClient = vi.fn(() => {
      order.push('spawn')
      return client
    })
    const owner = new OmpRpcSessionOwner({
      registry,
      spawnClient
    })

    const result = await owner.handoffFromPty({
      claim: claim(),
      sessionFile: '/sessions/current.jsonl',
      spawnOptions,
      provePtyExit: async () => {
        order.push('prove-pty-exit')
        return { status: 'exited' }
      }
    })

    expect(result.status).toBe('acquired')
    expect(order).toEqual(['prove-pty-exit', 'release-pty', 'spawn', 'switch'])
    expect(spawnClient).toHaveBeenCalledWith({
      ...spawnOptions,
      sessionMode: 'session-owning'
    })
  })
})
