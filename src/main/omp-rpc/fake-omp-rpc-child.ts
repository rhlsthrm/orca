import { join } from 'node:path'
import type {
  OmpRpcSessionState,
  OmpRpcSlashCommand,
  OmpRpcSpawnOptions
} from '../../shared/omp-rpc-protocol'

export type FakeOmpRpcScenario = {
  firstFrame?: unknown
  negotiationResponse?: unknown
  afterNegotiationFrames?: unknown[]
  commands?: OmpRpcSlashCommand[]
  commandErrors?: Partial<
    Record<
      | 'abort'
      | 'get_available_commands'
      | 'get_state'
      | 'prompt'
      | 'steer'
      | 'follow_up'
      | 'switch_session',
      { error: string; code?: string }
    >
  >
  promptOutput?: string[]
  promptResultAgentInvoked?: boolean
  promptAgentInvoked?: boolean
  /** Frames written (in order) when a `prompt` command is received, before its
   *  correlated response — simulates a real agent_start / message_* / agent_end run. */
  promptEvents?: unknown[]
  /** Same as `promptEvents` but for `steer` / `follow_up` commands. */
  steerEvents?: unknown[]
  followUpEvents?: unknown[]
  steerAgentInvoked?: boolean
  followUpAgentInvoked?: boolean
  /** Path to append every inbound `extension_ui_response` command to, as JSONL,
   *  so a test can assert what the client answered. */
  extensionUiResponseMarkerPath?: string
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
  argvMarkerPath?: string
  sessionState?: OmpRpcSessionState
}

export type FakeOmpRpcChild = {
  argv: string[]
  spawnOptions: OmpRpcSpawnOptions
}

export function createFakeOmpRpcChild(
  scenario: FakeOmpRpcScenario,
  sessionMode: 'session-less' | 'session-owning' = 'session-less'
): FakeOmpRpcChild {
  const fixtureDirectory = join(process.cwd(), 'src', 'main', 'omp-rpc')
  const scriptPath = join(fixtureDirectory, 'fake-omp-rpc-child-script.mjs')
  const executablePath =
    process.platform === 'win32' ? join(fixtureDirectory, 'fake-omp-rpc-child.cmd') : scriptPath
  const scenarioJson = JSON.stringify(scenario)
  const rpcArgs = [
    '--mode',
    'rpc',
    ...(sessionMode === 'session-less' ? ['--no-session'] : []),
    scenarioJson
  ]
  const spawnOptions: OmpRpcSpawnOptions =
    sessionMode === 'session-owning'
      ? {
          executablePath,
          cwd: process.cwd(),
          sessionMode,
          extraArgs: [scenarioJson]
        }
      : {
          executablePath,
          cwd: process.cwd(),
          sessionMode,
          noSession: true,
          extraArgs: [scenarioJson]
        }
  return {
    argv: [process.execPath, scriptPath, ...rpcArgs],
    spawnOptions
  }
}
