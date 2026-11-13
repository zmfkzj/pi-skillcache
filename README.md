# pi-skillcache

Experimental, quality-first Pi extension for explicit, bounded replay of reviewed read-only agent skill steps.

Based on [SkillCache: How Much Skill Orchestration Can LLM Agents Compile Away?](https://arxiv.org/abs/2611.10022). This is an initial harness-level prototype, not a reproduction of its automatic compiler, LLM holes, capsule selection, or automatic fallback. OpenAI and Anthropic API models remain unchanged.

## Current behavior

- Passive by default: no automatic replay and no additional model-visible tool declarations.
- Manual capsules support read, list, and literal grep. No shell, arbitrary code, network requests or writes.
- Capsule definitions must specify approved: true and be in the trusted project's .pi/skillcache/capsules/ directory.
- Symlink-aware path confinement, step/read/output limits, and optional file SHA-256 guards fail closed on invalid input.
- Metadata-only session trace counters: tool names and counts, never prompts, tool arguments or results.
- `/skillcache run` is deliberately manual. Use the original agent/skill if replay fails.

## Install

Requires Node.js >=22.19.0 and a compatible Pi runtime. No npm runtime dependencies.

```sh
pi install git:github.com/zmfkzj/pi-skillcache
npm test
```

## Commands

```text
/skillcache status
/skillcache doctor
/skillcache install-deps
/skillcache trace start
/skillcache trace report
/skillcache trace stop
/skillcache list
/skillcache inspect project-overview
/skillcache run project-overview file=README.md term=install
```

To try the provided capsule in an explicitly trusted project, copy `examples/reviewed-capsule.json` to `.pi/skillcache/capsules/project-overview.json`. Review its steps and guards first. The sample never runs by itself.

Capsule schema: `pi-skillcache/capsule@1`. Steps use `{op:'read'|'list'|'grep',path,...}`; parameters can be whole-string `$input.NAME` values. Optional `guards` specify file paths and lowercase SHA-256 digests. Scope parameters and inputs explicitly.

## Limitations and next steps

The paper's trace-to-capsule compiler, automatic matching, model holes, cross-request replay, and recovery with the original LLM are **not implemented**. Neither its token-reduction figures nor its quality scores have been reproduced. Next work requires opt-in trace capture, multi-input replay validation, independent correctness checks, invalidation by source skill/version, cost accounting and quality-gated A/B tests with pi-orche and pi-workbench.

## Integration

The `oh-my-pi-extensions` umbrella can load `./pi-skillcache/index.js` as a Git submodule and check it through `/oh-my-pi doctor`. The extension uses the umbrella's `oh-my-pi-extensions:dependencies` event contract and needs no provider/server changes.

License: MIT.
