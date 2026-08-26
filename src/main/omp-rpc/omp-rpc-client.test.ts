import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeOmpRpcChild } from './fake-omp-rpc-child'
import { spawnOmpRpcClient, type OmpRpcClient } from './omp-rpc-client'

const clients = new Set<OmpRpcClient>()
const temporaryDirectories = new Set<string>()

function spawnScenario(scenario: Parameters<typeof createFakeOmpRpcChild>[0]): OmpRpcClient {
  const client = spawnOmpRpcClient(createFakeOmpRpcChild(scenario).spawnOptions)
  clients.add(client)
  return client
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

describe('OMP RPC client negotiation', () => {
  it('resolves readiness only after negotiating protocol v2', async () => {
    const client = spawnScenario({})

    await expect(client.whenReady()).resolves.toEqual({
      ready: {
        type: 'ready',
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1_048_576,
        maxReassembledFrameBytes: 67_108_864
      },
      negotiatedProtocolVersion: 2
    })
  })

  it('rejects and emits a protocol fault for a malformed first frame', async () => {
    const client = spawnScenario({ firstFrame: { type: 'command_output', text: 'too early' } })
    const events: string[] = []
    client.on((event) => {
      if (event.kind === 'protocol-fault') {
        events.push(event.message)
      }
    })

    await expect(client.whenReady()).rejects.toThrow('valid ready frame')
    expect(events).toEqual(['OMP RPC first frame was not a valid ready frame'])
  })

  it('rejects readiness when protocol v2 negotiation fails', async () => {
    const client = spawnScenario({
      negotiationResponse: {
        id: 'orca-omp-1',
        type: 'response',
        command: 'negotiate_protocol',
        success: false,
        error: 'Protocol rejected',
        code: 'E_PROTOCOL'
      }
    })

    await expect(client.whenReady()).rejects.toThrow(
      'OMP RPC protocol v2 negotiation failed: Protocol rejected'
    )
  })
})

describe('OMP RPC command catalog', () => {
  it('returns correlated commands and emits pushed and returned catalogs', async () => {
    const commands = [
      {
        name: 'usage',
        aliases: ['u'],
        description: 'Show token usage',
        input: { hint: '' },
        source: 'built-in'
      }
    ]
    const client = spawnScenario({
      commands,
      afterNegotiationFrames: [{ type: 'available_commands_update', commands }]
    })
    const catalogs: unknown[] = []
    client.on((event) => {
      if (event.kind === 'commands') {
        catalogs.push(event.commands)
      }
    })

    await client.whenReady()
    await expect(client.getCommands()).resolves.toEqual(commands)
    await vi.waitFor(() => expect(catalogs).toEqual([commands, commands]))
  })
})

describe('OMP RPC prompts', () => {
  it('emits slash-command output before resolving an agent-free prompt', async () => {
    const client = spawnScenario({
      promptOutput: ['## Usage\n12% used'],
      promptResultAgentInvoked: false,
      promptAgentInvoked: false
    })
    const order: string[] = []
    client.on((event) => {
      if (event.kind === 'command-output') {
        order.push(`output:${event.text}`)
      }
      if (event.kind === 'prompt-result') {
        order.push(`result:${event.agentInvoked}`)
      }
    })

    await client.whenReady()
    const result = await client.prompt('/usage').then((value) => {
      order.push('resolved')
      return value
    })

    expect(result).toEqual({ agentInvoked: false })
    expect(order).toEqual(['output:## Usage\n12% used', 'result:false', 'resolved'])
  })

  it('defaults an absent prompt response payload to agent-invoking', async () => {
    const client = spawnScenario({})
    await client.whenReady()

    await expect(client.prompt('Explain this')).resolves.toEqual({ agentInvoked: true })
  })

  it('rejects an error response with its message and code', async () => {
    const client = spawnScenario({
      commandErrors: { prompt: { error: 'Prompt denied', code: 'E_DENIED' } }
    })
    await client.whenReady()

    await expect(client.prompt('Explain this')).rejects.toMatchObject({
      message: 'Prompt denied',
      code: 'E_DENIED'
    })
  })
})

describe('OMP RPC v2 chunking', () => {
  it('reassembles an oversized logical frame before dispatch', async () => {
    const textLength = 1_100_000
    const client = spawnScenario({ chunkedCommandOutputLength: textLength })
    const output: string[] = []
    client.on((event) => {
      if (event.kind === 'command-output') {
        output.push(event.text)
      }
    })

    await client.whenReady()
    await vi.waitFor(() => expect(output).toHaveLength(1))
    expect(output[0]).toBe('x'.repeat(textLength))
  })

  it.each([
    ['wrong-start-index', 'index 0'],
    ['chunk-id-mismatch', 'metadata'],
    ['interleaved-frame', 'non-chunk'],
    ['byte-length-mismatch', 'byte length']
  ] as const)('surfaces %s as a protocol fault', async (chunkFault, expectedMessage) => {
    const client = spawnScenario({
      chunkedCommandOutputLength: 1_100_000,
      chunkFault
    })
    const faults: string[] = []
    client.on((event) => {
      if (event.kind === 'protocol-fault') {
        faults.push(event.message)
      }
    })

    await client.whenReady()
    await vi.waitFor(() => expect(faults).toHaveLength(1))
    expect(faults[0]).toContain(expectedMessage)
  })
})

describe('OMP RPC transport lifecycle', () => {
  it('preserves an unrecognized parsed frame', async () => {
    const frame = { type: 'agent_custom_event', sequence: 4, payload: { state: 'working' } }
    const client = spawnScenario({ afterNegotiationFrames: [frame] })
    const unknownFrames: unknown[] = []
    client.on((event) => {
      if (event.kind === 'unknown-frame') {
        unknownFrames.push(event.frame)
      }
    })

    await client.whenReady()
    await vi.waitFor(() => expect(unknownFrames).toEqual([frame]))
  })

  it('surfaces malformed JSON with an excerpt bounded to 200 characters', async () => {
    const malformedLine = `{"type":"broken","payload":"${'z'.repeat(500)}`
    const client = spawnScenario({ malformedAfterNegotiationLine: malformedLine })
    const faults: string[] = []
    client.on((event) => {
      if (event.kind === 'protocol-fault') {
        faults.push(event.message)
      }
    })

    await client.whenReady()
    await vi.waitFor(() => expect(faults).toHaveLength(1))
    expect(faults[0]).toContain(malformedLine.slice(0, 200))
    expect(faults[0]).not.toContain(malformedLine.slice(0, 201))
  })

  it('rejects a pending command when the child exits and includes bounded stderr', async () => {
    const stderr = `${'x'.repeat(9_000)}diagnostic-tail`
    const client = spawnScenario({
      exitOnCommand: 'prompt',
      exitCode: 17,
      stderrBeforeExit: stderr
    })
    const exits: unknown[] = []
    client.on((event) => {
      if (event.kind === 'exit') {
        exits.push(event)
      }
    })
    await client.whenReady()

    await expect(client.prompt('exit now')).rejects.toThrow('diagnostic-tail')
    expect(client.stderrTail).toHaveLength(8_192)
    expect(client.stderrTail.endsWith('diagnostic-tail')).toBe(true)
    await vi.waitFor(() => expect(exits).toEqual([{ kind: 'exit', code: 17, signal: null }]))
  })

  it('terminates the child on dispose and emits one exit event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-omp-rpc-'))
    temporaryDirectories.add(directory)
    const markerPath = join(directory, 'signal.txt')
    const client = spawnScenario({ sigtermMarkerPath: markerPath })
    const exits: unknown[] = []
    client.on((event) => {
      if (event.kind === 'exit') {
        exits.push(event)
      }
    })
    await client.whenReady()

    client.dispose()

    await vi.waitFor(async () => expect(await readFile(markerPath, 'utf8')).toBe('SIGTERM'))
    await vi.waitFor(() => expect(exits).toHaveLength(1))
  })
})
