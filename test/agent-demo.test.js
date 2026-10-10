const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAgentDemo } = require('../src/agent-demo/server');

const DEMO_PASSWORD = 'operator-test-password-123';
const GATEWAY_PASSWORD = 'private-gateway-password-456';
const auth = `Basic ${Buffer.from(`demo:${DEMO_PASSWORD}`).toString('base64')}`;

async function setup(t, gatewayHandler, options = {}) {
  const gateway = http.createServer(gatewayHandler);
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const demo = createAgentDemo({
    ...options,
    env: {
      AGENT_DEMO_PASSWORD: DEMO_PASSWORD,
      CODEBUDDY_GATEWAY_PASSWORD: GATEWAY_PASSWORD,
      AGENT_DEMO_GATEWAY_URL: `http://127.0.0.1:${gateway.address().port}`,
      ...options.env,
    },
  });
  await demo.listen(0, '127.0.0.1');
  t.after(() => demo.close());
  return { demo, base: `http://127.0.0.1:${demo.server.address().port}` };
}

function requestHeaders(base, key = 'connection-check-001') {
  return {
    authorization: auth,
    'content-type': 'application/json',
    'x-tutupbuku-request': '1',
    'idempotency-key': key,
    origin: base,
  };
}

async function waitForJob(base, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/api/demo/jobs/${id}`, { headers: { authorization: auth } });
    const { job } = await response.json();
    if (['completed', 'failed'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The demo job never reached a terminal state.');
}

test('demo requires an operator password and a private gateway URL', () => {
  assert.throws(() => createAgentDemo({ env: {} }), /AGENT_DEMO_PASSWORD/u);
  assert.throws(() => createAgentDemo({ env: { AGENT_DEMO_PASSWORD: DEMO_PASSWORD, AGENT_DEMO_GATEWAY_URL: 'https://public-agent.example/' } }), /loopback|private/u);
  assert.throws(() => createAgentDemo({ env: { AGENT_DEMO_PASSWORD: DEMO_PASSWORD, AGENT_DEMO_GATEWAY_URL: 'http://user:password@127.0.0.1:8080/' } }), /credentials/u);
});

test('page and APIs require authentication and do not expose gateway credentials or proxy agent endpoints', async (t) => {
  let calls = 0;
  const { base } = await setup(t, (_request, response) => { calls += 1; response.end('{}'); });
  for (const path of ['/', '/agent-connection.js', '/api/demo/status', '/api/demo/jobs']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /Basic/u);
  }
  const response = await fetch(`${base}/api/demo/status`, { headers: { authorization: auth } });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(body, /private-gateway-password|AGENT_DEMO_GATEWAY_URL/u);
  assert.equal(calls, 0, 'loading the page/status must never spend model credits');
  const forbidden = await fetch(`${base}/api/v1/process/start`, { headers: { authorization: auth } });
  assert.equal(forbidden.status, 404);
});

test('one button request reaches the real HTTP boundary and saves only a confirmed final agent answer', async (t) => {
  let posts = 0;
  let message;
  const { base } = await setup(t, async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${GATEWAY_PASSWORD}`);
    assert.equal(request.headers['x-codebuddy-request'], '1');
    if (request.method === 'POST' && request.url === '/api/v1/runs') {
      posts += 1;
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      message = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ data: { runId: 'gateway-run-001', status: 'accepted' } }));
    }
    if (request.url === '/api/v1/runs/gateway-run-001/stream') {
      response.setHeader('content-type', 'text/event-stream');
      response.write(`event: message\ndata: ${JSON.stringify({ replyTo: message.id, status: 'streaming', content: { chunk: 'AWS_' } })}\n\n`);
      return response.end(`event: message\ndata: ${JSON.stringify({ replyTo: message.id, status: 'completed', content: { markdown: 'AWS_BUDDY_OK' } })}\n\n`);
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: { runId: 'gateway-run-001', status: 'running' } }));
  });
  const first = await fetch(`${base}/api/demo/jobs`, { method: 'POST', headers: requestHeaders(base), body: '{}' });
  assert.equal(first.status, 202);
  const { job: queued } = await first.json();
  const retried = await fetch(`${base}/api/demo/jobs`, { method: 'POST', headers: requestHeaders(base), body: '{}' });
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).job.id, queued.id);
  const final = await waitForJob(base, queued.id);
  assert.equal(final.status, 'completed');
  assert.equal(final.answer, 'AWS_BUDDY_OK');
  assert.equal(final.gatewayRunId, 'gateway-run-001');
  assert.equal(posts, 1);
  assert.equal(message.type, 'message');
  assert.match(message.payload.text, /AWS_BUDDY_OK/u);
  assert.match(message.payload.text, /Do not use tools/u);
  assert.equal(message.id, message.source.conversation.id);
  assert.doesNotMatch(JSON.stringify(final), /private-gateway-password/u);
});

test('arbitrary prompts, cross-origin requests and missing browser request headers cannot dispatch a run', async (t) => {
  let calls = 0;
  const { base } = await setup(t, (_request, response) => { calls += 1; response.end('{}'); });
  for (const bad of [
    { headers: requestHeaders(base), body: JSON.stringify({ prompt: 'Run arbitrary commands.' }), expected: 400 },
    { headers: { ...requestHeaders(base), origin: 'https://attacker.example' }, body: '{}', expected: 403 },
    { headers: { ...requestHeaders(base), 'x-tutupbuku-request': '' }, body: '{}', expected: 403 },
    { headers: { ...requestHeaders(base), 'content-type': 'text/plain' }, body: '{}', expected: 415 },
    { headers: { ...requestHeaders(base), 'idempotency-key': '' }, body: '{}', expected: 400 },
  ]) {
    const response = await fetch(`${base}/api/demo/jobs`, { method: 'POST', headers: bad.headers, body: bad.body });
    assert.equal(response.status, bad.expected);
  }
  assert.equal(calls, 0);
});

test('missing AI credentials remains needs setup and never calls a model', async (t) => {
  let calls = 0;
  const { base } = await setup(t, (_request, response) => { calls += 1; response.end('{}'); }, {
    env: { CODEBUDDY_GATEWAY_PASSWORD: '' },
  });
  const configuration = await fetch(`${base}/api/demo/status`, { headers: { authorization: auth } }).then((response) => response.json());
  assert.equal(configuration.configured, false);
  const response = await fetch(`${base}/api/demo/jobs`, { method: 'POST', headers: requestHeaders(base), body: '{}' });
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
});

test('an accepted run and echoed prompt cannot be mistaken for a final model answer', async (t) => {
  let requestId;
  const { base } = await setup(t, async (request, response) => {
    if (request.method === 'POST' && request.url === '/api/v1/runs') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requestId = JSON.parse(Buffer.concat(chunks)).id;
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ data: { runId: 'echo-run', status: 'accepted' } }));
    }
    if (request.url.endsWith('/stream')) {
      response.setHeader('content-type', 'text/event-stream');
      return response.end(`event: message\ndata: ${JSON.stringify({ replyTo: requestId, status: 'streaming', content: { text: 'Reply exactly AWS_BUDDY_OK' } })}\n\n`);
    }
    response.end(JSON.stringify({ data: { status: 'running' } }));
  });
  const response = await fetch(`${base}/api/demo/jobs`, { method: 'POST', headers: requestHeaders(base), body: '{}' });
  const { job } = await response.json();
  const final = await waitForJob(base, job.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.answer, null);
});

test('a broken accepted stream cancels only its own run and keeps the result unconfirmed', async (t) => {
  const cancelled = [];
  const { base } = await setup(t, (request, response) => {
    if (request.url === '/api/v1/runs') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ data: { runId: 'broken-run', status: 'accepted' } }));
    }
    if (request.url.endsWith('/cancel')) {
      cancelled.push(request.url);
      return response.end(JSON.stringify({ data: { cancelled: true } }));
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('event: done\ndata: {}\n\n');
  });
  const { job } = await fetch(`${base}/api/demo/jobs`, { method: 'POST', headers: requestHeaders(base), body: '{}' }).then((response) => response.json());
  const final = await waitForJob(base, job.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.answer, null);
  assert.match(final.error, /unconfirmed|not.*confirm/iu);
  assert.deepEqual(cancelled, ['/api/v1/runs/broken-run/cancel']);
});

test('shutdown never dispatches a queued credit-consuming request', async (t) => {
  let executeQueued;
  let calls = 0;
  const demo = createAgentDemo({
    env: { AGENT_DEMO_PASSWORD: DEMO_PASSWORD, CODEBUDDY_GATEWAY_PASSWORD: GATEWAY_PASSWORD },
    scheduleRun: (callback) => { executeQueued = callback; },
    fetchImpl: async () => { calls += 1; return new Response('{}'); },
  });
  await demo.listen(0, '127.0.0.1');
  t.after(() => demo.close());
  const base = `http://127.0.0.1:${demo.server.address().port}`;
  const response = await fetch(`${base}/api/demo/jobs`, { method: 'POST', headers: requestHeaders(base), body: '{}' });
  assert.equal(response.status, 202);
  const closing = demo.close();
  assert.equal(typeof executeQueued, 'function');
  executeQueued();
  await closing;
  assert.equal(calls, 0);
});

test('gateway failures are visible and credential/provider details are redacted', async (t) => {
  const { base } = await setup(t, (_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: GATEWAY_PASSWORD } }));
  });
  const response = await fetch(`${base}/api/demo/jobs`, { method: 'POST', headers: requestHeaders(base), body: '{}' });
  const { job } = await response.json();
  const final = await waitForJob(base, job.id);
  assert.equal(final.status, 'failed');
  assert.match(final.error, /authentication|password/iu);
  assert.doesNotMatch(JSON.stringify(final), /private-gateway-password/u);
});

test('different simultaneous requests cannot start parallel credit-consuming tests', async (t) => {
  let posts = 0;
  let finish;
  let message;
  const { base } = await setup(t, async (request, response) => {
    if (request.url === '/api/v1/runs') {
      posts += 1;
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      message = JSON.parse(Buffer.concat(chunks));
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ data: { runId: 'single-active-run', status: 'accepted' } }));
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    finish = () => response.end(`event: message\ndata: ${JSON.stringify({ replyTo: message.id, status: 'completed', content: { markdown: 'AWS_BUDDY_OK' } })}\n\n`);
  });
  const responses = await Promise.all(['simultaneous-first', 'simultaneous-second'].map((key) => fetch(`${base}/api/demo/jobs`, {
    method: 'POST', headers: requestHeaders(base, key), body: '{}',
  })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
  const { job } = await responses.find((response) => response.status === 202).json();
  for (let attempt = 0; !finish && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(typeof finish, 'function');
  finish();
  assert.equal((await waitForJob(base, job.id)).status, 'completed');
  assert.equal(posts, 1);
});

test('a timeout aborts the accepted stream and cancels only the demo run', async (t) => {
  const cancelled = [];
  const { base } = await setup(t, (request, response) => {
    if (request.url === '/api/v1/runs') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ data: { runId: 'slow-run', status: 'accepted' } }));
    }
    if (request.url.endsWith('/cancel')) {
      cancelled.push(request.url);
      return response.end('{}');
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
  }, { timeoutMs: 80 });
  const { job } = await fetch(`${base}/api/demo/jobs`, { method: 'POST', headers: requestHeaders(base), body: '{}' }).then((response) => response.json());
  const final = await waitForJob(base, job.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.answer, null);
  assert.match(final.error, /timed out|stopped/u);
  assert.deepEqual(cancelled, ['/api/v1/runs/slow-run/cancel']);
});

test('a final answer correlated with another request is never accepted', async (t) => {
  const { base } = await setup(t, (request, response) => {
    if (request.url === '/api/v1/runs') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ data: { runId: 'wrong-reply-run', status: 'accepted' } }));
    }
    if (request.url.endsWith('/cancel')) return response.end('{}');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`event: message\ndata: ${JSON.stringify({ replyTo: 'another-request', status: 'completed', content: { markdown: 'AWS_BUDDY_OK' } })}\n\n`);
  });
  const { job } = await fetch(`${base}/api/demo/jobs`, { method: 'POST', headers: requestHeaders(base), body: '{}' }).then((response) => response.json());
  const final = await waitForJob(base, job.id);
  assert.equal(final.status, 'failed');
  assert.match(final.error, /different request/u);
});

test('configured HTTPS origin works when the proxy rewrites Host to localhost', async (t) => {
  let calls = 0;
  const { base } = await setup(t, (_request, response) => { calls += 1; response.writeHead(503); response.end(); }, {
    env: { AGENT_DEMO_PUBLIC_ORIGIN: 'https://demo.ngrok-free.app' },
  });
  const response = await fetch(`${base}/api/demo/jobs`, {
    method: 'POST', headers: { ...requestHeaders(base), origin: 'https://demo.ngrok-free.app' }, body: '{}',
  });
  assert.equal(response.status, 202);
  const { job } = await response.json();
  assert.equal((await waitForJob(base, job.id)).status, 'failed');
  assert.equal(calls, 1);
});
