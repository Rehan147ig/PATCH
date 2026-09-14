import { describe, it, expect } from 'vitest';
import { verifyWebhookSignature } from './github.js';

describe('github webhook signature', () => {
  it('verifies a valid HMAC signature', () => {
    const secret = 's3cret';
    const body = '{"event":"test"}';
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const sig = 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(verifyWebhookSignature(secret, body, sig)).toBe(true);
  });

  it('rejects an invalid signature', () => {
    expect(verifyWebhookSignature('secret', '{"a":1}', 'sha256=deadbeef')).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyWebhookSignature('secret', '{}', undefined)).toBe(false);
  });
});
