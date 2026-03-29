#!/bin/bash
# Claude Code status line script for metro-mcp
# Shows the CDP connection status of the Metro bundler.
#
# Setup:
#   chmod +x /path/to/metro-mcp/scripts/claude-statusline.sh
#   Add to ~/.claude/settings.json:
#   {
#     "statusLine": {
#       "type": "command",
#       "command": "/path/to/metro-mcp/scripts/claude-statusline.sh"
#     }
#   }

STATUS_FILE="/tmp/metro-mcp-status.json"

if [ ! -f "$STATUS_FILE" ]; then
  echo "Metro: --"
  exit 0
fi

CONNECTED=$(jq -r '.connected' "$STATUS_FILE" 2>/dev/null)
HOST=$(jq -r '.host' "$STATUS_FILE" 2>/dev/null)
PORT=$(jq -r '.port' "$STATUS_FILE" 2>/dev/null)

if [ "$CONNECTED" = "true" ]; then
  printf "\033[32mMetro \u2713 %s:%s\033[0m\n" "$HOST" "$PORT"
else
  printf "\033[31mMetro \u2717\033[0m\n"
fi
