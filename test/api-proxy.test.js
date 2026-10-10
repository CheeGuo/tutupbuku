const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createProxyHandler } = require('../api/[...path].js');

function makeRequest(method, url, body = '') {
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  request.method = method;
  request.url = url;
  request.headers = {
    host: 'tutupbuku.vercel.app',
    origin: 'https://tutupbuku.vercel.app',
    'content-type': 'application/json',
  };
  return request;
}

function makeResponse() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body = '') { this.body = body; this.finished = true; },
  };
}

test('allowlisted API call is forwarded with the server-side bearer token', async () => {
  let sent;
  const handler = createProxyHandler({
    env: {
      TUTUPBUKU_UPSTREAM_URL: 'https://example.ngrok-free.app',
      TUTUPBUKU_UPSTREAM_TOKEN: 'private-token',
    },
    fetchImpl: async (url, options) => {
      sent = { url: String(url), options };
      return new Response(JSON.stringify({ case_id: 'Sept2026' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  const response = makeResponse();
  await handler(makeRequest('GET', '/api/case?case_id=Sept2026'), response);
  assert.equal(response.statusCode, 200);
  assert.equal(String(response.body), JSON.stringify({ case_id: 'Sept2026' }));
  assert.equal(sent.url, 'https://example.ngrok-free.app/api/case?case_id=Sept2026');
  assert.equal(sent.options.headers.authorization, 'Bearer private-token');
  assert.equal(sent.options.headers['x-forwarded-host'], undefined);
});

test('proxy rejects unlisted agent and process APIs without forwarding them', async () => {
  let requests = 0;
  const handler = createProxyHandler({
    env: {
      TUTUPBUKU_UPSTREAM_URL: 'https://example.ngrok-free.app',
      TUTUPBUKU_UPSTREAM_TOKEN: 'private-token',
    },
    fetchImpl: async () => { requests += 1; return new Response('{}'); },
  });
  const response = makeResponse();
  await handler(makeRequest('POST', '/api/v1/process/start', '{}'), response);
  assert.equal(response.statusCode, 404);
  assert.equal(requests, 0);
});

test('proxy rejects cross-origin state changes and fails closed when credentials are missing', async () => {
  const handler = createProxyHandler({
    env: {
      TUTUPBUKU_UPSTREAM_URL: 'https://example.ngrok-free.app',
      TUTUPBUKU_UPSTREAM_TOKEN: 'private-token',
    },
    fetchImpl: async () => new Response('{}'),
  });
  const crossOrigin = makeRequest('POST', '/api/decisions', '{}');
  crossOrigin.headers.origin = 'https://attacker.example';
  const rejected = makeResponse();
  await handler(crossOrigin, rejected);
  assert.equal(rejected.statusCode, 403);

  const unconfigured = createProxyHandler({ env: {}, fetchImpl: async () => new Response('{}') });
  const unavailable = makeResponse();
  await unconfigured(makeRequest('GET', '/api/case'), unavailable);
  assert.equal(unavailable.statusCode, 503);
});