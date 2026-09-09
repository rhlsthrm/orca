// Informational and auth interactive command cards for the RPC chat pane:
// `/login`, `/context`, `/stats`, `/subagents`, `/export`.
//
// Every card here reads a single RPC verb and renders exactly what came back.
// The three dashboards omit `apply` (read-only chrome, nothing to dispatch);
// `/login` and `/export` are the two that act. Nothing in this module computes
// a number OMP did not send, and nothing substitutes a zero for an absent
// field: an optional stat OMP omitted loses its row and is called out in the
// card's `note`, because a dashboard row reading "0" is a claim about the
// child's state, not a gap.

import type {
  OmpRpcLoginProvider,
  OmpRpcSessionStats,
  OmpRpcSubagentSnapshot
} from '../../../../shared/omp-rpc-protocol'
import type {
  OmpRpcInteractiveCardLoadResult,
  OmpRpcInteractiveCardOption,
  OmpRpcInteractiveCardRow,
  OmpRpcInteractiveCommandCard,
  OmpRpcInteractiveCommandContext
} from './omp-rpc-interactive-command-registry'

/** Longest free-text fragment (a subagent task, a provider note) a dashboard
 *  row carries. A row is a summary line, not a transcript. */
const MAX_ROW_DETAIL_LENGTH = 96

function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : String(value)
}

/** Presentation only: OMP sends `percent` as a number, and a raw
 *  `41.66666666666667%` is noise. Never rounded into a different claim —
 *  an integer percent stays integral. */
function formatPercent(percent: number): string {
  if (!Number.isFinite(percent)) {
    return String(percent)
  }
  return `${Number.isInteger(percent) ? percent : Number(percent.toFixed(1))}%`
}

/** OMP reports cost in dollars. Sub-cent costs keep four decimals because
 *  `$0.00` for a real charge reads as free. */
function formatUsd(cost: number): string {
  if (!Number.isFinite(cost)) {
    return String(cost)
  }
  const magnitude = Math.abs(cost)
  return `$${cost.toFixed(magnitude > 0 && magnitude < 0.01 ? 4 : 2)}`
}

function truncateDetail(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_ROW_DETAIL_LENGTH
    ? `${collapsed.slice(0, MAX_ROW_DETAIL_LENGTH - 1)}…`
    : collapsed
}

/** `available: false` means the provider cannot be logged into at all, so the
 *  row is shown (the account exists) but not selectable. `authenticated` is
 *  reported per row by OMP, so it is safe to state; it is NOT rendered as
 *  `current`, since several providers can be signed in at once and `current`
 *  means "the one active selection". */
function loginProviderOption(provider: OmpRpcLoginProvider): OmpRpcInteractiveCardOption {
  const description = !provider.available
    ? 'Unavailable in this session'
    : provider.authenticated
      ? 'Signed in — logging in again replaces the stored credential'
      : 'Not signed in'
  return {
    id: provider.id,
    label: provider.name,
    description,
    disabled: !provider.available
  }
}

const LOGIN_CARD: OmpRpcInteractiveCommandCard = {
  command: 'login',
  title: 'Sign in to a provider',
  kind: 'select',
  async load(ctx: OmpRpcInteractiveCommandContext): Promise<OmpRpcInteractiveCardLoadResult> {
    const result = await ctx.api.getLoginProviders({ paneKey: ctx.paneKey })
    if (!result.ok) {
      return { error: `OMP could not list login providers: ${result.reason}` }
    }
    if (result.data.length === 0) {
      // Why: an empty picker is indistinguishable from a broken one, and there
      // is nothing to synthesize — OMP genuinely published no providers.
      return { error: 'OMP reported no login providers for this session.' }
    }
    return {
      kind: 'select',
      options: result.data.map(loginProviderOption),
      note: 'OAuth continues in the prompts OMP sends next — the sign-in URL and any code arrive as their own cards.'
    }
  },
  async apply(ctx, choice) {
    if (choice.kind !== 'select') {
      return { ok: false, message: 'Login needs a provider selection.' }
    }
    const result = await ctx.api.login({ paneKey: ctx.paneKey, providerId: choice.optionId })
    if (!result.ok) {
      return { ok: false, message: `Login failed: ${result.reason}` }
    }
    // Why the payload's id and not `choice.optionId`: the result names the
    // credential the child actually persisted, which is the only thing that
    // happened. `login` resolving is upstream's statement that the credential
    // was stored; it carries no URL or instruction text (main validates the
    // payload down to `{ providerId }`), so there is nothing else to report.
    return { ok: true, message: `OMP stored the credential for ${result.data.providerId}.` }
  }
}

const CONTEXT_CARD: OmpRpcInteractiveCommandCard = {
  command: 'context',
  title: 'Context window',
  kind: 'dashboard',
  async load(ctx: OmpRpcInteractiveCommandContext): Promise<OmpRpcInteractiveCardLoadResult> {
    const result = await ctx.api.getState({ paneKey: ctx.paneKey })
    if (!result.ok) {
      return { error: `OMP could not report context usage: ${result.reason}` }
    }
    const usage = result.data.contextUsage
    if (!usage) {
      // Why: `contextUsage` is optional on purpose — absent means OMP sent
      // nothing this reader can trust, and zeros would be a fabricated claim.
      return { error: 'OMP reported no context usage for this session.' }
    }
    const rows: OmpRpcInteractiveCardRow[] = [
      { label: 'Tokens used', value: formatCount(usage.tokens) },
      { label: 'Context window', value: formatCount(usage.contextWindow) },
      { label: 'Used', value: formatPercent(usage.percent) }
    ]
    const model = result.data.model
    if (model) {
      rows.push({ label: 'Model', value: `${model.name} (${model.provider}/${model.id})` })
    }
    return { kind: 'dashboard', rows }
  }
}

function statsRows(stats: OmpRpcSessionStats): OmpRpcInteractiveCardRow[] {
  const rows: OmpRpcInteractiveCardRow[] = [{ label: 'Session', value: stats.sessionId }]
  if (stats.sessionFile) {
    rows.push({ label: 'Session file', value: stats.sessionFile })
  }
  rows.push(
    {
      label: 'Messages',
      value: `${formatCount(stats.totalMessages)} total · ${formatCount(stats.userMessages)} user · ${formatCount(stats.assistantMessages)} assistant`
    },
    {
      label: 'Tools',
      value: `${formatCount(stats.toolCalls)} calls · ${formatCount(stats.toolResults)} results`
    },
    { label: 'Tokens', value: formatCount(stats.tokens.total) },
    {
      label: 'Tokens in / out',
      value: `${formatCount(stats.tokens.input)} in · ${formatCount(stats.tokens.output)} out`
    },
    { label: 'Reasoning tokens', value: formatCount(stats.tokens.reasoning) },
    {
      label: 'Cache read / write',
      value: `${formatCount(stats.tokens.cacheRead)} read · ${formatCount(stats.tokens.cacheWrite)} written`
    },
    { label: 'Premium requests', value: formatCount(stats.premiumRequests) },
    { label: 'Cost', value: formatUsd(stats.cost) }
  )
  if (stats.credits) {
    rows.push({
      label: 'Credits',
      value: `${formatUsd(stats.credits.cost)} · ${formatUsd(stats.credits.committedCost)} committed · ${formatCount(stats.credits.acuCost)} ACU`
    })
  }
  for (const [modelId, turns] of Object.entries(stats.routedModels ?? {})) {
    rows.push({ label: `Routed · ${modelId}`, value: `${formatCount(turns)} turns` })
  }
  if (stats.contextUsage) {
    rows.push({
      label: 'Context',
      value: `${formatCount(stats.contextUsage.tokens)} / ${formatCount(stats.contextUsage.contextWindow)} · ${formatPercent(stats.contextUsage.percent)}`
    })
  }
  return rows
}

const STATS_CARD: OmpRpcInteractiveCommandCard = {
  command: 'stats',
  title: 'Session stats',
  kind: 'dashboard',
  async load(ctx: OmpRpcInteractiveCommandContext): Promise<OmpRpcInteractiveCardLoadResult> {
    const result = await ctx.api.getSessionStats({ paneKey: ctx.paneKey })
    if (!result.ok) {
      return { error: `OMP could not report session stats: ${result.reason}` }
    }
    const stats = result.data
    return {
      kind: 'dashboard',
      rows: statsRows(stats),
      note: stats.contextUsage
        ? undefined
        : 'OMP reported no context-window usage with these stats.'
    }
  }
}

function subagentRow(subagent: OmpRpcSubagentSnapshot): OmpRpcInteractiveCardRow {
  const detail = subagent.description ?? subagent.task ?? subagent.assignment
  const parts: string[] = [subagent.status]
  if (detail) {
    parts.push(truncateDetail(detail))
  }
  const progress = subagent.progress
  if (progress?.currentTool) {
    parts.push(`in ${progress.currentTool}`)
  }
  if (typeof progress?.toolCount === 'number') {
    parts.push(`${formatCount(progress.toolCount)} tools`)
  }
  if (typeof progress?.tokens === 'number') {
    parts.push(`${formatCount(progress.tokens)} tokens`)
  }
  if (typeof progress?.cost === 'number') {
    parts.push(formatUsd(progress.cost))
  }
  return { label: `#${subagent.index} ${subagent.agent}`, value: parts.join(' · ') }
}

const SUBAGENTS_CARD: OmpRpcInteractiveCommandCard = {
  command: 'subagents',
  title: 'Subagents',
  kind: 'dashboard',
  async load(ctx: OmpRpcInteractiveCommandContext): Promise<OmpRpcInteractiveCardLoadResult> {
    const result = await ctx.api.getSubagents({ paneKey: ctx.paneKey })
    if (!result.ok) {
      return { error: `OMP could not report subagents: ${result.reason}` }
    }
    if (result.data.length === 0) {
      // Why a dashboard and not an error: "no subagents" is a real, useful
      // answer to the question the command asks, unlike a failed read.
      return {
        kind: 'dashboard',
        rows: [],
        note: 'OMP reported no subagents for this session.'
      }
    }
    return { kind: 'dashboard', rows: result.data.map(subagentRow) }
  }
}

const EXPORT_CARD: OmpRpcInteractiveCommandCard = {
  command: 'export',
  title: 'Export transcript to HTML',
  kind: 'input',
  async load(): Promise<OmpRpcInteractiveCardLoadResult> {
    return {
      kind: 'input',
      label: 'Output path',
      placeholder: 'Leave blank to let OMP choose the file',
      submitLabel: 'Export'
    }
  },
  async apply(ctx, choice) {
    if (choice.kind !== 'input') {
      return { ok: false, message: 'Export needs an output path or an empty one.' }
    }
    const outputPath = choice.text.trim()
    const result = await ctx.api.exportHtml({
      paneKey: ctx.paneKey,
      // Why omit rather than send '': upstream treats a missing outputPath as
      // "pick the default", and an empty string is a path it would try to use.
      ...(outputPath ? { outputPath } : {})
    })
    if (!result.ok) {
      return { ok: false, message: `Export failed: ${result.reason}` }
    }
    const written = result.data.path.trim()
    if (!written) {
      return { ok: true, message: 'OMP exported the transcript but reported no output path.' }
    }
    return { ok: true, message: `Exported to ${written}` }
  }
}

/** Consumed by the interactive-command registry index. */
export const OMP_RPC_INFO_COMMAND_CARDS: readonly OmpRpcInteractiveCommandCard[] = [
  LOGIN_CARD,
  CONTEXT_CARD,
  STATS_CARD,
  SUBAGENTS_CARD,
  EXPORT_CARD
]
