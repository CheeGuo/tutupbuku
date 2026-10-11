const TYPE_KEYS = {
  quotation: ['quotation_no', 'Quotation number'],
  purchase_order: ['po_no', 'PO number'],
  delivery_order: ['do_no', 'DO number'],
  invoice: ['invoice_no', 'Invoice number'],
  payment_advice: ['advice_no', 'Payment advice number'],
  payment_receipt: ['receipt_no', 'Payment receipt number'],
  claim_receipt: ['receipt_ref', 'Receipt reference'],
};

const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const first = (...values) => values.find((value) => value !== null && value !== undefined && value !== '');
const safeSen = (value) => Number.isSafeInteger(value) ? value : undefined;
const asText = (value) => value === null || value === undefined ? '' : String(value);
const statusOf = (document, issues) => {
  const status = String(document.status || '').toLowerCase();
  if (status === 'approved') return 'VERIFIED';
  if (status === 'rejected') return 'REJECTED';
  if (status === 'queued' || status === 'processing' || status === 'needs_configuration' || status === 'failed') return 'UPLOADED';
  if (status === 'needs_review'
    || issues.some((issue) => !['resolved', 'dismissed'].includes(String(issue.status || '').toLowerCase()))) return 'NEEDS_REVIEW';
  return 'EXTRACTED';
};

function field(key, label, kind, value, sources) {
  const result = { key, label, kind, value: kind === 'money' ? '' : asText(value) };
  if (kind === 'money') result.sen = safeSen(value);
  if (Array.isArray(sources) && sources.length) result.provenance = sources;
  return result;
}

function projectDocument(document, documentIssues, email) {
  const analysis = asObject(document.analysis);
  const extracted = asObject(analysis.document || analysis);
  let type = String(first(extracted.type, document.type, 'unclassified')).toLowerCase();
  if (type === 'receipt') type = document.workflow === 'claim' ? 'claim_receipt' : 'payment_receipt';
  if (!Object.hasOwn(TYPE_KEYS, type)) type = 'unclassified';

  const fieldSources = asObject(extracted.fieldSources);
  const number = first(extracted.documentNumber, extracted.invoiceNumber, extracted.poNumber, extracted.quotationNumber, extracted.deliveryOrderNumber, extracted.receiptNumber, extracted.paymentReference);
  const party = document.workflow === 'claim'
    ? first(extracted.merchantName, extracted.supplierName)
    : first(extracted.supplierName, extracted.buyerName, extracted.merchantName);
  const amount = first(extracted.totalAmountSen, extracted.grandTotalSen, extracted.amountSen);
  const tax = first(extracted.taxAmountSen, extracted.taxSen);
  const [numberKey, numberLabel] = TYPE_KEYS[type] || ['document_no', 'Document number'];
  const fields = [
    field(numberKey, numberLabel, 'text', number, fieldSources.documentNumber || fieldSources.invoiceNumber || fieldSources.poNumber),
    field('date', 'Date', 'date', first(extracted.documentDate, extracted.date), fieldSources.documentDate || fieldSources.date),
    field(document.workflow === 'claim' ? 'merchant' : 'supplier', document.workflow === 'claim' ? 'Merchant' : 'Supplier', 'text', party, fieldSources.merchantName || fieldSources.supplierName),
    field(type === 'claim_receipt' ? 'total' : type === 'payment_advice' || type === 'payment_receipt' ? 'amount' : 'grand_total', 'Total', 'money', amount, fieldSources.totalAmountSen || fieldSources.grandTotalSen || fieldSources.amountSen),
    field('due_date', 'Due date', 'date', extracted.dueDate, fieldSources.dueDate),
    field('tax', 'Tax', 'money', tax, fieldSources.taxAmountSen || fieldSources.taxSen),
  ];
  const lines = Array.isArray(extracted.lines) ? extracted.lines.filter((line) => line && typeof line === 'object').map((line, index) => {
    const quantity = Number.isFinite(line.quantity) ? line.quantity : null;
    const unitSen = safeSen(first(line.unitAmountSen, line.unitPriceSen, line.unitSen));
    const suppliedTotal = safeSen(first(line.totalAmountSen, line.lineTotalSen, line.totalSen));
    return {
      id: String(line.id || `${document.id}-line-${index + 1}`),
      description: asText(first(line.description, line.item, line.name)),
      quantity,
      unitSen: unitSen === undefined ? null : unitSen,
      totalSen: suppliedTotal === undefined ? (quantity !== null && unitSen !== undefined ? Math.round(quantity * unitSen) : null) : suppliedTotal,
    };
  }) : [];
  const doc = {
    id: String(document.id), docType: type, flow: document.workflow === 'claim' ? 'claims' : 'purchasing',
    filename: asText(document.originalFilename || document.filename), fields, lines,
    status: statusOf(document, documentIssues), hash: asText(document.sha256), version: Number(document.inputVersion) || 1,
    uploadedAt: asText(document.createdAt || document.uploadedAt), uploadedBy: asText(document.uploadedByEmail || document.employeeName || email || 'Workspace member'),
    rawStatus: asText(document.status), jobId: asText(document.jobId), inputVersion: Number(document.inputVersion) || 1,
    analysisVersion: Number(document.analysisVersion) || 0, purpose: asText(document.purpose || extracted.purpose),
    sourceReferences: Array.isArray(analysis.sourceReferences) ? analysis.sourceReferences : [],
  };
  if (document.rejectionReason) doc.note = String(document.rejectionReason);
  return { doc, extracted, documentIssues };
}

function projectIssue(issue, docById) {
  const refs = Array.isArray(issue.sourceRefs) ? issue.sourceRefs : [];
  const docIds = [...new Set([issue.documentId, ...refs.map((ref) => ref && typeof ref === 'object' ? ref.documentId : null)].filter((id) => typeof id === 'string' && id.length))];
  const severity = String(issue.severity || '').toLowerCase();
  const status = String(issue.status || '').toLowerCase();
  const expected = issue.expected === null || issue.expected === undefined ? '' : asText(issue.expected);
  const observed = issue.observed === null || issue.observed === undefined ? '' : asText(issue.observed);
  const relatedDoc = docById.get(String(issue.documentId || docIds[0] || ''));
  return {
    id: String(issue.id), ruleCode: asText(issue.code || 'REVIEW_REQUIRED'),
    typeLabel: asText(issue.code || 'Review required').replaceAll('_', ' ').toLowerCase(),
    title: asText(issue.message || 'Review required.'),
    severity: ['error', 'high', 'critical'].includes(severity) ? 'HIGH' : severity === 'info' ? 'INFO' : 'WARNING',
    status: status === 'resolved' ? 'RESOLVED' : status === 'dismissed' ? 'DISMISSED' : status === 'needs_review' ? 'UNDER_REVIEW' : 'OPEN',
    docIds,
    ...(relatedDoc?.doc.flow === 'claims' ? { claimId: `CLM-${relatedDoc.doc.id}` } : {}),
    ...(typeof issue.field === 'string' ? { fieldKey: issue.field } : {}),
    ...(Array.isArray(issue.candidateIds) ? { candidateIds: issue.candidateIds } : {}),
    detected: asText(issue.message || 'Review required.'),
    why: expected || observed ? `Expected: ${expected || 'Not supplied'}. Found: ${observed || 'Not supplied'}.` : asText(issue.message || 'Review the source evidence.'),
    suggested: issue.requiredAction ? [asText(issue.requiredAction)] : [],
    evidence: [
      ...(expected ? [{ label: 'Expected', found: expected }] : []),
      ...(observed ? [{ label: 'Observed', found: observed }] : []),
      ...refs.map((ref) => ref && typeof ref === 'object' ? { label: asText(ref.label || ref.kind || 'Source'), found: asText(ref.page || ref.row || ref.line || ref.documentId || '') } : null).filter(Boolean),
    ],
    createdAt: asText(issue.createdAt),
    ...(issue.resolutionReason ? { resolution: asText(issue.resolutionReason) } : {}),
  };
}

export function projectBackendRecords({ documents = [], issues = [], jobs = [], masterData = {}, email = '' } = {}) {
  const issueByDocument = new Map();
  for (const issue of issues) {
    const key = String(issue.documentId || '');
    if (!issueByDocument.has(key)) issueByDocument.set(key, []);
    issueByDocument.get(key).push(issue);
  }
  const jobByDocument = new Map(jobs.filter((job) => job && job.documentId).map((job) => [String(job.documentId), job]));
  const projected = documents.filter((document) => document && document.id).map((document) => {
    const record = projectDocument({ ...document, jobId: jobByDocument.get(String(document.id))?.id }, issueByDocument.get(String(document.id)) || [], email);
    return record;
  });
  const docById = new Map(projected.map(({ doc }) => [doc.id, { doc }]));
  const projectedIssues = issues.filter(Boolean).map((issue) => projectIssue(issue, docById));
  const links = [];
  for (const projectedRecord of projected) {
    const { doc, extracted, documentIssues } = projectedRecord;
    const poId = first(extracted.linkedPoDocumentId, extracted.purchaseOrderDocumentId);
    if (poId && String(poId) !== doc.id && docById.has(String(poId))) {
      const confidence = typeof extracted.linkConfidence === 'number' ? extracted.linkConfidence : undefined;
      links.push({ id: `LNK-${doc.id}-${poId}`, sourceId: doc.id, targetId: String(poId), relationship: 'for_po', ...(confidence === undefined ? {} : { confidence }), confirmedBy: null });
    }
    const issueMessages = documentIssues.map((issue) => asText(issue.message)).filter(Boolean);
    if (doc.flow === 'claims') {
      const approved = doc.rawStatus.toLowerCase() === 'approved';
      const rejected = doc.rawStatus.toLowerCase() === 'rejected';
      const activeIssues = documentIssues.some((issue) => !['resolved', 'dismissed'].includes(String(issue.status || '').toLowerCase()));
      const claimData = extracted;
      const confidence = typeof claimData.accountCodeConfidence === 'number' ? claimData.accountCodeConfidence : null;
      const claim = {
        id: `CLM-${doc.id}`, employee: asText(claimData.employeeName || 'Employee claim'), receiptDocId: doc.id,
        employeePurpose: asText(doc.purpose || claimData.purpose),
        categoryCode: typeof claimData.accountCode === 'string' ? claimData.accountCode : null,
        categoryConfidence: confidence,
        categoryReasoning: asText(claimData.accountCodeReasoning), alternativeCodes: [],
        standardizedDescription: asText(claimData.standardizedDescription), findings: issueMessages,
        status: approved ? 'APPROVED' : rejected ? 'REJECTED' : doc.rawStatus.toLowerCase() === 'needs_review' || activeIssues ? 'NEEDS_REVIEW' : 'PLAUSIBLE',
      };
      if (approved && doc.approvedAt) claim.decision = { by: 'Reviewer', at: doc.approvedAt };
      if (rejected && doc.rejectedAt) claim.decision = { by: 'Reviewer', at: doc.rejectedAt, reason: asText(doc.note) };
      projectedRecord.claim = claim;
    }
  }
  const claims = projected.map(({ claim }) => claim).filter(Boolean);
  const audit = [];
  for (const job of jobs) for (const event of Array.isArray(job.events) ? job.events : []) {
    audit.push({
      id: asText(event.eventId || `${job.id}-${event.timestamp}`), timestamp: asText(event.timestamp),
      actor: event.actorId ? 'Reviewer' : asText(event.agent || 'Workflow'), actorKind: event.actorId ? 'human' : 'agent',
      action: asText(event.summary || event.type || event.state || 'Processing event'), entityId: asText(event.issueId || event.documentId || job.documentId || job.id),
    });
  }
  for (const issue of issues) if (issue.resolvedAt && issue.resolutionReason) {
    audit.push({ id: `issue-${issue.id}-${issue.resolvedAt}`, timestamp: issue.resolvedAt, actor: 'Reviewer', actorKind: 'human', action: asText(issue.resolutionReason), entityId: asText(issue.id) });
  }
  const accounts = (Array.isArray(masterData.chartOfAccounts) ? masterData.chartOfAccounts : [])
    .filter((account) => account && account.active !== false && account.code)
    .map((account) => ({ code: asText(account.code), name: asText(account.label || account.name) }));
  return { docs: projected.map(({ doc }) => doc), links, claims, issues: projectedIssues, audit, masterData: { ...masterData, chartOfAccounts: accounts } };
}
