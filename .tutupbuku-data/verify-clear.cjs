const assert = require('node:assert/strict');
const { chromium } = require('C:/Users/Acer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:65206/');
    await page.locator('#username').selectOption('bookkeeper');
    await page.locator('#password').fill('Demo-2026!');
    await page.locator('#login-form button[type=submit]').click();
    await page.locator('#workspace-view').waitFor({ state: 'visible' });
    const read = () => page.evaluate(async () => {
      const response = await fetch('/api/workspace');
      return response.json();
    });
    const before = await read();
    await page.locator('[data-action=clear-workspace]').click();
    assert.equal(await page.locator('#confirm-dialog').evaluate(dialog => dialog.open), true);
    await page.locator('#confirm-form button[value=cancel]').click();
    assert.equal((await read()).journals.length, before.journals.length);
    await page.locator('#reset-data-button').click();
    const clearedResponse = page.waitForResponse(response => response.url().endsWith('/api/workspace/action') && response.request().method() === 'POST');
    await page.locator('#dialog-confirm').click();
    const response = await clearedResponse;
    assert.equal(response.status(), 200);
    const result = await response.json();
    assert.equal(result.status, 'cleared');
    console.log(JSON.stringify({ backup_file: result.backup_file }));
    await page.getByRole('heading', { name: 'Start with your accounting records.' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Start with your accounting records.' }).waitFor();
    const after = await read();
    for (const field of ['journals', 'bank_transactions', 'opening_balances', 'uploads', 'archived_uploads', 'imports', 'exceptions']) assert.deepEqual(after[field], []);
    assert.equal(after.reports.ready, false);
    await page.screenshot({ path: '.tutupbuku-data/empty-workspace.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: 'passed', cancel: 'preserves records', clear: 'empty after reload', mobile: 'no horizontal overflow', backup_file: result.backup_file }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
