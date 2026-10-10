const test = require('node:test');
const assert = require('node:assert/strict');
const { extractDocument } = require('../src/ingest/ocr');

test('CSV ingestion produces row-based source references without requiring AI or OCR binaries', async () => {
  const result = await extractDocument({ filename: 'bank.csv', bytes: Buffer.from('date,description,amount\n2026-06-01,Shop,12.50\n') });
  assert.equal(result.kind, 'tabular');
  assert.deepEqual(result.rows, [{ date: '2026-06-01', description: 'Shop', amount: '12.50' }]);
  assert.equal(result.sourceRefs[0].row, 2);
});

test('text ingestion records line-level provenance and rejects empty content', async () => {
  const result = await extractDocument({ filename: 'claim.txt', bytes: Buffer.from('Company lunch\nDiscussed project') });
  assert.match(result.text, /Company lunch/);
  assert.equal(result.sourceRefs[1].line, 2);
  await assert.rejects(() => extractDocument({ filename: 'empty.txt', bytes: Buffer.from('  ') }), { code: 'OCR_EMPTY' });
});

test('unsupported files produce a clear OCR error', async () => {
  await assert.rejects(() => extractDocument({ filename: 'archive.zip', bytes: Buffer.from('x') }), { code: 'UNSUPPORTED_FILE' });
});
