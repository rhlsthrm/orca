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
      sessionFilePath: '/sessions/a.jsonl',
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
      sessionFilePath: '/sessions/a.jsonl',
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
      sessionFilePath: '/sessions/a.jsonl',
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
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    const second = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
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
      sessionFilePath: '/sessions/a.jsonl',
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
      sessionFilePath: '/sessions/a.jsonl',
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
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(result.status).toBe('spawn-failed')
  })

  // F4 (HIGH): app quit must kill every RPC child and release its claim, not
  // just tear down local listeners — otherwise a quit mid-turn orphans the
  // child and a relaunched PTY resume becomes a second writer on the session.
  it('disposeAll kills every RPC child and releases its claim so the identity can be re-acquired (F4)', async () => {
    const registry = makeRegistry()
    const acquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(acquired.status).toBe('acquired')

    registry.disposeAll()
    expect(registry.get('tab:leaf')).toBeNull()

    // The claim must be released too — a fresh acquire for the same identity
    // must succeed outright, not conflict with the disposed session's claim.
    const reacquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(reacquired.status).toBe('acquired')
  })

  // F5 (HIGH): release deletes the pane entry synchronously but holds the
  // claim until its handoff settles — acquire must wait for any in-flight
  // release for the same pane instead of racing it into a spurious conflict.
  it('acquire waits for an in-flight release before re-acquiring the same pane (F5)', async () => {
    const registry = makeRegistry()
    const acquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(acquired.status).toBe('acquired')

    const releasePromise = registry.release('tab:leaf')
    const reacquirePromise = registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    const [releaseResult, reacquireResult] = await Promise.all([releasePromise, reacquirePromise])
    expect(releaseResult.released).toBe(true)
    expect(reacquireResult.status).toBe('acquired')
  })

  // F5: React StrictMode double-mounts fire two concurrent acquires for the
  // same identity — the second must reuse the first's in-flight result
  // instead of racing a second spawn into `agent_session_conflict`.
  it('reuses an in-flight acquire for the same identity instead of double-spawning (F5)', async () => {
    const registry = makeRegistry()
    const args = {
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    }
    const [first, second] = await Promise.all([registry.acquire(args), registry.acquire(args)])
    expect(first.status).toBe('acquired')
    expect(second.status).toBe('acquired')
    if (first.status === 'acquired' && second.status === 'acquired') {
      expect(second.session).toBe(first.session)
    }
  })

  // F5 (cross-lab HIGH_2): a slower acquire for an identity that was rebound
  // mid-flight (not just released) must lose to the newer one — dispose
  // itself and never overwrite the paneKey's newer session.
  it('a stale acquire for a superseded identity disposes itself and never overwrites the newer session (F5)', async () => {
    const registry = makeRegistry()
    const stalePromise = registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    const freshPromise = registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/b.jsonl',
      sessionFilePath: '/sessions/b.jsonl',
      isPtyAlive: () => false
    })
    const [stale, fresh] = await Promise.all([stalePromise, freshPromise])
    expect(stale.status).toBe('conflict')
    expect(fresh.status).toBe('acquired')
    if (fresh.status === 'acquired') {
      expect(registry.get('tab:leaf')).toBe(fresh.session)
    }
  })

  // F10 (LOW): the dead resume-launch fields must be gone — release's result
  // is exactly `{released}`, nothing a future reader could mistake for a
  // wired PTY-resume path.
  it('release result carries only released, dropping the dead resume-launch fields (F10)', async () => {
    const registry = makeRegistry()
    await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    const released = await registry.release('tab:leaf')
    expect(Object.keys(released)).toEqual(['released'])
  })
})
