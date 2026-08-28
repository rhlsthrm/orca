// @vitest-environment happy-dom

import type { Dispatch, SetStateAction } from 'react'

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_HISTORY } from './native-chat-composer-state'

const sendNativeChatMessage = vi.fn()
const sendNativeChatTypedCommand = vi.fn()
const runLocalCommand = vi.fn()

vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => sendNativeChatMessage(...args),
  sendNativeChatTypedCommand: (...args: unknown[]) => sendNativeChatTypedCommand(...args)
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))

import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'

function commandItem(name: string) {
  return {
    kind: 'command' as const,
    id: `command:${name}`,
    name,
    description: undefined,
    skillCollision: false
  }
}

type OnSlashCommand = NonNullable<
  Parameters<typeof useNativeChatPickerCommandDispatch>[0]['onSlashCommand']
>

function renderDispatch(options: {
  agent: string
  onSlashCommand: OnSlashCommand
  resolveTarget?: () => { settings: Record<string, never>; ptyId: string } | null
  setNotice?: Dispatch<SetStateAction<string | null>>
}) {
  return renderHook(() =>
    useNativeChatPickerCommandDispatch({
      agent: options.agent,
      ompRpcCwd: '/work/a',
      disabled: false,
      isDispatchingSessionOption: false,
      resolveTarget: options.resolveTarget ?? (() => ({ settings: {}, ptyId: 'pty-1' })),
      onSlashCommand: options.onSlashCommand,
      sessionOptionsSurface: null,
      trackPendingSend: vi.fn(),
      setHistory: vi.fn((update) => update(EMPTY_HISTORY)),
      setDraft: vi.fn(),
      setCaret: vi.fn(),
      setActiveSuggestion: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: vi.fn(),
      setNotice: options.setNotice ?? vi.fn()
    })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  const handle = { cancel: vi.fn(), settleAfterMs: 0 }
  sendNativeChatMessage.mockReturnValue(handle)
  sendNativeChatTypedCommand.mockReturnValue(handle)
  // Assign onto happy-dom's real window; replacing it wholesale breaks waitFor.
  ;(window as unknown as { api: unknown }).api = { ompRpc: { runLocalCommand } }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('picker dispatch routes OMP /usage over RPC', () => {
  it('sends /usage to the RPC api instead of the PTY, and reports the output', async () => {
    runLocalCommand.mockResolvedValue({
      ok: true,
      outputText: '```\nTokens: 120k\n```',
      agentInvoked: false
    })
    const onSlashCommand = vi.fn()
    const hook = renderDispatch({ agent: 'omp', onSlashCommand })

    act(() => hook.result.current(commandItem('usage')))

    await waitFor(() =>
      expect(onSlashCommand).toHaveBeenCalledWith('/usage', {
        outputText: '```\nTokens: 120k\n```',
        agentInvoked: false
      })
    )
    expect(runLocalCommand).toHaveBeenCalledWith({ cwd: '/work/a', command: '/usage' })
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(sendNativeChatTypedCommand).not.toHaveBeenCalled()
  })

  it('keeps /help on the existing PTY path for the same omp pane', async () => {
    const onSlashCommand = vi.fn()
    const hook = renderDispatch({ agent: 'omp', onSlashCommand })

    act(() => hook.result.current(commandItem('help')))

    expect(sendNativeChatMessage).toHaveBeenCalledWith({}, 'pty-1', '/help')
    expect(runLocalCommand).not.toHaveBeenCalled()
    // No outcome argument: nothing was captured, so nothing is rendered.
    expect(onSlashCommand).toHaveBeenCalledWith('/help')
  })

  it('keeps /usage on the PTY path for a non-omp agent', () => {
    const onSlashCommand = vi.fn()
    const hook = renderDispatch({ agent: 'claude', onSlashCommand })

    act(() => hook.result.current(commandItem('usage')))

    expect(sendNativeChatMessage).toHaveBeenCalledWith({}, 'pty-1', '/usage')
    expect(runLocalCommand).not.toHaveBeenCalled()
  })

  it('falls back to the PTY when the probe is unavailable', async () => {
    runLocalCommand.mockResolvedValue({ ok: false, errorCode: 'executable-not-found' })
    const onSlashCommand = vi.fn()
    const hook = renderDispatch({ agent: 'omp', onSlashCommand })

    act(() => hook.result.current(commandItem('usage')))

    await waitFor(() => expect(sendNativeChatMessage).toHaveBeenCalledWith({}, 'pty-1', '/usage'))
    expect(onSlashCommand).toHaveBeenCalledWith('/usage')
  })
})

describe('picker dispatch on a PTY-less pane (wave 8, D1)', () => {
  it('still sends /usage to the RPC api with no PTY — acquisition succeeding must not disable it', async () => {
    runLocalCommand.mockResolvedValue({
      ok: true,
      outputText: '```\nTokens: 120k\n```',
      agentInvoked: false
    })
    const onSlashCommand = vi.fn()
    const hook = renderDispatch({
      agent: 'omp',
      onSlashCommand,
      resolveTarget: () => null
    })

    act(() => hook.result.current(commandItem('usage')))

    await waitFor(() =>
      expect(onSlashCommand).toHaveBeenCalledWith('/usage', {
        outputText: '```\nTokens: 120k\n```',
        agentInvoked: false
      })
    )
    expect(runLocalCommand).toHaveBeenCalledWith({ cwd: '/work/a', command: '/usage' })
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(sendNativeChatTypedCommand).not.toHaveBeenCalled()
  })

  it('shows a notice instead of silently dropping a PTY-only command when there is no PTY', () => {
    const onSlashCommand = vi.fn()
    const setNotice = vi.fn()
    const hook = renderDispatch({
      agent: 'claude',
      onSlashCommand,
      resolveTarget: () => null,
      setNotice
    })

    act(() => hook.result.current(commandItem('clear')))

    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(sendNativeChatTypedCommand).not.toHaveBeenCalled()
    expect(onSlashCommand).not.toHaveBeenCalled()
    expect(setNotice).toHaveBeenCalledWith(expect.any(String))
  })
})
