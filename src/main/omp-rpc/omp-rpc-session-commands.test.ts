// The interactive-command verbs' wire contract. Field names are the whole
// point: OMP's handlers read the property they expect, find `undefined` on a
// misspelled one, and answer `success: true` anyway — a renamed field is a
// silent no-op, not a compile error and not a wire error. These tests pin the
// exact frame each helper emits and prove that a payload the readers cannot
// trust rejects instead of reaching a caller half-decoded.

import { describe, expect, it } from 'vitest'
import type { OmpRpcCommand, OmpRpcModel } from '../../shared/omp-rpc-protocol'
import { OmpRpcSessionCommands } from './omp-rpc-session-commands'

/** A catalog row with every field the identity check requires. */
const MODEL: OmpRpcModel & Record<string, unknown> = {
  id: 'gpt-6-astra',
  name: 'GPT-6 Astra',
  provider: 'openai-codex',
  reasoning: true,
  contextWindow: 400_000,
  // Upstream's `Model` carries 100+ more fields; they must survive the reader.
  api: 'openai-responses',
  cost: { input: 1, output: 2 }
}

function makeCommands(respond: (command: OmpRpcCommand) => unknown = () => undefined) {
  const sent: OmpRpcCommand[] = []
  const commands = new OmpRpcSessionCommands({
    whenReady: () => Promise.resolve(),
    sendCommand: (command) => {
      sent.push(command)
      return Promise.resolve(respond(command))
    }
  })
  return { commands, sent }
}

describe('OMP RPC interactive command frames', () => {
  // One row per verb, because each row is a different wire contract with
  // different field names — not the same path with different arguments. A
  // wrong key here is the exact defect this suite exists to catch.
  const cases: {
    name: string
    run: (commands: OmpRpcSessionCommands) => Promise<unknown>
    frame: OmpRpcCommand
  }[] = [
    {
      name: 'set_model carries provider + modelId, never a nested model',
      run: (commands) => commands.setModel({ provider: 'anthropic', modelId: 'claude-opus-5' }),
      frame: { type: 'set_model', provider: 'anthropic', modelId: 'claude-opus-5' }
    },
    {
      name: 'cycle_model takes no payload',
      run: (commands) => commands.cycleModel(),
      frame: { type: 'cycle_model' }
    },
    {
      name: 'set_thinking_level carries level',
      run: (commands) => commands.setThinkingLevel('xhigh'),
      frame: { type: 'set_thinking_level', level: 'xhigh' }
    },
    {
      name: 'set_steering_mode carries mode',
      run: (commands) => commands.setSteeringMode('one-at-a-time'),
      frame: { type: 'set_steering_mode', mode: 'one-at-a-time' }
    },
    {
      name: 'set_follow_up_mode carries mode',
      run: (commands) => commands.setFollowUpMode('all'),
      frame: { type: 'set_follow_up_mode', mode: 'all' }
    },
    {
      name: 'set_interrupt_mode carries mode',
      run: (commands) => commands.setInterruptMode('immediate'),
      frame: { type: 'set_interrupt_mode', mode: 'immediate' }
    },
    {
      name: 'set_auto_compaction carries enabled',
      run: (commands) => commands.setAutoCompaction(false),
      frame: { type: 'set_auto_compaction', enabled: false }
    },
    {
      name: 'set_auto_retry carries enabled',
      run: (commands) => commands.setAutoRetry(true),
      frame: { type: 'set_auto_retry', enabled: true }
    },
    {
      name: 'abort_retry takes no payload',
      run: (commands) => commands.abortRetry(),
      frame: { type: 'abort_retry' }
    },
    {
      name: 'compact carries customInstructions',
      run: (commands) => commands.compact({ customInstructions: 'keep the repro' }),
      frame: { type: 'compact', customInstructions: 'keep the repro' }
    },
    {
      name: 'branch carries entryId',
      run: (commands) => commands.branch('entry-7'),
      frame: { type: 'branch', entryId: 'entry-7' }
    },
    {
      name: 'get_branch_messages takes no payload',
      run: (commands) => commands.getBranchMessages(),
      frame: { type: 'get_branch_messages' }
    },
    {
      name: 'set_session_name carries name',
      run: (commands) => commands.setSessionName('wire parity'),
      frame: { type: 'set_session_name', name: 'wire parity' }
    },
    {
      name: 'handoff carries customInstructions',
      run: (commands) => commands.handoff({ customInstructions: 'note the open PR' }),
      frame: { type: 'handoff', customInstructions: 'note the open PR' }
    },
    {
      name: 'new_session carries parentSession',
      run: (commands) => commands.newSession({ parentSession: '/sessions/parent.jsonl' }),
      frame: { type: 'new_session', parentSession: '/sessions/parent.jsonl' }
    },
    {
      name: 'export_html carries outputPath',
      run: (commands) => commands.exportHtml({ outputPath: '/tmp/session.html' }),
      frame: { type: 'export_html', outputPath: '/tmp/session.html' }
    },
    {
      name: 'login carries providerId',
      run: (commands) => commands.login('anthropic'),
      frame: { type: 'login', providerId: 'anthropic' }
    },
    {
      name: 'set_todos carries phases',
      run: (commands) =>
        commands.setTodos([{ name: 'wire', tasks: [{ content: 'ship', status: 'in_progress' }] }]),
      frame: {
        type: 'set_todos',
        phases: [{ name: 'wire', tasks: [{ content: 'ship', status: 'in_progress' }] }]
      }
    }
  ]

  for (const { name, run, frame } of cases) {
    it(name, async () => {
      const { commands, sent } = makeCommands((command) => respondFor(command))

      await run(commands)

      expect(sent).toEqual([frame])
    })
  }

  it('sends the model the child reported, not the pair that was requested', async () => {
    const { commands } = makeCommands(() => ({ ...MODEL, id: 'gpt-6-astra-high' }))

    await expect(
      commands.setModel({ provider: 'openai-codex', modelId: 'gpt-6-astra' })
    ).resolves.toMatchObject({ id: 'gpt-6-astra-high', provider: 'openai-codex' })
  })

  it('keeps upstream fields the reader does not name', async () => {
    const { commands } = makeCommands(() => ({ models: [MODEL] }))

    const [model] = await commands.getAvailableModels()

    expect(model).toMatchObject({ api: 'openai-responses', cost: { input: 1, output: 2 } })
  })

  // Every one of these would otherwise reach OMP as a command it accepts and
  // silently mismatches (an empty provider matches no catalog row; upstream
  // answers an empty session name with an error).
  it('refuses an empty required argument before anything reaches the wire', async () => {
    const { commands, sent } = makeCommands()

    await expect(commands.setModel({ provider: ' ', modelId: 'x' })).rejects.toThrow(
      'requires a provider and a model id'
    )
    await expect(commands.setModel({ provider: 'x', modelId: '' })).rejects.toThrow(
      'requires a provider and a model id'
    )
    await expect(commands.setSessionName('   ')).rejects.toThrow('session name is required')
    await expect(commands.branch('')).rejects.toThrow('requires an entry id')
    await expect(commands.login(' ')).rejects.toThrow('requires a provider id')
    expect(sent).toEqual([])
  })

  // F12, live-verified: `switch_session` takes a filesystem PATH. A bare
  // session id neither throws nor switches — upstream answers `success: true`
  // and keeps writing the session it was already on, so the mistake is
  // invisible on the wire and surfaces later as a pane whose claim no longer
  // matches its child. This guard is the only place the two are still
  // distinguishable, which is why it must refuse rather than send.
  it.each([
    ['a bare session id', '01JQ8ZK4X0000000000000000'],
    ['a relative path', 'sessions/a.jsonl'],
    ['a bare filename', 'a.jsonl'],
    ['a dot-relative path', './a.jsonl']
  ])('refuses %s as a session path without sending a no-op frame', async (_label, path) => {
    const { commands, sent } = makeCommands()

    await expect(commands.switchSession(path)).rejects.toThrow(
      `OMP RPC session path must be absolute, got: ${path}`
    )
    expect(sent).toEqual([])
  })

  it('sends switch_session for an absolute path, trimmed', async () => {
    const { commands, sent } = makeCommands()

    await commands.switchSession('  /sessions/a.jsonl  ')

    expect(sent).toEqual([{ type: 'switch_session', sessionPath: '/sessions/a.jsonl' }])
  })

  it('still refuses an empty session path', async () => {
    const { commands, sent } = makeCommands()

    await expect(commands.switchSession('   ')).rejects.toThrow('OMP RPC session path is required')
    expect(sent).toEqual([])
  })
})

describe('OMP RPC interactive command responses', () => {
  // Each identity field is separately load-bearing: `set_model` echoes
  // `provider` + `id` verbatim, so a row missing either is a picker entry that
  // can never be selected, and one missing `name` has no label to select. A
  // whole catalog of them must be reported as the protocol change it is —
  // handing the picker `[]` shows "no models" forever with nothing to recover
  // from.
  it.each(['id', 'name', 'provider'] as const)(
    'rejects a catalog whose rows all lack %s',
    async (field) => {
      const { [field]: _dropped, ...row } = MODEL
      const { commands } = makeCommands(() => ({ models: [row, row] }))

      await expect(commands.getAvailableModels()).rejects.toThrow(
        'OMP RPC get_available_models response was malformed'
      )
    }
  )

  it('accepts a genuinely empty catalog', async () => {
    const { commands } = makeCommands(() => ({ models: [] }))

    await expect(commands.getAvailableModels()).resolves.toEqual([])
  })

  it('drops one unreadable discovery row and keeps the rest', async () => {
    const { commands } = makeCommands(() => ({
      models: [MODEL, { id: 'half', name: 'Half', provider: '' }]
    }))

    await expect(commands.getAvailableModels()).resolves.toEqual([
      expect.objectContaining({ id: MODEL.id })
    ])
  })

  it('rejects a set_model echo that is not a model', async () => {
    const { commands } = makeCommands(() => ({ ok: true }))

    await expect(commands.setModel({ provider: 'p', modelId: 'm' })).rejects.toThrow(
      'OMP RPC set_model response was malformed'
    )
  })

  it('reports a null cycle as a real outcome rather than an error', async () => {
    const { commands } = makeCommands(() => null)

    await expect(commands.cycleModel()).resolves.toBeNull()
    await expect(commands.cycleThinkingLevel()).resolves.toBeNull()
  })

  it('rejects a cycled thinking level outside the effort list', async () => {
    // `inherit` is a valid selector to SEND and an impossible answer to a
    // cycle; accepting it would put a level in the UI the child is not using.
    const { commands } = makeCommands(() => ({ level: 'inherit' }))

    await expect(commands.cycleThinkingLevel()).rejects.toThrow(
      'OMP RPC cycle_thinking_level response was malformed'
    )
  })

  it('rejects a fast-mode reply missing the half that says it took', async () => {
    const { commands } = makeCommands(() => ({ enabled: true }))

    await expect(commands.setFastMode(true)).rejects.toThrow(
      'OMP RPC set_fast_mode response was malformed'
    )
  })

  it('rejects a login provider row missing its authentication state', async () => {
    // Without `authenticated` a picker renders an already-linked account as
    // one that still needs a login.
    const { commands } = makeCommands(() => ({
      providers: [{ id: 'anthropic', name: 'Anthropic', available: true }]
    }))

    await expect(commands.getLoginProviders()).rejects.toThrow(
      'OMP RPC get_login_providers response was malformed'
    )
  })

  it('rejects session stats with no token block', async () => {
    const { commands } = makeCommands(() => ({
      sessionId: 'session-a',
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      premiumRequests: 0,
      cost: 0
    }))

    await expect(commands.getSessionStats()).rejects.toThrow(
      'OMP RPC get_session_stats response was malformed'
    )
  })

  it('rejects a branch row set that is missing an entry id', async () => {
    const { commands } = makeCommands(() => ({ messages: [{ text: 'first turn' }] }))

    await expect(commands.getBranchMessages()).rejects.toThrow(
      'OMP RPC get_branch_messages response was malformed'
    )
  })

  it('rejects a todo phase carrying a status this build does not know', async () => {
    const { commands } = makeCommands(() => ({
      todoPhases: [{ name: 'wire', tasks: [{ content: 'ship', status: 'deferred' }] }]
    }))

    await expect(commands.setTodos([])).rejects.toThrow('OMP RPC set_todos response was malformed')
  })

  it('reads a null handoff as "no document written"', async () => {
    const { commands } = makeCommands(() => null)

    await expect(commands.handoff()).resolves.toBeNull()
  })

  // The roster keys and orders on these fields, so an admitted row missing one
  // renders an undefined entry rather than leaving a gap. Checked to the same
  // depth as the forwarded subagent frames, including nested progress.
  it.each([
    [
      'a row with no id',
      { index: 0, agent: 'scout', agentSource: 'bundled', status: 'running', lastUpdate: 1 }
    ],
    [
      'an unknown agent source',
      {
        id: 's1',
        index: 0,
        agent: 'scout',
        agentSource: 'plugin',
        status: 'running',
        lastUpdate: 1
      }
    ],
    [
      'an unknown status',
      {
        id: 's1',
        index: 0,
        agent: 'scout',
        agentSource: 'bundled',
        status: 'thinking',
        lastUpdate: 1
      }
    ],
    [
      'nested progress with no status',
      {
        id: 's1',
        index: 0,
        agent: 'scout',
        agentSource: 'bundled',
        status: 'running',
        lastUpdate: 1,
        progress: { id: 's1', index: 0, agent: 'scout', task: 'read' }
      }
    ]
  ])('rejects a subagent roster carrying %s', async (_label, row) => {
    const { commands } = makeCommands(() => ({ subagents: [row] }))

    await expect(commands.getSubagents()).rejects.toThrow(
      'OMP RPC get_subagents response was malformed'
    )
  })

  it('reads a roster row whose identity, status and progress all hold', async () => {
    const row = {
      id: 's1',
      index: 0,
      agent: 'scout',
      agentSource: 'bundled',
      status: 'running',
      lastUpdate: 1,
      progress: { id: 's1', index: 0, agent: 'scout', status: 'running', task: 'read' }
    }
    const { commands } = makeCommands(() => ({ subagents: [row] }))

    await expect(commands.getSubagents()).resolves.toEqual([row])
  })
})

/** The minimum valid payload for each verb, so the frame assertions above are
 *  not measuring validation failures. */
function respondFor(command: OmpRpcCommand): unknown {
  // A map, not a switch: only the verbs whose frames the assertions above send
  // need a payload, and an exhaustive switch over every OmpRpcCommand member
  // would enumerate 19 verbs this helper has no opinion about.
  const payloads: Partial<Record<OmpRpcCommand['type'], unknown>> = {
    set_model: MODEL,
    cycle_model: null,
    cycle_thinking_level: null,
    handoff: null,
    get_available_models: { models: [MODEL] },
    set_fast_mode: { enabled: true, active: true },
    compact: { summary: 's', firstKeptEntryId: 'e1', tokensBefore: 10 },
    branch: { text: 'first turn', cancelled: false },
    get_branch_messages: { messages: [{ entryId: 'e1', text: 'first turn' }] },
    new_session: { cancelled: false },
    export_html: { path: '/tmp/session.html' },
    get_login_providers: { providers: [] },
    login: { providerId: 'anthropic' },
    get_messages: { messages: [] },
    get_subagents: { subagents: [] },
    set_todos: { todoPhases: [] }
  }
  return payloads[command.type]
}
