# End-to-End Setup Tutorials

Choose one deployment shape. Every tutorial configures authentication and
durable state, starts AgentOrchestrator, exercises the same conversation and
session lifecycle, verifies persistence, and explains safe teardown.

| Setup | AgentOrchestrator runs in | OpenCode instances run as | Guide |
|-------|---------------------------|---------------------------|-------|
| Direct | Host process | Host child processes | [Direct host](direct.md) |
| Docker | Docker container | Bundled child processes inside the AO container | [Docker container](docker.md) |
| Kubernetes | Deployment | One Pod and PVC per conversation | [Kubernetes](kubernetes.md) |

The Docker tutorial deliberately does not mount the Docker socket. This keeps
the simple container deployment isolated from the host Docker control plane.
To run one OpenCode container per conversation instead, install AO on the host
and select a `docker` runtime as documented in the
[runtime reference](../configuration/runtime.md).

All examples use an admin API key so every smoke-test command is available.
Generate a unique key for each installation, keep configuration and key files
out of source control, and terminate TLS at a trusted reverse proxy or ingress
before exposing the API outside a private network.

## What “end to end” covers

Each tutorial verifies:

1. configuration validation;
2. server or Deployment readiness;
3. authenticated CLI access;
4. conversation creation and OpenCode instance startup;
5. OpenCode session creation;
6. session persistence across conversation stop/restart;
7. explicit conversation deletion and managed-data cleanup; and
8. graceful, mode-appropriate teardown.

Sending an LLM prompt is an optional final check because it requires a separate
provider account and credential. The lifecycle smoke test itself does not spend
provider credits.
