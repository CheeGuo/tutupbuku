const test = require('node:test');
const assert = require('node:assert/strict');
const { runDocumentWorkflow } = require('../src/workflow/orchestrator');
const { mapConcurrent } = require('../src/workflow/concurrency');

test('bounded concurrency does not exceed its configured worker count and preserves result order', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapConcurrent([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
});

test('a mismatched claim waits for clarification and never reaches category or writing agents', async () => {
  const called = [];
  const events = [];
  const dataFor = {
    'master-agent': { workflow: 'claim', documentType: 'receipt' },
    'docs-agent': { document: { type: 'receipt', merchantName: 'Caltex', categoryHints: ['fuel'] } },
    'claims-verification-agent': { plausibility: 'consistent' },
    'verify-audit-agent': { findings: [{ code: 'CLAIM_PURPOSE_MISMATCH', sourceRefs: [{ documentId: 'doc-1' }] }] },
    'documentation-db-agent': { persisted: true },
  };
  const result = await runDocumentWorkflow({
    job: { id: 'job-1' },
    document: { id: 'doc-1', workflow: 'claim', purpose: 'Lunch with Company X' },
    ownerId: 'owner-1',
  }, {
    runAgent: async (name) => {
      called.push(name);
      return { status: 'completed', data: dataFor[name] || {}, findings: [] };
    },
    onEvent: async (event) => events.push(event),
  });

  assert.equal(result.status, 'needs_review');
  assert.equal(result.canApprove, false);
  assert.ok(called.includes('claims-verification-agent'));
  assert.ok(!called.includes('council-of-agents'));
  assert.ok(!called.includes('writing-agent'));
  assert.ok(events.some((event) => event.state === 'waiting_for_clarification'));
});

test('purchasing identity and PO checks fan out in parallel before audit joins them', async () => {
  const called = [];
  const events = [];
  const result = await runDocumentWorkflow({
    job: { id: 'job-purchase' },
    document: { id: 'doc-invoice', workflow: 'purchasing' },
    ownerId: 'owner-1',
  }, {
    runAgent: async (name) => {
      called.push(name);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (name === 'master-agent') return { status: 'completed', data: { workflow: 'purchasing', documentType: 'invoice' } };
      if (name === 'docs-agent') return { status: 'completed', data: { document: { type: 'invoice' } } };
      if (name === 'supplier-buyer-verification-agent') return { status: 'completed', data: { supplierCheck: 'verified', buyerCheck: 'verified' } };
      if (name === 'purchasing-agent') return { status: 'completed', data: { poLink: 'matched' } };
      if (name === 'verify-audit-agent') return { status: 'completed', data: { findings: [] }, findings: [] };
      return { status: 'completed', data: { persisted: true } };
    },
    onEvent: async (event) => events.push(event),
  });

  assert.equal(result.status, 'completed');
  assert.ok(called.indexOf('supplier-buyer-verification-agent') < called.indexOf('verify-audit-agent'));
  assert.ok(called.indexOf('purchasing-agent') < called.indexOf('verify-audit-agent'));
  assert.ok(events.some((event) => event.agent === 'supplier-buyer-verification-agent' && event.state === 'started'));
  assert.ok(events.some((event) => event.agent === 'purchasing-agent' && event.state === 'started'));
  assert.equal(called.filter((name) => name === 'supplier-buyer-verification-agent').length, 2);
});

test('the claim council gets three independent parallel opinions and writing runs only after agreement', async () => {
  const calls = [];
  let active = 0;
  let peak = 0;
  const result = await runDocumentWorkflow({
    job: { id: 'job-claim' },
    document: { id: 'doc-meal', workflow: 'purchasing', routeMode: 'automatic', purpose: 'Lunch meeting with Company X' },
    extractedText: 'Lunch set RM25.00',
    chartOfAccounts: [{ code: '6100', label: 'Meals', active: true }],
  }, {
    maxConcurrency: 3,
    runAgent: async (name, context) => {
      calls.push({ name, perspective: context.perspective });
      if (name === 'master-agent') return { status: 'completed', data: { workflow: 'claim' } };
      if (name === 'docs-agent') return { status: 'completed', data: { document: { type: 'receipt', merchantName: 'Cafe One', description: 'Lunch set', documentDate: '2026-06-01', totalAmountSen: 2500 } } };
      if (name === 'claims-verification-agent') return { status: 'completed', data: { plausibility: 'consistent' }, findings: [] };
      if (name === 'council-of-agents') {
        active += 1; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 12));
        active -= 1;
        return { status: 'completed', data: { accountCode: '6100', reason: context.perspective }, findings: [] };
      }
      if (name === 'verify-audit-agent') return { status: 'completed', data: { findings: [] }, findings: [] };
      return { status: 'completed', data: {}, findings: [] };
    },
  });
  assert.equal(peak, 3);
  assert.equal(result.workflow, 'claim');
  assert.equal(result.results['council-of-agents'].data.opinions.length, 3);
  assert.equal(result.results['council-of-agents'].data.accountCode, '6100');
  assert.ok(calls.some((call) => call.name === 'writing-agent'));
  assert.equal(result.status, 'completed');
});

test('manual workflow selection is preserved and a conflicting Master Agent route is flagged', async () => {
  const result = await runDocumentWorkflow({
    job: { id: 'job-manual-route' }, document: { id: 'doc-manual', workflow: 'claim', routeMode: 'manual', purpose: 'Employee reimbursement' },
    sourceRefs: [{ page: 1, line: 1 }],
  }, {
    runAgent: async (name) => name === 'master-agent'
      ? { status: 'completed', data: { workflow: 'purchasing' }, findings: [] }
      : name === 'docs-agent' ? { status: 'completed', data: { document: { type: 'receipt' } }, findings: [] }
        : name === 'claims-verification-agent' ? { status: 'completed', data: { plausibility: 'insufficient_evidence' }, findings: [] }
          : { status: 'completed', data: {}, findings: [] },
  });
  assert.equal(result.workflow, 'claim');
  assert.ok(result.findings.some((finding) => finding.code === 'DOCUMENT_WORKFLOW_SELECTION_MISMATCH'));
});
