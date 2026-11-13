/** Passive Pi adapter for explicit, read-only capsule inspection and replay. */
import { listCapsules, loadCapsule, executeCapsule } from "./capsule.js";

const CHANNEL = "oh-my-pi-extensions:dependencies";
const USAGE = [
  "/skillcache status | list | inspect ID | run ID [key=value...]",
  "/skillcache trace start|stop|report (metadata only; no prompts, arguments, results or secrets are retained)",
  "/skillcache doctor | install-deps | help",
  "Replay is explicit, read-only and requires a trusted project; automatic compilation is NOT implemented.",
].join("\n");
const CMDS = ["status", "list", "inspect", "run", "trace", "doctor", "install-deps", "help"];

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
  return { items: [{ name: "Node.js", status: "ok", detail: process.version }], note: "Node-only, read-only capsule prototype; no external dependencies or install actions." };
}

export function createSkillCacheExtension() {
  return function skillcache(pi) {
    const trace = { active: false, calls: new Map(), count: 0 };
    const provider = { id: "pi-skillcache", label: "pi-skillcache", command: "/skillcache", check: async () => report(), install: async () => report() };
    pi.events?.on(CHANNEL, (event) => {
      if (event?.version === 1 && typeof event?.provide === "function") event.provide(provider);
    });
    pi.on?.("tool_call", (event) => {
      if (!trace.active) return;
      const name = String(event?.toolName ?? event?.name ?? "unknown").slice(0, 80);
      trace.calls.set(name, (trace.calls.get(name) ?? 0) + 1);
      trace.count++;
    });

    pi.registerCommand("skillcache", {
      description: "Explicit, read-only capsule replay; /skillcache status|list|run|trace|doctor",
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
          const count = await listCapsules(ctx.cwd);
          return notify("SkillCache: " + count.length + " capsule(s); replay is manual-only; trace " + (trace.active ? "enabled" : "disabled") + ".\nNo automatic compiler, model routing, mutation or success-claiming fallback.");
        }
        if (!ctx.isProjectTrusted?.()) return notify("SkillCache requires a trusted project to inspect or run local capsules.", "warning");
        try {
          if (command === "list") {
            const names = await listCapsules(ctx.cwd);
            return notify("SkillCache capsules (" + names.length + "):\n" + (names.join("\n") || "(none)"));
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
