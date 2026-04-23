/**
 * Atomic VCS Hooks Plugin for OpenCode
 * 1 session = 1 view. Each turn records with provenance.
 */
export const AtomicHooksPlugin = async ({ project, client, $, directory, worktree }) => {
  try {
    const v = Bun.spawnSync(["atomic", "--version"], { stdout: "pipe", stderr: "pipe" });
    if (v.exitCode !== 0) return {};
    const d = Bun.spawnSync(["test", "-d", `${directory}/.atomic`], { stdout: "pipe", stderr: "pipe" });
    if (d.exitCode !== 0) return {};
  } catch { return {}; }

  let sid = null;
  let model = null;
  let provider = null;
  let turns = 0;

  async function hook(verb, payload) {
    try {
      const json = JSON.stringify(payload);
      await $`echo ${json} | atomic agent hooks opencode ${verb} 2>/dev/null`.nothrow();
    } catch {}
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        sid = event.properties.sessionID;
        await hook("session-start", {
          session_id: sid, source: "startup",
          cwd: directory, timestamp: new Date().toISOString(),
        });
      } else if (event.type === "session.idle") {
        if (!sid) return;
        turns++;
        await hook("stop", {
          session_id: sid, turn_number: turns,
          model: model, provider: provider,
          cwd: directory, timestamp: new Date().toISOString(),
        });
      } else if (event.type === "session.deleted") {
        if (!sid) return;
        await hook("session-end", {
          session_id: sid, reason: "deleted",
          cwd: directory, timestamp: new Date().toISOString(),
        });
      }
    },

    "chat.message": async (input, output) => {
      if (input.model) {
        model = input.model.modelID;
        provider = input.model.providerID;
      }
      const prompt = output.parts.filter(p => p.type === "text").map(p => p.text).join("\n").trim();
      await hook("user-prompt", {
        session_id: sid || input.sessionID,
        prompt: prompt || undefined,
        model: model, provider: provider,
        cwd: directory, timestamp: new Date().toISOString(),
      });
    },

    "shell.env": async (_input, output) => {
      output.env.ATOMIC_AGENT = "opencode";
      output.env.ATOMIC_AGENT_VERSION = "1.0.0";
    },
  };
};
