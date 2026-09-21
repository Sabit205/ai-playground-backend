/* ==========================================================================
   OmniAI Backend — hardened for production
   - helmet security headers
   - strict CORS (ALLOWED_ORIGIN env, comma-separated allowlist)
   - shared-secret auth (x-app-token === APP_SECRET_TOKEN) — doubles as the
     CSRF defense: custom headers can't be sent by cross-site form posts
   - per-IP rate limiting (in-memory sliding window)
   - strict input validation (provider allowlist, URL scheme, size caps)
   - optional SSRF guard (BLOCK_PRIVATE_HOSTS=true disallows internal targets)
   - upstream call timeouts
   ========================================================================== */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false, // API only; CSP is enforced by the frontend
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// --- CORS: allowlist via env. No ALLOWED_ORIGIN set => reflect any origin
// (dev mode). In production set e.g. ALLOWED_ORIGIN=https://your-app.vercel.app
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    return cb(null, false); // no CORS headers => browser blocks the response
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-app-token'],
  maxAge: 86400,
}));

app.use(express.json({ limit: '25mb' })); // base64 image payloads can be large

// --- Shared-secret auth ---
const APP_TOKEN = process.env.APP_SECRET_TOKEN || '';

function requireAppToken(req, res, next) {
  if (!APP_TOKEN) return next(); // not configured (dev); set it in production!
  if (req.get('x-app-token') === APP_TOKEN) return next();
  return res.status(401).json({ error: 'Unauthorized: missing or invalid x-app-token' });
}

// --- Per-IP rate limiting (sliding 60s window, in-memory) ---
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MIN || '60', 10);
const hits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
}, 60_000).unref();

function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || rec.reset < now) {
    hits.set(ip, { count: 1, reset: now + 60_000 });
    return next();
  }
  rec.count += 1;
  if (rec.count > RATE_LIMIT) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again shortly.' });
  }
  return next();
}

const PORT = process.env.PORT || 5000;
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '120000', 10);
const BLOCK_PRIVATE_HOSTS = process.env.BLOCK_PRIVATE_HOSTS === 'true';

// ---------------------------------------------------------------------------
// Validation & helpers
// ---------------------------------------------------------------------------

const PROVIDER_TYPES = new Set(['openai', 'anthropic', 'gemini']);

function stripTrailingSlash(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

function isPrivateHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname === '::1' || hostname === '[::1]' || hostname === '0.0.0.0'
  );
}

/** Validate the /api/chat body. Returns { ok, value, error }. */
function validateChatBody(body = {}) {
  const providerType = PROVIDER_TYPES.has(body.providerType) ? body.providerType : null;
  if (!providerType) return { error: 'providerType must be one of: openai, anthropic, gemini' };

  const baseUrl = stripTrailingSlash(String(body.baseUrl || ''));
  if (!/^https?:\/\//i.test(baseUrl)) return { error: 'baseUrl must be an http(s) URL' };
  if (baseUrl.length > 2048) return { error: 'baseUrl too long' };

  let host = '';
  try { host = new URL(baseUrl).hostname; } catch { return { error: 'baseUrl is not a valid URL' }; }
  if (BLOCK_PRIVATE_HOSTS && isPrivateHost(host)) {
    return { error: 'Requests to private/internal hosts are blocked (BLOCK_PRIVATE_HOSTS=true)' };
  }

  const model = String(body.model || '').trim();
  if (!model || model.length > 200 || !/^[\w.:/-]+$/.test(model)) {
    return { error: 'invalid model name' };
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0 || messages.length > 200) return { error: 'messages must be a 1..200 array' };
  for (const m of messages) {
    if (!m || !['user', 'assistant', 'system'].includes(m.role)) return { error: 'invalid message role' };
    if (typeof m.content !== 'string' || m.content.length > 100_000) return { error: 'message content too long' };
    if (m.image && typeof m.image === 'string' && m.image.length > 15_000_000) return { error: 'image too large' };
  }

  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.slice(0, 500) : '';
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.slice(0, 50_000) : '';
  const temperature = Math.min(Math.max(Number.isFinite(+body.temperature) ? +body.temperature : 0.7, 0), 2);
  const maxTokens = Math.min(Math.max(parseInt(body.maxTokens, 10) || 2048, 1), 32768);
  const stream = !!body.stream;

  return { value: { providerType, baseUrl, apiKey, model, messages, systemPrompt, temperature, maxTokens, stream } };
}

function validateModelsBody(body = {}) {
  const providerType = PROVIDER_TYPES.has(body.providerType) ? body.providerType : null;
  if (!providerType) return { error: 'providerType must be one of: openai, anthropic, gemini' };
  const baseUrl = stripTrailingSlash(String(body.baseUrl || ''));
  if (!/^https?:\/\//i.test(baseUrl)) return { error: 'baseUrl must be an http(s) URL' };
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch { return { error: 'baseUrl is not a valid URL' }; }
  if (BLOCK_PRIVATE_HOSTS && isPrivateHost(host)) {
    return { error: 'Requests to private/internal hosts are blocked (BLOCK_PRIVATE_HOSTS=true)' };
  }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.slice(0, 500) : '';
  return { value: { providerType, baseUrl, apiKey } };
}

// ---------------------------------------------------------------------------
// Provider request builders
// ---------------------------------------------------------------------------

function buildHeaders(providerType, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (providerType === 'anthropic') {
    if (apiKey) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
  } else if (providerType === 'gemini') {
    // Gemini authenticates via ?key= in the query string
  } else if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

function buildModelsRequest({ providerType, baseUrl, apiKey }) {
  const base = stripTrailingSlash(baseUrl);
  if (providerType === 'gemini') {
    return { url: `${base}/models?key=${encodeURIComponent(apiKey)}`, headers: buildHeaders(providerType, apiKey) };
  }
  return { url: `${base}/models`, headers: buildHeaders(providerType, apiKey) };
}

function normalizeModels(providerType, data) {
  if (Array.isArray(data.data)) return data.data.map((m) => m.id).filter(Boolean);
  if (Array.isArray(data.models)) {
    return data.models.map((m) => (m.name || '').replace(/^models\//, '')).filter(Boolean);
  }
  return [];
}

/** messages: [{ role, content, image?, imageType? }] (image = data URL) */
function buildChatRequest({ providerType, baseUrl, apiKey, model, messages, systemPrompt, temperature, maxTokens, stream }) {
  const base = stripTrailingSlash(baseUrl);
  const headers = buildHeaders(providerType, apiKey);
  let url; let body;

  if (providerType === 'anthropic') {
    url = `${base}/messages`;
    const formatted = messages.map((msg) => {
      if (msg.role === 'user' && msg.image) {
        return {
          role: 'user',
          content: [
            { type: 'text', text: msg.content || '' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: msg.imageType || 'image/jpeg',
                data: (msg.image || '').split(',')[1] || '',
              },
            },
          ],
        };
      }
      return { role: msg.role, content: msg.content || '' };
    });
    body = { model, messages: formatted, max_tokens: maxTokens, temperature, stream };
    if (systemPrompt) body.system = systemPrompt;
  } else if (providerType === 'gemini') {
    const action = stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?';
    url = `${base}/models/${encodeURIComponent(model)}:${action}key=${encodeURIComponent(apiKey)}`;
    const contents = messages.map((msg) => {
      const parts = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.image) {
        parts.push({
          inline_data: {
            mime_type: msg.imageType || 'image/jpeg',
            data: (msg.image || '').split(',')[1] || '',
          },
        });
      }
      return { role: msg.role === 'assistant' ? 'model' : 'user', parts };
    });
    body = { contents, generationConfig: { temperature, maxOutputTokens: maxTokens } };
    if (systemPrompt) body.system_instruction = { parts: [{ text: systemPrompt }] };
  } else {
    url = `${base}/chat/completions`;
    const formatted = [];
    if (systemPrompt) formatted.push({ role: 'system', content: systemPrompt });
    messages.forEach((msg) => {
      if (msg.role === 'user' && msg.image) {
        formatted.push({
          role: 'user',
          content: [
            { type: 'text', text: msg.content || '' },
            { type: 'image_url', image_url: { url: msg.image } },
          ],
        });
      } else {
        formatted.push({ role: msg.role, content: msg.content || '' });
      }
    });
    body = { model, messages: formatted, temperature, max_tokens: maxTokens, stream };
  }

  return { url, headers, body };
}

function extractText(providerType, data) {
  if (providerType === 'anthropic') return data.content?.[0]?.text || '';
  if (providerType === 'gemini') {
    return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  }
  return data.choices?.[0]?.message?.content || '';
}

function extractUsage(providerType, data) {
  if (providerType === 'anthropic' && data.usage) {
    return { input: data.usage.input_tokens, output: data.usage.output_tokens };
  }
  if (providerType === 'gemini' && data.usageMetadata) {
    return { input: data.usageMetadata.promptTokenCount, output: data.usageMetadata.candidatesTokenCount };
  }
  if (providerType === 'openai' && data.usage) {
    return { input: data.usage.prompt_tokens, output: data.usage.completion_tokens };
  }
  return null;
}

function extractDelta(providerType, parsed) {
  if (providerType === 'openai') return parsed.choices?.[0]?.delta?.content || '';
  if (providerType === 'anthropic') {
    return parsed.type === 'content_block_delta' ? parsed.delta?.text || '' : '';
  }
  if (providerType === 'gemini') {
    return parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check: public, unthrottled (used by Render)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Everything under /api: rate limited + token protected
app.use('/api', rateLimit, requireAppToken);

// Model discovery — backend calls the provider and normalizes the list
app.post('/api/models', async (req, res) => {
  const check = validateModelsBody(req.body);
  if (check.error) return res.status(400).json({ error: check.error });
  const { providerType, baseUrl, apiKey } = check.value;

  try {
    const { url, headers } = buildModelsRequest({ providerType, baseUrl, apiKey });
    const upstream = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return res.status(upstream.status).type('application/json').send(text.slice(0, 4000));
    }
    const data = JSON.parse(text);
    return res.json({ models: normalizeModels(providerType, data).sort() });
  } catch (err) {
    if (err.name === 'TimeoutError') return res.status(504).json({ error: 'Upstream request timed out' });
    console.error('models error:', err.message);
    return res.status(502).json({ error: 'Upstream request failed' });
  }
});

// Chat — backend builds the payload, calls the provider, streams text back.
// Response body is a plain text stream (streaming) or { text, usage } JSON.
app.post('/api/chat', async (req, res) => {
  const check = validateChatBody(req.body);
  if (check.error) return res.status(400).json({ error: check.error });
  const cfg = check.value;

  const { url, headers, body } = buildChatRequest(cfg);

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return res.status(upstream.status).type('application/json').send(errText.slice(0, 8000));
    }

    // --- Non-streaming: return complete text + real token usage ---
    if (!cfg.stream) {
      const data = await upstream.json();
      return res.json({ text: extractText(cfg.providerType, data), usage: extractUsage(cfg.providerType, data) });
    }

    // --- Streaming: parse upstream SSE server-side, forward plain text ---
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let closed = false;
    req.on('close', () => { closed = true; });

    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6).trim();
        if (dataStr === '[DONE]') continue;
        try {
          const delta = extractDelta(cfg.providerType, JSON.parse(dataStr));
          if (delta) res.write(delta);
        } catch (e) { /* non-JSON SSE line */ }
      }
    }

    res.end();
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Upstream request timed out' });
    }
    if (err.name === 'AbortError') { try { res.end(); } catch (e) { /* noop */ } return; }
    console.error('chat error:', err.message);
    if (!res.headersSent) return res.status(502).json({ error: 'Upstream request failed' });
    try { res.end(); } catch (e) { /* noop */ }
  }
});

app.listen(PORT, () => {
  console.log(`OmniAI backend listening on port ${PORT}`);
  console.log(`Auth token: ${APP_TOKEN ? 'enabled' : 'DISABLED (set APP_SECRET_TOKEN for production)'}`);
  console.log(`CORS origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : 'any (set ALLOWED_ORIGIN for production)'}`);
  console.log(`Rate limit: ${RATE_LIMIT} req/min per IP`);
});
