import { join } from 'node:path'
import type { OmpRpcSlashCommand, OmpRpcSpawnOptions } from '../../shared/omp-rpc-protocol'

export type FakeOmpRpcScenario = {
  firstFrame?: unknown
  negotiationResponse?: unknown
  afterNegotiationFrames?: unknown[]
  commands?: OmpRpcSlashCommand[]
  commandErrors?: Partial<
    Record<'get_available_commands' | 'prompt', { error: string; code?: string }>
  >
  promptOutput?: string[]
  promptResultAgentInvoked?: boolean
  promptAgentInvoked?: boolean
  chunkedCommandOutputLength?: number
  chunkFault?:
    | 'wrong-start-index'
    | 'chunk-id-mismatch'
    | 'interleaved-frame'
    | 'byte-length-mismatch'
  malformedAfterNegotiationLine?: string
  exitOnCommand?: 'get_available_commands' | 'prompt'
  exitCode?: number
  stderrBeforeExit?: string
  sigtermMarkerPath?: string
}

export type FakeOmpRpcChild = {
  argv: string[]
  spawnOptions: OmpRpcSpawnOptions
}

export function createFakeOmpRpcChild(scenario: FakeOmpRpcScenario): FakeOmpRpcChild {
  const fixtureDirectory = join(process.cwd(), 'src', 'main', 'omp-rpc')
  const scriptPath = join(fixtureDirectory, 'fake-omp-rpc-child-script.mjs')
  const executablePath =
    process.platform === 'win32' ? join(fixtureDirectory, 'fake-omp-rpc-child.cmd') : scriptPath
  const scenarioJson = JSON.stringify(scenario)
  const rpcArgs = ['--mode', 'rpc', '--no-session', scenarioJson]
  return {
    argv: [process.execPath, scriptPath, ...rpcArgs],
    spawnOptions: {
      executablePath,
      cwd: process.cwd(),
      noSession: true,
      extraArgs: [scenarioJson]
    }
  }
}
