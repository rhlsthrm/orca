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
      { type: 'tool-call', name: 'read', input: { path: 'a' } },
      { type: 'tool-result', output: 'file body', isError: false },
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

  it('drops the overlay once the turn is no longer working', () => {
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
    expect(selectOmpRpcOverlayMessages(state, [])).toEqual([])
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
    expect(messages[0].blocks).toEqual([{ type: 'tool-call', name: 'read', input: {} }])
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
        frame: { type: 'extension_ui_request', id: 'ask-1', method: 'select' }
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
        frame: { type: 'extension_ui_request', id: 'ask-1', method: 'select' }
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
        frame: { type: 'extension_ui_request', id: 'ask-1', method: 'select' }
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
})
