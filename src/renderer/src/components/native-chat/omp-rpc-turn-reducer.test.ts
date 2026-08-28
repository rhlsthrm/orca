import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'
import {
  createInitialOmpRpcTurnState,
  isOmpRpcTurnActive,
  ompRpcTurnReducer,
  OMP_RPC_OVERLAY_ASSISTANT_ID,
  OMP_RPC_OVERLAY_REASONING_ID,
  selectOmpRpcOverlayMessages,
  type OmpRpcTurnState
} from './omp-rpc-turn-reducer'
function frame(event: OmpRpcClientEvent): { type: 'frame'; event: OmpRpcClientEvent } {
  return { type: 'frame', event }
}

function reduceAll(events: OmpRpcClientEvent[]): OmpRpcTurnState {
  return events.reduce(
    (state, event) => ompRpcTurnReducer(state, frame(event)),
    createInitialOmpRpcTurnState()
  )
}

const transcriptAssistant = (text: string): NativeChatMessage => ({
  id: 't-1',
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  timestamp: null,
  source: 'transcript'
})

const transcriptReasoning = (text: string): NativeChatMessage => ({
  id: 't-reasoning-1',
  role: 'reasoning',
  blocks: [{ type: 'text', text }],
  timestamp: null,
  source: 'transcript'
})

describe('ompRpcTurnReducer', () => {
  it('starts idle with no overlay content', () => {
    const state = createInitialOmpRpcTurnState()
    expect(state.status).toBe('idle')
    expect(isOmpRpcTurnActive(state)).toBe(false)
  })

  it('flips to working on agent_start and accumulates text deltas into one block', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Hel' }
        }
      },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'lo' }
        }
      }
    ])
    expect(state.status).toBe('working')
    expect(state.assistantText).toBe('Hello')
    expect(state.blocks).toEqual([{ type: 'text', text: 'Hello' }])
    expect(isOmpRpcTurnActive(state)).toBe(true)
  })

  it('interleaves tool-call and tool-result blocks with surrounding text in order', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Checking...' }
        }
      },
      {
        kind: 'tool-execution-start',
        frame: {
          type: 'tool_execution_start',
          toolCallId: 'c1',
          toolName: 'read',
          input: { path: 'a' }
        }
      },
      {
        kind: 'tool-execution-end',
        frame: { type: 'tool_execution_end', toolCallId: 'c1', content: 'file body' }
      },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Done.' }
        }
      }
    ])
    expect(state.blocks).toEqual([
      { type: 'text', text: 'Checking...' },
      { type: 'tool-call', name: 'read', input: { path: 'a' }, toolCallId: 'c1' },
      { type: 'tool-result', output: 'file body', isError: false, toolCallId: 'c1' },
      { type: 'text', text: 'Done.' }
    ])
  })

  it('accumulates thinking deltas separately from reply text', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'Pondering' }
        }
      },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Answer' }
        }
      }
    ])
    expect(state.reasoningText).toBe('Pondering')
    expect(state.assistantText).toBe('Answer')
  })

  it('resets accumulated content on a fresh agent_start (new turn)', () => {
    const first = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'first turn' }
        }
      }
    ])
    const second = ompRpcTurnReducer(
      first,
      frame({ kind: 'agent-start', frame: { type: 'agent_start' } })
    )
    expect(second.assistantText).toBe('')
    expect(second.blocks).toEqual([])
    expect(second.status).toBe('working')
  })

  it('stays working when agent_end reports isTerminal:false (maintenance continues)', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      { kind: 'agent-end', frame: { type: 'agent_end', isTerminal: false } }
    ])
    expect(state.status).toBe('working')
  })

  it('flips to idle on a terminal agent_end (absent isTerminal counts as terminal)', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    expect(state.status).toBe('idle')
  })

  // F1 (CRITICAL): OMP echoes the user's own turn through message_update with
  // role:'user' and no assistantMessageEvent at all — this must never fault.
  it('treats a message_update with no assistantMessageEvent as a valid non-fatal user echo', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: { type: 'message_update', message: { role: 'user' } }
      },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'reply' }
        }
      }
    ])
    expect(state.status).toBe('working')
    expect(state.assistantText).toBe('reply')
  })

  // F2 (CRITICAL): isOmpRpcTurnActive must be a lifecycle fact (status alone),
  // not content-derived — otherwise every completed turn stays "active" forever.
  it('isOmpRpcTurnActive returns false once a turn completes, even though content survives for the leads compare', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'hi there' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    expect(state.status).toBe('idle')
    expect(state.assistantText).toBe('hi there')
    expect(isOmpRpcTurnActive(state)).toBe(false)
  })

  // F3 (HIGH): a dead transport can no longer be "working" — protocol-fault
  // and exit must clear the working status even though the reducer itself
  // stays a no-op for anything else (the session hook owns the D1 fallback).
  it('clears working status on protocol-fault and exit', () => {
    const faulted = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'partial' }
        }
      },
      { kind: 'protocol-fault', message: 'boom' }
    ])
    expect(faulted.status).toBe('idle')
    expect(isOmpRpcTurnActive(faulted)).toBe(false)

    const exited = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'partial' }
        }
      },
      { kind: 'exit', code: 1, signal: null }
    ])
    expect(exited.status).toBe('idle')
    expect(isOmpRpcTurnActive(exited)).toBe(false)
  })

  // F11 (MEDIUM): a single tool result must not grow renderer state unbounded.
  it('caps a single tool-result output at a byte budget', () => {
    const huge = 'x'.repeat(200_000)
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'tool-execution-end',
        frame: { type: 'tool_execution_end', toolCallId: 'c1', content: huge }
      }
    ])
    const result = state.blocks.find((b) => b.type === 'tool-result')
    expect(result?.type).toBe('tool-result')
    if (result?.type === 'tool-result') {
      expect(result.output.length).toBeLessThan(huge.length)
      expect(result.output).toContain('truncated')
    }
  })
})

describe('selectOmpRpcOverlayMessages', () => {
  it('shows the assistant overlay while working and the transcript has not caught up', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Working on it' }
        }
      }
    ])
    const messages = selectOmpRpcOverlayMessages(state, [])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: OMP_RPC_OVERLAY_ASSISTANT_ID,
      role: 'assistant',
      source: 'rpc'
    })
  })

  it('drops the overlay once the transcript already contains the same text', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Hello' }
        }
      }
    ])
    const messages = selectOmpRpcOverlayMessages(state, [transcriptAssistant('Hello there')])
    expect(messages).toEqual([])
  })

  // W6-1 (CRITICAL, third-lab review q2): a terminal agent_end must not blank
  // the just-finished reply. RPC's agent_end arrives over an already-open
  // stdout pipe with no debounce, while the transcript update goes through a
  // 150ms filesystem-watcher debounce plus IPC plus a re-render — so gating
  // overlay visibility on the binary `working` flag flickered the reply off
  // and back on. The overlay must persist until the transcript demonstrably
  // covers it, whether or not the turn is still working.
  it('keeps rendering the reply after a terminal agent_end until the transcript catches up', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Hello' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    const messages = selectOmpRpcOverlayMessages(state, [])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: OMP_RPC_OVERLAY_ASSISTANT_ID,
      role: 'assistant',
      source: 'rpc'
    })
  })

  it('drops the overlay once the transcript catches up after a terminal agent_end', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Hello' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    expect(selectOmpRpcOverlayMessages(state, [transcriptAssistant('Hello there')])).toEqual([])
  })

  it('keeps rendering reasoning after a terminal agent_end until the transcript catches up', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking hard' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    const messages = selectOmpRpcOverlayMessages(state, [])
    expect(messages.map((m) => m.id)).toEqual([OMP_RPC_OVERLAY_REASONING_ID])
  })

  // Root cause (wave 12): the reasoning overlay was gated by comparing its
  // thinking prose against the transcript's assistant prose, which never
  // matches — the overlay leaked past its turn (rendered after the answer,
  // never retired). It must retire against the transcript's own
  // `role: 'reasoning'` row (wave-7 decoder output) instead.
  it('retires the reasoning overlay once the transcript carries a matching reasoning row', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking hard' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    const transcript = [transcriptReasoning('thinking hard about it'), transcriptAssistant('answer')]
    const messages = selectOmpRpcOverlayMessages(state, transcript)
    expect(messages.map((m) => m.id)).not.toContain(OMP_RPC_OVERLAY_REASONING_ID)
  })

  // Wave 6 anti-flicker preserved: a settled assistant answer alone (no
  // reasoning row yet) must not retire the reasoning overlay — the
  // transcript tailer may still be catching up on the reasoning row
  // specifically, even though the answer already landed.
  it('keeps the reasoning overlay when the transcript has the answer but no reasoning row yet', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking hard' }
        }
      },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'answer' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    const messages = selectOmpRpcOverlayMessages(state, [transcriptAssistant('answer')])
    expect(messages.map((m) => m.id)).toContain(OMP_RPC_OVERLAY_REASONING_ID)
  })

  // D4: once the transcript fully covers a settled turn (both its reasoning
  // row and its answer), no overlay message may render — the visible order
  // comes from the transcript rows alone.
  it('renders zero overlay messages once the transcript fully covers a settled turn', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking hard' }
        }
      },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'answer' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    const transcript = [
      transcriptReasoning('thinking hard about it'),
      transcriptAssistant('the full answer')
    ]
    expect(selectOmpRpcOverlayMessages(state, transcript)).toEqual([])
  })

  // D4: reasoning renders exactly once for a settled turn — the transcript's
  // row once it lands, never the overlay's stale copy alongside it.
  it('never double-renders reasoning once the transcript carries it', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking hard' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    const transcript = [transcriptReasoning('thinking hard'), transcriptAssistant('answer')]
    const overlayIds = selectOmpRpcOverlayMessages(state, transcript).map((m) => m.id)
    const reasoningOccurrences = overlayIds.filter((id) => id === OMP_RPC_OVERLAY_REASONING_ID).length
    expect(reasoningOccurrences).toBe(0)
  })

  it('shows a reasoning overlay ahead of the reply overlay', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' }
        }
      },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'reply' }
        }
      }
    ])
    const messages = selectOmpRpcOverlayMessages(state, [])
    expect(messages.map((m) => m.id)).toEqual([
      OMP_RPC_OVERLAY_REASONING_ID,
      OMP_RPC_OVERLAY_ASSISTANT_ID
    ])
  })

  it('shows a tool-call overlay even with no text yet, while working', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'tool-execution-start',
        frame: { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', input: {} }
      }
    ])
    const messages = selectOmpRpcOverlayMessages(state, [])
    expect(messages).toHaveLength(1)
    expect(messages[0].blocks).toEqual([
      { type: 'tool-call', name: 'read', input: {}, toolCallId: 'c1' }
    ])
  })

  // F8 (MEDIUM): a tool-first turn (empty assistantText) whose tool entry the
  // transcript tailer already surfaced must render it exactly once, not
  // duplicated between the overlay and the transcript.
  it('suppresses an overlay tool block once the transcript already carries its toolCallId', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'tool-execution-start',
        frame: { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', input: {} }
      },
      {
        kind: 'tool-execution-end',
        frame: { type: 'tool_execution_end', toolCallId: 'c1', content: 'done' }
      }
    ])
    const transcript: NativeChatMessage[] = [
      {
        id: 't-tool',
        role: 'tool',
        blocks: [{ type: 'tool-result', output: 'done', toolCallId: 'c1' }],
        timestamp: null,
        source: 'transcript'
      }
    ]
    expect(selectOmpRpcOverlayMessages(state, transcript)).toEqual([])
  })

  // F8: a text-length tie against the transcript must hide only the text
  // block, never the in-flight tool blocks the transcript hasn't caught up to.
  it('keeps in-flight tool blocks visible on a text-length tie with the transcript', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Hello' }
        }
      },
      {
        kind: 'tool-execution-start',
        frame: { type: 'tool_execution_start', toolCallId: 'c2', toolName: 'read', input: {} }
      }
    ])
    // Tie: transcript's last assistant text is exactly as long as the overlay's.
    const messages = selectOmpRpcOverlayMessages(state, [transcriptAssistant('Hello')])
    expect(messages).toHaveLength(1)
    expect(messages[0].blocks).toEqual([
      { type: 'tool-call', name: 'read', input: {}, toolCallId: 'c2' }
    ])
  })
})

describe('extension-ui request queueing', () => {
  it('sets the first select/confirm/input request as pending', () => {
    const state = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({
        kind: 'extension-ui-request',
        frame: {
          type: 'extension_ui_request',
          id: 'ask-1',
          method: 'select',
          options: ['Approve', 'Deny']
        }
      })
    )
    expect(state.pendingExtensionUiRequest?.id).toBe('ask-1')
  })

  it('queues a second request behind the pending one', () => {
    let state = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-1', method: 'select', options: ['Yes'] }
      })
    )
    state = ompRpcTurnReducer(
      state,
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-2', method: 'confirm' }
      })
    )
    expect(state.pendingExtensionUiRequest?.id).toBe('ask-1')
    expect(state.queuedExtensionUiRequests.map((r) => r.id)).toEqual(['ask-2'])
  })

  it('promotes the next queued request once the pending one is answered', () => {
    let state = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-1', method: 'select', options: ['Yes'] }
      })
    )
    state = ompRpcTurnReducer(
      state,
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-2', method: 'confirm' }
      })
    )
    state = ompRpcTurnReducer(state, { type: 'extension-ui-answered', requestId: 'ask-1' })
    expect(state.pendingExtensionUiRequest?.id).toBe('ask-2')
    expect(state.queuedExtensionUiRequests).toEqual([])
  })

  it('dismisses the pending request on a cancel-method frame with the same id', () => {
    let state = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-1', method: 'select', options: ['Yes'] }
      })
    )
    state = ompRpcTurnReducer(
      state,
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-1', method: 'cancel' }
      })
    )
    expect(state.pendingExtensionUiRequest).toBeNull()
  })

  it('ignores notify/setStatus/setWidget methods (log-and-ignore scope)', () => {
    const state = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({
        kind: 'extension-ui-request',
        frame: {
          type: 'extension_ui_request',
          id: 'w-1',
          method: 'setWidget',
          widgetKey: 'autoresearch'
        }
      })
    )
    expect(state.pendingExtensionUiRequest).toBeNull()
    expect(state.queuedExtensionUiRequests).toEqual([])
  })

  // F6 (HIGH): a select with no non-empty options renders zero buttons — the
  // reducer must not promote it to pendingExtensionUiRequest (it would wedge
  // the pane, since the composer is unmounted while a request is pending).
  it('never promotes a select request with absent or empty options', () => {
    const absentOptions = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-empty-1', method: 'select' }
      })
    )
    expect(absentOptions.pendingExtensionUiRequest).toBeNull()

    const emptyOptions = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-empty-2', method: 'select', options: [] }
      })
    )
    expect(emptyOptions.pendingExtensionUiRequest).toBeNull()
  })
})
