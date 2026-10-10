const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSkills, REQUIRED_SKILLS } = require('../src/agents/skills');

test('all nine workflow skills load from ./skills with valid frontmatter', () => {
  const skills = loadSkills();

  assert.deepEqual([...skills.keys()].sort(), [...REQUIRED_SKILLS].sort());
  for (const [name, content] of skills) {
    assert.match(content, /^---\r?\nname: [a-z0-9-]+\r?\ndescription: .+\r?\n---/);
    assert.match(content, /^# .+$/m, `${name} needs a readable title`);
    assert.match(content, /source|evidence|provenance/i, `${name} must require evidence-backed outputs`);
  }
});

test('the claims skill names the conflicting fuel and meal-purpose example and prohibits silent approval', () => {
  const claims = loadSkills().get('claims-verification-agent');
  assert.match(claims, /Caltex/i);
  assert.match(claims, /Lunch with Company X/i);
  assert.match(claims, /keep.*unapproved|do not approve|hold.*clarification/i);
});

test('purchasing and party verification handle missing evidence without inventing conclusions', () => {
  const skills = loadSkills();
  const purchasing = skills.get('purchasing-agent');
  const party = skills.get('supplier-buyer-verification-agent');
  assert.match(purchasing, /incomplete|insufficient evidence/i);
  assert.match(purchasing, /item identifier|item description/i);
  assert.match(party, /master data.*unavailable|unavailable.*master data/i);
  assert.match(party, /unverified/i);
});

test('shared contract defines issue lifecycle, severity, and incomplete check handling', () => {
  const contract = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'skills', '_shared', 'agent-contract.md'), 'utf8');
  assert.match(contract, /severity.*info.*warning.*error/is);
  assert.match(contract, /open.*needs_review.*resolved/is);
  assert.match(contract, /CHECK_INCOMPLETE/);
});
