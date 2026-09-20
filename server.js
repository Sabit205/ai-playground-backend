/* ==========================================================================
   OmniAI Backend — all heavy lifting happens here.
   - Builds provider-specific payloads (OpenAI / Anthropic / Gemini)
   - Calls upstream provider APIs server-side
   - Parses upstream SSE and streams plain text chunks to the frontend
   ========================================================================== */

const express = require('express');
const cors = require('cors');

const app = express();

app.set('trust proxy', 1); // behind Render's proxy
app.use(cors({ origin: '*' })); // UI lives on Vercel; no secrets stored server-side
app.use(express.json({ limit: '25mb' })); // base64 image payloads can be large

const PORT = process.env.PORT || 5000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripTrailingSlash(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

function buildHeaders(providerType, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (providerType === 'anthropic') {
    if (apiKey) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
  } else if (providerType === 'gemini') {
    // Gemini authenticates via ?key= in the query string
  } else {
    // openai-compatible
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
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

/**
 * Build the upstream chat request for a provider.
 * messages: [{ role, content, image?, imageType? }] (image = data URL)
 */
function buildChatRequest({ providerType, baseUrl, apiKey, model, messages, systemPrompt, temperature, maxTokens, stream }) {
  const base = stripTrailingSlash(baseUrl);
  let url;
  const headers = buildHeaders(providerType, apiKey);
  let body;

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
    url = `${base}/models/${model}:${action}key=${encodeURIComponent(apiKey)}`;
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
    // OpenAI-compatible
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

// ---------------------------------------------------------------------------
// Response extraction
// ---------------------------------------------------------------------------

/** Extract text from a non-streaming provider response. */
function extractText(providerType, data) {
  if (providerType === 'anthropic') return data.content?.[0]?.text || '';
  if (providerType === 'gemini') {
    return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  }
  return data.choices?.[0]?.message?.content || '';
}

/** Extract text delta from one upstream SSE event. */
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Model discovery — backend calls the provider and normalizes the list
app.post('/api/models', async (req, res) => {
  const { providerType = 'openai', baseUrl, apiKey = '' } = req.body || {};
  if (!baseUrl) return res.status(400).json({ error: 'baseUrl is required' });

  try {
    const { url, headers } = buildModelsRequest({ providerType, baseUrl, apiKey });
    const upstream = await fetch(url, { method: 'GET', headers });
    const text = await upstream.text();
    if (!upstream.ok) {
      return res.status(upstream.status).type('application/json').send(text);
    }
    const data = JSON.parse(text);
    return res.json({ models: normalizeModels(providerType, data).sort() });
  } catch (err) {
    console.error('models error:', err.message);
    return res.status(502).json({ error: err.message || 'Upstream request failed' });
  }
});

// Chat — backend builds the payload, calls the provider, streams text back.
// The response body is a plain text stream (not SSE), so the frontend stays dumb.
app.post('/api/chat', async (req, res) => {
  const {
    providerType = 'openai', baseUrl, apiKey = '', model,
    messages = [], systemPrompt = '',
    temperature = 0.7, maxTokens = 2048, stream = false,
  } = req.body || {};

  if (!baseUrl || !model) {
    return res.status(400).json({ error: 'baseUrl and model are required' });
  }

  const { url, headers, body } = buildChatRequest({
    providerType, baseUrl, apiKey, model, messages, systemPrompt, temperature, maxTokens, stream,
  });

  try {
    const upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return res.status(upstream.status).type('application/json').send(errText);
    }

    // --- Non-streaming: return complete text as JSON ---
    if (!stream) {
      const data = await upstream.json();
      return res.json({ text: extractText(providerType, data) });
    }

    // --- Streaming: parse upstream SSE server-side, forward plain text chunks ---
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
          const parsed = JSON.parse(dataStr);
          const delta = extractDelta(providerType, parsed);
          if (delta) res.write(delta);
        } catch (e) {
          // Ignore non-JSON SSE lines
        }
      }
    }

    res.end();
  } catch (err) {
    console.error('chat error:', err.message);
    if (!res.headersSent) {
      return res.status(502).json({ error: err.message || 'Upstream request failed' });
    }
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`OmniAI backend listening on port ${PORT}`);
});
