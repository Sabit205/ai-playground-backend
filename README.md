# OmniAI Backend (Render)

Express server that does ALL the heavy lifting for the OmniAI playground.
The Next.js frontend (deployed on Vercel) never calls AI providers directly —
Vercel's serverless functions are not suited for long-running/streaming tasks,
so every upstream call happens here instead.

## What it does

- `POST /api/models` — builds the provider-specific models request
  (OpenAI-compatible / Anthropic / Gemini), calls the upstream API,
  and returns a normalized `{ models: [...] }` list.
- `POST /api/chat` — builds the provider-specific chat payload (including
  base64 image/vision formatting), calls the upstream API, and:
  - non-streaming → returns `{ text: "..." }`
  - streaming → parses the provider's SSE server-side and streams plain
    text chunks back to the browser.
- `GET /health` — health check (used by Render).

## Deploy to Render

1. Push the `backend/` folder to its own GitHub repository.
2. On Render: **New > Web Service**, connect the repo.
3. Runtime: Node. Build: `npm install`. Start: `npm start`.
   (Or use the included `render.yaml` blueprint.)
4. No environment variables are required. Render injects `PORT`.

## Local development

```
npm install
npm start          # http://localhost:5000
```

## Security & environment variables

| Variable | Purpose |
| --- | --- |
| `APP_SECRET_TOKEN` | Shared secret; API calls must send it as the `x-app-token` header. **Set this in production** — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Same value goes into the frontend's `NEXT_PUBLIC_APP_TOKEN`. |
| `ALLOWED_ORIGIN` | Comma-separated CORS allowlist of frontend origins (e.g. `https://your-app.vercel.app`). Unset = reflect any origin (dev only). |
| `RATE_LIMIT_PER_MIN` | Per-IP request limit per minute (default `60`). |
| `BLOCK_PRIVATE_HOSTS` | `true` blocks SSRF targets (localhost/private IPs). Leave unset to keep Ollama support. |
| `UPSTREAM_TIMEOUT_MS` | Upstream call timeout (default `120000`). |

| `UPSTREAM_TIMEOUT_MS` | Upstream call timeout (default `300000`). |
| `HEARTBEAT_INTERVAL_MS` | SSE keep-alive comment interval during model silence (default `15000`). Prevents load-balancer/proxy idle timeouts (504s on Render). |

Other protections included: `helmet` security headers, strict input validation
(provider allowlist, URL scheme check, size caps, model-name charset), request
body limits, and upstream timeouts.

## Streaming transport (504 prevention)

`/api/chat` always responds with `Content-Type: text/event-stream`:

- responds **immediately** (200 + first keep-alive), never leaving the proxy idle
- emits `: ka` comment frames every 15s during any silence (model "thinking
  time"), which proxies ignore but which keep the connection alive on Render
- streamed deltas: `data: {"t":"..."}`
- non-streaming clients still get a single final event:
  `data: {"text":"...","usage":{...}}` — with heartbeats covering the wait
- terminal event: `data: {"done":true}`; upstream failures after headers:
  `data: {"error":"..."}`

Test it locally:

```
node scripts/mock-provider.js                                  # fake slow provider
APP_SECRET_TOKEN=test-secret-123 node server.js                # backend on :5000
node scripts/smoke-relay.js                                    # runs both tests
```

## Notes

- CORS is controlled via `ALLOWED_ORIGIN` — no secrets are stored server-side;
  the user's API key is relayed per request and never logged.
- Upstream errors are forwarded with their original status codes so the
  frontend can show exactly what the provider returned.
