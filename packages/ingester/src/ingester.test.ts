import { describe, it, expect } from 'vitest';
import { diffOpenApi, type OpenApiDocument } from '../src/openapi-diff.js';
import { compileManifest, flattenDiff } from '../src/manifest-generator.js';

const baseSpec: OpenApiDocument = {
  openapi: '3.0.3',
  info: { title: 'Test API', version: '1.0' },
  paths: {
    '/v1/charges': {
      post: {
        operationId: 'createCharge',
        parameters: [
          { name: 'amount', in: 'query', schema: { type: 'integer' } },
          { name: 'currency', in: 'query', schema: { type: 'string' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount'],
                properties: {
                  amount: { type: 'integer' },
                  sku: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    amount: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/v1/legacy': {
      get: { operationId: 'legacyOp' },
    },
  },
};

function cloneSpec(): OpenApiDocument {
  return JSON.parse(JSON.stringify(baseSpec)) as OpenApiDocument;
}

describe('openapi diff', () => {
  it('detects removed operations and deprecations', () => {
    const next = cloneSpec();
    delete next.paths!['/v1/legacy'];
    (next.paths!['/v1/charges'].post as { deprecated?: boolean }).deprecated = true;

    const diff = diffOpenApi(baseSpec, next);
    expect(diff.removedOperations).toContain('GET /v1/legacy');
    expect(diff.newlyDeprecated).toContain('POST /v1/charges');
  });

  it('detects removed request fields', () => {
    const next = cloneSpec();
    delete (next.paths!['/v1/charges'].post!.requestBody!.content!['application/json'].schema!.properties! as Record<string, unknown>).sku;

    const diff = diffOpenApi(baseSpec, next);
    expect(diff.removedRequestFields).toEqual([
      { path: '/v1/charges', method: 'POST', field: 'sku' },
    ]);
  });

  it('detects new required request fields', () => {
    const next = cloneSpec();
    const body = next.paths!['/v1/charges'].post!.requestBody!.content!['application/json'].schema!;
    (body.properties as Record<string, unknown>).customer = { type: 'string' };
    (body.required as string[]).push('customer');

    const diff = diffOpenApi(baseSpec, next);
    expect(diff.newRequiredRequestFields).toEqual([
      { path: '/v1/charges', method: 'POST', field: 'customer' },
    ]);
  });

  it('detects type changes and removed parameters', () => {
    const next = cloneSpec();
    (next.paths!['/v1/charges'].post!.parameters![0].schema as { type: string }).type = 'string';
    next.paths!['/v1/charges'].post!.parameters = next.paths!['/v1/charges'].post!.parameters!.filter(
      (p) => p.name !== 'currency',
    );

    const diff = diffOpenApi(baseSpec, next);
    expect(diff.typeChanges).toContainEqual({
      path: '/v1/charges', method: 'POST', name: 'amount', from: 'integer', to: 'string',
    });
    expect(diff.removedParameters).toContainEqual({
      path: '/v1/charges', method: 'POST', name: 'currency',
    });
  });

  it('detects removed response fields', () => {
    const next = cloneSpec();
    delete (next.paths!['/v1/charges'].post!.responses!['200'].content!['application/json'].schema!.properties! as Record<string, unknown>).amount;

    const diff = diffOpenApi(baseSpec, next);
    expect(diff.removedResponseFields).toEqual([
      { path: '/v1/charges', method: 'POST', field: 'amount' },
    ]);
  });
});

describe('manifest generator', () => {
  it('compiles a diff into a valid manifest', () => {
    const next = cloneSpec();
    delete next.paths!['/v1/legacy'];
    delete (next.paths!['/v1/charges'].post!.requestBody!.content!['application/json'].schema!.properties! as Record<string, unknown>).sku;

    const diff = diffOpenApi(baseSpec, next);
    const manifest = compileManifest(diff, {
      vendor: 'acme',
      title: 'Acme API breaking changes',
      changedAt: '2026-10-01',
      sourceContract: 'https://acme.dev/openapi.json',
    });

    expect(manifest.schemaVersion).toBe('1.0');
    expect(manifest.id).toBe('acme-20261001');
    expect(manifest.severity).toBe('breaking');
    expect(manifest.sourceContract).toBe('https://acme.dev/openapi.json');
    expect(manifest.changes.length).toBeGreaterThan(0);
    expect(manifest.changes.some((c) => c.type === 'endpoint-removed')).toBe(true);
    expect(manifest.changes.some((c) => c.type === 'removed-field')).toBe(true);
    // every change has a match
    for (const c of manifest.changes) {
      expect(c.match).toBeDefined();
    }
  });

  it('flattens all diff categories', () => {
    const entries = flattenDiff({
      removedOperations: ['DELETE /v1/x'],
      newlyDeprecated: ['GET /v1/y'],
      removedParameters: [{ path: '/v1/x', method: 'DELETE', name: 'p' }],
      renamedParameters: [{ path: '/v1/x', method: 'DELETE', from: 'a', to: 'b' }],
      removedRequestFields: [{ path: '/v1/x', method: 'DELETE', field: 'f' }],
      newRequiredRequestFields: [{ path: '/v1/x', method: 'DELETE', field: 'g' }],
      removedResponseFields: [{ path: '/v1/x', method: 'DELETE', field: 'r' }],
      typeChanges: [{ path: '/v1/x', method: 'DELETE', name: 't', from: 'int', to: 'str' }],
    });
    expect(entries).toHaveLength(8);
  });
});
