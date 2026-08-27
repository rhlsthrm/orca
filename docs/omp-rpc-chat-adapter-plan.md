# OMP RPC Chat adapter — working plan and state

Tracking issue: [stablyai/orca#10099](https://github.com/stablyai/orca/issues/10099)
Branch: `feat/omp-rpc-chat-adapter` (fork `rhlsthrm/orca`)

## Goal

Make Orca's Chat UI a real OMP JSONL RPC v2 client, as the first built-in
`input:"rpc"` / `transcript:"rpc"` structured agent adapter described in #10099. Orca
already ships the workspace shell and an OMP *transcript-tailing* Chat UI; the missing
load-bearing piece is protocol-faithful RPC, which is what unlocks streaming turns,
RPC-native questions/approvals, and extension UI.

Exit criterion is **full OMP parity**, delivered as a single full-parity PR, plus hands-on
UAT. Partial-parity PRs are explicitly not the plan.

## Source of truth

`src/shared/omp-rpc-protocol.ts` is the wire contract in code — prefer it over any prose.
This document records only decisions and live-probe facts that code does not carry.

## Shipped (this branch, oldest first)

| Commit | Content |
|---|---|
| `c6c94e922` | Shared RPC v2 wire contract + client interface |
| `35584140d` | Probe exposed over IPC (`ompRpc:getCommands`, `ompRpc:runLocalCommand`); `src/shared/omp-rpc-ipc-contract.ts` |
| `3d1b0d227` | Live catalog in composer; `/usage` routed off PTY to RPC, rendered with a "local command — agent not invoked" marker |
| `e91703bb6` | RPC v2 client: spawn, framing, ready validation, negotiation, strict chunk reassembly, correlation, scripted fake child (16 tests) |
| `5a14213e3` | Executable resolver — see "Traps" below (7 tests) |
| `aba1a9214` | Env-gated live probe against the installed `omp` (`ORCA_OMP_RPC_LIVE=1`) |
| `763add4d4` | Registers OMP `session_start` across four gates; also fixes a latent `prime-agent` drop |
| `a818b1d02` | Exclusive session ownership + proof-gated RPC↔PTY handoff (61 tests) |
| `8bb585d97` | **Wave 1.** Turn-lifecycle frames, extension_ui_request/response, steer/follow_up; `OmpRpcChatSession`/`OmpRpcChatSessionRegistry` (per-pane RPC ownership via `OmpRpcSessionOwner.handoffFromPty`); `ompRpcChat:*` IPC surface (acquire/release/send/abort/respondExtensionUi + subscribe push channel) |
| `9d569c481` | **Wave 1.** `ompRpcChat` exposed through preload (`src/preload/api/omp-rpc-chat-api.ts`) |
| `88d0af8e4` | **Wave 1.** `rpc` NativeChatSource; `omp-rpc-turn-reducer.ts` — pure reducer building the in-progress-turn overlay + one-pending-plus-queue extension-ui tracking. Verified live (omp 18.0.6): RPC message-in-progress frames carry no id matching any transcript entry, so RPC content is never id-merged (D4) — it renders as a leads-gated overlay instead, generalizing the hook-preview "leads" suppression so double-rendering a turn is impossible by construction |
| `c6e923344` | **Wave 2.** `use-omp-rpc-chat-session.ts` binds a pane to the acquired session (acquire/subscribe/release lifecycle, leak-free on unmount/view-away/pane-close/identity-rebind); `use-native-chat-omp-rpc-integration.ts` composes it into the overlay/status projections the view needs |
| `c22913b1a` | **Wave 2.** `NativeChatExtensionUiCard.tsx` — select/confirm/input/editor rendering for `extension_ui_request` (D7) |
| `9e2af8bb7` | **Wave 2.** `use-omp-rpc-chat-send.ts` + composer wiring — chat prompts route through the RPC session before the PTY fallback (D6); "Follow up" affordance |
| `ca83db743` | **Wave 2.** `NativeChatView.tsx` wiring — RPC overlay spliced into the message list, D5 status override, extension-UI card swap, Stop routed through `abort()` |
| `fcb5180aa` | **Wave 3.** Repairs 12 defects found by two independent adversarial reviews (same-lab Opus 5 + cross-lab GPT-5.6), each with a regression test. Two were critical: (a) `parseOmpRpcMessageUpdateFrame` faulted on the documented user-echo `message_update` (no `assistantMessageEvent`), latching `hasProtocolFault` and killing the session on the *first* prompt; (b) `isOmpRpcTurnActive` was content-derived, so it stayed true after every completed turn — permanent Stop button and a jammed suppression reset. Also: `exit`/`protocol-fault` now degrade the pane to PTY (D1) instead of no-oping behind a false comment; `disposeAll` disposes clients and releases claims so app-quit cannot orphan a second writer (D2); acquire/release serialized per pane with generation-guarded stores and a bounded `conflict` retry (fixes the 15s-release window and the StrictMode double-mount); extension-UI cards always offer cancel and never promote an option-less `select` (D7); fail-closed IPC rejection handling; per-block overlay gating keyed by `toolCallId` (D4); overlay text/tool-output/block-count caps; dead resume-launch fields dropped |
| `7c5d76fa0` | **Wave 3.** Mocks the `omp-rpc-chat` registrar in `register-core-handlers.test.ts` — wave 1 added `registerOmpRpcChatHandlers()` to `registerCoreHandlers()` but not the matching sibling mock, so the real module ran and tripped the suite's `electron` mock (absent `ipcMain`). The only genuine regression the full sweep caught |
| `24f667bb8` | **Wave 4.** Optional `IPtyProvider.getSlavePath`, local-provider-only — a read-only `readPtySlavePath(ptyProcesses.get(id))` delegate needed to derive OMP's own terminal-id |
| `977f71e87` | **Wave 4.** `omp-terminal-session-identity.ts` — Part A: resolves an OMP pane's session identity from OMP's own on-disk state (terminal breadcrumb, then newest-by-mtime cwd bucket), bypassing the broken hook chain (Decision 2). Every path is verified to exist before being returned (13 tests) |
| `5f5a90a28` | **Wave 4.** `ompRpcChat:resolveSessionIdentity` IPC handler wraps the resolver for the renderer, local-only, fail-closed |
| `640cfbc49` | **Wave 4.** `omp-rpc-chat-handback.ts` — `respawnPtyForOmpRpcChatHandback` spawns `omp --resume <id>` (existing `buildAgentResumeStartupPlan` resume path) and rebinds it into the exact pane that released RPC ownership, replacing the old ptyId, reusing the same store primitives `codex-detached-pane-restart.ts`'s in-place respawn uses |
| `2921d8437` | **Wave 4.** `use-omp-pane-session-identity.ts` resolves via the new IPC once a pane is visible (F9-style latch); wired into `NativeChatView.tsx` in place of the hook-derived `sessionId` feeding the RPC integration |
| `035522c5c` | **Wave 4.** Decision 1: `use-omp-rpc-chat-session.ts` kills the pane's live PTY before acquiring instead of only ever finding one already exited, and a new deferred, settle-gated hand-back effect (separate from the acquire effect, so F9 holds unchanged for it) releases + respawns once any in-flight turn settles, canceling if the pane returns to Chat view first |
| `8747bdbcb` | **Wave 5.** Shared IPC contract: `OmpRpcChatReleaseArgs.respawn` (hand-back intent) and the new `ompRpcChat:handback` push payload |
| `c044f34af` | **Wave 5.** Critical A fix: `killPtyBeforeOmpRpcAcquire` suppresses the pty exit (armed, not self-consumed) and proactively clears the tab's pty binding before killing. Critical B fix (renderer half): the unreachable settle-gated hand-back effect is removed; the acquire effect's cleanup/cancelled-before-acquired paths express hand-back intent via `release({ respawn })` and return immediately |
| `0eeed8186` | **Wave 5.** `handoffToPty`'s abort-on-streaming becomes an explicit opt-in (`allowAbort`, default false/unset) — no caller sets it true; default behavior waits (bounded) for a streaming turn to settle and fails closed if it doesn't |
| `393e51f7a` | **Wave 5.** `performRelease` only tears down and reports `released:true` on `handoffToPty`'s `'exited'` path — any other result fails closed (`released:false`), keeping the claim. Registry also tracks each pane's claimed session file path, exposed via `claimedSessionFilePaths()` (finding C's exclusion set) |
| `5b9cc9bee` | **Wave 5.** `omp-terminal-session-identity.ts` hardening: cwd normalization (realpath + trailing-slash strip, finding D) before breadcrumb/bucket comparison; `claimedSessionFilePaths` excludes another live pane's session from the mtime fallback (finding C) |
| `ab67e6711` | **Wave 5.** `ompRpcChat:release` pushes `ompRpcChat:handback` to the requesting sender once a respawn-intent release genuinely settles+exits; `use-omp-rpc-chat-handback-listener.ts`, wired into `TerminalPane` (stays mounted underneath `NativeChatView` through a "leave Chat view" unmount), performs the actual PTY respawn via the unchanged `respawnPtyForOmpRpcChatHandback`. Also wires finding E (`resolveSessionIdentity` verifies pty locality before scanning local disk) and finding C's exclusion set |

Note: commits are listed in dependency order, not `git log` order.

## Verified live facts (OMP 18.0.6, `/Users/rahul/.local/bin/omp`)

- `ready` frame advertises `protocolVersion: 1`, `supportedProtocolVersions: [1, 2]`,
  `maxFrameBytes: 1048576`, `maxReassembledFrameBytes: 67108864`. v2 negotiation succeeds.
- Command catalog returns 487–494 entries, including user-defined `/skill:*` commands.
- `prompt {message:"/usage"}` emits `command_output` frames, then a response carrying
  `data.agentInvoked: false`. Local commands must therefore **never** synthesize an
  assistant turn.
- v2 chunking is strictly in-order: one pending sequence, must start at index 0,
  `count >= 2`, per-chunk payload ≤256KiB, total `byteLength` ≥1MiB and ≤64MiB, exact
  byte-length match on completion. Deviations are protocol faults to surface, not tolerate
  — do not add an out-of-order/dedupe reassembler.
- Tool approval has **no dedicated frame**. It arrives as `extension_ui_request` with
  `method: "select"`, a free-text prompt, and Approve/Deny options.
- OMP has **no checkpoint verb**. Continuity is only `switch_session {sessionPath}` and
  `new_session {parentSession?}`, so checkpointing is a host-side convention.
- **`switch_session` requires the absolute session-file path, not the bare session id**
  (live-probed twice, omp 18.0.6, wave 3 / F12). Passing a bare id does **not** error — it
  silently fails to switch, and only a follow-up `get_state` reveals the session never
  changed (`sessionFile mismatch after switch`). This is the opposite of the CLI, whose
  `--resume` *does* accept a bare id; the two mechanisms are not interchangeable and
  conflating them was a real latent bug. Acquisition now resolves the real path via
  `resolveSessionFilePath('omp', …)` before switching, while the bare id remains the claim
  identity key. The env-gated probe that proves this lives in `omp-rpc-live.test.ts`.
- **Terminal-scoped breadcrumbs (`~/.omp/agent/terminal-sessions/<terminal-id>`) exist
  and are keyed by the plain basename of the pane's tty slave device path** — real files
  observed on this machine are named e.g. `ttys000`, matching `basename('/dev/ttys000')`,
  not any Orca-set env var (Orca sets `ORCA_PANE_KEY`/`ORCA_TAB_ID`, not one of OMP's
  recognized fallback identifiers `CMUX_SURFACE_ID`/`TMUX_PANE`/`TERM_SESSION_ID`/
  `WT_SESSION`, so OMP always falls through to the TTY path for an Orca-spawned pane).
  Content is `<cwd>\n<sessionFilePath>\n[fresh]` — a missing second line is only a
  legitimate non-stale state when the third line is `fresh` (a lazily-unmaterialized
  `/new` boundary), matching `continueRecent()`'s own documented validation rule
  (omp://session-switching-and-recent-listing.md).
- **No existing repo code computed OMP's session-directory cwd-encoding** before wave 4
  (`-<relative>` under home, `-tmp-<relative>` under the temp root, `--<encoded-absolute>--`
  otherwise) — `omp-terminal-session-identity.ts`'s `encodeOmpSessionCwdBucket` is a fresh
  implementation of the documented rule, verified against the real observed bucket name
  `-dev-projects-orca` for this repo's own checkout. The `--<encoded-absolute>--` case has
  no real-world example available to verify against; it is implemented per the literal
  spec and is only ever a fallback heuristic behind existence verification (see the trap
  below), so a wrong guess there degrades to "no candidate found," never a wrong write.

## Design decisions

- **Ownership registry is the only safety mechanism.** OMP does not enforce single-writer,
  so `src/shared/claimed-agent-rpc-owner.ts` deliberately shares *one* registry with
  `claimed-agent-pty-owner.ts` rather than standing up a parallel one. An RPC child and a
  PTY child must never write the same OMP session concurrently.
- **Handoff ordering is the invariant:** dispose → prove exit → release → resume. An
  unprovable exit keeps the claim held and returns `unverifiable` (fail closed).
- **Never hardcode OMP surface.** Slash commands come from the catalog at runtime; the
  typed decoder is a floor, not a ceiling (`command_output` is untyped).
- **Raw frames:** opt-in, bounded diagnostic capture. Not a durable ledger.
- No dynamic third-party adapter loader and no arbitrary renderer code — built-in adapter
  only, against #10099's contract.
- **D5 — status derives from the RPC turn, not the hook, while RPC owns the
  pane.** `session.status` is overridden to `'working'` whenever
  `isOmpRpcTurnActive` is true, so Stop/isWorking/viewState react to the RPC
  stream instead of a hook that a PTY-exited pane will never emit again.
- **D2 (verified during wave 2, not just assumed).** Plain local "New tab ->
  OMP" never registers a claim in the runtime's shared
  `ClaimedAgentPtyOwnerRegistry` (`src/main/ipc/pty/pane/agent-session-owners.ts`)
  — that registry is populated only by the remote/paired-device resume path
  (`terminal.ensureAgentSession`/`createAgentSession`), never by a local
  `pty:spawn`. Real dual-writer safety for the RPC<->PTY handoff comes from
  `isLocalPtyAlive` (a genuine OS-level `provider.hasPty(ptyId)` check) plus
  `OmpRpcSessionOwner`'s fail-closed exit-proof gates, not from registry
  sharing with that global registry. This is why `OmpRpcChatSessionRegistry`
  is deliberately its own isolated `ClaimedAgentPtyOwnerRegistry` instance.
- **The pane's OMP identity is a session id; the RPC wire needs a path.** OMP's hook
  reports only a `session_id`, never a `session_file` (`agent-status-extension-source.ts`,
  #8962), unlike pi/prime-agent — so `transcriptPath` is always null for omp panes. The id
  is therefore the *claim identity*, and the session-file path used for `switch_session` is
  resolved from it at the IPC boundary. Do not pass the id to `switch_session`; see the
  live-probed fact above for why that fails silently.
- **Decision 1 (wave 4, amended wave 5) — kill-and-resume on first chat use.**
  Chat-view activation for an OMP pane acquires the session by killing the pane's
  PTY (`pty.kill(ptyId, {keepHistory:true})`, single-PTY granularity, best-effort
  — the registry's existing liveness/exit-proof gate is the real proof) and
  resuming that same session in the RPC child, holding RPC ownership for the
  pane's life. Killing suppresses the exit first (`suppressPtyExit`, left armed
  — wave 5, Critical A) and proactively clears the tab's pty binding to a
  well-defined "RPC-owned, no PTY" state, rather than leaving an unsuppressed
  exit to route through the same teardown a genuine crash would (it closed the
  whole tab for the common single-pane case).
  **Wave 5 replaced the wave-4 hand-back design.** The original design used a
  second, `isVisible`-gated effect deferring past a tick then polling
  `turnState` indefinitely for settlement, reconciled with F9 as a separate
  effect from acquire/release. A cross-lab review found this effect is
  *unreachable*: the real "leave Chat view" trigger (`TerminalPane.tsx`'s
  portal render gate returning null) unmounts the whole hook, which `isVisible`
  flipping while mounted does not model — `rerender()` in the wave-4 tests
  modeled the wrong transition and is why they passed against the broken
  trigger (see the Traps entry below). The actual trigger — the *first*
  effect's unconditional cleanup — released through `handoffToPty`'s then-
  unconditional abort, so a mere view toggle silently aborted a live turn, the
  exact outcome F9 forbids, and never respawned a PTY at all.
  **Hand-back ownership now lives in main, not the renderer hook.** The acquire
  effect's cleanup (and its cancelled-before-acquired race) express intent via
  `release({ paneKey, respawn: { replacedPtyId, cwd, sessionId } })` and return
  immediately — no polling, no settle-wait, in the renderer. Main's
  `handoffToPty` gates aborting behind an explicit, unused-by-default
  `allowAbort` opt-in (default: never abort; wait, bounded, for the turn to
  settle on its own; fail closed to `unverifiable` — keeping the claim — if it
  doesn't) and `performRelease` only tears down on the proven `'exited'`
  result. Only once release genuinely settles+exits does main push
  `ompRpcChat:handback` to the renderer; `use-omp-rpc-chat-handback-listener.ts`,
  subscribed once by `TerminalPane` (which stays mounted underneath
  `NativeChatView` through the very unmount that triggers hand-back), performs
  the actual `pty.spawn` + rebind via the unchanged
  `respawnPtyForOmpRpcChatHandback`. A respawned pty is still a fresh acquire
  identity (`ptyId` changed), so the F9 visibility latch still resets for it.
  **Known limitation, not fixed this wave:** if a turn never settles within
  `handoffToPty`'s bounded wait (`OMP_RPC_SETTLE_TIMEOUT_MS`, currently tuned
  for the settle-then-exit-proof sequence generally, not specifically for
  "user left Chat view mid-turn"), the release fails closed and nothing retries
  it — the pane is left with neither a live PTY nor a respawned one until the
  user returns to Chat view (which re-attaches to the still-running session,
  since `acquire()` finds and reuses it) or the process is otherwise handled.
  This trades a possibly-long "no terminal" window for never silently killing
  live work — deliberately, per the brief that drove this wave — but a
  durable retry-until-settled loop (mirroring the old effect's indefinite
  poll, just hosted where it can survive the unmount) is future work if that
  window proves too disruptive in UAT.
- **Decision 2 (wave 4, hardened wave 5) — bypass the broken hook, resolve from OMP's own on-disk
  state.** Rather than wait on open item 2's hook-delivery fix, the pane's OMP session
  identity is resolved directly from `~/.omp/agent/terminal-sessions/<terminal-id>`
  (preferred) or the newest-by-mtime file in the pane's encoded-cwd session bucket
  (fallback heuristic), then confirmed by the existing post-acquire `get_state()` check
  that was already in `OmpRpcSessionOwner.acquire()` from wave 3's F12 fix — that check
  already *is* Decision 2's "confirm via get_state," no new code was needed for it. Every
  resolved path is verified to exist on disk before being handed to `switch_session`
  (`omp-terminal-session-identity.ts`) — the single most dangerous failure mode this wave
  guards against is a wrong path silently minting an empty session (see the trap below).
  This closes open item 1's gate (b) without depending on item 2's fix; item 2 (hook
  delivery to the renderer) remains open and still blocks the *transcript-reading* path
  for a PTY-hosted (non-RPC-owned) OMP pane — a separate, still-broken concern this wave
  did not touch.
  **Wave 5 hardening (secondary review findings C/D/E, all Medium/Low, none exploitable):**
  the breadcrumb cwd comparison and cwd-bucket encoding now normalize both sides (realpath
  + trailing-slash strip) before comparing, so a symlinked worktree or a trailing slash no
  longer reads as stale-tty mismatch (finding D); the mtime fallback excludes session files
  another live pane already claimed via a new `claimedSessionFilePaths` option, so two panes
  sharing a cwd can no longer both resolve to the same session (finding C); and
  `resolveSessionIdentity`'s IPC handler now verifies pty locality itself via
  `localPtyProvider` before scanning local disk, rather than relying solely on the
  renderer's own `runtimeEnvironmentId === null` gate (finding E).

## Open work, in recommended order

1. ~~Streaming turns over RPC~~ — **built (waves 1-3), both handoff gates closed
   (wave 4), still not live-exercised against a real OMP pane.**
   `prompt`/`steer`/`follow_up`/`abort`, message/tool/turn frames, and
   `extension_ui_request` are wired end-to-end into `NativeChat`: acquire/subscribe/release
   lifecycle, overlay rendering, D5 status override, composer send routing, the Follow up
   affordance, and the extension-UI card. Two adversarial reviews then found 12 defects
   (2 critical, 6 high) — all fixed in `fcb5180aa` with a regression test each. **Every
   invariant D1-D7 has at least one test that fails if it regresses.**
   Wave 4 closed the two gates that previously blocked acquisition entirely:
   (a) *Handoff trigger* — **closed by Decision 1.** Acquisition now kills the pane's
   live PTY and resumes it in the RPC child, instead of only ever finding one already
   exited.
   (b) *No session id to acquire with* — **closed by Decision 2.** The pane's session
   identity is resolved from OMP's own on-disk state (breadcrumb, then mtime fallback),
   bypassing the broken hook chain entirely, rather than waiting on item 2's fix.
   Read this honestly: the feature is *tested*, still not *proven in a live app*.
   Wave 5 additionally repaired two Critical defects a cross-lab adversarial
   review found in wave 4's kill-and-resume/hand-back machinery — an
   unsuppressed kill that could close the whole tab (Critical A), and an
   unreachable hand-back effect whose real trigger silently aborted a live
   turn and never respawned a PTY (Critical B) — see Decision 1's amendment
   above. No end-to-end run against a real OMP pane has happened yet — that
   is explicitly the next wave's job, and it needs a human at the keyboard
   (New tab → OMP, open Chat, watch a real turn stream, switch to Terminal
   view mid-turn and back, confirm the interrupted-turn status row renders
   on a killed-mid-turn resume, confirm a mid-turn "leave Chat view" neither
   aborts the turn nor loses the PTY once it settles). The wave-1/2 and
   wave-4 experience is the argument for doing that UAT before trusting any
   of it: two waves in a row shipped a critical defect that only a live
   probe (wave 2) or a cross-lab adversarial review (wave 4) caught, never
   the wave's own test suite. Wave 4's own new mechanisms
   (terminal-id-from-tty-path, the cwd-bucket encoding's `--<encoded-absolute>--` branch)
   are similarly unverified against a real OMP process — see the "Verified live facts"
   caveats above.
2. **Hook delivery to the renderer for OMP panes** — still broken end to end. No longer
   blocks item 1's acquisition path (Decision 2 bypassed it), but still blocks the
   *transcript-reading* path for a PTY-hosted (non-RPC-owned) OMP pane: `sessionFile`/
   `sessionId` for that path still comes from this broken hook chain. Four code gates
   were fixed in `763add4d4` and unit-proven, but a live pane still records nothing after
   a *complete* turn. Proven chain: no hook event → `recordAgentProviderSession`
   never fires → no provider session id → `nativeChat.readSession` returns
   `{error:"Transcript unavailable", notFound:true}` → the chat view renders the user
   message but never the assistant reply, and `agentStatusByPaneKey` stays empty. `/usage`
   is unaffected only because it bypasses the transcript entirely.
   Prime suspect: prod and dev builds write the same
   `~/.omp/agent/extensions/orca-agent-status.ts`, so hook endpoint routing can cross apps.
   Check whether the extension embeds an endpoint at write time or reads it from env at
   runtime (`src/main/pi/agent-status-extension-source.ts`,
   `src/main/ipc/pty/host-env/pi-agent.ts`, `src/shared/agent-hook-endpoint-file.ts`).
3. Subagent frames; unknown-frame diagnostic rendering; opt-in raw capture.
4. Expand RPC command routing beyond the current `/usage`-only allowlist.
5. Subscribe to OMP's `session_switch` event — flagged by `763add4d4`, still unsubscribed.
6. SSH/remote runtime locality; mobile read parity (`nativeChatRequiresLocalTranscript`
   semantics change once RPC bypasses disk) — the RPC session hook is already
   local-only-gated (`runtimeEnvironmentId === null`), so this item is scoping
   the *removal* of that gate, not adding one. Wave 4's new mechanisms (`getSlavePath`,
   the terminal-id/breadcrumb resolver) are also local-provider-only today — a daemon or
   SSH pane's `getSlavePath` is absent, so those panes fall straight to the mtime-fallback
   heuristic; extending real breadcrumb resolution to them is part of this item, not done.
7. Upstream PR against #10099, then UAT — blocked on item 1's live exercise (this wave
   closed the gates that blocked it; the run itself still has not happened) and item 2's
   hook-delivery bug for full transcript-reading parity.

## Traps that cost real time

- `hydrateShellPath` (`src/main/startup/hydrate-shell-path.ts`) caches its result promise
  process-wide **including a cold-start timeout failure**, which made `omp` permanently
  unresolvable (`executable-not-found` forever). `src/main/ipc/omp-rpc-executable-resolver.ts`
  works around it: bare PATH → hydration → *forced* re-hydration → well-known posix
  installer paths. Do not "simplify" this back into a single hydration call.
- An empty `agentStatusByPaneKey` on a booted-but-unprompted pane is **designed** —
  identity routes to the cold-restore map (`sleepingAgentSessionsByPaneKey`). Do not treat
  it as the bug; the real gap only appears after a full turn.
- Reaching the Chat UI requires a tab with `launchAgent: "omp"` (New tab → OMP). Typing
  `omp` into a plain shell leaves `launchAgent: null` and the chat toggle stays gated.
- Use `npx -y pnpm@10.24.0`; the repo pins 10.24.0. Dev builds get a separate userData
  namespace and a deterministic CDP port of 9432.
- Repo gates that bite: oxlint forbids `Array<T>`; child processes only via
  `src/shared/child-process/`; `.ts` not `.d.ts` for owned types in `src/preload`/`src/shared`;
  never add a `max-lines` disable — split the file.
- **A wrong session path silently creates an empty session, not an error** —
  `setSessionFile` treats ENOENT and a malformed header as "empty" and initializes a
  brand-new session at that exact path. This is why `omp-terminal-session-identity.ts`
  verifies existence twice (once when accepting a breadcrumb/mtime candidate, once
  immediately before returning it) and why a stale breadcrumb (recorded cwd disagrees
  with the pane's actual cwd — tty device paths are reused across processes) is discarded
  rather than trusted. Any future caller of the resolved path must keep this discipline —
  never hand an unverified path to `switch_session`.
- **A `rerender()` in a hook test can silently model the wrong transition.**
  Wave 4's hand-back tests used `rerender({...BASE_ARGS, isVisible: false})`
  to simulate "leaving Chat view," but the real trigger unmounts the
  component (`TerminalPane.tsx`'s portal render gate returning null, not a
  prop change on a persistently-mounted instance) — `rerender()` re-renders
  the *same* mounted instance and cannot model an unmount. The suite was
  internally consistent with the resulting bug (Critical B) and gave false
  confidence; four tests had this mistake, all in the same describe block.
  **Any test asserting lifecycle behavior for a transition that unmounts a
  component in production must use `unmount()` (and remount where relevant),
  never `rerender()` with changed props** — a passing test that models the
  wrong transition is worse than no test. `rerender()` remains correct for
  transitions that genuinely happen on a persistently-mounted instance (e.g.
  F9's visibility toggle, or an identity rebind while still eligible).

## Verification baseline

Full sweep after wave 5 (`ab67e6711`): `npx -y pnpm@10.24.0 tc` — exactly 9
`tc:web` errors, all in `src/renderer/src/components/automations/**` at
identical file:line to wave 4's baseline (upstream `cda2280d6`), zero new;
`tc:node`/`tc:cli` clean. `check:code-quality:changed` — 0 findings across 98
changed files (code quality, type-aware code quality, React Doctor all
clean). `electron-vite build` clean (main + preload + renderer, exit 0).

Full `npx -y pnpm@10.24.0 test` (62,575 tests): 13 failures observed in one
full-suite run — 12 match wave 4's exact documented baseline, all pre-existing
and unrelated, each reproduced in isolation this wave too:
- 10 in `src/renderer/src/components/automations/**` (incl.
  `automation-scoped-list-client.test.ts`), the same `hasCustomSchedule`/
  `getAutomationOwnerTarget`/`AutomationsApi.create` `ReferenceError`s from
  upstream `cda2280d6` — same root cause as the 9 `tc:web` errors.
- 2 in `repro-13767-shell-ready-marker-lost-to-exec.test.ts` (real-subprocess
  PTY timing; imports nothing this branch touches).
- The 13th (`updater.startup-scheduling.test.ts`, a fake-timer scheduling
  assertion) is **not** in the documented baseline and touches code this
  branch never does (`src/main/updater.ts`); re-run in isolation it passed
  cleanly (10/10), confirming flake under full-suite parallel load, not a
  regression.

Zero failures in any `native-chat`/`omp-rpc`/`pty-provider`/`terminal-pane`
file — a combined targeted sweep of those four directories plus the main
`ipc/omp-rpc-chat.test.ts` file (527 files, 5104 tests) passed clean both
immediately after the code changes and again after the commits' pre-commit
`oxfmt --write` pass. New/changed wave-5 tests: 5 new
(`use-omp-rpc-chat-handback-listener.test.ts`) + rewritten hand-back/
suppression coverage in `use-omp-rpc-chat-session.test.ts` (29 tests, net +1
after removing 4 `rerender`-modeled hand-back tests and adding 5 `unmount`-
modeled ones) + 2 new + 1 rewritten in `omp-rpc-session-owner.test.ts` (10
tests) + 1 new + fixture fix in `omp-rpc-chat-session-registry.test.ts` (16
tests) + 4 new in `omp-terminal-session-identity.test.ts` (17 tests) + 4 new
in `omp-rpc-chat.test.ts` (18 tests) — all passing.

Live evidence so far: unchanged from wave 4 — the 494-command catalog and
`/usage` render correctly in the dev app (wave 1); wave 3's F12 probe
live-verified `switch_session` path-vs-id semantics. Everything wave 4 and 5
added, including every fix in this wave, rests on unit tests against real
temp-fs fixtures and a real (non-mocked) Zustand store — never a real OMP
process. **The streaming-turn path, the kill-and-resume acquire trigger, and
the hand-back respawn have still never run against a real OMP pane** — that
is explicitly the next wave's job (open item 1), and per the working rules
for this wave it was not attempted here.
