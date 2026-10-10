const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/agent-test.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../public/agent-connection.js'), 'utf8');
const storageKey = 'tutupbuku.agentTest.v1';

function status(extra = {}) {
  return { data: { configured: true, activeJob: null, message: 'Ready', instanceId: 'instance-1', ...extra } };
}

function job(statusValue = 'running', extra = {}) {
  return {
    data: {
      job: {
        id: 'job-1', status: statusValue,
        createdAt: '2026-10-11T12:00:00Z', updatedAt: '2026-10-11T12:00:10Z',
        answer: statusValue === 'completed' ? 'AWS_BUDDY_OK' : null,
        error: null, gatewayRunId: 'gateway-1', ...extra,
      },
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Drive the shipped script with actual page IDs and an observable HTTP boundary.
// No browser package, model credentials or network access is required.
function createPage(responses, saved = null) {
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/gu)) {
    const tag = match[0];
    const listeners = new Map();
    const attributes = new Map();
    const classes = new Set();
    const element = {
      hidden: /\bhidden(?:\s|>)/u.test(tag),
      disabled: /\bdisabled(?:\s|>)/u.test(tag),
      textContent: '', className: '',
      classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name); },
      addEventListener(name, listener) { listeners.set(name, listener); },
      async click() {
        if (!this.disabled) await listeners.get('click')?.();
      },
    };
    Object.defineProperty(element, 'innerHTML', {
      set() { throw new Error('Untrusted response text must not be inserted as HTML.'); },
    });
    elements.set(match[1], element);
  }
  const storage = new Map(saved ? [[storageKey, JSON.stringify(saved)]] : []);
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  let nextKey = 0;
  const context = {
    document: { getElementById: (id) => elements.get(id) },
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    window: { addEventListener() {} },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++nextKey).padStart(12, '0')}` },
    AbortController, Intl, Date, JSON, Set, Map, Object, String, Boolean, Number, Error,
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    async fetch(url, options) {
      calls.push({ url, options });
      const next = responses.shift();
      if (!next) throw new Error(`Unexpected request ${url}`);
      if (next instanceof Error) throw next;
      const reply = await (typeof next === 'function' ? next(url, options) : next);
      const code = reply.status ?? 200;
      return { ok: code >= 200 && code < 300, status: code, json: async () => reply.data };
    },
  };
  vm.runInNewContext(script, context, { filename: 'agent-connection.js' });
  return {
    calls, storage,
    get: (id) => elements.get(id),
    posts: () => calls.filter(({ options }) => options.method === 'POST'),
    async flush() {
      for (let i = 0; i < 6; i += 1) await new Promise(setImmediate);
    },
    async click(id) { await elements.get(id).click(); },
    async poll() {
      const earliest = [...timers.entries()].sort((a, b) => a[1].delay - b[1].delay)[0];
      assert.ok(earliest, 'an active job should schedule a status refresh');
      timers.delete(earliest[0]);
      await earliest[1].callback();
    },
  };
}

test('agent test page loads configuration without issuing an AI request', async () => {
  const page = createPage([status()]);
  await page.flush();
  assert.deepEqual(page.calls.map(({ url }) => url), ['/api/demo/status']);
  assert.equal(page.posts().length, 0);
  assert.equal(page.get('runTest').disabled, false);
  assert.equal(page.get('jobBadge').textContent, 'Ready');
  assert.match(html, /aria-live="polite"/u);
});

test('the button displays actual queued, running and completed states and the final reply', async () => {
  const page = createPage([status(), job('queued'), job('running'), job('completed')]);
  await page.flush();
  await page.click('runTest');
  assert.equal(page.get('jobBadge').textContent, 'Queued');
  assert.equal(page.get('runTest').disabled, true);
  await page.poll();
  assert.equal(page.get('jobBadge').textContent, 'Running');
  await page.poll();
  assert.equal(page.get('jobBadge').textContent, 'Completed');
  assert.equal(page.get('answer').textContent, 'AWS_BUDDY_OK');
  assert.equal(page.get('resultPanel').hidden, false);
  assert.match(page.get('resultNote').textContent, /expected reply was received/u);
  assert.equal(page.get('runTest').disabled, false);
  assert.equal(page.posts().length, 1);
  assert.equal(page.posts()[0].options.body, '{}');
  assert.equal(page.posts()[0].options.headers['X-TutupBuku-Request'], '1');
  assert.equal(page.posts()[0].options.credentials, 'same-origin');
});

test('response text is rendered as text even when it resembles HTML', async () => {
  const text = '<img src=x onerror=alert(1)>';
  const page = createPage([status(), job('completed', { answer: text })]);
  await page.flush();
  await page.click('runTest');
  assert.equal(page.get('answer').textContent, text);
  assert.match(page.get('resultNote').textContent, /did not exactly match/u);
});

test('a second click while submission is pending cannot dispatch another credit-consuming request', async () => {
  const acceptance = deferred();
  const page = createPage([status(), () => acceptance.promise]);
  await page.flush();
  const pending = page.click('runTest');
  assert.equal(page.get('runTest').disabled, true);
  assert.equal(page.get('runTest').getAttribute('aria-busy'), 'true');
  await page.click('runTest');
  assert.equal(page.posts().length, 1);
  acceptance.resolve(job('queued'));
  await pending;
  assert.equal(page.get('runTest').getAttribute('aria-busy'), 'false');
  assert.equal(page.get('runTest').disabled, true);
});

test('a failed job shows its error and only a manual new test creates a fresh request', async () => {
  const page = createPage([
    status(), job('failed', { error: 'The private agent could not be reached.' }),
    job('completed', { id: 'job-2' }),
  ]);
  await page.flush();
  await page.click('runTest');
  assert.equal(page.get('jobBadge').textContent, 'Failed');
  assert.equal(page.get('notice').textContent, 'The private agent could not be reached.');
  assert.equal(page.get('resultPanel').hidden, true);
  assert.equal(page.get('runTest').disabled, false);
  assert.equal(page.posts().length, 1);
  await page.click('runTest');
  assert.equal(page.posts().length, 2);
  assert.notEqual(page.posts()[0].options.headers['Idempotency-Key'], page.posts()[1].options.headers['Idempotency-Key']);
  assert.equal(page.get('jobBadge').textContent, 'Completed');
});

test('a known job polling failure keeps new tests locked and recovers with read-only refresh', async () => {
  const page = createPage([status(), new Error('offline'), status(), job('completed')], {
    jobId: 'job-1', instanceId: 'instance-1',
  });
  await page.flush();
  assert.equal(page.get('runTest').disabled, true);
  assert.equal(page.get('refreshStatus').hidden, false);
  assert.match(page.get('statusText').textContent, /may still be working/u);
  await page.click('runTest');
  assert.equal(page.posts().length, 0);
  await page.click('refreshStatus');
  assert.equal(page.get('answer').textContent, 'AWS_BUDDY_OK');
  assert.equal(page.posts().length, 0);
});

test('unknown POST completion blocks new tests and explicit retry uses the original request key', async () => {
  const page = createPage([status(), new Error('response lost'), status(), status(), job('completed')]);
  await page.flush();
  await page.click('runTest');
  assert.equal(page.get('jobBadge').textContent, 'Status unknown');
  assert.equal(page.get('runTest').disabled, true);
  assert.equal(page.get('retryRequest').hidden, false);
  await page.click('refreshStatus');
  assert.equal(page.posts().length, 1, 'Refresh status must not issue another AI request');
  await page.click('retryRequest');
  assert.equal(page.posts().length, 2);
  assert.equal(page.posts()[0].options.headers['Idempotency-Key'], page.posts()[1].options.headers['Idempotency-Key']);
  assert.equal(page.get('answer').textContent, 'AWS_BUDDY_OK');
});

test('a 404 for the stored job explains lost state without an automatic AI retry', async () => {
  const page = createPage([status(), { status: 404, data: { error: 'Job not found.' } }], {
    jobId: 'job-1', instanceId: 'instance-1',
  });
  await page.flush();
  assert.equal(page.storage.has(storageKey), false);
  assert.equal(page.posts().length, 0);
  assert.match(page.get('statusText').textContent, /no longer available/u);
  assert.match(page.get('notice').textContent, /No new AI request was sent/u);
});

test('page reload after a backend restart discards an uncertain request without retrying AI', async () => {
  const page = createPage([status({ instanceId: 'instance-2' })], {
    pendingKey: 'uncertain-request-001', instanceId: 'instance-1',
  });
  await page.flush();
  assert.equal(page.posts().length, 0);
  assert.equal(page.get('retryRequest').hidden, true);
  assert.match(page.get('statusText').textContent, /backend restarted/u);
  assert.match(page.get('notice').textContent, /No AI request was retried/u);
});

test('explicit retry rechecks the backend and cannot reuse a request lost during restart', async () => {
  const page = createPage([status(), new Error('response lost'), status({ instanceId: 'instance-2' })]);
  await page.flush();
  await page.click('runTest');
  await page.click('retryRequest');
  assert.equal(page.posts().length, 1);
  assert.equal(page.get('retryRequest').hidden, true);
  assert.match(page.get('statusText').textContent, /backend restarted/u);
});

test('an active-job conflict requires status recovery before another test can run', async () => {
  const page = createPage([
    status(), { status: 409, data: { error: 'A test is already running.', code: 'TEST_BUSY' } },
    status({ activeJob: { id: 'job-other', status: 'running' } }), job('completed', { id: 'job-other' }),
  ]);
  await page.flush();
  await page.click('runTest');
  assert.equal(page.get('runTest').disabled, true);
  await page.click('refreshStatus');
  assert.equal(page.get('answer').textContent, 'AWS_BUDDY_OK');
  assert.equal(page.get('jobId').textContent, 'job-other');
  assert.equal(page.posts().length, 1);
});

test('configuration failure is distinct from failure of an AI job and supports read-only retry', async () => {
  const page = createPage([status({ configured: false, message: 'Configure the private agent connection.' }), status()]);
  await page.flush();
  assert.equal(page.get('jobBadge').textContent, 'Needs setup');
  assert.equal(page.get('runTest').disabled, true);
  assert.equal(page.get('refreshStatus').hidden, false);
  await page.click('refreshStatus');
  assert.equal(page.get('runTest').disabled, false);
  assert.equal(page.posts().length, 0);
});

test('a stale poll response cannot replace a newer completed result', async () => {
  const stale = deferred();
  const page = createPage([status(), job('running'), () => stale.promise, status(), job('completed')]);
  await page.flush();
  await page.click('runTest');
  const oldPoll = page.poll();
  await page.click('refreshStatus');
  assert.equal(page.get('jobBadge').textContent, 'Completed');
  stale.resolve(job('running'));
  await oldPoll;
  assert.equal(page.get('jobBadge').textContent, 'Completed');
  assert.equal(page.get('answer').textContent, 'AWS_BUDDY_OK');
  assert.equal(page.get('runTest').disabled, false);
});
