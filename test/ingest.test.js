const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('../src/ingest/csv');

test('CSV parser preserves commas, quotes, and line breaks inside quoted fields', () => {
  const rows = parseCsv(Buffer.from('Invoice No,Description,Amount\r\nINV-1,"Lunch, client meeting",25.50\r\nINV-2,"first line\nsecond line",10.00\r\n'));
  assert.deepEqual(rows, [
    { 'Invoice No': 'INV-1', Description: 'Lunch, client meeting', Amount: '25.50' },
    { 'Invoice No': 'INV-2', Description: 'first line\nsecond line', Amount: '10.00' },
  ]);
});

test('CSV parser rejects rows whose field count does not match the header', () => {
  assert.throws(() => parseCsv(Buffer.from('a,b\n1\n')), /row 2.*2 columns/i);
});
