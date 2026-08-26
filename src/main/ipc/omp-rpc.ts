// IPC surface for the session-less OMP RPC probe: a live slash-command catalog
// for the chat composer, and execution of allowlisted local commands (/usage).
// Every handler is fail-closed — it returns an error code rather than throwing
// across IPC, because the renderer's contract is "degrade to the static catalog
// and the PTY path", never "surface a crash".

import { app, ipcMain } from 'electron'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type {
  OmpRpcGetCommandsArgs,
  OmpRpcGetCommandsResult,
  OmpRpcRunLocalCommandArgs,
  OmpRpcRunLocalCommandResult
} from '../../shared/omp-rpc-ipc-contract'
import type { OmpRpcClientLike, OmpRpcSpawnOptions } from '../../shared/omp-rpc-protocol'
import { createOmpRpcProbePool, type OmpRpcProbePool } from './omp-rpc-probe-pool'
import { isCommandOnLocalPath } from './command-path-resolver'
import { hydrateShellPathForAgentDetection } from './agent-detection-shell-path'

let pool: OmpRpcProbePool | null = null
let shellPathHydration: Promise<void> | null = null

/** OMP launches from PATH exactly as its TUI does, so the probe and the pane
 *  agree on which binary is "omp" — no second resolution rule to drift. */
async function resolveOmpExecutablePath(): Promise<string | null> {
  const command = TUI_AGENT_CONFIG.omp.launchCmd
  if (await isCommandOnLocalPath(command)) {
    return command
  }
  // Why: a GUI-launched Electron app inherits a sparse PATH (no ~/.local/bin,
  // no version-manager shims), so retry once through the user's login shell
  // before declaring the binary missing.
  shellPathHydration ??= hydrateShellPathForAgentDetection()
  await shellPathHydration
  return (await isCommandOnLocalPath(command)) ? command : null
}

async function spawnOmpRpcClientLazily(options: OmpRpcSpawnOptions): Promise<OmpRpcClientLike> {
  // Why: imported at call time so the concrete client (and the child-process
  // machinery it pulls in) never loads for users who don't run OMP.
  const { spawnOmpRpcClient } = await import('../omp-rpc/omp-rpc-client')
  return spawnOmpRpcClient(options)
}

function getPool(): OmpRpcProbePool {
  pool ??= createOmpRpcProbePool({
    resolveExecutablePath: resolveOmpExecutablePath,
    // The pool owns lifecycle synchronously; the dynamic import is bridged by a
    // proxy client that defers each call to the resolved concrete client.
    spawn: (options) => createDeferredOmpRpcClient(spawnOmpRpcClientLazily(options))
  })
  return pool
}

export function registerOmpRpcHandlers(): void {
  ipcMain.handle(
    'ompRpc:getCommands',
    async (_event, args: OmpRpcGetCommandsArgs): Promise<OmpRpcGetCommandsResult> => {
      const cwd = args?.cwd?.trim()
      if (!cwd) {
        return { ok: false, errorCode: 'executable-not-found' }
      }
      try {
        return await getPool().getCommands(cwd)
      } catch {
        return { ok: false, errorCode: 'request-failed' }
      }
    }
  )
  ipcMain.handle(
    'ompRpc:runLocalCommand',
    async (_event, args: OmpRpcRunLocalCommandArgs): Promise<OmpRpcRunLocalCommandResult> => {
      const cwd = args?.cwd?.trim()
      if (!cwd) {
        return { ok: false, errorCode: 'executable-not-found' }
      }
      try {
        return await getPool().runLocalCommand(cwd, args?.command ?? '')
      } catch {
        return { ok: false, errorCode: 'request-failed' }
      }
    }
  )
  app.once('will-quit', disposeOmpRpcProbes)
}

export function disposeOmpRpcProbes(): void {
  pool?.dispose()
  pool = null
}

type OmpRpcClientListener = Parameters<OmpRpcClientLike['on']>[0]

/** Adapts a not-yet-resolved client to the synchronous OmpRpcClientLike the pool
 *  holds. A listener registered during the spawn window attaches as soon as the
 *  child exists, so no `commands`/`exit` event is lost. */
function createDeferredOmpRpcClient(pending: Promise<OmpRpcClientLike>): OmpRpcClientLike {
  let disposed = false
  const resolved = pending.then((client) => {
    if (disposed) {
      client.dispose()
      throw new Error('OMP RPC probe disposed before it was ready')
    }
    return client
  })
  // Why: `resolved` is awaited lazily per call, so an early spawn failure would
  // otherwise surface as an unhandled rejection before the first call arrives.
  resolved.catch(() => {})
  return {
    whenReady: () => resolved.then((client) => client.whenReady()),
    getCommands: () => resolved.then((client) => client.getCommands()),
    prompt: (message) => resolved.then((client) => client.prompt(message)),
    on: (listener: OmpRpcClientListener) => {
      let detached = false
      let detach: (() => void) | null = null
      void resolved.then(
        (client) => {
          if (!detached) {
            detach = client.on(listener)
          }
        },
        () => {}
      )
      return () => {
        detached = true
        detach?.()
      }
    },
    dispose: () => {
      disposed = true
      void resolved.then(
        (client) => client.dispose(),
        () => {}
      )
    }
  }
}
