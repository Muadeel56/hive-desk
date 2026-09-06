#!/usr/bin/env bash
# Manual chat-completion smoke test against Google Gemini (task A2).
# Usage:  LLM_API_KEY=your-key ./scripts/llm-smoke.sh  ["your question"]
set -euo pipefail

MODEL="${LLM_MODEL:-gemini-3.6-flash}"
BASE="${LLM_API_URL:-https://generativelanguage.googleapis.com/v1beta/models}"
QUESTION="${1:-What are your opening hours?}"

if [ -z "${LLM_API_KEY:-}" ]; then
  echo "LLM_API_KEY is not set. Get one at https://aistudio.google.com/app/apikey" >&2
  exit 1
fi

REQ=$(cat <<JSON
{
  "system_instruction": { "parts": [{ "text": "You are a concise support assistant. If you cannot answer from the given context, reply exactly NEEDS_HUMAN." }] },
  "contents": [
    { "role": "user", "parts": [{ "text": $(printf '%s' "$QUESTION" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))') }] }
  ],
  "generationConfig": { "temperature": 0.2, "maxOutputTokens": 256 }
}
JSON
)

echo "--- REQUEST ---"
echo "$REQ"
echo
echo "--- RESPONSE ---"
curl -sS "${BASE}/${MODEL}:generateContent?key=${LLM_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d "$REQ"
echo
