const { spawn } = require('node:child_process');

// Ubuntu launcher: use the CLI's existing signed-in account. Supplying the
// password through its documented environment variable keeps it out of argv.
if (!process.env.CODEBUDDY_GATEWAY_PASSWORD) {
  console.error('Set CODEBUDDY_GATEWAY_PASSWORD in .env.agent-demo first.');
  process.exit(1);
}
if (process.env.CODEBUDDY_API_KEY || process.env.CODEBUDDY_BASE_URL) {
  console.error('Remove CODEBUDDY_API_KEY / CODEBUDDY_BASE_URL overrides for this demo to use your existing CLI account.');
  process.exit(1);
}
const args = [
  '--serve', '--agent', 'cli', '--host', '127.0.0.1', '--port', '8081', '--auth', 'password',
  '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
];
const child = spawn('codebuddy', args, { stdio: 'inherit', shell: false, env: process.env });
child.on('error', () => {
  console.error('Could not start codebuddy. On Ubuntu, check that codebuddy --version works in this terminal.');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
