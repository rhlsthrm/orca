import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { OmpRpcChatEventPayload } from '../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcClientEvent } from '../../shared/omp-rpc-protocol'

const {
  handle,
  on,
  appOnce,
  registryInstance,
  RegistryCtor,
  resolveOmpExecutablePath,
  resolveSessionFilePath
} = vi.hoisted(() => {
  const registryInstance = {
    acquire: vi.fn(),
    release: vi.fn(),
    get: vi.fn(),
    disposeAll: vi.fn()
  }
  return {
    handle: vi.fn(),
    on: vi.fn(),
    appOnce: vi.fn(),
    registryInstance,
    RegistryCtor: vi.fn(function OmpRpcChatSessionRegistry() {
      return registryInstance
    }),
    resolveOmpExecutablePath: vi.fn(),
    resolveSessionFilePath: vi.fn()
  }
})

vi.mock('electron', () => ({ ipcMain: { handle, on }, app: { once: appOnce } }))
vi.mock('../omp-rpc/omp-rpc-chat-session-registry', () => ({
  OmpRpcChatSessionRegistry: RegistryCtor
}))
vi.mock('./omp-rpc', () => ({ resolveOmpExecutablePath }))
vi.mock('../native-chat/session-file-resolver', () => ({ resolveSessionFilePath }))

import { clearOmpRpcChatHandlersForTests, registerOmpRpcChatHandlers } from './omp-rpc-chat'

function invoke(channel: string, args?: unknown): Promise<unknown> {
  const handler = handle.mock.calls.find(([name]) => name === channel)?.[1] as (
    event: unknown,
    args?: unknown
  ) => Promise<unknown>
  return handler({}, args)
}

function fireOn(channel: string, event: unknown, args?: unknown): void {
  const handler = on.mock.calls.find(([name]) => name === channel)?.[1] as (
    event: unknown,
    args?: unknown
  ) => void
  handler(event, args)
}

describe('OMP RPC chat IPC handlers', () => {
  beforeEach(() => {
    clearOmpRpcChatHandlersForTests()
    vi.clearAllMocks()
    resolveOmpExecutablePath.mockResolvedValue('/usr/local/bin/omp')
    resolveSessionFilePath.mockResolvedValue('/sessions/a.jsonl')
  })

  it('registers acquire/release/send/abort/respond and the subscribe push channels', () => {
    registerOmpRpcChatHandlers()
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual([
      'ompRpcChat:acquire',
      'ompRpcChat:release',
      'ompRpcChat:send',
      'ompRpcChat:abort',
      'ompRpcChat:respondExtensionUi'
    ])
    expect(on.mock.calls.map(([channel]) => channel)).toEqual([
      'ompRpcChat:subscribe',
      'ompRpcChat:unsubscribe'
    ])
    expect(appOnce).toHaveBeenCalledWith('will-quit', expect.any(Function))
  })

  it('fails closed with executable-not-found when omp cannot be resolved', async () => {
    resolveOmpExecutablePath.mockResolvedValue(null)
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:acquire', {
        paneKey: 'tab:leaf',
        ptyId: 'pty-1',
        cwd: '/work',
        sessionFile: '/sessions/a.jsonl'
      })
    ).resolves.toEqual({ ok: false, reason: 'executable-not-found' })
    expect(registryInstance.acquire).not.toHaveBeenCalled()
  })

  it('fails closed on missing required args without resolving the executable', async () => {
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:acquire', { paneKey: '', ptyId: '', cwd: '', sessionFile: '' })
    ).resolves.toEqual({ ok: false, reason: 'spawn-failed' })
    expect(resolveOmpExecutablePath).not.toHaveBeenCalled()
  })

  it('maps a successful acquisition to ok:true', async () => {
    registryInstance.acquire.mockResolvedValue({ status: 'acquired', session: {} })
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:acquire', {
        paneKey: 'tab:leaf',
        ptyId: 'pty-1',
        cwd: '/work',
        sessionFile: 'session-id-1'
      })
    ).resolves.toEqual({ ok: true })
    expect(resolveSessionFilePath).toHaveBeenCalledWith('omp', 'session-id-1')
    expect(registryInstance.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: 'tab:leaf',
        ptyId: 'pty-1',
        executablePath: '/usr/local/bin/omp',
        sessionFile: 'session-id-1',
        sessionFilePath: '/sessions/a.jsonl'
      })
    )
  })

  // F12: switch_session requires the resolved absolute path, not the bare id
  // — acquisition must fail closed rather than pass the id through unresolved.
  it('fails closed when the bare session id cannot be resolved to a file path', async () => {
    resolveSessionFilePath.mockResolvedValue(null)
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:acquire', {
        paneKey: 'tab:leaf',
        ptyId: 'pty-1',
        cwd: '/work',
        sessionFile: 'session-id-1'
      })
    ).resolves.toEqual({ ok: false, reason: 'spawn-failed' })
    expect(registryInstance.acquire).not.toHaveBeenCalled()
  })

  it('maps a live-pty refusal to ok:false reason "live"', async () => {
    registryInstance.acquire.mockResolvedValue({ status: 'live' })
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:acquire', {
        paneKey: 'tab:leaf',
        ptyId: 'pty-1',
        cwd: '/work',
        sessionFile: '/sessions/a.jsonl'
      })
    ).resolves.toEqual({ ok: false, reason: 'live' })
  })

  it('routes send/abort/respondExtensionUi to the pane session, failing closed when unacquired', async () => {
    registerOmpRpcChatHandlers()
    registryInstance.get.mockReturnValue(null)
    await expect(
      invoke('ompRpcChat:send', { paneKey: 'tab:leaf', message: 'hi', behavior: 'idle' })
    ).resolves.toEqual({ ok: false, reason: expect.any(String) })
    await expect(invoke('ompRpcChat:abort', { paneKey: 'tab:leaf' })).resolves.toEqual({
      ok: false,
      reason: expect.any(String)
    })
    await expect(
      invoke('ompRpcChat:respondExtensionUi', {
        paneKey: 'tab:leaf',
        response: { type: 'extension_ui_response', id: 'x', confirmed: true }
      })
    ).resolves.toBe(false)

    const session = {
      send: vi.fn().mockResolvedValue({ ok: true, agentInvoked: true }),
      abort: vi.fn().mockResolvedValue({ ok: true, agentInvoked: true }),
      respondExtensionUi: vi.fn().mockReturnValue(true)
    }
    registryInstance.get.mockReturnValue(session)
    await expect(
      invoke('ompRpcChat:send', { paneKey: 'tab:leaf', message: 'hi', behavior: 'steer' })
    ).resolves.toEqual({ ok: true, agentInvoked: true })
    expect(session.send).toHaveBeenCalledWith({
      message: 'hi',
      images: undefined,
      behavior: 'steer'
    })
    await expect(invoke('ompRpcChat:abort', { paneKey: 'tab:leaf' })).resolves.toEqual({
      ok: true,
      agentInvoked: true
    })
    await expect(
      invoke('ompRpcChat:respondExtensionUi', {
        paneKey: 'tab:leaf',
        response: { type: 'extension_ui_response', id: 'x', confirmed: true }
      })
    ).resolves.toBe(true)
  })

  it('releases and reports the registry result', async () => {
    registryInstance.release.mockResolvedValue({ released: true })
    registerOmpRpcChatHandlers()
    await expect(invoke('ompRpcChat:release', { paneKey: 'tab:leaf' })).resolves.toEqual({
      released: true
    })
    expect(registryInstance.release).toHaveBeenCalledWith('tab:leaf')
  })

  it('forwards session events to the subscribing sender only for its subscriptionId', () => {
    const emittedListeners: ((event: OmpRpcClientEvent) => void)[] = []
    const session = {
      on: vi.fn((listener: (event: OmpRpcClientEvent) => void) => {
        emittedListeners.push(listener)
        return vi.fn()
      })
    }
    registryInstance.get.mockReturnValue(session)
    registerOmpRpcChatHandlers()
    const send = vi.fn()
    const sender = { id: 7, isDestroyed: () => false, send, once: vi.fn() }
    fireOn('ompRpcChat:subscribe', { sender }, { paneKey: 'tab:leaf', subscriptionId: 'sub-1' })
    expect(emittedListeners).toHaveLength(1)

    const event: OmpRpcClientEvent = { kind: 'agent-start', frame: { type: 'agent_start' } }
    emittedListeners[0](event)
    expect(send).toHaveBeenCalledWith('ompRpcChat:event', {
      subscriptionId: 'sub-1',
      event
    } satisfies OmpRpcChatEventPayload)
  })

  it('unsubscribes cleanly and tears down all subscriptions when the sender is destroyed', () => {
    const unsubscribe = vi.fn()
    const session = { on: vi.fn(() => unsubscribe) }
    registryInstance.get.mockReturnValue(session)
    registerOmpRpcChatHandlers()
    let destroyedHandler: (() => void) | undefined
    const sender = {
      id: 9,
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn((eventName: string, handler: () => void) => {
        if (eventName === 'destroyed') {
          destroyedHandler = handler
        }
      })
    }
    fireOn('ompRpcChat:subscribe', { sender }, { paneKey: 'tab:leaf', subscriptionId: 'sub-1' })
    fireOn('ompRpcChat:unsubscribe', { sender }, { subscriptionId: 'sub-1' })
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    fireOn('ompRpcChat:subscribe', { sender }, { paneKey: 'tab:leaf', subscriptionId: 'sub-2' })
    destroyedHandler?.()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })

  it('no-ops a subscribe for a pane with no acquired session', () => {
    registryInstance.get.mockReturnValue(null)
    registerOmpRpcChatHandlers()
    const send = vi.fn()
    const sender = { id: 3, isDestroyed: () => false, send, once: vi.fn() }
    expect(() =>
      fireOn('ompRpcChat:subscribe', { sender }, { paneKey: 'tab:leaf', subscriptionId: 'sub-1' })
    ).not.toThrow()
    expect(send).not.toHaveBeenCalled()
  })
})
