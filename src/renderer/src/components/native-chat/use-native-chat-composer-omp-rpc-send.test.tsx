// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useNativeChatComposerOmpRpcSend } from './use-native-chat-composer-omp-rpc-send'
import { isMacPlatform } from './native-chat-shortcut'
import { ompRpcCardCommandUnavailableNotice } from './omp-rpc-terminal-only-commands'

describe('useNativeChatComposerOmpRpcSend', () => {
  it('applies follow-up to one send and clears the toggle immediately', () => {
    const send = vi.fn().mockResolvedValue({ ok: true })
    const { result } = renderHook(() =>
      useNativeChatComposerOmpRpcSend({
        agent: 'omp',
        ompRpcChat: { isOwned: true, isTurnWorking: true, send },
        setNotice: vi.fn()
      })
    )

    act(() => result.current.followUp?.onToggle())
    expect(result.current.followUp?.active).toBe(true)

    act(() => expect(result.current.sendOmpRpcChat('later')).toBe(true))
    expect(send).toHaveBeenCalledWith({ message: 'later', behavior: 'followUp' })
    expect(result.current.followUp?.active).toBe(false)
  })

  it('routes a chat send rejected after unmount to the pane-owned notice', async () => {
    // The binding wiring is what a hook-level test cannot see: without it the
    // durable reporter is undefined and the failure dies with the composer.
    let reject: ((error: Error) => void) | undefined
    const send = vi.fn(
      () =>
        new Promise<never>((_resolve, settle) => {
          reject = settle
        })
    )
    const reportMessageFailure = vi.fn()
    const setNotice = vi.fn()
    const hook = renderHook(() =>
      useNativeChatComposerOmpRpcSend({
        agent: 'omp',
        ompRpcChat: { isOwned: true, isTurnWorking: false, send, reportMessageFailure },
        setNotice
      })
    )

    act(() => expect(hook.result.current.sendOmpRpcChat('hello')).toBe(true))
    hook.unmount()
    await act(async () => {
      reject?.(new Error('handler torn down'))
    })

    expect(reportMessageFailure).toHaveBeenCalledTimes(1)
    expect(setNotice).not.toHaveBeenCalled()
  })

  it('routes the echo retraction of a failed send through the binding', async () => {
    // Binding wiring the hook-level test cannot see: leave
    // `onOptimisticSendCanceled` unthreaded here and a failed message keeps
    // rendering as delivered in the pane cache, whichever notice route ran.
    let reject: ((error: Error) => void) | undefined
    const send = vi.fn(
      () =>
        new Promise<never>((_resolve, settle) => {
          reject = settle
        })
    )
    const onOptimisticSend = vi.fn().mockReturnValue('pending-1')
    const onOptimisticSendCanceled = vi.fn()
    const hook = renderHook(() =>
      useNativeChatComposerOmpRpcSend({
        agent: 'omp',
        ompRpcChat: { isOwned: true, isTurnWorking: false, send },
        onOptimisticSend,
        onOptimisticSendCanceled,
        setNotice: vi.fn()
      })
    )

    act(() => expect(hook.result.current.sendOmpRpcChat('hello')).toBe(true))
    await act(async () => {
      reject?.(new Error('handler torn down'))
    })

    expect(onOptimisticSendCanceled).toHaveBeenCalledExactlyOnceWith('pending-1')
  })

  it("fences the pane-owned message notice with the binding's session generation", async () => {
    // The binding wiring again: the reporter is only safe if the generation
    // reaches it, otherwise the notice lands in whatever session holds the
    // paneKey when the rejection settles.
    let reject: ((error: Error) => void) | undefined
    const send = vi.fn(
      () =>
        new Promise<never>((_resolve, settle) => {
          reject = settle
        })
    )
    const reportMessageFailure = vi.fn()
    const hook = renderHook(() =>
      useNativeChatComposerOmpRpcSend({
        agent: 'omp',
        ompRpcChat: {
          isOwned: true,
          isTurnWorking: false,
          send,
          reportMessageFailure,
          sessionGeneration: 7
        },
        setNotice: vi.fn()
      })
    )

    act(() => expect(hook.result.current.sendOmpRpcChat('hello')).toBe(true))
    hook.unmount()
    await act(async () => {
      reject?.(new Error('handler torn down'))
    })

    expect(reportMessageFailure).toHaveBeenCalledWith(7)
  })

  describe('claimOmpRpcInteractiveCommand', () => {
    function claim(
      text: string,
      binding: {
        isOwned?: boolean
        agent?: 'omp' | 'claude'
        /** Panes whose binding exposes no card opener cannot drive a card
         *  either, so they must answer locally rather than fall through. */
        withCardOpener?: boolean
        /** A caller with no marker sink cannot render the notice. */
        withSlashCommand?: boolean
      } = {}
    ): {
      claimed: boolean
      openInteractiveCard: ReturnType<typeof vi.fn>
      onSlashCommand: ReturnType<typeof vi.fn>
    } {
      const openInteractiveCard = vi.fn()
      const onSlashCommand = vi.fn()
      const hook = renderHook(() =>
        useNativeChatComposerOmpRpcSend({
          agent: binding.agent ?? 'omp',
          ompRpcChat: {
            isOwned: binding.isOwned ?? true,
            isTurnWorking: false,
            send: vi.fn().mockResolvedValue({ ok: true }),
            ...(binding.withCardOpener === false ? {} : { openInteractiveCard })
          },
          ...(binding.withSlashCommand === false ? {} : { onSlashCommand }),
          setNotice: vi.fn()
        })
      )
      return {
        claimed: hook.result.current.claimOmpRpcInteractiveCommand(text),
        openInteractiveCard,
        onSlashCommand
      }
    }

    it('claims a bare registered command and opens its card under the canonical name', () => {
      const bare = claim('/switch')
      expect(bare.claimed).toBe(true)
      expect(bare.openInteractiveCard).toHaveBeenCalledWith('switch')
      expect(bare.onSlashCommand).not.toHaveBeenCalled()

      const alias = claim('/model')
      expect(alias.claimed).toBe(true)
      expect(alias.openInteractiveCard).toHaveBeenCalledWith('switch')
    })

    it('leaves an argumented invocation on the existing wire route', () => {
      const argumented = claim('/switch gpt-6-astra')
      expect(argumented.claimed).toBe(false)
      expect(argumented.openInteractiveCard).not.toHaveBeenCalled()

      // Same on a pane with no session: an argumented invocation is a real
      // wire command OMP answers, so it keeps the route it has today.
      const unowned = claim('/switch gpt-6-astra', { isOwned: false })
      expect(unowned.claimed).toBe(false)
      expect(unowned.onSlashCommand).not.toHaveBeenCalled()
    })

    // The trap this replaces (live, omp 18.1.15): the draft fell through to
    // the PTY, OMP's model picker opened behind the chat view, and every
    // later message was swallowed by that invisible overlay.
    it('answers a card-backed command locally when the pane cannot drive a card', () => {
      const notice = ompRpcCardCommandUnavailableNotice('switch', isMacPlatform())
      for (const binding of [{ isOwned: false }, { withCardOpener: false }]) {
        const unavailable = claim('/switch', binding)
        expect(unavailable.claimed).toBe(true)
        expect(unavailable.openInteractiveCard).not.toHaveBeenCalled()
        expect(unavailable.onSlashCommand).toHaveBeenCalledWith('/switch', {
          outputText: notice,
          agentInvoked: false
        })
      }
    })

    it('declines instead of swallowing the draft when nothing can render the notice', () => {
      const noSink = claim('/switch', { isOwned: false, withSlashCommand: false })
      expect(noSink.claimed).toBe(false)
      expect(noSink.openInteractiveCard).not.toHaveBeenCalled()
    })

    it('claims nothing on a non-OMP agent', () => {
      const claude = claim('/switch', { agent: 'claude' })
      expect(claude.claimed).toBe(false)
      expect(claude.onSlashCommand).not.toHaveBeenCalled()
    })

    it('leaves an unregistered command alone', () => {
      const unregistered = claim('/usage')
      expect(unregistered.claimed).toBe(false)
      expect(unregistered.openInteractiveCard).not.toHaveBeenCalled()
      expect(unregistered.onSlashCommand).not.toHaveBeenCalled()
    })
  })
})
