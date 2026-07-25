# Dashboard

AgentOrchestrator includes a built-in web dashboard for managing conversations and viewing real-time events.

## Access

Open in your browser:

```
http://localhost:8080/dashboard
```

The dashboard HTML is served without authentication. API calls from the dashboard require a valid API key if `server.apiKeys` is configured.

## Features

- **Conversation Management** — Create, start, stop, restart, and delete conversations
- **Real-time Events** — Live event timeline via WebSocket
- **Message Display** — View messages with tool call collapsing
- **Agent Management** — View and edit agent definitions
- **File Browser** — Browse conversation workspace files
- **Role-aware UI** — Adapts to admin/observer permissions

## Authentication

1. Open the dashboard
2. Enter your API key when prompted
3. The key is stored in `sessionStorage` (not persisted to disk)
4. All subsequent API calls and WebSocket connections use this key

**Observer mode:** The dashboard hides write controls when an observer key is used.

## Architecture

The dashboard is a single-file SPA (Single Page Application) served as inline HTML. No build step, no external assets, no CDN dependencies.

```
GET /dashboard  →  index.html (SPA)
  ├── Login screen (if no key in sessionStorage)
  ├── Conversation list (admin: full controls, observer: read-only)
  └── Conversation detail
       ├── Event timeline (real-time WebSocket)
       ├── Message display
       └── Agent/file/session panels
```

## Real-time Updates

The dashboard connects to the WebSocket endpoint for real-time event streaming:

```
ws://localhost:8080/ws/{conversationId}?apiKey={key}
```

Events are displayed in a timeline with:
- Color-coded event types
- Timestamps
- Collapsible tool call details
- Auto-scroll with pause on hover

## Limitations

- Single-file architecture limits UI complexity
- No message editing or retry
- No multi-conversation view (one conversation at a time)
- No data persistence (refresh resets the view)

**Future:** Phase 2 will add message sending from the dashboard UI.
