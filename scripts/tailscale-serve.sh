#!/usr/bin/env bash
#
# Publish the locally-running SecureChat web tier to your Tailscale tailnet
# over HTTPS. Tailscale Serve provisions a trusted *.ts.net certificate, which
# is required for camera/microphone access (WebRTC calls) in the browser.
#
# Prerequisites (one-time, in the Tailscale admin console):
#   - Enable MagicDNS
#   - Enable HTTPS Certificates
#
# Usage:
#   WEB_PORT=8080 scripts/tailscale-serve.sh
#
# Then set CORS_ORIGIN and COOKIE_SECURE in your .env to the printed origin and
# restart the stack. See docs/DEPLOYMENT.md.

set -euo pipefail

PORT="${WEB_PORT:-8080}"
TARGET="http://127.0.0.1:${PORT}"
SERVE_PORT="${TS_SERVE_PORT:-443}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "error: tailscale CLI not found on PATH. Install Tailscale on the host first." >&2
  exit 1
fi

if ! curl -fsS -o /dev/null "${TARGET}/api/v1/health" 2>/dev/null; then
  echo "warning: ${TARGET} did not answer /api/v1/health yet." >&2
  echo "         Start the stack first: docker compose up -d --build" >&2
fi

echo "Publishing ${TARGET} on https://<this-node>.<tailnet>.ts.net ..."
tailscale serve --bg --https="${SERVE_PORT}" "${TARGET}"

echo
tailscale serve status
echo
echo "Set these in your .env and restart the stack:"
echo "  CORS_ORIGIN=https://<this-node>.<tailnet>.ts.net"
echo "  COOKIE_SECURE=true"
