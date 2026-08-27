#!/usr/bin/env node

import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const scenario = JSON.parse(process.argv.at(-1) ?? '{}')
let sessionState = scenario.sessionState ?? {
  sessionFile: null,
  sessionId: null,
  isStreaming: false,
  isCompacting: false,
  queuedMessageCount: 0
}
const readyFrame = {
  type: 'ready',
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 67_108_864
}

if (scenario.sigtermMarkerPath) {
  process.on('SIGTERM', () => {
    appendFileSync(scenario.sigtermMarkerPath, 'SIGTERM')
    process.exit(0)
  })
}

if (scenario.argvMarkerPath) {
  appendFileSync(scenario.argvMarkerPath, JSON.stringify(process.argv.slice(2, -1)))
}

function writeLine(frame) {
  const line = typeof frame === 'string' ? frame : JSON.stringify(frame)
  process.stdout.write(`${line}\n`)
}

function writeChunkedCommandOutput(textLength, fault) {
  const bytes = Buffer.from(
    JSON.stringify({ type: 'command_output', text: 'x'.repeat(textLength) })
  )
  const payloads = []
  for (let offset = 0; offset < bytes.length; offset += 262_144) {
    payloads.push(bytes.subarray(offset, offset + 262_144))
  }
  for (const [index, payload] of payloads.entries()) {
    if (fault === 'interleaved-frame' && index === 1) {
      writeLine({ type: 'command_output', text: 'interleaved' })
    }
    writeLine({
      type: 'rpc_chunk',
      chunkId: fault === 'chunk-id-mismatch' && index === 1 ? 'fake-chunk-2' : 'fake-chunk-1',
      index: fault === 'wrong-start-index' && index === 0 ? 1 : index,
      count: payloads.length,
      byteLength: fault === 'byte-length-mismatch' ? bytes.length + 1 : bytes.length,
      data: payload.toString('base64')
    })
  }
}

writeLine(scenario.firstFrame ?? readyFrame)

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const command = JSON.parse(line)
  if (scenario.exitOnCommand === command.type) {
    const exit = () => process.exit(scenario.exitCode ?? 17)
    if (scenario.stderrBeforeExit) {
      process.stderr.write(scenario.stderrBeforeExit, exit)
    } else {
      exit()
    }
    return
  }
  const commandError = scenario.commandErrors?.[command.type]
  if (commandError) {
    writeLine({
      id: command.id,
      type: 'response',
      command: command.type,
      success: false,
      error: commandError.error,
      code: commandError.code
    })
    return
  }
  if (command.type === 'get_available_commands') {
    writeLine({
      id: command.id,
      type: 'response',
      command: 'get_available_commands',
      success: true,
      data: { commands: scenario.commands ?? [] }
    })
    return
  }
  if (command.type === 'get_state') {
    writeLine({
      id: command.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: sessionState
    })
    return
  }
  if (command.type === 'abort') {
    sessionState = {
      ...sessionState,
      isStreaming: false,
      isCompacting: false,
      queuedMessageCount: 0
    }
    writeLine({
      id: command.id,
      type: 'response',
      command: 'abort',
      success: true
    })
    return
  }
  if (command.type === 'switch_session') {
    sessionState = { ...sessionState, sessionFile: command.sessionPath }
    writeLine({
      id: command.id,
      type: 'response',
      command: 'switch_session',
      success: true
    })
    return
  }
  if (command.type === 'prompt') {
    for (const text of scenario.promptOutput ?? []) {
      writeLine({ type: 'command_output', text })
    }
    if (typeof scenario.promptResultAgentInvoked === 'boolean') {
      writeLine({
        type: 'prompt_result',
        id: command.id,
        agentInvoked: scenario.promptResultAgentInvoked
      })
    }
    writeLine({
      id: command.id,
      type: 'response',
      command: 'prompt',
      success: true,
      ...(typeof scenario.promptAgentInvoked === 'boolean'
        ? { data: { agentInvoked: scenario.promptAgentInvoked } }
        : {})
    })
    return
  }
  if (command.type !== 'negotiate_protocol') {
    return
  }
  writeLine(
    scenario.negotiationResponse ?? {
      id: command.id,
      type: 'response',
      command: 'negotiate_protocol',
      success: true,
      data: { protocolVersion: 2 }
    }
  )
  for (const frame of scenario.afterNegotiationFrames ?? []) {
    writeLine(frame)
  }
  if (scenario.malformedAfterNegotiationLine) {
    writeLine(scenario.malformedAfterNegotiationLine)
  }
  if (typeof scenario.chunkedCommandOutputLength === 'number') {
    writeChunkedCommandOutput(scenario.chunkedCommandOutputLength, scenario.chunkFault)
  }
})
