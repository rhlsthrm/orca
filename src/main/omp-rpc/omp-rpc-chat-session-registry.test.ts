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
              // Why: a real OMP RPC child always reports a sessionId once
              // acquired (Decision 2 in docs/omp-rpc-chat-adapter-plan.md —
              // it is the claim identity) — this fixture is left non-null
              // so `release()` genuinely reaches handoffToPty's 'exited'
              // path instead of short-circuiting on 'ownership-unknown'
              // (a wrong-shaped fixture would silently mask that path).
              sessionId: 'session-a',
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

  // Critical B (cross-lab review, wave 5): a release whose turn never
  // settles must fail closed — keep the session registered and never
  // dispose/force-release the claim out from under still-streaming work
  // (the OLD code unconditionally disposed and returned `released: true`
  // here regardless of what handoffToPty reported).
  it('fails closed and keeps the session when the turn never settles (Critical B)', async () => {
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => {
        const client = spawnOmpRpcClient(
          createFakeOmpRpcChild(
            {
              sessionState: {
                sessionFile: null,
                sessionId: 'session-a',
                isStreaming: true,
                isCompacting: false,
                queuedMessageCount: 0
              }
            },
            'session-owning'
          ).spawnOptions
        ) as unknown as OmpSessionOwningRpcClient
        clients.add(client)
        return client
      },
      waitForSettle: async () => ({
        status: 'unverifiable',
        reason: 'OMP RPC session did not settle before timeout'
      })
    })
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

    expect(released).toEqual({ released: false })
    expect(registry.get('tab:leaf')).not.toBeNull()
  })

  // Wave 9, Defect 2, acceptance criteria 3 & 4: the exclusion set for the
  // mtime fallback must consider only claims held by panes OTHER than the
  // asking pane — the asking pane's own claim must never be held against
  // it, while a genuinely different pane's claim must still be excluded.
  describe('claimedSessionFilePathsExcluding', () => {
    it("excludes only OTHER panes' claims, never the asking pane's own", async () => {
      const registry = makeRegistry()
      await registry.acquire({
        paneKey: 'tab:leaf-a',
        ptyId: 'pty-a',
        cwd: '/work',
        executablePath: 'omp',
        sessionFile: '/sessions/a.jsonl',
        sessionFilePath: '/sessions/a.jsonl',
        isPtyAlive: () => false
      })
      await registry.acquire({
        paneKey: 'tab:leaf-b',
        ptyId: 'pty-b',
        cwd: '/work',
        executablePath: 'omp',
        sessionFile: '/sessions/b.jsonl',
        sessionFilePath: '/sessions/b.jsonl',
        isPtyAlive: () => false
      })

      // Pane A re-resolving its own identity: its own claim must not be in
      // the exclusion set, but pane B's must (finding C intact).
      expect(registry.claimedSessionFilePathsExcluding('tab:leaf-a')).toEqual(
        new Set(['/sessions/b.jsonl'])
      )
      // Pane B symmetrically excludes only A's claim.
      expect(registry.claimedSessionFilePathsExcluding('tab:leaf-b')).toEqual(
        new Set(['/sessions/a.jsonl'])
      )
      // A pane with no claim of its own (e.g. a fresh third pane sharing
      // the cwd bucket) still sees every currently-claimed path excluded.
      expect(registry.claimedSessionFilePathsExcluding('tab:leaf-c')).toEqual(
        new Set(['/sessions/a.jsonl', '/sessions/b.jsonl'])
      )
    })

    it("drops a pane's exclusion entry once it releases (no leak, none to 'fix')", async () => {
      const registry = makeRegistry()
      await registry.acquire({
        paneKey: 'tab:leaf-a',
        ptyId: 'pty-a',
        cwd: '/work',
        executablePath: 'omp',
        sessionFile: '/sessions/a.jsonl',
        sessionFilePath: '/sessions/a.jsonl',
        isPtyAlive: () => false
      })
      await registry.release('tab:leaf-a')
      expect(registry.claimedSessionFilePathsExcluding('tab:leaf-b')).toEqual(new Set())
    })
  })
})
