/** JSON transport for local responses and accepted hosted worker jobs. */

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 45 * 60 * 1000;
const MAX_POLL_NETWORK_FAILURES = 5;
const ambiguousPosts = new Map<string, string>();

class ServiceRequestError extends Error {
  readonly status?: number;
  readonly jobId?: string;
  readonly code?: string;

  constructor(message: string, status?: number, jobId?: string, code?: string) {
    super(message);
    this.name = 'ServiceRequestError';
    this.status = status;
    this.jobId = jobId;
    this.code = code;
  }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (record(value)) {
    for (const key of ['error', 'message', 'detail']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key];
    }
    if (record(value.error) && typeof value.error.message === 'string' && value.error.message.trim()) return value.error.message;
  }
  return fallback;
}

function httpError(value: unknown, status: number, jobId?: string): ServiceRequestError {
  const code = record(value) && typeof value.code === 'string' ? value.code
    : record(value) && record(value.error) && typeof value.error.code === 'string' ? value.error.code : undefined;
  return new ServiceRequestError(errorMessage(value, `Service request failed (${status}).`), status, jobId, code);
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Stopped waiting locally. The server job may continue.', 'AbortError');
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted || (error instanceof Error && error.name === 'AbortError'));
}

function pause(signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(new DOMException('Stopped waiting locally. The server job may continue.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }, POLL_INTERVAL_MS);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

async function jsonBody(response: Response, jobId?: string): Promise<unknown> {
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw httpError(value, response.status, jobId);
  if (value === undefined) throw new ServiceRequestError('The service returned an invalid JSON response.', response.status, jobId);
  return value;
}

function completedBody(job: Record<string, unknown>, jobId: string): unknown {
  const response = job.response;
  if (!record(response) || !Number.isInteger(response.status) || Number(response.status) < 100 || Number(response.status) > 599 || typeof response.body !== 'string') {
    throw new ServiceRequestError(`Worker job ${jobId} returned an invalid response. Check the job before retrying.`, undefined, jobId);
  }
  let value: unknown;
  try {
    const bytes = Uint8Array.from(atob(response.body), character => character.charCodeAt(0));
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ServiceRequestError(`Worker job ${jobId} returned invalid encoded JSON. Check the job before retrying.`, Number(response.status), jobId);
  }
  const status = Number(response.status);
  if (status < 200 || status >= 300) throw httpError(value, status, jobId);
  return value;
}

async function waitForJob(initial: unknown, signal?: AbortSignal): Promise<{ job: Record<string, unknown>; jobId: string }> {
  if (!record(initial) || typeof initial.id !== 'string' || !JOB_ID.test(initial.id)) {
    throw new ServiceRequestError('The service returned an invalid worker job ID. No further request was sent.');
  }
  const jobId = initial.id.toLowerCase();
  // Derive the URL from a validated ID; never follow a server-supplied URL.
  const jobUrl = `/api/worker/jobs/${jobId}`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let failures = 0;
  while (Date.now() < deadline) {
    await pause(signal);
    checkAbort(signal);
    if (Date.now() >= deadline) break;
    let response: Response;
    try {
      response = await fetch(jobUrl, { method: 'GET', cache: 'no-store', credentials: 'same-origin', signal });
    } catch (error) {
      if (isAbort(error, signal)) throw new DOMException('Stopped waiting locally. The server job may continue.', 'AbortError');
      failures += 1;
      if (failures >= MAX_POLL_NETWORK_FAILURES) {
        throw new ServiceRequestError(`Connection interrupted while checking worker job ${jobId}. Check this job before retrying; the request was not resubmitted.`, undefined, jobId);
      }
      continue;
    }
    checkAbort(signal);
    const body = await jsonBody(response, jobId);
    const job = record(body) ? body.worker_job : undefined;
    if (!record(job) || typeof job.id !== 'string' || job.id.toLowerCase() !== jobId) {
      throw new ServiceRequestError(`The service returned an invalid or different worker job. Expected ${jobId}.`, response.status, jobId);
    }
    failures = 0;
    if (job.status === 'queued' || job.status === 'running') continue;
    if (job.status === 'completed') return { job, jobId };
    if (job.status === 'unconfirmed') {
      throw new ServiceRequestError(`Worker job ${jobId} has an unconfirmed outcome. Check this job before retrying; do not automatically resubmit.`, undefined, jobId);
    }
    if (job.status === 'failed') {
      throw new ServiceRequestError(`Worker job ${jobId} failed: ${errorMessage(job.error, 'No confirmed result was returned.')}`, undefined, jobId);
    }
    throw new ServiceRequestError(`Worker job ${jobId} returned an invalid status. Check this job before retrying.`, undefined, jobId);
  }
  throw new ServiceRequestError(`Waiting for worker job ${jobId} timed out. Check this job before retrying; the request was not resubmitted.`, undefined, jobId);
}

async function pollJob(initial: unknown, signal?: AbortSignal): Promise<unknown> {
  const { job, jobId } = await waitForJob(initial, signal);
  return completedBody(job, jobId);
}

function completedFile(job: Record<string, unknown>, jobId: string): Response {
  const response = job.response;
  if (!record(response) || !Number.isInteger(response.status) || Number(response.status) < 100 || Number(response.status) > 599
      || typeof response.body !== 'string' || response.body.length > 4 * 1024 * 1024) {
    throw new ServiceRequestError(`Worker job ${jobId} returned an invalid response. Check the job before retrying.`, undefined, jobId);
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(response.body), character => character.charCodeAt(0));
  } catch {
    throw new ServiceRequestError(`Worker job ${jobId} returned invalid encoded file data. Check this job before retrying.`, Number(response.status), jobId);
  }
  const status = Number(response.status);
  const headers = new Headers();
  if (record(response.headers)) {
    for (const key of ['content-type', 'content-disposition']) {
      const value = response.headers[key] ?? response.headers[key[0].toUpperCase() + key.slice(1)];
      if (typeof value === 'string' && !/[\r\n]/.test(value)) headers.set(key, value);
    }
  }
  if (status < 200 || status >= 300) {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { value = undefined; }
    throw httpError(value, status, jobId);
  }
  return new Response(status === 204 || status === 304 ? null : bytes, { status, headers });
}

export async function request<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  const hasBody = body !== undefined;
  const serialized = hasBody ? JSON.stringify(body) : undefined;
  const signature = hasBody ? `${url}\u0000${serialized}` : undefined;
  const idempotencyKey = signature ? ambiguousPosts.get(signature) || crypto.randomUUID() : undefined;
  const headers = hasBody ? { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey! } : undefined;
  let response: Response;
  try {
    // A mutation is submitted exactly once. Only status GETs may be retried.
    response = await fetch(url, { method: hasBody ? 'POST' : 'GET', headers, body: serialized, credentials: 'same-origin', signal });
  } catch (error) {
    if (signature && idempotencyKey) {
      if (ambiguousPosts.size >= 32 && !ambiguousPosts.has(signature)) {
        const oldest = ambiguousPosts.keys().next().value;
        if (oldest) ambiguousPosts.delete(oldest);
      }
      ambiguousPosts.set(signature, idempotencyKey);
    }
    if (isAbort(error, signal)) throw new DOMException('Stopped waiting locally. The server job may continue.', 'AbortError');
    throw new ServiceRequestError(hasBody
      ? 'Connection interrupted. The request may have been accepted; check its outcome before retrying. It was not automatically resubmitted.'
      : 'The service could not be reached. Check the connection before retrying.');
  }
  if (signature) ambiguousPosts.delete(signature);
  checkAbort(signal);
  const value = await jsonBody(response);
  checkAbort(signal);
  if (response.status === 202 && record(value) && 'worker_job' in value) return await pollJob(value.worker_job, signal) as T;
  return value as T;
}

/** GET a file directly or wait for the same-origin daemon job to finish. */
export async function requestFile(url: string, signal?: AbortSignal): Promise<Response> {
  checkAbort(signal);
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', cache: 'no-store', credentials: 'same-origin', signal });
  } catch (error) {
    if (isAbort(error, signal)) throw new DOMException('Stopped waiting locally. The server job may continue.', 'AbortError');
    throw new ServiceRequestError('The file service could not be reached. Check the connection before retrying.');
  }
  checkAbort(signal);
  if (response.status !== 202) return response;
  const accepted = await jsonBody(response);
  if (!record(accepted) || !('worker_job' in accepted)) return new Response(JSON.stringify(accepted), { status: 202, headers: { 'Content-Type': 'application/json' } });
  const { job, jobId } = await waitForJob(accepted.worker_job, signal);
  return completedFile(job, jobId);
}
