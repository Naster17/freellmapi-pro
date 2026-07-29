import { describe, it, expect } from 'vitest';
import { sanitizeProviderErrorMessage, applyRedactions, REDACTIONS, summarizeAttemptError } from '../../lib/error-redaction.js';

describe('error-redaction', () => {
  describe('sanitizeProviderErrorMessage', () => {
    it('returns "Provider error" for empty input', () => {
      expect(sanitizeProviderErrorMessage('')).toBe('Provider error');
      expect(sanitizeProviderErrorMessage(null)).toBe('Provider error');
      expect(sanitizeProviderErrorMessage(undefined)).toBe('Provider error');
    });

    it('redacts Bearer tokens', () => {
      const out = sanitizeProviderErrorMessage('upstream: Bearer abc123def456');
      expect(out).not.toContain('abc123def456');
      expect(out).toContain('Bearer [redacted]');
    });

    it('redacts sk- keys when not preceded by api_key:', () => {
      const out = sanitizeProviderErrorMessage('auth failed for sk-abcdef1234567890');
      expect(out).toContain('[redacted-key]');
    });

    it('redacts api_key: <value> patterns', () => {
      const out = sanitizeProviderErrorMessage('config api_key: supersecretvalue123');
      expect(out).not.toContain('supersecretvalue123');
      expect(out).toContain('[redacted]');
    });

    it('redacts URLs', () => {
      const out = sanitizeProviderErrorMessage('upstream failed: https://api.example.com/v1/chat');
      expect(out).toContain('[redacted-url]');
    });

    it('truncates long messages', () => {
      const long = 'x'.repeat(500);
      const out = sanitizeProviderErrorMessage(long);
      expect(out.length).toBeLessThanOrEqual(240);
      expect(out).toMatch(/\.\.\.$/);
    });

    it('redacts labeled secrets in plain form', () => {
      expect(sanitizeProviderErrorMessage('api_key=supersecretvalue rejected')).toBe(
        'api_key=[redacted] rejected',
      );
    });

    it('redacts JSON-quoted secret labels', () => {
      const out = sanitizeProviderErrorMessage('upstream said {"api_key": "supersecretvalue123"}');
      expect(out).not.toContain('supersecretvalue123');
      expect(out).toContain('"api_key": "[redacted]');
    });

    it('redacts bare high-entropy tokens with no known prefix', () => {
      const out = sanitizeProviderErrorMessage('key co-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 was rejected');
      expect(out).not.toContain('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
      expect(out).toContain('[redacted-token]');
    });

    it('leaves ordinary provider prose and model ids intact', () => {
      const msg = 'model llama-3.3-70b-versatile is over capacity, retry after 30s (HTTP 429)';
      expect(sanitizeProviderErrorMessage(msg)).toBe(msg);
    });
  });

  describe('applyRedactions', () => {
    it('exports REDACTIONS array', () => {
      expect(Array.isArray(REDACTIONS)).toBe(true);
      expect(REDACTIONS.length).toBeGreaterThan(0);
    });

    it('applyRedactions processes the same patterns as the legacy REDACTIONS copy', () => {
      const out = applyRedactions('upstream sk-abcdef1234567890 extra https://x.test/y');
      expect(out).toContain('[redacted-key]');
      expect(out).toContain('[redacted-url]');
    });
  });

  describe('summarizeAttemptError', () => {
    it('applies the same secret redactions', () => {
      const out = summarizeAttemptError('401 rejected: Bearer sk-abc.def-12345 for key gsk_A1b2C3d4E5f6G7h8');
      expect(out).not.toContain('sk-abc.def-12345');
      expect(out).not.toContain('gsk_A1b2C3d4E5f6G7h8');
      expect(out).toContain('Bearer [redacted]');
    });

    it('caps the summary at 200 characters with an ellipsis', () => {
      const out = summarizeAttemptError('upstream exploded because ' + 'y '.repeat(300));
      expect(out.length).toBeLessThanOrEqual(200);
      expect(out.endsWith('...')).toBe(true);
    });

    it('leaves ordinary provider prose intact', () => {
      const msg = '429 Too Many Requests: rate limit reached for llama-3.3-70b, retry in 7m12s';
      expect(summarizeAttemptError(msg)).toBe(msg);
    });
  });
});
