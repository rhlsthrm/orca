import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { respawnPtyForOmpRpcChatHandback } from './omp-rpc-chat-handback'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OLD_PTY = 'wt1@@old'
const NEW_PTY = 'wt1@@new'

function seedPane(opts: { layoutRoot?: 'leaf' | 'none' } = {}): void {
  useAppStore.setState({
    settings: { activeRuntimeEnvironmentId: null } as never,
    worktreesByRepo: {
      repo1: [{ id: 'wt1', path: '/Users/dev/code/orca' }]
    } as never,
    tabsByWorktree: {
      wt1: [
        {
          id: 'tab-1',
          ptyId: OLD_PTY,
          worktreeId: 'wt1',
          title: 'omp',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          launchAgent: 'omp' as const
        }
      ]
    } as never,
    ptyIdsByTabId: { 'tab-1': [OLD_PTY] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: opts.layoutRoot === 'none' ? null : { type: 'leaf' as const, leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: OLD_PTY }
      }
    }
  })
}

describe('respawnPtyForOmpRpcChatHandback', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: vi.fn().mockResolvedValue({ id: NEW_PTY }),
          kill: vi.fn().mockResolvedValue(undefined)
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('spawns a resume command into the same pane and kills the replaced PTY', async () => {
    seedPane()
    const paneKey = makePaneKey('tab-1', LEAF_ID)

    const result = await respawnPtyForOmpRpcChatHandback({
      paneKey,
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(result).toEqual({ ok: true, ptyId: NEW_PTY })
    expect(window.api.pty.spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cols: 80,
        rows: 24,
        cwd: '/Users/dev/code/orca',
        launchAgent: 'omp',
        worktreeId: 'wt1',
        tabId: 'tab-1',
        leafId: LEAF_ID,
        command: expect.stringContaining('--resume')
      })
    )
    expect(window.api.pty.spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ command: expect.stringContaining('session-1') })
    )
    expect(useAppStore.getState().ptyIdsByTabId['tab-1']).toContain(NEW_PTY)
    expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      NEW_PTY
    )
    expect(window.api.pty.kill).toHaveBeenCalledWith(OLD_PTY)
  })

  it('mints a single-pane layout when the leaf has no established split layout yet', async () => {
    seedPane({ layoutRoot: 'none' })
    const paneKey = makePaneKey('tab-1', LEAF_ID)

    const result = await respawnPtyForOmpRpcChatHandback({
      paneKey,
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(result).toEqual({ ok: true, ptyId: NEW_PTY })
    expect(useAppStore.getState().terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      NEW_PTY
    )
  })

  it('fails closed with invalid-pane-key for a malformed pane key, without spawning', async () => {
    seedPane()

    const result = await respawnPtyForOmpRpcChatHandback({
      paneKey: 'not-a-real-pane-key',
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(result).toEqual({ ok: false, reason: 'invalid-pane-key' })
    expect(window.api.pty.spawn).not.toHaveBeenCalled()
  })

  it('fails closed with tab-not-found when the tab has since closed', async () => {
    seedPane()
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    useAppStore.setState({ tabsByWorktree: {} })

    const result = await respawnPtyForOmpRpcChatHandback({
      paneKey,
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })

    expect(result).toEqual({ ok: false, reason: 'tab-not-found' })
    expect(window.api.pty.spawn).not.toHaveBeenCalled()
  })

  it('reaps the spawned PTY without rebinding when the tab closed mid-spawn', async () => {
    seedPane()
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const { promise, resolve } = Promise.withResolvers<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(promise)

    const pending = respawnPtyForOmpRpcChatHandback({
      paneKey,
      replacedPtyId: OLD_PTY,
      cwd: '/Users/dev/code/orca',
      sessionId: 'session-1'
    })
    useAppStore.setState({ tabsByWorktree: {} })
    resolve({ id: NEW_PTY })

    await expect(pending).resolves.toEqual({ ok: false, reason: 'tab-closed-during-respawn' })
    expect(window.api.pty.kill).toHaveBeenCalledWith(NEW_PTY)
  })
})
