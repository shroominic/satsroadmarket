#!/usr/bin/env bash
# Local Cashu mint (nutshell, FakeWallet backend) on http://127.0.0.1:3338
# FakeWallet auto-pays mint quotes (FAKEWALLET_BRR=True), so tests can fund wallets with no Lightning.
# Usage: scripts/local-mint.sh [start|stop|status|logs]   (start runs detached and waits until ready)
set -euo pipefail
NAME=${MINT_CONTAINER:-satsroad-mint}
PORT=${MINT_PORT:-3338}
IMAGE=${MINT_IMAGE:-cashubtc/nutshell:latest}
URL="http://127.0.0.1:${PORT}"
cmd=${1:-start}

case "$cmd" in
  start)
    command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }
    docker info >/dev/null 2>&1 || { echo "docker daemon not running (open Docker Desktop)" >&2; exit 1; }
    if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then echo "already running"; else
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:3338" \
        -e MINT_BACKEND_BOLT11_SAT=FakeWallet \
        -e MINT_LISTEN_HOST=0.0.0.0 -e MINT_LISTEN_PORT=3338 \
        -e MINT_PRIVATE_KEY=satsroad-local-test-key-not-secret \
        -e FAKEWALLET_BRR=True -e FAKEWALLET_DELAY_PAYMENT=0 \
        -e MINT_INPUT_FEE_PPK=0 \
        "$IMAGE" poetry run mint >/dev/null
    fi
    for _ in $(seq 1 60); do
      if curl -fsS "$URL/v1/info" >/dev/null 2>&1; then echo "mint ready: $URL"; exit 0; fi
      sleep 1
    done
    echo "mint did not become ready; logs:" >&2; docker logs --tail 30 "$NAME" >&2; exit 1 ;;
  stop) docker rm -f "$NAME" >/dev/null 2>&1 && echo stopped || echo "not running" ;;
  status) curl -fsS "$URL/v1/info" || { echo "mint down" >&2; exit 1; } ;;
  logs) docker logs -f "$NAME" ;;
  *) echo "usage: $0 [start|stop|status|logs]" >&2; exit 2 ;;
esac
