#!/usr/bin/env bash
# Shared configuration for the helper scripts; source this file, do not execute it.
# Export variables in your shell (or explicitly source an ignored .env file).
BASE="${ARTIFACT_BASE_URL:-${ARTIFACT_BASE:-http://127.0.0.1:8787}}"
BASE="$(ARTIFACT_HELPER_BASE="$BASE" node -e '
  try {
    const u = new URL(process.env.ARTIFACT_HELPER_BASE);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if ((u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) ||
        u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new Error();
    process.stdout.write(u.origin);
  } catch {
    console.error("ARTIFACT_BASE_URL must be an HTTPS origin (HTTP is allowed on loopback).");
    process.exit(2);
  }
')" || return 2
if [ -z "${ADMIN_TOKEN:-}" ] && [ -n "${ADMIN_TOKEN_FILE:-}" ]; then
  ADMIN_TOKEN="$(cat "$ADMIN_TOKEN_FILE")" || return 2
fi
if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "Set ADMIN_TOKEN or ADMIN_TOKEN_FILE before using an admin helper." >&2
  return 2
fi
if [[ "$ADMIN_TOKEN" == *$'\n'* || "$ADMIN_TOKEN" == *$'\r'* ]]; then
  echo "ADMIN_TOKEN must not contain line breaks." >&2
  return 2
fi
export ADMIN_TOKEN
