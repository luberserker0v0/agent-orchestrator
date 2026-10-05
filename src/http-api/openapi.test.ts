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
