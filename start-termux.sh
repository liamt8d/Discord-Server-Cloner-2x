#!/usr/bin/env bash
set -e
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo 'Instala Node.js en Termux: pkg install nodejs-lts'
  exit 1
fi
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 18) ? 0 : 1)'; then
  echo 'Se necesita Node.js 20.18 o superior: pkg upgrade'
  exit 1
fi
if [ ! -f .env ]; then cp .env.example .env; fi
if [ ! -d node_modules ]; then npm ci; fi
cloner_wake_lock=0
if command -v termux-wake-lock >/dev/null 2>&1; then
  if termux-wake-lock; then cloner_wake_lock=1; fi
fi
cleanup() {
  if [ "$cloner_wake_lock" = 1 ]; then termux-wake-unlock || true; fi
}
trap cleanup EXIT
npm start
