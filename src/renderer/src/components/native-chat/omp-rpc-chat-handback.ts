// Decision 1's hand-back: when a pane returns to Terminal view, respawn a PTY
// resuming the same OMP session into the exact same pane (not a new tab) —
// the terminal the user is looking at should show their shell again, not an
// unrelated new tab elsewhere. There is no existing generic "respawn into an
// existing pane" primitive; the closest precedent is Codex's detached-pane
// account-restart (codex-detached-pane-restart.ts), whose store rebind
// primitives (`updateTabPtyId` + the terminal-layout leaf rebind) this module
// reuses. `buildAgentResumeStartupPlan` (already the OMP-session-resume path
// used by "wake sleeping agent") builds the actual `omp --resume <id>`
// command — the CLI accepts a bare session id (unlike the RPC wire's
// `switch_session`, which needs the resolved absolute path), so no path
// lookup is needed here.
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { resolveAgentResumeLaunchTarget } from '@/lib/agent-resume-launch-target'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { useAppStore } from '@/store'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import { isTerminalLeafId, parsePaneKey } from '../../../../shared/stable-pane-id'

export type OmpRpcChatHandbackArgs = {
  paneKey: string
  /** The PTY the RPC child took over — the pane's identity going into the
   *  respawn; killed once the replacement is bound in. */
  replacedPtyId: string
  cwd: string
  /** Bare session id (the claim identity) — sufficient for the CLI's
   *  `--resume`, unlike the RPC wire protocol. */
  sessionId: string
}

export type OmpRpcChatHandbackResult = { ok: true; ptyId: string } | { ok: false; reason: string }

function layoutRootContainsLeaf(
  node: TerminalPaneLayoutNode | null | undefined,
  leafId: string
): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutRootContainsLeaf(node.first, leafId) || layoutRootContainsLeaf(node.second, leafId)
}

/** Mirrors codex-detached-pane-restart.ts's `rebindCodexPaneLayoutLeaf`: a
 *  root that doesn't yet name this leaf (e.g. the pane's layout was never
 *  split) mints a fresh single-pane layout instead of silently orphaning the
 *  respawned PTY; an existing split rewrites just this leaf's binding. */
function rebindPaneLayoutLeaf(tabId: string, leafId: string, newPtyId: string): void {
  const store = useAppStore.getState()
  const layout = store.terminalLayoutsByTabId[tabId]
  const boundLeafIds = Object.keys(layout?.ptyIdsByLeafId ?? {})
  if (!layoutRootContainsLeaf(layout?.root, leafId) && boundLeafIds.every((id) => id === leafId)) {
    store.setTabLayout(
      tabId,
      singlePaneLayoutSnapshot(leafId, newPtyId, layout?.titlesByLeafId?.[leafId] ?? null)
    )
    return
  }
  store.replaceTerminalLayoutPanePtyId(tabId, leafId, newPtyId)
}

function locateWorktreeIdForTab(tabId: string): string | null {
  const state = useAppStore.getState()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      return worktreeId
    }
  }
  return null
}

/** Spawns a PTY resuming `sessionId` and rebinds it into the pane that
 *  `paneKey` identifies, replacing `replacedPtyId`. Never touches any other
 *  pane/tab. Failure is reported, never thrown — the caller degrades by
 *  leaving the pane on its now-exited PTY (the user can restart the shell
 *  manually), consistent with this feature's fail-closed contract. */
export async function respawnPtyForOmpRpcChatHandback(
  args: OmpRpcChatHandbackArgs
): Promise<OmpRpcChatHandbackResult> {
  const parsed = parsePaneKey(args.paneKey)
  if (!parsed || !isTerminalLeafId(parsed.leafId)) {
    return { ok: false, reason: 'invalid-pane-key' }
  }
  const { tabId, leafId } = parsed
  const worktreeId = locateWorktreeIdForTab(tabId)
  if (!worktreeId) {
    return { ok: false, reason: 'tab-not-found' }
  }

  const state = useAppStore.getState()
  const repo = state.repos.find(
    (entry) => entry.id === state.getKnownWorktreeById(worktreeId)?.repoId
  )
  const resumeTarget = resolveAgentResumeLaunchTarget({
    projectRuntime: getLocalProjectExecutionRuntimeContext(state, worktreeId),
    connectionId: repo?.connectionId,
    executionHostId: getExecutionHostIdForWorktree(state, worktreeId),
    worktreePath: args.cwd,
    terminalWindowsShell: state.settings?.terminalWindowsShell
  })
  const startupPlan = buildAgentResumeStartupPlan({
    agent: 'omp',
    providerSession: { key: 'session_id', id: args.sessionId },
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    platform: resumeTarget.platform,
    shell: resumeTarget.shell
  })
  if (!startupPlan) {
    return { ok: false, reason: 'resume-plan-unavailable' }
  }

  let spawned: { id: string }
  try {
    spawned = await window.api.pty.spawn({
      cols: 80,
      rows: 24,
      cwd: args.cwd,
      ...(startupPlan.env ? { env: startupPlan.env } : {}),
      command: startupPlan.launchCommand,
      launchAgent: 'omp',
      worktreeId,
      tabId,
      leafId
    })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }

  if (!useAppStore.getState().tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)) {
    // The tab closed while the spawn was in flight — reap the orphaned PTY
    // rather than leave it idling with nothing bound to it.
    void window.api.pty.kill(spawned.id).catch(() => {})
    return { ok: false, reason: 'tab-closed-during-respawn' }
  }

  useAppStore.getState().updateTabPtyId(tabId, spawned.id, args.replacedPtyId)
  rebindPaneLayoutLeaf(tabId, leafId, spawned.id)
  void window.api.pty.kill(args.replacedPtyId).catch(() => {})

  return { ok: true, ptyId: spawned.id }
}
