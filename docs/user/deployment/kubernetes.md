# Kubernetes Deployment

> **Status:** Planned

Kubernetes deployment support is planned but not yet implemented. This document outlines the planned architecture.

## Planned Components

| Component | Description |
|-----------|-------------|
| `Deployment` | AgentOrchestrator pod |
| `Service` | ClusterIP service for internal access |
| `ConfigMap` | Configuration file |
| `PersistentVolumeClaim` | Workspace storage |

## Planned Manifests

```
k8s/
├── deployment.yaml    # AgentOrchestrator Deployment
├── service.yaml       # ClusterIP Service
├── configmap.yaml     # Configuration
└── pvc.yaml           # Persistent Volume Claim
```

## Planned Architecture

```
┌─────────────────────────────────────────┐
│              Kubernetes Cluster          │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  AgentOrchestrator Pod          │    │
│  │  ┌─────────────────────────┐    │    │
│  │  │  AgentOrchestrator      │    │    │
│  │  │  (Node.js process)      │    │    │
│  │  └─────────────────────────┘    │    │
│  │                                 │    │
│  │  ┌─────────────────────────┐    │    │
│  │  │  OpenCode Sidecar       │    │    │
│  │  │  (Docker container)     │    │    │
│  │  └─────────────────────────┘    │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  PVC: Workspace Storage         │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

## Health Probes

| Probe | Path | Port | Initial Delay | Period |
|-------|------|------|---------------|--------|
| Liveness | `/health` | 8080 | 10s | 30s |
| Readiness | `/health` | 8080 | 5s | 10s |

## Current Alternative

For now, use Docker Compose or Docker with a systemd service for container orchestration. See [Docker Deployment](docker.md) and [npm Deployment](npm.md).
