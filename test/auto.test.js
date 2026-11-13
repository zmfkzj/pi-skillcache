import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoCacheStatus, clearAutoCache, compileToolCall, createAutoEngine, setAutoEnabled,
} from "../src/auto.js";

async function setup(t, { enabled = true } = {}) {
  const temp = await mkdtemp(join(tmpdir(), "pi-skillcache-auto-test-"));
  const old = process.env.PI_SKILLCACHE_HOME;
  process.env.PI_SKILLCACHE_HOME = join(temp, "agent");
  t.after(async () => {
    if (old === undefined) delete process.env.PI_SKILLCACHE_HOME;
    else process.env.PI_SKILLCACHE_HOME = old;
    await rm(temp, { recursive: true, force: true });
  });
  const cwd = join(temp, "project");
  await mkdir(cwd);
  await mkdir(join(cwd, "docs"));
  await writeFile(join(cwd, "README.md"), "intro\nTODO: verify\nconclusion\n");
  await writeFile(join(cwd, "docs", "note.txt"), "alpha\nbeta\n");
  if (enabled) await setAutoEnabled(cwd, true);
  return { temp, cwd, ctx: { cwd, isProjectTrusted: () => true } };
}
function tool(id, name, input) {
  const event = { toolCallId: id, toolName: name, input };
  return { call: event, result: { ...event, content: [{ type: "text", text: "observed successful tool output" }], isError: false } };
}
async function observed(engine, ctx, prompt, tools, { outcome = "completed", aborted = false } = {}) {
  const replay = await engine.before({ messageType: "user", prompt }, ctx);
  for (const { call, result } of tools) { engine.toolCall(call, ctx); engine.toolResult(result, ctx); }
  engine.settlement({ outcome });
  await engine.settled({ aborted }, ctx);
  return replay;
}

const READ = tool("read-1", "read", { path: "README.md" });
const GREP = tool("grep-2", "grep", { path: "README.md", pattern: "TODO", literal: true });

// Individual safety checks are pure, independent of an active Pi session.
test("compiler restricts operations, flags, paths and sensitive filenames", () => {
  const compile = (toolName, input) => compileToolCall({ toolName, input });
  assert.deepEqual(compile("read", { path: "README.md" }), { op: "read", path: "README.md", maxBytes: 65536 });
  assert.deepEqual(compile("grep", { path: "README.md", pattern: "TODO", literal: true }).op, "grep");
  assert.deepEqual(compile("ls", { path: ".", limit: 10 }), { op: "list", path: ".", maxEntries: 10 });
  assert.equal(compile("read", { path: ".env" }), null);
  assert.equal(compile("read", { path: "docs/.private" }), null);
  assert.equal(compile("read", { path: "node_modules/x" }), null);
  assert.equal(compile("read", { path: "docs/secrets.txt" }), null);
  assert.equal(compile("read", { path: "../outside" }), null);
  assert.equal(compile("read", { path: "/etc/passwd" }), null);
  assert.equal(compile("read", { path: "src/foo.js", offset: 2 }), null);
  assert.equal(compile("grep", { path: "README.md", pattern: "foo.*bar" }), null);
  assert.equal(compile("grep", { path: "README.md", pattern: "foo.*bar", literal: true }).op, "grep");
  assert.equal(compile("grep", { path: "README.md", pattern: "hi", literal: true, ignoreCase: true }), null);
  assert.equal(compile("bash", { command: "cat README.md" }), null);
  assert.equal(compileToolCall({ parentToolCallId: "parent", toolName: "read", input: { path: "README.md" } }), null);
});

test("default-off; enabling persists; data and key are outside Git project; disabling stops replay", async t => {
  const f = await setup(t, { enabled: false });
  const engine = createAutoEngine();
  assert.deepEqual(await autoCacheStatus(f.cwd), { enabled: false, count: 0 });
  assert.equal(await observed(engine, f.ctx, "Read README", [READ]), undefined);
  assert.equal(engine.metrics.compiled, 0);
  await setAutoEnabled(f.cwd, true);
  assert.equal((await autoCacheStatus(f.cwd)).enabled, true);
  assert.equal((await readdir(f.cwd)).includes(".pi"), false);
  assert.equal((await readdir(f.temp)).includes("agent"), true);
  await setAutoEnabled(f.cwd, false);
  assert.equal((await autoCacheStatus(f.cwd)).enabled, false);
  assert.equal(await engine.before({ messageType: "user", prompt: "Read README" }, f.ctx), undefined);
});

test("compiles completed read + literal grep and injects fresh untrusted evidence for an identical prompt", async t => {
  const f = await setup(t);
  const first = createAutoEngine();
  const prompt = "Find TODO references in README without executing anything";
  assert.equal(await observed(first, f.ctx, prompt, [READ, GREP]), undefined);
  assert.equal(first.metrics.compiled, 1);
  assert.deepEqual(await autoCacheStatus(f.cwd), { enabled: true, count: 1 });
  const second = createAutoEngine();
  const result = await second.before({ messageType: "user", prompt }, f.ctx);
  assert.equal(result?.message?.customType, "pi-skillcache.auto-evidence");
  assert.equal(result?.message?.display, false);
  assert.match(result.message.content, /fresh local evidence/);
  assert.match(result.message.content, /TODO: verify/);
  assert.match(result.message.content, /UNTRUSTED/);
  assert.match(result.message.content, /independently run/);
  assert.equal(second.metrics.hits, 1);
  assert.equal(await second.before({ messageType: "user", prompt: prompt + " now" }, f.ctx), undefined);
  assert.equal(second.metrics.misses, 1);
  assert.equal(await second.before({ messageType: "user", prompt, images: [{ type: "image", data: "xx" }] }, f.ctx), undefined);
  const storage = join(f.temp, "agent", "skillcache", "projects");
  const projectId = (await readdir(storage))[0];
  const saved = (await readdir(join(storage, projectId, "compiled")))[0];
  const file = await readFile(join(storage, projectId, "compiled", saved), "utf8");
  assert.doesNotMatch(file, /Find TODO references/); // No raw user prompt is stored.
  assert.doesNotMatch(file, /TODO: verify/); // No previous tool outputs are stored.
});

test("edits invalidate guard, automatically fall back, then a completed rerun refreshes the capsule", async t => {
  const f = await setup(t);
  const engine = createAutoEngine();
  const prompt = "Read README";
  await observed(engine, f.ctx, prompt, [READ]);
  await writeFile(join(f.cwd, "README.md"), "changed\nnew insight\n");
  assert.equal(await engine.before({ messageType: "user", prompt }, f.ctx), undefined);
  assert.equal(engine.metrics.fallbacks, 1);
  engine.toolCall(READ.call, f.ctx);
  engine.toolResult(READ.result, f.ctx);
  engine.settlement({ outcome: "completed" });
  await engine.settled({ aborted: false }, f.ctx);
  assert.equal(engine.metrics.compiled, 2);
  const replay = await engine.before({ messageType: "user", prompt }, f.ctx);
  assert.match(replay.message.content, /new insight/);
  assert.equal(engine.metrics.hits, 1);
});

test("directories are guarded: adding a file prevents stale ls reuse", async t => {
  const f = await setup(t);
  const engine = createAutoEngine();
  const listing = tool("list", "ls", { path: "docs" });
  await observed(engine, f.ctx, "List docs", [listing]);
  const initial = await engine.before({ messageType: "user", prompt: "List docs" }, f.ctx);
  assert.match(initial.message.content, /note.txt/);
  await writeFile(join(f.cwd, "docs", "more.txt"), "new\n");
  assert.equal(await engine.before({ messageType: "user", prompt: "List docs" }, f.ctx), undefined);
  assert.equal(engine.metrics.fallbacks, 1);
});

test("failed calls, unsafe tools, changed inputs, aborted and error runs are never compiled", async t => {
  const f = await setup(t);
  const engine = createAutoEngine();
  const prompt = "Investigate";
  await observed(engine, f.ctx, prompt, [tool("shell", "bash", { command: "echo test" })]);
  assert.equal(engine.metrics.compiled, 0);
  await observed(engine, f.ctx, prompt, [READ], { aborted: true });
  await observed(engine, f.ctx, prompt, [READ], { outcome: "error" });
  await engine.before({ messageType: "user", prompt }, f.ctx);
  engine.toolCall(READ.call, f.ctx);
  engine.toolResult({ ...READ.result, isError: true }, f.ctx);
  engine.settlement({ outcome: "completed" });
  await engine.settled({ aborted: false }, f.ctx);
  assert.equal(engine.metrics.compiled, 0);
  await engine.before({ messageType: "user", prompt }, f.ctx);
  engine.toolCall(READ.call, f.ctx);
  engine.toolResult({ ...READ.result, input: { path: "docs/note.txt" } }, f.ctx);
  engine.settlement({ outcome: "completed" });
  await engine.settled({ aborted: false }, f.ctx);
  assert.equal(engine.metrics.compiled, 0);
  assert.equal((await autoCacheStatus(f.cwd)).count, 0);
});

test("untrusted and image inputs never compile or reuse", async t => {
  const f = await setup(t);
  const engine = createAutoEngine();
  const ctx = { ...f.ctx, isProjectTrusted: () => false };
  assert.equal(await observed(engine, ctx, "Read README", [READ]), undefined);
  assert.equal(engine.metrics.compiled, 0);
  assert.equal((await autoCacheStatus(f.cwd)).count, 0);
  assert.equal(await engine.before({ messageType: "custom", prompt: "Read README" }, f.ctx), undefined);
});

test("symlink escaping and oversized files cannot be compiled; clear removes only compiled data", async t => {
  const f = await setup(t);
  const engine = createAutoEngine();
  await symlink("/etc/hosts", join(f.cwd, "docs", "out"));
  await observed(engine, f.ctx, "Read linked", [tool("1", "read", { path: "docs/out" })]);
  assert.equal(engine.metrics.compiled, 0);
  await writeFile(join(f.cwd, "docs", "large.txt"), "A".repeat(130 * 1024));
  await observed(engine, f.ctx, "Read big", [tool("1", "read", { path: "docs/large.txt" })]);
  assert.equal(engine.metrics.compiled, 0);
  await observed(engine, f.ctx, "Read ordinary", [READ]);
  assert.equal((await autoCacheStatus(f.cwd)).count, 1);
  assert.equal(await clearAutoCache(f.cwd), 1);
  assert.equal((await autoCacheStatus(f.cwd)).enabled, true);
  assert.equal((await autoCacheStatus(f.cwd)).count, 0);
});

test("worker read-only planning tools may be ignored but mutating tools still prevent compilation", async t => {
  const f = await setup(t);
  const engine = createAutoEngine();
  const plan = tool("plan-1", "task_plan", { nodes: [] });
  const check = tool("diag-1", "diagnostics", { path: "README.md" });
  await observed(engine, f.ctx, "Summarize README after planning", [plan, READ, check]);
  assert.equal(engine.metrics.compiled, 1);
  assert.match((await engine.before({ messageType: "user", prompt: "Summarize README after planning" }, f.ctx)).message.content, /intro/);
  await observed(engine, f.ctx, "Modify README", [READ, tool("write-1", "write", { path: "README.md", content: "evil" })]);
  assert.equal((await autoCacheStatus(f.cwd)).count, 1);
});
