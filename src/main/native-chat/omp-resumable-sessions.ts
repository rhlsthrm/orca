// Enumerates the sessions a pane could resume, from OMP's own on-disk layout.
//
// This is the list half of omp-terminal-session-identity.ts, which resolves the
// ONE session a pane is already using. It deliberately reuses that module's
// layout knowledge — `ompSessionBucketDir` (agent-dir resolution + the
// `sessions` segment + the cwd-bucket encoding) and
// `parseOmpSessionIdFromFilename` — rather than re-deriving paths: a second,
// drifting copy of the encoding would silently walk an empty directory and
// report "nothing to resume" instead of failing.
//
// CRITICAL, inherited from that module: a wrong path does not fail loudly.
// `switch_session` treats a missing or malformed session file as "empty" and
// silently initializes a brand-new session there, so every path returned here
// is stat-verified to be an existing regular file — the same stat that supplies
// `modifiedAt`, so verification is not a separable cost. A session another live
// pane already claims is dropped before it can be offered (the caller passes
// the registry's `claimedSessionFilePathsExcluding(paneKey)`, which withholds
// only OTHER panes' claims, never the asking pane's own).
import type { Dirent } from 'node:fs'
import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { OmpRpcChatResumableSession } from '../../shared/omp-rpc-chat-ipc-contract'
import {
  ompSessionBucketDir,
  parseOmpSessionIdFromFilename,
  type ResolveOmpPaneSessionIdentityOptions
} from './omp-terminal-session-identity'

/** OMP's own session listing reads a 4 KB header prefix per file and nothing
 *  more for the recent list (oh-my-pi session-listing.ts, `scanSessionFile`).
 *  The title slot record is padded to a fixed width well inside this window
 *  and the `{"type":"session"}` header follows it immediately. */
const HEADER_PREFIX_BYTES = 4096

type SessionHeader = { name?: string; startedAt?: string }

/** Mirrors OMP's `normalizeTitleOverride`: an absent title field is "unknown"
 *  (fall through to the session record's own title), while a present but blank
 *  one is an explicit "no title" that must SUPPRESS the record's title rather
 *  than fall through to it. */
function titleOverrideFrom(record: Record<string, unknown>): string | null | undefined {
  const title = record.title
  if (typeof title !== 'string') {
    return undefined
  }
  return title.trim() ? title : null
}

function parseHeaderPrefix(prefix: string): SessionHeader {
  let titleOverride: string | null | undefined
  let sawTitleSlot = false
  for (const rawLine of prefix.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      // A line the 4 KB window truncated, or a corrupt one. Either way there
      // is nothing to report — never guess a name from the raw bytes.
      return {}
    }
    if (!sawTitleSlot && record.type === 'title') {
      titleOverride = titleOverrideFrom(record)
      sawTitleSlot = true
      continue
    }
    if (record.type !== 'session') {
      return {}
    }
    const recordTitle = typeof record.title === 'string' ? record.title : undefined
    const name = titleOverride === null ? undefined : (titleOverride ?? recordTitle)
    const startedAt = typeof record.timestamp === 'string' ? record.timestamp.trim() : ''
    return {
      ...(name && name.trim() ? { name } : {}),
      ...(startedAt ? { startedAt } : {})
    }
  }
  return {}
}

async function readSessionHeader(path: string): Promise<SessionHeader> {
  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch {
    return {}
  }
  try {
    const buffer = Buffer.allocUnsafe(HEADER_PREFIX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_PREFIX_BYTES, 0)
    return parseHeaderPrefix(buffer.subarray(0, bytesRead).toString('utf8'))
  } catch {
    return {}
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Every session file in this cwd's bucket that a pane could switch into,
 * newest-modified first. An empty array means "nothing to resume" — never an
 * error, and never a fabricated row: a bucket that does not exist, a file that
 * vanished between `readdir` and `stat`, and a filename OMP's own id parser
 * rejects all just drop out of the list.
 *
 * Complete, deliberately uncapped: these rows ARE the answer to "what can I
 * resume here", and a silent truncation would let a picker imply a complete
 * list it cannot verify — main would know the list was cut and the renderer
 * would not, with no field in the contract to tell it. The per-file cost is one
 * `stat` plus one bounded header read, and a cwd bucket holds tens of sessions
 * (the largest on the machine this was built against held 31).
 */
export async function listOmpResumableSessions(
  args: { cwd: string; currentSessionId?: string | null },
  options?: ResolveOmpPaneSessionIdentityOptions
): Promise<OmpRpcChatResumableSession[]> {
  const bucketDir = ompSessionBucketDir(args.cwd, options)
  let entries: Dirent[]
  try {
    entries = await readdir(bucketDir, { withFileTypes: true })
  } catch {
    return []
  }
  const claimed = options?.claimedSessionFilePaths
  const candidates: { sessionId: string; sessionPath: string; modifiedAtMs: number }[] = []
  for (const entry of entries) {
    // A bucket holds both `<stem>.jsonl` transcripts and `<stem>/` artifact
    // directories; only the former is resumable, and only when its name
    // carries the `<timestamp>_<sessionId>` shape the id parser understands.
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue
    }
    const sessionId = parseOmpSessionIdFromFilename(entry.name)
    if (!sessionId) {
      continue
    }
    const sessionPath = join(bucketDir, entry.name)
    if (claimed?.has(sessionPath)) {
      continue
    }
    try {
      const info = await stat(sessionPath)
      if (!info.isFile()) {
        continue
      }
      candidates.push({ sessionId, sessionPath, modifiedAtMs: info.mtimeMs })
    } catch {
      // Raced deletion between readdir and stat — skip, never fabricate.
    }
  }
  candidates.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
  return await Promise.all(
    candidates.map(async (candidate) => {
      const header = await readSessionHeader(candidate.sessionPath)
      return {
        sessionId: candidate.sessionId,
        sessionPath: candidate.sessionPath,
        modifiedAtMs: candidate.modifiedAtMs,
        isCurrent: candidate.sessionId === args.currentSessionId,
        ...header
      }
    })
  )
}
