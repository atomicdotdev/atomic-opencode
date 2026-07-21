import { appendFileSync } from "node:fs";

/**
 * Atomic VCS Hooks Plugin for OpenCode
 * 1 session = 1 view. Each turn records with provenance.
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
        reasoningParts.clear();
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
          cwd: directory,
          timestamp: new Date().toISOString(),
        });
      } else if (event.type === "message.part.updated") {
        // Reasoning parts stream incrementally; keep the latest snapshot
        // per part so turn end has the full thinking text.
        const part = event.properties?.part;
        if (part?.type === "reasoning") {
          reasoningParts.set(part.id, {
            text: part.text ?? "",
            start: part.time?.start,
            end: part.time?.end,
          });
        }
      } else if (event.type === "message.part.removed") {
        const partId = event.properties?.partID;
        if (partId) reasoningParts.delete(partId);
      } else if (event.type === "session.deleted") {
        sid = sid ?? event.properties.sessionID;
        reasoningParts.clear();
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
      // Turn boundary: start the wall clock and drop reasoning buffered
      // from a turn that ended without session.idle (e.g., a crash), so
      // stale thinking is never attributed to the wrong turn.
      reasoningParts.clear();
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

      await hook("after-tool", {
        session_id: sid,
        tool_name: input.tool,
        tool_call_id: input.callID,
        tool_input: args,
        tool_output: toolOutput,
        title,
        file_path: args.filePath || args.path,
        status: "completed",
        duration: duration,
        cwd: directory,
        timestamp: new Date().toISOString(),
      });
    },

    "shell.env": async (_input, output) => {
      output.env.ATOMIC_AGENT = "opencode";
      output.env.ATOMIC_AGENT_VERSION = "1.0.0";
    },
  };
};
