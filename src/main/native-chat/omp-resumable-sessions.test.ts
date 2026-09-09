import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { listOmpResumableSessions } from './omp-resumable-sessions'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

/** A pane rooted at `<root>/work`, whose sessions live in the `-work` bucket
 *  under an agent dir this test owns. */
async function makeBucket(): Promise<{ root: string; cwd: string; bucketDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-omp-resumable-'))
  tempRoots.push(root)
  const cwd = join(root, 'work')
  const bucketDir = join(root, 'sessions', '-work')
  await mkdir(cwd, { recursive: true })
  await mkdir(bucketDir, { recursive: true })
  return { root, cwd, bucketDir }
}

/** Writes the two header records OMP itself writes: the fixed-width title slot
 *  followed by the `session` record. */
async function writeSession(
  bucketDir: string,
  fileName: string,
  header: { id: string; title?: string; timestamp?: string; mtimeSeconds?: number }
): Promise<string> {
  const path = join(bucketDir, fileName)
  const lines = [
    JSON.stringify({ type: 'title', v: 1, title: header.title ?? '', pad: ' '.repeat(64) }),
    JSON.stringify({
      type: 'session',
      version: 3,
      id: header.id,
      timestamp: header.timestamp ?? '2026-08-04T22:12:41.139Z',
      cwd: '/work'
    }),
    JSON.stringify({ type: 'message', message: { role: 'user' } })
  ]
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  if (header.mtimeSeconds !== undefined) {
    await utimes(path, header.mtimeSeconds, header.mtimeSeconds)
  }
  return path
}

function agentDirOptions(root: string): { agentDir: string; homeDir: string; tempDir: string } {
  return { agentDir: root, homeDir: root, tempDir: join(root, 'no-tmp') }
}

describe('listOmpResumableSessions', () => {
  it('offers only sessions that exist on disk, newest-modified first', async () => {
    const { root, cwd, bucketDir } = await makeBucket()
    const older = await writeSession(bucketDir, '2026-08-01T00-00-00-000Z_older.jsonl', {
      id: 'older',
      mtimeSeconds: 1_000
    })
    const newer = await writeSession(bucketDir, '2026-08-02T00-00-00-000Z_newer.jsonl', {
      id: 'newer',
      mtimeSeconds: 2_000
    })
    // A name OMP's id parser rejects, an artifacts directory, and a stray
    // non-transcript file all share the bucket with real sessions.
    await writeFile(join(bucketDir, 'nodelimiter.jsonl'), '{}\n', 'utf8')
    await writeFile(join(bucketDir, '2026-08-03T00-00-00-000Z_notes.txt'), 'x', 'utf8')
    await mkdir(join(bucketDir, '2026-08-02T00-00-00-000Z_newer'), { recursive: true })

    const sessions = await listOmpResumableSessions({ cwd }, agentDirOptions(root))

    expect(sessions.map((session) => session.sessionPath)).toEqual([newer, older])
  })

  it('withholds a session another pane already claims', async () => {
    const { root, cwd, bucketDir } = await makeBucket()
    const claimed = await writeSession(bucketDir, '2026-08-02T00-00-00-000Z_claimed.jsonl', {
      id: 'claimed',
      mtimeSeconds: 2_000
    })
    const free = await writeSession(bucketDir, '2026-08-01T00-00-00-000Z_free.jsonl', {
      id: 'free',
      mtimeSeconds: 1_000
    })

    const sessions = await listOmpResumableSessions(
      { cwd },
      { ...agentDirOptions(root), claimedSessionFilePaths: new Set([claimed]) }
    )

    expect(sessions.map((session) => session.sessionPath)).toEqual([free])
  })

  it('marks the pane it is asked for as the current session, and only that one', async () => {
    const { root, cwd, bucketDir } = await makeBucket()
    await writeSession(bucketDir, '2026-08-01T00-00-00-000Z_mine.jsonl', {
      id: 'mine',
      mtimeSeconds: 1_000
    })
    await writeSession(bucketDir, '2026-08-02T00-00-00-000Z_theirs.jsonl', {
      id: 'theirs',
      mtimeSeconds: 2_000
    })

    const sessions = await listOmpResumableSessions(
      { cwd, currentSessionId: 'mine' },
      agentDirOptions(root)
    )

    expect(
      sessions.map((session) => ({ id: session.sessionId, current: session.isCurrent }))
    ).toEqual([
      { id: 'theirs', current: false },
      { id: 'mine', current: true }
    ])
  })

  it("reports a session's own title and start timestamp, and omits a blank title", async () => {
    const { root, cwd, bucketDir } = await makeBucket()
    await writeSession(bucketDir, '2026-08-02T00-00-00-000Z_named.jsonl', {
      id: 'named',
      title: 'Wire up the adapter',
      timestamp: '2026-08-02T10-00-00-000Z',
      mtimeSeconds: 2_000
    })
    await writeSession(bucketDir, '2026-08-01T00-00-00-000Z_blank.jsonl', {
      id: 'blank',
      title: '   ',
      mtimeSeconds: 1_000
    })

    const sessions = await listOmpResumableSessions({ cwd }, agentDirOptions(root))

    expect(sessions.map((session) => session.name)).toEqual(['Wire up the adapter', undefined])
    expect(sessions[0].startedAt).toBe('2026-08-02T10-00-00-000Z')
  })

  it('lets a blank title slot suppress a stale name still in the session record', async () => {
    // OMP's own listing treats a present-but-blank title slot as an explicit
    // "no title" that OVERRIDES the session record (`normalizeTitleOverride`
    // returns null, session-listing.ts:315-318/352-361). Falling through to
    // the record instead would resurrect a name the user cleared.
    const { root, cwd, bucketDir } = await makeBucket()
    const path = join(bucketDir, '2026-08-01T00-00-00-000Z_cleared.jsonl')
    await writeFile(
      path,
      `${JSON.stringify({ type: 'title', v: 1, title: '  ' })}\n${JSON.stringify({
        type: 'session',
        id: 'cleared',
        title: 'the name the user cleared'
      })}\n`,
      'utf8'
    )

    const sessions = await listOmpResumableSessions({ cwd }, agentDirOptions(root))

    expect(sessions.map((session) => session.name)).toEqual([undefined])
  })

  it('falls back to the session record title when there is no title slot', async () => {
    const { root, cwd, bucketDir } = await makeBucket()
    const path = join(bucketDir, '2026-08-01T00-00-00-000Z_recorded.jsonl')
    await writeFile(
      path,
      `${JSON.stringify({ type: 'session', id: 'recorded', title: 'From the record' })}\n`,
      'utf8'
    )

    const sessions = await listOmpResumableSessions({ cwd }, agentDirOptions(root))

    expect(sessions.map((session) => session.name)).toEqual(['From the record'])
  })

  it('reports no sessions for a cwd bucket that does not exist', async () => {
    const { root } = await makeBucket()

    await expect(
      listOmpResumableSessions({ cwd: join(root, 'never-used') }, agentDirOptions(root))
    ).resolves.toEqual([])
  })
})
