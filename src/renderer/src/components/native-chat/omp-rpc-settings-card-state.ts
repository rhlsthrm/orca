// State reading shared by the settings-family cards. Split out so the two
// card modules stay inside the line budget and, more importantly, so the
// "absent means UNKNOWN" rule has exactly one implementation: every settings
// card marks `current` from a value OMP actually reported, and discloses the
// gap with the same wording when it reported none.

import type { OmpRpcSessionState } from '../../../../shared/omp-rpc-protocol'
import type {
  OmpRpcInteractiveCardOption,
  OmpRpcInteractiveCommandContext
} from './omp-rpc-interactive-command-registry'

export const UNREPORTED_STATE_NOTE =
  'OMP did not report the current value, so no row is marked as active.'

export const ENABLED_OPTION_ID = 'on'
export const DISABLED_OPTION_ID = 'off'

/** The child's state, or null when the read failed. A failed read is not an
 *  error for most cards — it only costs them the `current` marker. */
export async function readSessionState(
  ctx: OmpRpcInteractiveCommandContext
): Promise<OmpRpcSessionState | null> {
  const state = await ctx.api.getState({ paneKey: ctx.paneKey })
  return state.ok ? state.data : null
}

/** Rows for a two-state toggle whose current value may be unknown: `undefined`
 *  marks neither row, which is the only honest rendering of "OMP said
 *  nothing" — `false` would claim the setting is off. */
export function toggleOptions(
  enabled: boolean | undefined,
  labels: { on: string; off: string }
): readonly OmpRpcInteractiveCardOption[] {
  return [
    { id: ENABLED_OPTION_ID, label: labels.on, ...(enabled === true ? { current: true } : {}) },
    { id: DISABLED_OPTION_ID, label: labels.off, ...(enabled === false ? { current: true } : {}) }
  ]
}
