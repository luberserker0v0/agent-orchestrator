# Direct Host Setup

This setup runs AgentOrchestrator as a Node.js process and starts one local
`opencode serve` child process per active conversation. It is the shortest path
for development and trusted single-host deployments.

## 1. Prerequisites

- Node.js 24 or newer and npm 10 or newer.
- OpenCode installed on the same host. The pinned example runtime is `1.17.8`.
- A free local TCP port (this guide uses `8080`).

Install and verify the two CLIs:

```bash
npm install -g @luberserker0v0/agent-orchestrator
npm install -g opencode-ai@1.17.8
node --version
aor --version
opencode --version
```

OpenCode also publishes platform-specific installation methods in its
[official installation guide](https://opencode.ai/docs). Windows users get the
most predictable process and filesystem behavior in WSL2.

## 2. Create a private working directory

Create a directory that will remain the AgentOrchestrator working directory:

```bash
mkdir ao-direct
cd ao-direct
mkdir workspace sessions logs
```

Generate a long random admin key with your password manager or platform secret
tool. Save only the raw value (no quotes) in `ao-admin.key`, and put the same
value in `server.apiKeys[0].key` below. Do not commit either file.

## 3. Create `ao.config.json`

Replace `REPLACE_WITH_A_LONG_RANDOM_KEY` before starting the service:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8080,
    "shutdownTimeoutMs": 15000,
    "apiKeys": [
      {
        "key": "REPLACE_WITH_A_LONG_RANDOM_KEY",
        "role": "admin",
        "name": "local-admin"
      }
    ],
    "rbac": { "enabled": true }
  },
  "logging": {
    "file": {
      "enabled": true,
      "directory": "./logs",
      "maxFileSizeBytes": 10485760,
      "maxRotatedFiles": 10,
      "retentionMs": 604800000
    }
  },
  "cleanup": {
    "ownerId": "direct-host-1",
    "sweepIntervalMs": 3600000,
    "orphanedData": {
      "enabled": false,
      "gracePeriodMs": 2592000000
    }
  },
  "orchestrator": {
    "maxInstances": 4,
    "idleTimeoutMs": 600000,
    "idleSweepIntervalMs": 60000,
    "portRange": {
      "start": 30000,
      "end": 30010,
      "allowDynamicFallback": true
    },
    "defaultAgentType": "opencode-direct",
    "runtimes": [
      {
        "id": "opencode-direct",
        "type": "direct",
        "config": {
          "binary": "opencode",
          "version": "1.17.8",
          "sessionStorage": {
            "sharedRoot": "./sessions",
            "mode": "xdg"
          }
        }
      }
    ],
    "healthCheck": {
      "retries": 20,
      "intervalMs": 500,
      "clientTimeoutMs": 5000
    },
    "sse": {
      "enabled": true,
      "reconnectMaxAttempts": 10,
      "reconnectBaseMs": 1000,
      "filterHeartbeat": true
    }
  },
  "workspace": {
    "basePath": "./workspace",
    "enforceCanonicalConfig": true,
    "maxSizeBytes": 52428800,
    "storage": { "type": "local" }
  }
}
```

Relative paths resolve from the directory in which `aor serve` runs. A stable
`cleanup.ownerId` identifies data owned by this installation; do not share it
with another AO process that uses the same storage roots.

On POSIX systems, restrict the credential-bearing files:

```bash
chmod 600 ao-admin.key ao.config.json
```

Validate without starting the service:

```bash
aor config validate ./ao.config.json
aor --config ./ao.config.json runtime list
```

## 4. Start AgentOrchestrator

Run this from the `ao-direct` directory and leave the terminal open:

```bash
aor serve --config ./ao.config.json
```

Expected results include a listening address on port `8080` and no runtime or
configuration error. Console output remains enabled; the same filtered records
are written to `logs/agentorchestrator.jsonl`.

## 5. Run the lifecycle smoke test

Open a second terminal in `ao-direct`. The options are repeated below so no
credential is placed in process arguments:

```bash
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key status
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation create direct-smoke --agent-type opencode-direct --start
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation get direct-smoke
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key session create direct-smoke --title "Persistence check"
```

Stopping a conversation destroys the process but must preserve the managed
session directory. Restart it and confirm the session still exists:

```bash
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation stop direct-smoke
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation start direct-smoke
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key session list direct-smoke
```

Delete the conversation only after the persistence check. Explicit deletion
removes its workspace and managed session data:

```bash
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation delete direct-smoke --confirm
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation list
```

## 6. Optional LLM check

Configure a provider using OpenCode’s supported authentication mechanism before
starting AO, so child processes inherit the credential. Then create a fresh
conversation and send a low-cost prompt, optionally selecting a provider/model:

```bash
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation create direct-llm --agent-type opencode-direct --start
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key message send direct-llm --text "Reply with exactly: AO is ready"
aor --server http://127.0.0.1:8080 --api-key-file ./ao-admin.key conversation delete direct-llm --confirm
```

This call can consume provider credits. If no default model is configured, add
`--model provider/model` using a model available to your OpenCode installation.

## 7. Shutdown and diagnose

Press `Ctrl+C` in the server terminal. AO stops accepting requests, closes
WebSockets, terminates active OpenCode processes, flushes logs, and exits within
`shutdownTimeoutMs`.

If startup fails:

```bash
opencode --version
aor config validate ./ao.config.json
curl http://127.0.0.1:8080/health
```

- `EADDRINUSE`: change `server.port` or stop the process already using `8080`.
- OpenCode readiness timeout: run `opencode serve --port 30000` directly and
  inspect its output, then stop it before retrying AO.
- `401` or `403`: ensure `ao-admin.key` contains exactly the configured value,
  without quotes or extra lines.
- Session missing after restart: confirm `sessionStorage.sharedRoot` is writable
  and that `aor serve` is always launched from the same working directory.
