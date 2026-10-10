const test = require('node:test');
const assert = require('node:assert/strict');

const { auditClaimRelevance, auditPartyMaster, auditPurchaseChain } = require('../src/domain/audit');
const { validateExtractedDocument } = require('../src/domain/schema');

function issueCodes(issues) {
  return issues.map((issue) => issue.code);
}

test('fuel receipt with a lunch purpose is held for clarification with both sources', () => {
  const receipt = {
    documentId: 'doc-fuel-1',
    merchant: 'Caltex',
    description: 'PETROL RON95',
    categoryHints: ['fuel'],
    sourceRef: { documentId: 'doc-fuel-1', page: 1, quote: 'PETROL RON95 RM120.00' },
  };

  const result = auditClaimRelevance(receipt, 'Lunch with Company X');

  assert.equal(result.decision, 'needs_review');
  assert.equal(result.suggestedAccountCode, null);
  assert.ok(issueCodes(result.issues).includes('CLAIM_PURPOSE_MISMATCH'));
  const mismatch = result.issues.find((issue) => issue.code === 'CLAIM_PURPOSE_MISMATCH');
  assert.match(mismatch.message, /fuel|receipt/i);
  assert.ok(mismatch.sourceRefs.some((ref) => ref.documentId === 'doc-fuel-1'));
  assert.ok(mismatch.sourceRefs.some((ref) => ref.kind === 'employee_purpose'));
});

test('invoice with a higher unit price, supplier mismatch and missing DO is flagged against its PO', () => {
  const po = {
    documentId: 'doc-po-1',
    poNumber: 'PO-104',
    supplierName: 'Mega Engineering',
    buyerName: 'Example Sdn Bhd',
    currency: 'MYR',
    lines: [{ item: 'Part A', quantity: 10, unitPriceSen: 4500, totalSen: 45000 }],
    sourceRef: { documentId: 'doc-po-1', page: 1, quote: '10 x RM45.00' },
  };
  const documents = [{
    documentId: 'doc-invoice-1',
    type: 'invoice',
    invoiceNumber: 'INV-88',
    poNumber: 'PO-104',
    supplierName: 'Mega Enterprise',
    buyerName: 'Example Sdn Bhd',
    currency: 'MYR',
    lines: [{ item: 'Part A', quantity: 10, unitPriceSen: 5000, totalSen: 50000 }],
    sourceRef: { documentId: 'doc-invoice-1', page: 1, quote: '10 x RM50.00' },
  }];

  const issues = auditPurchaseChain(po, documents);
  const codes = issueCodes(issues);

  assert.ok(codes.includes('PURCHASE_PRICE_MISMATCH'));
  assert.ok(codes.includes('PURCHASE_MISSING_DELIVERY_ORDER'));
  assert.ok(codes.includes('PURCHASE_SUPPLIER_IDENTITY_MISMATCH'));
  for (const issue of issues) {
    assert.ok(issue.sourceRefs.length >= 1, `${issue.code} needs source evidence`);
    assert.ok(['needs_review', 'open'].includes(issue.status));
  }
  const priceIssue = issues.find((issue) => issue.code === 'PURCHASE_PRICE_MISMATCH');
  assert.equal(priceIssue.expectedAmountSen, 45000);
  assert.equal(priceIssue.observedAmountSen, 50000);
});

test('a complete purchase chain with matching supplier and values has no missing-step issue', () => {
  const po = {
    documentId: 'po-doc', poNumber: 'PO-8', supplierName: 'Supplier S', buyerName: 'Buyer B', currency: 'MYR',
    lines: [{ item: 'Item', quantity: 2, unitPriceSen: 1000, totalSen: 2000 }],
    sourceRef: { documentId: 'po-doc', page: 1 },
  };
  const types = ['delivery_order', 'invoice', 'payment_advice', 'receipt'];
  const documents = types.map((type) => ({
    documentId: `doc-${type}`, type, poNumber: 'PO-8', supplierName: 'Supplier S', buyerName: 'Buyer B', currency: 'MYR',
    lines: [{ item: 'Item', quantity: 2, unitPriceSen: 1000, totalSen: 2000 }],
    sourceRef: { documentId: `doc-${type}`, page: 1 },
  }));

  const issues = auditPurchaseChain(po, documents);

  assert.deepEqual(issues, []);
});

test('partial invoices are allowed, but cumulative PO quantity and amount overages are flagged', () => {
  const po = {
    documentId: 'po-balance', poNumber: 'PO-BAL', supplierName: 'Supplier S', buyerName: 'Buyer B', totalAmountSen: 10000,
    lines: [{ item: 'Widget', quantity: 10, unitPriceSen: 1000, totalSen: 10000 }],
    sourceRef: { documentId: 'po-balance', page: 1 },
  };
  const partials = [
    { documentId: 'invoice-a', type: 'invoice', invoiceNumber: 'A', lines: [{ item: 'Widget', quantity: 4, unitPriceSen: 1000, totalSen: 4000 }], totalAmountSen: 4000, sourceRef: { documentId: 'invoice-a', page: 1 } },
    { documentId: 'invoice-b', type: 'invoice', invoiceNumber: 'B', lines: [{ item: 'Widget', quantity: 4, unitPriceSen: 1000, totalSen: 4000 }], totalAmountSen: 4000, sourceRef: { documentId: 'invoice-b', page: 1 } },
  ];
  const withDeliveryOrder = [{ documentId: 'do-1', type: 'delivery_order', documentNumber: 'DO-1', sourceRef: { documentId: 'do-1', page: 1 } }, ...partials];
  assert.deepEqual(auditPurchaseChain(po, withDeliveryOrder), []);
  const over = { documentId: 'invoice-c', type: 'invoice', invoiceNumber: 'C', lines: [{ item: 'Widget', quantity: 3, unitPriceSen: 1000, totalSen: 3000 }], totalAmountSen: 3000, sourceRef: { documentId: 'invoice-c', page: 1 } };
  const codes = issueCodes(auditPurchaseChain(po, [...withDeliveryOrder, over]));
  assert.ok(codes.includes('PURCHASE_PO_BALANCE_EXCEEDED'));
  assert.ok(codes.includes('PURCHASE_PO_QUANTITY_EXCEEDED'));
});

test('cumulative delivery-order quantity cannot exceed the PO order quantity', () => {
  const po = { documentId: 'po-do-balance', poNumber: 'PO-DO', lines: [{ item: 'Pump', quantity: 10 }] };
  const deliveries = [4, 4, 3].map((quantity, index) => ({
    documentId: `do-${index}`, type: 'delivery_order', documentNumber: `DO-${index}`,
    lines: [{ item: 'Pump', quantity }], sourceRef: { documentId: `do-${index}`, page: 1 },
  }));
  assert.ok(auditPurchaseChain(po, deliveries).some((finding) => finding.code === 'PURCHASE_PO_DELIVERY_QUANTITY_EXCEEDED'));
});

test('deterministic extraction validation catches a line-total arithmetic mismatch', () => {
  const result = validateExtractedDocument({
    type: 'invoice', supplierName: 'Supplier', documentNumber: 'INV-2', documentDate: '2026-06-01', totalAmountSen: 1000,
    lines: [{ item: 'Cable', quantity: 2, unitPriceSen: 500, totalSen: 1200 }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((message) => /quantity multiplied by unit price/i.test(message)));
});

test('party-master audit blocks missing and unexpected legal identities', () => {
  const document = { documentId: 'invoice-1', supplierName: 'Mega Engineering', buyerName: 'Other Buyer', fieldSources: { supplierName: [{ row: 4 }], buyerName: [{ page: 1 }] } };
  const missing = auditPartyMaster(document, { suppliers: [], buyerProfile: null });
  assert.ok(missing.some((finding) => finding.code === 'SUPPLIER_MASTER_DATA_UNAVAILABLE'));
  assert.ok(missing.some((finding) => finding.code === 'BUYER_PROFILE_UNAVAILABLE'));
  const mismatch = auditPartyMaster(document, { suppliers: [{ id: 'supplier-1', legalName: 'Mega Engineering' }], buyerProfile: { legalName: 'Example Sdn Bhd' } });
  assert.ok(mismatch.some((finding) => finding.code === 'PURCHASE_BUYER_IDENTITY_MISMATCH'));
  assert.ok(!mismatch.some((finding) => finding.code === 'PURCHASE_SUPPLIER_NOT_IN_MASTER_DATA'));
});
