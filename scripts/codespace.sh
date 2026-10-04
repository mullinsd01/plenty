#!/usr/bin/env bash
# One command to get Plenty running in a GitHub Codespace (or any dev container with a Postgres reachable through
# DATABASE_URL). Safe to run again: every step is repeatable.
#
#   bash scripts/codespace.sh          set everything up, then run the app in this terminal
#   bash scripts/codespace.sh setup    set up only (used when the Codespace is created)
set -u
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

[ -f .env ] || cp .env.example .env
[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL isn't set. In a Codespace it comes from .devcontainer/docker-compose.yml: rebuild the container (Command Palette → Codespaces: Rebuild Container)."

hostport=$(node -e 'const u = new URL(process.env.DATABASE_URL); console.log(u.hostname + " " + (u.port || 5432))')
host=${hostport% *}; port=${hostport#* }
say "Waiting for the database at $host:$port"
ready=0
for _ in $(seq 1 60); do
  if (echo > "/dev/tcp/$host/$port") 2>/dev/null; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] || fail "The database at $host:$port isn't answering after two minutes. In a Codespace, rebuild the container so the database service starts."

say "Installing packages (the first time takes a few minutes)"
npm install || fail "npm install failed. Read the error above, then run this script again."

say "Setting up the database, product catalog and recipes"
npm run setup || fail "Database setup failed. Read the error above."

say "Loading the demo household and the role accounts"
npm run db:seed || fail "Loading the demo household failed. Read the error above."
npm run db:seed-roles || fail "Loading the role accounts failed. Read the error above."

[ "${1:-}" = "setup" ] && { say "Setup finished. Start the app with: npm run dev"; exit 0; }

say "Starting Plenty on port 3000. Open the Ports tab and click the globe next to port 3000."
exec npm run dev
