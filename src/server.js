const http = require('node:http');
const { createHmac, randomUUID, timingSafeEqual, createHash } = require('node:crypto');
const path = require('node:path');
const { LocalStore } = require('./storage/local-store');

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.csv', '.tsv', '.txt', '.pdf', '.png', '.jpg', '.jpeg', '.webp']);
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};

function json(response, status, data) {
  response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(data));
}

function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function sign(value, secret) { return createHmac('sha256', secret).update(value).digest('base64url'); }
function issueLocalToken(user, secret) {
  const payload = encode({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12 });
  return `${payload}.${sign(payload, secret)}`;
}
function verifyLocalToken(token, secret) {
  const [payload, signature, extra] = String(token || '').split('.');
  if (!payload || !signature || extra) return null;
  const expected = Buffer.from(sign(payload, secret));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.sub || !data.email || !Number.isFinite(data.exp) || data.exp <= Date.now() / 1000) return null;
    return { id: data.sub, email: data.email };
  } catch { return null; }
}

async function readBody(request, maximum = MAX_UPLOAD_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error(`Request body exceeds ${maximum} bytes.`), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function csvCell(value) {
  let text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function toCsv(rows) {
  if (!rows.length) return 'id,status,workflow,filename,document_type,document_number,total_amount_sen,created_at\r\n';
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return `${columns.map(csvCell).join(',')}\r\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')).join('\r\n')}\r\n`;
}

function assertProductionConfiguration(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
  const missing = required.filter((name) => !String(env[name] || '').trim());
  if (missing.length) throw new Error(`Production requires ${missing.join(', ')}. LocalStore and local sign-in are development-only.`);
}

function createApplication({ env = process.env, store, processDocument, fetchImpl = globalThis.fetch } = {}) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(process.cwd(), '.tutupbuku-data'));
  const storage = store || new LocalStore({ dataDir });
  const supabaseAuthConfigured = Boolean(String(env.SUPABASE_URL || '').trim() && String(env.SUPABASE_ANON_KEY || '').trim());
  const supabaseStoreConfigured = Boolean(supabaseAuthConfigured && String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim());
  const processingQueue = [];
  const scheduledJobs = new Set();
  const maxParallelJobs = Math.max(1, Math.min(Number(env.MAX_PARALLEL_JOBS) || 2, 16));
  let activeJobs = 0;
  let recoveryTimer;
  function pumpQueue() {
    while (activeJobs < maxParallelJobs && processingQueue.length) {
      const task = processingQueue.shift();
      activeJobs += 1;
      setImmediate(() => processJob(task).catch(() => {}).finally(() => {
        activeJobs -= 1;
        scheduledJobs.delete(task.job.id);
        pumpQueue();
      }));
    }
  }
  function scheduleJob(task) {
    if (scheduledJobs.has(task.job.id)) return true;
    if (processingQueue.length >= 100) return false;
    scheduledJobs.add(task.job.id);
    processingQueue.push(task);
    pumpQueue();
    return true;
  }
  async function recoverJobs() {
    if (!storage.listRecoverableJobs) return;
    try {
      for (const job of await storage.listRecoverableJobs()) {
        if (scheduledJobs.has(job.id)) continue;
        const document = job.document || await storage.getDocument(job.businessId, job.documentId);
        const bytes = document ? await storage.getUpload(job.businessId, document.id) : null;
        if (document && bytes) scheduleJob({ storage, processDocument, env, document, job, bytes });
      }
    } catch { /* Persistent jobs remain available for the next recovery pass. */ }
  }
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { status: 'ok', service: 'tutupbuku' });
      if (request.method === 'GET' && url.pathname === '/api/config') {
        return json(response, 200, {
          aiConfigured: Boolean(String(env.AI_BASE_URL || '').trim() && String(env.AI_MODEL || '').trim()), maxUploadBytes: MAX_UPLOAD_BYTES,
          authMode: supabaseStoreConfigured ? 'supabase' : env.NODE_ENV === 'production' ? 'unconfigured' : 'local-development',
          ...(supabaseStoreConfigured ? { supabaseUrl: String(env.SUPABASE_URL).trim(), supabaseAnonKey: String(env.SUPABASE_ANON_KEY).trim() } : {}),
        });
      }
      if (request.method === 'GET' && ['/','/index.html','/app.js','/styles.css'].includes(url.pathname)) {
        const filename = url.pathname === '/app.js' ? 'app.js' : url.pathname === '/styles.css' ? 'styles.css' : 'index.html';
        const mime = filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
        response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': mime, 'cache-control': 'no-cache' });
        return response.end(await require('node:fs/promises').readFile(path.join(__dirname, '..', 'public', filename)));
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/local') {
        if (env.NODE_ENV === 'production' || String(env.SUPABASE_URL || '').trim()) return json(response, 404, { error: 'Not found.' });
        const body = JSON.parse((await readBody(request, 16_384)).toString('utf8'));
        const email = String(body.email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return json(response, 400, { error: 'Enter a valid email address.' });
        const id = createHash('sha256').update(email).digest('hex').slice(0, 32);
        return json(response, 200, { accessToken: issueLocalToken({ id: `local-${id}`, email }, String(env.APP_SECRET || 'development-only-change-me')) });
      }

      let actor;
      const authorization = request.headers.authorization || '';
      if (!authorization.startsWith('Bearer ')) return json(response, 401, { error: 'Authentication required.' });
      const token = authorization.slice(7);
      if (supabaseAuthConfigured) {
        const authResponse = await fetchImpl(`${String(env.SUPABASE_URL).trim().replace(/\/$/u, '')}/auth/v1/user`, {
          headers: { apikey: String(env.SUPABASE_ANON_KEY).trim(), authorization: `Bearer ${token}` },
        });
        if (!authResponse.ok) return json(response, 401, { error: 'Invalid or expired sign-in.' });
        const user = await authResponse.json();
        if (!user.id || !user.email) return json(response, 401, { error: 'Authenticated account has no email address.' });
        actor = { id: user.id, email: user.email };
      } else {
        if (env.NODE_ENV === 'production') return json(response, 503, { error: 'Production authentication is not configured.' });
        actor = verifyLocalToken(token, String(env.APP_SECRET || 'development-only-change-me'));
        if (!actor) return json(response, 401, { error: 'Invalid or expired sign-in.' });
      }

      const membership = await storage.resolveBusiness({ userId: actor.id, email: actor.email });
      const businessId = membership.businessId;
      const role = ['owner', 'reviewer', 'employee'].includes(membership.role) ? membership.role : 'owner';
      const canReview = role === 'owner' || role === 'reviewer';
      const employeeCanSee = (document) => role !== 'employee'
        || (document?.workflow === 'claim' && document.uploadedBy === actor.id);

      if (request.method === 'GET' && url.pathname === '/api/session') return json(response, 200, { role });

      if (request.method === 'GET' && url.pathname === '/api/master-data') return json(response, 200, await storage.getMasterData(businessId));
      if (request.method === 'PUT' && url.pathname === '/api/master-data') {
        if (role !== 'owner') return json(response, 403, { error: 'Only a business owner can change company reference data.' });
        const body = JSON.parse((await readBody(request, 1_000_000)).toString('utf8'));
        return json(response, 200, await storage.saveMasterData(businessId, body));
      }

      if (request.method === 'POST' && url.pathname === '/api/documents') {
        const filename = decodeHeader(request.headers['x-filename'] || 'upload').slice(0, 240);
        const extension = path.extname(filename).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(extension)) return json(response, 415, { error: 'Upload a CSV, TSV, TXT, PDF, PNG, JPG, JPEG, or WEBP file.' });
        const requestedWorkflow = String(request.headers['x-workflow'] || 'auto').toLowerCase();
        if (!['auto', 'purchasing', 'claim'].includes(requestedWorkflow)) return json(response, 400, { error: 'Choose automatic routing, purchasing, or employee claim.' });
        if (role === 'employee' && requestedWorkflow !== 'claim') return json(response, 403, { error: 'Employee accounts can submit employee claims only.' });
        const routeMode = requestedWorkflow === 'auto' ? 'automatic' : 'manual';
        const workflow = requestedWorkflow === 'auto' ? 'purchasing' : requestedWorkflow;
        if (role === 'employee' && !decodeHeader(request.headers['x-claim-purpose'] || '').trim()) return json(response, 400, { error: 'Add the employee claim purpose before uploading.' });
        if (processingQueue.length >= 100) return json(response, 503, { error: 'The document queue is full. Try again shortly.' });
        const bytes = await readBody(request);
        if (!bytes.length) return json(response, 400, { error: 'The uploaded file is empty.' });
        if (!validFileSignature(extension, bytes)) return json(response, 415, { error: 'The file contents do not match its file type.' });
        const idempotencyKey = String(request.headers['idempotency-key'] || '').slice(0, 200);
        if (idempotencyKey) {
          const existing = await storage.findIdempotentUpload?.(businessId, idempotencyKey);
          if (existing) return json(response, 200, { document: publicDocument(existing.document), job: { id: existing.job.id, status: existing.job.status }, idempotentReplay: true });
        }
        const documentId = randomUUID();
        const jobId = randomUUID();
        const digest = createHash('sha256').update(bytes).digest('hex');
        const duplicate = await storage.findDuplicateHash?.(businessId, digest);
        const storageKey = await storage.putUpload(businessId, documentId, filename, bytes);
        let document;
        try { document = await storage.createDocument({
          id: documentId, businessId, uploadedBy: actor.id, originalFilename: filename, workflow, routeMode,
          purpose: decodeHeader(request.headers['x-claim-purpose'] || '').slice(0, 2000), status: 'queued',
          sha256: digest, storageKey, mimeType: request.headers['content-type'] || 'application/octet-stream', idempotencyKey: idempotencyKey || null,
          duplicateOf: duplicate?.id || null,
        }); } catch (error) {
          if (idempotencyKey && (error.code === 'DUPLICATE_IDEMPOTENCY' || error.status === 409)) {
            const existing = await storage.findIdempotentUpload?.(businessId, idempotencyKey);
            if (existing) return json(response, 200, { document: publicDocument(existing.document), job: { id: existing.job.id, status: existing.job.status }, idempotentReplay: true });
          }
          throw error;
        }
        const job = await storage.createJob({ id: jobId, businessId, documentId, status: 'queued' });
        scheduleJob({ storage, processDocument, env, document, job, bytes });
        return json(response, 201, { document: publicDocument(document), job: { id: job.id, status: job.status } });
      }

      if (request.method === 'GET' && url.pathname === '/api/jobs') {
        const jobs = await storage.listRecentJobs(businessId);
        if (role !== 'employee') return json(response, 200, jobs);
        const visibleJobs = [];
        for (const job of jobs) if (employeeCanSee(await storage.getDocument(businessId, job.documentId))) visibleJobs.push(job);
        return json(response, 200, visibleJobs);
      }
      const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)$/u);
      if (request.method === 'GET' && jobMatch) {
        const job = await storage.getJob(businessId, jobMatch[1]);
        if (!job) return json(response, 404, { error: 'Job not found.' });
        if (!employeeCanSee(await storage.getDocument(businessId, job.documentId))) return json(response, 404, { error: 'Job not found.' });
        return json(response, 200, job);
      }

      const eventsMatch = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)\/events$/u);
      if (request.method === 'GET' && eventsMatch) {
        const job = await storage.getJob(businessId, eventsMatch[1]);
        if (!job || !employeeCanSee(await storage.getDocument(businessId, job.documentId))) return json(response, 404, { error: 'Job not found.' });
        const events = await storage.getEvents(businessId, eventsMatch[1]);
        if (!events) return json(response, 404, { error: 'Job not found.' });
        response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        response.write(': connected\n\n');
        for (const event of events) response.write(`id: ${event.eventId}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`);
        return response.end();
      }

      if (request.method === 'GET' && url.pathname === '/api/documents') {
        return json(response, 200, (await storage.listDocuments(businessId)).filter(employeeCanSee).map(publicDocument));
      }
      if (request.method === 'GET' && url.pathname === '/api/issues') {
        const issues = await storage.listIssues(businessId);
        if (role !== 'employee') return json(response, 200, issues);
        const visibleIds = new Set((await storage.listDocuments(businessId)).filter(employeeCanSee).map((item) => item.id));
        return json(response, 200, issues.filter((issue) => visibleIds.has(issue.documentId)));
      }

      const reprocessMatch = url.pathname.match(/^\/api\/documents\/([a-zA-Z0-9-]+)\/reprocess$/u);
      if (request.method === 'POST' && reprocessMatch) {
        const document = await storage.getDocument(businessId, reprocessMatch[1]);
        const job = document ? await storage.getJobForDocument?.(businessId, document.id) : null;
        const bytes = document ? await storage.getUpload(businessId, document.id) : null;
        if (!document || !job || !bytes) return json(response, 404, { error: 'Document, processing job, or stored upload not found.' });
        if (!employeeCanSee(document)) return json(response, 404, { error: 'Document not found.' });
        if (document.status === 'approved') return json(response, 409, { error: 'Approved documents cannot be reprocessed. Create a correction workflow with a reviewer.' });
        if (processingQueue.length >= 100) return json(response, 503, { error: 'The document queue is full. Try again shortly.' });
        await storage.updateDocumentStatus?.(businessId, document.id, 'queued');
        await storage.setJobStatus(businessId, job.id, 'queued', { error: null, summary: 'Checks queued after a reviewer correction.' });
        scheduleJob({ storage, processDocument, env, document: { ...document, status: 'queued' }, job: { ...job, status: 'queued' }, bytes });
        return json(response, 202, { document: publicDocument({ ...document, status: 'queued' }), job: { id: job.id, status: 'queued' } });
      }

      const correctionMatch = url.pathname.match(/^\/api\/documents\/([a-zA-Z0-9-]+)\/corrections$/u);
      if (request.method === 'POST' && correctionMatch) {
        const body = JSON.parse((await readBody(request, 64_000)).toString('utf8'));
        const existingDocument = await storage.getDocument(businessId, correctionMatch[1]);
        if (!existingDocument) return json(response, 404, { error: 'Document not found.' });
        if (!employeeCanSee(existingDocument)) return json(response, 404, { error: 'Document not found.' });
        if (existingDocument.status === 'approved') return json(response, 409, { error: 'Approved documents cannot be edited.' });
        const document = await storage.recordCorrection(businessId, correctionMatch[1], actor.id, body);
        if (!document) return json(response, 404, { error: 'Document not found.' });
        return json(response, 200, publicDocument(document));
      }

      const resolveMatch = url.pathname.match(/^\/api\/issues\/([a-zA-Z0-9-]+)\/resolve$/u);
      if (request.method === 'POST' && resolveMatch) {
        if (!canReview) return json(response, 403, { error: 'Only a reviewer or owner can resolve issues.' });
        const body = JSON.parse((await readBody(request, 16_384)).toString('utf8'));
        const issue = await storage.resolveIssue(businessId, resolveMatch[1], actor.id, body.reason);
        if (!issue) return json(response, 404, { error: 'Issue not found.' });
        return json(response, 200, issue);
      }

      const approveMatch = url.pathname.match(/^\/api\/documents\/([a-zA-Z0-9-]+)\/approve$/u);
      if (request.method === 'POST' && approveMatch) {
        if (!canReview) return json(response, 403, { error: 'Only a reviewer or owner can approve documents.' });
        const document = await storage.approveDocument(businessId, approveMatch[1], actor.id);
        if (!document) return json(response, 404, { error: 'Document not found.' });
        return json(response, 200, publicDocument(document));
      }

      if (request.method === 'GET' && url.pathname === '/api/export') {
        const kind = String(url.searchParams.get('kind') || 'records');
        let rows;
        if (kind === 'issues') {
          rows = await storage.listIssues(businessId);
          if (role === 'employee') {
            const visibleIds = new Set((await storage.listDocuments(businessId)).filter(employeeCanSee).map((item) => item.id));
            rows = rows.filter((issue) => visibleIds.has(issue.documentId));
          }
        }
        else if (kind === 'records') rows = (await storage.listDocuments(businessId)).filter(employeeCanSee).map((document) => flattenRecord(document));
        else return json(response, 400, { error: 'Export kind must be records or issues.' });
        response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="tutupbuku-${kind}.csv"`, 'cache-control': 'no-store' });
        return response.end(toCsv(rows));
      }
      return json(response, 404, { error: 'Not found.' });
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const status = error.code === 'OPEN_ISSUES' || error.code === 'ANALYSIS_REQUIRED' ? 409
        : error.status || (error instanceof SyntaxError || error instanceof TypeError ? 400 : 500);
      const safeMessage = error.code === 'OPEN_ISSUES' ? 'Resolve all open issues before approval.'
        : error.code === 'ANALYSIS_REQUIRED' ? 'A completed analysis is required before approval.'
          : status >= 500 || error.code === 'SUPABASE_ERROR' ? 'The request could not be completed. Check service configuration and logs.'
            : error.message;
      json(response, status, { error: safeMessage, code: error.code || undefined });
    }
  });

  return {
    server,
    async listen(port = Number(env.PORT) || 3000, host = env.HOST || '0.0.0.0') {
      await storage.init?.();
      const address = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
      });
      setImmediate(() => recoverJobs());
      recoveryTimer = setInterval(() => recoverJobs(), 30_000);
      recoveryTimer.unref?.();
      return address;
    },
    close() { clearInterval(recoveryTimer); return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}

function publicDocument(document) {
  const { storageKey, sha256, uploadedBy, businessId, ...safe } = document;
  return safe;
}
function decodeHeader(value) {
  try { return decodeURIComponent(String(value)); } catch { return String(value); }
}
function validFileSignature(extension, bytes) {
  if (extension === '.pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (extension === '.png') return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (extension === '.jpg' || extension === '.jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === '.webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return !bytes.subarray(0, 1024).includes(0);
}
function flattenRecord(document) {
  const extracted = document.analysis?.document || document.analysis || {};
  return {
    id: document.id, status: document.status, workflow: document.workflow, filename: document.originalFilename,
    document_type: extracted.type || '', document_number: extracted.documentNumber || extracted.invoiceNumber || extracted.poNumber || '',
    document_date: extracted.documentDate || '', supplier_name: extracted.supplierName || '', buyer_name: extracted.buyerName || '',
    claim_purpose: extracted.purpose || document.purpose || '', standardized_description: extracted.standardizedDescription || '',
    account_code: extracted.accountCode || '', po_document_id: extracted.linkedPoDocumentId || document.linkedPoDocumentId || '',
    total_amount_sen: extracted.totalAmountSen ?? '', total_amount_myr: Number.isSafeInteger(extracted.totalAmountSen) ? (extracted.totalAmountSen / 100).toFixed(2) : '',
    created_at: document.createdAt,
  };
}

async function processJob({ storage, processDocument, env, document, job, bytes }) {
  const emit = async (event) => storage.addJobEvent(job.businessId, job.id, event);
  const workerId = randomUUID();
  if (storage.claimJob && !await storage.claimJob(job.businessId, job.id, workerId)) return;
  if (!storage.claimJob) await storage.setJobStatus(job.businessId, job.id, 'processing');
  const leaseRenewal = storage.renewJobLease ? setInterval(() => storage.renewJobLease(job.businessId, job.id, workerId).catch(() => {}), 30_000) : null;
  leaseRenewal?.unref?.();
  try {
    const result = typeof processDocument === 'function'
      ? await processDocument({ document, job, bytes, emit, store: storage })
      : { status: 'needs_configuration', findings: [], error: { code: 'AI_NOT_CONFIGURED', message: 'No document processor is configured.' } };
    if (result.status === 'needs_configuration') {
      const code = result.error?.code || 'AI_NOT_CONFIGURED';
      await storage.setJobStatus(job.businessId, job.id, 'needs_configuration', { error: { code, message: safeProcessingMessage(code) }, summary: 'AI/OCR processing is not configured; the file was saved without claiming an analysis.' });
      await storage.updateDocumentStatus?.(job.businessId, document.id, 'needs_configuration');
      return;
    }
    if (result.status === 'failed') {
      const code = result.error?.code || 'WORKFLOW_FAILED';
      process.stderr.write(`[tutupbuku] job ${job.id} failed with ${code}\n`);
      await storage.setJobStatus(job.businessId, job.id, 'failed', { error: { code, message: safeProcessingMessage(code) }, summary: 'Processing failed. Review the error and retry after correcting the setup or input.' });
      await storage.updateDocumentStatus?.(job.businessId, document.id, 'failed');
      return;
    }
    await storage.persistProposal({ businessId: job.businessId, jobId: job.id, documentId: document.id, result });
  } catch (error) {
    const status = error.code === 'AI_NOT_CONFIGURED' || error.code === 'OCR_UNAVAILABLE' ? 'needs_configuration' : 'failed';
    const code = error.code || 'PROCESSING_FAILED';
    process.stderr.write(`[tutupbuku] job ${job.id} failed with ${code}\n`);
    await storage.setJobStatus(job.businessId, job.id, status, { error: { code, message: safeProcessingMessage(code) } });
    await storage.updateDocumentStatus?.(job.businessId, document.id, status);
  } finally {
    clearInterval(leaseRenewal);
  }
}

function safeProcessingMessage(code) {
  return code === 'AI_NOT_CONFIGURED' ? 'AI endpoint is not configured.'
    : code === 'ROUTE_UNCERTAIN' ? 'Master Agent could not choose a workflow with confidence. Upload again and select purchasing or claim manually.'
    : code === 'OCR_UNAVAILABLE' ? 'OCR tools are not installed. Install Tesseract and Poppler or use a text-based file.'
      : code === 'OCR_EMPTY' ? 'No readable text was found. Check the document or upload a clearer scan.'
        : code === 'AI_TIMEOUT' ? 'The AI provider timed out. Retry after checking the configured endpoint.'
          : code === 'AI_INVALID_JSON' ? 'The AI provider returned an invalid structured result. The document remains unapproved.'
            : code === 'AI_INVALID_OUTPUT' ? 'An agent returned an incomplete result. The document remains unapproved.'
              : 'Processing failed. Check server logs for the error code and retry.';
}

if (require.main === module) {
  const { createProcessor } = require('./processor');
  const { createAIProvider } = require('./ai/provider');
  assertProductionConfiguration(process.env);
  const store = String(process.env.SUPABASE_URL || '').trim()
    ? new (require('./storage/supabase-store').SupabaseStore)({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY })
    : process.env.NODE_ENV === 'production'
      ? (() => { throw new Error('Production mode requires Supabase configuration. LocalStore is intended for local development only.'); })()
      : new LocalStore({ dataDir: path.resolve(process.env.DATA_DIR || path.join(process.cwd(), '.tutupbuku-data')) });
  const processor = createProcessor({ env: process.env, provider: createAIProvider(process.env) });
  const app = createApplication({ env: process.env, store, processDocument: processor });
  app.listen().then((address) => process.stdout.write(`TutupBuku listening on http://${address.address}:${address.port}\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().finally(() => process.exit()));
}

module.exports = { createApplication, processJob, verifyLocalToken, issueLocalToken, toCsv, assertProductionConfiguration };
