// Relay smoke test — verifies the SSE transport end to end:
//   1. streamed text arrives intact through a long silent gap
//   2. keep-alive comments are emitted during the silence
//   3. non-streaming requests get { text, usage } after the same silence
//
// Prerequisites:
//   node scripts/mock-provider.js                 (terminal 1)
//   APP_SECRET_TOKEN=test-secret-123 node server.js   (terminal 2)
//   node scripts/smoke-relay.js                   (terminal 3)

const BASE = process.env.SMOKE_BACKEND_URL || 'http://localhost:5000';
const TOKEN = process.env.APP_SECRET_TOKEN || 'test-secret-123';
const BASE_URL = process.env.SMOKE_UPSTREAM_URL || 'http://localhost:5055/v1';

async function request(stream) {
  return fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-token': TOKEN },
    body: JSON.stringify({
      providerType: 'openai', baseUrl: BASE_URL, apiKey: 'mock', model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }], stream,
    }),
  });
}

async function streamTest() {
  const res = await request(true);
  const ok = res.ok && (res.headers.get('content-type') || '').includes('text/event-stream');
  if (!ok) { console.log('STREAM FAIL: bad status/CT', res.status); return false; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let keepalives = 0;
  let text = '';
  let sawDone = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.trim();
      if (line === ': ka') keepalives += 1;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.t) text += evt.t;
        if (evt.done) sawDone = true;
        if (evt.error) { console.log('STREAM FAIL: error event:', evt.error); return false; }
      } catch (e) { /* ignore */ }
    }
  }

  const pass = text === 'Hello world from mock' && keepalives >= 1 && sawDone;
  console.log(`STREAM: text=${JSON.stringify(text)} keepalives=${keepalives} done=${sawDone} => ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

async function nonStreamTest() {
  const res = await request(false);
  if (!res.ok) { console.log('NONSTREAM FAIL: status', res.status); return false; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let keepalives = 0;
  let text = null;
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.trim();
      if (line === ': ka') keepalives += 1;
      if (!line.startsWith('data:')) continue;
      try {
        const evt = JSON.parse(line.slice(5).trim());
        if (evt.text) { text = evt.text; usage = evt.usage; }
        if (evt.error) { console.log('NONSTREAM FAIL: error event:', evt.error); return false; }
      } catch (e) { /* ignore */ }
    }
  }

  const pass = text === 'Full response after a long think.' && usage?.output === 7 && keepalives >= 1;
  console.log(`NONSTREAM: text=${JSON.stringify(text)} usage=${JSON.stringify(usage)} keepalives=${keepalives} => ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

(async () => {
  const a = await streamTest();
  const b = await nonStreamTest();
  console.log(a && b ? 'ALL RELAY TESTS PASS' : 'RELAY TESTS FAILED');
  process.exit(a && b ? 0 : 1);
})();
