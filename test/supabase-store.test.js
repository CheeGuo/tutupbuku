const test = require('node:test');
const assert = require('node:assert/strict');
const { SupabaseStore } = require('../src/storage/supabase-store');

test('Supabase store creates a shared demo business without user login and scopes proposal persistence', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/rpc/persist_document_proposal')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (String(url).includes('/rest/v1/documents?')) return new Response('[]', { status: 200 });
    return new Response(null, { status: 204 });
  };
  const store = new SupabaseStore({ url: 'https://db.example.test', serviceRoleKey: 'server-only', fetchImpl });
  const business = await store.resolveDemoBusiness('00000000-0000-4000-8000-000000000001');
  assert.equal(business.businessId, '00000000-0000-4000-8000-000000000001');
  assert.match(calls[0].url, /businesses\?on_conflict=id/u);
  assert.deepEqual(JSON.parse(calls[0].init.body), { id: business.businessId, name: 'TutupBuku hackathon demo' });
  await store.listDocuments('business-1');
  await store.persistProposal({ businessId: 'business-1', jobId: 'job-1', documentId: 'doc-1', result: { status: 'needs_review', findings: [] } });
  assert.match(calls[1].url, /business_id=eq\.business-1/);
  assert.match(calls[2].url, /rpc\/persist_document_proposal/);
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
