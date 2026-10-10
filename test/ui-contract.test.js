const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('public app serves the Dormathon month-end review desk UI', () => {
  const root = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

  assert.match(html, /TutupBuku — Month-end review desk/u);
  for (const label of ['Inputs', 'Review', 'Review Pack']) {
    assert.ok(html.includes(label), 'missing Dormathon screen: ' + label);
  }
  for (const id of ['view-inputs', 'view-review', 'view-pack', 'file-input', 'build-button']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing Dormathon control: ' + id);
  }
  assert.match(html, /href="\/styles\.css"/u);
  assert.match(html, /src="\/app\.js"/u);
  assert.doesNotMatch(html, /authForm|authView|Sign in to your desk|Business setup|Upload documents/u);
  assert.match(script, /\/api\/case/u);
  assert.match(script, /\/api\/run/u);
  assert.match(script, /\/api\/decisions/u);
  assert.match(script, /\/api\/build-review-pack/u);
  assert.match(css, /prefers-reduced-motion/u);
});
