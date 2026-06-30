import { describe, it, expect } from 'vitest';
import { isKeyInvalidatingError } from '../../lib/error-classify.js';

describe('isKeyInvalidatingError — network-noise false positives', () => {
  it('does NOT flag a bare 401-in-message without structured status or credential-error code', () => {
    // Simulates an upstream whose error JSON contains "401" inside a model-level
    // failure (e.g. a 4xx body that quotes an inner status). Old code matched
    // this on `msg.includes('401')` and instantly killed the key.
    const err = new Error('Provider returned 401 in error body for non-auth reason');
    expect(isKeyInvalidatingError(err, 'groq')).toBe(false);
  });

  it('does NOT flag a generic 401 in the message for non-google', () => {
    const err = new Error('API error 401');
    expect(isKeyInvalidatingError(err, 'cerebras')).toBe(false);
    expect(isKeyInvalidatingError(err, 'mistral')).toBe(false);
  });

  it('still flags structured 401 status', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(isKeyInvalidatingError(err, 'groq')).toBe(true);
  });

  it('still flags credential-error code substrings', () => {
    expect(isKeyInvalidatingError(new Error('OpenRouter API error 401: invalid bearer token'), 'openrouter')).toBe(true);
    expect(isKeyInvalidatingError(new Error('API key not valid'), 'google')).toBe(true);
    expect(isKeyInvalidatingError(new Error('api_key_invalid'), 'google')).toBe(true);
  });

  it('still flags Google project/API-denied errors', () => {
    const err = Object.assign(new Error('Your project has been denied access'), { status: 403 });
    expect(isKeyInvalidatingError(err, 'google')).toBe(true);
  });
});
