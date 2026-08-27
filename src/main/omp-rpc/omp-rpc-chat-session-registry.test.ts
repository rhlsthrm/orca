import { afterEach, describe, expect, it } from 'vitest'
import type { OmpSessionOwningRpcClient } from '../../shared/omp-rpc-protocol'
import { createFakeOmpRpcChild } from './fake-omp-rpc-child'
import { spawnOmpRpcClient } from './omp-rpc-client'
import { OmpRpcChatSessionRegistry } from './omp-rpc-chat-session-registry'

const clients = new Set<OmpSessionOwningRpcClient>()

function makeRegistry(): OmpRpcChatSessionRegistry {
  return new OmpRpcChatSessionRegistry({
    spawnClient: () => {
      const client = spawnOmpRpcClient(
        createFakeOmpRpcChild(
          {
            sessionState: {
              sessionFile: null,
              sessionId: null,
              isStreaming: false,
              isCompacting: false,
              queuedMessageCount: 0
            }
          },
          'session-owning'
        ).spawnOptions
      ) as unknown as OmpSessionOwningRpcClient
      clients.add(client)
      return client
    }
  })
}

afterEach(() => {
  for (const client of clients) {
    client.dispose()
  }
  clients.clear()
})

describe('OmpRpcChatSessionRegistry', () => {
  it('fails closed with status "live" without spawning when the pty is still running', async () => {
    let spawned = false
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => {
        spawned = true
        throw new Error('must not spawn')
      }
    })
    const result = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      isPtyAlive: () => true
    })
    expect(result.status).toBe('live')
    expect(spawned).toBe(false)
  })

  it('fails closed with "unverifiable" when pty liveness cannot be determined', async () => {
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => {
        throw new Error('must not spawn')
      }
    })
    const result = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      isPtyAlive: () => null
    })
    expect(result.status).toBe('unverifiable')
  })

  it('acquires an RPC session once the pty is confirmed exited', async () => {
    const registry = makeRegistry()
    const result = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(result.status).toBe('acquired')
    if (result.status === 'acquired') {
      expect(registry.get('tab:leaf')).toBe(result.session)
    }
  })

  it('returns the same session on a repeated acquire for the same pane', async () => {
    const registry = makeRegistry()
    const first = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    const second = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(first.status).toBe('acquired')
    expect(second.status).toBe('acquired')
    if (first.status === 'acquired' && second.status === 'acquired') {
      expect(second.session).toBe(first.session)
    }
  })

  it('releases a session and frees the pane for a fresh acquisition', async () => {
    const registry = makeRegistry()
    const acquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(acquired.status).toBe('acquired')

    const released = await registry.release('tab:leaf')
    expect(released.released).toBe(true)
    expect(registry.get('tab:leaf')).toBeNull()

    const reacquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(reacquired.status).toBe('acquired')
  })

  it('releasing an unknown pane is a no-op', async () => {
    const registry = makeRegistry()
    await expect(registry.release('unknown:pane')).resolves.toEqual({ released: false })
  })

  it('reports spawn failure without acquiring when the child cannot start', async () => {
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => {
        throw new Error('spawn exploded')
      }
    })
    const result = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'does-not-exist',
      sessionFile: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(result.status).toBe('spawn-failed')
  })
})
