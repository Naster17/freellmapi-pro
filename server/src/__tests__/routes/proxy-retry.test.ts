import { describe, it, expect } from 'vitest';
import { isRetryableError, isPaymentRequiredError, isModelNotFoundError, isModelAccessForbiddenError, isKeyInvalidatingError, isModelGoneError } from '../../routes/proxy.js';

describe('isModelAccessForbiddenError (403 model-not-on-tier, drives whole-model skip — issue #256)', () => {
  it('flags a 403 reaching the proxy by message or attached status', () => {
    // GitHub Models / Cloudflare 403 a model the key's free tier can't reach.
    expect(isModelAccessForbiddenError(new Error('GitHub Models API error 403: Model not available on your plan'))).toBe(true);
    expect(isModelAccessForbiddenError(new Error('Cloudflare API error 403: this model requires a subscription'))).toBe(true);
    expect(isModelAccessForbiddenError(new Error('Forbidden'))).toBe(true);
    // #261 attaches the upstream status to the thrown error; honor it even if
    // the message phrasing omits the code.
    expect(isModelAccessForbiddenError(Object.assign(new Error('access denied'), { status: 403 }))).toBe(true);
  });

  it('does not flag rate limits, 404s, or payment errors', () => {
    expect(isModelAccessForbiddenError(new Error('429 Too Many Requests'))).toBe(false);
    expect(isModelAccessForbiddenError(new Error('OpenRouter API error 404: Provider returned error'))).toBe(false);
    expect(isModelAccessForbiddenError(new Error('HuggingFace Router API error 402: Payment required'))).toBe(false);
  });
});

describe('isModelNotFoundError (drives whole-model skip within a request)', () => {
  it('flags 404 / not-found / no-endpoints phrasings', () => {
    expect(isModelNotFoundError(new Error('OpenRouter API error 404: Provider returned error'))).toBe(true);
    expect(isModelNotFoundError(new Error('Model not found'))).toBe(true);
    expect(isModelNotFoundError(new Error('No endpoints found for openrouter/minimax/minimax-m2.5:free'))).toBe(true);
  });

  it('flags 410 Gone (model pulled upstream) by message or attached status — #339', () => {
    expect(isModelNotFoundError(new Error('Ollama Cloud API error 410: Gone'))).toBe(true);
    expect(isModelNotFoundError(Object.assign(new Error('Gone'), { status: 410 }))).toBe(true);
  });

  it('does not flag rate limits, 5xx, or payment errors', () => {
    expect(isModelNotFoundError(new Error('429 Too Many Requests'))).toBe(false);
    expect(isModelNotFoundError(new Error('503 Service Unavailable'))).toBe(false);
    expect(isModelNotFoundError(new Error('HuggingFace Router API error 402: Payment required'))).toBe(false);
  });
});

describe('isModelGoneError (drives the 410 "no longer available" response when the only model is EOL)', () => {
  it('flags 410 Gone by attached status regardless of message phrasing', () => {
    expect(isModelGoneError(Object.assign(new Error('whatever'), { status: 410 }))).toBe(true);
  });

  it('flags NVIDIA\'s end-of-life phrasing so the gateway returns a clear 410 instead of "rate limited"', () => {
    expect(isModelGoneError(new Error(
      'NVIDIA NIM API error 410: The model \'z-ai/glm-5.1\' has reached its end of life on 2026-07-02T00:00:00Z and is no longer available.',
    ))).toBe(true);
  });

  it('flags common "no longer available" / "retired" / "sunset" / "deprecated" / "removed from" phrasings', () => {
    expect(isModelGoneError(new Error('410 Gone: model is no longer available'))).toBe(true);
    expect(isModelGoneError(new Error('This model has been retired'))).toBe(true);
    expect(isModelGoneError(new Error('Model was sunset on 2025-01-01'))).toBe(true);
    expect(isModelGoneError(new Error('This model is deprecated and will be removed'))).toBe(true);
    expect(isModelGoneError(new Error('Model was removed from the catalog'))).toBe(true);
    expect(isModelGoneError(new Error('410: model has reached its end of life'))).toBe(true);
  });

  it('does NOT flag a bare 410 that lacks EOL phrasing (could be a transient provider-side Gone)', () => {
    expect(isModelGoneError(new Error('Ollama Cloud API error 410: Gone'))).toBe(false);
    expect(isModelGoneError(new Error('API error 410'))).toBe(false);
  });

  it('does NOT flag 404 / 403 / 429 / 5xx errors (those are model-not-found / tier / rate / outage, not EOL)', () => {
    expect(isModelGoneError(new Error('404 Not Found'))).toBe(false);
    expect(isModelGoneError(new Error('403 Forbidden'))).toBe(false);
    expect(isModelGoneError(new Error('429 Too Many Requests'))).toBe(false);
    expect(isModelGoneError(new Error('503 Service Unavailable'))).toBe(false);
    expect(isModelGoneError(new Error('402 Payment required'))).toBe(false);
  });
});

describe('isRetryableError', () => {
  describe('413 Payload Too Large', () => {
    it('treats explicit "413" in the error message as retryable', () => {
      expect(isRetryableError(new Error('GitHub Models API error 413: Request body too large'))).toBe(true);
      expect(isRetryableError(new Error('Cloudflare API error 413: Payload Too Large'))).toBe(true);
    });

    it('treats common 413 phrasings (no status code) as retryable', () => {
      expect(isRetryableError(new Error('Payload Too Large'))).toBe(true);
      expect(isRetryableError(new Error('Request body too large for this model'))).toBe(true);
      expect(isRetryableError(new Error('Request entity too large'))).toBe(true);
      expect(isRetryableError(new Error('Content too large'))).toBe(true);
    });
  });

  describe('404 model removed / not found (the bug #66 fixes)', () => {
    it('treats explicit "404" in the error message as retryable', () => {
      expect(isRetryableError(new Error('OpenRouter API error 404: Provider returned error'))).toBe(true);
      expect(isRetryableError(new Error('Groq API error 404: model not found'))).toBe(true);
    });

    it('catches OpenRouter\'s "No endpoints found" phrasing for deprecated models', () => {
      expect(isRetryableError(new Error('No endpoints found for openrouter/minimax/minimax-m2.5:free'))).toBe(true);
    });

    it('catches bare "not found" phrasing (any provider, any case)', () => {
      expect(isRetryableError(new Error('Model not found'))).toBe(true);
      expect(isRetryableError(new Error('The requested model was not found'))).toBe(true);
    });
  });

  describe('provider tool-call generation 400s fail over (#168)', () => {
    // Groq (and every other openai-compat provider) throws its errors as
    // `${name} API error ${status}: ${msg}`, so a tool-call-generation failure
    // surfaces as "Groq API error 400: Failed to call a function...". That
    // matches the "api error 400" rule, so it's ALREADY retryable and fails
    // over to the next provider — #168 is covered by existing behavior.
    it('treats a Groq failed_generation 400 as retryable', () => {
      expect(isRetryableError(new Error(
        "Groq API error 400: Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details.",
      ))).toBe(true);
    });

    it('treats any openai-compat "API error 400" as retryable (one provider rejects params another accepts)', () => {
      expect(isRetryableError(new Error('Cerebras API error 400: tool schema not supported'))).toBe(true);
    });

    it('but a bare validation "400 Bad Request" (our own schema) is still NOT retryable', () => {
      expect(isRetryableError(new Error('400 Bad Request'))).toBe(false);
    });
  });

  describe('403 model not on this key\'s tier fails over instead of 502 (issue #256)', () => {
    it('treats a 403 from GitHub Models / Cloudflare as retryable', () => {
      expect(isRetryableError(new Error('GitHub Models API error 403: Model not available on your plan'))).toBe(true);
      expect(isRetryableError(new Error('Cloudflare API error 403: this model requires a subscription'))).toBe(true);
    });

    it('treats a bare "Forbidden" / attached 403 status as retryable', () => {
      expect(isRetryableError(new Error('Forbidden'))).toBe(true);
      expect(isRetryableError(Object.assign(new Error('access denied'), { status: 403 }))).toBe(true);
    });

    it('still treats a bare 400 validation error as non-retryable', () => {
      expect(isRetryableError(new Error('400 Bad Request'))).toBe(false);
    });
  });

  describe('402 Payment Required out-of-credits fails over (graceful degradation)', () => {
    it('treats a HuggingFace Router 402 as retryable (same model lives on other providers)', () => {
      expect(isRetryableError(new Error('HuggingFace Router API error 402: Payment required'))).toBe(true);
    });

    it('catches common out-of-credits phrasings', () => {
      expect(isRetryableError(new Error('Payment Required'))).toBe(true);
      expect(isRetryableError(new Error('You exceeded your current quota: insufficient_quota'))).toBe(true);
      expect(isRetryableError(new Error('Insufficient credit for this request'))).toBe(true);
      expect(isRetryableError(new Error('Insufficient balance'))).toBe(true);
    });

    it('isPaymentRequiredError flags 402 (drives the long bench) but not a 429', () => {
      expect(isPaymentRequiredError(new Error('HuggingFace Router API error 402: Payment required'))).toBe(true);
      expect(isPaymentRequiredError(new Error('429 Too Many Requests'))).toBe(false);
      expect(isPaymentRequiredError(new Error('503 Service Unavailable'))).toBe(false);
    });
  });

  describe('410 Gone & un-enumerated upstream statuses fail over instead of 502 (#337/#339)', () => {
    // The headline bug: a provider error whose HTTP status the substring allowlist
    // never enumerated (410 Gone, 502, 504, 408 …) used to abort the whole chain
    // with a 502 — stranding the healthy paid routes still queued later in the
    // fallback order. It must rotate to the next route instead.
    it('treats an Ollama "410: Gone" as retryable, by message and by attached status', () => {
      // openai-compat throws via providerHttpError, so the real error carries both.
      expect(isRetryableError(new Error('Ollama Cloud API error 410: Gone'))).toBe(true);
      expect(isRetryableError(Object.assign(new Error('Ollama Cloud API error 410: Gone'), { status: 410 }))).toBe(true);
    });

    it('fails over on any 5xx the substring rules never listed, via the structured status', () => {
      // No '502'/'504'/'507' substring rule exists; the err.status catch-all covers them.
      expect(isRetryableError(Object.assign(new Error('Bad Gateway'), { status: 502 }))).toBe(true);
      expect(isRetryableError(Object.assign(new Error('Gateway Timeout'), { status: 504 }))).toBe(true);
      expect(isRetryableError(Object.assign(new Error('Insufficient Storage'), { status: 507 }))).toBe(true);
    });

    it('fails over on 408 request-timeout / 409 conflict by status', () => {
      expect(isRetryableError(Object.assign(new Error('Request Timeout'), { status: 408 }))).toBe(true);
      expect(isRetryableError(Object.assign(new Error('Conflict'), { status: 409 }))).toBe(true);
    });

    it('still treats genuinely-fatal 400/401 as NON-retryable even with an attached status', () => {
      // The structured catch-all must not swallow client-fatal errors — they fail on
      // every provider identically, so aborting the request is the correct behavior.
      expect(isRetryableError(Object.assign(new Error('Bad Request'), { status: 400 }))).toBe(false);
      expect(isRetryableError(Object.assign(new Error('Unauthorized'), { status: 401 }))).toBe(false);
    });
  });

  describe('existing categories still classify correctly', () => {
    it('429 / rate limits are retryable', () => {
      expect(isRetryableError(new Error('429 Too Many Requests'))).toBe(true);
      expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
      expect(isRetryableError(new Error('quota exhausted'))).toBe(true);
    });

    it('5xx and network errors are retryable', () => {
      expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
      expect(isRetryableError(new Error('500 Internal Server Error'))).toBe(true);
      expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
      expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
    });

    it('401 / bare-400 auth & validation errors are NOT retryable', () => {
      expect(isRetryableError(new Error('401 Unauthorized'))).toBe(false);
      expect(isRetryableError(new Error('400 Bad Request'))).toBe(false);
      expect(isRetryableError(new Error('Invalid API key'))).toBe(false);
      // 403 is deliberately NOT here anymore: a request-time 403 on a key that
      // passed validateKey is a model-not-on-tier gate, so it fails over to the
      // next model rather than 502-ing the request (issue #256). The 403 cases
      // are covered in the dedicated describe block above.
    });
  });
});

describe('isKeyInvalidatingError', () => {
  it('flags auth failures that prove the selected key is bad', () => {
    expect(isKeyInvalidatingError(Object.assign(new Error('Unauthorized'), { status: 401 }), 'groq')).toBe(true);
    expect(isKeyInvalidatingError(new Error('Google API error 400: API key not valid. Please pass a valid API key.'), 'google')).toBe(true);
    expect(isKeyInvalidatingError(new Error('OpenRouter API error 401: invalid bearer token'), 'openrouter')).toBe(true);
  });

  it('flags Google project/API-denied failures but not generic model-tier 403s', () => {
    expect(isKeyInvalidatingError(
      Object.assign(new Error('Google API error 403: Your project has been denied access to this API.'), { status: 403 }),
      'google',
    )).toBe(true);
    expect(isKeyInvalidatingError(
      Object.assign(new Error('Google API error 403: Generative Language API has not been used in project before or it is disabled.'), { status: 403 }),
      'google',
    )).toBe(true);
    expect(isKeyInvalidatingError(
      Object.assign(new Error('Cloudflare API error 403: this model requires a subscription'), { status: 403 }),
      'cloudflare',
    )).toBe(false);
    expect(isKeyInvalidatingError(Object.assign(new Error('access denied'), { status: 403 }), 'github')).toBe(false);
  });

  it('does not flag rate limits or transient server failures', () => {
    expect(isKeyInvalidatingError(Object.assign(new Error('Too Many Requests'), { status: 429 }), 'google')).toBe(false);
    expect(isKeyInvalidatingError(Object.assign(new Error('Service Unavailable'), { status: 503 }), 'google')).toBe(false);
  });
});
