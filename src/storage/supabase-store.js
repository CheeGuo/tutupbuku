const { CORRECTABLE_FIELDS } = require('./local-store');

class SupabaseStore {
  constructor({ url, serviceRoleKey, fetchImpl = globalThis.fetch } = {}) {
    if (!url || !serviceRoleKey) throw new TypeError('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for production storage.');
    this.url = String(url).trim().replace(/\/$/u, '');
    this.key = String(serviceRoleKey).trim();
    this.fetch = fetchImpl;
  }

  async request(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
    const response = await this.fetch(`${this.url}${path}`, {
      method,
      headers: {
        apikey: this.key,
        authorization: `Bearer ${this.key}`,
        ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 500);
      const code = /Resolve all open issues/i.test(text) ? 'OPEN_ISSUES'
        : /completed analysis is required before approval/i.test(text) ? 'ANALYSIS_REQUIRED'
          : /idempotency_key|duplicate key/i.test(text) ? 'DUPLICATE_IDEMPOTENCY' : 'SUPABASE_ERROR';
      throw Object.assign(new Error(`Supabase request failed (${response.status}): ${text}`), { code, status: response.status });
    }
    if (response.status === 204) return null;
    if (raw) return Buffer.from(await response.arrayBuffer());
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  rest(table, query = '') { return `/rest/v1/${table}${query ? `?${query}` : ''}`; }
  async resolveBusiness({ userId, email }) {
    const result = await this.request('/rest/v1/rpc/resolve_business_for_user', { method: 'POST', body: { p_user_id: userId, p_email: email } });
    const row = Array.isArray(result) ? result[0] : result;
    const businessId = row?.business_id || row?.businessId;
    if (!businessId) throw new Error('No business membership could be resolved for the authenticated user.');
    return { businessId, userId, email, role: row?.role || 'owner' };
  }

  async putUpload(businessId, documentId, filename, bytes) {
    const key = `${encodeURIComponent(businessId)}/${encodeURIComponent(documentId)}/${encodeURIComponent(documentId)}.bin`;
    await this.request(`/storage/v1/object/documents/${key}`, { method: 'POST', body: bytes, raw: true, headers: { 'content-type': 'application/octet-stream', 'x-upsert': 'false' } });
    return key;
  }
  async getUpload(businessId, documentId) {
    const key = `${encodeURIComponent(businessId)}/${encodeURIComponent(documentId)}/${encodeURIComponent(documentId)}.bin`;
    try { return await this.request(`/storage/v1/object/documents/${key}`, { raw: true }); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }

  async createDocument(document) {
    const rows = await this.request(this.rest('documents'), { method: 'POST', body: docToRow(document), headers: { Prefer: 'return=representation' } });
    return docFromRow(rows?.[0] || docToRow(document));
  }
  async createJob(job) {
    const rows = await this.request(this.rest('jobs'), { method: 'POST', body: jobToRow(job), headers: { Prefer: 'return=representation' } });
    const saved = jobFromRow(rows?.[0] || jobToRow(job));
    await this.addJobEvent(job.businessId, job.id, { type: 'job', agent: 'workflow', state: 'queued', summary: 'Document queued for processing.' });
    return saved;
  }
  async findIdempotentUpload(businessId, idempotencyKey) {
    if (!idempotencyKey) return null;
    const query = new URLSearchParams({ business_id: `eq.${businessId}`, idempotency_key: `eq.${idempotencyKey}`, select: '*' });
    const documents = await this.request(this.rest('documents', query.toString()));
    if (!documents?.length) return null;
    const queryJob = new URLSearchParams({ business_id: `eq.${businessId}`, document_id: `eq.${documents[0].id}`, select: '*' });
    const jobs = await this.request(this.rest('jobs', queryJob.toString()));
    return jobs?.length ? { document: docFromRow(documents[0]), job: jobFromRow(jobs[0]) } : null;
  }
  async findDuplicateHash(businessId, sha256) {
    const query = new URLSearchParams({ business_id: `eq.${businessId}`, sha256: `eq.${sha256}`, select: '*', limit: '1' });
    const rows = await this.request(this.rest('documents', query.toString()));
    return rows?.[0] ? docFromRow(rows[0]) : null;
  }
  async getJobForDocument(businessId, documentId) {
    const query = new URLSearchParams({ business_id: `eq.${businessId}`, document_id: `eq.${documentId}`, select: '*', limit: '1' });
    const rows = await this.request(this.rest('jobs', query.toString()));
    return rows?.[0] ? { ...jobFromRow(rows[0]), events: await this.getEvents(businessId, rows[0].id) } : null;
  }
  async listActiveJobs(businessId) {
    const query = new URLSearchParams({ business_id: `eq.${businessId}`, status: 'in.(queued,processing)', select: '*', order: 'created_at.desc', limit: '100' });
    const rows = await this.request(this.rest('jobs', query.toString()));
    return Promise.all((rows || []).map(async (row) => ({ ...jobFromRow(row), events: await this.getEvents(businessId, row.id) || [] })));
  }
  async listRecentJobs(businessId) {
    const query = new URLSearchParams({ business_id: `eq.${businessId}`, select: '*', order: 'created_at.desc', limit: '15' });
    const rows = await this.request(this.rest('jobs', query.toString()));
    return Promise.all((rows || []).map(async (row) => ({ ...jobFromRow(row), events: await this.getEvents(businessId, row.id) || [] })));
  }
  async claimJob(businessId, jobId, workerId, { leaseMs = 15 * 60 * 1000 } = {}) {
    const result = await this.request('/rest/v1/rpc/claim_intake_job', { method: 'POST', body: { p_business_id: businessId, p_job_id: jobId, p_worker_id: workerId, p_lease_seconds: Math.max(1, Math.ceil(leaseMs / 1000)) } });
    return result === true || result?.[0] === true;
  }
  async renewJobLease(businessId, jobId, workerId, { leaseMs = 15 * 60 * 1000 } = {}) {
    const result = await this.request('/rest/v1/rpc/renew_intake_job_lease', { method: 'POST', body: { p_business_id: businessId, p_job_id: jobId, p_worker_id: workerId, p_lease_seconds: Math.max(1, Math.ceil(leaseMs / 1000)) } });
    return result === true || result?.[0] === true;
  }
  async listRecoverableJobs() {
    const queuedQuery = new URLSearchParams({ status: 'eq.queued', select: '*', order: 'created_at.asc', limit: '100' });
    const processingQuery = new URLSearchParams({ status: 'eq.processing', select: '*', order: 'created_at.asc', limit: '100' });
    const [queued, processing] = await Promise.all([
      this.request(this.rest('jobs', queuedQuery.toString())),
      this.request(this.rest('jobs', processingQuery.toString())),
    ]);
    const recoverable = [...(queued || []), ...(processing || []).filter((job) => !job.lease_expires_at || Date.parse(job.lease_expires_at) <= Date.now())];
    return Promise.all(recoverable.map(async (row) => ({
      ...jobFromRow(row),
      document: await this.getDocument(row.business_id, row.document_id),
    })));
  }
  async persistProposal({ businessId, jobId, documentId, result }) {
    return this.request('/rest/v1/rpc/persist_document_proposal', { method: 'POST', body: { p_business_id: businessId, p_job_id: jobId, p_document_id: documentId, p_result: result } });
  }
  async getDocument(businessId, documentId) {
    const query = new URLSearchParams({ business_id: `eq.${businessId}`, id: `eq.${documentId}`, select: '*', limit: '1' });
    const rows = await this.request(this.rest('documents', query.toString()));
    return rows?.[0] ? docFromRow(rows[0]) : null;
  }
  async updateDocumentStatus(businessId, documentId, status) {
    const query = new URLSearchParams({ business_id: `eq.${businessId}`, id: `eq.${documentId}`, select: '*' });
    const rows = await this.request(this.rest('documents', query.toString()), { method: 'PATCH', body: { status, updated_at: new Date().toISOString() }, headers: { Prefer: 'return=representation' } });
    return rows?.[0] ? docFromRow(rows[0]) : null;
  }
  async listDocuments(businessId) {
    const query = new URLSearchParams({ business_id: `eq.${businessId}`, select: '*', order: 'created_at.desc' });
    return (await this.request(this.rest('documents', query.toString())) || []).map(docFromRow);
  }
  async listIssues(businessId) {
    const query = new URLSearchParams({ business_id: `eq.${businessId}`, select: '*', order: 'created_at.desc' });
    return (await this.request(this.rest('issues', query.toString())) || []).map(issueFromRow);
  }
  async getJob(businessId, jobId) {
    const query = new URLSearchParams({ business_id: `eq.${businessId}`, id: `eq.${jobId}`, select: '*', limit: '1' });
    const rows = await this.request(this.rest('jobs', query.toString()));
    if (!rows?.[0]) return null;
    return { ...jobFromRow(rows[0]), events: await this.getEvents(businessId, jobId) };
  }
  async getJobForDocument(businessId, documentId) {
    const query = new URLSearchParams({ business_id: `eq.${businessId}`, document_id: `eq.${documentId}`, select: '*', limit: '1' });
    const rows = await this.request(this.rest('jobs', query.toString()));
    return rows?.[0] ? { ...jobFromRow(rows[0]), events: await this.getEvents(businessId, rows[0].id) } : null;
  }
  async getEvents(businessId, jobId) {
    if (!await this.getJobRow(businessId, jobId)) return null;
    const query = new URLSearchParams({ business_id: `eq.${businessId}`, job_id: `eq.${jobId}`, select: '*', order: 'created_at.asc' });
    return (await this.request(this.rest('job_events', query.toString())) || []).map(eventFromRow);
  }
  async getJobRow(businessId, jobId) {
    const query = new URLSearchParams({ business_id: `eq.${businessId}`, id: `eq.${jobId}`, select: 'id', limit: '1' });
    return (await this.request(this.rest('jobs', query.toString())))?.[0] || null;
  }
  async addJobEvent(businessId, jobId, event) {
    if (!await this.getJobRow(businessId, jobId)) return null;
    const row = { event_id: event.eventId, business_id: businessId, job_id: jobId, type: event.type || 'agent_progress', agent: event.agent || null, state: event.state || null, summary: event.summary || '', payload: event };
    const rows = await this.request(this.rest('job_events'), { method: 'POST', body: row, headers: { Prefer: 'return=representation' } });
    if (event.jobStatus) {
      const query = new URLSearchParams({ business_id: `eq.${businessId}`, id: `eq.${jobId}` });
      await this.request(this.rest('jobs', query.toString()), { method: 'PATCH', body: { status: event.jobStatus, updated_at: new Date().toISOString() } });
    }
    return eventFromRow(rows?.[0] || row);
  }
  async setJobStatus(businessId, jobId, status, details = {}) {
    const query = new URLSearchParams({ business_id: `eq.${businessId}`, id: `eq.${jobId}` });
    const rows = await this.request(this.rest('jobs', query.toString()), { method: 'PATCH', body: { status, error: details.error || null, lease_owner: null, lease_expires_at: null, updated_at: new Date().toISOString() }, headers: { Prefer: 'return=representation' } });
    if (!rows?.length) return null;
    await this.addJobEvent(businessId, jobId, { type: 'job', agent: 'workflow', state: status, summary: details.summary || `Job ${status.replaceAll('_', ' ')}.`, jobStatus: status });
    return jobFromRow(rows[0]);
  }
  async recordCorrection(businessId, documentId, actorId, correction) {
    if (!CORRECTABLE_FIELDS.has(correction?.field)) throw new TypeError('Choose a supported extracted field to correct.');
    if (!correction?.reason || String(correction.reason).trim().length < 3) throw new TypeError('A correction reason is required.');
    const result = await this.request('/rest/v1/rpc/record_document_correction', { method: 'POST', body: { p_business_id: businessId, p_document_id: documentId, p_actor_id: actorId, p_field: correction.field, p_value: correction.value, p_reason: correction.reason } });
    const row = Array.isArray(result) ? result[0] : result;
    return row?.id ? docFromRow(row) : null;
  }
  async resolveIssue(businessId, issueId, actorId, reason) {
    const result = await this.request('/rest/v1/rpc/resolve_review_issue', { method: 'POST', body: { p_business_id: businessId, p_issue_id: issueId, p_actor_id: actorId, p_reason: reason } });
    const row = Array.isArray(result) ? result[0] : result;
    return row?.id ? issueFromRow(row) : null;
  }
  async approveDocument(businessId, documentId, actorId) {
    const result = await this.request('/rest/v1/rpc/approve_intake_document', { method: 'POST', body: { p_business_id: businessId, p_document_id: documentId, p_actor_id: actorId } });
    const row = Array.isArray(result) ? result[0] : result;
    return row?.id ? docFromRow(row) : null;
  }
  async getMasterData(businessId) {
    const query = new URLSearchParams({ business_id: `eq.${businessId}`, select: '*', limit: '1' });
    const rows = await this.request(this.rest('business_master_data', query.toString()));
    const row = rows?.[0];
    return row ? { chartOfAccounts: row.chart_of_accounts || [], suppliers: row.suppliers || [], buyerProfile: row.buyer_profile || null, updatedAt: row.updated_at } : { chartOfAccounts: [], suppliers: [], buyerProfile: null };
  }
  async saveMasterData(businessId, input) {
    const chartOfAccounts = Array.isArray(input?.chartOfAccounts) ? input.chartOfAccounts : [];
    const suppliers = Array.isArray(input?.suppliers) ? input.suppliers : [];
    if (chartOfAccounts.length > 500 || suppliers.length > 2000) throw Object.assign(new Error('Master data is too large.'), { status: 413 });
    const codes = chartOfAccounts.map((account) => String(account.code || '').trim());
    if (codes.some((code) => !code || code.length > 40) || new Set(codes).size !== codes.length) throw new TypeError('Chart of accounts codes must be present, unique, and under 40 characters.');
    if (chartOfAccounts.some((account) => !String(account.label || '').trim())) throw new TypeError('Each chart-of-accounts entry needs a label.');
    if (suppliers.some((supplier) => !String(supplier.legalName || '').trim())) throw new TypeError('Each supplier needs a legal name.');
    const buyerProfile = input?.buyerProfile && String(input.buyerProfile.legalName || '').trim()
      ? { legalName: String(input.buyerProfile.legalName).trim(), registrationNumber: String(input.buyerProfile.registrationNumber || '').trim() }
      : null;
    const query = new URLSearchParams({ on_conflict: 'business_id' });
    const rows = await this.request(this.rest('business_master_data', query.toString()), {
      method: 'POST', body: {
        business_id: businessId,
        chart_of_accounts: chartOfAccounts.map((account) => ({ code: String(account.code).trim(), label: String(account.label).trim(), active: account.active !== false })),
        suppliers: suppliers.map((supplier) => ({ id: supplier.id, legalName: String(supplier.legalName).trim(), registrationNumber: String(supplier.registrationNumber || '').trim(), active: supplier.active !== false })),
        buyer_profile: buyerProfile,
        updated_at: new Date().toISOString(),
      }, headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    });
    const row = rows?.[0];
    return row ? { chartOfAccounts: row.chart_of_accounts, suppliers: row.suppliers, buyerProfile: row.buyer_profile, updatedAt: row.updated_at } : await this.getMasterData(businessId);
  }
  async init() { return this; }
  close() {}
}

function docToRow(item) {
  return {
    id: item.id, business_id: item.businessId, uploaded_by: item.uploadedBy, original_filename: item.originalFilename,
    workflow: item.workflow, route_mode: item.routeMode || 'manual', purpose: item.purpose || '', status: item.status, sha256: item.sha256, storage_key: item.storageKey,
    mime_type: item.mimeType, idempotency_key: item.idempotencyKey || null, input_version: item.inputVersion || 1,
    manual_overrides: item.manualOverrides || {}, manual_override_metadata: item.manualOverrideMetadata || {}, linked_po_document_id: item.linkedPoDocumentId || null, analysis: item.analysis || null, findings: item.findings || [],
  };
}
function docFromRow(item) {
  return {
    id: item.id, businessId: item.business_id, uploadedBy: item.uploaded_by, originalFilename: item.original_filename,
    workflow: item.workflow, routeMode: item.route_mode || 'manual', purpose: item.purpose, status: item.status, sha256: item.sha256, storageKey: item.storage_key,
    mimeType: item.mime_type, idempotencyKey: item.idempotency_key, linkedPoDocumentId: item.linked_po_document_id || null, inputVersion: item.input_version || 1,
    manualOverrides: item.manual_overrides || {}, manualOverrideMetadata: item.manual_override_metadata || {}, analysis: item.analysis, findings: item.findings || [],
    createdAt: item.created_at, updatedAt: item.updated_at, approvedAt: item.approved_at, approvedBy: item.approved_by,
  };
}
function jobToRow(item) { return { id: item.id, business_id: item.businessId, document_id: item.documentId, status: item.status || 'queued', error: null }; }
function jobFromRow(item) { return { id: item.id, businessId: item.business_id, documentId: item.document_id, status: item.status, error: item.error, leaseOwner: item.lease_owner, leaseUntil: item.lease_expires_at, createdAt: item.created_at, updatedAt: item.updated_at, completedAt: item.completed_at }; }
function issueFromRow(item) {
  return { id: item.id, businessId: item.business_id, jobId: item.job_id, documentId: item.document_id, code: item.code, severity: item.severity, status: item.status, message: item.message, sourceRefs: item.source_refs || [], expected: item.expected, observed: item.observed, createdAt: item.created_at, resolvedAt: item.resolved_at, resolvedBy: item.resolved_by, resolutionReason: item.resolution_reason };
}
function eventFromRow(item) { return { ...(item.payload || {}), eventId: item.event_id, jobId: item.job_id, type: item.type, agent: item.agent, state: item.state, summary: item.summary, timestamp: item.created_at }; }

module.exports = { SupabaseStore };
