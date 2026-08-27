import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeOmpRpcChild } from './fake-omp-rpc-child'
import { spawnOmpRpcClient, type OmpRpcClient } from './omp-rpc-client'
import type { OmpRpcClientEvent } from '../../shared/omp-rpc-protocol'

const clients = new Set<OmpRpcClient>()
const temporaryDirectories = new Set<string>()

function spawnScenario(scenario: Parameters<typeof createFakeOmpRpcChild>[0]): OmpRpcClient {
  const client = spawnOmpRpcClient(createFakeOmpRpcChild(scenario, 'session-owning').spawnOptions)
  clients.add(client)
  return client
}

async function tempMarkerPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omp-rpc-turn-events-'))
  temporaryDirectories.add(dir)
  return join(dir, name)
}

afterEach(async () => {
  for (const client of clients) {
    client.dispose()
  }
  clients.clear()
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true }))
  )
  temporaryDirectories.clear()
})

describe('OMP RPC client turn-lifecycle frames', () => {
  it('emits message-update for a text_delta event', async () => {
    const client = spawnScenario({
      promptEvents: [
        { type: 'message_update', assistantMessageEvent: { type: 'text_start' } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.whenReady()
    await client.prompt('hello')
    expect(events.filter((e) => e.kind === 'message-update')).toHaveLength(2)
    const delta = events.find(
      (e) => e.kind === 'message-update' && e.frame.assistantMessageEvent?.type === 'text_delta'
    )
    expect(delta).toBeDefined()
    if (
      delta?.kind === 'message-update' &&
      delta.frame.assistantMessageEvent?.type === 'text_delta'
    ) {
      expect(delta.frame.assistantMessageEvent.delta).toBe('Hi')
    }
  })

  it('protocol-faults on a message_update missing its delta', async () => {
    const client = spawnScenario({
      promptEvents: [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } }]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.whenReady()
    await expect(client.prompt('hello')).rejects.toThrow()
    expect(events.some((e) => e.kind === 'protocol-fault')).toBe(true)
  })

  // F1 (CRITICAL): OMP echoes the user's own turn through message_update
  // with role:'user' and no assistantMessageEvent at all — this is a valid,
  // non-fatal frame shape, not a protocol fault.
  it('does not protocol-fault on a message_update with no assistantMessageEvent (user echo)', async () => {
    const client = spawnScenario({
      promptEvents: [
        { type: 'message_update', message: { role: 'user', content: [] } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.whenReady()
    await client.prompt('hello')
    expect(events.some((e) => e.kind === 'protocol-fault')).toBe(false)
    const delta = events.find(
      (e) => e.kind === 'message-update' && e.frame.assistantMessageEvent?.type === 'text_delta'
    )
    expect(delta).toBeDefined()
    const userEcho = events.find(
      (e) => e.kind === 'message-update' && e.frame.assistantMessageEvent === undefined
    )
    expect(userEcho).toBeDefined()
    // The session must still be alive after the echo — a real, subsequent
    // command succeeds.
    const state = await client.getState()
    expect(state).toBeDefined()
  })

  it('emits agent-end honoring isTerminal', async () => {
    const client = spawnScenario({
      promptEvents: [{ type: 'agent_end', messages: [], isTerminal: false }]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.whenReady()
    await client.prompt('hello')
    const agentEnd = events.find((e) => e.kind === 'agent-end')
    expect(agentEnd).toBeDefined()
    if (agentEnd?.kind === 'agent-end') {
      expect(agentEnd.frame.isTerminal).toBe(false)
    }
  })

  it('passes through agent_start, turn_start/end, and tool_execution_* frames', async () => {
    const client = spawnScenario({
      promptEvents: [
        { type: 'agent_start' },
        { type: 'turn_start' },
        {
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'read',
          input: { path: 'a' }
        },
        { type: 'tool_execution_end', toolCallId: 'call-1', content: 'ok', isError: false },
        { type: 'turn_end' }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.whenReady()
    await client.prompt('hello')
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        'agent-start',
        'turn-start',
        'tool-execution-start',
        'tool-execution-end',
        'turn-end'
      ])
    )
    const toolStart = events.find((e) => e.kind === 'tool-execution-start')
    if (toolStart?.kind === 'tool-execution-start') {
      expect(toolStart.frame.toolCallId).toBe('call-1')
      expect(toolStart.frame.toolName).toBe('read')
    }
  })

  it('emits extension-ui-request for a select approval prompt', async () => {
    const client = spawnScenario({
      promptEvents: [
        {
          type: 'extension_ui_request',
          id: 'ask-1',
          method: 'select',
          message: 'Approve running rm?',
          options: ['Approve', 'Deny']
        }
      ]
    })
    const events: OmpRpcClientEvent[] = []
    client.on((event) => events.push(event))
    await client.whenReady()
    await client.prompt('hello')
    const request = events.find((e) => e.kind === 'extension-ui-request')
    expect(request).toBeDefined()
    if (request?.kind === 'extension-ui-request') {
      expect(request.frame.id).toBe('ask-1')
      expect(request.frame.options).toEqual(['Approve', 'Deny'])
    }
  })

  it('sends steer and follow_up with the documented wire shape', async () => {
    const client = spawnScenario({ steerAgentInvoked: true, followUpAgentInvoked: true })
    await client.whenReady()
    await expect(client.steer('stop and do X')).resolves.toEqual({ agentInvoked: true })
    await expect(client.followUp('do Y after')).resolves.toEqual({ agentInvoked: true })
  })

  it('sends prompt with images and streamingBehavior when provided', async () => {
    const argvMarkerPath = await tempMarkerPath('argv.json')
    const client = spawnScenario({ argvMarkerPath, promptAgentInvoked: true })
    await client.whenReady()
    await client.prompt('continue', {
      streamingBehavior: 'steer',
      images: [{ type: 'image', mimeType: 'image/png', data: 'YWJj' }]
    })
    // Why: argvMarkerPath only proves the child launched with the scenario; the
    // wire shape itself is proven by the fake script's response echoing agentInvoked.
    await readFile(argvMarkerPath, 'utf8')
  })

  it('writes a raw extension_ui_response frame bypassing command correlation', async () => {
    const extensionUiResponseMarkerPath = await tempMarkerPath('responses.jsonl')
    const client = spawnScenario({ extensionUiResponseMarkerPath })
    await client.whenReady()
    expect(
      client.respondExtensionUi({ type: 'extension_ui_response', id: 'ask-1', value: 'Approve' })
    ).toBe(true)
    // Why: the child's stdin is a single ordered stream — awaiting a correlated
    // command sent afterward proves the prior raw write was already processed,
    // without a fixed-duration sleep.
    await client.getState()
    const written = await readFile(extensionUiResponseMarkerPath, 'utf8')
    expect(JSON.parse(written.trim())).toEqual({
      type: 'extension_ui_response',
      id: 'ask-1',
      value: 'Approve'
    })
  })

  it('returns false from respondExtensionUi after dispose', async () => {
    const client = spawnScenario({})
    await client.whenReady()
    client.dispose()
    expect(
      client.respondExtensionUi({ type: 'extension_ui_response', id: 'x', confirmed: true })
    ).toBe(false)
  })
})
