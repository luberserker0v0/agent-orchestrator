# Quick Start

Get AgentOrchestrator running in under 5 minutes.

---

## Prerequisites

- **Node.js** >= 20.0.0
- **OpenCode CLI** installed (`opencode --version`)
- npm >= 10.0.0

---

## Install

```bash
git clone <repository-url>
cd agent-orchestrator
npm install
cp config/agentorchestrator.example.json config/agentorchestrator.json
```

Default configuration works out of the box — OpenCode instances spawn directly on the host using port range `30000-30100`.

For **Docker runtime**, set `"runtime": "docker"` in `config/agentorchestrator.json` and configure `runtimeConfig.docker.image`.

Optional **API key authentication** — set `server.apiKey` (min 8 chars) or env `AGENTORCHESTRATOR_SERVER_APIKEY`. All endpoints except `/health`, `/metrics`, and `/api-docs*` require `Authorization: Bearer <key>`.

---

## Start the Server

```bash
# Development mode (hot reload)
npm run dev
```

On startup you'll see:

```
AgentOrchestrator listening on http://127.0.0.1:11697
WebSocket endpoint: ws://127.0.0.1:11697/ws/{conversationId}
```

The port is dynamically assigned when `port: 0` in config. Set a fixed port (e.g. `8080`) if needed.

Check server health at `/health`:

```bash
curl http://127.0.0.1:11697/health
```

---

## Your First Conversation

AgentOrchestrator uses a **prepare → configure → start** flow.

### 1. Prepare a conversation

Creates a workspace directory without launching OpenCode:

```bash
curl -s -X POST http://127.0.0.1:11697/api/conversations \
  -H "Content-Type: application/json" \
  -d '{"id":"hello"}'
```

Response:

```json
{
  "id": "hello",
  "status": "prepared",
  "wsUrl": "ws://127.0.0.1:11697/ws/hello"
}
```

### 2. (Optional) Configure agent or files

Write an agent definition:

```bash
curl -s -X PUT http://127.0.0.1:11697/api/conversations/hello/agents \
  -H "Content-Type: application/json" \
  -d '{"name":"helper.md","content":"---\nname: Helper\n---\nYou are a helpful assistant."}'
```

Write a file:

```bash
curl -s -X PUT http://127.0.0.1:11697/api/conversations/hello/files \
  -H "Content-Type: application/json" \
  -d '{"path":"notes.txt","content":"Hello world"}'
```

### 3. Start OpenCode

```bash
curl -s -X POST http://127.0.0.1:11697/api/conversations/hello/start
```

Wait for status to become `running` (poll events or watch the server log).

### 4. Send a message

Via REST:

```bash
curl -s -X POST http://127.0.0.1:11697/api/conversations/hello/message \
  -H "Content-Type: application/json" \
  -d '{"text":"What files are in my workspace?"}'
```

Via WebSocket (install `wscat` first):

```bash
npm install -g wscat
wscat -c ws://127.0.0.1:11697/ws/hello
```

Then send:

```json
{"jsonrpc":"2.0","id":1,"method":"message.send","params":{"text":"List my files"}}
```

### 5. Clean up

```bash
curl -s -X DELETE http://127.0.0.1:11697/api/conversations/hello
```

Or stop the server (Ctrl+C) — it gracefully destroys all instances and cleans up workspaces.

---

## Production Build

```bash
npm run build
npm start
```

---

## Next Steps

- [API Reference](API.md) — full REST and WebSocket endpoint docs
- [Architecture Overview](ARCHITECTURE.md) — core modules and data flow
- [Quick Test Guide](QUICKTEST.md) — how to run unit and e2e tests
- [CHANGELOG](../CHANGELOG.md) — version history
