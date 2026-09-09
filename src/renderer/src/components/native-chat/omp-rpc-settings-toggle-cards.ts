// The settings-family cards that pick between a fixed set of values OMP owns:
// fast mode, automatic compaction, and the two queue drains plus interrupt
// timing. None of these has a slash command over RPC at all — they are verbs
// with no text handler — so each card below is the pane's only way to reach
// one, and it renders the child's reported value or none.

import {
  OMP_RPC_INTERRUPT_MODES,
  OMP_RPC_QUEUE_MODES,
  type OmpRpcInterruptMode,
  type OmpRpcQueueMode,
  type OmpRpcSessionState
} from '../../../../shared/omp-rpc-protocol'
import type { OmpRpcChatCommandResult } from '../../../../shared/omp-rpc-chat-ipc-contract'
import type {
  OmpRpcInteractiveCardApplyResult,
  OmpRpcInteractiveCardLoadResult,
  OmpRpcInteractiveCommandCard,
  OmpRpcInteractiveCommandContext
} from './omp-rpc-interactive-command-registry'
import {
  ENABLED_OPTION_ID,
  readSessionState,
  toggleOptions,
  UNREPORTED_STATE_NOTE
} from './omp-rpc-settings-card-state'

const QUEUE_MODE_LABELS: Record<OmpRpcQueueMode, string> = {
  all: 'All queued messages at once',
  'one-at-a-time': 'One queued message at a time'
}

const INTERRUPT_MODE_LABELS: Record<OmpRpcInterruptMode, string> = {
  immediate: 'Interrupt immediately',
  wait: 'Wait for the running tool call'
}

/** Fast mode has two halves: `enabled` is the request, `active` is whether the
 *  model can serve it, and the verb reports both. */
const FAST_MODE_CARD: OmpRpcInteractiveCommandCard = {
  command: 'fast',
  aliases: ['fast-mode'],
  title: 'Fast mode',
  kind: 'select',
  async load(ctx) {
    const state = await readSessionState(ctx)
    const enabled = state?.fastModeEnabled
    const notes = [
      ...(enabled === undefined ? [UNREPORTED_STATE_NOTE] : []),
      ...(enabled === true && state?.fastModeActive === false
        ? ['OMP reports fast mode enabled but not active for the current model.']
        : [])
    ]
    return {
      kind: 'select',
      options: toggleOptions(enabled, { on: 'Fast mode on', off: 'Fast mode off' }),
      ...(notes.length > 0 ? { note: notes.join(' ') } : {})
    }
  },
  async apply(ctx, choice) {
    if (choice.kind !== 'select') {
      return { ok: false, message: 'The fast-mode card needs a row.' }
    }
    const enabled = choice.optionId === ENABLED_OPTION_ID
    const result = await ctx.api.setFastMode({ paneKey: ctx.paneKey, enabled })
    if (!result.ok) {
      return { ok: false, message: `Fast mode could not be changed: ${result.reason}` }
    }
    if (result.data.enabled && !result.data.active) {
      return { ok: true, message: 'Fast mode enabled, but the current model cannot serve it.' }
    }
    return { ok: true, message: result.data.enabled ? 'Fast mode enabled.' : 'Fast mode disabled.' }
  }
}

const AUTO_COMPACTION_CARD: OmpRpcInteractiveCommandCard = {
  command: 'auto-compact',
  aliases: ['autocompact'],
  title: 'Automatic compaction',
  kind: 'select',
  async load(ctx) {
    const enabled = (await readSessionState(ctx))?.autoCompactionEnabled
    return {
      kind: 'select',
      options: toggleOptions(enabled, {
        on: 'Compact automatically when the context fills',
        off: 'Never compact automatically'
      }),
      ...(enabled === undefined ? { note: UNREPORTED_STATE_NOTE } : {})
    }
  },
  async apply(ctx, choice) {
    if (choice.kind !== 'select') {
      return { ok: false, message: 'The automatic-compaction card needs a row.' }
    }
    const enabled = choice.optionId === ENABLED_OPTION_ID
    const result = await ctx.api.setAutoCompaction({ paneKey: ctx.paneKey, enabled })
    return result.ok
      ? { ok: true, message: `Automatic compaction ${enabled ? 'enabled' : 'disabled'}.` }
      : { ok: false, message: `Automatic compaction could not be changed: ${result.reason}` }
  }
}

/** The three queue/interrupt selectors differ only in which verb they write
 *  and which `get_state` field they read, so they are built rather than
 *  copied: a divergence between them would be a bug, not a feature. */
function queueModeCard<Mode extends string>(spec: {
  command: string
  aliases?: readonly string[]
  title: string
  modes: readonly Mode[]
  labels: Record<Mode, string>
  readCurrent: (state: OmpRpcSessionState) => Mode | undefined
  write: (
    ctx: OmpRpcInteractiveCommandContext,
    mode: Mode
  ) => Promise<OmpRpcChatCommandResult<void>>
}): OmpRpcInteractiveCommandCard {
  return {
    command: spec.command,
    ...(spec.aliases ? { aliases: spec.aliases } : {}),
    title: spec.title,
    kind: 'select',
    async load(ctx): Promise<OmpRpcInteractiveCardLoadResult> {
      const state = await readSessionState(ctx)
      const current = state ? spec.readCurrent(state) : undefined
      return {
        kind: 'select',
        options: spec.modes.map((mode) => ({
          id: mode,
          label: spec.labels[mode],
          ...(mode === current ? { current: true } : {})
        })),
        ...(current ? {} : { note: UNREPORTED_STATE_NOTE })
      }
    },
    async apply(ctx, choice): Promise<OmpRpcInteractiveCardApplyResult> {
      const mode = spec.modes.find(
        (candidate) => choice.kind === 'select' && candidate === choice.optionId
      )
      if (!mode) {
        return { ok: false, message: `That is not a ${spec.title.toLowerCase()} OMP accepts.` }
      }
      const result = await spec.write(ctx, mode)
      return result.ok
        ? { ok: true, message: `${spec.title} set to: ${spec.labels[mode]}.` }
        : { ok: false, message: `${spec.title} could not be changed: ${result.reason}` }
    }
  }
}

export const OMP_RPC_SETTINGS_TOGGLE_CARDS: readonly OmpRpcInteractiveCommandCard[] = [
  FAST_MODE_CARD,
  AUTO_COMPACTION_CARD,
  queueModeCard<OmpRpcQueueMode>({
    command: 'steering',
    aliases: ['steering-mode'],
    title: 'Steering queue',
    modes: OMP_RPC_QUEUE_MODES,
    labels: QUEUE_MODE_LABELS,
    readCurrent: (state) => state.steeringMode,
    write: (ctx, mode) => ctx.api.setSteeringMode({ paneKey: ctx.paneKey, mode })
  }),
  queueModeCard<OmpRpcQueueMode>({
    command: 'follow-up',
    aliases: ['followup', 'follow-up-mode'],
    title: 'Follow-up queue',
    modes: OMP_RPC_QUEUE_MODES,
    labels: QUEUE_MODE_LABELS,
    readCurrent: (state) => state.followUpMode,
    write: (ctx, mode) => ctx.api.setFollowUpMode({ paneKey: ctx.paneKey, mode })
  }),
  queueModeCard<OmpRpcInterruptMode>({
    command: 'interrupt',
    aliases: ['interrupt-mode'],
    title: 'Interrupt timing',
    modes: OMP_RPC_INTERRUPT_MODES,
    labels: INTERRUPT_MODE_LABELS,
    readCurrent: (state) => state.interruptMode,
    write: (ctx, mode) => ctx.api.setInterruptMode({ paneKey: ctx.paneKey, mode })
  })
]
