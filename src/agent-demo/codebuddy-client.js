const { randomUUID } = require('node:crypto');

const EXPECTED_ANSWER = 'AWS_BUDDY_OK';
const TEST_PROMPT = `Reply exactly ${EXPECTED_ANSWER}. Do not use tools. Do not read or modify files. Do not perform any accounting action.`;

class GatewayError extends Error {
  constructor(message, code = 'GATEWAY_ERROR') {
    super(message);
    this.code = code;
  }
}

function gatewayUrl(value = 'http://127.0.0.1:8081') {
  let url;
  try { url = new URL(value); } catch { throw new Error('AGENT_DEMO_GATEWAY_URL must be a valid URL.'); }
  if (url.username || url.password) throw new Error('AGENT_DEMO_GATEWAY_URL must not contain credentials.');
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('AGENT_DEMO_GATEWAY_URL must point to a private loopback service on this VM.');
  }
  if (url.search || url.hash) throw new Error('AGENT_DEMO_GATEWAY_URL must not contain a query or fragment.');
  return url.toString().replace(/\/$/u, '');
}

function httpFailure(status) {
  if ([401, 403].includes(status)) return new GatewayError('CodeBuddy authentication failed. Check the backend gateway password.', 'GATEWAY_AUTH');
  if (status === 404) return new GatewayError('CodeBuddy did not provide the expected run stream. Check the installed API version; a finished stream cannot be replayed.', 'GATEWAY_STREAM_UNAVAILABLE');
  return new GatewayError(`CodeBuddy returned HTTP ${status}. Check the private service on the VM.`, 'GATEWAY_HTTP');
}

// Public CodeBuddy 2.164.0 GatewayOutboundMessage / SSE contract. Completion
// requires a final message for this request; echoes and an SSE "done" do not pass.
async function readFinalAnswer(response, requestId) {
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    throw new GatewayError('CodeBuddy returned an unsupported stream format.', 'GATEWAY_PROTOCOL');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let receivedBytes = 0;
  function parseFrame(frame) {
    const lines = frame.split('\n');
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /u, '')).join('\n');
    if (!data || event === 'done') return null;
    if (event === 'error') throw new GatewayError('CodeBuddy could not finish the agent request.', 'GATEWAY_RUN_FAILED');
    if (event !== 'message') return null;
    let message;
    try { message = JSON.parse(data); } catch { throw new GatewayError('CodeBuddy returned invalid stream data.', 'GATEWAY_PROTOCOL'); }
    if (message.replyTo !== requestId) throw new GatewayError('CodeBuddy returned a message for a different request.', 'GATEWAY_PROTOCOL');
    if (message.status === 'error') throw new GatewayError('CodeBuddy could not finish the agent request.', 'GATEWAY_RUN_FAILED');
    if (message.status !== 'completed') return null;
    const text = message.content?.markdown ?? message.content?.text;
    if (typeof text !== 'string' || text.trim() !== EXPECTED_ANSWER) {
      throw new GatewayError('The agent finished but did not return the expected test phrase. The connection test was not confirmed.', 'GATEWAY_UNEXPECTED_ANSWER');
    }
    return text.trim();
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) receivedBytes += value.byteLength;
      if (receivedBytes > 262144) throw new GatewayError('The agent stream exceeded the connection-test limit.', 'GATEWAY_PROTOCOL');
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/gu, '\n');
      let separator;
      while ((separator = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const answer = parseFrame(frame);
        if (answer) return answer;
      }
      if (done) {
        if (buffer.trim()) {
          const answer = parseFrame(buffer);
          if (answer) return answer;
        }
        throw new GatewayError('The stream ended without a confirmed final agent answer. Do not assume the request succeeded.', 'GATEWAY_INCOMPLETE');
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function createCodeBuddyClient({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs } = {}) {
  // CODEBUDDY_BASE_URL configures the CLI's model provider, not this gateway.
  const base = gatewayUrl(env.AGENT_DEMO_GATEWAY_URL);
  const password = String(env.CODEBUDDY_GATEWAY_PASSWORD || '');
  const deadline = timeoutMs ?? Math.max(5000, Math.min(Number(env.AGENT_DEMO_TIMEOUT_MS) || 90000, 180000));
  return {
    configured: Boolean(password),
    async runTest({ onAccepted = () => {}, signal } = {}) {
      if (!password) throw new GatewayError('The backend gateway password is not configured.', 'GATEWAY_NOT_CONFIGURED');
      const requestId = randomUUID();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deadline);
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      let runId;
      const headers = { authorization: `Bearer ${password}`, 'x-codebuddy-request': '1' };
      try {
        const accepted = await fetchImpl(`${base}/api/v1/runs`, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, redirect: 'error', signal: controller.signal,
          body: JSON.stringify({
            id: requestId, type: 'message',
            source: { platform: 'generic', sender: { id: 'tutupbuku-connection-test' }, conversation: { id: requestId, type: 'direct' } },
            payload: { text: TEST_PROMPT }, timeoutMs: deadline,
          }),
        });
        if (!accepted.ok) throw httpFailure(accepted.status);
        let body;
        try { body = await accepted.json(); } catch { throw new GatewayError('CodeBuddy returned an invalid submission response.', 'GATEWAY_PROTOCOL'); }
        runId = body?.data?.runId;
        if (typeof runId !== 'string' || !/^[\w-]{1,128}$/u.test(runId) || body.data.status !== 'accepted') {
          throw new GatewayError('CodeBuddy did not accept a valid agent run.', 'GATEWAY_PROTOCOL');
        }
        onAccepted(runId);
        const stream = await fetchImpl(`${base}/api/v1/runs/${encodeURIComponent(runId)}/stream`, {
          headers, redirect: 'error', signal: controller.signal,
        });
        if (!stream.ok) throw httpFailure(stream.status);
        const answer = await readFinalAnswer(stream, requestId);
        return { answer, runId };
      } catch (error) {
        if (runId) {
          // Best effort cancellation affects only this demo run. Never retry a
          // credit-consuming submission automatically after an uncertain result.
          await fetchImpl(`${base}/api/v1/runs/${encodeURIComponent(runId)}/cancel`, {
            method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(1500),
          }).then((response) => response.body?.cancel()).catch(() => {});
        }
        if (controller.signal.aborted) {
          throw new GatewayError('The agent test timed out or was stopped. Its result is unconfirmed; check the VM before retrying.', 'GATEWAY_TIMEOUT');
        }
        if (error instanceof GatewayError) {
          if (runId) error.message += ' The result is unconfirmed; check the agent on AWS before starting another test.';
          throw error;
        }
        throw new GatewayError('The private CodeBuddy service could not be reached. Check that it is running on the VM.', 'GATEWAY_UNREACHABLE');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}

module.exports = { createCodeBuddyClient, gatewayUrl, readFinalAnswer, GatewayError, EXPECTED_ANSWER };
