const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentRunner } = require('../src/agents/runner');

test('agent runner includes the role skill and rejects malformed agent output', async () => {
  let request;
  const runner = createAgentRunner({
    provider: { completeJSON: async (input) => { request = input; return { status: 'completed', summary: 'extracted', data: { document: { type: 'invoice' } }, findings: [], confidence: 'medium' }; } },
  });
  const result = await runner('docs-agent', { jobId: 'job-1', documentId: 'doc-1', extractedText: 'INV-1' });
  assert.equal(result.jobId, 'job-1');
  assert.equal(result.documentId, 'doc-1');
  assert.match(request.system, /Docs Agent/);
  assert.match(request.user, /INV-1/);

  const malformed = createAgentRunner({ provider: { completeJSON: async () => ({ ok: true }) } });
  await assert.rejects(() => malformed('docs-agent', { jobId: 'job-1', documentId: 'doc-1' }), { code: 'AGENT_INVALID_OUTPUT' });
  const noEvidence = createAgentRunner({ provider: { completeJSON: async () => ({ status: 'needs_review', data: {}, findings: [{ code: 'MISMATCH', message: 'Mismatch', sourceRefs: [] }] }) } });
  await assert.rejects(() => noEvidence('docs-agent', { jobId: 'job-1', documentId: 'doc-1' }), { code: 'AGENT_INVALID_OUTPUT' });
});

test('agent runner fails closed for an unknown skill', async () => {
  const runner = createAgentRunner({ provider: { completeJSON: async () => ({}) } });
  await assert.rejects(() => runner('admin-agent', {}), { code: 'AGENT_SKILL_MISSING' });
});
