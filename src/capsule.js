/**
 * Experimental, read-only declarative capsule runner. No shell, eval, code execution,
 * project writes, network access or implicit replay. All paths are confined to cwd,
 * including after symlink resolution. A capsule is a reviewed JSON plan, not an
 * LLM-generated executable script.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, isAbsolute, sep } from "node:path";

export const CAPSULE_SCHEMA = "pi-skillcache/capsule@1";
export const CAPSULES_DIR = ".pi/skillcache/capsules";
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const PARAM = /^\$input\.([a-zA-Z][a-zA-Z0-9_]{0,63})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_STEPS = 24;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;

function fail(message) { throw new Error(`SkillCache: ${message}`); }
function plainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keysOnly(obj, allowed, label) {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) fail(`${label}: unsupported key '${key}'`);
}
function literalOrParam(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) fail(`${label}: expected nonempty string up to 2048 chars`);
  if (value.includes("\0")) fail(`${label}: NUL byte is not allowed`);
  if (value.startsWith("$input.") && !PARAM.test(value)) fail(`${label}: invalid parameter reference`);
}
function integerRange(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label}: expected integer ${min}..${max}`);
}

export function validateCapsule(capsule) {
  if (!plainObject(capsule)) fail("capsule must be an object");
  keysOnly(capsule, ["schema", "id", "description", "approved", "guards", "steps"], "capsule");
  if (capsule.schema !== CAPSULE_SCHEMA) fail(`schema must be '${CAPSULE_SCHEMA}'`);
  if (!ID.test(capsule.id ?? "")) fail("invalid capsule id");
  if (typeof capsule.description !== "string" || !capsule.description.trim() || capsule.description.length > 500) fail("description must be a short nonempty string");
  if (capsule.approved !== true) fail("capsule must be explicitly approved: true");
  if (!Array.isArray(capsule.steps) || capsule.steps.length === 0 || capsule.steps.length > MAX_STEPS) fail(`steps must contain 1..${MAX_STEPS} items`);
  if (capsule.guards !== undefined) {
    if (!Array.isArray(capsule.guards) || capsule.guards.length > 16) fail("guards must be an array of up to 16 file hashes");
    for (const [i, guard] of capsule.guards.entries()) {
      if (!plainObject(guard)) fail(`guards[${i}] must be an object`);
      keysOnly(guard, ["path", "sha256", "kind"], `guards[${i}]`);
      if (guard.kind !== undefined && !["file", "directory"].includes(guard.kind)) fail(`guards[${i}].kind must be file|directory`);
      literalOrParam(guard.path, `guards[${i}].path`);
      if (!SHA256.test(guard.sha256 ?? "")) fail(`guards[${i}].sha256 must be lowercase hex SHA-256`);
    }
  }
  for (const [i, step] of capsule.steps.entries()) {
    if (!plainObject(step)) fail(`steps[${i}] must be an object`);
    keysOnly(step, ["op", "path", "pattern", "maxEntries", "maxMatches", "maxBytes"], `steps[${i}]`);
    if (!["read", "list", "grep"].includes(step.op)) fail(`steps[${i}].op must be read|list|grep`);
    literalOrParam(step.path, `steps[${i}].path`);
    if (step.op === "grep") literalOrParam(step.pattern, `steps[${i}].pattern`);
    else if ("pattern" in step) fail(`steps[${i}]: pattern is only valid for grep`);
    if (step.maxEntries !== undefined) {
      if (step.op !== "list") fail(`steps[${i}]: maxEntries is only valid for list`);
      integerRange(step.maxEntries, 1, 500, `steps[${i}].maxEntries`);
    }
    if (step.maxMatches !== undefined) {
      if (step.op !== "grep") fail(`steps[${i}]: maxMatches is only valid for grep`);
      integerRange(step.maxMatches, 1, 500, `steps[${i}].maxMatches`);
    }
    if (step.maxBytes !== undefined) {
      if (!["read", "grep"].includes(step.op)) fail(`steps[${i}]: maxBytes is only valid for read or grep`);
      integerRange(step.maxBytes, 1, MAX_FILE_BYTES, `steps[${i}].maxBytes`);
    }
  }
  return capsule;
}

function substitute(value, inputs, name) {
  const param = value.match(PARAM);
  if (!param) return value;
  const replacement = inputs?.[param[1]];
  if (typeof replacement !== "string" || !replacement || replacement.includes("\0") || replacement.length > 2048) fail(`missing/invalid input '${param[1]}' for ${name}`);
  return replacement;
}

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function safePath(root, path, inputs) {
  const supplied = substitute(path, inputs, "path");
  if (isAbsolute(supplied)) fail("absolute paths are not allowed");
  const logical = resolve(root, supplied);
  if (!contained(root, logical)) fail("path escapes project root");
  const physical = await realpath(logical);
  if (!contained(root, physical)) fail("path resolves through a symlink outside project root");
  return { physical, relativePath: relative(root, physical) || "." };
}

async function fileBuffer(path, maxBytes) {
  const s = await stat(path);
  if (!s.isFile()) fail("expected a regular file");
  if (s.size > maxBytes) fail(`file exceeds read limit of ${maxBytes} bytes`);
  const buffer = await readFile(path);
  if (buffer.byteLength > maxBytes) fail("file grew past read limit");
  return buffer;
}

export function digest(buffer) { return createHash("sha256").update(buffer).digest("hex"); }

export async function executeCapsule(capsule, { cwd, inputs = {}, outputLimitBytes = MAX_OUTPUT_BYTES } = {}) {
  validateCapsule(capsule);
  if (typeof cwd !== "string") fail("cwd is required");
  integerRange(outputLimitBytes, 1, MAX_OUTPUT_BYTES, "outputLimitBytes");
  const root = await realpath(cwd);
  if (!(await stat(root)).isDirectory()) fail("cwd must be a directory");
  if (!plainObject(inputs) || Object.keys(inputs).length > 32) fail("inputs must be an object with up to 32 entries");
  const verifyGuards = async () => {
    for (const guard of capsule.guards ?? []) {
      const p = await safePath(root, guard.path, inputs);
      let current;
      if (guard.kind === "directory") {
        if (!(await stat(p.physical)).isDirectory()) fail("guard expects a directory");
        const entries = (await readdir(p.physical, { withFileTypes: true })).map(e =>
          [e.name, e.isDirectory() ? "d" : e.isFile() ? "f" : e.isSymbolicLink() ? "l" : "o"]);
        entries.sort((a, b) => a[0].localeCompare(b[0]));
        current = digest(Buffer.from(JSON.stringify(entries)));
      } else current = digest(await fileBuffer(p.physical, MAX_FILE_BYTES));
      if (current !== guard.sha256) fail(`guard mismatch: '${p.relativePath}' changed; use the original skill instead`);
    }
  };
  await verifyGuards();
  const result = [];
  let total = 0;
  for (const [index, step] of capsule.steps.entries()) {
    const p = await safePath(root, step.path, inputs);
    let data;
    if (step.op === "read") {
      data = { text: (await fileBuffer(p.physical, step.maxBytes ?? 65536)).toString("utf8") };
    } else if (step.op === "list") {
      const s = await stat(p.physical);
      if (!s.isDirectory()) fail("list expects a directory");
      const entries = (await readdir(p.physical, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      const cap = step.maxEntries ?? 100;
      data = { entries: entries.slice(0, cap).map(entry => ({ name: entry.name, kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" })), truncated: entries.length > cap };
    } else {
      const pattern = substitute(step.pattern, inputs, "pattern");
      if (pattern.length > 256) fail("grep pattern exceeds 256 characters");
      const content = (await fileBuffer(p.physical, step.maxBytes ?? MAX_FILE_BYTES)).toString("utf8");
      const cap = step.maxMatches ?? 100;
      const matches = [];
      let truncated = false;
      for (const [line, text] of content.split(/\r?\n/).entries()) {
        if (!text.includes(pattern)) continue;
        if (matches.length === cap) { truncated = true; break; }
        matches.push({ line: line + 1, text: text.slice(0, 2000) });
      }
      data = { matches, truncated };
    }
    const entry = { index: index + 1, op: step.op, path: p.relativePath, ...data };
    total += Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (total > outputLimitBytes) fail(`result exceeds ${outputLimitBytes} bytes; rerun the original skill`);
    result.push(entry);
  }
  await verifyGuards(); // Fail closed if files changed during replay.
  return { schema: "pi-skillcache/result@1", capsule: capsule.id, steps: result, readOnly: true };
}

export async function loadCapsule(cwd, id) {
  if (!ID.test(id ?? "")) fail("invalid capsule id");
  const dir = join(cwd, CAPSULES_DIR);
  const root = await realpath(cwd);
  const path = join(dir, `${id}.json`);
  // Capsule definitions must not be redirected through symlinks outside the project.
  const physical = await realpath(path);
  if (!contained(root, physical)) fail("capsule definition escapes project root");
  const buffer = await fileBuffer(physical, MAX_FILE_BYTES);
  const capsule = JSON.parse(buffer.toString("utf8"));
  validateCapsule(capsule);
  if (capsule.id !== id) fail("capsule ID does not match file name");
  return capsule;
}

export async function listCapsules(cwd) {
  const dir = join(cwd, CAPSULES_DIR);
  let files;
  try { files = await readdir(dir); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return files.filter(file => /^[a-z][a-z0-9-]{0,63}\.json$/.test(file)).map(file => file.slice(0, -5)).sort();
}
