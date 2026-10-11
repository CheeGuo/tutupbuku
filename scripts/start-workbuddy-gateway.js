const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const gatewayPassword = String(process.env.CODEBUDDY_GATEWAY_PASSWORD || '');
const apiToken = String(process.env.TUTUPBUKU_API_TOKEN || '');
if (gatewayPassword.length < 32 || /\s/u.test(gatewayPassword)) {
  console.error('Set a private CODEBUDDY_GATEWAY_PASSWORD of at least 32 characters in .env.workbuddy.');
  process.exit(1);
}
if (apiToken.length < 32 || /\s/u.test(apiToken)) {
  console.error('Set a separate TUTUPBUKU_API_TOKEN of at least 32 characters in .env.workbuddy.');
  process.exit(1);
}
if (process.env.CODEBUDDY_API_KEY || process.env.CODEBUDDY_BASE_URL) {
  console.error('Remove CODEBUDDY_API_KEY / CODEBUDDY_BASE_URL overrides to use the signed-in CodeBuddy account.');
  process.exit(1);
}

const python = process.env.TUTUPBUKU_PYTHON || 'python3';
const config = {
  mcpServers: {
    tutupbuku: {
      type: 'stdio',
      command: python,
      args: ['-m', 'tutupbuku.app', '--port', '8765'],
      cwd: root,
      env: {
        TUTUPBUKU_AGENT_MODE: '1',
        TUTUPBUKU_API_TOKEN: '${TUTUPBUKU_API_TOKEN}',
        CODEBUDDY_GATEWAY_PASSWORD: '${CODEBUDDY_GATEWAY_PASSWORD}',
        CODEBUDDY_GATEWAY_URL: 'http://127.0.0.1:8081',
      },
    },
  },
};
const args = [
  '--serve', '--agent', 'cli', '--host', '127.0.0.1', '--port', '8081', '--auth', 'password',
  '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify(config),
];
console.error('Starting the private WorkBuddy gateway on 127.0.0.1:8081 with the restricted TutupBuku MCP server.');
const child = spawn('codebuddy', args, { cwd: root, stdio: 'inherit', shell: false, env: process.env });
child.on('error', () => {
  console.error('Could not start codebuddy. Check codebuddy --version and the signed-in account on this VM.');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));