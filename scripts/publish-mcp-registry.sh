#!/usr/bin/env bash
set -euo pipefail

# Retry registration only: npm may accept a publish before its version metadata
# reaches the registry's cache. Never repeat npm publish or mask other failures.
max_attempts=21
retry_delay_seconds=30

for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  printf 'Publishing to MCP Registry (attempt %s/%s)\n' "$attempt" "$max_attempts"
  if output=$(./mcp-publisher publish 2>&1); then
    printf '%s\n' "$output"
    exit 0
  else
    status=$?
  fi
  printf '%s\n' "$output" >&2

  # Match the specific registry validation error seen after publishing v0.14.0.
  # Authentication, malformed metadata, conflicts, and other errors fail fast.
  case "$output" in
    *"NPM package '"*"' exists, but version '"*"' was not found (status: 404)"*) ;;
    *) exit "$status" ;;
  esac

  if ((attempt == max_attempts)); then
    printf '::error::npm version is still unavailable after %s registration attempts; giving up.\n' "$max_attempts" >&2
    exit "$status"
  fi

  printf 'Waiting %s seconds for npm propagation before retrying registration.\n' "$retry_delay_seconds"
  sleep "$retry_delay_seconds"
done
