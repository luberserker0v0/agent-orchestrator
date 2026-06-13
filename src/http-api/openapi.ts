export const openapiSpec: Record<string, unknown> = {
  openapi: '3.0.3',
  info: {
    title: 'AgentOrchestrator API',
    version: '1.0.0',
    description: 'REST API for managing OpenCode conversation instances',
  },
  servers: [{ url: 'http://127.0.0.1:{port}', variables: { port: { default: '0', description: 'Server port (0 = auto-assigned)' } } }],
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        responses: {
          '200': {
            description: 'Server is healthy',
            content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, uptime: { type: 'number' }, timestamp: { type: 'string', format: 'date-time' } } } } },
          },
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['System'],
        summary: 'Prometheus metrics',
        responses: {
          '200': { description: 'Prometheus exposition format metrics', content: { 'text/plain': { schema: { type: 'string' } } } },
        },
      },
    },
    '/api/conversations': {
      post: {
        tags: ['Conversations'],
        summary: 'Create a conversation (prepare workspace, do not start OpenCode)',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string', description: 'Conversation ID (auto-generated if omitted)' } } } } } },
        responses: {
          '201': { description: 'Conversation created', content: { 'application/json': { schema: { $ref: '#/components/schemas/ConversationCreated' } } } },
          '409': { description: 'Conversation already exists', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      get: {
        tags: ['Conversations'],
        summary: 'List active conversations',
        responses: {
          '200': { description: 'Conversation list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ConversationInfo' } } } } },
        },
      },
    },
    '/api/conversations/{id}': {
      get: {
        tags: ['Conversations'],
        summary: 'Get single conversation details',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Conversation details', content: { 'application/json': { schema: { $ref: '#/components/schemas/ConversationInfo' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Conversations'],
        summary: 'Delete conversation (destroy instance + remove workspace)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '204': { description: 'Conversation deleted' },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/start': {
      post: {
        tags: ['Conversations'],
        summary: 'Start OpenCode instance for a conversation',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Instance starting', content: { 'application/json': { schema: { $ref: '#/components/schemas/ConversationStarted' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '409': { description: 'Already running', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Start failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/stop': {
      post: {
        tags: ['Conversations'],
        summary: 'Stop OpenCode instance and remove workspace',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Stopped', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } } },
          '409': { description: 'Not running', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Stop failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/restart': {
      post: {
        tags: ['Conversations'],
        summary: 'Restart OpenCode instance (keeps workspace)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Restarting', content: { 'application/json': { schema: { $ref: '#/components/schemas/ConversationStarted' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '409': { description: 'Invalid state', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Restart failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/events': {
      get: {
        tags: ['Conversations'],
        summary: 'Get recent conversation events',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 } },
        ],
        responses: {
          '200': { description: 'Event list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Event' } } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/config': {
      get: {
        tags: ['Config'],
        summary: 'Read opencode.json',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Config content', content: { 'application/json': { schema: { type: 'object' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['Config'],
        summary: 'Write/update opencode.json (full replacement with canonical enforcement)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', description: 'Partial opencode.json content' } } } },
        responses: {
          '204': { description: 'Config updated' },
          '400': { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      patch: {
        tags: ['Config'],
        summary: 'Partially update opencode.json (merge fields into current config)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', description: 'Fields to merge into the current opencode.json' } } } },
        responses: {
          '204': { description: 'Config updated' },
          '400': { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/agents': {
      put: {
        tags: ['Agents'],
        summary: 'Write agent definition file',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } }, required: ['name', 'content'] } } } },
        responses: {
          '204': { description: 'Agent written' },
          '400': { description: 'Missing name or content', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      get: {
        tags: ['Agents'],
        summary: 'List agent definitions, enriched with descriptions from running instance when available',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Agent list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/AgentItem' } } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/agents/{name}': {
      get: {
        tags: ['Agents'],
        summary: 'Read agent definition',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Agent content', content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } } } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Agents'],
        summary: 'Delete agent definition',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '204': { description: 'Agent deleted' },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/agent/config': {
      put: {
        tags: ['AGENTS.md'],
        summary: 'Write AGENTS.md content',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } } } },
        responses: {
          '204': { description: 'AGENTS.md written' },
          '400': { description: 'Missing content', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      get: {
        tags: ['AGENTS.md'],
        summary: 'Read AGENTS.md content',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'AGENTS.md content', content: { 'application/json': { schema: { type: 'object', properties: { content: { type: 'string' } } } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['AGENTS.md'],
        summary: 'Delete AGENTS.md',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '204': { description: 'AGENTS.md deleted' },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/files': {
      put: {
        tags: ['Files'],
        summary: 'Write a file in the conversation workspace',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } } },
        responses: {
          '204': { description: 'File written' },
          '400': { description: 'Missing path/content or path traversal', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/files/read': {
      post: {
        tags: ['Files'],
        summary: 'Read a file from the conversation workspace',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } } },
        responses: {
          '200': { description: 'File content', content: { 'application/json': { schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } } } },
          '400': { description: 'Missing path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'File or conversation not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/files/delete': {
      post: {
        tags: ['Files'],
        summary: 'Delete a file from the conversation workspace',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } } },
        responses: {
          '204': { description: 'File deleted' },
          '400': { description: 'Missing path', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/files/copy': {
      post: {
        tags: ['Files'],
        summary: 'Copy files from server-local allowed directories',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { source: { type: 'string' }, dest: { type: 'string' } }, required: ['source', 'dest'] } } } },
        responses: {
          '204': { description: 'Files copied' },
          '400': { description: 'Missing source or dest', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/files/list': {
      post: {
        tags: ['Files'],
        summary: 'List files in a workspace directory',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { path: { type: 'string', description: 'Directory path (default: root)' } } } } } },
        responses: {
          '200': { description: 'File list', content: { 'application/json': { schema: { type: 'object', properties: { path: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } } } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/message': {
      post: {
        tags: ['Messages'],
        summary: 'Send a message and get AI response (HTTP REST)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { text: { type: 'string' }, model: { type: 'string', description: 'Optional: providerID/modelID' }, agent: { type: 'string' } }, required: ['text'] } } } },
        responses: {
          '200': { description: 'AI response', content: { 'application/json': { schema: { $ref: '#/components/schemas/MessageResponse' } } } },
          '400': { description: 'Missing text', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '409': { description: 'Not running or not ready', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/providers': {
      get: {
        tags: ['Providers'],
        summary: 'List LLM providers and their models from the running instance',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Provider list', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProvidersResponse' } } } },
          '409': { description: 'Not running or not ready', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/sessions': {
      post: {
        tags: ['Sessions'],
        summary: 'Create a new session',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, parentID: { type: 'string' } } } } } },
        responses: {
          '201': { description: 'Session created', content: { 'application/json': { schema: { type: 'object' } } } },
          '409': { description: 'Not ready', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      get: {
        tags: ['Sessions'],
        summary: 'List all sessions',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Session list', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
          '409': { description: 'Not ready', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/sessions/{sid}': {
      get: {
        tags: ['Sessions'],
        summary: 'Get a single session',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sid', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Session details', content: { 'application/json': { schema: { type: 'object' } } } },
          '409': { description: 'Not ready', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Sessions'],
        summary: 'Delete a session',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sid', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '204': { description: 'Session deleted' },
          '409': { description: 'Not ready', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/sessions/{sid}/children': {
      get: {
        tags: ['Sessions'],
        summary: 'Get child sessions (session tree)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sid', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Child session list', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
          '409': { description: 'Not ready', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/sessions/{sid}/fork': {
      post: {
        tags: ['Sessions'],
        summary: 'Fork a session',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sid', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { messageID: { type: 'string' } } } } } },
        responses: {
          '201': { description: 'Session forked', content: { 'application/json': { schema: { type: 'object' } } } },
          '409': { description: 'Not ready', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/sessions/{sid}/messages': {
      get: {
        tags: ['Sessions'],
        summary: 'Get message history for a session',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sid', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: {
          '200': { description: 'Message list', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } },
          '409': { description: 'Not ready', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/skills/upload': {
      post: {
        tags: ['Skills'],
        summary: 'Upload a skill as zip archive',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'query', required: true, schema: { type: 'string' } },
        ],
        requestBody: { content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } },
        responses: {
          '204': { description: 'Skill uploaded' },
          '400': { description: 'Invalid name, missing SKILL.md, or zip slip', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '413': { description: 'Quota exceeded', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/skills/import': {
      post: {
        tags: ['Skills'],
        summary: 'Import a skill from server-local directory',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { source: { type: 'string' }, name: { type: 'string' } }, required: ['source', 'name'] } } } },
        responses: {
          '204': { description: 'Skill imported' },
          '400': { description: 'Invalid skill name', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '403': { description: 'Source path not allowed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Source not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '413': { description: 'Quota exceeded', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/skills': {
      get: {
        tags: ['Skills'],
        summary: 'List all skills',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Skill list', content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/skills/{name}': {
      get: {
        tags: ['Skills'],
        summary: 'Read SKILL.md content',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'SKILL.md content', content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } } } } } },
          '400': { description: 'Invalid skill name', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Skills'],
        summary: 'Delete a skill',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '204': { description: 'Skill deleted' },
          '400': { description: 'Invalid skill name', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/conversations/{id}/skills/{name}/info': {
      get: {
        tags: ['Skills'],
        summary: 'Get skill directory structure, size, and hash',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Skill info', content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, totalSize: { type: 'integer' }, sha256: { type: 'string' } } } } } },
          '400': { description: 'Invalid skill name', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

  },
  components: {
    schemas: {
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
      ConversationCreated: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['prepared'] },
          wsUrl: { type: 'string' },
        },
      },
      ConversationInfo: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['prepared', 'starting', 'running', 'stopped', 'error', 'destroyed'] },
          ready: { type: 'boolean' },
          needsRestart: { type: 'boolean' },
          port: { type: 'integer' },
          sessionId: { type: 'string' },
          wsUrl: { type: 'string' },
          createdAt: { type: 'integer' },
          updatedAt: { type: 'integer' },
        },
      },
      ConversationStarted: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          ready: { type: 'boolean' },
          port: { type: 'integer' },
          wsUrl: { type: 'string' },
          sessionId: { type: 'string' },
        },
      },
      Event: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          id: { type: 'string' },
          timestamp: { type: 'integer' },
          payload: { type: 'object' },
        },
      },
      MessageResponse: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
          text: { type: 'string' },
          parts: { type: 'array', items: { type: 'object' } },
        },
      },
      AgentItem: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
        },
      },
      ProvidersResponse: {
        type: 'object',
        properties: {
          providers: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, models: { type: 'array', items: { type: 'string' } } } } },
          default: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
    },
  },
};
