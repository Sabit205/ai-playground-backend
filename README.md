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

## Notes

- CORS is open (`*`) because the frontend is a public testing tool and the
  user supplies their own API keys per request; nothing is stored server-side.
- Upstream errors are forwarded with their original status codes so the
  frontend can show exactly what the provider returned.
