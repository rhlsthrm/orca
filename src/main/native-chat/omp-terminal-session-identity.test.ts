import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  encodeOmpSessionCwdBucket,
  parseOmpSessionIdFromFilename,
  resolveOmpPaneSessionIdentity,
  terminalIdFromSlavePath
} from './omp-terminal-session-identity'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

describe('terminalIdFromSlavePath', () => {
  it('takes the basename of a posix slave device path', () => {
    expect(terminalIdFromSlavePath('/dev/ttys021')).toBe('ttys021')
  })

  it('returns null for an empty path', () => {
    expect(terminalIdFromSlavePath('')).toBeNull()
  })
})

describe('parseOmpSessionIdFromFilename', () => {
  it('splits at the first underscore after the timestamp', () => {
    expect(
      parseOmpSessionIdFromFilename(
        '/root/-dev-orca/2026-08-12T00-30-36-053Z_019ff360-d015-7000-b307-561e7306dc73.jsonl'
      )
    ).toBe('019ff360-d015-7000-b307-561e7306dc73')
  })

  it('returns null when there is no underscore delimiter', () => {
    expect(parseOmpSessionIdFromFilename('/root/-dev-orca/nodelimiter.jsonl')).toBeNull()
  })
})

describe('encodeOmpSessionCwdBucket', () => {
  it('encodes a home-relative cwd with a single leading dash', () => {
    const bucket = encodeOmpSessionCwdBucket('/Users/ada/dev/projects/orca', {
      homeDir: '/Users/ada',
      tempDir: '/tmp'
    })
    expect(bucket).toBe('-dev-projects-orca')
  })

  it('encodes a temp-root cwd with the -tmp- prefix', () => {
    const bucket = encodeOmpSessionCwdBucket('/tmp/scratch/work', {
      homeDir: '/Users/ada',
      tempDir: '/tmp'
    })
    expect(bucket).toBe('-tmp-scratch-work')
  })

  it('wraps an otherwise-unrelated absolute cwd in double dashes', () => {
    const bucket = encodeOmpSessionCwdBucket('/opt/foo/bar', {
      homeDir: '/Users/ada',
      tempDir: '/tmp'
    })
    expect(bucket).toBe('--opt-foo-bar--')
  })
})

describe('resolveOmpPaneSessionIdentity', () => {
  it('resolves via a materialized breadcrumb whose cwd matches the pane', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-breadcrumb-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const bucketDir = join(root, 'sessions', '-work')
    await mkdir(bucketDir, { recursive: true })
    const sessionFile = join(bucketDir, '2026-08-12T00-30-36-053Z_session-a.jsonl')
    await writeFile(sessionFile, '{}\n')
    await mkdir(join(root, 'terminal-sessions'), { recursive: true })
    await writeFile(join(root, 'terminal-sessions', 'ttys000'), `${cwd}\n${sessionFile}\n`)

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: 'pty-1', cwd },
      {
        agentDir: root,
        homeDir: root,
        tempDir: join(root, 'no-tmp'),
        getSlavePath: () => '/dev/ttys000'
      }
    )

    expect(resolved).toEqual({
      sessionId: 'session-a',
      sessionFilePath: sessionFile,
      source: 'breadcrumb'
    })
  })

  it('ignores a breadcrumb recorded for a different cwd (stale tty reuse) and falls back to mtime', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-stale-breadcrumb-')
    const cwd = join(root, 'work')
    const otherCwd = join(root, 'other')
    await mkdir(cwd, { recursive: true })
    await mkdir(otherCwd, { recursive: true })
    const staleSessionFile = join(root, 'sessions', '-other', 'stale.jsonl')
    await mkdir(join(root, 'sessions', '-other'), { recursive: true })
    await writeFile(staleSessionFile, '{}\n')
    const bucketDir = join(root, 'sessions', '-work')
    await mkdir(bucketDir, { recursive: true })
    const realSessionFile = join(bucketDir, '2026-08-12T00-30-36-053Z_session-real.jsonl')
    await writeFile(realSessionFile, '{}\n')
    await mkdir(join(root, 'terminal-sessions'), { recursive: true })
    // Breadcrumb still names the OTHER cwd/session — a leftover from a previous
    // process that used the same tty slot.
    await writeFile(
      join(root, 'terminal-sessions', 'ttys000'),
      `${otherCwd}\n${staleSessionFile}\n`
    )

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: 'pty-1', cwd },
      {
        agentDir: root,
        homeDir: root,
        tempDir: join(root, 'no-tmp'),
        getSlavePath: () => '/dev/ttys000'
      }
    )

    expect(resolved).toEqual({
      sessionId: 'session-real',
      sessionFilePath: realSessionFile,
      source: 'mtime-fallback'
    })
  })

  it('returns null (never falls back) for a missing-but-fresh breadcrumb', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-fresh-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const bucketDir = join(root, 'sessions', '-work')
    await mkdir(bucketDir, { recursive: true })
    // A prior session exists in the bucket, but the fresh boundary must win —
    // resurrecting it would silently undo the user's own `/new`.
    await writeFile(join(bucketDir, '2026-08-12T00-30-36-053Z_prior.jsonl'), '{}\n')
    await mkdir(join(root, 'terminal-sessions'), { recursive: true })
    await writeFile(join(root, 'terminal-sessions', 'ttys000'), `${cwd}\n\nfresh\n`)

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: 'pty-1', cwd },
      {
        agentDir: root,
        homeDir: root,
        tempDir: join(root, 'no-tmp'),
        getSlavePath: () => '/dev/ttys000'
      }
    )

    expect(resolved).toBeNull()
  })

  it('falls back to the newest session by mtime when there is no breadcrumb at all', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-mtime-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const bucketDir = join(root, 'sessions', '-work')
    await mkdir(bucketDir, { recursive: true })
    const older = join(bucketDir, '2026-08-11T00-00-00-000Z_older.jsonl')
    const newer = join(bucketDir, '2026-08-12T00-00-00-000Z_newer.jsonl')
    await writeFile(older, '{}\n')
    await writeFile(newer, '{}\n')
    // Why explicit utimes instead of a real sleep: mtime ordering is the
    // behavior under test, so set it deterministically rather than racing
    // the filesystem clock's resolution.
    await utimes(older, new Date('2026-08-11T00:00:00Z'), new Date('2026-08-11T00:00:00Z'))
    await utimes(newer, new Date('2026-08-12T00:00:00Z'), new Date('2026-08-12T00:00:00Z'))

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: 'pty-1', cwd },
      {
        agentDir: root,
        homeDir: root,
        tempDir: join(root, 'no-tmp'),
        getSlavePath: () => undefined
      }
    )

    expect(resolved).toEqual({
      sessionId: 'newer',
      sessionFilePath: newer,
      source: 'mtime-fallback'
    })
  })

  it('returns null when nothing exists in the bucket (never invents a path)', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-empty-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: 'pty-1', cwd },
      {
        agentDir: root,
        homeDir: root,
        tempDir: join(root, 'no-tmp'),
        getSlavePath: () => undefined
      }
    )

    expect(resolved).toBeNull()
  })

  it('falls through to mtime fallback when the terminal id cannot be determined', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-no-tty-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const bucketDir = join(root, 'sessions', '-work')
    await mkdir(bucketDir, { recursive: true })
    const target = join(bucketDir, '2026-08-12T00-00-00-000Z_only.jsonl')
    await writeFile(target, '{}\n')

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: 'pty-1', cwd },
      { agentDir: root, homeDir: root, tempDir: join(root, 'no-tmp'), getSlavePath: undefined }
    )

    expect(resolved).toEqual({
      sessionId: 'only',
      sessionFilePath: target,
      source: 'mtime-fallback'
    })
  })
})
