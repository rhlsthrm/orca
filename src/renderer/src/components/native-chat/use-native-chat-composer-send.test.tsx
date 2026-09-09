// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatSendClassification } from '../../../../shared/native-chat-slash-commands'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { UseNativeChatComposerSendArgs } from './use-native-chat-composer-send'

const sendNativeChatMessage = vi.fn()
const sendNativeChatTypedCommand = vi.fn()
const sendNativeChatMessageWithImageAttachments = vi.fn()
const submitNativeChatPrompt = vi.fn()
const clearNativeChatLaunchDraft = vi.fn()

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/gu, (_match, name: string) => String(options?.[name] ?? ''))
}))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => sendNativeChatMessage(...args),
  sendNativeChatTypedCommand: (...args: unknown[]) => sendNativeChatTypedCommand(...args),
  submitNativeChatPrompt: (...args: unknown[]) => submitNativeChatPrompt(...args)
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: (...args: unknown[]) =>
    sendNativeChatMessageWithImageAttachments(...args)
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn()
}))
vi.mock('../../store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ clearNativeChatLaunchDraft })
  })
}))

import { useNativeChatComposerSend } from './use-native-chat-composer-send'
import { isMacPlatform } from './native-chat-shortcut'
import {
  findOmpRpcTerminalOnlyCommand,
  ompRpcTerminalOnlyCommandNotice
} from './omp-rpc-terminal-only-commands'

const PTY_TARGET: NativeChatResolvedTarget = { ptyId: 'pty-1', settings: {} }

function buildArgs(overrides: Partial<UseNativeChatComposerSendArgs> = {}): {
  args: UseNativeChatComposerSendArgs
  setNotice: ReturnType<typeof vi.fn>
  setHistory: ReturnType<typeof vi.fn>
  setDraft: ReturnType<typeof vi.fn>
  sendOmpLocalCommand: ReturnType<typeof vi.fn>
  sendOmpRpcChat: ReturnType<typeof vi.fn>
  sendOmpRpcCommand: ReturnType<typeof vi.fn>
  claimOmpRpcInteractiveCommand: ReturnType<typeof vi.fn>
  resolveTarget: ReturnType<typeof vi.fn>
  onSlashCommand: ReturnType<typeof vi.fn>
} {
  const setNotice = vi.fn()
  const setHistory = vi.fn()
  const setDraft = vi.fn()
  const setCaret = vi.fn()
  const clearSkillOrigin = vi.fn()
  const clearImageAttachments = vi.fn()
  const trackPendingSend = vi.fn()
  const sendOmpLocalCommand = vi.fn(() => false)
  const sendOmpRpcChat = vi.fn(() => false)
  const sendOmpRpcCommand = vi.fn(() => false)
  const claimOmpRpcInteractiveCommand = vi.fn(() => false)
  const resolveTarget = vi.fn((): NativeChatResolvedTarget | null => null)
  const onSlashCommand = vi.fn()
  const classification: NativeChatSendClassification = 'chat'
  const classifySend = vi.fn(() => classification)
  const args: UseNativeChatComposerSendArgs = {
    agent: 'codex',
    terminalTabId: 'tab-1',
    draft: 'hello',
    imageAttachments: [],
    hasPendingAttachment: false,
    disabled: false,
    isDispatchingSessionOption: false,
    launchDraftResolved: false,
    readTerminalScreen: () => null,
    resolveTarget,
    classifySend,
    sendOmpLocalCommand,
    sendOmpRpcChat,
    sendOmpRpcCommand,
    claimOmpRpcInteractiveCommand,
    sessionOptionsSurface: null,
    trackPendingSend,
    setHistory,
    setDraft,
    setCaret,
    clearSkillOrigin,
    clearImageAttachments,
    setNotice,
    onSlashCommand,
    ...overrides
  }
  return {
    args,
    setNotice: args.setNotice as ReturnType<typeof vi.fn>,
    setHistory: args.setHistory as ReturnType<typeof vi.fn>,
    setDraft: args.setDraft as ReturnType<typeof vi.fn>,
    sendOmpLocalCommand: args.sendOmpLocalCommand as ReturnType<typeof vi.fn>,
    sendOmpRpcChat: args.sendOmpRpcChat as ReturnType<typeof vi.fn>,
    sendOmpRpcCommand: args.sendOmpRpcCommand as ReturnType<typeof vi.fn>,
    claimOmpRpcInteractiveCommand: args.claimOmpRpcInteractiveCommand as ReturnType<typeof vi.fn>,
    resolveTarget: args.resolveTarget as ReturnType<typeof vi.fn>,
    onSlashCommand: args.onSlashCommand as ReturnType<typeof vi.fn>
  }
}

function image(id: string): NativeChatComposerImageAttachment {
  return { id, path: `/tmp/${id}.png` }
}

describe('useNativeChatComposerSend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendNativeChatMessage.mockReturnValue({ cancel: vi.fn(), settleAfterMs: 0 })
    sendNativeChatTypedCommand.mockReturnValue({ cancel: vi.fn(), settleAfterMs: 0 })
  })

  it('runs an OMP local command over RPC without ever resolving a PTY target (D1)', () => {
    const { args, resolveTarget, sendOmpLocalCommand, setDraft } = buildArgs({
      draft: '/usage',
      sendOmpLocalCommand: vi.fn(() => true)
    })
    const { result } = renderHook(() => useNativeChatComposerSend(args))

    act(() => result.current())

    expect(sendOmpLocalCommand).toHaveBeenCalledWith('/usage')
    expect(resolveTarget).not.toHaveBeenCalled()
    expect(setDraft).toHaveBeenCalledWith('')
  })

  it('routes a catalog command to the RPC session without ever resolving a PTY target', () => {
    const { args, resolveTarget, sendOmpRpcCommand, setDraft } = buildArgs({
      draft: '/help',
      classifySend: vi.fn((): NativeChatSendClassification => 'command'),
      sendOmpRpcCommand: vi.fn(() => true)
    })
    const { result } = renderHook(() => useNativeChatComposerSend(args))

    act(() => result.current())

    expect(sendOmpRpcCommand).toHaveBeenCalledWith('/help')
    expect(resolveTarget).not.toHaveBeenCalled()
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(setDraft).toHaveBeenCalledWith('')
  })

  it('opens an interactive command card instead of sending the command over the wire', () => {
    // The ordering IS the fix: sending `/switch` as text gets a degraded
    // one-liner back, so the card claim has to be asked first.
    const {
      args,
      claimOmpRpcInteractiveCommand,
      sendOmpRpcCommand,
      sendOmpLocalCommand,
      setDraft
    } = buildArgs({
      draft: '/switch',
      classifySend: vi.fn((): NativeChatSendClassification => 'command'),
      claimOmpRpcInteractiveCommand: vi.fn(() => true),
      sendOmpRpcCommand: vi.fn(() => true)
    })
    const { result } = renderHook(() => useNativeChatComposerSend(args))

    act(() => result.current())

    expect(claimOmpRpcInteractiveCommand).toHaveBeenCalledWith('/switch')
    expect(sendOmpRpcCommand).not.toHaveBeenCalled()
    expect(sendOmpLocalCommand).not.toHaveBeenCalled()
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(setDraft).toHaveBeenCalledWith('')
  })

  it('sends the command over the wire when no card claims it', () => {
    const { args, sendOmpRpcCommand } = buildArgs({
      draft: '/switch gpt-6-astra',
      classifySend: vi.fn((): NativeChatSendClassification => 'command'),
      claimOmpRpcInteractiveCommand: vi.fn(() => false),
      sendOmpRpcCommand: vi.fn(() => true)
    })
    const { result } = renderHook(() => useNativeChatComposerSend(args))

    act(() => result.current())

    expect(sendOmpRpcCommand).toHaveBeenCalledWith('/switch gpt-6-astra')
  })

  it('keeps a command on the PTY when the RPC session declines it', () => {
    const { args, sendOmpRpcCommand } = buildArgs({
      draft: '/help',
      classifySend: vi.fn((): NativeChatSendClassification => 'command'),
      sendOmpRpcCommand: vi.fn(() => false),
      resolveTarget: vi.fn(() => ({ settings: {}, ptyId: 'pty-1' }) as NativeChatResolvedTarget)
    })
    const { result } = renderHook(() => useNativeChatComposerSend(args))

    act(() => result.current())

    expect(sendOmpRpcCommand).toHaveBeenCalledWith('/help')
    // buildArgs' default agent is codex, whose commands take the typed path.
    expect(sendNativeChatTypedCommand).toHaveBeenCalledWith({}, 'pty-1', '/help')
  })

  it('keeps a command with an image attachment on the PTY path — RPC send is text-only', () => {
    const { args, sendOmpRpcCommand } = buildArgs({
      draft: '/help',
      imageAttachments: [image('a')],
      classifySend: vi.fn((): NativeChatSendClassification => 'command'),
      sendOmpRpcCommand: vi.fn(() => true)
    })
    const { result } = renderHook(() => useNativeChatComposerSend(args))

    act(() => result.current())

    expect(sendOmpRpcCommand).not.toHaveBeenCalled()
  })

  it('routes a chat prompt to the RPC session without ever resolving a PTY target (D1/D6)', () => {
    const { args, resolveTarget, sendOmpRpcChat, setDraft } = buildArgs({
      classifySend: vi.fn((): NativeChatSendClassification => 'chat'),
      sendOmpRpcChat: vi.fn(() => true)
    })
    const { result } = renderHook(() => useNativeChatComposerSend(args))

    act(() => result.current())

    expect(sendOmpRpcChat).toHaveBeenCalledWith('hello')
    expect(resolveTarget).not.toHaveBeenCalled()
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(setDraft).toHaveBeenCalledWith('')
  })

  it('sends via the PTY when a target resolves and nothing above claims the draft (regression)', () => {
    const { args } = buildArgs({
      classifySend: vi.fn((): NativeChatSendClassification => 'chat'),
      resolveTarget: vi.fn(() => PTY_TARGET)
    })
    const { result } = renderHook(() => useNativeChatComposerSend(args))

    act(() => result.current())

    expect(sendNativeChatMessage).toHaveBeenCalledWith({}, 'pty-1', 'hello', undefined)
  })

  it('shows a notice instead of silently dropping a PTY-only command with no PTY and no RPC route for it', () => {
    const { args, setNotice, setDraft } = buildArgs({
      draft: '/model',
      classifySend: vi.fn((): NativeChatSendClassification => 'command'),
      resolveTarget: vi.fn(() => null)
    })
    const { result } = renderHook(() => useNativeChatComposerSend(args))

    act(() => result.current())

    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    expect(sendNativeChatTypedCommand).not.toHaveBeenCalled()
    expect(setNotice).toHaveBeenCalledWith(expect.any(String))
    expect(setNotice.mock.calls.at(-1)?.[0]).not.toBeNull()
    // Nothing was sent: the draft must not be cleared out from under the user.
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('shows a notice instead of silently dropping an image attachment when there is no PTY (RPC send is text-only)', () => {
    const { args, setNotice } = buildArgs({
      imageAttachments: [image('a')],
      classifySend: vi.fn((): NativeChatSendClassification => 'chat'),
      sendOmpRpcChat: vi.fn(() => true), // must never be reached: images always keep the PTY path
      resolveTarget: vi.fn(() => null)
    })
    const { result } = renderHook(() => useNativeChatComposerSend(args))

    act(() => result.current())

    expect(args.sendOmpRpcChat).not.toHaveBeenCalled()
    expect(sendNativeChatMessageWithImageAttachments).not.toHaveBeenCalled()
    expect(setNotice).toHaveBeenCalledWith(expect.any(String))
  })

  it('does nothing when the composer is disabled', () => {
    const { args, resolveTarget, sendOmpLocalCommand } = buildArgs({ disabled: true })
    const { result } = renderHook(() => useNativeChatComposerSend(args))

    act(() => result.current())

    expect(resolveTarget).not.toHaveBeenCalled()
    expect(sendOmpLocalCommand).not.toHaveBeenCalled()
  })

  describe('terminal-only OMP commands', () => {
    // OMP forwards a builtin with no text handler straight to the model
    // (rpc-mode.ts), so these must never reach any send route.
    it('answers a bare invocation with a local notice and sends nothing', () => {
      for (const command of ['/settings', '/agents']) {
        vi.clearAllMocks()
        const {
          args,
          onSlashCommand,
          resolveTarget,
          sendOmpRpcCommand,
          sendOmpLocalCommand,
          sendOmpRpcChat,
          setDraft
        } = buildArgs({
          agent: 'omp',
          draft: command,
          classifySend: vi.fn((): NativeChatSendClassification => 'unknown-token')
        })
        const { result } = renderHook(() => useNativeChatComposerSend(args))

        act(() => result.current())

        const entry = findOmpRpcTerminalOnlyCommand(command)
        expect(entry, `${command} must be a table row`).not.toBeNull()
        expect(onSlashCommand).toHaveBeenCalledWith(command, {
          outputText: ompRpcTerminalOnlyCommandNotice(entry!, isMacPlatform()),
          agentInvoked: false
        })
        expect(sendOmpRpcCommand).not.toHaveBeenCalled()
        expect(sendOmpLocalCommand).not.toHaveBeenCalled()
        expect(sendOmpRpcChat).not.toHaveBeenCalled()
        expect(resolveTarget).not.toHaveBeenCalled()
        expect(sendNativeChatMessage).not.toHaveBeenCalled()
        expect(setDraft).toHaveBeenCalledWith('')
      }
    })

    it('leaves an argumented invocation on its existing route', () => {
      const { args, onSlashCommand } = buildArgs({
        agent: 'omp',
        draft: '/settings something',
        classifySend: vi.fn((): NativeChatSendClassification => 'unknown-token'),
        resolveTarget: vi.fn(() => PTY_TARGET)
      })
      const { result } = renderHook(() => useNativeChatComposerSend(args))

      act(() => result.current())

      expect(sendNativeChatMessage).toHaveBeenCalledWith(
        {},
        'pty-1',
        '/settings something',
        undefined
      )
      expect(onSlashCommand).not.toHaveBeenCalled()
    })

    // A card is strictly better than "go to the terminal", so a table row must
    // never be able to intercept a command a card drives.
    it('never diverts a card-backed command, even when the card claim declines', () => {
      const { args, onSlashCommand, sendOmpRpcCommand } = buildArgs({
        agent: 'omp',
        draft: '/switch',
        classifySend: vi.fn((): NativeChatSendClassification => 'command'),
        claimOmpRpcInteractiveCommand: vi.fn(() => false),
        sendOmpRpcCommand: vi.fn(() => true)
      })
      const { result } = renderHook(() => useNativeChatComposerSend(args))

      act(() => result.current())

      expect(sendOmpRpcCommand).toHaveBeenCalledWith('/switch')
      expect(onSlashCommand).not.toHaveBeenCalled()
    })

    // `/plan` is a real Codex command that its TUI runs; only OMP's registry
    // makes it terminal-only.
    it('leaves an identically-named command on a non-OMP agent alone', () => {
      const { args, onSlashCommand } = buildArgs({
        agent: 'codex',
        draft: '/plan',
        classifySend: vi.fn((): NativeChatSendClassification => 'command'),
        resolveTarget: vi.fn(() => PTY_TARGET)
      })
      const { result } = renderHook(() => useNativeChatComposerSend(args))

      act(() => result.current())

      expect(sendNativeChatTypedCommand).toHaveBeenCalledWith({}, 'pty-1', '/plan')
      expect(onSlashCommand).toHaveBeenCalledWith('/plan')
    })
  })
})
