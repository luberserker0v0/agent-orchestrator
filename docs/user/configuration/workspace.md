# Workspace Configuration

The `workspace` section controls file storage, quotas, and canonical config enforcement.

## Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `basePath` | string | `'./workspace'` | Base directory for conversation workspaces. |
| `enforceCanonicalConfig` | boolean | `true` | Require canonical OpenCode config in workspaces. |
| `maxSizeBytes` | integer | `52428800` | Maximum workspace size in bytes. `0` = unlimited. |
| `storage` | object | `{ type: 'local' }` | Storage backend configuration. |

## Workspace Size

The `maxSizeBytes` field limits the total size of files in a conversation workspace.

| Value | Behavior |
|-------|----------|
| `0` | Unlimited — no size checks performed |
| `> 0` | Enforced — writes that would exceed the quota are rejected with `WORKSPACE_QUOTA_EXCEEDED` |

**Environment variable:** `AGENTORCHESTRATOR_WORKSPACE_MAXSIZEBYTES=0` sets unlimited.

### Common Sizes

| Value | Human Readable |
|-------|----------------|
| `0` | Unlimited |
| `52428800` | 50 MB |
| `104857600` | 100 MB |
| `524288000` | 500 MB |
| `1073741824` | 1 GB |

## Storage Backend

Currently only `local` storage is supported.

```jsonc
{
  "workspace": {
    "storage": { "type": "local" }
  }
}
```

**Planned:** `docker` storage backend for container-based workspace isolation.

## Canonical Config

When `enforceCanonicalConfig` is `true`, the orchestrator copies the canonical OpenCode configuration (`config/canonical-opencode.json`) to each workspace at conversation start. This ensures consistent provider configuration across all instances.

When `false`, the workspace must contain its own `opencode.json` or the instance will fail to start.

## Workspace Structure

Each conversation gets its own workspace directory:

```

Conversation workspaces persist across orchestrator restarts. Startup cleanup
removes only `.tmp-*` artifacts left by interrupted storage operations. A
workspace is removed when its conversation is explicitly deleted.

Conversation IDs are also used in filesystem and Kubernetes resource names.
They must contain 1-52 lowercase letters, digits, or hyphens and must start and
end with a letter or digit.
workspace/
  {conversation-id}/
    opencode.json          # OpenCode configuration
    .opencode/
      agents/
        agent-name.md      # Agent definitions
      agents.md            # AGENTS.md (optional)
      skills/
        skill-name/
          SKILL.md         # Skill instructions
    files/                 # User files
```
