const { randomUUID } = require('node:crypto');
const { mapConcurrent } = require('./concurrency');
const { auditClaimRelevance } = require('../domain/audit');

const AGENT_NAMES = Object.freeze([
  'master-agent', 'docs-agent', 'supplier-buyer-verification-agent', 'purchasing-agent',
  'verify-audit-agent', 'claims-verification-agent', 'council-of-agents', 'writing-agent',
  'documentation-db-agent',
]);

async function runDocumentWorkflow(context, services = {}) {
  const { runAgent, onEvent = async () => {}, maxConcurrency = 4 } = services;
  if (typeof runAgent !== 'function') throw new TypeError('runAgent service is required');
  const job = context.job || {};
  const document = context.document || {};
  const results = {};
  const domainFindings = [];
  const progress = async (agent, state, summary, extra = {}) => onEvent({
    eventId: randomUUID(), jobId: job.id, documentId: document.id, agent, state, summary,
    timestamp: new Date().toISOString(), ...extra,
  });
  const execute = async (name, input = {}, resultKey = name) => {
    const perspective = input.perspective || input.partyType || null;
    const progressMeta = perspective ? { perspective } : {};
    await progress(name, 'started', perspective ? `${name.replaceAll('-', ' ')} started: ${perspective}.` : `${name.replaceAll('-', ' ')} started.`, progressMeta);
    try {
      const result = await runAgent(name, {
        ...context,
        ...input,
        jobId: job.id,
        documentId: document.id,
        taskId: randomUUID(),
      });
      if (!result || !['completed', 'needs_review'].includes(result.status)) {
        throw new Error(`${name} returned an invalid agent status.`);
      }
      results[resultKey] = result;
      await progress(name, result.status, result.summary || `${name.replaceAll('-', ' ')} ${result.status.replaceAll('_', ' ')}.`, progressMeta);
      return result;
    } catch (error) {
      await progress(name, 'failed', `${name.replaceAll('-', ' ')} could not finish.`, { errorCode: error.code || 'AGENT_FAILED' });
      throw error;
    }
  };

  try {
    const master = await execute('master-agent', {
      stage: 'route', file: document.fileMetadata || {}, routeMode: document.routeMode || 'manual',
      requestedWorkflow: document.routeMode === 'automatic' ? 'automatic' : document.workflow,
    });
    const workflow = (document.routeMode || 'manual') === 'automatic' ? master.data?.workflow : document.workflow;
    if (!['purchasing', 'claim'].includes(workflow)) throw Object.assign(new Error('The document workflow is uncertain; choose purchasing or claim to continue.'), { code: 'ROUTE_UNCERTAIN' });
    if ((document.routeMode || 'manual') === 'manual' && ['purchasing', 'claim'].includes(master.data?.workflow) && master.data.workflow !== workflow) {
      domainFindings.push({
        code: 'DOCUMENT_WORKFLOW_SELECTION_MISMATCH', severity: 'warning', status: 'needs_review',
        message: `The content appears to follow the ${master.data.workflow} flow, while the uploader selected ${workflow}. Confirm the correct workflow before approval.`,
        sourceRefs: [{ documentId: document.id, ...(context.sourceRefs?.[0] || {}) }],
        expected: workflow, observed: master.data.workflow,
      });
    }
    const docs = await execute('docs-agent', { stage: 'extract', workflow, routing: master.data || {} });
    const proposedDocument = docs.data?.document || {};
    const joined = { workflow, document: proposedDocument, routing: master.data || {} };

    if (workflow === 'purchasing') {
      const parties = await mapConcurrent([
        { type: 'supplier', key: 'supplier-party-check' },
        { type: 'buyer', key: 'buyer-party-check' },
        { type: 'purchasing', key: 'purchasing-agent' },
      ], maxConcurrency, async (task) => task.type === 'purchasing'
        ? execute('purchasing-agent', { stage: 'match', ...joined }, task.key)
        : execute('supplier-buyer-verification-agent', { stage: 'verify-party', partyType: task.type, ...joined }, task.key));
      const supplierResult = parties[0];
      const buyerResult = parties[1];
      const purchasing = parties[2];
      const supplierCheck = supplierResult.data?.supplierCheck || supplierResult.data || {};
      const buyerCheck = buyerResult.data?.buyerCheck || buyerResult.data || {};
      const identityFindings = [...(supplierResult.findings || []), ...(buyerResult.findings || [])];
      results['supplier-buyer-verification-agent'] = {
        agent: 'supplier-buyer-verification-agent',
        status: [supplierResult, buyerResult].some((result) => result.status === 'needs_review') ? 'needs_review' : 'completed',
        summary: 'Supplier and buyer records were checked independently.',
        data: { supplierCheck, buyerCheck }, findings: identityFindings,
      };
      joined.identityCheck = { supplierCheck, buyerCheck };
      joined.poMatch = purchasing.data || {};
    } else {
      const claims = await execute('claims-verification-agent', {
        stage: 'verify-purpose', ...joined, purpose: document.purpose || context.purpose || '',
      });
      joined.claimCheck = { ...(claims.data || {}) };
      const purpose = document.purpose || context.purpose || '';
      if (!String(purpose).trim()) {
        domainFindings.push({
          code: 'CLAIM_PURPOSE_MISSING', severity: 'warning', status: 'open',
          message: 'The employee claim purpose is missing. Add the business reason before category recommendation or approval.',
          sourceRefs: [{ documentId: document.id, kind: 'employee_purpose' }], expected: 'A specific business purpose', observed: '',
        });
        joined.claimCheck.plausibility = 'insufficient_evidence';
      }
      const deterministic = auditClaimRelevance({
        ...(joined.document || {}), documentId: document.id,
        ocrText: context.extractedText || '',
        sourceRef: { documentId: document.id, ...(context.sourceRefs?.[0] || {}) },
      }, purpose);
      if (deterministic.issues.length) {
        domainFindings.push(...deterministic.issues);
        joined.claimCheck.plausibility = 'mismatch';
      }
      joined.claimCheck.deterministicFindings = deterministic.issues;
      const plausibility = joined.claimCheck.plausibility;
      if (plausibility === 'consistent' && deterministic.issues.length === 0 && String(purpose).trim() && (context.chartOfAccounts || []).length > 0) {
        const perspectives = ['transaction-evidence', 'business-purpose', 'policy-risk'];
        const opinions = await mapConcurrent(perspectives, maxConcurrency, (perspective) => execute(
          'council-of-agents', { stage: 'categorize-opinion', perspective, ...joined, chartOfAccounts: context.chartOfAccounts || [] }, `council-opinion-${perspective}`,
        ));
        const accounts = context.chartOfAccounts.filter((account) => account.active !== false);
        const codes = opinions.map((opinion) => opinion.data?.accountCode || opinion.data?.proposedAccountCode || opinion.data?.category?.code || null);
        const unanimousCode = codes[0] && codes.every((code) => code === codes[0]) ? codes[0] : null;
        const allowedCode = unanimousCode && accounts.some((account) => account.code === unanimousCode);
        const councilFindings = opinions.flatMap((opinion) => opinion.findings || []);
        if (!allowedCode || opinions.some((opinion) => opinion.status === 'needs_review')) {
          const reason = !unanimousCode ? 'The independent recommendations did not agree on one account code.'
            : !allowedCode ? `The recommended code ${unanimousCode} is not in the active chart of accounts.`
              : 'At least one recommendation requires human review.';
          councilFindings.push({ code: 'CLAIM_CATEGORY_NEEDS_REVIEW', severity: 'warning', status: 'open', message: reason, sourceRefs: [{ documentId: document.id }], expected: accounts.map((account) => account.code), observed: codes });
        }
        const council = {
          agent: 'council-of-agents',
          status: allowedCode && opinions.every((opinion) => opinion.status === 'completed' && opinion.findings.length === 0) && councilFindings.length === 0 ? 'completed' : 'needs_review',
          summary: allowedCode ? 'Independent expense-category recommendations agree.' : 'Expense-category recommendation needs human review.',
          data: { opinions: opinions.map((opinion, index) => ({ perspective: perspectives[index], ...opinion.data })), accountCode: allowedCode ? unanimousCode : null, agreementState: allowedCode ? 'unanimous' : 'needs_review' },
          findings: councilFindings,
        };
        results['council-of-agents'] = council;
        joined.category = council.data;
        if (council.status === 'completed') await execute('writing-agent', { stage: 'describe', ...joined });
        else await progress('writing-agent', 'waiting_for_clarification', 'Standardized description is waiting for a confirmed expense category.');
      } else if (plausibility === 'consistent' && (context.chartOfAccounts || []).length === 0) {
        domainFindings.push({
          code: 'CLAIM_CHART_OF_ACCOUNTS_MISSING', severity: 'warning', status: 'open',
          message: 'No chart of accounts is configured. Add the company accounts before requesting an expense category.',
          sourceRefs: [{ documentId: document.id }], expected: 'An active business chart of accounts', observed: 'No accounts configured',
        });
        await progress('council-of-agents', 'waiting_for_configuration', 'Category recommendation is waiting for the business chart of accounts.');
        await progress('writing-agent', 'waiting_for_configuration', 'Standardized accounting description is waiting for an approved category.');
      } else {
        await progress('council-of-agents', 'waiting_for_clarification', 'Category recommendation is waiting for a resolved claim purpose.');
        await progress('writing-agent', 'waiting_for_clarification', 'Description is waiting for a resolved claim purpose.');
      }
    }

    const audit = await execute('verify-audit-agent', { stage: 'audit', ...joined, agentResults: results });
    joined.audit = audit.data || {};
    const hasFindings = Object.values(results).some((result) => result.status === 'needs_review'
      || (result.findings || []).length > 0 || (result.data?.findings || []).length > 0);
    const hasPurposeMismatch = workflow === 'claim' && joined.claimCheck.plausibility !== 'consistent';
    const overallStatus = hasFindings || domainFindings.length > 0 || hasPurposeMismatch ? 'needs_review' : 'completed';
    await execute('documentation-db-agent', {
      stage: 'persist-validated-proposal', ...joined, overallStatus, agentResults: results,
    });
    await progress('workflow', overallStatus, overallStatus === 'needs_review'
      ? 'Processing finished with items waiting for a human review.'
      : 'Processing finished; the proposal is ready for human review.');
    return {
      status: overallStatus,
      canApprove: overallStatus === 'completed',
      workflow,
      document: proposedDocument,
      results,
      findings: [...domainFindings, ...Object.values(results).flatMap((result) => [...(result.findings || []), ...(result.data?.findings || [])])],
    };
  } catch (error) {
    const status = error.code === 'AI_NOT_CONFIGURED' ? 'needs_configuration' : 'failed';
    await progress('workflow', status, status === 'needs_configuration'
      ? 'AI processing is not configured. No AI request was sent; the item needs a configured provider or manual review.'
      : 'Processing stopped before a validated proposal could be saved.', { errorCode: error.code || 'WORKFLOW_FAILED' });
    return {
      status,
      canApprove: false,
      workflow: document.workflow || null,
      error: { code: error.code || 'WORKFLOW_FAILED', message: error.message },
      results,
    };
  }
}

module.exports = { runDocumentWorkflow, AGENT_NAMES };
