const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { auditPoBalance } = require('../domain/audit');

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
const CORRECTABLE_FIELDS = new Set(['type','supplierName','buyerName','merchantName','documentNumber','invoiceNumber','poNumber','documentDate','dueDate','totalAmountSen','taxAmountSen','paymentTerm','purpose','description','standardizedDescription','lines','categoryHints','accountCode','linkedPoDocumentId']);
function emptyState() {
  return { version: 1, businesses: {}, masterData: {}, documents: {}, jobs: {}, issues: {}, events: {}, corrections: [] };
}
function safeSegment(value) {
  const segment = String(value || '');
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(segment)) throw new Error('Invalid storage identifier.');
  return segment;
}

class LocalStore {
  constructor({ dataDir } = {}) {
    if (!dataDir) throw new TypeError('dataDir is required for LocalStore.');
    this.dataDir = path.resolve(dataDir);
    this.uploadDir = path.join(this.dataDir, 'uploads');
    this.statePath = path.join(this.dataDir, 'state.json');
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.uploadDir, { recursive: true });
    try { await fs.access(this.statePath); }
    catch { await fs.writeFile(this.statePath, JSON.stringify(emptyState(), null, 2), { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error; }); }
    return this;
  }

  async readState() {
    await this.init();
    const state = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
    if (!state || state.version !== 1 || typeof state.documents !== 'object') throw new Error('Local store state is invalid.');
    return state;
  }

  async mutate(mutator) {
    const run = this.writeQueue.then(async () => {
      const state = await this.readState();
      const value = await mutator(state);
      const temporary = `${this.statePath}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
      await fs.rename(temporary, this.statePath);
      return clone(value);
    });
    this.writeQueue = run.catch(() => {});
    return run;
  }

  async putUpload(businessId, documentId, filename, bytes) {
    const business = safeSegment(businessId);
    const document = safeSegment(documentId);
    const directory = path.join(this.uploadDir, business);
    await fs.mkdir(directory, { recursive: true });
    const target = path.resolve(directory, `${document}.bin`);
    if (!target.startsWith(`${this.uploadDir}${path.sep}`)) throw new Error('Invalid upload path.');
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target);
    return `${business}/${document}.bin`;
  }

  async getUpload(businessId, documentId) {
    const business = safeSegment(businessId);
    const document = safeSegment(documentId);
    try { return await fs.readFile(path.join(this.uploadDir, business, `${document}.bin`)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async createDocument(document) {
    if (!document?.id || !document.businessId) throw new TypeError('Document id and businessId are required.');
    return this.mutate((state) => {
      if (state.documents[document.id]) throw new Error('Document already exists.');
      if (document.idempotencyKey && Object.values(state.documents).some((item) => item.businessId === document.businessId && item.idempotencyKey === document.idempotencyKey)) {
        throw Object.assign(new Error('Idempotency key was already used.'), { code: 'DUPLICATE_IDEMPOTENCY' });
      }
      const saved = {
        ...document,
        inputVersion: Number(document.inputVersion) || 1,
        manualOverrides: {},
        analysis: null,
        findings: [],
        createdAt: document.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.documents[document.id] = saved;
      return saved;
    });
  }

  async createJob(job) {
    if (!job?.id || !job.businessId || !job.documentId) throw new TypeError('Job id, businessId, and documentId are required.');
    return this.mutate((state) => {
      if (state.jobs[job.id]) throw new Error('Job already exists.');
      const saved = { ...job, runId: job.runId || randomUUID(), inputVersion: job.inputVersion || state.documents[job.documentId]?.inputVersion || 1, status: job.status || 'queued', leaseOwner: null, leaseUntil: null, createdAt: job.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.jobs[job.id] = saved;
      state.events[job.id] = [];
      this.pushEvent(state, saved, { type: 'job', agent: 'workflow', state: 'queued', summary: 'Document queued for processing.' });
      return saved;
    });
  }

  async findIdempotentUpload(businessId, idempotencyKey) {
    if (!idempotencyKey) return null;
    const state = await this.readState();
    const document = Object.values(state.documents).find((item) => item.businessId === businessId && item.idempotencyKey === idempotencyKey);
    if (!document) return null;
    const job = Object.values(state.jobs).find((item) => item.businessId === businessId && item.documentId === document.id);
    return job ? { document: clone(document), job: clone(job) } : null;
  }

  async findDuplicateHash(businessId, sha256) {
    const state = await this.readState();
    const document = Object.values(state.documents).find((item) => item.businessId === businessId && item.sha256 === sha256);
    return document ? clone(document) : null;
  }

  async getJobForDocument(businessId, documentId) {
    const state = await this.readState();
    const job = Object.values(state.jobs).find((item) => item.businessId === businessId && item.documentId === documentId);
    return job ? { ...clone(job), events: clone(state.events[job.id] || []) } : null;
  }

  async listActiveJobs(businessId) {
    const state = await this.readState();
    return Object.values(state.jobs).filter((job) => job.businessId === businessId && ['queued', 'processing'].includes(job.status))
      .map((job) => ({ ...clone(job), events: clone(state.events[job.id] || []) }));
  }

  async listRecentJobs(businessId) {
    const state = await this.readState();
    return Object.values(state.jobs).filter((job) => job.businessId === businessId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 15)
      .map((job) => ({ ...clone(job), events: clone(state.events[job.id] || []) }));
  }

  async claimJob(businessId, jobId, workerId, { leaseMs = 15 * 60 * 1000 } = {}) {
    return this.mutate((state) => {
      const job = state.jobs[jobId];
      if (!job || job.businessId !== businessId) return false;
      const expired = !job.leaseUntil || Date.parse(job.leaseUntil) <= Date.now();
      if (job.status !== 'queued' && !(job.status === 'processing' && expired)) return false;
      job.status = 'processing';
      job.leaseOwner = workerId;
      job.leaseUntil = new Date(Date.now() + Math.max(1, leaseMs)).toISOString();
      job.updatedAt = new Date().toISOString();
      this.pushEvent(state, job, { type: 'job', agent: 'workflow', state: 'processing', summary: 'Document processor claimed this job.', workerId, jobStatus: 'processing' });
      return true;
    });
  }

  async renewJobLease(businessId, jobId, workerId, { leaseMs = 15 * 60 * 1000 } = {}) {
    return this.mutate((state) => {
      const job = state.jobs[jobId];
      if (!job || job.businessId !== businessId || job.leaseOwner !== workerId || job.status !== 'processing') return false;
      job.leaseUntil = new Date(Date.now() + Math.max(1, leaseMs)).toISOString();
      job.updatedAt = new Date().toISOString();
      return true;
    });
  }

  async listRecoverableJobs() {
    const state = await this.readState();
    return Object.values(state.jobs).filter((job) => job.status === 'queued'
      || (job.status === 'processing' && (!job.leaseUntil || Date.parse(job.leaseUntil) <= Date.now())))
      .map((job) => ({ ...clone(job), document: clone(state.documents[job.documentId]) }));
  }

  pushEvent(state, job, event) {
    const saved = { eventId: event.eventId || randomUUID(), jobId: job.id, timestamp: event.timestamp || new Date().toISOString(), ...event };
    state.events[job.id] ||= [];
    state.events[job.id].push(saved);
    job.updatedAt = saved.timestamp;
    if (event.jobStatus) job.status = event.jobStatus;
    return saved;
  }

  async addJobEvent(businessId, jobId, event) {
    return this.mutate((state) => {
      const job = state.jobs[jobId];
      if (!job || job.businessId !== businessId) return null;
      return this.pushEvent(state, job, event);
    });
  }

  async setJobStatus(businessId, jobId, status, details = {}) {
    return this.mutate((state) => {
      const job = state.jobs[jobId];
      if (!job || job.businessId !== businessId) return null;
      job.status = status;
      if (status !== 'processing') { job.leaseOwner = null; job.leaseUntil = null; }
      Object.assign(job, details, { updatedAt: new Date().toISOString() });
      this.pushEvent(state, job, { type: 'job', agent: 'workflow', state: status, summary: details.summary || `Job ${status.replaceAll('_', ' ')}.`, jobStatus: status });
      return job;
    });
  }

  async persistProposal({ businessId, jobId, documentId, result, runId, inputVersion, workerId }) {
    return this.mutate((state) => {
      const document = state.documents[documentId];
      const job = state.jobs[jobId];
      if (!document || !job || document.businessId !== businessId || job.businessId !== businessId || job.documentId !== documentId) {
        throw new Error('Proposal scope does not match the stored document and job.');
      }
      if ((runId && job.runId !== runId) || (inputVersion && document.inputVersion !== inputVersion) || (workerId && job.leaseOwner !== workerId)) return { stale: true, document, job };
      const proposedDocument = result.document || result.analysis?.document || {};
      if (proposedDocument.linkedPoDocumentId) {
        const po = state.documents[proposedDocument.linkedPoDocumentId];
        const poDocument = po?.analysis?.document;
        if (!po || po.businessId !== businessId || (poDocument?.type !== 'purchase_order')) {
          throw Object.assign(new Error('The proposed PO link does not reference a purchase order in this business.'), { code: 'PO_LINK_SCOPE_MISMATCH' });
        }
        document.linkedPoDocumentId = po.id;
      }
      let persistedResult = result;
      if (document.linkedPoDocumentId && ['invoice', 'delivery_order'].includes(proposedDocument.type)) {
        const po = state.documents[document.linkedPoDocumentId];
        const poModel = {
          ...(po.analysis?.document || {}), documentId: po.id,
          sourceRef: { documentId: po.id, ...(po.analysis?.sourceReferences?.[0] || {}) },
        };
        const priorInvoices = Object.values(state.documents)
          .filter((item) => item.businessId === businessId && item.id !== documentId
            && item.linkedPoDocumentId === po.id && item.analysis?.document?.type === proposedDocument.type
            && !['failed', 'needs_configuration'].includes(item.status))
          .map((item) => ({ ...item.analysis.document, documentId: item.id, sourceRef: { documentId: item.id, ...(item.analysis?.sourceReferences?.[0] || {}) } }));
        const currentInvoice = { ...proposedDocument, documentId, sourceRef: { documentId, ...(persistedResult.analysis?.sourceReferences?.[0] || result.analysis?.sourceReferences?.[0] || {}) } };
        const balanceFindings = auditPoBalance(poModel, [...priorInvoices, currentInvoice])
          .filter((finding) => !(result.findings || []).some((existing) => existing.code === finding.code
            && (existing.sourceRefs || []).some((ref) => ref.documentId === documentId)));
        if (balanceFindings.length) persistedResult = {
          ...result, status: 'needs_review', canApprove: false,
          findings: [...(result.findings || []), ...balanceFindings],
        };
      }
      document.status = persistedResult.status;
      if (['purchasing', 'claim'].includes(persistedResult.workflow)) document.workflow = persistedResult.workflow;
      document.analysis = clone(persistedResult.analysis || { document: result.document || null, results: result.results || null });
      document.analysisVersion = Number(inputVersion || job.inputVersion || document.inputVersion) || 1;
      document.findings = clone(persistedResult.findings || []);
      document.updatedAt = new Date().toISOString();
      job.status = persistedResult.status;
      job.leaseOwner = null;
      job.leaseUntil = null;
      job.completedAt = new Date().toISOString();
      for (const finding of document.findings) {
        const stableKey = finding.stableKey || `${jobId}:${finding.code}:${JSON.stringify(finding.sourceRefs || [])}`;
        const existing = Object.values(state.issues).find((item) => item.stableKey === stableKey);
        if (existing) {
          existing.message = finding.message || existing.message;
          existing.sourceRefs = clone(finding.sourceRefs || []);
          existing.status = ['open', 'needs_review'].includes(finding.status) ? finding.status : 'open';
          existing.resolvedAt = null;
          existing.resolvedBy = null;
          existing.resolutionReason = null;
          continue;
        }
        const id = randomUUID();
        state.issues[id] = {
          id, stableKey, businessId, jobId, documentId, code: finding.code || 'REVIEW_REQUIRED',
          severity: finding.severity || 'warning', status: ['open', 'needs_review'].includes(finding.status) ? finding.status : 'open',
          message: finding.message || 'Review required.', sourceRefs: clone(finding.sourceRefs || []),
          expected: finding.expected ?? null, observed: finding.observed ?? null,
          createdAt: new Date().toISOString(), resolvedAt: null,
        };
      }
      this.pushEvent(state, job, { type: 'proposal_persisted', agent: 'documentation-db-agent', state: 'completed', summary: 'Validated proposal and findings were stored.', jobStatus: persistedResult.status });
      return { document, job };
    });
  }

  async getDocument(businessId, documentId) {
    const state = await this.readState();
    const document = state.documents[documentId];
    return document?.businessId === businessId ? clone(document) : null;
  }

  async updateDocumentStatus(businessId, documentId, status) {
    return this.mutate((state) => {
      const document = state.documents[documentId];
      if (!document || document.businessId !== businessId) return null;
      document.status = status;
      document.updatedAt = new Date().toISOString();
      return document;
    });
  }

  async queueReprocess(businessId, documentId, jobId) {
    return this.mutate((state) => {
      const document = state.documents[documentId]; const job = state.jobs[jobId];
      if (!document || !job || document.businessId !== businessId || job.businessId !== businessId || job.documentId !== documentId) return null;
      if (['queued', 'processing'].includes(job.status)) throw Object.assign(new Error('This document is already being processed.'), { code: 'JOB_ACTIVE' });
      if (document.status === 'approved') throw Object.assign(new Error('Approved documents cannot be reprocessed.'), { code: 'DOCUMENT_APPROVED' });
      const now = new Date().toISOString();
      const runId = randomUUID();
      job.runId = runId; job.inputVersion = Number(document.inputVersion) || 1; job.status = 'queued'; job.error = null;
      job.leaseOwner = null; job.leaseUntil = null; job.completedAt = null; job.updatedAt = now;
      document.status = 'queued'; document.updatedAt = now;
      this.pushEvent(state, job, { type: 'job', agent: 'workflow', state: 'queued', summary: 'Checks queued after a reviewer correction.', runId, inputVersion: job.inputVersion });
      return { document, job };
    });
  }

  async listDocuments(businessId) {
    const state = await this.readState();
    return Object.values(state.documents).filter((document) => document.businessId === businessId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  async listIssues(businessId) {
    const state = await this.readState();
    return Object.values(state.issues).filter((issue) => issue.businessId === businessId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  async getJob(businessId, jobId) {
    const state = await this.readState();
    const job = state.jobs[jobId];
    if (!job || job.businessId !== businessId) return null;
    return { ...clone(job), events: clone(state.events[jobId] || []) };
  }

  async getEvents(businessId, jobId) {
    const job = await this.getJob(businessId, jobId);
    return job?.events || null;
  }

  async recordCorrection(businessId, documentId, actorId, correction) {
    if (!correction?.field || typeof correction.field !== 'string' || !CORRECTABLE_FIELDS.has(correction.field)) throw new TypeError('Choose a supported extracted field to correct.');
    if (!correction.reason || String(correction.reason).trim().length < 3) throw new TypeError('A correction reason is required.');
    return this.mutate((state) => {
      const document = state.documents[documentId];
      if (!document || document.businessId !== businessId) return null;
      const currentJob = Object.values(state.jobs).find((item) => item.documentId === documentId && item.businessId === businessId);
      if (currentJob && ['queued', 'processing'].includes(currentJob.status)) throw Object.assign(new Error('Wait for the current document check to finish before editing it.'), { code: 'JOB_ACTIVE' });
      if (document.status === 'approved') throw Object.assign(new Error('Approved documents cannot be edited.'), { code: 'DOCUMENT_APPROVED' });
      const previousValue = document.manualOverrides?.[correction.field] ?? document.analysis?.document?.[correction.field] ?? null;
      document.manualOverrides ||= {};
      document.manualOverrides[correction.field] = clone(correction.value);
      document.inputVersion = (Number(document.inputVersion) || 1) + 1;
      document.status = 'needs_review';
      document.updatedAt = new Date().toISOString();
      document.manualOverrideMetadata ||= {};
      document.manualOverrideMetadata[correction.field] = { actorId, reason: String(correction.reason).trim(), inputVersion: document.inputVersion, createdAt: document.updatedAt };
      const entry = { id: randomUUID(), businessId, documentId, actorId, previousValue: clone(previousValue), ...clone(correction), createdAt: document.updatedAt, inputVersion: document.inputVersion };
      state.corrections.push(entry);
      const job = Object.values(state.jobs).find((item) => item.documentId === documentId && item.businessId === businessId);
      if (job) this.pushEvent(state, job, { type: 'field_corrected', agent: 'human-review', state: 'completed', summary: `${correction.field} was corrected by a reviewer.`, actorId, inputVersion: document.inputVersion });
      return document;
    });
  }

  async resolveIssue(businessId, issueId, actorId, reason) {
    return this.setIssueStatus(businessId, issueId, actorId, 'resolved', reason);
  }

  async setIssueStatus(businessId, issueId, actorId, status, reason) {
    if (!['open', 'needs_review', 'resolved', 'dismissed'].includes(status)) throw new TypeError('Choose a valid issue status.');
    if (!reason || String(reason).trim().length < 3) throw new TypeError('A resolution reason is required.');
    return this.mutate((state) => {
      const issue = state.issues[issueId];
      if (!issue || issue.businessId !== businessId) return null;
      const previousStatus = issue.status;
      issue.status = status;
      issue.resolvedAt = ['resolved', 'dismissed'].includes(status) ? new Date().toISOString() : null;
      issue.resolvedBy = actorId;
      issue.resolutionReason = String(reason).trim();
      const job = state.jobs[issue.jobId];
      if (job) this.pushEvent(state, job, { type: status === 'resolved' ? 'issue_resolved' : 'issue_status_changed', agent: 'human-review', state: 'completed', summary: `Issue ${issue.code} changed from ${previousStatus} to ${status}.`, actorId, issueId, reason: issue.resolutionReason });
      return issue;
    });
  }

  async rejectDocument(businessId, documentId, actorId, reason) {
    if (!reason || String(reason).trim().length < 3) throw new TypeError('A rejection reason is required.');
    return this.mutate((state) => {
      const document = state.documents[documentId];
      if (!document || document.businessId !== businessId) return null;
      if (document.status === 'approved') throw Object.assign(new Error('Approved documents cannot be rejected.'), { code: 'DOCUMENT_APPROVED' });
      const job = Object.values(state.jobs).find((item) => item.businessId === businessId && item.documentId === documentId);
      if (job && ['queued', 'processing'].includes(job.status)) throw Object.assign(new Error('Wait for processing to finish before rejecting this document.'), { code: 'JOB_ACTIVE' });
      document.status = 'rejected'; document.rejectionReason = String(reason).trim(); document.rejectedBy = actorId; document.rejectedAt = new Date().toISOString(); document.updatedAt = document.rejectedAt;
      if (job) this.pushEvent(state, job, { type: 'document_rejected', agent: 'human-review', state: 'completed', summary: 'Document was rejected by a reviewer.', actorId, reason: document.rejectionReason });
      return document;
    });
  }

  async approveDocument(businessId, documentId, actorId) {
    return this.mutate((state) => {
      const document = state.documents[documentId];
      if (!document || document.businessId !== businessId) return null;
      const open = Object.values(state.issues).some((issue) => issue.businessId === businessId && issue.documentId === documentId && !['resolved', 'dismissed'].includes(issue.status));
      if (open) throw Object.assign(new Error('Resolve all open issues before approval.'), { code: 'OPEN_ISSUES' });
      if (!document.analysis || !['completed', 'needs_review'].includes(document.status)) throw Object.assign(new Error('The document has no completed analysis to approve.'), { code: 'ANALYSIS_REQUIRED' });
      if (Number(document.analysisVersion) !== Number(document.inputVersion)) throw Object.assign(new Error('The latest correction has not been rechecked yet.'), { code: 'ANALYSIS_STALE' });
      document.status = 'approved';
      document.approvedBy = actorId;
      document.approvedAt = new Date().toISOString();
      document.updatedAt = document.approvedAt;
      const job = Object.values(state.jobs).find((item) => item.businessId === businessId && item.documentId === documentId);
      if (job) this.pushEvent(state, job, { type: 'document_approved', agent: 'human-review', state: 'completed', summary: 'Document was approved by a reviewer.', actorId });
      return document;
    });
  }

  async resolveBusiness({ userId, email }) {
    if (!userId || !email) throw new TypeError('Authenticated user identity is required.');
    const key = createHash('sha256').update(String(userId)).digest('hex');
    return this.mutate((state) => {
      if (!state.businesses[key]) state.businesses[key] = { businessId: `business-${key.slice(0, 24)}`, userId, email: String(email).toLowerCase(), role: 'owner', createdAt: new Date().toISOString() };
      return state.businesses[key];
    });
  }

  async getMasterData(businessId) {
    const state = await this.readState();
    return clone(state.masterData?.[businessId] || { chartOfAccounts: [], suppliers: [], buyerProfile: null });
  }

  async saveMasterData(businessId, input) {
    const chartOfAccounts = Array.isArray(input?.chartOfAccounts) ? input.chartOfAccounts : [];
    const suppliers = Array.isArray(input?.suppliers) ? input.suppliers : [];
    const codes = chartOfAccounts.map((account) => String(account.code || '').trim());
    if (chartOfAccounts.length > 500 || suppliers.length > 2000) throw Object.assign(new Error('Master data is too large.'), { status: 413 });
    if (codes.some((code) => !code || code.length > 40) || new Set(codes).size !== codes.length) throw new TypeError('Chart of accounts codes must be present, unique, and under 40 characters.');
    if (chartOfAccounts.some((account) => !String(account.label || '').trim() || String(account.label).length > 200)) throw new TypeError('Each chart-of-accounts entry needs a label under 200 characters.');
    if (suppliers.some((supplier) => !String(supplier.legalName || '').trim() || String(supplier.legalName).length > 250)) throw new TypeError('Each supplier needs a legal name under 250 characters.');
    const buyerProfile = input?.buyerProfile && String(input.buyerProfile.legalName || '').trim()
      ? { legalName: String(input.buyerProfile.legalName).trim().slice(0, 250), registrationNumber: String(input.buyerProfile.registrationNumber || '').slice(0, 100) }
      : null;
    const saved = {
      chartOfAccounts: chartOfAccounts.map((account) => ({ code: String(account.code).trim(), label: String(account.label).trim(), active: account.active !== false })),
      suppliers: suppliers.map((supplier) => ({ id: String(supplier.id || randomUUID()), legalName: String(supplier.legalName).trim(), registrationNumber: String(supplier.registrationNumber || '').slice(0, 100), active: supplier.active !== false })),
      buyerProfile,
      updatedAt: new Date().toISOString(),
    };
    return this.mutate((state) => {
      state.masterData ||= {};
      state.masterData[businessId] = saved;
      return saved;
    });
  }
}

module.exports = { LocalStore, CORRECTABLE_FIELDS };
