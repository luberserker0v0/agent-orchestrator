> **DEPRECATED**: This file has been reorganized. See [new documentation](user/deployment/) for the updated deployment guide. This file will be removed in a future version.

# Deployment Guide

AgentOrchestrator can be deployed in three ways. Choose the one that fits your workflow.

---

## 1. Docker Image (Production)

Pull and run the pre-built image:

```bash
docker pull luberserker/agent-orchestrator
docker run -d --name aor \
  -p 8080:8080 \
  -v /data/workspace \
  -e AGENTORCHESTRATOR_SERVER_APIKEY=your-secret-key \
  luberserker/agent-orchestrator
```

Runtime defaults to `direct` — OpenCode runs as a child process inside the same container, sharing the filesystem. No extra setup needed.

### Custom config

Mount your own config and override via environment variables:

```bash
docker run -d --name aor \
  -p 8080:8080 \
  -v /host/path/ao.config.json:/app/ao.config.json:ro \
  -e AGENTORCHESTRATOR_SERVER_PORT=8080 \
  -e AGENTORCHESTRATOR_SERVER_HOST=0.0.0.0 \
  luberserker/agent-orchestrator
```

### Workspace persistence

Workspace data lives at `/data/workspace` inside the container. Mount a volume to persist across restarts:

```bash
docker run -d --name aor \
  -v aor-workspace:/data/workspace \
  luberserker/agent-orchestrator
```

### Container + Runtime + Storage compatibility

If you change the runtime to `docker` (to spawn OpenCode in sibling containers):

| AO deployment | Runtime | Storage | Works? | Reason |
|---------------|---------|---------|--------|--------|
| Container | `direct` | `local` | ✅ | Default. Child processes share the AO filesystem |
| Container | `docker` | `local` | ❌ | AO will **refuse to start**. Sibling containers cannot access the AO container's local filesystem |
| Container | `docker` | `docker-volume` | ⏳ | Requires a StorageBackend implementation that creates Docker volumes (not yet built) |

**Important**: AO does **not** support mounting `/var/run/docker.sock`. If you use a `docker` runtime while AO itself runs in a container, you must configure a non-local storage backend (like `docker-volume`) so agent containers can access workspace data through shared volumes.

---

## 2. `aor` CLI (Global npm install)

Install globally and run from anywhere:

```bash
npm install -g agent-orchestrator
```

### With an explicit config file

```bash
aor --config ./path/to/ao.config.json
# or shorter:
aor -c ./path/to/ao.config.json
```

### Without a config file

`aor` looks for a config file automatically in the current directory:

1. `ao.config.json` (recommended name)
2. `config/agentorchestrator.json` (legacy)
3. `config/agentorchestrator.example.json` (fallback — emits a warning)

```bash
# Looks for ao.config.json in CWD
cd /my/ao-project
aor
```

### Optional flags

```bash
aor --port 8080 --host 0.0.0.0
# or
aor -p 8080 -H 0.0.0.0
```

Flags override config file values and can be combined with environment variables.

### Production note

```bash
npm run build && npm start
```

This runs the compiled JS directly (same as `aor` without global install). Use a process manager like `pm2` or `systemd` for production:

```bash
npm install -g pm2
pm2 start aor -- -c /etc/ao/ao.config.json
```

---

## 3. Source Code / Development

Clone and run in development mode:

```bash
git clone <repo-url>
cd agent-orchestrator
npm install
cp config/agentorchestrator.example.json config/agentorchestrator.json
npm run dev
```

`npm run dev` uses `tsx watch` — source changes trigger automatic restart.

### Production build from source

```bash
npm run build
npm start
```

Or without a config file (falls back to `ao.config.json` or defaults):

```bash
node dist/index.js --port 8080
```

### Testing

```bash
npm run preflight   # lint + test + build
npm run test:e2e    # end-to-end tests
```

---

## Config resolution order

When `aor` or `index.js` starts, config is resolved in this priority:

1. `--config <path>` CLI flag — explicit path
2. `./ao.config.json` — recommended config file in CWD
3. `./config/agentorchestrator.json` — legacy config path
4. `./config/agentorchestrator.example.json` — example file (warning emitted)
5. Built-in defaults (no file needed)

Any field can be overridden by `AGENTORCHESTRATOR_*` environment variables (except arrays like `runtimes[]`).

---

## Runtime + Storage compatibility matrix

| AO host | OpenCode runtime | Storage type | Valid | Notes |
|---------|-----------------|--------------|-------|-------|
| Bare metal / VM | `direct` | `local` | ✅ | Default. Works out of the box |
| Bare metal / VM | `docker` | `local` | ✅ | AO bind-mounts the workspace path into the agent container |
| Container | `direct` | `local` | ✅ | Default for Docker deployment |
| Container | `docker` | `local` | ❌ | Startup error — incompatible |
| Container | `docker` | `docker-volume` | ⏳ | Planned — needs StorageBackend for Docker volumes |
