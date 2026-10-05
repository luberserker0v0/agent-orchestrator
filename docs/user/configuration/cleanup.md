# Logging and Cleanup Policy

AgentOrchestrator can rotate its own structured file logs and clean up persistent
session data that no longer belongs to a live conversation. Both capabilities are
opt-in. Console logging remains enabled when file logging is enabled.

## Configuration

```jsonc
{
  "logging": {
    "file": {
      "enabled": false,
      "directory": "./logs",
      "maxFileSizeBytes": 10485760,
      "maxRotatedFiles": 10,
      "retentionMs": 604800000
    }
  },
  "cleanup": {
    "ownerId": null,
    "sweepIntervalMs": 3600000,
    "orphanedData": {
      "enabled": false,
      "gracePeriodMs": 2592000000
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `logging.file.enabled` | `false` | Mirror filtered AO log records to JSONL. |
| `logging.file.directory` | `./logs` | Directory containing the active and rotated AO log files. A filesystem root and symlink destination are rejected. |
| `logging.file.maxFileSizeBytes` | `10485760` | Rotate before a complete JSON record would exceed this size. |
| `logging.file.maxRotatedFiles` | `10` | Maximum number of rotated AO log files after age pruning. |
| `logging.file.retentionMs` | `604800000` | Delete managed rotated files older than this duration. |
| `cleanup.ownerId` | `null` | Stable identifier for this AO installation. Required when orphan cleanup is enabled. |
| `cleanup.sweepIntervalMs` | `3600000` | Startup/hourly cleanup cadence in milliseconds. |
| `cleanup.orphanedData.enabled` | `false` | Enable orphan discovery and deletion for owned session data/PVCs. |
| `cleanup.orphanedData.gracePeriodMs` | `2592000000` | Full first-observed grace period before an orphan is eligible (30 days). |

Use an owner ID that stays constant across restarts and upgrades, for example
`production-us-east-1`. Changing it makes existing artifacts foreign and therefore
report-only. Do not reuse an owner ID for independent AO installations that share a
session root or Kubernetes namespace.

## What Is Deleted

- Explicit conversation deletion immediately quarantines and purges configured
  Direct/Docker session storage, or deletes the managed Kubernetes PVC after its
  Pod references are gone. Kubernetes mirrors the marker onto the instance CR so
  the placement controller cannot recreate storage during an interrupted delete.
  Durable `delete-pending` markers are retried by the
  startup/periodic coordinator even when orphan reaping remains disabled
  (Kubernetes retries still require healthy cluster status reporting).
- Periodic orphan cleanup considers only artifacts owned by this installation.
  The first executing sweep records the observation; a later sweep must see the
  artifact again after the complete grace period before deletion.
- Stopped, restarted, migrated, and idle-evicted conversations remain valid and
  keep their persistent data.
- Direct runtime data outside an explicit `sessionStorage.sharedRoot`, Docker
  runtimes without persistent session storage, foreign/unlabeled PVCs, symlinks,
  malformed records, and unsafe paths are never deleted.

The policy deletes whole orphaned stores. It does not prune individual OpenCode
session rows or run SQLite `VACUUM`.

## Administrative API

Preview is non-mutating:

```bash
curl -X POST http://localhost:8080/api/cleanup/preview \
  -H "Authorization: Bearer $AO_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"targets":["logs","persistentData"]}'
```

Run cleanup with an explicit confirmation:

```bash
curl -X POST http://localhost:8080/api/cleanup/run \
  -H "Authorization: Bearer $AO_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"targets":["logs","persistentData"],"confirm":true}'
```

The permissions are `cleanup:read` and `cleanup:run`. Built-in `user` and
`observer` roles do not receive them; custom roles may opt in. Manual runs always
use configured retention/grace values. Concurrent preview/run requests return
`409 CLEANUP_IN_PROGRESS`, and individual failures are reported in a successful
HTTP response with `partial` or `failed` status.

Reports contain artifact identifiers and conversation IDs, but never absolute
filesystem paths. Back up persistent session roots and PVCs before first enabling
orphan cleanup.
