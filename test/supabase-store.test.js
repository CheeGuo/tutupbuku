const test = require('node:test');
const assert = require('node:assert/strict');
const { SupabaseStore } = require('../src/storage/supabase-store');

test('Supabase store resolves authenticated business and persists versioned proposals through the atomic RPC', async () => {
  const calls = [];
  const jobRow = { id: 'job-1', business_id: 'business-1', document_id: 'doc-1', status: 'processing', run_id: 'run-1', input_version: 1, lease_owner: 'worker-1' };
  const documentRow = { id: 'doc-1', business_id: 'business-1', uploaded_by: 'user-1', original_filename: 'invoice.csv', workflow: 'purchasing', status: 'processing', input_version: 1 };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/rpc/resolve_business_for_user')) return new Response(JSON.stringify({ business_id: 'business-1' }), { status: 200 });
    if (String(url).includes('/rpc/persist_versioned_document_proposal')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (String(url).includes('/rest/v1/documents?')) return new Response(JSON.stringify(String(url).includes('id=eq.doc-1') ? [documentRow] : []), { status: 200 });
    if (String(url).includes('/rest/v1/jobs?')) return new Response(JSON.stringify(String(url).includes('select=id') ? [{ id: 'job-1' }] : [jobRow]), { status: 200 });
    if (String(url).includes('/rest/v1/job_events?')) return new Response('[]', { status: 200 });
    return new Response(null, { status: 204 });
  };
  const store = new SupabaseStore({ url: 'https://db.example.test', serviceRoleKey: 'server-only', fetchImpl });
  const business = await store.resolveBusiness({ userId: 'user-1', email: 'owner@example.test' });
  assert.equal(business.businessId, 'business-1');
  await store.listDocuments('business-1');
  await store.persistProposal({ businessId: 'business-1', jobId: 'job-1', documentId: 'doc-1', result: { status: 'needs_review', findings: [] } });
  assert.match(calls[1].url, /business_id=eq\.business-1/);
  const proposalCall = calls.find((call) => call.url.includes('/rpc/persist_versioned_document_proposal'));
  assert.ok(proposalCall);
  assert.deepEqual(JSON.parse(proposalCall.init.body), {
    p_business_id: 'business-1', p_job_id: 'job-1', p_document_id: 'doc-1',
    p_run_id: 'run-1', p_input_version: 1, p_worker_id: 'worker-1',
    p_result: { status: 'needs_review', findings: [] },
  });
  assert.equal(calls[0].init.headers.apikey, 'server-only');
});

test('Supabase approval fails closed when a document has no completed analysis', async () => {
  const store = new SupabaseStore({ url: 'https://db.example.test', serviceRoleKey: 'server-only', fetchImpl: async () => new Response(JSON.stringify({ message: 'completed analysis is required before approval' }), { status: 400 }) });
  await assert.rejects(store.approveDocument('business-1', 'doc-1', 'user-1'), (error) => error.code === 'ANALYSIS_REQUIRED');
});

test('Supabase migration serializes PO balance updates and requires analysis before approval', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '001_agentic_intake.sql'), 'utf8');
  assert.match(migration, /where po\.id = v_po_document_id and po\.business_id = p_business_id[\s\S]{0,240}for update/iu);
  assert.match(migration, /PURCHASE_PO_QUANTITY_EXCEEDED/u);
  assert.match(migration, /PURCHASE_PO_DELIVERY_QUANTITY_EXCEEDED/u);
  assert.match(migration, /PURCHASE_PO_BALANCE_EXCEEDED/u);
  assert.match(migration, /v_doc\.analysis is null or v_doc\.status not in \('completed','needs_review'\)/u);
  assert.match(migration, /route_mode text not null default 'manual'/u);
  assert.match(migration, /returns table\(business_id uuid, role text\)/u);
  assert.match(migration, /documents\.workflow='claim' and documents\.uploaded_by=auth\.uid\(\)/u);
  assert.match(migration, /m\.role in \('owner','reviewer'\)/u);
});
