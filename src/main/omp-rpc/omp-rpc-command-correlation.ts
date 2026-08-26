import type { OmpRpcCommand } from '../../shared/omp-rpc-protocol'

export type OmpRpcPendingResponse = {
  command: OmpRpcCommand['type']
  resolve: (data: unknown) => void
  reject: (error: Error) => void
}

export class OmpRpcCommandError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
    this.name = 'OmpRpcCommandError'
  }
}
