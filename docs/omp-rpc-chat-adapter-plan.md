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
- **sessionFile is a session id, not a path, for OMP.** OMP resumes by session
  id (`agent-status-extension-source.ts`, #8962) — its hook never reports a
  `session_file`, unlike pi/prime-agent. `use-omp-rpc-chat-session.ts` passes
  the pane's resolved `sessionId` as the contract's `sessionFile` argument.

## Open work, in recommended order

1. ~~Streaming turns over RPC~~ — **shipped (waves 1-2).** `prompt`/`steer`/
   `follow_up`/`abort`, message/tool/turn frames, and `extension_ui_request`
   are wired end-to-end into `NativeChat`: acquire/subscribe/release
   lifecycle, overlay rendering, D5 status override, composer send routing,
   the Follow up affordance, and the extension-UI card.
   **Handoff trigger — the one thing still gating it live.** `acquire()`
   only succeeds when the pane's PTY has *already exited* (it refuses,
   correctly, to kill a live PTY — see D2 above). Whether chat-view
   activation should kill-and-resume a live PTY is a product decision the
   user is making separately; wave 2 built the entire feature against the
   existing `OmpRpcChatAcquireResult` contract unchanged, so only the
   acquisition call site will need to change when that decision lands — no
   rework in the renderer. Until then, RPC engages only for panes whose PTY
   already exited on its own (e.g. a resumed/sleeping session), not a
   normal live "New tab -> OMP" pane.
2. **Hook delivery to the renderer for OMP panes** — still broken end to end
   (unrelated to the handoff trigger above, and a second reason RPC rarely
   engages today: `sessionFile`/`sessionId` is what gates acquisition, and
   it comes from this same broken hook chain). Four code gates were fixed in
   `763add4d4` and unit-proven, but a live pane still records nothing after
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
   the *removal* of that gate, not adding one.
7. Upstream PR against #10099, then UAT — blocked on items 1's handoff
   trigger and item 2's hook-delivery bug landing, since neither is
   meaningfully UAT-able without them.

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

## Verification baseline

Full sweep after wave 2 (`ca83db743`): 62,238 tests passing / 255 skipped, 13
failing — all 13 pre-existing in `src/renderer/src/components/automations/**`
(broken by upstream `cda2280d6`; same `hasCustomSchedule`/
`getAutomationOwnerTarget`/`AutomationsApi.create` breaks `tc:web` reports).
Zero failures in any `native-chat`/`omp-rpc` file. `tc:node` and `tc:cli`
clean; `tc:web` clean apart from the same 9 pre-existing `automations/**`
errors. (Earlier baseline of 11,626/83 predates unrelated test growth
elsewhere in the tree; re-measure from this note going forward, not that
figure.) Live: 494-command catalog and `/usage` rendering correctly in the
dev app (wave 1). Wave 2 shipped without a fresh live OMP probe per its
brief — the fake child (`fake-omp-rpc-child.ts`) covers the frames, and the
one live-gating fact this wave needed (D2's PTY-claim isolation) was
verified by reading the runtime code paths, not a live run.
