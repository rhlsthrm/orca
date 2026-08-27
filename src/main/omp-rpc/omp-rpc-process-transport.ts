import { spawnProcess, type ChildProcessHandle } from '../../shared/child-process/run-process'
import type { OmpRpcSpawnOptions } from '../../shared/omp-rpc-protocol'

const STDERR_TAIL_BYTES = 8_192
const FORCE_KILL_DELAY_MS = 2_000

export type OmpRpcProcessTransportHandlers = {
  onLine: (line: string) => void
  onStreamError: (error: Error) => void
  onExit: (code: number | null, signal: NodeJS.Signals | null, cause?: Error) => void
}

export class OmpRpcProcessTransport {
  private readonly child: ChildProcessHandle
  private stdoutBuffer = ''
  private stderrBytes = Buffer.alloc(0)
  private hasExited = false
  private isDisposed = false
  private forceKillTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    options: OmpRpcSpawnOptions,
    private readonly handlers: OmpRpcProcessTransportHandlers
  ) {
    if (
      options.sessionMode === 'session-owning' &&
      options.extraArgs?.some((arg) => arg === '--no-session' || arg.startsWith('--no-session='))
    ) {
      throw new Error('session-owning OMP RPC spawn cannot include --no-session')
    }
    this.child = spawnProcess({
      program: options.executablePath,
      args: [
        '--mode',
        'rpc',
        ...(options.sessionMode === 'session-owning' ? [] : ['--no-session']),
        ...(options.extraArgs ?? [])
      ],
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child.stdout?.on('data', this.handleStdout)
    this.child.stderr?.on('data', this.handleStderr)
    this.child.on('error', this.handleChildError)
    this.child.on('close', this.handleChildClose)
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream?.on('error', this.handlers.onStreamError)
    }
  }

  get stderrTail(): string {
    return this.stderrBytes.toString('utf8')
  }

  write(frame: unknown): boolean {
    if (this.isDisposed || this.hasExited || !this.child.stdin) {
      return false
    }
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
    return true
  }

  dispose(): void {
    if (this.isDisposed || this.hasExited) {
      return
    }
    this.isDisposed = true
    this.child.stdin?.end()
    this.child.kill('SIGTERM')
    this.child.stdout?.removeListener('data', this.handleStdout)
    this.forceKillTimer = setTimeout(() => {
      if (!this.hasExited) {
        this.child.kill('SIGKILL')
      }
    }, FORCE_KILL_DELAY_MS)
    this.forceKillTimer.unref?.()
  }

  private readonly handleStdout = (chunk: Buffer | string): void => {
    this.stdoutBuffer += chunk.toString()
    let newlineIndex = this.stdoutBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex)
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      this.handlers.onLine(line)
      newlineIndex = this.stdoutBuffer.indexOf('\n')
    }
  }

  private readonly handleStderr = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const retainedBytes = Math.max(0, STDERR_TAIL_BYTES - bytes.length)
    const retainedStart = Math.max(0, this.stderrBytes.length - retainedBytes)
    this.stderrBytes = Buffer.concat([this.stderrBytes.subarray(retainedStart), bytes]).subarray(
      -STDERR_TAIL_BYTES
    )
  }

  private readonly handleChildError = (error: Error): void => {
    this.finishExit(null, null, error)
  }

  private readonly handleChildClose = (
    code: number | null,
    signal: NodeJS.Signals | null
  ): void => {
    this.finishExit(code, signal)
  }

  private finishExit(code: number | null, signal: NodeJS.Signals | null, cause?: Error): void {
    if (this.hasExited) {
      return
    }
    this.hasExited = true
    if (this.forceKillTimer) {
      clearTimeout(this.forceKillTimer)
      this.forceKillTimer = null
    }
    this.removeListeners()
    this.handlers.onExit(code, signal, cause)
  }

  private removeListeners(): void {
    this.child.stdout?.removeListener('data', this.handleStdout)
    this.child.stderr?.removeListener('data', this.handleStderr)
    this.child.removeListener('error', this.handleChildError)
    this.child.removeListener('close', this.handleChildClose)
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream?.removeListener('error', this.handlers.onStreamError)
    }
  }
}
