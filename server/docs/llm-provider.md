# LLM provider — Google Gemini (free tier)

- **Model:** `gemini-3.6-flash`
  (`gemini-2.0-flash` is retired — the API returns `404 NOT_FOUND` telling you to
  move to `gemini-3.6-flash`.)
- **Base URL:** `https://generativelanguage.googleapis.com/v1beta/models`
- **Endpoint:** `POST {BASE}/{MODEL}:generateContent?key={LLM_API_KEY}`
- **Get a key:** https://aistudio.google.com/app/apikey (no billing required for the free tier)

Recorded in `server/.env.example` as `LLM_MODEL`, `LLM_API_URL`, `LLM_API_KEY`.

## Make the manual test call (A2)

```bash
export LLM_API_KEY=your-key-here
./scripts/llm-smoke.sh
```

or directly, using the Phase 4 confidence convention (structured JSON output):

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=$LLM_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "system_instruction": { "parts": [{ "text": "You are the automated first-line support assistant for \"Acme\". Answer ONLY from the Knowledge Base below. Never use outside knowledge. Never guess.\n\nKnowledge Base:\nQ: What are your opening hours?\nA: We are open 9am to 5pm, Monday to Friday.\n---\n\nRules:\n- If the Knowledge Base clearly answers the visitor'\''s question, reply with a short, friendly answer in the visitor'\''s language.\n- Otherwise — not covered, unsure, visitor asks for a human, visitor is upset, wants to purchase, or has an account-specific problem — do NOT answer.\n- Respond with exactly one JSON object and nothing else:\n  {\"confident\": true, \"answer\": \"<your answer>\"}\n  {\"confident\": false, \"answer\": \"\"}" }] },
    "contents": [
      { "role": "user", "parts": [{ "text": "What time do you open?" }] }
    ],
    "generationConfig": { "temperature": 0.2, "maxOutputTokens": 800, "responseMimeType": "application/json" }
  }'
```

Expected reply text (a single JSON object): `{"confident": true, "answer": "We're open 9am–5pm, Monday to Friday."}`.
Ask something off-topic instead and it returns `{"confident": false, "answer": ""}`.

## Request shape

```jsonc
{
  "system_instruction": { "parts": [{ "text": "<system prompt>" }] },
  "contents": [
    { "role": "user",  "parts": [{ "text": "..." }] },
    { "role": "model", "parts": [{ "text": "..." }] }   // prior AI turn
  ],
  "generationConfig": {
    "temperature": 0.2,
    "maxOutputTokens": 800,          // thinking tokens count against this — keep headroom
    "responseMimeType": "application/json"  // force a single JSON object, no prose/fences
  }
}
```

- Roles inside `contents` are **`user`** and **`model`** only — no `system`/`assistant`.
- System prompt goes in the top-level `system_instruction`, not in `contents`.

## Confidence convention (Phase 4)

`src/ai/responder.js` builds the system prompt (`buildSystemPrompt`) so the model
must answer with exactly one JSON object:

- `{"confident": true, "answer": "<short answer>"}` — the KB clearly answers the question.
- `{"confident": false, "answer": ""}` — anything else (not in KB, unsure, wants a
  human, upset, wants to buy, account-specific).

`parseConfidence(text, finishReason)` treats **all** of the following as *not confident*
→ hand off to a human: `JSON.parse` fails (after stripping ``` fences), `confident !== true`,
`answer` empty/whitespace, `finishReason` is `MAX_TOKENS` or `SAFETY`, or a bare
`NEEDS_HUMAN` sentinel comes back. Transport errors from `aiClient` (`TIMEOUT`,
`RATE_LIMIT`, `HTTP_ERROR`, `MALFORMED`, `NOT_CONFIGURED`) also hand off.

## Response shape (success)

```jsonc
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [
          {
            "text": "<reply text>",
            "thoughtSignature": "<opaque base64 — present on 3.x thinking models, ignore it>"
          }
        ]
      },
      "finishReason": "STOP",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 30,
    "candidatesTokenCount": 5,
    "thoughtsTokenCount": 131,   // 3.x is a thinking model; billed but not returned
    "totalTokenCount": 166,
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-3.6-flash",
  "responseId": "…"
}
```

Extract the reply with: `json.candidates[0].content.parts[0].text`
(a `part` may also carry `thoughtSignature` — take the one that has `text`).

Error responses use HTTP 4xx/5xx with `{ "error": { "code", "message", "status" } }`.

## Real captured call (A2)

> Historical — captured before the Phase 4 JSON confidence convention. It uses the
> old `NEEDS_HUMAN` sentinel and `maxOutputTokens: 256`; the sentinel is still
> accepted by `parseConfidence` as a "not confident" signal, but production now
> sends the JSON prompt above with `responseMimeType: "application/json"`.

Captured 2026-09-06 against a live key. Model `gemini-2.0-flash` first returned:

```json
{
  "error": {
    "code": 404,
    "message": "This model models/gemini-2.0-flash is no longer available. Please update your code to use models/gemini-3.6-flash for the latest features and improvements. We recommend you to use the Interactions API.",
    "status": "NOT_FOUND"
  }
}
```

Re-run with `LLM_MODEL=gemini-3.6-flash`:

### Request

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=***
Content-Type: application/json

{
  "system_instruction": { "parts": [{ "text": "You are a concise support assistant. If you cannot answer from the given context, reply exactly NEEDS_HUMAN." }] },
  "contents": [
    { "role": "user", "parts": [{ "text": "What are your opening hours?" }] }
  ],
  "generationConfig": { "temperature": 0.2, "maxOutputTokens": 256 }
}
```

### Response — HTTP 200

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "text": "NEEDS_HUMAN",
            "thoughtSignature": "EooFCocFARFNMg+bWiMruVvFfCWMjVwEcrJno/f4rHcXfSR0dmhLdJGhmMv4rFl0MUsN7m1bsK4ZYJrXzBsyXR1RmVweejzJbA47DZh50Uf9F2YxDIzdAB524hF...(truncated)"
          }
        ],
        "role": "model"
      },
      "finishReason": "STOP",
      "index": 0
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 30,
    "candidatesTokenCount": 5,
    "totalTokenCount": 166,
    "promptTokensDetails": [{ "modality": "TEXT", "tokenCount": 30 }],
    "thoughtsTokenCount": 131,
    "serviceTier": "standard"
  },
  "modelVersion": "gemini-3.6-flash",
  "responseId": "KJadau6TAdCHxs0PjZDzmAI"
}
```

Notes for the code that depends on this (Phase 4):

- Reply text: `candidates[0].content.parts[0].text` → `"NEEDS_HUMAN"`. Here the model
  correctly refused (no opening-hours context was supplied) — exactly the
  confidence signal `responder.js` will branch on for AI-vs-human handoff.
- `parts[].thoughtSignature` and `usageMetadata.thoughtsTokenCount` are new on the
  3.x "thinking" models. Ignore `thoughtSignature`; the raw reasoning is not returned.
- `finishReason: "STOP"` is the success case. Watch for `"MAX_TOKENS"` (bump
  `maxOutputTokens` — thinking tokens count against it) and `"SAFETY"`.
