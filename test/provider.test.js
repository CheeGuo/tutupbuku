const test = require('node:test');
const assert = require('node:assert/strict');
const { createAIProvider } = require('../src/ai/provider');

test('provider reports missing endpoint without making a network request', async () => {
  const provider = createAIProvider({});
  assert.equal(provider.available, false);
  await assert.rejects(provider.completeJSON({ system: 'test', user: 'test' }), (error) => {
    assert.equal(error.code, 'AI_NOT_CONFIGURED');
    return true;
  });
});

test('provider rejects unsafe non-HTTP endpoint protocols', () => {
  assert.throws(() => createAIProvider({ AI_BASE_URL: 'file:///tmp/anything' }), /http or https/i);
});
