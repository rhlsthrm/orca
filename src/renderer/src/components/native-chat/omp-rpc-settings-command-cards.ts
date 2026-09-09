// Settings-family interactive command cards: the model picker `/switch` and
// `/model` degrade to `Current model: …` over RPC, `/thinking` is not even
// advertised as a command (its text would reach the model as a prompt), and
// `/compact` answers with a one-liner instead of asking how to summarize.
// The value pickers with no text command at all — fast mode, automatic
// compaction, the queue drains — live in omp-rpc-settings-toggle-cards.ts and
// are re-exported through the family array at the bottom.
//
// Two rules run through both files. An absent `get_state` field means
// UNKNOWN, never `false`: the card then marks no row current and says so in
// `note`, because a guessed marker is a claim about the child's state. And
// nothing here reports a result the verb did not return — `setModel` quotes
// the model the CHILD selected, and a `void` verb's success is reported as
// accepted, not as a value.

import {
  OMP_RPC_THINKING_LEVELS,
  type OmpRpcModel,
  type OmpRpcThinkingLevel
} from '../../../../shared/omp-rpc-protocol'
import type { OmpRpcInteractiveCommandCard } from './omp-rpc-interactive-command-registry'
import { readSessionState, UNREPORTED_STATE_NOTE } from './omp-rpc-settings-card-state'
import { OMP_RPC_SETTINGS_TOGGLE_CARDS } from './omp-rpc-settings-toggle-cards'

/** Longest fragment of OMP's own summary text a result message repeats. */
const MAX_SUMMARY_LENGTH = 200

const THINKING_LEVEL_LABELS: Record<OmpRpcThinkingLevel, string> = {
  inherit: 'Inherit',
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-high',
  max: 'Max'
}

/** `provider` and `id` are what `set_model` must echo verbatim, and neither is
 *  constrained to a separator-free string — JSON is the encoding that cannot
 *  be ambiguous, and `apply` has no other way to recover them (a card's
 *  `apply` never sees the rows its `load` produced). */
function encodeModelOptionId(model: OmpRpcModel): string {
  return JSON.stringify([model.provider, model.id])
}

function decodeModelOptionId(optionId: string): { provider: string; modelId: string } | null {
  try {
    const decoded: unknown = JSON.parse(optionId)
    if (
      Array.isArray(decoded) &&
      typeof decoded[0] === 'string' &&
      typeof decoded[1] === 'string'
    ) {
      return { provider: decoded[0], modelId: decoded[1] }
    }
  } catch {
    return null
  }
  return null
}

function describeModel(model: OmpRpcModel): string {
  const parts = [model.provider]
  if (typeof model.contextWindow === 'number' && Number.isFinite(model.contextWindow)) {
    parts.push(`${model.contextWindow.toLocaleString('en-US')} token context`)
  }
  if (model.reasoning === true) {
    parts.push('reasoning')
  }
  return parts.join(' · ')
}

/**
 * `/switch` + `/model`: OMP publishes both, and both print the current model
 * instead of opening its picker. Rows come from `get_available_models` only —
 * a failed read is an error, never an empty list.
 */
const MODEL_CARD: OmpRpcInteractiveCommandCard = {
  command: 'switch',
  aliases: ['model'],
  title: 'Model',
  kind: 'select',
  async load(ctx) {
    const [models, state] = await Promise.all([
      ctx.api.getAvailableModels({ paneKey: ctx.paneKey }),
      ctx.api.getState({ paneKey: ctx.paneKey })
    ])
    if (!models.ok) {
      return { error: `OMP could not list its models: ${models.reason}` }
    }
    const current = state.ok ? state.data.model : undefined
    const options = models.data.map((model) => ({
      id: encodeModelOptionId(model),
      label: model.name,
      description: describeModel(model),
      ...(current?.provider === model.provider && current.id === model.id ? { current: true } : {})
    }))
    return { kind: 'select', options, ...(current ? {} : { note: UNREPORTED_STATE_NOTE }) }
  },
  async apply(ctx, choice) {
    if (choice.kind !== 'select') {
      return { ok: false, message: 'The model card needs a model row.' }
    }
    const decoded = decodeModelOptionId(choice.optionId)
    if (!decoded) {
      return { ok: false, message: 'That model row could not be read.' }
    }
    const result = await ctx.api.setModel({ paneKey: ctx.paneKey, ...decoded })
    return result.ok
      ? { ok: true, message: `Model set to ${result.data.name} (${result.data.provider}).` }
      : { ok: false, message: `Model could not be changed: ${result.reason}` }
  }
}

/** `/thinking` is a TUI-only builtin: OMP does not advertise it over RPC, so
 *  today its text is handed to the model as a prompt. */
const THINKING_CARD: OmpRpcInteractiveCommandCard = {
  command: 'thinking',
  title: 'Thinking level',
  kind: 'select',
  async load(ctx) {
    const state = await readSessionState(ctx)
    const current = state?.thinkingLevel
    const notes = [
      ...(current ? [] : [UNREPORTED_STATE_NOTE]),
      ...(state?.model?.reasoning === false
        ? ['OMP reports the active model does not reason, so a level may have no effect.']
        : [])
    ]
    return {
      kind: 'select',
      options: OMP_RPC_THINKING_LEVELS.map((level) => ({
        id: level,
        label: THINKING_LEVEL_LABELS[level],
        ...(level === current ? { current: true } : {})
      })),
      ...(notes.length > 0 ? { note: notes.join(' ') } : {})
    }
  },
  async apply(ctx, choice) {
    const level = OMP_RPC_THINKING_LEVELS.find(
      (candidate) => choice.kind === 'select' && candidate === choice.optionId
    )
    if (!level) {
      return { ok: false, message: 'That thinking level is not one OMP accepts.' }
    }
    const result = await ctx.api.setThinkingLevel({ paneKey: ctx.paneKey, level })
    return result.ok
      ? { ok: true, message: `Thinking level set to ${THINKING_LEVEL_LABELS[level]}.` }
      : { ok: false, message: `Thinking level could not be changed: ${result.reason}` }
  }
}

/** `/compact` runs the child's summarizer, so it is the one card here that
 *  makes the model work — hence `invokesAgent`, which keeps the command marker
 *  from claiming the agent was never invoked. */
const COMPACT_CARD: OmpRpcInteractiveCommandCard = {
  command: 'compact',
  title: 'Compact context',
  kind: 'input',
  invokesAgent: true,
  async load(ctx) {
    const usage = (await readSessionState(ctx))?.contextUsage
    const notes = [
      'Compaction summarizes the conversation with the model and can take minutes.',
      ...(usage
        ? [
            `Context now: ${usage.tokens.toLocaleString('en-US')} of ${usage.contextWindow.toLocaleString('en-US')} tokens.`
          ]
        : [])
    ]
    return {
      kind: 'input',
      label: 'Summary instructions (optional)',
      placeholder: "Leave empty for OMP's own summary",
      submitLabel: 'Compact',
      note: notes.join(' ')
    }
  },
  async apply(ctx, choice) {
    if (choice.kind !== 'input') {
      return { ok: false, message: 'The compaction card needs its instructions field.' }
    }
    const customInstructions = choice.text.trim()
    const result = await ctx.api.compact({
      paneKey: ctx.paneKey,
      ...(customInstructions ? { customInstructions } : {})
    })
    if (!result.ok) {
      return { ok: false, message: `Compaction failed: ${result.reason}` }
    }
    const summary = result.data.shortSummary?.trim()
    return {
      ok: true,
      message: summary
        ? `Context compacted: ${summary.slice(0, MAX_SUMMARY_LENGTH)}`
        : 'Context compacted.'
    }
  }
}

export const OMP_RPC_SETTINGS_COMMAND_CARDS: readonly OmpRpcInteractiveCommandCard[] = [
  MODEL_CARD,
  THINKING_CARD,
  COMPACT_CARD,
  ...OMP_RPC_SETTINGS_TOGGLE_CARDS
]
