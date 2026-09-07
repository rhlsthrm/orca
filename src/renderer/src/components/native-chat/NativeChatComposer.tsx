import { forwardRef, useCallback, useImperativeHandle, useState } from 'react'
import { useAppStore } from '../../store'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
<<<<<<< HEAD

import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { useOmpRpcCommands, useOmpRpcProbeCwd } from './use-omp-rpc-commands'
import { useOmpRpcLocalCommandSend } from './use-omp-rpc-local-command-send'
import { useNativeChatComposerTextEditing } from './use-native-chat-composer-text-editing'
import { translate } from '@/i18n/i18n'
import { useNativeChatComposerOmpRpcSend } from './use-native-chat-composer-omp-rpc-send'
import { useNativeChatComposerSend } from './use-native-chat-composer-send'
import { EMPTY_HISTORY, type HistoryState } from './native-chat-composer-state'
import { readNativeChatDraftCache } from './native-chat-draft-cache'
||||||| 8fa1b3c16c
import {
  sendNativeChatMessage,
  sendNativeChatTypedCommand,
  submitNativeChatPrompt
} from './native-chat-runtime-send'
import type { NativeChatSendHandle } from './native-chat-runtime-send'
import { sendNativeChatMessageWithImageAttachments } from './native-chat-runtime-image-send'
import { resolveNativeChatLaunchDraftSend } from './native-chat-launch-draft-send'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { isSlashCommandDraft } from '../../../../shared/native-chat-slash-commands'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import {
  applyMentionSuggestion,
  EMPTY_HISTORY,
  pushHistory,
  type HistoryState
} from './native-chat-composer-state'
import { readNativeChatDraftCache } from './native-chat-draft-cache'
=======
import {
  applyMentionSuggestion,
  EMPTY_HISTORY,
  type HistoryState
} from './native-chat-composer-state'
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
import { useNativeChatDraft } from './use-native-chat-draft'
import { useNativeChatLaunchDraftAdoption } from './use-native-chat-launch-draft-adoption'
import { NativeChatComposerField } from './NativeChatComposerField'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'
import { useNativeChatExternalAttachments } from './use-native-chat-external-attachments'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import { useNativeChatSendLifecycle } from './use-native-chat-send-lifecycle'
import { useNativeChatSessionOptions } from './use-native-chat-session-options'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'
import { useNativeChatDictationActions } from './use-native-chat-dictation-actions'
import { useNativeChatSessionOptionCommand } from './use-native-chat-session-option-command'
import { useNativeChatComposerCatalog } from './use-native-chat-composer-catalog'
import { useOmpRpcCommands, useOmpRpcProbeCwd } from './use-omp-rpc-commands'
import { useOmpRpcLocalCommandSend } from './use-omp-rpc-local-command-send'
import { useNativeChatComposerCommandFailureNotice } from './use-native-chat-composer-command-failure-notice'
import {
  OMP_RPC_CHAT_DISABLED,
  useNativeChatComposerOmpRpcSend
} from './use-native-chat-composer-omp-rpc-send'
import { useNativeChatComposerSend } from './use-native-chat-composer-send'
import { useNativeChatPickerState } from './use-native-chat-picker-state'
import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'
import { useNativeChatTypedInsertion } from './use-native-chat-typed-insertion'
import type {
  NativeChatComposerHandle,
  NativeChatComposerOmpRpcBinding,
  NativeChatComposerProps
} from './native-chat-composer-types'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { useNativeChatComposerAppMenuSelection } from './use-native-chat-composer-app-menu-selection'

export type {
  NativeChatComposerHandle,
  NativeChatComposerOmpRpcBinding,
  NativeChatComposerProps
} from './native-chat-composer-types'

// Why: a plain ESC byte is what the agent TUIs read as the interrupt key over a
// PTY (matching how xterm forwards Escape). The richer interrupt-intent
// inference (agent-interrupt-intent.ts) is driven by the existing PTY input
// observers, so writing ESC through the same send path feeds that machinery.
const ESC = '\x1b'

// Why: a stable module-level fallback so an unset `ompRpcChat` prop never
// re-creates a fresh object (and a fresh `send` identity) on every render.
const OMP_RPC_CHAT_DISABLED: NativeChatComposerOmpRpcBinding = {
  isOwned: false,
  isTurnWorking: false,
  send: () => Promise.resolve({ ok: false, reason: 'not-available' })
}

/**
 * Rich native input for the chat view. Sends prompts into the running agent
 * through the same verified runtime path as typed input (KTD4), so the agent
 * cannot distinguish native input from keystrokes. Enter sends; Shift+Enter
 * inserts a newline; multi-line is bracketed-paste wrapped; Esc interrupts.
 * Slash-command and `@file` autocomplete are agent-aware; image paste persists a
 * temp file and injects the agent-appropriate path (or reports unsupported).
 */
const NativeChatComposerPane = forwardRef<NativeChatComposerHandle, NativeChatComposerProps>(
  function NativeChatComposerPane(
    {
      terminalTabId,
      paneKey,
      targetPtyId,
      agent,
      canSend = true,
      isWorking = false,
      onStop,
      onOptimisticSend,
      onOptimisticSendCanceled,
      onSlashCommand,
      onSwitchToTerminal,
      readTerminalScreen,
<<<<<<< HEAD
      launchDraft,
      launchDraftResolved = false,
||||||| 8fa1b3c16c
      launchDraft,
      launchDraftResolved = false
=======
      launchSeed,
      structuredTransport,
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
      ompRpcChat = OMP_RPC_CHAT_DISABLED
    },
    ref
  ): React.JSX.Element {
    // Scope key shared with image attachments so an unsent draft + its attached
    // images survive both TUI/GUI toggles and PTY replacement on reconnect.
    // Why: local, SSH, and runtime reconnects can replace or temporarily clear
    // the PTY id. Pane identity is the stable ownership key for unsent input.
    const { draft, setDraft } = useNativeChatDraft(paneKey)
    const [caret, setCaret] = useState(draft.length)
    useNativeChatLaunchDraftAdoption({
      terminalTabId,
      agent,
      launchDraft: launchSeed?.launchDraft,
      launchDraftResolved: launchSeed?.launchDraftResolved === true,
      ownsTabWideLaunchDraft: launchSeed?.ownsTabWideLaunchDraft === true,
      draft,
      setDraft,
      setCaret
    })
    const [history, setHistory] = useState<HistoryState>(EMPTY_HISTORY)
    const [activeSuggestion, setActiveSuggestion] = useState(0)
    const [notice, setNotice] = useState<string | null>(null)
    useNativeChatComposerCommandFailureNotice({ ompRpcChat, setNotice })
    const [dictationPressed, setDictationPressed] = useState(false)
<<<<<<< HEAD
    const textareaRef = useRef<HTMLTextAreaElement>(null)
||||||| 8fa1b3c16c
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const isComposingRef = useRef(false)
=======
    const imeEnterGesture = useImeEnterGestureOwnership()
    const { textareaRef } = useNativeChatComposerAppMenuSelection(imeEnterGesture.isComposing)
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
    const { cancelPendingSends, trackPendingSend } = useNativeChatSendLifecycle(
      terminalTabId,
      targetPtyId,
      onOptimisticSendCanceled
    )
    const dictationState = useAppStore((store) => store.dictationState)
    const voiceSettings = useAppStore((store) => store.settings?.voice)
    const dictationDisabled = voiceSettings?.enabled !== true || !voiceSettings.sttModel
    const isDictating =
      dictationPressed ||
      dictationState === 'starting' ||
      dictationState === 'listening' ||
      dictationState === 'stopping'

<<<<<<< HEAD
    // Place the caret at the end of the (possibly restored) draft when the
    // composer is reused for a different pane. Adjusted during render (matching
    // the draft reload) so caret and text stay consistent on the first paint.
    const lastDraftScopeKey = useRef(draftScopeKey)
    if (lastDraftScopeKey.current !== draftScopeKey) {
      lastDraftScopeKey.current = draftScopeKey
      setCaret(readNativeChatDraftCache(draftScopeKey).length)
    }

    const staticAgentCommands = useMemo(() => getVerifiedNativeChatCommands(agent), [agent])
    // OMP publishes its catalog over RPC; every other agent keeps the static one.
    const agentCommands = useOmpRpcCommands(agent, terminalTabId, staticAgentCommands)
||||||| 8fa1b3c16c
    // Place the caret at the end of the (possibly restored) draft when the
    // composer is reused for a different pane. Adjusted during render (matching
    // the draft reload) so caret and text stay consistent on the first paint.
    const lastDraftScopeKey = useRef(draftScopeKey)
    if (lastDraftScopeKey.current !== draftScopeKey) {
      lastDraftScopeKey.current = draftScopeKey
      setCaret(readNativeChatDraftCache(draftScopeKey).length)
    }

    const agentCommands = useMemo(() => getVerifiedNativeChatCommands(agent), [agent])
=======
    const { agentCommands: staticAgentCommands, sessionSkillNames } =
      useNativeChatComposerCatalog(agent, structuredTransport)
    const agentCommands = useOmpRpcCommands(
      agent,
      terminalTabId,
      staticAgentCommands,
      ompRpcChat.commands
    )
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
    const ompRpcCwd = useOmpRpcProbeCwd(agent, terminalTabId)
    const picker = useNativeChatPickerState({
      agent,
      terminalTabId,
      draftScopeKey: paneKey,
      draft,
      caret,
      agentCommands,
      sessionSkillNames,
      textareaRef,
      setDraft,
      setCaret,
      setActiveSuggestion
    })
    const {
      autocomplete,
      classifySend,
      clearSkillOrigin,
      completeItem,
      dismiss,
      handleDraftOrCaretChange
    } = picker
    const textEditing = useNativeChatComposerTextEditing({
      draft,
      caret,
      autocomplete,
      textareaRef,
      setDraft,
      setCaret,
      setHistory,
      setActiveSuggestion,
      handleDraftOrCaretChange
    })

    // Resolve the live ptyId for this chat leaf; runtime owner settings route
    // local vs remote (SSH) sends.
    const resolveTarget = useCallback((): NativeChatResolvedTarget | null => {
      if (!targetPtyId) {
        return null
      }
      return { ptyId: targetPtyId, settings: getSettingsForAgentTabRuntimeOwner(terminalTabId) }
    }, [targetPtyId, terminalTabId])

<<<<<<< HEAD
    // D1: RPC ownership of this pane is an equally valid send route as a
    // live PTY — acquisition deliberately kills the PTY on success
    // (killPtyBeforeOmpRpcAcquire), so requiring one here made a
    // *successful* acquisition the thing that broke sending. Only a
    // genuine absence of every route, or the multi-device input lock
    // (canSend), disables typing/sending; PTY-only affordances (image
    // attachments, PTY-routed slash commands) gate individually below on
    // `hasPty` instead of widening this flag.
    const hasPty = targetPtyId !== null
    const hasSendRoute = hasPty || ompRpcChat.isOwned
    const disabled = !hasSendRoute || !canSend
    // Images always ride the PTY this milestone (RPC send is text-only,
    // wave 2) — the attach affordance must read as unavailable rather than
    // accept a click that attachResolvedPaths would only reject.
    const attachDisabled = !hasPty || !canSend
||||||| 8fa1b3c16c
    const [hasPty, disabled] = [targetPtyId !== null, targetPtyId === null || !canSend]

    const syncCaret = useCallback((el: HTMLTextAreaElement) => {
      setCaret(el.selectionStart ?? el.value.length)
    }, [])
=======
    const hasPty = targetPtyId !== null
    const hasSendRoute = Boolean(structuredTransport) || hasPty || ompRpcChat.isOwned
    const disabled = !hasSendRoute || !canSend

    const syncCaret = useCallback((el: HTMLTextAreaElement) => {
      setCaret(el.selectionStart ?? el.value.length)
    }, [])
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d

    const attachments = useNativeChatComposerAttachments({
      attachmentScopeKey: paneKey,
      allowWithoutTarget: Boolean(structuredTransport),
      caret,
      disabled,
      isComposing: imeEnterGesture.isComposing,
      resolveTarget,
      textareaRef,
      setCaret,
      setDraft,
      setNotice
    })
    const {
      imageAttachments,
      attachResolvedPaths,
      clearImageAttachments,
      removeImageAttachment,
      beginPendingImageAttachment,
      resolvePendingImageAttachment,
      dropPendingImageAttachment
    } = attachments
    // A pasted image has no agent-readable path until its save lands; sending
    // mid-save would ship the message without the image the chip promises.
    const hasPendingAttachment = imageAttachments.some((attachment) => attachment.pending)
    const sendButtonDisabled = isWorking
      ? !hasSendRoute || !onStop
<<<<<<< HEAD
      : disabled || (draft.trim() === '' && imageAttachments.length === 0)
||||||| 8fa1b3c16c
      ? !hasPty || !onStop
      : disabled || (draft.trim() === '' && imageAttachments.length === 0)
=======
      : disabled || hasPendingAttachment || (draft.trim() === '' && imageAttachments.length === 0)
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d

    const { insertTypedText, focus } = useNativeChatTypedInsertion({
      textareaRef,
      caret,
      draft,
      setDraft,
      setCaret,
      setHistory,
      setActiveSuggestion
    })

    const { attachExternalPaths, resolveAttachmentOwner } = useNativeChatExternalAttachments({
      terminalTabId,
      structuredWorktreeId: structuredTransport?.worktreeId,
      disabled,
      attachResolvedPaths,
      setNotice
    })

    const { handlePaste, pasteFromClipboard } = useNativeChatComposerPaste({
      agent,
      disabled,
      caret,
      resolveAttachmentOwner,
      attachResolvedPaths,
      beginPendingImageAttachment,
      resolvePendingImageAttachment,
      dropPendingImageAttachment,
      insertTypedText,
      setCaret,
      setNotice
    })

    useImperativeHandle(
      ref,
      () => ({ focus, insertTypedText, handlePasteEvent: handlePaste, pasteFromClipboard }),
      [focus, insertTypedText, handlePaste, pasteFromClipboard]
    )

    const { pickAttachment } = useNativeChatFileAttachmentActions(attachExternalPaths)
    const { toggleDictation, startHoldDictation, stopHoldDictation } =
      useNativeChatDictationActions({ textareaRef, setDictationPressed })
    const { dispatch: dispatchSessionOptionCommand, isDispatching: isDispatchingSessionOption } =
      useNativeChatSessionOptionCommand({
        agent,
        disabled,
        onSlashCommand,
        resolveTarget,
        setHistory
      })

    const { surface: ptySessionOptionsSurface, snapshot: ptySessionOptionsSnapshot } =
      useNativeChatSessionOptions({
        agent,
        terminalTabId,
        targetPtyId,
        dispatchCommand: dispatchSessionOptionCommand,
        onAgentPicker: onSwitchToTerminal,
        readTerminalScreen
      })
    const sessionOptionsSurface = structuredTransport?.optionsSurface ?? ptySessionOptionsSurface
    const sessionOptionsSnapshot = structuredTransport?.optionSnapshot ?? ptySessionOptionsSnapshot

    const sendOmpLocalCommand = useOmpRpcLocalCommandSend({
      agent,
      ompRpcCwd,
      resolveTarget,
<<<<<<< HEAD
      onSlashCommand
    })

    const { sendOmpRpcChat, followUp } = useNativeChatComposerOmpRpcSend({
      ompRpcChat,
      onOptimisticSend,
      onSendFailed: () =>
        setNotice(
          translate(
            'components.native-chat.composer.ompRpcSendFailed',
            'Message could not be sent to the agent.'
          )
        )
||||||| 8fa1b3c16c
      classifySend,
      clearSkillOrigin,
      clearImageAttachments,
=======
      onSlashCommand,
      setNotice
    })
    const { sendOmpRpcChat, sendOmpRpcCommand, followUp } = useNativeChatComposerOmpRpcSend({
      agent,
      ompRpcChat,
      onOptimisticSend,
      onOptimisticSendCanceled,
      onSlashCommand,
      setNotice
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
    })

    const send = useNativeChatComposerSend({
      agent,
      terminalTabId,
      draft,
      structuredTransport,
      hasPendingAttachment,
      imageAttachments,
      disabled,
      isDispatchingSessionOption,
      launchDraft: launchSeed?.launchDraft,
      launchDraftResolved: launchSeed?.launchDraftResolved === true,
      readTerminalScreen,
      resolveTarget,
      classifySend,
      sendOmpLocalCommand,
      sendOmpRpcChat,
<<<<<<< HEAD
||||||| 8fa1b3c16c
      onOptimisticSend,
=======
      sendOmpRpcCommand,
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
      onSlashCommand,
      onOptimisticSend,
<<<<<<< HEAD
      sessionOptionsSurface,
||||||| 8fa1b3c16c
      sessionOptionsSurface,
      terminalTabId,
=======
      sessionOptionsSurface: ptySessionOptionsSurface,
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
      trackPendingSend,
      setHistory,
      setDraft,
      setCaret,
      clearSkillOrigin,
      clearImageAttachments,
      setNotice
    })

    const interrupt = useCallback(() => {
      cancelPendingSends()
      if (isWorking && onStop) {
        onStop()
        return
      }
      const target = resolveTarget()
      if (!target) {
        return
      }
      sendRuntimePtyInput(target.settings, target.ptyId, ESC)
    }, [cancelPendingSends, isWorking, onStop, resolveTarget])

    const dispatchPtyPickerCommand = useNativeChatPickerCommandDispatch({
      agent,
      ompRpcCwd,
<<<<<<< HEAD
||||||| 8fa1b3c16c
=======
      sendOmpRpcCommand,
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
      disabled,
      isDispatchingSessionOption,
      resolveTarget,
      onSlashCommand,
      sessionOptionsSurface: ptySessionOptionsSurface,
      trackPendingSend,
      setHistory,
      setDraft,
      setCaret,
      setActiveSuggestion,
      clearSkillOrigin,
      clearImageAttachments,
      setNotice
    })
    const dispatchPickerCommand = useCallback(
      (command: Parameters<typeof dispatchPtyPickerCommand>[0]) => {
        if (structuredTransport) {
          send(`/${command.name}`)
          return
        }
        dispatchPtyPickerCommand(command)
      },
      [dispatchPtyPickerCommand, send, structuredTransport]
    )

    const handleKeyDown = useNativeChatComposerKeyDown({
      autocomplete,
      activeSuggestion,
      draft,
      history,
<<<<<<< HEAD
      isComposing: textEditing.isComposing,
||||||| 8fa1b3c16c
      isComposing: () => isComposingRef.current,
=======
      isComposing: imeEnterGesture.isComposing,
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
      completePickerItem: completeItem,
      dispatchPickerCommand,
      dismissPicker: dismiss,
      interrupt,
      send,
      setActiveSuggestion,
      setDraft,
      setCaret,
      setHistory
    })
    return (
      <NativeChatComposerField
        textareaRef={textareaRef}
        draft={draft}
        disabled={disabled}
        hasSendRoute={hasSendRoute}
        canSend={canSend}
        autocomplete={autocomplete}
        activeSuggestion={activeSuggestion}
        notice={notice}
        imageAttachments={imageAttachments}
        sendButtonDisabled={sendButtonDisabled}
        isWorking={isWorking}
<<<<<<< HEAD
        attachDisabled={attachDisabled}
||||||| 8fa1b3c16c
        attachDisabled={disabled}
=======
        attachDisabled={!canSend || (!hasPty && !structuredTransport)}
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
        dictationDisabled={dictationDisabled}
        isDictating={isDictating}
<<<<<<< HEAD
        isDictationHoldMode={isDictationHoldMode}
        onDraftChange={textEditing.handleDraftChange}
        onTextareaSelect={textEditing.handleTextareaSelect}
||||||| 8fa1b3c16c
        isDictationHoldMode={isDictationHoldMode}
        onDraftChange={handleDraftChange}
        onTextareaSelect={(element) => {
          syncCaret(element)
          handleDraftOrCaretChange(element.value, element.selectionStart ?? element.value.length)
          setActiveSuggestion(0)
        }}
=======
        isDictationHoldMode={voiceSettings?.dictationMode === 'hold'}
        imeEnterGesture={imeEnterGesture}
        onDraftChange={handleDraftChange}
        onTextareaSelect={(element) => {
          syncCaret(element)
          handleDraftOrCaretChange(element.value, element.selectionStart ?? element.value.length)
          setActiveSuggestion(0)
        }}
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
        onKeyDown={handleKeyDown}
<<<<<<< HEAD
        onCompositionStart={textEditing.handleCompositionStart}
        onCompositionEnd={(event) => textEditing.handleCompositionEnd(event.currentTarget)}
||||||| 8fa1b3c16c
        onCompositionStart={() => {
          isComposingRef.current = true
        }}
        onCompositionEnd={(event) => {
          isComposingRef.current = false
          if (event.currentTarget.value !== draft) {
            handleDraftChange(event.currentTarget.value, event.currentTarget)
          }
        }}
=======
        onImeSettled={(element) => {
          if (element.value !== draft) {
            handleDraftChange(element.value, element)
          }
          attachments.flushPendingAttachments()
        }}
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
        onPaste={handlePaste}
        pickerListboxId={picker.listboxId}
        onChoosePickerItem={completeItem}
        onRetrySkills={picker.retrySkills}
        onAcceptMention={textEditing.acceptMention}
        onRemoveImageAttachment={(id) => removeImageAttachment(id)}
        onAttach={pickAttachment}
        onDictationToggle={toggleDictation}
        onDictationHoldStart={startHoldDictation}
        onDictationHoldEnd={stopHoldDictation}
        onSend={send}
        onStop={interrupt}
        sessionOptionsSurface={sessionOptionsSurface}
        sessionOptionsSnapshot={sessionOptionsSnapshot}
<<<<<<< HEAD
||||||| 8fa1b3c16c
=======
        sessionOptionsPickerRequest={structuredTransport?.optionPickerRequest ?? null}
>>>>>>> 8471c69a7eb936467bf9cb94bb459fc92df13a0d
        followUp={followUp}
      />
    )
  }
)

export const NativeChatComposer = forwardRef<NativeChatComposerHandle, NativeChatComposerProps>(
  function NativeChatComposer(props, ref): React.JSX.Element {
    return <NativeChatComposerPane key={props.paneKey} {...props} ref={ref} />
  }
)
