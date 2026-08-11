import { appendFileSync } from "node:fs";

/**
 * Atomic VCS Hooks Plugin for OpenCode
 * 1 session = 1 view. Each turn records with provenance.
 *
 * v1.1: the stop payload carries everything the Atomic CLI consumes —
 * reasoning blocks, the turn's closing response, and per-turn token /
 * cost / step telemetry — buffered from the streamed part events. The
 * CLI still falls back to OpenCode's own store for anything a thin
 * plugin omits, so older installs keep working.
 */
export const AtomicHooksPlugin = async ({
  project,
  client,
  $,
  directory,
  worktree,
}) => {
  try {
    const v = Bun.spawnSync(["atomic", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (v.exitCode !== 0) return {};
    const d = Bun.spawnSync(["test", "-d", `${directory}/.atomic`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (d.exitCode !== 0) return {};
  } catch {
    return {};
  }

  let sid = null;
  let model = null;
  let provider = null;
  let turns = 0;
  const toolStartTimes = new Map();
  // Stash args from before-tool so after-tool can include them
  const toolArgs = new Map();
  // Reasoning capture: part.id -> { text, start, end }. Parts stream
  // incrementally via message.part.updated, so the latest snapshot wins.
  const reasoningParts = new Map();
  // Message ids known to belong to assistant messages, so streamed text
  // parts can be attributed — user prompts also arrive as text parts.
  const assistantMessages = new Set();
  // Assistant text parts of the current turn; latest snapshot wins.
  const textParts = new Map();
  // Per-turn step telemetry accumulated from step-start / step-finish.
  const stepStats = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    steps: 0,
    finish: null,
  };
  // Wall-clock turn start (set in chat.message) for turn_duration_ms.
  let turnStartTime = null;

  function logFailure(verb, message) {
    try {
      appendFileSync(
        `${directory}/.atomic/hook-errors.log`,
        `${new Date().toISOString()} ${verb} ${message}\n`,
      );
    } catch {}
  }

  async function hook(verb, payload) {
    try {
      const json = JSON.stringify(payload);
      const result =
        await $`echo ${json} | atomic agent hooks opencode ${verb}`.nothrow();
      if (result.exitCode !== 0) {
        logFailure(
          verb,
          `exit ${result.exitCode}: ${String(result.stderr).trim()}`,
        );
      }
    } catch (e) {
      logFailure(verb, String(e));
    }
  }

  // Turn boundary: drop everything buffered from the previous turn so a
  // turn that ended without session.idle (e.g., a crash) never leaks its
  // thinking, prose or telemetry into the next turn.
  function resetTurnBuffers() {
    reasoningParts.clear();
    textParts.clear();
    assistantMessages.clear();
    stepStats.input = 0;
    stepStats.output = 0;
    stepStats.reasoning = 0;
    stepStats.cacheRead = 0;
    stepStats.cacheWrite = 0;
    stepStats.cost = 0;
    stepStats.steps = 0;
    stepStats.finish = null;
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        // Accept both payload shapes, and never clobber a known id with
        // undefined — session.created can race plugin startup.
        sid = event.properties.sessionID ?? event.properties.info?.id ?? sid;
        if (!sid) return;
        await hook("session-start", {
          session_id: sid,
          source: "startup",
          cwd: directory,
          timestamp: new Date().toISOString(),
        });
      } else if (event.type === "message.updated") {
        // Remember which message ids are assistant so text parts can be
        // attributed to the answer rather than the user's prompt.
        const info = event.properties?.info;
        if (info?.role === "assistant" && info.id) {
          assistantMessages.add(info.id);
        }
      } else if (event.type === "session.idle") {
        // The idle event carries its own sessionID — use it to heal a sid
        // missed at session.created instead of dropping the turn.
        sid = sid ?? event.properties.sessionID;
        if (!sid) return;
        turns++;
        // Drain buffered reasoning into the stop payload. The CLI's
        // inject_reasoning_nodes prefers structured reasoning_blocks over
        // concatenated reasoning_text.
        const reasoning_blocks = [...reasoningParts.values()]
          .map((b) => ({
            text: (b.text || "").trim(),
            duration_ms:
              b.start != null && b.end != null
                ? Math.max(0, b.end - b.start)
                : undefined,
          }))
          .filter((b) => b.text.length > 0);
        // The turn's closing answer: the last non-empty assistant text
        // part streamed this turn.
        const response = [...textParts.values()]
          .map((t) => (t || "").trim())
          .filter((t) => t.length > 0)
          .pop();
        // Per-turn telemetry; only sent when steps were observed so a
        // chat-only turn adds no zero noise.
        const telemetry =
          stepStats.steps > 0
            ? {
                input_tokens: stepStats.input,
                output_tokens: stepStats.output,
                reasoning_tokens: stepStats.reasoning,
                cache_read_tokens: stepStats.cacheRead,
                cache_write_tokens: stepStats.cacheWrite,
                cost_usd: stepStats.cost > 0 ? stepStats.cost : undefined,
                finish_reason: stepStats.finish ?? undefined,
                step_count: stepStats.steps,
              }
            : {};
        resetTurnBuffers();
        const turn_duration_ms =
          turnStartTime != null ? Date.now() - turnStartTime : undefined;
        turnStartTime = null;
        await hook("stop", {
          session_id: sid,
          turn_number: turns,
          model: model,
          provider: provider,
          turn_duration_ms,
          reasoning_blocks:
            reasoning_blocks.length > 0 ? reasoning_blocks : undefined,
          response,
          ...telemetry,
          cwd: directory,
          timestamp: new Date().toISOString(),
        });
      } else if (event.type === "message.part.updated") {
        // Parts stream incrementally; keep the latest snapshot per part
        // so turn end has the full text.
        const part = event.properties?.part;
        if (!part) return;
        if (part.type === "reasoning") {
          reasoningParts.set(part.id, {
            text: part.text ?? "",
            start: part.time?.start,
            end: part.time?.end,
          });
        } else if (part.type === "text") {
          if (part.messageID && assistantMessages.has(part.messageID)) {
            textParts.set(part.id, part.text ?? "");
          }
        } else if (part.type === "step-start") {
          stepStats.steps += 1;
        } else if (part.type === "step-finish") {
          const t = part.tokens ?? {};
          stepStats.input += t.input ?? 0;
          stepStats.output += t.output ?? 0;
          stepStats.reasoning += t.reasoning ?? 0;
          stepStats.cacheRead += t.cache?.read ?? 0;
          stepStats.cacheWrite += t.cache?.write ?? 0;
          stepStats.cost += part.cost ?? 0;
          if (part.reason) stepStats.finish = part.reason;
        }
      } else if (event.type === "message.part.removed") {
        const partId = event.properties?.partID;
        if (partId) {
          reasoningParts.delete(partId);
          textParts.delete(partId);
        }
      } else if (event.type === "session.deleted") {
        sid = sid ?? event.properties.sessionID;
        resetTurnBuffers();
        turnStartTime = null;
        if (!sid) return;
        await hook("session-end", {
          session_id: sid,
          reason: "deleted",
          cwd: directory,
          timestamp: new Date().toISOString(),
        });
      }
    },

    "chat.message": async (input, output) => {
      if (input.model) {
        model = input.model.modelID;
        provider = input.model.providerID;
      }
      sid = sid || input.sessionID;
      // Turn boundary: start the wall clock and drop anything buffered
      // from a turn that ended without session.idle (e.g., a crash), so
      // stale thinking is never attributed to the wrong turn.
      resetTurnBuffers();
      turnStartTime = Date.now();
      const prompt = output.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      await hook("user-prompt", {
        session_id: sid || input.sessionID,
        prompt: prompt || undefined,
        model: model,
        provider: provider,
        cwd: directory,
        timestamp: new Date().toISOString(),
      });
    },

    "tool.execute.before": async (input, output) => {
      sid = sid || input.sessionID;
      if (!sid) return;
      const args = output.args || {};
      toolStartTimes.set(input.callID, Date.now());
      toolArgs.set(input.callID, args);
      await hook("before-tool", {
        session_id: sid,
        tool_name: input.tool,
        tool_call_id: input.callID,
        tool_input: args,
        cwd: directory,
        timestamp: new Date().toISOString(),
      });
    },

    "tool.execute.after": async (input, output) => {
      sid = sid || input.sessionID;
      if (!sid) return;
      const startTime = toolStartTimes.get(input.callID);
      const duration = startTime ? Date.now() - startTime : undefined;
      const args = toolArgs.get(input.callID) || {};
      toolStartTimes.delete(input.callID);
      toolArgs.delete(input.callID);

      // Capture result — truncate long output
      const rawOutput = output.output;
      const title = output.title;
      const metadata = output.metadata;
      let toolOutput;
      if (typeof rawOutput === "string") {
        toolOutput =
          rawOutput.length > 2048 ? rawOutput.slice(0, 2048) + "…" : rawOutput;
      }
      const exit = metadata?.exit;

      await hook("after-tool", {
        session_id: sid,
        tool_name: input.tool,
        tool_call_id: input.callID,
        tool_input: args,
        tool_output: toolOutput,
        title,
        file_path: args.filePath || args.path,
        exit_code: typeof exit === "number" ? exit : undefined,
        status: "completed",
        duration: duration,
        cwd: directory,
        timestamp: new Date().toISOString(),
      });
    },

    "shell.env": async (_input, output) => {
      output.env.ATOMIC_AGENT = "opencode";
      output.env.ATOMIC_AGENT_VERSION = "1.1.0";
    },
  };
};
