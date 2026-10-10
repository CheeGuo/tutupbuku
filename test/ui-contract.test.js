const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('operator UI provides authenticated upload, records, issue review, and business setup views', () => {
  const root = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  for (const label of ['Upload', 'Records', 'Issues', 'Business setup']) assert.match(html, new RegExp(label, 'i'));
  assert.match(html, /novalidate/i);
  assert.match(html, /aria-live/i);
  assert.match(html, /value="auto">Let Master Agent decide/u);
  assert.match(script, /\/api\/documents/);
  assert.match(script, /\/api\/issues/);
  assert.match(script, /\/api\/master-data/);
  assert.match(script, /reprocess/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /scrollbar-color/);
});
