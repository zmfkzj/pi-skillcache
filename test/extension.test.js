import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillCacheExtension } from "../src/extension.js";
import { CAPSULE_SCHEMA } from "../src/capsule.js";

function createFakePi() {
  const handlers = new Map(), commands = new Map();
  const eventHandlers = new Map();
  return {
    handlers, commands,
    on: (event, fn) => handlers.set(event, fn),
    registerCommand: (name, config) => commands.set(name, config),
    events: {
      on: (name, fn) => eventHandlers.set(name, fn),
      emit: (name, data) => eventHandlers.get(name)?.(data),
    },
  };
}
async function createFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-skillcache-extension-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi/skillcache/capsules"), { recursive: true });
  await writeFile(join(cwd, "README.md"), "hello\n");
  await writeFile(join(cwd, ".pi/skillcache/capsules/sample.json"), JSON.stringify({
    schema: CAPSULE_SCHEMA, id: "sample", description: "Fixture", approved: true, steps: [{ op: "read", path: "README.md" }],
  }));
  const output = [];
  const ctx = { cwd, isProjectTrusted: () => true, ui: { notify: (msg, level) => output.push({ msg, level }), setStatus: () => undefined } };
  return { cwd, output, ctx };
}

test("Pi registers command, dependency provider and opt-in metadata-only trace", async t => {
  const pi = createFakePi();
  const f = await createFixture(t);
  createSkillCacheExtension()(pi);
  assert.equal(pi.commands.has("skillcache"), true);
  const providers = [];
  pi.events.emit("oh-my-pi-extensions:dependencies", { version: 1, provide: x => providers.push(x) });
  assert.equal(providers[0].id, "pi-skillcache");
  assert.equal((await providers[0].check()).items[0].status, "ok");
  await pi.commands.get("skillcache").handler("trace start", f.ctx);
  pi.handlers.get("tool_call")({ toolName: "read", input: { token: "secret" } });
  await pi.commands.get("skillcache").handler("trace report", f.ctx);
  assert.match(f.output.at(-1).msg, /read: 1/);
  assert.doesNotMatch(f.output.at(-1).msg, /secret/);
  await pi.commands.get("skillcache").handler("trace stop", f.ctx);
  await pi.commands.get("skillcache").handler("run sample", f.ctx);
  assert.match(f.output.at(-1).msg, /replay OK/);
  assert.match(f.output.at(-1).msg, /hello/);
});

test("untrusted project cannot inspect or replay a capsule", async t => {
  const pi = createFakePi();
  const f = await createFixture(t);
  createSkillCacheExtension()(pi);
  await pi.commands.get("skillcache").handler("run sample", { ...f.ctx, isProjectTrusted: () => false });
  assert.match(f.output.at(-1).msg, /trusted project/);
});

test("opt-in automatic compilation across Pi events and worker capability factory", async t => {
  const old = process.env.PI_SKILLCACHE_HOME;
  const home = await mkdtemp(join(tmpdir(), "pi-skillcache-auto-extension-"));
  process.env.PI_SKILLCACHE_HOME = home;
  t.after(async () => {
    if (old === undefined) delete process.env.PI_SKILLCACHE_HOME;
    else process.env.PI_SKILLCACHE_HOME = old;
    await rm(home, { recursive: true, force: true });
  });
  const pi = createFakePi();
  const f = await createFixture(t);
  createSkillCacheExtension()(pi);
  await pi.handlers.get("session_start")({}, f.ctx);
  const providers = [];
  pi.events.emit("orche:worker-capability", { capability: "skillcache", cwd: f.cwd, provide: value => providers.push(value) });
  assert.equal(providers.length, 0, "off by default");
  await pi.commands.get("skillcache").handler("auto on", f.ctx);
  pi.events.emit("orche:worker-capability", { capability: "skillcache", cwd: f.cwd, provide: value => providers.push(value) });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].tools.length, 0);
  assert.equal(typeof providers[0].extensionFactories[0], "function");
  // A headless orche worker can inherit only this trusted cwd, even if its own UI trust lookup is false.
  const workerPi = createFakePi();
  providers[0].extensionFactories[0](workerPi);
  const workerCtx = { ...f.ctx, isProjectTrusted: () => false };
  await workerPi.handlers.get("session_start")({}, workerCtx);
  const workerPrompt = "Worker read README";
  assert.equal(await workerPi.handlers.get("before_agent_start")({ messageType: "user", prompt: workerPrompt }, workerCtx), undefined);
  const workerCall = { toolName: "read", input: { path: "README.md" }, toolCallId: "worker-call" };
  workerPi.handlers.get("tool_call")(workerCall, workerCtx);
  workerPi.handlers.get("tool_result")({ ...workerCall, content: [{ type: "text", text: "hello" }], isError: false }, workerCtx);
  workerPi.handlers.get("agent_before_settle")({ outcome: "completed" }, workerCtx);
  await workerPi.handlers.get("agent_settled")({ aborted: false }, workerCtx);
  assert.match((await workerPi.handlers.get("before_agent_start")({ messageType: "user", prompt: workerPrompt }, workerCtx)).message.content, /hello/);
  assert.equal(await workerPi.handlers.get("before_agent_start")({ messageType: "user", prompt: workerPrompt }, { ...workerCtx, cwd: home }), undefined);
  const prompt = "Show README content";
  assert.equal(await pi.handlers.get("before_agent_start")({ messageType: "user", prompt }, f.ctx), undefined);
  const call = { toolName: "read", input: { path: "README.md" }, toolCallId: "call-1" };
  pi.handlers.get("tool_call")(call, f.ctx);
  pi.handlers.get("tool_result")({ ...call, content: [{ type: "text", text: "hello" }], isError: false }, f.ctx);
  pi.handlers.get("agent_before_settle")({ outcome: "completed" }, f.ctx);
  await pi.handlers.get("agent_settled")({ aborted: false }, f.ctx);
  const replay = await pi.handlers.get("before_agent_start")({ messageType: "user", prompt }, f.ctx);
  assert.match(replay.message.content, /hello/);
  await pi.commands.get("skillcache").handler("auto status", f.ctx);
  assert.match(f.output.at(-1).msg, /ON, compiled 2/);
  await pi.commands.get("skillcache").handler("auto clear", f.ctx);
  assert.match(f.output.at(-1).msg, /cleared 2/);
  await pi.commands.get("skillcache").handler("auto off", f.ctx);
  assert.match(f.output.at(-1).msg, /OFF/);
  pi.events.emit("orche:worker-capability", { capability: "skillcache", cwd: f.cwd, provide: value => providers.push(value) });
  assert.equal(providers.length, 1, "provider no longer offered");
});
