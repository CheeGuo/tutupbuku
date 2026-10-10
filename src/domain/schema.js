const DOCUMENT_TYPES = Object.freeze([
  'quotation',
  'purchase_order',
  'delivery_order',
  'invoice',
  'payment_advice',
  'receipt',
]);

const REQUIRED_FIELDS = Object.freeze({
  quotation: ['supplierName', 'documentDate'],
  purchase_order: ['supplierName', 'documentNumber', 'documentDate'],
  delivery_order: ['supplierName', 'documentNumber', 'documentDate'],
  invoice: ['supplierName', 'documentNumber', 'documentDate', 'totalAmountSen'],
  payment_advice: ['documentNumber', 'documentDate', 'totalAmountSen'],
  receipt: ['merchantName', 'documentDate', 'totalAmountSen'],
});

function validateExtractedDocument(document) {
  const errors = [];
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { valid: false, errors: ['Document extraction must be an object.'] };
  }
  if (!DOCUMENT_TYPES.includes(document.type)) {
    errors.push(`Unsupported document type: ${document.type || '(missing)'}.`);
  } else {
    for (const field of REQUIRED_FIELDS[document.type]) {
      if (document[field] === undefined || document[field] === null || document[field] === '') {
        errors.push(`Missing required field: ${field}.`);
      }
    }
  }
  if (document.totalAmountSen !== undefined && !Number.isSafeInteger(document.totalAmountSen)) {
    errors.push('totalAmountSen must be an integer amount in Malaysian sen.');
  }
  if (document.lines !== undefined) {
    if (!Array.isArray(document.lines)) errors.push('lines must be an array.');
    else document.lines.forEach((line, index) => {
      if (line.quantity !== undefined && (!Number.isFinite(line.quantity) || line.quantity <= 0)) {
        errors.push(`Line ${index + 1} quantity must be positive.`);
      }
      for (const amount of ['unitPriceSen', 'totalSen']) {
        if (line[amount] !== undefined && !Number.isSafeInteger(line[amount])) {
          errors.push(`Line ${index + 1} ${amount} must be an integer amount in Malaysian sen.`);
        }
      }
      if (Number.isFinite(line.quantity) && line.quantity > 0 && Number.isSafeInteger(line.unitPriceSen) && Number.isSafeInteger(line.totalSen)) {
        const calculated = Math.round(line.quantity * line.unitPriceSen);
        if (Number.isSafeInteger(calculated) && calculated !== line.totalSen) errors.push(`Line ${index + 1} total does not equal quantity multiplied by unit price.`);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { DOCUMENT_TYPES, REQUIRED_FIELDS, validateExtractedDocument };
