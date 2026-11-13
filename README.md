# pi-skillcache

Opt-in, quality-first automatic read-only trace compiler and capsule replay extension for [Pi](https://github.com/earendil-works/pi). Inspired by [SkillCache: How Much Skill Orchestration Can LLM Agents Compile Away?](https://arxiv.org/abs/2611.10022). No model fine-tuning, hidden-state access, server changes, API key migration or replacement of OpenAI/Anthropic is required.

**Scope is deliberately narrower than the paper.** This extension compiles a strictly bounded subset of *already successful tool calls* and replays the local data as **fresh evidence for the next identical prompt**. It does not synthesize arbitrary programs, skip model reasoning, execute shell commands, learn LLM holes, handle semantic similarity, or claim task completion. A replay hit can reduce redundant read/search calls, but **token/time savings and quality neutrality must be measured**.

## Activate

Node.js >=22.19.0; no runtime npm dependencies.

```sh
pi install git:github.com/zmfkzj/pi-skillcache
```

In a **trusted project**, explicitly opt in:

```text
/skillcache auto on
/skillcache auto status
```

The setting persists for this project across Pi sessions. Automatic compilation and replay are **OFF by default**. Turning it on does not replace the original agent: the first run proceeds normally. Only after that run fully completes with a safe trace can a Capsule be compiled. Repeating the **identical expanded user prompt** causes the extension to re-read the guarded files and pass structured results into the next model turn before the agent runs its tools. The model may still choose to verify or re-read, so saved tool calls are not guaranteed.

To disable and/or invalidate:

```text
/skillcache auto off
/skillcache auto clear
/skillcache status
```

`auto clear` only deletes machine-generated capsules for this project; manually reviewed capsules remain untouched. Disabling does not erase the cache. `auto status` reports the cache count and current-session hits, misses, fallbacks, and skips.

## Eligibility and safeguards

An automatic Capsule is compiled only when all of these hold:

- The project is explicitly trusted and auto mode enabled; the request was a normal text-only user turn.
- The agent run settled normally, the recorded tools succeeded, and the relevant trace is within bounds (24 executable replay steps maximum).
- Every replayed step is deterministic, local and read-only: `read` (whole small text file), `ls` (bounded direct listing) or `grep` (single file, literal/case-sensitive matches). `task_plan`, `report_result`, `diagnostics`, `find`, `ast_search`, and `codegraph_explore` are allowed *as non-replayed steps*. All other calls, including shell, edits, writes, networking, nested tool calls and non-literal searches, disqualify the automatic compilation.
- Sensitive-looking, hidden, external and symlink-escaping paths are excluded; a file is at most 128 KiB. The captured replay is run twice and the results must match before it is saved. This checks deterministic execution, **not semantic equivalence or correctness**.
- A repeat request must match the original prompt exactly (HMAC-SHA-256; original prompt and tool outputs are never saved). File SHA-256 or directory-content hashes must still match before *and after* replay. Cached evidence expires after 14 days, requires identical source files, and is bounded to ~32 KiB of text.
- The replayed text is marked as **untrusted data**. Verification, human approvals, independent QA, test gates and other tool policies stay in effect. Any replay failure silently falls back to the unmodified agent run; no success is asserted.

Compiled capsules, the project-specific key and enablement live **outside the Git tree** under the Pi agent data directory, normally `~/.pi/agent/skillcache/projects/<sha256-of-project-path>/` (or `PI_CODING_AGENT_DIR` / `PI_AGENT_HOME`). A private deployment can override the state root using `PI_SKILLCACHE_HOME`. Cached definitions include *file paths and literal grep patterns*, so protect agent data/backups accordingly. Project files are not modified by compiling or replaying. The cache is local to the machine and physical workspace path.

### pi-orche workers

`pi-skillcache` provides an optional `skillcache` worker capability on the `orche:worker-capability` event channel **only for a trusted, auto-enabled parent project**. When a matching `pi-orche` version requests this capability, each worker/sub-worker gets an isolated extension instance with permission to reuse that *same* trusted project only. Worker changes are never replayed and isolated Git worktrees do not inherit the parent's enablement. Older `pi-orche` versions simply run normally without worker-side cache integration.

## Manual reviewed Capsules (unchanged)

```text
/skillcache trace start
/skillcache trace report
/skillcache trace stop
/skillcache list
/skillcache inspect project-overview
/skillcache run project-overview file=README.md term=install
/skillcache doctor
/skillcache install-deps
```

The trace command retains **tool-name/count metadata only**. Manual Capsules must be in `.pi/skillcache/capsules/`, explicitly marked `approved: true`, and use schema `pi-skillcache/capsule@1`. `read`, `list`, and literal `grep` support whole-string `$input.NAME` substitutions, bounded reads/results and optional file guards (`{path,sha256}`); directory guards use `{path,kind:"directory",sha256}`. Manual execution requires project trust and is explicitly invoked with `/skillcache run`.

The `examples/reviewed-capsule.json` file is a template only and is not auto-executed. The umbrella `oh-my-pi-extensions` loads `./pi-skillcache/index.js` from a Git submodule and checks it through `/oh-my-pi doctor pi-skillcache`.

## Validation

```sh
npm run check
npm test
```

The tests cover strict admission, compilation after completion, cross-session replay, symlinks, file and directory invalidation, aborted/error runs, mismatched actual tool arguments, exact-prompt matching, fallback and worker factory isolation. This is still a **prototype**. Benchmark with matched controls and the full `pi-orche` + `pi-eval-loop` quality gates before considering it a performance improvement. Automatic reuse is *pre-agent evidence injection*, not transparent replacement of Pi's tool calls because Pi's `tool_call` event can block but cannot return a replacement tool result.

License: MIT.
