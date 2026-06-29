import { describe, it, expect } from 'vitest';
import { sanitizeProviderErrorMessage, applyRedactions, REDACTIONS } from '../../lib/error-redaction.js';

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
});
