import { describe, expect, it, vi, beforeEach } from 'vitest'
import type {
  OmpRpcGetCommandsResult,
  OmpRpcRunLocalCommandResult
} from '../../shared/omp-rpc-ipc-contract'

const { handle, appOnce, pool, createOmpRpcProbePool, isCommandOnLocalPath, hydrateShellPath } =
  vi.hoisted(() => {
    const pool = {
      getCommands: vi.fn(),
      runLocalCommand: vi.fn(),
      dispose: vi.fn()
    }
    return {
      handle: vi.fn(),
      appOnce: vi.fn(),
      pool,
      createOmpRpcProbePool: vi.fn(() => pool),
      isCommandOnLocalPath: vi.fn(),
      hydrateShellPath: vi.fn()
    }
  })

vi.mock('electron', () => ({ ipcMain: { handle }, app: { once: appOnce } }))
vi.mock('./omp-rpc-probe-pool', () => ({ createOmpRpcProbePool }))
vi.mock('./command-path-resolver', () => ({ isCommandOnLocalPath }))
vi.mock('./agent-detection-shell-path', () => ({
  hydrateShellPathForAgentDetection: hydrateShellPath
}))

import { disposeOmpRpcProbes, registerOmpRpcHandlers } from './omp-rpc'

function invoke(channel: string, args?: unknown): Promise<unknown> {
  const handler = handle.mock.calls.find(([name]) => name === channel)?.[1] as (
    event: unknown,
    args?: unknown
  ) => Promise<unknown>
  return handler({}, args)
}

describe('OMP RPC IPC handlers', () => {
  beforeEach(() => {
    // Drop any pool a previous test built BEFORE clearing mocks, so its teardown
    // dispose is not counted against the next test.
    disposeOmpRpcProbes()
    vi.clearAllMocks()
    hydrateShellPath.mockResolvedValue(undefined)
  })

  it('registers both channels and a shutdown disposal hook', () => {
    registerOmpRpcHandlers()
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual([
      'ompRpc:getCommands',
      'ompRpc:runLocalCommand'
    ])
    expect(appOnce).toHaveBeenCalledWith('will-quit', disposeOmpRpcProbes)
  })

  it('forwards a catalog read to the pool', async () => {
    const commands: OmpRpcGetCommandsResult = { ok: true, commands: [{ name: 'usage' }] }
    pool.getCommands.mockResolvedValue(commands)
    isCommandOnLocalPath.mockResolvedValue(true)
    registerOmpRpcHandlers()

    await expect(invoke('ompRpc:getCommands', { cwd: '/work/a' })).resolves.toEqual(commands)
    expect(pool.getCommands).toHaveBeenCalledWith('/work/a')
  })

  it('forwards a local command and its allowlist verdict from the pool', async () => {
    const denied: OmpRpcRunLocalCommandResult = { ok: false, errorCode: 'not-allowed' }
    pool.runLocalCommand.mockResolvedValue(denied)
    registerOmpRpcHandlers()

    await expect(
      invoke('ompRpc:runLocalCommand', { cwd: '/work/a', command: '/compact' })
    ).resolves.toEqual(denied)
    expect(pool.runLocalCommand).toHaveBeenCalledWith('/work/a', '/compact')
  })

  it('fails closed on a missing cwd without touching the pool', async () => {
    registerOmpRpcHandlers()
    await expect(invoke('ompRpc:getCommands', { cwd: '   ' })).resolves.toEqual({
      ok: false,
      errorCode: 'executable-not-found'
    })
    await expect(invoke('ompRpc:runLocalCommand', {})).resolves.toEqual({
      ok: false,
      errorCode: 'executable-not-found'
    })
    expect(pool.getCommands).not.toHaveBeenCalled()
    expect(pool.runLocalCommand).not.toHaveBeenCalled()
  })

  it('never throws across IPC when the pool rejects', async () => {
    pool.getCommands.mockRejectedValue(new Error('boom'))
    pool.runLocalCommand.mockRejectedValue(new Error('boom'))
    registerOmpRpcHandlers()

    await expect(invoke('ompRpc:getCommands', { cwd: '/work/a' })).resolves.toEqual({
      ok: false,
      errorCode: 'request-failed'
    })
    await expect(
      invoke('ompRpc:runLocalCommand', { cwd: '/work/a', command: '/usage' })
    ).resolves.toEqual({ ok: false, errorCode: 'request-failed' })
  })

  it('builds the pool lazily, on the first request rather than at registration', async () => {
    pool.getCommands.mockResolvedValue({ ok: true, commands: [] })
    registerOmpRpcHandlers()
    expect(createOmpRpcProbePool).not.toHaveBeenCalled()

    await invoke('ompRpc:getCommands', { cwd: '/work/a' })
    expect(createOmpRpcProbePool).toHaveBeenCalledTimes(1)
  })

  it('resolves the omp binary from PATH, hydrating the login shell PATH only on a miss', async () => {
    pool.getCommands.mockResolvedValue({ ok: true, commands: [] })
    registerOmpRpcHandlers()
    await invoke('ompRpc:getCommands', { cwd: '/work/a' })
    const resolve = (
      createOmpRpcProbePool.mock.calls as unknown as [
        { resolveExecutablePath: (cwd: string) => Promise<string | null> }
      ][]
    )[0][0].resolveExecutablePath

    isCommandOnLocalPath.mockResolvedValueOnce(true)
    await expect(resolve('/work/a')).resolves.toBe('omp')
    expect(hydrateShellPath).not.toHaveBeenCalled()

    // A GUI-launched app can miss ~/.local/bin until the login shell PATH loads.
    isCommandOnLocalPath.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await expect(resolve('/work/a')).resolves.toBe('omp')
    expect(hydrateShellPath).toHaveBeenCalledTimes(1)

    isCommandOnLocalPath.mockResolvedValue(false)
    await expect(resolve('/work/a')).resolves.toBeNull()
  })

  it('shares one pool across workspaces and disposes it on shutdown', async () => {
    pool.getCommands.mockResolvedValue({ ok: true, commands: [] })
    registerOmpRpcHandlers()
    await invoke('ompRpc:getCommands', { cwd: '/work/a' })
    await invoke('ompRpc:getCommands', { cwd: '/work/b' })
    expect(createOmpRpcProbePool).toHaveBeenCalledTimes(1)

    disposeOmpRpcProbes()
    expect(pool.dispose).toHaveBeenCalledTimes(1)
  })
})
