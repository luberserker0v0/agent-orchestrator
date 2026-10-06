# Docker Container Setup

This setup runs AgentOrchestrator and its bundled OpenCode binary in one Docker
container. Each active conversation is still a separate child process inside
that container. Named volumes preserve workspaces, managed sessions, and AO file logs.
No Docker socket is mounted.

## 1. Prerequisites

- Docker Engine 20.10 or newer with Docker Compose v2.
- Enough memory for AO plus approximately 100–200 MB per active OpenCode instance.
- Port `8080` available on the host.

Verify the tools:

```bash
docker version
docker compose version
```

## 2. Create the deployment files

Create an empty directory containing these files:

```text
ao-docker/
├── .env
├── ao-admin.key
├── agentorchestrator.json
└── compose.yaml
```

Set `.env` to a released AgentOrchestrator image version. Keep the CLI and image
on the same release when possible:

```dotenv
AO_VERSION=1.2.2
```

Generate a long random key. Save only its raw value in `ao-admin.key`, then put
the same value in `agentorchestrator.json`:

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 8080,
    "shutdownTimeoutMs": 15000,
    "apiKeys": [
      {
        "key": "REPLACE_WITH_A_LONG_RANDOM_KEY",
        "role": "admin",
        "name": "docker-admin"
      }
    ],
    "rbac": { "enabled": true }
  },
  "logging": {
    "file": {
      "enabled": true,
      "directory": "/data/logs",
      "maxFileSizeBytes": 10485760,
      "maxRotatedFiles": 10,
      "retentionMs": 604800000
    }
  },
  "cleanup": {
    "ownerId": "docker-host-1",
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
            "sharedRoot": "/data/workspace/.ao-sessions",
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
    "basePath": "/data/workspace",
    "enforceCanonicalConfig": true,
    "maxSizeBytes": 52428800,
    "storage": { "type": "local" }
  }
}
```

Create `compose.yaml`:

```yaml
services:
  agent-orchestrator:
    image: luberserker/agent-orchestrator:${AO_VERSION}
    container_name: agent-orchestrator
    command:
      - node
      - dist/index.js
      - serve
      - --config
      - /run/ao/agentorchestrator.json
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - ./agentorchestrator.json:/run/ao/agentorchestrator.json:ro
      - ao-workspace:/data/workspace
      - ao-logs:/data/logs
    secrets:
      - ao_admin_key
    restart: unless-stopped
    stop_grace_period: 30s
    logging:
      driver: local
      options:
        max-size: 10m
        max-file: "3"

secrets:
  ao_admin_key:
    file: ./ao-admin.key

volumes:
  ao-workspace:
  ao-logs:
```

Binding to `127.0.0.1` prevents direct network exposure. Put a TLS reverse proxy
in front before changing that binding to a public interface. On POSIX systems:

```bash
chmod 600 .env ao-admin.key agentorchestrator.json
```

## 3. Validate and start

Compose can validate interpolation and YAML before it creates resources:

```bash
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail 100 agent-orchestrator
```

Confirm the public health endpoint and the container health state:

```bash
curl --fail http://127.0.0.1:8080/health
docker inspect --format '{{.State.Health.Status}}' agent-orchestrator
```

The published image contains the `aor` executable but does not install it as a
global command. Run the packaged CLI inside the container:

```bash
docker compose exec -T agent-orchestrator node /app/bin/aor.js \
  --server http://127.0.0.1:8080 \
  --api-key-file /run/secrets/ao_admin_key \
  status
```

## 4. Run the lifecycle smoke test

For readability, the commands below keep the same full CLI prefix:

```bash
docker compose exec -T agent-orchestrator node /app/bin/aor.js --server http://127.0.0.1:8080 --api-key-file /run/secrets/ao_admin_key conversation create docker-smoke --agent-type opencode-direct --start
docker compose exec -T agent-orchestrator node /app/bin/aor.js --server http://127.0.0.1:8080 --api-key-file /run/secrets/ao_admin_key session create docker-smoke --title "Persistence check"
docker compose exec -T agent-orchestrator node /app/bin/aor.js --server http://127.0.0.1:8080 --api-key-file /run/secrets/ao_admin_key conversation stop docker-smoke
docker compose exec -T agent-orchestrator test -d /data/workspace/.ao-sessions/docker-smoke
docker compose exec -T agent-orchestrator node /app/bin/aor.js --server http://127.0.0.1:8080 --api-key-file /run/secrets/ao_admin_key conversation start docker-smoke
docker compose exec -T agent-orchestrator node /app/bin/aor.js --server http://127.0.0.1:8080 --api-key-file /run/secrets/ao_admin_key session list docker-smoke
```

The `test -d` command exits successfully when the managed session directory
survives the stop. Explicit deletion should remove it:

```bash
docker compose exec -T agent-orchestrator node /app/bin/aor.js --server http://127.0.0.1:8080 --api-key-file /run/secrets/ao_admin_key conversation delete docker-smoke --confirm
docker compose exec -T agent-orchestrator test ! -d /data/workspace/.ao-sessions/docker-smoke
```

## 5. Optional LLM check

Add the provider credential expected by your OpenCode configuration under the
service’s `environment` or as a Compose secret, recreate the container, and send
a prompt. Environment credentials are inherited by the child process:

```bash
docker compose up -d --force-recreate
docker compose exec -T agent-orchestrator node /app/bin/aor.js --server http://127.0.0.1:8080 --api-key-file /run/secrets/ao_admin_key conversation create docker-llm --agent-type opencode-direct --start
docker compose exec -T agent-orchestrator node /app/bin/aor.js --server http://127.0.0.1:8080 --api-key-file /run/secrets/ao_admin_key message send docker-llm --text "Reply with exactly: AO is ready"
docker compose exec -T agent-orchestrator node /app/bin/aor.js --server http://127.0.0.1:8080 --api-key-file /run/secrets/ao_admin_key conversation delete docker-llm --confirm
```

This check can consume provider credits.

## 6. Upgrade, stop, and remove

To move to another release, change `AO_VERSION` in `.env`, then:

```bash
docker compose pull
docker compose up -d
```

Normal shutdown and removal preserve named volumes:

```bash
docker compose down
```

Only after confirming that all workspaces, sessions, and logs may be destroyed:

```bash
docker compose down --volumes
```

## 7. Troubleshooting

```bash
docker compose ps
docker compose logs --tail 200 agent-orchestrator
docker compose exec -T agent-orchestrator opencode --version
docker compose exec -T agent-orchestrator ls -ld /data/workspace /data/workspace/.ao-sessions /data/logs
```

- Image pull failure: verify `AO_VERSION` names an available release tag.
- Permission denied under `/data`: ensure the volumes were created for this
  service; inspect them before changing ownership or deleting anything.
- `401` or `403`: compare the raw `ao-admin.key` value with the configured key.
- OpenCode instance timeout: inspect AO logs and verify the bundled
  `opencode --version` command works.
- Port collision: change the host side of `127.0.0.1:8080:8080` and pass that
  new URL to clients; the container-side port remains `8080`.
