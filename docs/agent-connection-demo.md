# AWS agent connection demo

This demo provides a normal HTML page with a button that makes one real AI request. It can run beside TutupBuku on your Ubuntu AWS VM. It uses your existing international CodeBuddy CLI account login, which you have already tested with WorkBuddy credits. It does not require another model API key.

```text
Browser on your laptop
  -> ngrok HTTPS endpoint
  -> authenticated demo backend on the AWS VM, port 3001
  -> dedicated private CodeBuddy gateway on the same VM, port 8081
  -> final AI reply displayed on the page
```

This is a fixed-response connection test. It does not review accounting records, call TutupBuku MCP tools, or test parallel agents. The existing accounting application and its approval requirements are unchanged.

## 1. Get the new files onto the VM

Your laptop changes must be committed and pushed to the GitHub repository before the VM can pull them. Do not commit `.env`, `.env.agent-demo`, tokens, passwords, or accounting data. The `.env.*` files are ignored by Git.

In your **AWS Instance Connect Ubuntu terminal**, run:

```bash
cd ~/tutupbuku
git status --short
```

If that shows VM changes, preserve them before pulling; do not discard them. If the checkout is clean, run:

```bash
git pull --ff-only
ls src/agent-demo/server.js scripts/start-agent-demo-gateway.js agent-demo.env.example
node --version
codebuddy --version
```

Expected: all three files exist, Node is **v22 or newer**, and CodeBuddy prints its installed version. Use your actual repository path if it is not `~/tutupbuku`. No `npm install` is needed for the demo; it uses Node built-ins.

Keep the same Ubuntu user and international CLI login that completed your earlier successful AI test. Do not start CodeBuddy using `sudo` or copy desktop session tokens. This implementation targets the CodeBuddy 2.164.0 gateway contract; another version needs its own live verification. See the [official HTTP API documentation](https://www.codebuddy.ai/docs/cli/http-api).

## 2. Create two separate passwords

```bash
cp agent-demo.env.example .env.agent-demo
chmod 600 .env.agent-demo
openssl rand -hex 24
openssl rand -hex 24
nano .env.agent-demo
```

Use the first generated value for `AGENT_DEMO_PASSWORD` and the second for `CODEBUDDY_GATEWAY_PASSWORD`. They must be different. The first is the browser/operator login password; the second protects the private CodeBuddy gateway.

Keep these values in the file:

```dotenv
AGENT_DEMO_USER=demo
AGENT_DEMO_HOST=127.0.0.1
AGENT_DEMO_PORT=3001
AGENT_DEMO_GATEWAY_URL=http://127.0.0.1:8081
```

In nano, save with **Ctrl+O**, then **Enter**, and exit with **Ctrl+X**. Do not paste the passwords into chat or screenshots. Each process below loads the file using Node's `--env-file`; you do not need to source it in Bash.

`AGENT_DEMO_GATEWAY_URL` is our backend setting. Do not substitute `CODEBUDDY_BASE_URL`: that official variable overrides the model-provider endpoint and can change how requests are authenticated or billed. The launcher rejects `CODEBUDDY_API_KEY` and `CODEBUDDY_BASE_URL` overrides rather than silently switching away from your existing CLI login. Consult the [official environment-variable reference](https://www.codebuddy.ai/docs/cli/env-vars) if startup reports an override.

## 3. Start the dedicated gateway

In the first Instance Connect terminal:

```bash
cd ~/tutupbuku
node --env-file=.env.agent-demo scripts/start-agent-demo-gateway.js
```

Leave it running. The launcher starts CodeBuddy with these arguments:

```text
--serve --agent cli --host 127.0.0.1 --port 8081
--auth password --tools ""
--strict-mcp-config --mcp-config '{"mcpServers":{}}'
```

The empty tool list disables agent tools, and strict empty MCP configuration excludes registered MCP servers. The gateway password is passed through the process environment rather than a command-line argument. CLI options are described in the [official CLI reference](https://www.codebuddy.ai/docs/cli/cli-reference).

Use this dedicated gateway for the connection test, even if your existing accounting-capable gateway is running on port 8080. The installed 2.164.0 REST execution path bypasses native interactive approval prompts. A text instruction such as “do not use tools” does not enforce a permission boundary by itself. This test therefore removes tools and MCP access; it does not claim to preserve the CLI's interactive approvals.

## 4. Start the HTML page and backend

Open a **second Instance Connect terminal**:

```bash
cd ~/tutupbuku
node --env-file=.env.agent-demo src/agent-demo/server.js
```

Expected startup message:

```text
TutupBuku agent test: http://127.0.0.1:3001
```

Leave this terminal running. Every page and API route requires the separate operator login. Only the fixed connection-test routes are exposed; this service does not proxy CodeBuddy's filesystem, terminal, process, or general agent APIs.

## 5. Publish this demo through ngrok

Open a **third Instance Connect terminal**. If ngrok is not installed:

```bash
sudo snap install ngrok
```

Use your ngrok account's authtoken. Enter it without putting its literal value in shell history:

```bash
read -rsp 'ngrok authtoken: ' TB_NGROK_TOKEN
printf '\n'
ngrok config add-authtoken "$TB_NGROK_TOKEN"
unset TB_NGROK_TOKEN
ngrok http http://127.0.0.1:3001
```

The terminal should show an **HTTPS forwarding URL**. Installation and token setup are documented by [ngrok for Linux](https://ngrok.com/download/linux?tab=download).

Do not add EC2 inbound rules for ports **3001 or 8081**. Both services bind to loopback, and ngrok makes an outbound connection. This separate demo accepts the tunnel's forwarded Host and does not need the accounting application's local-Host rewrite.

## 6. Click the button

Open the displayed **HTTPS URL on your laptop**. If ngrok displays its visitor notice, continue to the site. The browser then asks for:

- Username: `demo`.
- Password: the `AGENT_DEMO_PASSWORD` value from your VM file.

Click **Run AWS agent test** once. A queued/running job means the backend accepted the request; it is not proof that the model responded. Success requires the page to show:

```text
Completed
Actual AI reply
AWS_BUDDY_OK
```

Each new test invokes the AI through your CLI account and can deduct existing credits. Page loading, refreshing status, and retrying an already recorded request key do not create another model run. If the original request never reached the backend, explicitly retrying that same request starts its first run and uses credits.

The service permits one active test and up to 20 new tests per hour. It keeps a bounded in-memory history. A backend restart clears jobs and their request references; the page reports the lost state instead of automatically resubmitting. A new test after that restart is a separate request and can spend more credits.

## Troubleshooting

- **Needs setup:** configure both passwords in `.env.agent-demo`, then restart the relevant process.
- **Authentication failed:** the backend and dedicated gateway must use the same `CODEBUDDY_GATEWAY_PASSWORD`. The browser must use the other password.
- **Status unknown/unavailable:** use **Refresh status** to check the existing job. Do not immediately start a second test.
- **Stream unavailable, failed, or timed out:** the outcome is unconfirmed. CodeBuddy's completed run stream cannot necessarily be replayed; a late stream subscription can return 404. Check the VM before retrying. The client attempts cancellation of its known failed/timed-out run; cancellation is best effort, and automatic credit-consuming resubmission is disabled.
- **Public POST rejected:** ordinarily keep `AGENT_DEMO_PUBLIC_ORIGIN` unset. If your proxy rewrites Host, set it to the exact ngrok HTTPS origin, with no path, then restart the backend. Update it when the tunnel URL changes.
- **Launcher rejects an API-key/provider-endpoint override:** do not bypass the check to “make it work.” Inspect your own shell/CLI configuration and remove the unwanted override if you intend to use the already tested account login. Do not share the values of credentials.

## Keep the demo running after closing Instance Connect

Three ordinary browser terminal sessions are the easiest initial setup, but disconnecting them may stop their processes. For a longer demonstration, stop those three running commands with **Ctrl+C**, then run them in three windows of a tmux session. Restarting the demo backend clears its in-memory job history; finish any active test first.

```bash
sudo apt-get update
sudo apt-get install -y tmux
tmux new -s tutupbuku-demo
```

Start the gateway in the first window. Press **Ctrl+B**, then **C** to create a window for the backend; repeat for ngrok. Change to `~/tutupbuku` before each Node command. Press **Ctrl+B**, then **D** to detach. Reconnect later with:

```bash
tmux attach -t tutupbuku-demo
```

This does not survive a VM reboot or automatically recover a failed service. The VM must remain running, online, and able to authenticate to CodeBuddy, with sufficient account credits. Automatic startup and production monitoring are separate deployment steps.

## Verification boundary

Run code-level checks in the repository:

```bash
node --test test/agent-demo.test.js test/agent-demo-ui.test.js
node --check src/agent-demo/server.js
node --check src/agent-demo/codebuddy-client.js
node --check scripts/start-agent-demo-gateway.js
node --check public/agent-connection.js
```

Automated gateway tests use a mock HTTP service and do not spend AI credits. They check authentication, fixed request restrictions, duplicate submission handling, confirmed final-response parsing, and visible failures. They do not prove that your AWS gateway, public ngrok endpoint, or actual credit deduction works.

Live AWS/public execution of this new button remains unverified until you run the steps above and observe the final reply. Connecting the accounting workflows to CodeBuddy/MCP and demonstrating parallel accounting agents are still separate integration work.
