import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const accepted = () => json({ worker_job: { id: JOB_ID, status: 'queued' } }, 202);
const completed = (body, status = 200) => json({ worker_job: {
  id: JOB_ID, status: 'completed', error: null,
  response: { status, headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(body), 'utf8').toString('base64') },
} });
let request;

beforeEach(async () => {
  const module = await import('../src/lib/worker-request.ts').catch(() => null);
  assert.equal(typeof module?.request, 'function', 'The shared worker transport must be implemented.');
  request = module.request;
});

function fastPolling(t) {
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, _delay, ...args) => original(callback, 0, ...args));
}

function fetchSequence(t, responses) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, options });
    const response = responses.shift();
    assert.ok(response, 'No unexpected request may be sent.');
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(url, options) : response;
  });
  return calls;
}

test('submits once, polls only the same-origin job path, and decodes a UTF-8 response', async t => {
  fastPolling(t);
  const calls = fetchSequence(t, [accepted(), json({ worker_job: { id: JOB_ID, status: 'queued' } }), json({ worker_job: { id: JOB_ID, status: 'running' } }), completed({ reply: '已完成 ✓ RM10.00' })]);
  assert.deepEqual(await request('/api/chat', { message: 'review' }), { reply: '已完成 ✓ RM10.00' });
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.match(calls[0].options.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/i);
  assert.equal(calls[0].options.body, '{"message":"review"}');
  assert.equal(calls.length, 4);
  for (const call of calls.slice(1)) {
    assert.equal(call.url, `/api/worker/jobs/${JOB_ID}`);
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.body, undefined);
    assert.equal(call.options.headers?.['Idempotency-Key'], undefined);
  }
});

test('ordinary local 202 run responses are returned without worker polling', async t => {
  const body = { run: { id: 'local-run', status: 'running' } };
  const calls = fetchSequence(t, [json(body, 202)]);
  assert.deepEqual(await request('/api/execution', { goal: 'review' }), body);
  assert.equal(calls.length, 1);
});

test('ordinary GET requests and a falsy POST body retain their JSON values', async t => {
  const calls = fetchSequence(t, [json({ cases: [] }), json({ saved: false })]);
  assert.deepEqual(await request('/api/cases'), { cases: [] });
  assert.deepEqual(await request('/api/records', false), { saved: false });
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.body, 'false');
});

test('each caller invocation gets its own idempotency key', async t => {
  const calls = fetchSequence(t, [json({ ok: true }), json({ ok: true })]);
  await request('/api/chat', { message: 'first' });
  await request('/api/chat', { message: 'second' });
  assert.notEqual(calls[0].options.headers['Idempotency-Key'], calls[1].options.headers['Idempotency-Key']);
});

test('completed jobs preserve the original HTTP status and error message', async t => {
  fastPolling(t);
  const calls = fetchSequence(t, [accepted(), completed({ error: { message: 'Account permission denied.' } }, 403)]);
  await assert.rejects(request('/api/chat', { message: 'review' }), error => {
    assert.equal(error.status, 403);
    assert.equal(error.jobId, JOB_ID);
    assert.equal(error.message, 'Account permission denied.');
    return true;
  });
  assert.equal(calls.length, 2);
});

test('local HTTP errors retain readable messages and status', async t => {
  fetchSequence(t, [json({ error: 'Database is unavailable.' }, 503)]);
  await assert.rejects(request('/api/records'), error => error.status === 503 && error.message === 'Database is unavailable.');
});

test('an unconfirmed job reports its ID and never resubmits or cancels it', async t => {
  fastPolling(t);
  const calls = fetchSequence(t, [accepted(), json({ worker_job: { id: JOB_ID, status: 'unconfirmed', error: 'Worker stopped after acceptance.' } })]);
  await assert.rejects(request('/api/chat', { message: 'review' }), error => {
    assert.equal(error.jobId, JOB_ID);
    assert.match(error.message, /unconfirmed/i);
    assert.match(error.message, /not.*resubmit|before.*retry/i);
    assert.ok(error.message.includes(JOB_ID));
    return true;
  });
  assert.deepEqual(calls.map(call => call.options.method), ['POST', 'GET']);
});

test('invalid and remote job IDs cannot become polling URLs', async t => {
  for (const id of ['../escape', 'https://elsewhere.invalid/job', `${JOB_ID}/extra`, `${JOB_ID}?other=1`]) {
    const calls = fetchSequence(t, [json({ worker_job: { id, status: 'queued' } }, 202)]);
    await assert.rejects(request('/api/chat', { message: 'review' }), /invalid.*job|job.*invalid/i);
    assert.equal(calls.length, 1);
  }
});

test('temporary polling network failures retry GET without repeating POST', async t => {
  fastPolling(t);
  const calls = fetchSequence(t, [accepted(), new TypeError('offline'), new TypeError('offline'), completed({ reply: 'recovered' })]);
  assert.deepEqual(await request('/api/chat', { message: 'review' }), { reply: 'recovered' });
  assert.deepEqual(calls.map(call => call.options.method), ['POST', 'GET', 'GET', 'GET']);
});

test('polling network failures stop after five failures and expose the accepted job ID', async t => {
  fastPolling(t);
  const calls = fetchSequence(t, [accepted(), ...Array.from({ length: 5 }, () => new TypeError('offline'))]);
  await assert.rejects(request('/api/chat', { message: 'review' }), error => error.jobId === JOB_ID && error.message.includes(JOB_ID));
  assert.equal(calls.length, 6);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
});

test('a failed initial POST is never replayed', async t => {
  const calls = fetchSequence(t, [new TypeError('connection lost')]);
  await assert.rejects(request('/api/chat', { message: 'review' }), /accepted|outcome|before.*retry/i);
  assert.equal(calls.length, 1);
});

test('abort before submission sends nothing', async t => {
  const calls = fetchSequence(t, []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(request('/api/chat', { message: 'review' }, controller.signal), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});

test('abort during polling stops locally without replay or server cancellation', async t => {
  fastPolling(t);
  const controller = new AbortController();
  const calls = fetchSequence(t, [accepted(), () => { controller.abort(); throw new DOMException('Aborted', 'AbortError'); }]);
  await assert.rejects(request('/api/chat', { message: 'review' }, controller.signal), { name: 'AbortError' });
  assert.deepEqual(calls.map(call => call.options.method), ['POST', 'GET']);
});

test('polling HTTP errors preserve their status and job ID without retrying', async t => {
  fastPolling(t);
  const calls = fetchSequence(t, [accepted(), json({ error: 'Job access denied.' }, 401)]);
  await assert.rejects(request('/api/chat', { message: 'review' }), error => error.status === 401 && error.jobId === JOB_ID && error.message === 'Job access denied.');
  assert.equal(calls.length, 2);
});

test('a mismatched polled job ID and invalid encoded result are rejected', async t => {
  fastPolling(t);
  for (const worker_job of [
    { id: '22222222-2222-4222-8222-222222222222', status: 'running' },
    { id: JOB_ID, status: 'completed', response: { status: 200, headers: {}, body: '%%%invalid%%%' } },
  ]) {
    const calls = fetchSequence(t, [accepted(), json({ worker_job })]);
    await assert.rejects(request('/api/chat', { message: 'review' }), error => error.jobId === JOB_ID && /invalid|different/i.test(error.message));
    assert.equal(calls.length, 2);
  }
});

test('polling has a bounded total wait and never repeats the accepted request', async t => {
  fastPolling(t);
  let clockCalls = 0;
  t.mock.method(Date, 'now', () => clockCalls++ === 0 ? 0 : 2_700_001);
  const calls = fetchSequence(t, [accepted()]);
  await assert.rejects(request('/api/chat', { message: 'review' }), error => error.jobId === JOB_ID && /timeout|timed out|long/i.test(error.message));
  assert.equal(calls.length, 1);
});
