const CHAIN_ORDER = Object.freeze([
  'quotation', 'purchase_order', 'delivery_order', 'invoice', 'payment_advice', 'receipt',
]);
const REQUIRED_PREDECESSORS = Object.freeze({
  delivery_order: ['purchase_order'],
  invoice: ['purchase_order', 'delivery_order'],
  payment_advice: ['invoice'],
  receipt: ['payment_advice'],
});

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('en-MY').replace(/[^\p{L}\p{N}]/gu, '');
}

function refsFor(...items) {
  return items.filter(Boolean).map((item) => item.sourceRef || { documentId: item.documentId });
}

function issue(code, message, sourceRefs, details = {}) {
  return {
    code,
    severity: 'warning',
    status: 'needs_review',
    message,
    sourceRefs: sourceRefs.filter((ref) => ref && ref.documentId),
    ...details,
  };
}

function auditClaimRelevance(receipt, purpose) {
  const hints = (receipt?.categoryHints || []).map((hint) => normalize(hint));
  const receiptText = normalize(`${receipt?.merchant || ''} ${receipt?.merchantName || ''} ${receipt?.description || ''} ${receipt?.ocrText || ''}`);
  const purposeText = normalize(purpose);
  const fuelEvidence = hints.some((hint) => ['fuel', 'petrol', 'diesel', 'gasoline'].includes(hint))
    || /fuel|petrol|diesel|gasoline|ron95|ron97/.test(receiptText);
  const mealPurpose = /lunch|dinner|breakfast|meal|restaurant|food/.test(purposeText);
  const fuelPurpose = /fuel|petrol|diesel|gasoline|mileage|vehicle|trip|travel/.test(purposeText);
  const mealEvidence = /lunch|dinner|breakfast|restaurant|food|cafe/.test(receiptText);

  if (fuelEvidence && mealPurpose && !fuelPurpose) {
    return {
      decision: 'needs_review',
      suggestedAccountCode: null,
      issues: [issue(
        'CLAIM_PURPOSE_MISMATCH',
        'The receipt supports a fuel purchase, while the submitted purpose describes a meal. Confirm whether this fuel belongs to a business trip or whether the receipt or purpose was attached to the wrong claim.',
        [
          ...refsFor(receipt),
          { documentId: receipt?.documentId || 'claim', kind: 'employee_purpose', quote: String(purpose || '') },
        ],
        { expected: 'Fuel-related business purpose or a matching meal receipt', observed: String(purpose || '') },
      )],
    };
  }

  if (mealEvidence && fuelPurpose && !mealPurpose) {
    return {
      decision: 'needs_review',
      suggestedAccountCode: null,
      issues: [issue(
        'CLAIM_PURPOSE_MISMATCH',
        'The receipt supports a meal purchase, while the submitted purpose describes fuel or travel. Confirm whether the purpose or document is correct.',
        [...refsFor(receipt), { documentId: receipt?.documentId || 'claim', kind: 'employee_purpose', quote: String(purpose || '') }],
        { expected: 'Meal-related business purpose or a matching fuel receipt', observed: String(purpose || '') },
      )],
    };
  }

  return { decision: 'consistent', suggestedAccountCode: null, issues: [] };
}

function auditPartyMaster(document, masterData = {}) {
  const findings = [];
  const sourceFor = (field) => {
    const source = document?.fieldSources?.[field]?.[0] || document?.sourceRef || {};
    return { ...source, documentId: source.documentId || document?.documentId || 'unknown', field };
  };
  const suppliers = (masterData.suppliers || []).filter((supplier) => supplier.active !== false);
  if (!suppliers.length) {
    findings.push(issue(
      'SUPPLIER_MASTER_DATA_UNAVAILABLE',
      'No approved supplier list is configured. Supplier identity has not been verified.',
      [sourceFor('supplierName')], { expected: 'An approved supplier record', observed: document?.supplierName || 'Supplier not identified' },
    ));
  } else if (document?.supplierName) {
    const match = suppliers.find((supplier) => normalize(supplier.legalName) === normalize(document.supplierName));
    if (!match) findings.push(issue(
      'PURCHASE_SUPPLIER_NOT_IN_MASTER_DATA',
      `Supplier “${document.supplierName}” does not exactly match an approved supplier record. Confirm the legal identity before continuing.`,
      [sourceFor('supplierName')], { expected: suppliers.map((supplier) => supplier.legalName), observed: document.supplierName },
    ));
    else if (match.registrationNumber && document.supplierRegistrationNumber
      && normalize(match.registrationNumber) !== normalize(document.supplierRegistrationNumber)) {
      findings.push(issue(
        'PURCHASE_SUPPLIER_REGISTRATION_MISMATCH',
        'The supplier name matches an approved record, but its registration number differs.',
        [sourceFor('supplierRegistrationNumber')], { expected: match.registrationNumber, observed: document.supplierRegistrationNumber, supplierRecordId: match.id || null },
      ));
    }
  }

  const buyer = masterData.buyerProfile;
  if (!buyer?.legalName) findings.push(issue(
    'BUYER_PROFILE_UNAVAILABLE',
    'The business buyer identity is not configured. Buyer identity has not been verified.',
    [sourceFor('buyerName')], { expected: 'A configured business buyer profile', observed: document?.buyerName || 'No buyer profile' },
  ));
  else if (!document?.buyerName) findings.push(issue(
    'PURCHASE_BUYER_MISSING',
    'The document does not show a buyer identity to compare with the business profile.',
    [sourceFor('buyerName')], { expected: buyer.legalName, observed: 'Not present on document' },
  ));
  else if (normalize(buyer.legalName) !== normalize(document.buyerName)) findings.push(issue(
    'PURCHASE_BUYER_IDENTITY_MISMATCH',
    `The document buyer “${document.buyerName}” does not match the configured business buyer “${buyer.legalName}”.`,
    [sourceFor('buyerName')], { expected: buyer.legalName, observed: document.buyerName },
  ));
  else if (buyer.registrationNumber && document.buyerRegistrationNumber
    && normalize(buyer.registrationNumber) !== normalize(document.buyerRegistrationNumber)) findings.push(issue(
      'PURCHASE_BUYER_REGISTRATION_MISMATCH',
      'The buyer name matches the business profile, but the registration number differs.',
      [sourceFor('buyerRegistrationNumber')], { expected: buyer.registrationNumber, observed: document.buyerRegistrationNumber },
    ));
  return findings;
}

function sumLineTotals(lines = []) {
  return lines.reduce((total, line) => total + (Number.isSafeInteger(line.totalSen) ? line.totalSen : 0), 0);
}

function auditPoBalance(purchaseOrder, documents = []) {
  if (!purchaseOrder) return [];
  const rows = documents.filter((doc) => ['invoice', 'delivery_order'].includes(doc?.type));
  if (!rows.length) return [];
  const issues = [];
  const allowanceByItem = new Map();
  for (const line of purchaseOrder.lines || []) {
    const item = normalize(line.item);
    if (!item || !Number.isFinite(line.quantity) || line.quantity <= 0) continue;
    allowanceByItem.set(item, (allowanceByItem.get(item) || 0) + line.quantity);
  }
  for (const type of ['delivery_order', 'invoice']) {
    const consumptionRows = rows.filter((doc) => doc.type === type);
    if (!consumptionRows.length) continue;
    const consumedByItem = new Map();
    for (const doc of consumptionRows) for (const line of doc.lines || []) {
      const item = normalize(line.item);
      if (!item || !Number.isFinite(line.quantity) || line.quantity <= 0) continue;
      consumedByItem.set(item, (consumedByItem.get(item) || 0) + line.quantity);
    }
    for (const [item, consumed] of consumedByItem) {
      const allowed = allowanceByItem.get(item);
      if (allowed !== undefined && consumed > allowed) {
        const isDelivery = type === 'delivery_order';
        const current = consumptionRows.at(-1);
        issues.push(issue(
          isDelivery ? 'PURCHASE_PO_DELIVERY_QUANTITY_EXCEEDED' : 'PURCHASE_PO_QUANTITY_EXCEEDED',
          `${isDelivery ? 'Delivery orders' : 'Invoices'} linked to PO ${purchaseOrder.poNumber || purchaseOrder.documentNumber || ''} consume ${consumed} units of an item ordered at ${allowed}. The combined quantity exceeds the PO.`.trim(),
          refsFor(purchaseOrder, ...consumptionRows),
          { severity: 'error', stableKey: `purchase-po-quantity:${purchaseOrder.documentId || purchaseOrder.poNumber || 'unknown'}:${type}:${current.documentId || 'current'}`, expectedQuantity: allowed, observedQuantity: consumed, poNumber: purchaseOrder.poNumber || purchaseOrder.documentNumber || null },
        ));
      }
    }
  }

  const invoices = rows.filter((doc) => doc.type === 'invoice');
  if (!invoices.length) return issues;
  const poTotal = Number.isSafeInteger(purchaseOrder.totalAmountSen) ? purchaseOrder.totalAmountSen : sumLineTotals(purchaseOrder.lines);
  const invoiceTotals = invoices.map((invoice) => Number.isSafeInteger(invoice.totalAmountSen) ? invoice.totalAmountSen : sumLineTotals(invoice.lines));
  if (poTotal > 0 && invoiceTotals.every(Number.isSafeInteger)) {
    const invoicedTotal = invoiceTotals.reduce((total, amount) => total + BigInt(amount), 0n);
    if (invoicedTotal > BigInt(poTotal)) {
      const observedAmountSen = invoicedTotal <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(invoicedTotal) : invoicedTotal.toString();
      const current = invoices.at(-1);
      issues.push(issue(
        'PURCHASE_PO_BALANCE_EXCEEDED',
        `Invoices linked to PO ${purchaseOrder.poNumber || purchaseOrder.documentNumber || ''} total RM${(Number(invoicedTotal) / 100).toFixed(2)}, above its RM${(poTotal / 100).toFixed(2)} value.`.trim(),
        refsFor(purchaseOrder, ...invoices),
        { severity: 'error', stableKey: `purchase-po-balance:${purchaseOrder.documentId || purchaseOrder.poNumber || 'unknown'}:${current.documentId || 'current'}`, expectedAmountSen: poTotal, observedAmountSen, poNumber: purchaseOrder.poNumber || purchaseOrder.documentNumber || null },
      ));
    }
  }
  return issues;
}

function auditPurchaseChain(purchaseOrder, documents = [], options = {}) {
  const issues = [];
  const expected = options.requiredPredecessors || REQUIRED_PREDECESSORS;
  const docs = documents.filter(Boolean);

  for (const doc of docs) {
    if (!CHAIN_ORDER.includes(doc.type)) continue;
    if (!purchaseOrder && doc.type !== 'quotation' && doc.type !== 'purchase_order') {
      issues.push(issue(
        'PURCHASE_MISSING_PO',
        `${doc.type.replaceAll('_', ' ')} ${doc.documentNumber || doc.documentId} references a purchasing flow with no matching purchase order.`,
        refsFor(doc),
        { poNumber: doc.poNumber || null },
      ));
      continue;
    }
    const required = expected[doc.type] || [];
    for (const prerequisite of required) {
      const present = prerequisite === 'purchase_order'
        ? Boolean(purchaseOrder)
        : docs.some((candidate) => candidate.type === prerequisite);
      if (!present) {
        const missingCode = prerequisite === 'delivery_order'
          ? 'PURCHASE_MISSING_DELIVERY_ORDER'
          : `PURCHASE_MISSING_${prerequisite.toLocaleUpperCase('en-US')}`;
        issues.push(issue(
          missingCode,
          `${doc.type.replaceAll('_', ' ')} ${doc.documentNumber || doc.documentId} is present without the expected ${prerequisite.replaceAll('_', ' ')}.`,
          refsFor(doc, purchaseOrder),
          { missingType: prerequisite, poNumber: doc.poNumber || purchaseOrder?.poNumber || null },
        ));
      }
    }
  }

  if (purchaseOrder) {
    const normalizedSupplier = normalize(purchaseOrder.supplierName);
    const normalizedBuyer = normalize(purchaseOrder.buyerName);
    for (const doc of docs) {
      if (!CHAIN_ORDER.includes(doc.type) || doc.type === 'quotation' || doc.type === 'purchase_order') continue;
      if (doc.supplierName && normalizedSupplier && normalize(doc.supplierName) !== normalizedSupplier) {
        issues.push(issue(
          'PURCHASE_SUPPLIER_IDENTITY_MISMATCH',
          `The PO names supplier “${purchaseOrder.supplierName}”, but ${doc.type.replaceAll('_', ' ')} names “${doc.supplierName}”. Verify both against the approved supplier records.`,
          refsFor(purchaseOrder, doc),
          { expected: purchaseOrder.supplierName, observed: doc.supplierName, poNumber: purchaseOrder.poNumber },
        ));
      }
      if (doc.buyerName && normalizedBuyer && normalize(doc.buyerName) !== normalizedBuyer) {
        issues.push(issue(
          'PURCHASE_BUYER_IDENTITY_MISMATCH',
          `The PO names buyer “${purchaseOrder.buyerName}”, but ${doc.type.replaceAll('_', ' ')} names “${doc.buyerName}”. Verify the legal buyer identity.`,
          refsFor(purchaseOrder, doc),
          { expected: purchaseOrder.buyerName, observed: doc.buyerName, poNumber: purchaseOrder.poNumber },
        ));
      }
      if (doc.type !== 'invoice') continue;

      const poByItem = new Map((purchaseOrder.lines || []).map((line) => [normalize(line.item), line]));
      for (const line of doc.lines || []) {
        const expectedLine = poByItem.get(normalize(line.item));
        if (!expectedLine) {
          issues.push(issue(
            'PURCHASE_LINE_NOT_ON_PO',
            `Invoice line “${line.item || '(unnamed item)'}” is not found on PO ${purchaseOrder.poNumber}.`,
            refsFor(purchaseOrder, doc),
            { observedItem: line.item || null, poNumber: purchaseOrder.poNumber },
          ));
          continue;
        }
        if (Number.isSafeInteger(line.unitPriceSen) && Number.isSafeInteger(expectedLine.unitPriceSen)
            && line.unitPriceSen !== expectedLine.unitPriceSen) {
          issues.push(issue(
            'PURCHASE_PRICE_MISMATCH',
            `Invoice unit price for “${line.item}” differs from the PO by RM${((line.unitPriceSen - expectedLine.unitPriceSen) / 100).toFixed(2)} per unit.`,
            refsFor(purchaseOrder, doc),
            {
              expectedAmountSen: expectedLine.unitPriceSen * (Number.isFinite(expectedLine.quantity) ? expectedLine.quantity : 1),
              observedAmountSen: line.unitPriceSen * (Number.isFinite(line.quantity) ? line.quantity : 1),
              expectedUnitPriceSen: expectedLine.unitPriceSen,
              observedUnitPriceSen: line.unitPriceSen,
              poNumber: purchaseOrder.poNumber,
            },
          ));
        }
      }
    }
    issues.push(...auditPoBalance(purchaseOrder, docs));
  }

  const invoices = docs.filter((doc) => doc.type === 'invoice' && doc.invoiceNumber);
  const seen = new Map();
  for (const invoice of invoices) {
    const key = `${normalize(invoice.supplierName)}:${normalize(invoice.invoiceNumber)}`;
    if (seen.has(key)) {
      issues.push(issue(
        'PURCHASE_DUPLICATE_INVOICE',
        `Invoice ${invoice.invoiceNumber} appears more than once for supplier ${invoice.supplierName || '(unknown)'}.`,
        refsFor(seen.get(key), invoice),
        { invoiceNumber: invoice.invoiceNumber },
      ));
    } else seen.set(key, invoice);
  }
  return issues;
}

module.exports = { auditClaimRelevance, auditPartyMaster, auditPurchaseChain, auditPoBalance, CHAIN_ORDER, REQUIRED_PREDECESSORS };
