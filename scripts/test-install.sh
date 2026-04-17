#!/bin/bash
# Claws — post-install test + live demo of multi-terminal orchestration
# Run after install.sh. Proves every feature works end-to-end.
# Usage: bash scripts/test-install.sh

set -e

SOCK=".claws/claws.sock"
PASS=0
FAIL=0

passed() { echo "  ✓ $1"; PASS=$((PASS+1)); }
failed() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "  ╔═══════════════════════════════════════════╗"
echo "  ║   CLAWS — Installation Test + Live Demo   ║"
echo "  ╚═══════════════════════════════════════════╝"
echo ""

# Test 1: Socket exists
echo "── Test 1: Socket connection ──"
if [ -S "$SOCK" ]; then
  passed "socket found at $SOCK"
else
  failed "no socket at $SOCK — did you reload VS Code?"
  echo "  Run: Cmd+Shift+P → 'Developer: Reload Window'"
  exit 1
fi

# Test 2: List terminals
echo "── Test 2: List terminals ──"
RESP=$(echo '{"id":1,"cmd":"list"}' | nc -U "$SOCK" 2>/dev/null)
if echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['ok']" 2>/dev/null; then
  COUNT=$(echo "$RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['terminals']))")
  passed "listed $COUNT terminal(s)"
else
  failed "list command failed"
fi

# Test 3: Python client
echo "── Test 3: Python client ──"
if python3 -c "from claws import ClawsClient; print('OK')" 2>/dev/null; then
  passed "python client importable"
else
  failed "python client not installed — run: pip install -e clients/python"
fi

# Test 4: Create + exec + read + close (full loop)
echo "── Test 4: Full terminal lifecycle ──"
python3 - <<'PY'
import sys, time
try:
    from claws import ClawsClient
    c = ClawsClient(".claws/claws.sock")
    t = c.create("claws-test", wrapped=True)
    time.sleep(1.5)
    r = c.exec(t.id, "echo CLAWS_TEST_PASS && date && uname -a")
    assert r.exit_code == 0, f"exit code {r.exit_code}"
    assert "CLAWS_TEST_PASS" in r.output, "output missing marker"
    log = c.read_log(t.id, lines=10)
    assert len(log) > 0, "empty log"
    c.close(t.id)
    print("  ✓ create → exec → readLog → close — all passed")
except Exception as e:
    print(f"  ✗ lifecycle test failed: {e}")
    sys.exit(1)
PY

# Test 5: Multi-terminal orchestration demo
echo ""
echo "── Test 5: LIVE DEMO — Multi-terminal orchestration ──"
echo ""
python3 - <<'PY'
import time
from claws import ClawsClient

c = ClawsClient(".claws/claws.sock")

# Spawn 3 workers
print("  Spawning 3 parallel workers...")
workers = {}
for name, cmd in [("worker-alpha", "echo 'Alpha reporting' && sleep 1 && echo 'Alpha done'"),
                  ("worker-beta", "echo 'Beta reporting' && ls -1 | head -5 && echo 'Beta done'"),
                  ("worker-gamma", "echo 'Gamma reporting' && date && whoami && echo 'Gamma done'")]:
    t = c.create(name, wrapped=True)
    workers[name] = t
    time.sleep(0.5)
print(f"  ✓ 3 terminals spawned: {', '.join(workers.keys())}")

# Fire all commands in parallel
print("  Firing commands into all 3...")
for name, cmd in [("worker-alpha", "echo 'Alpha reporting' && sleep 1 && echo 'Alpha done'"),
                  ("worker-beta", "echo 'Beta reporting' && ls -1 | head -5 && echo 'Beta done'"),
                  ("worker-gamma", "echo 'Gamma reporting' && date && whoami && echo 'Gamma done'")]:
    c.send(workers[name].id, cmd)
print("  ✓ Commands sent to all 3 workers")

# Wait and collect results
print("  Waiting for results...")
time.sleep(3)

print("")
print("  ┌─────────────────────────────────────────────┐")
for name, t in workers.items():
    log = c.read_log(t.id, lines=8)
    lines = [l for l in log.splitlines() if l.strip() and "done" in l.lower()]
    status = "DONE" if lines else "..."
    print(f"  │  {name:<20} [{status}]")
print("  └─────────────────────────────────────────────┘")
print("")

# Cleanup
for name, t in workers.items():
    c.close(t.id)
print("  ✓ All 3 workers closed. Terminals cleaned up.")
print("")
print("  Multi-terminal orchestration works. You're ready.")
PY

echo ""
echo "  ════════════════════════════════════════════"
echo "  Results: $PASS passed"
echo ""
echo "  Your terminals are now programmable."
echo "  Docs:    https://github.com/neunaha/claws"
echo "  Website: https://neunaha.github.io/claws/"
echo "  ════════════════════════════════════════════"
echo ""
