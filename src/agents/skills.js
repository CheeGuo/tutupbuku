const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_SKILLS = Object.freeze([
  'master-agent',
  'docs-agent',
  'supplier-buyer-verification-agent',
  'purchasing-agent',
  'verify-audit-agent',
  'claims-verification-agent',
  'council-of-agents',
  'writing-agent',
  'documentation-db-agent',
]);

function loadSkills(root = path.resolve(__dirname, '../../skills')) {
  const skills = new Map();
  for (const name of REQUIRED_SKILLS) {
    const filename = path.join(root, name, 'SKILL.md');
    if (!fs.existsSync(filename)) throw new Error(`Required agent skill is missing: ${filename}`);
    const content = fs.readFileSync(filename, 'utf8');
    if (!/^---\r?\nname: [a-z0-9-]+\r?\ndescription: .+\r?\n---/u.test(content)) {
      throw new Error(`Invalid SKILL.md frontmatter: ${filename}`);
    }
    skills.set(name, content);
  }
  return skills;
}

module.exports = { loadSkills, REQUIRED_SKILLS };
