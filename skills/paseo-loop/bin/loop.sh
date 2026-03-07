#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: loop.sh (--plan PROMPT | --plan-file PATH) --name NAME [options]

Required:
  --plan PROMPT           The implementation plan (given to both worker and judge)
  --plan-file PATH        Read the plan from a file
  --name NAME             Name prefix for agents (e.g. "fix-bug" → "fix-bug-work-1", "fix-bug-verify-1")

Options:
  --max-iterations N      Maximum loop iterations (default: 10)
  --worktree NAME         Run all agents in this worktree (created on first use, reused after)
  --worker-provider P     Worker provider: claude or codex (default: codex)
  --worker-model M        Worker model (default: provider's default)
  --judge-provider P      Judge provider: claude or codex (default: claude)
  --judge-model M         Judge model (default: provider's default)
  --thinking LEVEL        Thinking level for worker (default: medium)
EOF
  exit 1
}

# Defaults
max_iterations=10
worker_provider="codex"
worker_model=""
judge_provider="claude"
judge_model="sonnet"
plan=""
plan_file_input=""
name=""
thinking="medium"
worktree=""
state_root="${HOME}/.paseo/loops"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan) plan="$2"; shift 2 ;;
    --plan-file) plan_file_input="$2"; shift 2 ;;
    --name) name="$2"; shift 2 ;;
    --max-iterations) max_iterations="$2"; shift 2 ;;
    --worktree) worktree="$2"; shift 2 ;;
    --worker-provider) worker_provider="$2"; shift 2 ;;
    --worker-model) worker_model="$2"; shift 2 ;;
    --judge-provider) judge_provider="$2"; shift 2 ;;
    --judge-model) judge_model="$2"; shift 2 ;;
    --thinking) thinking="$2"; shift 2 ;;
    --help|-h) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

load_prompt() {
  local inline_value="$1"
  local file_value="$2"
  local label="$3"

  if [[ -n "$inline_value" && -n "$file_value" ]]; then
    echo "Error: use either --${label} or --${label}-file, not both"
    usage
  fi

  if [[ -n "$file_value" ]]; then
    [[ -f "$file_value" ]] || { echo "Error: --${label}-file not found: $file_value"; exit 1; }
    local file_content
    file_content="$(cat "$file_value")"
    [[ -n "$file_content" ]] || { echo "Error: --${label}-file is empty: $file_value"; exit 1; }
    printf '%s' "$file_content"
    return 0
  fi

  if [[ -n "$inline_value" ]]; then
    printf '%s' "$inline_value"
    return 0
  fi

  echo "Error: either --${label} or --${label}-file is required"
  usage
}

plan="$(load_prompt "$plan" "$plan_file_input" "plan")"
[[ -z "$name" ]] && { echo "Error: --name is required"; usage; }

mkdir -p "$state_root"

generate_loop_id() {
  uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-' | cut -c1-6
}

loop_id="$(generate_loop_id)"
state_dir="${state_root}/${loop_id}"
while [[ -e "$state_dir" ]]; do
  loop_id="$(generate_loop_id)"
  state_dir="${state_root}/${loop_id}"
done

mkdir -p "$state_dir"

plan_file="${state_dir}/plan.md"
last_reason_file="${state_dir}/last_reason.md"
history_log="${state_dir}/history.log"

printf '%s\n' "$plan" > "$plan_file"
printf '' > "$last_reason_file"
printf '' > "$history_log"

# Build worker flags
worker_flags=()
if [[ "$worker_provider" == "codex" ]]; then
  worker_flags+=(--mode full-access --provider codex)
elif [[ "$worker_provider" == "claude" ]]; then
  worker_flags+=(--mode bypassPermissions)
fi
[[ -n "$worker_model" ]] && worker_flags+=(--model "$worker_model")
[[ -n "$thinking" ]] && worker_flags+=(--thinking "$thinking")

# Build judge flags
judge_flags=()
if [[ "$judge_provider" == "codex" ]]; then
  judge_flags+=(--mode full-access --provider codex)
elif [[ "$judge_provider" == "claude" ]]; then
  judge_flags+=(--mode bypassPermissions)
fi
[[ -n "$judge_model" ]] && judge_flags+=(--model "$judge_model")

# Worktree flags — passed to every paseo run call
worktree_flags=()
if [[ -n "$worktree" ]]; then
  base_branch="$(git branch --show-current 2>/dev/null || echo "main")"
  worktree_flags+=(--worktree "$worktree" --base "$base_branch")
fi

# Judge output schema
judge_schema='{"type":"object","properties":{"criteria_met":{"type":"boolean"},"reason":{"type":"string"}},"required":["criteria_met","reason"],"additionalProperties":false}'

iteration=0

echo "=== Loop started: $name ==="
echo "  Loop ID: $loop_id"
echo "  State dir: $state_dir"
echo "  Plan file: $plan_file"
echo "  Last reason file: $last_reason_file"
echo "  History log: $history_log"
echo "  Steering: edits to plan.md are picked up on the next worker/judge launch."
echo "  Worker: $worker_provider ${worker_model:-(default)}"
echo "  Judge:  $judge_provider ${judge_model:-(default)}"
if [[ -n "$worktree" ]]; then
  echo "  Worktree: $worktree (base: $base_branch)"
fi
echo "  Max iterations: $max_iterations"
echo ""

while [[ $iteration -lt $max_iterations ]]; do
  iteration=$((iteration + 1))
  echo "--- Iteration $iteration/$max_iterations ---"

  if [[ ! -s "$plan_file" ]]; then
    echo "Error: plan file is missing or empty: $plan_file"
    exit 1
  fi

  current_plan="$(cat "$plan_file")"
  last_reason="$(cat "$last_reason_file")"

  # Build worker prompt with plan in XML tags
  worker_prompt="Implement the following plan exactly as specified.

<plan>
$current_plan
</plan>"

  if [[ -n "$last_reason" ]]; then
    worker_prompt="$worker_prompt

<previous-verification-failure>
The previous attempt was verified and did NOT pass. Address the following issues before anything else:

$last_reason
</previous-verification-failure>"
  fi

  # Launch worker
  worker_name="${name}-work-${iteration}"
  echo "Launching worker: $worker_name"
  worker_id=$(paseo run -d "${worker_flags[@]}" "${worktree_flags[@]}" --name "$worker_name" "$worker_prompt" -q)
  echo "Worker [$worker_name] launched. ID: $worker_id"
  echo "  Stream logs:  paseo logs $worker_id -f"
  echo "  Inspect:      paseo inspect $worker_id"
  echo "  Wait:         paseo wait $worker_id"

  # Wait for worker
  echo ""
  echo "Waiting for worker to complete..."
  paseo wait "$worker_id"
  echo "Worker done."

  # Build judge prompt with plan in XML tags
  judge_prompt="You are a fact checker. Your ONLY job is to verify whether the plan below was implemented correctly and completely.

Inspect the codebase independently. Do NOT fix anything. Do NOT suggest fixes. Do NOT provide guidance.

<plan>
$current_plan
</plan>

<instructions>
Verify that every step of the plan has been implemented to the letter. If the plan contains acceptance criteria, check each one individually.

Report ONLY facts:
- criteria_met: true if the ENTIRE plan is implemented correctly, false if ANY part is missing or wrong
- reason: for each item in the plan, state whether it was implemented correctly with evidence (file contents, test output, etc.). Be specific about what passed and what failed.
</instructions>"

  # Launch judge (blocking, structured output)
  judge_name="${name}-verify-${iteration}"
  echo ""
  echo "Launching judge: $judge_name (synchronous, blocks until verdict)"
  verdict=$(paseo run "${judge_flags[@]}" "${worktree_flags[@]}" --name "$judge_name" --output-schema "$judge_schema" "$judge_prompt")
  echo "Verdict: $verdict"

  # Parse verdict
  criteria_met=$(echo "$verdict" | jq -r '.criteria_met')
  reason=$(echo "$verdict" | jq -r '.reason')
  printf '[%s] iteration=%s worker_id=%s judge=%s criteria_met=%s reason=%s\n' \
    "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
    "$iteration" \
    "$worker_id" \
    "$judge_name" \
    "$criteria_met" \
    "$(echo "$reason" | tr '\n' ' ')" >> "$history_log"

  if [[ "$criteria_met" == "true" ]]; then
    echo ""
    echo "=== Loop complete: criteria met on iteration $iteration ==="
    echo "Reason: $reason"
    echo ""
    echo "Review the final worker's changes:"
    echo "  paseo logs $worker_id"
    echo "  paseo inspect $worker_id"
    exit 0
  fi

  echo "Criteria not met: $reason"
  echo "Starting next iteration..."

  # Keep only the latest judge reason for the next worker iteration.
  printf '%s\n' "$reason" > "$last_reason_file"

  echo ""
done

echo "=== Loop exhausted: $max_iterations iterations without meeting criteria ==="
exit 1
