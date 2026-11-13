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
