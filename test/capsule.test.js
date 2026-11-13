import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPSULE_SCHEMA, digest, executeCapsule, listCapsules, loadCapsule, validateCapsule } from "../src/capsule.js";

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-skillcache-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".pi", "skillcache", "capsules"), { recursive: true });
  await writeFile(join(root, "README.md"), "intro\nTODO check\nother\nTODO finish\n");
  return root;
}
const capsule = (steps, guards = []) => ({ schema: CAPSULE_SCHEMA, id: "readme", description: "Test", approved: true, guards, steps });

test("reviewed declarative capsule executes only bounded read/list/literal grep", async t => {
  const root = await project(t);
  const c = capsule([
    { op: "list", path: ".", maxEntries: 10 },
    { op: "read", path: "$input.file", maxBytes: 1024 },
    { op: "grep", path: "$input.file", pattern: "$input.term", maxMatches: 1 },
  ]);
  const output = await executeCapsule(c, { cwd: root, inputs: { file: "README.md", term: "TODO" } });
  assert.equal(output.steps[0].entries.some(e => e.name === "README.md"), true);
  assert.match(output.steps[1].text, /TODO check/);
  assert.equal(output.steps[2].matches[0].line, 2);
  assert.equal(output.steps[2].truncated, true);
  assert.equal(output.readOnly, true);
});

test("reject unsafe, unapproved, malformed or oversized capsules", async t => {
  const root = await project(t);
  const simple = capsule([{ op: "read", path: "README.md" }]);
  assert.throws(() => validateCapsule({ ...simple, approved: false }), /approved/);
  assert.throws(() => validateCapsule(capsule([{ op: "shell", path: "README.md" }])), /read\|list\|grep/);
  assert.throws(() => validateCapsule(capsule([{ op: "read", path: "README.md", extra: true }])), /unsupported key/);
  assert.throws(() => validateCapsule(capsule([{ op: "read", path: "$input.bad-name" }])), /invalid parameter/);
  await assert.rejects(executeCapsule(capsule([{ op: "read", path: "../README.md" }]), { cwd: root }), /escapes/);
  await assert.rejects(executeCapsule(capsule([{ op: "read", path: "/etc/passwd" }]), { cwd: root }), /absolute/);
  await assert.rejects(executeCapsule(capsule([{ op: "read", path: "README.md", maxBytes: 2 }]), { cwd: root }), /limit/);
  await assert.rejects(executeCapsule(simple, { cwd: root, outputLimitBytes: 1 }), /exceeds/);
});

test("symlink escape is rejected after realpath", async t => {
  const root = await project(t);
  await symlink("/etc/hosts", join(root, "out"));
  await assert.rejects(executeCapsule(capsule([{ op: "read", path: "out" }]), { cwd: root }), /symlink outside/);
});

test("content guards invalidate changed inputs", async t => {
  const root = await project(t);
  const body = "intro\nTODO check\nother\nTODO finish\n";
  const c = capsule([{ op: "read", path: "README.md" }], [{ path: "README.md", sha256: digest(Buffer.from(body)) }]);
  await executeCapsule(c, { cwd: root });
  await writeFile(join(root, "README.md"), "changed");
  await assert.rejects(executeCapsule(c, { cwd: root }), /guard mismatch/);
});

test("capsule is loaded only from strict ID-matched JSON and project-local path", async t => {
  const root = await project(t);
  await writeFile(join(root, ".pi/skillcache/capsules/readme.json"), JSON.stringify(capsule([{ op: "list", path: "." }])));
  assert.deepEqual(await listCapsules(root), ["readme"]);
  assert.equal((await loadCapsule(root, "readme")).id, "readme");
  await assert.rejects(loadCapsule(root, "../README"), /invalid capsule id/);
  await writeFile(join(root, ".pi/skillcache/capsules/readme.json"), JSON.stringify({ ...capsule([{ op: "list", path: "." }]), id: "other" }));
  await assert.rejects(loadCapsule(root, "readme"), /does not match/);
});
