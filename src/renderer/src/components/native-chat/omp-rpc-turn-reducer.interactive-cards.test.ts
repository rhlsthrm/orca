import { describe, expect, it } from 'vitest'
import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'
import { createInitialOmpRpcTurnState, ompRpcTurnReducer } from './omp-rpc-turn-reducer'

function frame(event: OmpRpcClientEvent): { type: 'frame'; event: OmpRpcClientEvent } {
  return { type: 'frame', event }
}

describe('Orca-originated interactive command cards', () => {
  const pendingRequest = frame({
    kind: 'extension-ui-request',
    frame: { type: 'extension_ui_request', id: 'ask-1', method: 'select', options: ['Yes'] }
  })

  it('holds one card at a time, replaced by a newer invocation', () => {
    let state = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'interactive-card-opened',
      card: { cardId: 'card-1', command: 'switch' }
    })
    state = ompRpcTurnReducer(state, {
      type: 'interactive-card-opened',
      card: { cardId: 'card-2', command: 'thinking' }
    })
    expect(state.openInteractiveCard).toEqual({ cardId: 'card-2', command: 'thinking' })
  })

  it('answers a card without touching the child request blocking the pane', () => {
    let state = ompRpcTurnReducer(createInitialOmpRpcTurnState(), pendingRequest)
    state = ompRpcTurnReducer(state, {
      type: 'interactive-card-opened',
      card: { cardId: 'card-1', command: 'switch' }
    })
    state = ompRpcTurnReducer(state, { type: 'interactive-card-dismissed', cardId: 'card-1' })

    expect(state.openInteractiveCard).toBeNull()
    expect(state.pendingExtensionUiRequest?.id).toBe('ask-1')
  })

  it('leaves the card alone when the child request is answered', () => {
    let state = ompRpcTurnReducer(createInitialOmpRpcTurnState(), pendingRequest)
    state = ompRpcTurnReducer(state, {
      type: 'interactive-card-opened',
      card: { cardId: 'card-1', command: 'switch' }
    })
    state = ompRpcTurnReducer(state, { type: 'extension-ui-answered', requestId: 'ask-1' })

    expect(state.pendingExtensionUiRequest).toBeNull()
    expect(state.openInteractiveCard).toEqual({ cardId: 'card-1', command: 'switch' })
  })

  it('ignores a dismissal for a card that has already been replaced', () => {
    let state = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'interactive-card-opened',
      card: { cardId: 'card-1', command: 'switch' }
    })
    state = ompRpcTurnReducer(state, {
      type: 'interactive-card-opened',
      card: { cardId: 'card-2', command: 'thinking' }
    })
    state = ompRpcTurnReducer(state, { type: 'interactive-card-dismissed', cardId: 'card-1' })

    expect(state.openInteractiveCard).toEqual({ cardId: 'card-2', command: 'thinking' })
  })

  it('keeps an unanswered card across a turn boundary and drops it on reset', () => {
    let state = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'interactive-card-opened',
      card: { cardId: 'card-1', command: 'switch' }
    })
    state = ompRpcTurnReducer(state, frame({ kind: 'agent-start', frame: { type: 'agent_start' } }))
    expect(state.openInteractiveCard).toEqual({ cardId: 'card-1', command: 'switch' })

    expect(ompRpcTurnReducer(state, { type: 'reset' }).openInteractiveCard).toBeNull()
  })
})
