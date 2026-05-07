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
  let turnActive = false;
  const toolStartTimes = new Map();


  // Serialize all hook calls so concurrent opencode events (e.g.,
  // session.created + chat.message firing back-to-back) don't race on
  // session.json — atomic's SessionStore has no file lock, last writer wins.
  let hookQueue: Promise<unknown> = Promise.resolve();
  async function hook(verb, payload) {
    const json = JSON.stringify(payload);
    const next = hookQueue.then(async () => {
      try {
        await $`echo ${json} | atomic agent hooks opencode ${verb} 2>/dev/null`.nothrow();
      } catch {}
    });
    hookQueue = next.catch(() => {});
    await next;
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        sid = event.properties.sessionID;
        await hook("session-start", {
          session_id: sid,
          source: "startup",
          cwd: directory,
          timestamp: new Date().toISOString(),
        });
      } else if (event.type === "session.idle") {
        if (!sid || !turnActive) return;
        turnActive = false;
        turns++;
        await hook("after-agent", {
          session_id: sid,
          turn_number: turns,
          model: model,
          provider: provider,
          cwd: directory,
          timestamp: new Date().toISOString(),
        });
      } else if (event.type === "session.deleted") {
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
      const prompt = output.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      turnActive = true;
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
      if (!sid) return;
      toolStartTimes.set(input.callID, Date.now());
      await hook("before-tool", {
        session_id: sid,
        tool_name: input.tool,
        tool_call_id: input.callID,
        tool_input: output?.args ?? {},
        cwd: directory,
        timestamp: new Date().toISOString(),
      });
    },

    "tool.execute.after": async (input, output) => {
      if (!sid) return;
      const startTime = toolStartTimes.get(input.callID);
      const duration = startTime ? Date.now() - startTime : undefined;
      toolStartTimes.delete(input.callID);
      await hook("after-tool", {
        session_id: sid,
        tool_name: input.tool,
        tool_call_id: input.callID,
        tool_input: input.args ?? {},
        tool_response: {
          title: output?.title,
          output: output?.output,
          metadata: output?.metadata,
        },
        status: "completed",
        duration_ms: duration,
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
