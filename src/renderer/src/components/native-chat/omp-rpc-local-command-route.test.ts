import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runOmpLocalCommand, shouldRouteOmpLocalCommand } from './omp-rpc-local-command-route'

const runLocalCommand = vi.fn()

beforeEach(() => {
  runLocalCommand.mockReset()
  ;(globalThis as { window?: unknown }).window = { api: { ompRpc: { runLocalCommand } } }
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('shouldRouteOmpLocalCommand', () => {
  it('routes /usage on an omp pane off the PTY path', () => {
    expect(shouldRouteOmpLocalCommand('omp', '/usage')).toBe(true)
    expect(shouldRouteOmpLocalCommand('omp', '  /usage  ')).toBe(true)
    expect(shouldRouteOmpLocalCommand('omp', '/USAGE')).toBe(true)
  })

  it('leaves every other omp command on the existing path', () => {
    for (const command of [
      '/help',
      '/clear',
      '/compact',
      '/model opus',
      '/usage --json',
      'hello'
    ]) {
      expect(shouldRouteOmpLocalCommand('omp', command)).toBe(false)
    }
  })

  it('never routes for a non-omp agent, even for /usage', () => {
    for (const agent of ['claude', 'codex', 'grok', 'openclaude', 'pi']) {
      expect(shouldRouteOmpLocalCommand(agent, '/usage')).toBe(false)
    }
  })
})

describe('runOmpLocalCommand', () => {
  it('returns the probe output and the wire agentInvoked flag', async () => {
    runLocalCommand.mockResolvedValue({
      ok: true,
      outputText: '```\nUsage\n```',
      agentInvoked: false
    })

    await expect(runOmpLocalCommand('/work/a', '/usage')).resolves.toEqual({
      outputText: '```\nUsage\n```',
      agentInvoked: false
    })
    expect(runLocalCommand).toHaveBeenCalledWith({ cwd: '/work/a', command: '/usage' })
  })

  it('carries the truncation flag through', async () => {
    runLocalCommand.mockResolvedValue({
      ok: true,
      outputText: 'partial',
      agentInvoked: false,
      truncated: true
    })
    await expect(runOmpLocalCommand('/work/a', '/usage')).resolves.toEqual({
      outputText: 'partial',
      agentInvoked: false,
      truncated: true
    })
  })

  it('signals PTY fallback with null when there is no cwd, no result, or a rejection', async () => {
    await expect(runOmpLocalCommand(null, '/usage')).resolves.toBeNull()
    expect(runLocalCommand).not.toHaveBeenCalled()

    runLocalCommand.mockResolvedValue({ ok: false, errorCode: 'executable-not-found' })
    await expect(runOmpLocalCommand('/work/a', '/usage')).resolves.toBeNull()

    runLocalCommand.mockRejectedValue(new Error('ipc down'))
    await expect(runOmpLocalCommand('/work/a', '/usage')).resolves.toBeNull()
  })

  it('falls back when the preload api is absent entirely', async () => {
    ;(globalThis as { window?: unknown }).window = {}
    await expect(runOmpLocalCommand('/work/a', '/usage')).resolves.toBeNull()
  })
})
