// Resolves an OMP pane's session identity from OMP's own on-disk state,
// bypassing the broken agent-status hook chain (docs/omp-rpc-chat-adapter-plan.md,
// open item 1's gate (b) / Decision 2). Two mechanisms, preferred-then-fallback:
//
//   1. The terminal-scoped breadcrumb at `~/.omp/agent/terminal-sessions/<terminal-id>`
//      (omp://session.md#on-disk-layout, omp://session-switching-and-recent-listing.md)
//      records exactly which session file a given terminal's OMP was using.
//      `<terminal-id>` is derived the same way OMP derives it: from the pane's PTY
//      slave device path (OMP "prefers TTY path"; real breadcrumb files observed on
//      this machine are named e.g. `ttys000`, matching `basename(slavePath)`).
//   2. Without a usable breadcrumb: newest `.jsonl` by mtime in the pane's
//      encoded-cwd session bucket — a heuristic, not an authoritative record.
//
// CRITICAL: a wrong path does not fail loudly. `setSessionFile` treats a missing or
// malformed session file as "empty" and silently initializes a brand-new session
// there. Every path this module returns is verified to exist on disk before it is
// handed back, and a breadcrumb whose recorded cwd disagrees with the pane's actual
// cwd (stale — ttys device paths are reused across processes) is never trusted.
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'

export type OmpTerminalSessionIdentitySource = 'breadcrumb' | 'mtime-fallback'

export type OmpPaneSessionIdentity = {
  /** Bare session id — the claim identity `ompRpcChat:acquire` expects as `sessionFile`. */
  sessionId: string
  /** Absolute path to the session's JSONL transcript, verified to exist. */
  sessionFilePath: string
  source: OmpTerminalSessionIdentitySource
}

export type ResolveOmpPaneSessionIdentityOptions = {
  /** Override the OMP agent root (defaults to `OMP_CODING_AGENT_DIR` or `~/.omp/agent`). */
  agentDir?: string
  homeDir?: string
  tempDir?: string
  /** Read-only PTY slave device path lookup; undefined/absent means "unknowable"
   *  (non-local provider, Windows, or a provider that doesn't expose one) — the
   *  resolver falls straight to the mtime bucket fallback in that case. */
  getSlavePath?: (ptyId: string) => string | undefined
}

function ompAgentDir(options?: ResolveOmpPaneSessionIdentityOptions): string {
  return (
    options?.agentDir?.trim() ||
    process.env.OMP_CODING_AGENT_DIR?.trim() ||
    join(options?.homeDir ?? homedir(), '.omp', 'agent')
  )
}

/** OMP's own terminal-id derivation prefers the TTY path; on this codebase's
 *  evidence (`~/.omp/agent/terminal-sessions/ttys000`, …) that id is the plain
 *  basename of the slave device path. */
export function terminalIdFromSlavePath(slavePath: string): string | null {
  const segments = slavePath.split(/[\\/]/).filter(Boolean)
  const last = segments.at(-1)
  return last && last.length > 0 ? last : null
}

function isPathUnder(parent: string, child: string): boolean {
  if (parent === child) {
    return true
  }
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

function encodeSegments(relativePath: string): string {
  return relativePath.split(/[\\/]/).filter(Boolean).join('-')
}

/** Strips a Windows drive prefix (`C:\`) before falling back to `--<encoded>--`;
 *  POSIX drive-less absolute paths need no such stripping. Windows PTY kill/respawn
 *  semantics are unverified elsewhere in this wave (see plan doc) — this encoding
 *  is best-effort for that platform and is only ever a fallback heuristic: a wrong
 *  guess here yields an empty/nonexistent directory listing, which this module
 *  already treats as "no candidate", never a wrong write. */
function encodeAbsoluteCwd(cwd: string): string {
  const withoutDrive = cwd.replace(/^[a-zA-Z]:[\\/]/, '')
  const withoutLeadingSep = withoutDrive.replace(/^[\\/]+/, '')
  return encodeSegments(withoutLeadingSep)
}

/** Mirrors the on-disk-layout rules in omp://session.md: `-<relative>` under home,
 *  `-tmp-<relative>` under the temp root, `--<encoded-absolute>--` otherwise. */
export function encodeOmpSessionCwdBucket(
  cwd: string,
  options?: ResolveOmpPaneSessionIdentityOptions
): string {
  const home = options?.homeDir ?? homedir()
  const temp = options?.tempDir ?? tmpdir()
  if (isPathUnder(home, cwd)) {
    return `-${encodeSegments(relative(home, cwd))}`
  }
  if (isPathUnder(temp, cwd)) {
    return `-tmp-${encodeSegments(relative(temp, cwd))}`
  }
  return `--${encodeAbsoluteCwd(cwd)}--`
}

export type OmpTerminalBreadcrumb = {
  cwd: string
  /** Null when the breadcrumb records a lazily-unmaterialized `/new` boundary. */
  sessionFilePath: string | null
  /** The optional third line: a missing `sessionFilePath` is only a legitimate,
   *  non-stale state when this is true (session-switching-and-recent-listing.md). */
  fresh: boolean
}

async function readTerminalBreadcrumb(
  terminalId: string,
  options?: ResolveOmpPaneSessionIdentityOptions
): Promise<OmpTerminalBreadcrumb | null> {
  const path = join(ompAgentDir(options), 'terminal-sessions', terminalId)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const lines = raw.split(/\r?\n/)
  const cwd = lines[0]?.trim()
  if (!cwd) {
    return null
  }
  const sessionFilePath = lines[1]?.trim() || null
  const fresh = lines[2]?.trim() === 'fresh'
  return { cwd, sessionFilePath, fresh }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

async function resolveFromBreadcrumb(
  ptyId: string,
  cwd: string,
  options?: ResolveOmpPaneSessionIdentityOptions
): Promise<{ sessionFilePath: string } | 'fresh-empty' | null> {
  const slavePath = options?.getSlavePath?.(ptyId)
  const terminalId = slavePath ? terminalIdFromSlavePath(slavePath) : null
  if (!terminalId) {
    return null
  }
  const breadcrumb = await readTerminalBreadcrumb(terminalId, options)
  if (!breadcrumb) {
    return null
  }
  if (breadcrumb.sessionFilePath) {
    // Why: a tty device path is reused across processes over a machine's
    // lifetime; a breadcrumb recorded for a since-repurposed tty slot is
    // stale, not authoritative. Only trust it when it agrees with this
    // pane's actual cwd — otherwise fall through to the mtime heuristic
    // rather than risk switching into an unrelated pane's session.
    if (breadcrumb.cwd !== cwd) {
      return null
    }
    if (!(await fileExists(breadcrumb.sessionFilePath))) {
      // Materialized-but-missing is not "fresh" — the recorded target rotted
      // (moved/deleted). Fall through to the mtime fallback rather than
      // trust a path that would silently mint an empty session.
      return null
    }
    return { sessionFilePath: breadcrumb.sessionFilePath }
  }
  // Missing target: only a legitimate, non-stale state when `fresh` — a
  // lazily-unmaterialized `/new` boundary with genuinely nothing to resume.
  // Do NOT fall back to mtime scanning here: that would resurrect whatever
  // session predates the `/new`, silently undoing the user's own boundary.
  return breadcrumb.fresh ? 'fresh-empty' : null
}

async function resolveNewestSessionFileInBucket(
  cwd: string,
  options?: ResolveOmpPaneSessionIdentityOptions
): Promise<string | null> {
  const bucketDir = join(ompAgentDir(options), 'sessions', encodeOmpSessionCwdBucket(cwd, options))
  let entries: Dirent[]
  try {
    entries = await readdir(bucketDir, { withFileTypes: true })
  } catch {
    return null
  }
  const candidates: { path: string; mtimeMs: number }[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue
    }
    const path = join(bucketDir, entry.name)
    try {
      const info = await stat(path)
      candidates.push({ path, mtimeMs: info.mtimeMs })
    } catch {
      // Raced deletion between readdir and stat — skip, never fabricate.
    }
  }
  if (candidates.length === 0) {
    return null
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0].path
}

/** `<timestamp>_<sessionId>.jsonl` (session.md#on-disk-layout) — the timestamp
 *  portion uses no underscores, so the first `_` is the delimiter. */
export function parseOmpSessionIdFromFilename(filePath: string): string | null {
  const base = filePath.slice(filePath.replace(/[\\/]+$/, '').lastIndexOf('/') + 1)
  const stem = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base
  const separatorIndex = stem.indexOf('_')
  if (separatorIndex === -1 || separatorIndex === stem.length - 1) {
    return null
  }
  return stem.slice(separatorIndex + 1)
}

/**
 * Resolves the session a pane's OMP process is (or was) using, without the
 * broken hook chain. Null means "nothing to resume" — not an error: callers
 * must degrade to today's PTY behavior, never guess a path.
 */
export async function resolveOmpPaneSessionIdentity(
  args: { ptyId: string; cwd: string },
  options?: ResolveOmpPaneSessionIdentityOptions
): Promise<OmpPaneSessionIdentity | null> {
  const fromBreadcrumb = await resolveFromBreadcrumb(args.ptyId, args.cwd, options)
  if (fromBreadcrumb === 'fresh-empty') {
    return null
  }
  let sessionFilePath: string
  let source: OmpTerminalSessionIdentitySource
  if (fromBreadcrumb) {
    sessionFilePath = fromBreadcrumb.sessionFilePath
    source = 'breadcrumb'
  } else {
    const fallback = await resolveNewestSessionFileInBucket(args.cwd, options)
    if (!fallback) {
      return null
    }
    sessionFilePath = fallback
    source = 'mtime-fallback'
  }
  // Verify existence a final time immediately before handing the path back —
  // the single most dangerous failure mode in this wave is an unverified path
  // reaching `switch_session` (see module doc).
  if (!(await fileExists(sessionFilePath))) {
    return null
  }
  const sessionId = parseOmpSessionIdFromFilename(sessionFilePath)
  if (!sessionId) {
    return null
  }
  return { sessionId, sessionFilePath, source }
}
