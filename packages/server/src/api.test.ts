import { describe, it, expect } from 'vitest';
import { createServer } from './index.js';

describe('control-plane API surface (§10)', () => {
  it('registers all required routes', () => {
    const server = createServer({ appId: '1', privateKey: 'x' }, 'manifests');
    const stack = (server as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } })._router.stack;
    const paths = new Set(stack.map((l) => l.route && `${Object.keys(l.route.methods).join(',').toUpperCase()} ${l.route.path}`).filter(Boolean));
    for (const expected of [
      'GET /api/repositories',
      'GET /api/repositories/:id/integrations',
      'GET /api/migrations',
      'GET /api/migrations/:id',
      'POST /api/migrations/:id/approve',
      'POST /api/migrations/:id/cancel',
      'POST /api/migrations/:id/retry',
      'GET /api/migrations/:id/evidence',
      'GET /api/migrations/:id/logs',
      'POST /api/scans',
      'GET /api/scans/:id',
      'GET /api/audit/export',
      'GET /api/settings/policies',
      'GET /api/runners',
      'GET /api/usage',
    ]) {
      expect(paths.has(expected)).toBe(true);
    }
  });
});
