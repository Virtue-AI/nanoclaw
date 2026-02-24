#!/bin/bash
# Toggle Action Guard + Skills Guard (skill scan) on/off for demo
# Usage: bash e2e/guard-toggle.sh [on|off]

set -e
ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env not found at $ENV_FILE"
  exit 1
fi

case "${1:-}" in
  off)
    # Disable both guards
    if grep -q '^GUARD_ENABLED=' "$ENV_FILE"; then
      sed -i 's/^GUARD_ENABLED=.*/GUARD_ENABLED=false/' "$ENV_FILE"
    else
      echo 'GUARD_ENABLED=false' >> "$ENV_FILE"
    fi
    if grep -q '^SKILLS_GUARD_ENABLED=' "$ENV_FILE"; then
      sed -i 's/^SKILLS_GUARD_ENABLED=.*/SKILLS_GUARD_ENABLED=false/' "$ENV_FILE"
    else
      echo 'SKILLS_GUARD_ENABLED=false' >> "$ENV_FILE"
    fi
    echo "\u2705 Guard OFF — next agent run will skip action guard + skill scan"
    ;;
  on)
    # Enable both guards (remove SKILLS_GUARD_ENABLED since default is on)
    if grep -q '^GUARD_ENABLED=' "$ENV_FILE"; then
      sed -i 's/^GUARD_ENABLED=.*/GUARD_ENABLED=true/' "$ENV_FILE"
    else
      echo 'GUARD_ENABLED=true' >> "$ENV_FILE"
    fi
    sed -i '/^SKILLS_GUARD_ENABLED=/d' "$ENV_FILE"
    echo "\u2705 Guard ON — next agent run will enforce action guard + skill scan"
    ;;
  *)
    # Show current status
    GUARD=$(grep '^GUARD_ENABLED=' "$ENV_FILE" 2>/dev/null | cut -d= -f2)
    SKILLS=$(grep '^SKILLS_GUARD_ENABLED=' "$ENV_FILE" 2>/dev/null | cut -d= -f2)
    echo "Current guard status:"
    echo "  Action Guard:  ${GUARD:-true (default)}"
    echo "  Skills Guard:  ${SKILLS:-true (default)}"
    echo ""
    echo "Usage: $0 [on|off]"
    ;;
esac