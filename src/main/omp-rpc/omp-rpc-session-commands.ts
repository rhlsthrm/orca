import type { OmpRpcCommand, OmpRpcSessionState } from '../../shared/omp-rpc-protocol'
import { parseOmpRpcSessionState } from './omp-rpc-frame-validation'

type OmpRpcSessionCommandDependencies = {
  whenReady: () => Promise<unknown>
  sendCommand: (command: OmpRpcCommand) => Promise<unknown>
}

export class OmpRpcSessionCommands {
  constructor(private readonly dependencies: OmpRpcSessionCommandDependencies) {}

  readonly getState = async (): Promise<OmpRpcSessionState> => {
    await this.dependencies.whenReady()
    return parseOmpRpcSessionState(await this.dependencies.sendCommand({ type: 'get_state' }))
  }

  readonly switchSession = async (sessionPath: string): Promise<void> => {
    if (!sessionPath.trim()) {
      throw new Error('OMP RPC session path is required')
    }
    await this.dependencies.whenReady()
    await this.dependencies.sendCommand({ type: 'switch_session', sessionPath })
  }

  readonly abort = async (): Promise<void> => {
    await this.dependencies.whenReady()
    await this.dependencies.sendCommand({ type: 'abort' })
  }
}
