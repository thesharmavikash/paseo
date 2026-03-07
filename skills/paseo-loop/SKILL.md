---
name: paseo-loop
description: Run a task in a worker→judge loop until acceptance criteria are met. Use when the user says "loop", "loop this", "keep trying until", or wants iterative autonomous execution.
user-invocable: true
---

# Loop Skill

You are setting up an autonomous worker→judge loop. A worker agent implements the plan, then a judge agent independently verifies the plan was implemented to the letter.

**User's arguments:** $ARGUMENTS

---

## Prerequisites

Load the **Paseo skill** first — it contains the CLI reference for all agent commands.

## What Is a Loop

A loop is two roles — **worker** and **judge** — running in alternation:

1. **Worker** receives the plan and implements it (fresh agent each iteration)
2. **Judge** receives the same plan and independently verifies it was implemented correctly, emitting a structured verdict: `{ criteria_met: boolean, reason: string }`
3. If `criteria_met` is false, a new worker is launched with the latest judge failure reason (latest only, not full history)
4. Loop exits when the judge says `criteria_met: true` or max iterations are reached

The judge verifies the **entire plan** — every step, every file change, every acceptance criterion. It does NOT suggest fixes or provide guidance. It only reports facts.

## Live Steering

Each loop run persists state in:

```text
~/.paseo/loops/<loop-id>/
  plan.md
  last_reason.md
  history.log
```

Behavior:
- `plan.md` is read immediately before launching each worker and each judge.
- `last_reason.md` stores only the latest judge failure reason (not accumulated history).
- `history.log` appends per-iteration operational records.

Edits to `plan.md` are picked up on the next worker/judge launch without restarting the loop.

## Parsing Arguments

Parse `$ARGUMENTS` to determine:

1. **Plan** — the full implementation plan (context, steps, acceptance criteria, constraints — all in one document)
2. **Worker model** — who does the work (default: Codex `gpt-5.4`)
3. **Judge model** — who verifies (default: Claude `sonnet`)
4. **Name** — a short name for tracking iterations
5. **Max iterations** — safety cap (default: 10)
6. **Worktree** — whether to run in an isolated git worktree

### Examples

```
/loop
→ Agent derives plan from conversation context

/loop the provider list bug
→ Plan: full context about the bug, steps to fix, acceptance criteria
   Name: provider-list-fix

/loop until tests pass
→ Plan: make the failing tests pass, acceptance criteria: all tests pass
   Name: fix-tests

/loop in a worktree
→ Same as above but all agents run in a shared worktree
```

## Using the Script

The loop is implemented as a bash script at `~/.agents/skills/loop/bin/loop.sh`.

```bash
~/.agents/skills/loop/bin/loop.sh \
  --plan "The full implementation plan" \
  --name "short-name" \
  --max-iterations 10 \
  --worker-provider codex \
  --worker-model gpt-5.4 \
  --judge-provider claude \
  --judge-model sonnet
```

### Arguments

| Flag | Required | Default | Description |
|---|---|---|---|
| `--plan` | Yes* | — | Full implementation plan (given to both worker and judge) |
| `--plan-file` | Yes* | — | Read the plan from a file |
| `--name` | Yes | — | Name prefix for agents (`name-work-N`, `name-verify-N`) |
| `--max-iterations` | No | 10 | Safety cap on iterations |
| `--worktree` | No | — | Worktree name. Created on first use, reused for all subsequent agents. |
| `--worker-provider` | No | `codex` | `codex` or `claude` |
| `--worker-model` | No | provider default | Model for worker |
| `--judge-provider` | No | `claude` | `codex` or `claude` |
| `--judge-model` | No | provider default | Model for judge |
| `--thinking` | No | `medium` | Thinking level for worker |

\* Provide exactly one of `--plan` or `--plan-file`.

### How the Plan Is Used

The same plan is given to both the worker and the judge, wrapped in XML tags:

**Worker receives:**
```
Implement the following plan exactly as specified.

<plan>
[your plan here]
</plan>
```

If a previous iteration failed, the worker also receives:
```
<previous-verification-failure>
[judge's failure reason from last iteration]
</previous-verification-failure>
```

**Judge receives:**
```
Verify that every step of the plan has been implemented to the letter.

<plan>
[your plan here]
</plan>
```

### Agent Naming

Agents are named `{name}-work-{N}` and `{name}-verify-{N}` so the caller can track iterations:

```
fix-bug-work-1     # First worker attempt
fix-bug-verify-1   # First judge check
fix-bug-work-2     # Second worker attempt (with failure context)
fix-bug-verify-2   # Second judge check
```

### Worktree Support

When `--worktree` is passed, all workers and judges run in the same git worktree. The worktree is created on the first agent launch and reused for all subsequent agents (the `--worktree` flag on `paseo run` is idempotent — if the worktree exists, the agent runs in it without creating a new one).

No `--base` is needed in the loop script — it automatically uses the current branch as the base.

```bash
~/.agents/skills/loop/bin/loop.sh \
  --plan-file /tmp/my-plan.md \
  --name "feature-x" \
  --worktree "feature-x"
```

## Your Job

1. **Understand the task** from the conversation context and `$ARGUMENTS`
2. **Write the plan** — comprehensive, self-contained (the worker has zero context). The plan should include:
   - Task description and context
   - Relevant files and what they do
   - Implementation steps (ordered, concrete)
   - Acceptance criteria (factual, verifiable)
   - Constraints (what NOT to do)
3. **Choose models** — default: Codex worker + Claude sonnet judge
4. **Choose a name** — short, descriptive
5. **Run the script** — call `loop.sh` with all the arguments

### Steering Guidance

- Prefer tightening or clarifying the plan when important requirements are missing.
- Rework acceptance criteria when they are causing dead loops or are not independently verifiable.
- Avoid weakening user-defined criteria unless the user explicitly asks for that change.
- Keep the plan self-contained so the loop can succeed without relying on iterative reasoning context.

### Writing a Good Plan

The plan is the single source of truth for both the worker and the judge. It must be:

1. **Self-contained** — The worker starts with zero context. Everything needed is in the plan.
2. **Specific** — Name files, functions, types. "Update the handler" is useless. "In `src/handlers/auth.ts`, modify the `handleLogin` function to..." is useful.
3. **Ordered** — Steps should be in implementation order.
4. **Verifiable** — Every step and criterion must be independently checkable by the judge.

**Good plan elements:**
- "File `src/utils.ts` exports a function named `formatDate`"
- "Running `npm test` exits with code 0"
- "The component at `src/ProviderList.tsx` renders a list of providers from the API response"
- "Typecheck passes (`npm run typecheck`)"
- "`npm run typecheck` passes"

**Bad plan elements:**
- "The code is clean" (subjective)
- "The implementation is correct" (vague)
- "It works" (unverifiable)

### Skill Stacking

You can instruct the worker to use other skills in the plan:

```bash
~/.agents/skills/loop/bin/loop.sh \
  --plan "Use the /committee skill to plan and then fix the provider list bug. The bug is..." \
  --name "provider-fix"
```

### Composing with Handoff

A handoff can launch a loop in a worktree:

```
/handoff a loop in a worktree
```

The handoff skill writes a prompt telling the new agent to use `/loop`, and the loop runs inside the worktree.
