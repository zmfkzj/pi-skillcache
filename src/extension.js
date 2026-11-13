/** Pi adapter: explicit reviewed capsules plus opt-in auto compilation/replay evidence. */
import { listCapsules, loadCapsule, executeCapsule } from "./capsule.js";
import { autoCacheStatus, autoSettings, clearAutoCache, createAutoEngine, setAutoEnabled } from "./auto.js";

const CHANNEL = "oh-my-pi-extensions:dependencies";
const WORKER_CHANNEL = "orche:worker-capability";
const WORKER_CAPABILITY = "skillcache";
const USAGE = [
  "/skillcache status | list | inspect ID | run ID [key=value...]",
  "/skillcache auto on|off|status|clear (opt-in, persistent per trusted project)",
  "/skillcache trace start|stop|report (metadata only: names/counts)",
  "/skillcache doctor | install-deps | help",
  "Auto mode replays only identical prompts with validated, unchanged, read-only traces as LLM evidence.",
  "Other tools, changed inputs and failed validations fall back to the ordinary agent without blocking it.",
].join("\n");
const CMDS = ["status", "list", "inspect", "run", "auto", "trace", "doctor", "install-deps", "help"];

function parseRunArgs(rest) {
  const [id, ...parameters] = rest;
  if (!id) throw new Error("missing capsule ID");
  const inputs = {};
  for (const item of parameters) {
    const match = /^([a-zA-Z][a-zA-Z0-9_]{0,63})=(.*)$/.exec(item);
    if (!match || !match[2] || Object.hasOwn(inputs, match[1])) throw new Error("invalid or duplicate parameter '" + item + "'");
    inputs[match[1]] = match[2];
  }
  return { id, inputs };
}
function report() {
  return { items: [{ name: "Node.js", status: "ok", detail: process.version }], note: "Node-only, read-only capsules; auto mode requires explicit trusted-project enablement." };
}

export function createSkillCacheExtension({ trustedCwd: delegatedTrust } = {}) {
  return function skillcache(pi) {
    // Only an explicitly trusted *main* session may delegate this exact cwd to an isolated orche worker.
    const isTrusted = ctx => !!ctx?.isProjectTrusted?.() || !!delegatedTrust && ctx?.cwd === delegatedTrust;
    const authorizedContext = ctx => isTrusted(ctx) && !ctx?.isProjectTrusted?.()
      ? Object.assign(Object.create(ctx), { isProjectTrusted: () => true }) : ctx;
    const trace = { active: false, calls: new Map(), count: 0 };
    const auto = createAutoEngine();
    let workerEnabled = false;
    let trustedCwd = null;
    const provider = { id: "pi-skillcache", label: "pi-skillcache", command: "/skillcache", check: async () => report(), install: async () => report() };
    pi.events?.on(CHANNEL, (event) => {
      if (event?.version === 1 && typeof event?.provide === "function") event.provide(provider);
    });
    pi.on?.("session_start", async (_event, ctx) => {
      trustedCwd = isTrusted(ctx) ? ctx.cwd : null;
      try { workerEnabled = !!trustedCwd && (await autoSettings(trustedCwd)).enabled; }
      catch { workerEnabled = false; }
    });
    // Optional orche capability: newly spawned worker sessions load their OWN isolated engine.
    // No prompt, tool arguments, or result objects cross the worker capability channel.
    pi.events?.on(WORKER_CHANNEL, (request) => {
      if (!workerEnabled || request?.capability !== WORKER_CAPABILITY || request?.cwd !== trustedCwd ||
          typeof request.provide !== "function") return;
      request.provide({
        key: "pi-skillcache/auto@1", tools: [], extensionFactories: [createSkillCacheExtension({ trustedCwd })],
        instructions: "SkillCache may supply fresh, hash-guarded read-only evidence for repeated identical requests; it never establishes task success or replaces verification.",
      });
    });
    pi.on?.("before_agent_start", (event, ctx) => auto.before(event, authorizedContext(ctx)));
    pi.on?.("tool_call", (event, ctx) => {
      if (trace.active) {
        const name = String(event?.toolName ?? event?.name ?? "unknown").slice(0, 80);
        trace.calls.set(name, (trace.calls.get(name) ?? 0) + 1);
        trace.count++;
      }
      auto.toolCall(event, authorizedContext(ctx));
    });
    pi.on?.("tool_result", (event, ctx) => auto.toolResult(event, authorizedContext(ctx)));
    pi.on?.("agent_before_settle", (event) => auto.settlement(event));
    pi.on?.("agent_settled", (event, ctx) => auto.settled(event, authorizedContext(ctx)));
    pi.on?.("session_shutdown", () => { auto.reset(); workerEnabled = false; trustedCwd = null; });
    pi.on?.("session_before_switch", () => auto.reset());
    pi.on?.("session_before_tree", () => auto.reset());

    pi.registerCommand("skillcache", {
      description: "Read-only capsule replay and opt-in automatic compilation: /skillcache auto on|off|status",
      getArgumentCompletions: (prefix) => {
        const value = String(prefix ?? "").trim();
        if (value.includes(" ")) return null;
        const matches = CMDS.filter(command => command.startsWith(value));
        return matches.length ? matches.map(command => ({ value: command, label: command })) : null;
      },
      handler: async (args, ctx) => {
        const [command = "help", ...rest] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
        const notify = (message, level = "info") => ctx.ui?.notify?.(message, level);
        if (command === "help") return notify(USAGE);
        if (command === "doctor" || command === "install-deps") return notify("pi-skillcache " + command + ": healthy\n" + report().note + "\nNode.js: " + process.version);
        if (command === "trace") {
          if (rest.length !== 1 || !["start", "stop", "report"].includes(rest[0])) return notify(USAGE, "warning");
          if (rest[0] === "start") {
            trace.active = true; trace.calls.clear(); trace.count = 0;
            return notify("SkillCache trace observation enabled for this session (tool names/counts only).");
          }
          if (rest[0] === "stop") { trace.active = false; return notify("SkillCache trace observation stopped."); }
          const detail = [...trace.calls].sort((a, b) => b[1] - a[1]).map(([name, count]) => "- " + name + ": " + count).join("\n") || "(none)";
          return notify("SkillCache trace: " + trace.count + " tool calls" + (trace.active ? " (active)" : "") + ".\n" + detail);
        }
        if (command === "status") {
          if (!isTrusted(ctx)) return notify("SkillCache: project is not trusted; auto mode disabled.", "warning");
          try {
            const count = await listCapsules(ctx.cwd);
            const s = await autoCacheStatus(ctx.cwd);
            return notify("SkillCache: " + count.length + " reviewed capsule(s); automatic replay " + (s.enabled ? "ON" : "OFF") +
              ", compiled " + s.count + ", session hits " + auto.metrics.hits + ", compiled " + auto.metrics.compiled +
              ", fallback " + auto.metrics.fallbacks + ", skipped " + auto.metrics.skipped + "; trace " + (trace.active ? "enabled" : "disabled") + ".");
          } catch (e) { return notify("SkillCache status unavailable: " + e.message, "warning"); }
        }
        if (!isTrusted(ctx)) return notify("SkillCache requires a trusted project to inspect, compile or replay local capsules.", "warning");
        try {
          if (command === "auto") {
            if (rest.length !== 1 || !["on", "off", "clear", "status"].includes(rest[0])) return notify(USAGE, "warning");
            if (rest[0] === "on" || rest[0] === "off") {
              await setAutoEnabled(ctx.cwd, rest[0] === "on");
              trustedCwd = ctx.cwd;
              workerEnabled = rest[0] === "on";
              auto.reset();
              return notify("SkillCache automatic read-only compilation/replay " + rest[0].toUpperCase() + ". Project-local, exact prompt matching; ordinary agent remains active.\nCache files are private under the Pi agent data directory, outside the project Git tree.");
            }
            if (rest[0] === "clear") return notify("SkillCache cleared " + await clearAutoCache(ctx.cwd) + " auto-compiled capsule(s); reviewed capsules unaffected.");
            const s = await autoCacheStatus(ctx.cwd);
            return notify("SkillCache auto " + (s.enabled ? "ON" : "OFF") + ", compiled " + s.count +
              "; hits " + auto.metrics.hits + ", misses " + auto.metrics.misses +
              ", fallbacks " + auto.metrics.fallbacks + ", skipped " + auto.metrics.skipped + ".");
          }
          if (command === "list") {
            const names = await listCapsules(ctx.cwd);
            return notify("SkillCache reviewed capsules (" + names.length + "):\n" + (names.join("\n") || "(none)"));
          }
          if (command === "inspect") {
            if (rest.length !== 1) return notify(USAGE, "warning");
            const capsule = await loadCapsule(ctx.cwd, rest[0]);
            return notify(JSON.stringify({ id: capsule.id, description: capsule.description, steps: capsule.steps.length, guards: capsule.guards?.length ?? 0, approved: capsule.approved }, null, 2));
          }
          if (command === "run") {
            const { id, inputs } = parseRunArgs(rest);
            ctx.ui?.setStatus?.("skillcache", "Running " + id + "...");
            try {
              const output = await executeCapsule(await loadCapsule(ctx.cwd, id), { cwd: ctx.cwd, inputs });
              const serialized = JSON.stringify(output, null, 2);
              const clipped = serialized.length > 12000 ? serialized.slice(0, 12000) + "\n[display truncated]" : serialized;
              return notify("SkillCache " + id + ": replay OK (read-only)\n" + clipped);
            } finally { ctx.ui?.setStatus?.("skillcache", undefined); }
          }
          return notify(USAGE, "warning");
        } catch (error) {
          return notify("SkillCache aborted, use the ordinary agent/skill instead: " + (error instanceof Error ? error.message : String(error)), "warning");
        }
      },
    });
  };
}
