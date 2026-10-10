const { createAgentRunner } = require('./agents/runner');
const { createAIProvider } = require('./ai/provider');
const { extractDocument } = require('./ingest/ocr');
const { runDocumentWorkflow } = require('./workflow/orchestrator');
const { validateExtractedDocument } = require('./domain/schema');
const { auditPartyMaster, auditPurchaseChain } = require('./domain/audit');

function createProcessor({ env = process.env, provider = createAIProvider(env), runAgent, extract = extractDocument, maxConcurrency = 4 } = {}) {
  const agent = runAgent || createAgentRunner({ provider });
  return async function processDocument({ document, job, bytes, emit = async () => {}, store }) {
    await emit({ agent: 'ocr-engine', state: 'started', summary: 'Reading the uploaded file and locating source lines.' });
    const extracted = await extract({ filename: document.originalFilename, bytes, mimeType: document.mimeType });
    await emit({ agent: 'ocr-engine', state: 'completed', summary: `Read ${extracted.sourceRefs?.length || 0} source references from the upload.`, sourceReferenceCount: extracted.sourceRefs?.length || 0 });

    const existingDocuments = store ? (await store.listDocuments(document.businessId))
      .filter((item) => item.id !== document.id && item.analysis?.document)
      .map((item) => {
        const extractedDocument = item.analysis.document;
        return {
          ...extractedDocument,
          ...(extractedDocument.type === 'purchase_order' ? { poNumber: extractedDocument.poNumber || extractedDocument.documentNumber } : {}),
          ...(extractedDocument.type === 'invoice' ? { invoiceNumber: extractedDocument.invoiceNumber || extractedDocument.documentNumber } : {}),
          documentId: item.id, workflow: item.workflow, status: item.status,
          linkedPoDocumentId: extractedDocument.linkedPoDocumentId,
            sourceRef: { documentId: item.id, ...(item.analysis?.sourceReferences?.[0] || {}) },
        };
      }) : [];
    const masterData = store?.getMasterData ? await store.getMasterData(document.businessId) : { chartOfAccounts: [], suppliers: [], buyerProfile: null };
    const safeDocument = {
      id: document.id,
      inputVersion: document.inputVersion || job.inputVersion || 1,
      runId: job.runId || null,
      workflow: document.workflow,
      routeMode: document.routeMode || 'manual',
      purpose: document.manualOverrides?.purpose ?? document.purpose ?? '',
      manualOverrides: document.manualOverrides || {},
      manualOverrideMetadata: document.manualOverrideMetadata || {},
      originalFilename: document.originalFilename,
      mimeType: document.mimeType,
      fileMetadata: { filename: document.originalFilename, mimeType: document.mimeType, sizeBytes: bytes.length, kind: extracted.kind },
    };
    const workflowResult = await runDocumentWorkflow({
      job, document: safeDocument, purpose: safeDocument.purpose, extracted,
      extractedText: extracted.text, rows: extracted.rows || [], sourceRefs: extracted.sourceRefs || [],
      existingDocuments, chartOfAccounts: masterData.chartOfAccounts || [], supplierRecords: masterData.suppliers || [], buyerProfile: masterData.buyerProfile || null,
    }, { runAgent: agent, onEvent: emit, maxConcurrency });

    if (workflowResult.status === 'failed' || workflowResult.status === 'needs_configuration') return workflowResult;
    const proposed = { ...(workflowResult.document || {}), ...(document.manualOverrides || {}), documentId: document.id };
    const findings = [...(workflowResult.findings || [])];
    const writingResult = workflowResult.results?.['writing-agent']?.data || {};
    const standardizedDescription = writingResult.standardizedDescription || writingResult.proposedDescription || writingResult.description;
    if (standardizedDescription && !document.manualOverrides?.standardizedDescription) {
      proposed.standardizedDescription = standardizedDescription;
      const writingRefs = writingResult.sourceRefs || writingResult.sourceReferences || [];
      const sourceMap = proposed.fieldSources || (proposed.fieldSources = {});
      const fieldsUsed = Array.isArray(writingResult.fieldsUsed) ? writingResult.fieldsUsed : [];
      const derivedRefs = fieldsUsed.flatMap((field) => {
        const name = typeof field === 'string' ? field : field?.field;
        return name ? (sourceMap[name] || (field?.sourceRefs || [])) : [];
      });
      const allExistingRefs = Object.values(sourceMap).flatMap((refs) => Array.isArray(refs) ? refs : []);
      const refs = writingRefs.length ? writingRefs : derivedRefs.length ? derivedRefs : allExistingRefs;
      if (refs.length) sourceMap.standardizedDescription = normalizeSourceRefs(document.id, refs);
    }
    if (extracted.truncated) findings.push({
      code: 'DOCUMENT_CONTENT_TRUNCATED', severity: 'warning', status: 'open',
      message: 'Only part of this file was provided to the agent checks. Review the original file or split it before relying on the results.',
      sourceRefs: sourceRefsFor(document.id, extracted.sourceRefs), expected: 'The full document contents', observed: `Input limit reached (${extracted.rowCount ?? extracted.text?.length ?? 0} rows/characters available)`,
    });

    if (document.duplicateOf) findings.push({
      code: 'DUPLICATE_FILE_CONTENT', severity: 'warning', status: 'open',
      message: `This upload has the same file hash as previously uploaded document ${document.duplicateOf}. Confirm whether it is a duplicate before approving.`,
      sourceRefs: [{ documentId: document.id }, { documentId: document.duplicateOf }], expected: 'A unique source document', observed: 'Identical file content',
    });

    if (workflowResult.workflow === 'purchasing') findings.push(...auditPartyMaster({ ...proposed, documentId: document.id }, masterData));

    if (workflowResult.workflow === 'purchasing' && !['purchase_order', 'quotation'].includes(proposed.type)) {
      const poLink = workflowResult.results?.['purchasing-agent']?.data?.poLink || {};
      const decision = typeof poLink === 'string' ? poLink : poLink.decision || poLink.status;
      const poDocumentId = typeof poLink === 'object' ? poLink.poDocumentId || poLink.documentId : null;
      const purchaseOrder = decision === 'matched' && poDocumentId
        ? existingDocuments.find((item) => item.documentId === poDocumentId && item.type === 'purchase_order') : null;
      if (purchaseOrder) proposed.linkedPoDocumentId = purchaseOrder.documentId;
      else if (decision === 'candidate' || decision === 'needs_review') findings.push({
        code: 'PURCHASE_PO_MATCH_REVIEW', severity: 'warning', status: 'open',
        message: 'The document has a possible PO match, but the link is not confirmed. Review the candidate before approving.',
        sourceRefs: [{ documentId: document.id }, ...(poDocumentId ? [{ documentId: poDocumentId }] : [])],
        expected: 'A confirmed existing PO', observed: decision,
      });
      const current = {
        ...proposed,
        ...(proposed.type === 'purchase_order' ? { poNumber: proposed.poNumber || proposed.documentNumber } : {}),
        ...(proposed.type === 'invoice' ? { invoiceNumber: proposed.invoiceNumber || proposed.documentNumber } : {}),
        documentId: document.id, sourceRef: { documentId: document.id, ...(extracted.sourceRefs?.[0] || {}) },
      };
      const chainDocs = existingDocuments.filter((item) => item.documentId === purchaseOrder?.documentId
        || item.linkedPoDocumentId === purchaseOrder?.documentId
        || (purchaseOrder?.poNumber && item.poNumber === purchaseOrder.poNumber));
      findings.push(...auditPurchaseChain(purchaseOrder || null, [...chainDocs, current]));
      if (decision === 'matched' && !purchaseOrder) findings.push({
        code: 'PURCHASE_PO_LINK_UNVERIFIED', severity: 'warning', status: 'open',
        message: 'The agent proposed a PO link that is not an existing purchase-order record in this business. The link was not saved.',
        sourceRefs: [{ documentId: document.id }, ...(poDocumentId ? [{ documentId: poDocumentId }] : [])],
        expected: 'An existing purchase-order document in this business', observed: poDocumentId || 'No PO document ID',
      });
    }

    if (workflowResult.workflow === 'claim' && workflowResult.results?.['council-of-agents']) {
      const category = workflowResult.results['council-of-agents'].data || {};
      const proposedCode = category.accountCode || category.proposedAccountCode || category.category?.code;
      const isAllowedCode = (code) => masterData.chartOfAccounts.some((account) => account.active !== false && account.code === code);
      if (proposedCode && !isAllowedCode(proposedCode)) {
        findings.push({
          code: 'CLAIM_ACCOUNT_CODE_NOT_ALLOWED', severity: 'error', status: 'needs_review',
          message: `The suggested account code ${proposedCode} is not in the active company chart of accounts. The code was not accepted.`,
          sourceRefs: [{ documentId: document.id }], expected: masterData.chartOfAccounts.filter((account) => account.active !== false).map((account) => account.code), observed: proposedCode,
        });
        if (proposed.accountCode === proposedCode) delete proposed.accountCode;
      } else if (proposedCode) {
        proposed.accountCode = proposedCode;
        proposed.fieldSources ||= {};
        const opinionRefs = (category.opinions || []).flatMap((opinion) => opinion.sourceRefs || opinion.evidenceRefs || []);
        proposed.fieldSources.accountCode = opinionRefs.length ? opinionRefs : sourceRefsFor(document.id, extracted.sourceRefs);
      }
      if (Object.hasOwn(document.manualOverrides || {}, 'accountCode')) proposed.accountCode = document.manualOverrides.accountCode;
    }
    if (workflowResult.workflow === 'claim' && proposed.accountCode && !masterData.chartOfAccounts.some((account) => account.active !== false && account.code === proposed.accountCode)) {
      if (!findings.some((finding) => finding.code === 'CLAIM_ACCOUNT_CODE_NOT_ALLOWED' && finding.observed === proposed.accountCode)) findings.push({
        code: 'CLAIM_ACCOUNT_CODE_NOT_ALLOWED', severity: 'error', status: 'needs_review',
        message: `Account code ${proposed.accountCode} is not in the active company chart of accounts. It was not accepted.`,
        sourceRefs: [{ documentId: document.id }], expected: masterData.chartOfAccounts.filter((account) => account.active !== false).map((account) => account.code), observed: proposed.accountCode,
      });
      delete proposed.accountCode;
    }
    const validation = validateExtractedDocument(proposed);
    for (const error of validation.errors) {
      findings.push({
        code: 'EXTRACTION_VALIDATION_FAILED', severity: 'warning', status: 'open', message: error,
        sourceRefs: sourceRefsFor(document.id, extracted.sourceRefs), expected: 'A complete, valid extraction', observed: error,
      });
    }

    const sourceMap = proposed.fieldSources || {};
    for (const [field, value] of Object.entries(proposed)) {
      if (['fieldSources', 'uncertainty', 'confidence', 'sourceRef', 'documentId', 'linkedPoDocumentId'].includes(field) || value === null || value === undefined || value === '') continue;
      const correction = document.manualOverrideMetadata?.[field];
      const refs = correction ? [{ kind: 'human_correction', actorId: correction.actorId, reason: correction.reason, inputVersion: correction.inputVersion }] : sourceMap[field];
      if (correction) sourceMap[field] = refs;
      if (!Array.isArray(refs) || refs.length === 0) {
        findings.push({
          code: 'EXTRACTION_PROVENANCE_MISSING', severity: 'warning', status: 'open',
          message: `The extracted value for ${field} has no source reference. Verify it against the uploaded document.`,
          sourceRefs: sourceRefsFor(document.id, extracted.sourceRefs), expected: 'A source page, row, or line for this value', observed: field,
        });
      }
    }
    proposed.fieldSources = sourceMap;
    if (workflowResult.status === 'needs_review' && findings.length === 0) findings.push({
      code: 'AGENT_REVIEW_REQUIRED', severity: 'warning', status: 'open',
      message: 'An agent requested human review but did not provide a specific finding. Review the extraction and linked documents before approval.',
      sourceRefs: [{ documentId: document.id }], expected: 'A clear review finding', observed: 'Agent requested review without details',
    });
    const status = workflowResult.status === 'needs_review' || findings.length > 0 ? 'needs_review' : 'completed';
    await emit({ agent: 'deterministic-validation', state: validation.valid && findings.length === (workflowResult.findings || []).length ? 'completed' : 'needs_review', summary: validation.valid ? 'Required fields and deterministic amount checks ran.' : 'Some required fields or amounts need human review.' });
    return {
      status,
      workflow: workflowResult.workflow,
      document: proposed,
      findings,
      agentResults: workflowResult.results,
      analysis: { document: proposed, agentResults: workflowResult.results, sourceReferences: extracted.sourceRefs || [], ocrKind: extracted.kind },
      canApprove: status === 'completed',
    };
  };
}

function sourceRefsFor(documentId, refs = []) {
  return normalizeSourceRefs(documentId, refs);
}

function normalizeSourceRefs(documentId, refs = []) {
  const values = Array.isArray(refs) ? refs : [];
  if (!values.length) return [{ documentId }];
  const unique = new Map();
  for (const ref of values) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
    const normalized = { ...ref, documentId: ref.documentId || documentId };
    unique.set(JSON.stringify(normalized), normalized);
  }
  return unique.size ? [...unique.values()] : [{ documentId }];
}

module.exports = { createProcessor };
