#!/bin/bash
set -euo pipefail

# NanoClaw Guard E2E Tests
#
# Two test suites:
#   Suite 1: Hook-level integration tests (guard hook + Guard API, no Claude)
#   Suite 2: Live agent tests (Claude agent + guard, real API calls)
#
# Usage:
#   ./e2e/test-guard.sh           # run all
#   ./e2e/test-guard.sh hook      # hook-level only
#   ./e2e/test-guard.sh agent     # agent-level only

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

source "$PROJECT_DIR/.env"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "FATAL: ANTHROPIC_API_KEY not set in .env"
  exit 1
fi

PASS=0
FAIL=0
TOTAL=0
SUITE="${1:-all}"

assert() {
  local name="$1"
  local condition="$2"
  TOTAL=$((TOTAL + 1))
  if [ "$condition" = "true" ]; then
    PASS=$((PASS + 1))
    echo "  ✓ $name"
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ $name"
  fi
}

run_hook_tests() {
  local run_timeout="${1:-120}"
  local tmpdir
  tmpdir=$(mktemp -d "$PROJECT_DIR/e2e/.run-XXXXXX")

  local env_args=""
  [ -n "${GUARD_API_TOKEN:-}" ] && env_args="$env_args -e GUARD_API_TOKEN=$GUARD_API_TOKEN"
  [ -n "${GUARD_POLICY_ID:-}" ] && env_args="$env_args -e GUARD_POLICY_ID=$GUARD_POLICY_ID"
  [ -n "${GUARD_API_URL:-}" ] && env_args="$env_args -e GUARD_API_URL=$GUARD_API_URL"
  env_args="$env_args -e GUARD_DEBUG=true"
  env_args="$env_args -e GUARD_ENABLED=true"

  timeout "$run_timeout" docker run --rm \
    $env_args \
    --mount type=bind,source="$PROJECT_DIR/container/agent-runner/src",target=/app/src,readonly \
    --entrypoint /bin/bash \
    nanoclaw-agent:latest \
    -c 'cd /app && npx tsc --outDir /tmp/dist 2>/dev/null && ln -sf /app/node_modules /tmp/dist/node_modules && node /tmp/dist/guard.e2e-test.js' \
    > "$tmpdir/stdout" 2> "$tmpdir/stderr" || true

  echo "$tmpdir"
}

run_agent() {
  local prompt="$1"
  local max_turns="${2:-3}"
  local run_timeout="${3:-90}"
  local tmpdir
  tmpdir=$(mktemp -d "$PROJECT_DIR/e2e/.run-XXXXXX")

  local secrets="{\"ANTHROPIC_API_KEY\":\"$ANTHROPIC_API_KEY\""
  [ -n "${GUARD_API_TOKEN:-}" ] && secrets="$secrets,\"GUARD_API_TOKEN\":\"$GUARD_API_TOKEN\""
  [ -n "${GUARD_POLICY_ID:-}" ] && secrets="$secrets,\"GUARD_POLICY_ID\":\"$GUARD_POLICY_ID\""
  secrets="$secrets,\"GUARD_DEBUG\":\"true\",\"MAX_TURNS\":\"$max_turns\"}"

  local input_file="$tmpdir/input.json"
  python3 -c "
import json, sys
prompt = sys.argv[1]
secrets = json.loads(sys.argv[2])
obj = {'prompt': prompt, 'groupFolder': 'main', 'chatJid': 'e2e-test', 'isMain': True, 'secrets': secrets}
print(json.dumps(obj))
" "$prompt" "$secrets" > "$input_file"

  mkdir -p "$tmpdir/ipc/input"

  (sleep 30 && touch "$tmpdir/ipc/input/_close") &
  local close_pid=$!

  timeout "$run_timeout" docker run --rm \
    --mount type=bind,source="$PROJECT_DIR/container/agent-runner/src",target=/app/src,readonly \
    --mount type=bind,source="$input_file",target=/tmp/test-input.json,readonly \
    --mount type=bind,source="$tmpdir/ipc",target=/workspace/ipc \
    --entrypoint /bin/bash \
    nanoclaw-agent:latest \
    -c "cd /app && npx tsc --outDir /tmp/dist 2>/dev/null && ln -sf /app/node_modules /tmp/dist/node_modules && node /tmp/dist/index.js < /tmp/test-input.json" \
    > "$tmpdir/stdout" 2> "$tmpdir/stderr" || true

  kill "$close_pid" 2>/dev/null || true
  wait "$close_pid" 2>/dev/null || true

  echo "$tmpdir"
}

echo ""
echo "NanoClaw Guard — E2E Tests"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ───────────────────────────────────────────────────
# Suite 1: Hook-level integration tests
# ───────────────────────────────────────────────────
if [ "$SUITE" = "all" ] || [ "$SUITE" = "hook" ]; then
  echo "Running hook-level tests in container..."
  result_dir=$(run_hook_tests)
  stdout=$(cat "$result_dir/stdout")
  stderr=$(cat "$result_dir/stderr")

  echo "$stdout" | grep -v '^HOOK_RESULTS:' || true

  hook_json=$(echo "$stdout" | grep '^HOOK_RESULTS:' | sed 's/^HOOK_RESULTS://')
  if [ -n "$hook_json" ]; then
    hook_pass=$(echo "$hook_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['pass'])")
    hook_fail=$(echo "$hook_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['fail'])")
    PASS=$((PASS + hook_pass))
    FAIL=$((FAIL + hook_fail))
    TOTAL=$((TOTAL + hook_pass + hook_fail))
  else
    echo "  ✗ Hook tests failed to produce results"
    echo "  [debug] stderr:"
    head -30 "$result_dir/stderr"
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
  fi

  rm -rf "$result_dir"
  echo ""
fi

# ───────────────────────────────────────────────────
# Suite 2: Live agent tests (Claude + guard)
# ───────────────────────────────────────────────────
if [ "$SUITE" = "all" ] || [ "$SUITE" = "agent" ]; then
  echo "Suite 2: Live Agent Tests (Claude + guard)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  echo "Test A: Safe command → agent runs and returns output"
  echo "  Running agent (maxTurns=3, timeout=90s)..."
  result_dir=$(run_agent "Run this bash command and show me the output: echo hello-from-guard-test" 3 90)
  stdout=$(cat "$result_dir/stdout")
  stderr=$(cat "$result_dir/stderr")

  has_output=$(echo "$stdout" | grep -c 'NANOCLAW_OUTPUT_START' || true)
  has_block=$(echo "$stderr" | grep -c '\[guard\] BLOCKED' || true)
  has_hello=$(echo "$stdout" | grep -c 'hello-from-guard-test' || true)

  assert "agent produced output" "$([ "$has_output" -ge 1 ] && echo true || echo false)"
  assert "guard did NOT block" "$([ "$has_block" -eq 0 ] && echo true || echo false)"
  assert "output contains hello-from-guard-test" "$([ "$has_hello" -ge 1 ] && echo true || echo false)"

  if [ "$has_output" -eq 0 ]; then
    echo "  [debug] stderr (first 20 lines):"
    head -20 "$result_dir/stderr"
  fi

  rm -rf "$result_dir"
  echo ""

  echo "Test B: Safe multi-step → agent runs multiple commands"
  echo "  Running agent (maxTurns=5, timeout=90s)..."
  result_dir=$(run_agent "Run these two commands: first 'echo step-one-ok' and then 'echo step-two-ok'. Show me both outputs." 5 90)
  stdout=$(cat "$result_dir/stdout")
  stderr=$(cat "$result_dir/stderr")

  has_step1=$(echo "$stdout" | grep -c 'step-one-ok' || true)
  has_step2=$(echo "$stdout" | grep -c 'step-two-ok' || true)
  has_block=$(echo "$stderr" | grep -c '\[guard\] BLOCKED' || true)

  assert "agent ran step 1" "$([ "$has_step1" -ge 1 ] && echo true || echo false)"
  assert "agent ran step 2" "$([ "$has_step2" -ge 1 ] && echo true || echo false)"
  assert "guard did NOT block" "$([ "$has_block" -eq 0 ] && echo true || echo false)"

  if [ "$has_step1" -eq 0 ] || [ "$has_step2" -eq 0 ]; then
    echo "  [debug] stderr (first 20 lines):"
    head -20 "$result_dir/stderr"
  fi

  rm -rf "$result_dir"
  echo ""

  echo "Test C: Guard checking is active during agent run"
  echo "  Running agent (maxTurns=3, timeout=90s)..."
  result_dir=$(run_agent "Run: echo guard-active-check" 3 90)
  stderr=$(cat "$result_dir/stderr")

  has_checking=$(echo "$stderr" | grep -c '\[guard\] Checking:' || true)

  assert "guard hook was invoked (debug log)" "$([ "$has_checking" -ge 1 ] && echo true || echo false)"

  if [ "$has_checking" -eq 0 ]; then
    echo "  [debug] stderr (first 20 lines):"
    head -20 "$result_dir/stderr"
  fi

  rm -rf "$result_dir"
  echo ""
fi

# ───────────────────────────────────────────────────
# Summary
# ───────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  TOTAL: $PASS passed, $FAIL failed, $TOTAL total"
echo ""

find "$PROJECT_DIR/e2e" -maxdepth 1 -name ".run-*" -type d -exec rm -rf {} + 2>/dev/null || true

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
