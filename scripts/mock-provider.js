// Fake OpenAI-compatible provider for local relay testing.
// Reproduces the exact conditions that cause proxy 504s:
//   - slow first token (2s)
//   - long silent gap (default 18s, longer than the backend's 15s heartbeat)
//   - then streamed deltas and [DONE]
// Non-streaming requests stay silent for the same gap, then return JSON+usage.
//
// Usage: node scripts/mock-provider.js        (default port 5055)

const http = require('http');

const PORT = parseInt(process.env.MOCK_PORT || '5055', 10);
const SILENT_GAP_MS = parseInt(process.env.MOCK_GAP_MS || '18000', 10);

function sseChunk(content) {
  return `data: ${JSON.stringify({ id: 'mock', choices: [{ delta: { content } }] })}\n\n`;
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }
    const wantsStream = !!body.stream;

    if (!wantsStream) {
      console.log(`[mock] non-stream request — silent for ${SILENT_GAP_MS}ms`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      setTimeout(() => {
        res.end(JSON.stringify({
          choices: [{ message: { content: 'Full response after a long think.' } }],
          usage: { prompt_tokens: 5, completion_tokens: 7 },
        }));
      }, SILENT_GAP_MS);
      return;
    }

    console.log(`[mock] stream request — 2s TTFB + ${SILENT_GAP_MS}ms silent gap`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': mock connected\n\n');

    setTimeout(() => {
      if (res.writableEnded) return;
      res.write(sseChunk('Hello'));
      setTimeout(() => {
        if (res.writableEnded) return;
        res.write(sseChunk(' world'));
        res.write(sseChunk(' from mock'));
        setTimeout(() => {
          if (res.writableEnded) return;
          res.write('data: [DONE]\n\n');
          res.end();
        }, 1000);
      }, SILENT_GAP_MS);
    }, 2000);
    // NOTE: deliberately no req.on('close') here — Node fires 'close' when
    // the request message completes (body parsed), NOT on client disconnect.
    // Adding it ends the stream immediately.
  });
});

server.listen(PORT, () => {
  console.log(`Mock provider on http://localhost:${PORT}/v1 (silent gap ${SILENT_GAP_MS}ms)`);
});
