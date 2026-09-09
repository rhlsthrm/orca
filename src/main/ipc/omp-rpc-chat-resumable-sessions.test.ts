import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  OMP_RPC_CHAT_NO_OWNED_SESSION_REASON,
  type OmpRpcChatCommandResult,
  type OmpRpcChatResumableSession
} from '../../shared/omp-rpc-chat-ipc-contract'

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }))

vi.mock('electron', () => ({ ipcMain: { handle } }))

import { registerOmpRpcChatResumableSessionHandlers } from './omp-rpc-chat-resumable-sessions'

let tempRoots: string[] = []

beforeEach(() => {
  handle.mockReset()
})

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function writeSession(
  bucketDir: string,
  fileName: string,
  id: string,
  mtimeSeconds: number
): Promise<string> {
  const path = join(bucketDir, fileName)
  await writeFile(path, `${JSON.stringify({ type: 'session', id })}\n`, 'utf8')
  await utimes(path, mtimeSeconds, mtimeSeconds)
  return path
}

/** A pane whose OMP sessions live in a bucket this test owns. `OMP_CODING_AGENT_DIR`
 *  is the same override the resolver itself honors, and the handler passes no
 *  agent-dir option of its own — so pointing it here is what makes this an
 *  end-to-end test of the real enumerator rather than a mocked one. */
async function makePaneBucket(): Promise<{ cwd: string; bucketDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-omp-resume-ipc-'))
  tempRoots.push(root)
  vi.stubEnv('OMP_CODING_AGENT_DIR', root)
  vi.stubEnv('HOME', root)
  const cwd = join(root, 'work')
  const bucketDir = join(root, 'sessions', '-work')
  await mkdir(cwd, { recursive: true })
  await mkdir(bucketDir, { recursive: true })
  return { cwd, bucketDir }
}

type Registry = {
  getSessionFile: (paneKey: string) => string | null
  claimedSessionFilePathsExcluding: (paneKey: string) => ReadonlySet<string>
}

function invokeList(args: unknown): Promise<OmpRpcChatCommandResult<OmpRpcChatResumableSession[]>> {
  const registered = handle.mock.calls.find(
    ([channel]) => channel === 'ompRpcChat:listResumableSessions'
  )
  if (!registered) {
    throw new Error('ompRpcChat:listResumableSessions was never registered')
  }
  return registered[1]({}, args)
}

describe('ompRpcChat:listResumableSessions', () => {
  it('refuses a pane the registry does not hold, without reading any disk', async () => {
    const { cwd } = await makePaneBucket()
    const getSessionFile = vi.fn<Registry['getSessionFile']>(() => null)
    const claimedSessionFilePathsExcluding = vi.fn<Registry['claimedSessionFilePathsExcluding']>(
      () => new Set<string>()
    )
    registerOmpRpcChatResumableSessionHandlers(() => ({
      getSessionFile,
      claimedSessionFilePathsExcluding
    }))

    await expect(invokeList({ paneKey: 'tab-1:leaf-1', cwd })).resolves.toEqual({
      ok: false,
      reason: OMP_RPC_CHAT_NO_OWNED_SESSION_REASON
    })
    // The pane is unauthorized, so nothing about its cwd bucket was consulted.
    expect(claimedSessionFilePathsExcluding).not.toHaveBeenCalled()
  })

  it('lists this bucket newest-first, withholds another pane\u2019s claim, and marks the pane\u2019s own session', async () => {
    const { cwd, bucketDir } = await makePaneBucket()
    const mine = await writeSession(bucketDir, '2026-08-01T00-00-00-000Z_mine.jsonl', 'mine', 1_000)
    const other = await writeSession(
      bucketDir,
      '2026-08-03T00-00-00-000Z_other.jsonl',
      'other',
      3_000
    )
    const free = await writeSession(bucketDir, '2026-08-02T00-00-00-000Z_free.jsonl', 'free', 2_000)
    registerOmpRpcChatResumableSessionHandlers(() => ({
      getSessionFile: (paneKey) => (paneKey === 'tab-1:leaf-1' ? 'mine' : null),
      // What the real registry answers: the claim held by ANOTHER pane, never
      // the asking pane's own.
      claimedSessionFilePathsExcluding: () => new Set([other])
    }))

    const result = await invokeList({ paneKey: 'tab-1:leaf-1', cwd })

    expect(result.ok).toBe(true)
    expect(result.ok ? result.data : []).toEqual([
      expect.objectContaining({ sessionId: 'free', sessionPath: free, isCurrent: false }),
      expect.objectContaining({ sessionId: 'mine', sessionPath: mine, isCurrent: true })
    ])
  })

  it('answers ok:false rather than throwing when the pane key or cwd is missing', async () => {
    registerOmpRpcChatResumableSessionHandlers(() => ({
      getSessionFile: () => 'mine',
      claimedSessionFilePathsExcluding: () => new Set<string>()
    }))

    await expect(invokeList({ paneKey: '   ', cwd: '/work' })).resolves.toMatchObject({
      ok: false
    })
    await expect(invokeList({ paneKey: 'tab-1:leaf-1' })).resolves.toMatchObject({ ok: false })
  })

  it('answers ok:false rather than rejecting when the registry lookup throws', async () => {
    const { cwd } = await makePaneBucket()
    registerOmpRpcChatResumableSessionHandlers(() => ({
      getSessionFile: () => 'mine',
      claimedSessionFilePathsExcluding: () => {
        throw new Error('registry unavailable')
      }
    }))

    await expect(invokeList({ paneKey: 'tab-1:leaf-1', cwd })).resolves.toEqual({
      ok: false,
      reason: 'registry unavailable'
    })
  })
})
