import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openapiSpec } from './openapi.js';

describe('cleanup OpenAPI contract', () => {
  it('documents strict preview/run requests and report/error responses', () => {
    const paths = openapiSpec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const components = openapiSpec.components as {
      schemas: Record<string, Record<string, unknown>>;
    };
    const preview = paths['/api/cleanup/preview'].post;
    const run = paths['/api/cleanup/run'].post;
    const previewRequest = components.schemas.CleanupPreviewRequest;
    const runRequest = components.schemas.CleanupRunRequest;
    const report = components.schemas.CleanupReport;

    expect(preview.requestBody).toMatchObject({ required: false });
    expect(run.requestBody).toMatchObject({ required: true });
    expect(preview.responses).toHaveProperty('409');
    expect(run.responses).toHaveProperty('409');
    expect(previewRequest).toMatchObject({ additionalProperties: false });
    expect(runRequest).toMatchObject({
      additionalProperties: false,
      required: ['targets', 'confirm'],
      properties: {
        targets: { minItems: 1, uniqueItems: true },
        confirm: { type: 'boolean', enum: [true] },
      },
    });
    expect(report).toMatchObject({
      required: ['mode', 'status', 'startedAt', 'finishedAt', 'summary', 'targets', 'items'],
      properties: { status: { enum: ['completed', 'partial', 'failed'] } },
    });
  });
});

describe('OpenAPI route coverage', () => {
  it('documents every explicitly registered HTTP operation', () => {
    const routesDirectory = fileURLToPath(new URL('./routes/', import.meta.url));
    const routeSources = readdirSync(routesDirectory)
      .filter(name => name.endsWith('.ts'))
      .map(name => readFileSync(new URL(`./routes/${name}`, import.meta.url), 'utf8'));
    const registered = new Set<string>();
    const routePattern = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
    for (const source of routeSources) {
      for (const match of source.matchAll(routePattern)) addRoute(registered, match[1], match[2]);
      for (const match of source.matchAll(/registerScope\(app, '([^']+)'/g)) {
        addSkillRoutes(registered, match[1]);
      }
    }

    const paths = openapiSpec.paths as Record<string, Record<string, unknown>>;
    const documented = new Set<string>();
    for (const [path, operations] of Object.entries(paths)) {
      for (const method of Object.keys(operations)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          documented.add(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect([...documented].sort()).toEqual([...registered].sort());
  });

  it('documents runtime selection when creating a conversation', () => {
    const paths = openapiSpec.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths['/api/conversations'].post.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { properties: { agentType: { type: 'string' } } },
        },
      },
    });
  });
});

function addRoute(routes: Set<string>, method: string, path: string): void {
  routes.add(`${method.toUpperCase()} ${path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}')}`);
}

function addSkillRoutes(routes: Set<string>, base: string): void {
  addRoute(routes, 'post', `${base}/upload`);
  addRoute(routes, 'post', `${base}/import`);
  addRoute(routes, 'get', base);
  addRoute(routes, 'get', `${base}/:name`);
  addRoute(routes, 'get', `${base}/:name/info`);
  addRoute(routes, 'delete', `${base}/:name`);
}
