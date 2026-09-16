# Concurrent session validation (2026-09-16)

Atomic intent `ATOM::vince::1` (`01M2NY9KRPQMD2GH15V2430NEN`) in the
atomic-opencode project; view `fix/subagent-session-isolation`.
Base: release commit `60132da85ed81e6a2a3ef438424e07a43aaf07dd` (includes #7).

The plugin previously shared one session ID, tool maps and turn buffers across
all parent/child callbacks. The regression fixture reproduces wrong-session
routing against that version. State and hook ordering are now per session, with
explicit event IDs and foreground CLI completion. There is no global hook queue.

`bun test`: 5 tests, 21 assertions pass. Coverage includes interleaved tools,
reasoning, response, model and telemetry; independent progress while one session
is delayed; missing startup and duplicate idle; nonzero Stop failure/retry; and
repeated part snapshots and session deletion.

A real OpenCode 1.18.30 run used a parent and two overlapping atomic subagents
with openrouter/openai/gpt-5-mini. The Atomic test binary combined PR #190 at
67b74c8881ce4afe8a758beea093bc486a1da3f7, PR #189 at
9c6fdff35a6a6ce73ea6a8c79eea1a26af136828, and a separate bounded session-start
lock-wait fix. All 21 tool calls completed, all three checkpoints published,
and frozen journal tool IDs matched their OpenCode sessions with no missing
completed calls or foreign calls. All three provenance hashes verified.
No lock warnings or plugin hook failures were observed.

This test does not prove independent file ownership in a shared working tree:
one child Stop recorded both child files, the other had a provenance-only
checkpoint, and those files appear untracked from the parent's current view.
The files were preserved in history. Correct session routing does not provide
workspace isolation or merge child changes into a parent view.

The persistent test server was allowed 15 seconds to drain callbacks before
shutdown. Immediate process-exit delivery and crash durability of in-memory
plugin buffers are not guaranteed by this change. Stop retry coverage applies
to a reported nonzero CLI exit; a CLI that logs an error but returns success
cannot be distinguished by the plugin's exit-code check.

Raw local evidence: enclosing workspace .gstack/subagent-fixes-20260916,
including live-with189/provenance-audit.json and live-server-audit.json.
