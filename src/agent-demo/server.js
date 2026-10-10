const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createCodeBuddyClient } = require('./codebuddy-client');

const SECURITY_HEADERS = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const ASSETS = new Map([
  ['/', ['agent-test.html', 'text/html']], ['/agent-test.html', ['agent-test.html', 'text/html']],
  ['/agent-connection.js', ['agent-connection.js', 'text/javascript']], ['/agent-test.css', ['agent-test.css', 'text/css']],
  ['/styles.css', ['styles.css', 'text/css']],
]);

function send(response, status, body) {
  response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
async function emptyBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 256) throw Object.assign(new Error('Only an empty test request is allowed.'), { status: 413 });
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Object.assign(new Error('Send a JSON object.'), { status: 400 }); }
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) {
    throw Object.assign(new Error('This endpoint accepts only the fixed connection test, without prompts or commands.'), { status: 400 });
  }
}

function createAgentDemo({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs, maxRuns = 20, scheduleRun = setImmediate } = {}) {
  const client = createCodeBuddyClient({ env, fetchImpl, timeoutMs });
  const instanceId = randomUUID();
  const jobs = new Map();
  const keys = new Map();
  const recentRuns = [];
  const activeRequests = new Set();
  let activeJob = null;
  const pending = new Set();
  let closing = false;
  let publicOrigin;
  if (env.AGENT_DEMO_PUBLIC_ORIGIN) {
    const originUrl = new URL(env.AGENT_DEMO_PUBLIC_ORIGIN);
    if (originUrl.protocol !== 'https:' || originUrl.username || originUrl.password || originUrl.pathname !== '/' || originUrl.search || originUrl.hash) {
      throw new Error('AGENT_DEMO_PUBLIC_ORIGIN must be an HTTPS origin without a path or credentials.');
    }
    publicOrigin = originUrl.origin;
  }
  function allowedOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true; // Authenticated CLI callers may omit Origin.
    if (origin === publicOrigin) return true;
    try {
      const parsed = new URL(origin);
      return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin && parsed.host === request.headers.host;
    } catch { return false; }
  }
  function snapshot(job) { return structuredClone(job); }
  function update(job, values) { Object.assign(job, values, { updatedAt: new Date().toISOString() }); }
  async function execute(job) {
    if (closing) {
      update(job, { status: 'failed', error: 'The service stopped before this test was sent. No AI request was started.' });
      if (activeJob === job) activeJob = null;
      return;
    }
    const controller = new AbortController();
    activeRequests.add(controller);
    try {
      update(job, { status: 'running' });
      const result = await client.runTest({
        signal: controller.signal,
        onAccepted: (runId) => update(job, { gatewayRunId: runId }),
      });
      update(job, { status: 'completed', answer: result.answer, gatewayRunId: result.runId });
    } catch (error) {
      update(job, { status: 'failed', error: error.code ? error.message : 'The test could not finish. Check the service on the VM.' });
    } finally {
      activeRequests.delete(controller);
      if (activeJob === job) activeJob = null;
    }
  }
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && ASSETS.has(url.pathname)) {
        const [filename, type] = ASSETS.get(url.pathname);
        const bytes = await fs.readFile(path.join(__dirname, '../../public', filename));
        response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': `${type}; charset=utf-8` });
        return response.end(bytes);
      }
      if (request.method === 'GET' && url.pathname === '/api/demo/status') {
        return send(response, 200, {
          configured: client.configured, instanceId,
          activeJob: activeJob ? snapshot(activeJob) : null,
          message: client.configured ? 'Ready to request a live response from the AWS agent.' : 'The backend gateway password needs setup on the VM.',
        });
      }
      const jobPath = /^\/api\/demo\/jobs\/([a-zA-Z0-9-]{1,128})$/u.exec(url.pathname);
      if (request.method === 'GET' && jobPath) {
        const job = jobs.get(jobPath[1]);
        return job ? send(response, 200, { job: snapshot(job) }) : send(response, 404, { error: 'Test job not found. Its in-memory state may have been cleared by a server restart.' });
      }
      if (request.method === 'POST' && url.pathname === '/api/demo/jobs') {
        if (closing) return send(response, 503, { error: 'The demo service is stopping.' });
        if (request.headers['x-tutupbuku-request'] !== '1' || !allowedOrigin(request)) return send(response, 403, { error: 'Use the test button from this website.' });
        if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] || '')) return send(response, 415, { error: 'Send an application/json test request.' });
        const key = String(request.headers['idempotency-key'] || '');
        if (!/^[\w-]{8,128}$/u.test(key)) return send(response, 400, { error: 'A valid request reference is required.' });
        await emptyBody(request);
        if (keys.has(key)) return send(response, 200, { job: snapshot(jobs.get(keys.get(key))) });
        if (!client.configured) return send(response, 503, { error: 'Configure the backend gateway password first.', code: 'GATEWAY_NOT_CONFIGURED' });
        if (activeJob) return send(response, 409, { error: 'A test is already running. Refresh its status before starting another.', code: 'TEST_BUSY' });
        const now = Date.now();
        while (recentRuns.length && recentRuns[0] < now - 3600000) recentRuns.shift();
        if (recentRuns.length >= maxRuns || jobs.size >= 200) return send(response, 429, { error: 'The demo test limit has been reached. Wait before using more AI credits.', code: 'TEST_LIMIT' });
        recentRuns.push(now);
        const timestamp = new Date(now).toISOString();
        const job = { id: randomUUID(), status: 'queued', createdAt: timestamp, updatedAt: timestamp, gatewayRunId: null, answer: null, error: null };
        jobs.set(job.id, job);
        keys.set(key, job.id);
        activeJob = job;
        const task = new Promise((resolve) => scheduleRun(resolve)).then(() => execute(job));
        pending.add(task);
        task.finally(() => pending.delete(task));
        return send(response, 202, { job: snapshot(job) });
      }
      return send(response, 404, { error: 'Not found.' });
    } catch (error) {
      return send(response, error.status || 500, { error: error.status ? error.message : 'The demo request could not be completed.' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server,
    listen(port = Number(env.AGENT_DEMO_PORT) || 3001, host = env.AGENT_DEMO_HOST || '127.0.0.1') {
      return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); });
    },
    async close() {
      closing = true;
      for (const controller of activeRequests) controller.abort();
      await Promise.allSettled([...pending]);
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (require.main === module) {
  try {
    const demo = createAgentDemo();
    demo.listen().then(() => {
      console.log(`TutupBuku agent test: http://${process.env.AGENT_DEMO_HOST || '127.0.0.1'}:${demo.server.address().port}`);
      console.log('Open the page directly. The CodeBuddy gateway password stays on the backend.');
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => demo.close().then(() => process.exit(0)));
    }).catch((error) => { console.error(`Agent test startup failed: ${error.message}`); process.exitCode = 1; });
  } catch (error) { console.error(`Agent test startup failed: ${error.message}`); process.exitCode = 1; }
}

module.exports = { createAgentDemo };
