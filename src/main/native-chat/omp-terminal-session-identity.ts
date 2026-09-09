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
//   1b. A breadcrumb whose recorded target does NOT exist yet, while the
//      breadcrumb also carries the `fresh` marker: OMP has decided which
//      session file this tty's next turn writes and simply has not
//      materialized it (a `/new` boundary, or a pane whose first prompt was
//      never sent). That is a real, usable identity for THIS pane — see
//      `fresh-breadcrumb` below.
//   2. With no live PTY: newest `.jsonl` by mtime in the pane's encoded-cwd
//      session bucket — a recovery heuristic, never a live-takeover identity.
//
// CRITICAL: a wrong path does not fail loudly. `setSessionFile` treats a missing
// or malformed session file as "empty" and silently initializes a brand-new
// session there. Every path this module returns for an EXISTING session is
// verified to exist on disk before it is handed back; the single exception is
// `fresh-breadcrumb`, whose absence is the point and whose safety comes from
// provenance rather than a stat (see that source's doc). A breadcrumb whose
// recorded cwd disagrees with the pane's actual cwd (stale — ttys device paths
// are reused across processes) is never trusted, fresh or not.
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'

/** `fresh-breadcrumb` is the one source whose file does not exist yet. It is
 *  NOT a guess: the path came from OMP's own breadcrumb for this pane's tty,
 *  so an RPC child materializing it produces exactly the session the pane's
 *  own TUI would have produced on its next turn. Kept distinguishable from
 *  `breadcrumb` so a consumer can tell a known-empty target from a resolved
 *  existing session, and from `mtime-fallback`, which stays a heuristic and
 *  must never become a live-takeover identity. */
export type OmpTerminalSessionIdentitySource = 'breadcrumb' | 'fresh-breadcrumb' | 'mtime-fallback'

export type OmpPaneSessionIdentity = {
  /** Bare session id — the claim identity `ompRpcChat:acquire` expects as `sessionFile`. */
  sessionId: string
  /** Absolute path to the session's JSONL transcript. Verified to exist for
   *  every source except `fresh-breadcrumb`. */
  sessionFilePath: string
  source: OmpTerminalSessionIdentitySource
}

export type ResolveOmpPaneSessionIdentityOptions = {
  /** Override the OMP agent root (defaults to `OMP_CODING_AGENT_DIR` or `~/.omp/agent`). */
  agentDir?: string
  homeDir?: string
  tempDir?: string
  /** Read-only PTY slave device path lookup; undefined/absent means "unknowable"
   *  (non-local provider, Windows, or a provider that doesn't expose one). */
  getSlavePath?: (ptyId: string) => string | undefined | Promise<string | undefined>
  /** Session file paths already claimed by a live pane (finding C, cross-lab
   *  review) — excluded from the mtime-fallback candidate list so two panes
   *  cd'd into the same cwd can never both resolve to the SAME session via
   *  the heuristic fallback. The registry's own identity-keyed claim already
   *  blocks a resulting dual-writer; this narrows the fallback's candidate
   *  set before that point, so a fresh pane sharing a cwd is never even
   *  offered another pane's live conversation to display or attempt. */
  claimedSessionFilePaths?: ReadonlySet<string>
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

/** Node's `realpathSync` throws if ANY path component is missing — unlike a
 *  "resolve what exists, keep the rest literal" realpath — so a genuinely
 *  nonexistent leaf (a stale cwd whose directory was since removed) under
 *  an existing, symlinked parent would otherwise normalize inconsistently
 *  against a sibling reference path (home/temp) that itself exists and
 *  resolves cleanly. Walks up to the longest existing prefix, resolves
 *  THAT, then reattaches the still-literal missing suffix. Falls back to
 *  the raw path only when no prefix exists at all (this can only ever
 *  degrade to "no candidate found" per the module doc, never trust a wrong
 *  match). Also strips a trailing separator, so a symlinked worktree or a
 *  trailing slash doesn't make a genuinely-matching cwd read as a mismatch
 *  (finding D, cross-lab review). */
function realpathAsFarAsPossible(path: string): string {
  let current = path
  const missingSuffix: string[] = []
  for (;;) {
    try {
      const resolved = realpathSync(current)
      return missingSuffix.length > 0 ? join(resolved, ...missingSuffix) : resolved
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        // Reached the filesystem root without finding any existing prefix.
        return path
      }
      missingSuffix.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''))
      current = parent
    }
  }
}

function normalizeCwdForComparison(cwd: string): string {
  const resolved = realpathAsFarAsPossible(cwd)
  return resolved.length > 1 && (resolved.endsWith('/') || resolved.endsWith('\\'))
    ? resolved.slice(0, -1)
    : resolved
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
  const normalizedCwd = normalizeCwdForComparison(cwd)
  const home = normalizeCwdForComparison(options?.homeDir ?? homedir())
  const temp = normalizeCwdForComparison(options?.tempDir ?? tmpdir())
  if (isPathUnder(home, normalizedCwd)) {
    return `-${encodeSegments(relative(home, normalizedCwd))}`
  }
  if (isPathUnder(temp, normalizedCwd)) {
    return `-tmp-${encodeSegments(relative(temp, normalizedCwd))}`
  }
  return `--${encodeAbsoluteCwd(normalizedCwd)}--`
}

/** `<agentDir>/sessions/<bucket>` — the directory holding every session file
 *  OMP would offer for this cwd. Exported because the resumable-session
 *  enumerator (omp-resumable-sessions.ts) has to walk the same directory the
 *  mtime fallback below walks; two independent compositions of the agent dir,
 *  the `sessions` segment and the bucket encoding is exactly the kind of
 *  drift that silently points one of them at an empty directory. */
export function ompSessionBucketDir(
  cwd: string,
  options?: ResolveOmpPaneSessionIdentityOptions
): string {
  return join(ompAgentDir(options), 'sessions', encodeOmpSessionCwdBucket(cwd, options))
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
  slavePath: string | undefined,
  cwd: string,
  options?: ResolveOmpPaneSessionIdentityOptions
): Promise<
  | { sessionFilePath: string; source: Exclude<OmpTerminalSessionIdentitySource, 'mtime-fallback'> }
  | 'fresh-empty'
  | null
> {
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
    // rather than risk switching into an unrelated pane's session. Both
    // sides are normalized (finding D) so a symlinked worktree or a
    // trailing slash doesn't read as a mismatch on its own.
    if (normalizeCwdForComparison(breadcrumb.cwd) !== normalizeCwdForComparison(cwd)) {
      return null
    }
    if (await fileExists(breadcrumb.sessionFilePath)) {
      return { sessionFilePath: breadcrumb.sessionFilePath, source: 'breadcrumb' }
    }
    if (!breadcrumb.fresh) {
      // Materialized-but-missing is not "fresh" — the recorded target rotted
      // (moved/deleted). Fall through to the mtime fallback rather than
      // trust a path that would silently mint an empty session.
      return null
    }
    // Absent AND marked fresh: OMP recorded this exact path as the session
    // this tty's next turn writes, and simply has not created it yet — the
    // live shape of a pane whose chat view opened before its first prompt.
    // Handing it back is not a guess (see `fresh-breadcrumb`); withholding it
    // is what left such a pane permanently unownable, so slash commands fell
    // through to an invisible TUI. The claimed-path exclusion still applies:
    // if another live pane already owns this target, this pane must not race
    // it to materialize the same file.
    if (options?.claimedSessionFilePaths?.has(breadcrumb.sessionFilePath)) {
      return null
    }
    return { sessionFilePath: breadcrumb.sessionFilePath, source: 'fresh-breadcrumb' }
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
  const bucketDir = ompSessionBucketDir(cwd, options)
  let entries: Dirent[]
  try {
    entries = await readdir(bucketDir, { withFileTypes: true })
  } catch {
    return null
  }
  const candidates: { path: string; mtimeMs: number }[] = []
  for (const entry of entries) {
    // Why the filename filter: the newest file in the bucket may not carry a
    // `<timestamp>_<sessionId>` name; choosing it would fail the parse below
    // and return null instead of the older session that is actually resumable.
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.jsonl') ||
      !parseOmpSessionIdFromFilename(entry.name)
    ) {
      continue
    }
    const path = join(bucketDir, entry.name)
    // Why (finding C): a session another live pane already claimed must
    // never be offered to a second pane sharing the same cwd bucket.
    if (options?.claimedSessionFilePaths?.has(path)) {
      continue
    }
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
 *  portion uses no underscores, so the first `_` is the delimiter. Splits on
 *  either separator: on Windows an underscore in a parent directory would
 *  otherwise become the delimiter and yield a path fragment as the id. */
export function parseOmpSessionIdFromFilename(filePath: string): string | null {
  const base =
    filePath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) ?? ''
  const stem = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base
  const separatorIndex = stem.indexOf('_')
  if (separatorIndex === -1 || separatorIndex === stem.length - 1) {
    return null
  }
  return stem.slice(separatorIndex + 1)
}

/**
 * The fresh, not-yet-materialized session file a pane breadcrumb records for
 * `sessionId` under `cwd`, or null.
 *
 * Why this exists separately from the resolver above: acquisition receives the
 * BARE session id and resolves its `switch_session` path with
 * `resolveSessionFilePath`, which can only ever find a file that already
 * exists — so a pane whose identity resolved as `fresh-breadcrumb` would be
 * refused at acquire time, i.e. exactly the pane this feature is for. And the
 * tty-scoped lookup above is unavailable by then: Decision 1's acquisition
 * kills the pane's PTY first, so there is no slave path left to derive a
 * terminal id from. The breadcrumb FILE outlives its process (this machine
 * holds entries for ttys whose devices are long gone), so the target is found
 * by scanning breadcrumbs for the one naming this session.
 *
 * Re-verifies every condition from OMP's own record rather than trusting a
 * remembered path: the breadcrumb must still name this session, still carry
 * `fresh`, still agree with the pane's cwd, still be absent on disk, and still
 * be unclaimed by another pane. Any of those failing yields null, and the
 * caller keeps its existing refusal.
 */
export async function resolveOmpFreshSessionTargetPath(
  args: { cwd: string; sessionId: string },
  options?: ResolveOmpPaneSessionIdentityOptions
): Promise<string | null> {
  let entries: Dirent[]
  try {
    entries = await readdir(join(ompAgentDir(options), 'terminal-sessions'), {
      withFileTypes: true
    })
  } catch {
    return null
  }
  const paneCwd = normalizeCwdForComparison(args.cwd)
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }
    const breadcrumb = await readTerminalBreadcrumb(entry.name, options)
    const target = breadcrumb?.sessionFilePath
    if (
      !breadcrumb ||
      !target ||
      !breadcrumb.fresh ||
      parseOmpSessionIdFromFilename(target) !== args.sessionId ||
      normalizeCwdForComparison(breadcrumb.cwd) !== paneCwd ||
      options?.claimedSessionFilePaths?.has(target) === true
    ) {
      continue
    }
    // A target that has since materialized is a resolved EXISTING session:
    // `resolveSessionFilePath` finds it by id, and handing it back from here
    // would skip that verified route in favour of an unstatted path.
    if (await fileExists(target)) {
      continue
    }
    return target
  }
  return null
}

/**
 * Resolves the session a pane's OMP process is (or was) using, without the
 * broken hook chain. Null means "nothing to resume" — not an error: callers
 * must degrade to today's PTY behavior, never guess a path.
 *
 * A breadcrumb is preferred when the provider can identify the terminal. Windows
 * ConPTY has no slave path, so it uses the unclaimed cwd bucket fallback instead.
 */
export async function resolveOmpPaneSessionIdentity(
  args: { ptyId: string | null; cwd: string },
  options?: ResolveOmpPaneSessionIdentityOptions
): Promise<OmpPaneSessionIdentity | null> {
  const slavePath = args.ptyId ? await options?.getSlavePath?.(args.ptyId) : undefined
  const fromBreadcrumb = args.ptyId
    ? await resolveFromBreadcrumb(slavePath, args.cwd, options)
    : null
  if (fromBreadcrumb === 'fresh-empty') {
    return null
  }
  let sessionFilePath: string
  let source: OmpTerminalSessionIdentitySource
  if (fromBreadcrumb) {
    sessionFilePath = fromBreadcrumb.sessionFilePath
    source = fromBreadcrumb.source
  } else {
    const canUseMtimeFallback =
      args.ptyId === null || (slavePath === undefined && process.platform === 'win32')
    if (!canUseMtimeFallback) {
      return null
    }
    const fallback = await resolveNewestSessionFileInBucket(args.cwd, options)
    if (!fallback) {
      return null
    }
    sessionFilePath = fallback
    source = 'mtime-fallback'
  }
  // Verify existence a final time immediately before handing the path back —
  // the single most dangerous failure mode in this wave is an unverified path
  // reaching `switch_session` (see module doc). The lone exception is
  // `fresh-breadcrumb`: its target is absent BY DEFINITION, and what makes it
  // safe is provenance, not a stat — OMP's own breadcrumb for this pane's tty
  // named it, with the `fresh` marker, for this pane's cwd, unclaimed by any
  // other pane. Statting it here would reject exactly the case it exists for.
  if (source !== 'fresh-breadcrumb' && !(await fileExists(sessionFilePath))) {
    return null
  }
  const sessionId = parseOmpSessionIdFromFilename(sessionFilePath)
  if (!sessionId) {
    return null
  }
  return { sessionId, sessionFilePath, source }
}
