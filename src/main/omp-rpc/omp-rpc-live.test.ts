// Opt-in live probe against a real installed OMP. Skipped unless
// ORCA_OMP_RPC_LIVE=1 and an omp binary resolves, so CI (which has neither)
// stays green while a developer can prove the client against the real agent.

import { describe, expect, it } from 'vitest'
import { access, constants as fsConstants } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnOmpRpcClient } from './omp-rpc-client'

const LIVE_ENABLED = process.env.ORCA_OMP_RPC_LIVE === '1'

async function findOmp(): Promise<string | null> {
  const fromEnv = process.env.ORCA_OMP_RPC_LIVE_BIN
  const candidates = [
    ...(fromEnv ? [fromEnv] : []),
    path.join(os.homedir(), '.local', 'bin', 'omp'),
    path.join(os.homedir(), '.bun', 'bin', 'omp'),
    '/opt/homebrew/bin/omp',
    '/usr/local/bin/omp'
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

describe.skipIf(!LIVE_ENABLED)('omp rpc client against a live OMP', () => {
  it('negotiates v2, lists the command catalog, and runs /usage locally', async () => {
    const executablePath = await findOmp()
    if (!executablePath) {
      // Why: enabling the flag on a machine without omp is a setup mistake, not
      // a product failure — fail loudly rather than passing vacuously.
      throw new Error('ORCA_OMP_RPC_LIVE=1 but no omp binary found')
    }
    const client = spawnOmpRpcClient({ executablePath, cwd: process.cwd(), noSession: true })
    const outputs: string[] = []
    client.on((event) => {
      if (event.kind === 'command-output') {
        outputs.push(event.text)
      }
    })
    try {
      const ready = await client.whenReady()
      expect(ready.negotiatedProtocolVersion).toBe(2)
      expect(ready.ready.supportedProtocolVersions).toContain(2)

      const commands = await client.getCommands()
      expect(commands.length).toBeGreaterThan(50)
      expect(commands.map((command) => command.name)).toContain('usage')

      // /usage is a local command: it must report agentInvoked=false and emit
      // its full output before the prompt settles.
      const result = await client.prompt('/usage')
      expect(result.agentInvoked).toBe(false)
      expect(outputs.length).toBeGreaterThan(0)
      expect(outputs.join('')).toContain('Usage')
    } finally {
      client.dispose()
    }
  }, 60_000)
})
