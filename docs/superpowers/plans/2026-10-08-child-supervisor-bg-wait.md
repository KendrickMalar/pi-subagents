# Child supervisor-aware bg_wait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Parent implements inline; one fresh read-only reviewer checks the final branch.

**Goal:** A child coordinator's explicit bg_wait yields for an owned supervisor request before the request times out, then resumes result collection after a reply.
**Architecture:** Reuse the existing pending-request predicate and wait barrier. Resolve the predicate through the mutable ChildRuntimeConfig at execution time, because fanout installs it after prompt-runtime registration. Do not change public APIs, supervisor ownership, leases or terminal-proof semantics.
**Tech Stack:** TypeScript, node:test, existing lockfile, Pi SDK 1.0.4, Node 22.23.3, existing deterministic native fixture providers.
**Spec:** User-approved in-chat design (2026-10-08): RED regression, minimal predicate connection, isolated unit/integration/native verification, separate approval before shared installation.

## Global Constraints

- Repo: /Users/papillon/Documents/Github/pi-subagents; base 51731b0a773b1e4b6ebbda61f47d5160a17b5009.
- Worktree: /Users/papillon/Documents/Github/worktrees/pi-subagents/child-supervisor-bg-wait-20261008; branch fix/child-supervisor-bg-wait.
- Installed npm 0.76.1 is not this checkout. Keep it, shared settings, credentials, Copi product code and all old run artifacts unchanged.
- Existing lock only; no dependency upgrades, install hooks, CI edits, public issues, push, merge or publication.
- Tests use synthetic HOME/agent/TMPDIR/cache and deterministic providers. No real model or old tester resume in regression tests.
- Preserve RED/GREEN logs, fixture evidence and the worktree; cleanup deletion is not approved.

## Review Focus

1. Predicate is installed after tool registration, replaced between waits, or absent: no stale capture and no false supervisor barrier.
2. Request appears during an active exact workflow wait: yield with supervisor_request, not done/window_elapsed; leave work alive.
3. Foreign requests do not interrupt this owner; pending clear permits collection of the original result.
4. Prompt-runtime explicit wait and final drain must retain their existing scopes and fail-closed ownership checks.
5. Native request/reply/result/close evidence must prove the path, not merely tool discovery or a mocked end event.

## Task 1: Runtime connection and regression

**Files:** Modify src/runs/shared/subagent-prompt-runtime.ts; test/unit/subagent-prompt-runtime.test.ts.
**Consumes:** ChildRuntimeConfig.hasPendingSupervisorRequest?: () => boolean; registerWaitTool's existing seventh argument.
**Produces:** Registered child bg_wait consults the current predicate at execution time, absent predicate means false.

- [ ] Record baseline focused tests using existing lock dependencies.
- [ ] Add registered-tool tests: late-installed predicate yields supervisor_request; replaced/cleared predicate changes subsequent waits; absent predicate retains ordinary completion behavior.
- [ ] Run focused tests and preserve an assertion RED before changing production code.
- [ ] Pass a forwarding closure resolving config.hasPendingSupervisorRequest on demand; preserve all existing registerWaitTool arguments and scope behavior.
- [ ] Re-run focused tests GREEN, typecheck and relevant supervisor/wait suites; record commands, exits and counts.
- [ ] Make a local scoped candidate commit after verification.

## Task 2: Native end-to-end verification

**Files:** Extend test/integration/nested-async-wait.test.ts and, if needed, its existing deterministic provider fixture or a focused new fixture under test/fixtures/.
**Consumes:** Task 1 runtime connection; existing native SDK loader and native-supervisor channel.
**Produces:** A deterministic test proving child request -> coordinator wait yield -> correct reply -> original result consumed -> observed child close.

- [ ] Add a bounded native SDK test using an isolated agent directory and synthetic provider; assert wait returns supervisor_request while the requester is active and has not timed out.
- [ ] Assert the owner replies to the correct request, the child consumes the reply, and the coordinator waits again and reads the original result.
- [ ] Assert terminal/close evidence appropriate to the launch mode; do not equate report persistence with process close.
- [ ] Compare against the unpatched baseline where feasible and preserve RED evidence; run the patched test without skip.
- [ ] Run unit suite, integration suite, typecheck and package build with existing scripts; distinguish existing optional external-CLI skips from required native coverage.

## Task 3: Candidate artifact and review

**Files:** Existing scripts/build-package.mjs/package output; no production installation changes.
**Consumes:** Fixed-ref source and successful Task 1/2 evidence.
**Produces:** Local candidate source/pack evidence and one fresh whole-branch review.

- [ ] Build/pack locally; inventory candidate vs installed baseline and reject unrelated changes from an unverified source baseline.
- [ ] Fresh reviewer checks exact branch/ref, diff, tests, late binding, owner scope and explicit wait behavior.
- [ ] Parent arbitrates findings and verifies any required fixes with RED/GREEN.
- [ ] Report actual evidence, residual risks and a proposed shared-install/reload/rollback procedure. Do not apply without a separate user approval.

## Deferred

Old orphaned tester terminal-proof repair, old session resume, Copi A/B/C probe correction/retest, shared npm replacement and settings changes are not authorized by this plan.
