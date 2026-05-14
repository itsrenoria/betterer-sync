import { describe, expect, it, vi } from 'vitest';
import { ApiError, requestJson } from '../http/request.js';

describe('requestJson', () => {
  it('retries 429 responses using Retry-After before succeeding', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('Too many', { status: 429, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const result = await requestJson('https://example.test', { fetchImpl, sleep, maxRetries: 2 });

    expect(result).toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not wait on Retry-After delays longer than the retry delay cap', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn()
      .mockResolvedValue(new Response('Daily API limit exceeded', {
        status: 429,
        headers: { 'Retry-After': '50569' },
      }));

    await expect(requestJson('https://example.test', {
      fetchImpl,
      sleep,
      maxRetries: 2,
      maxRetryDelayMs: 30_000,
    })).rejects.toMatchObject({ status: 429, retryable: true });
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws typed API errors for exhausted 5xx responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('Bad gateway', { status: 502 }));

    await expect(requestJson('https://example.test', { fetchImpl, sleep: async () => {}, maxRetries: 1 }))
      .rejects.toMatchObject({ status: 502, retryable: true });
    await expect(requestJson('https://example.test', { fetchImpl, sleep: async () => {}, maxRetries: 1 }))
      .rejects.toBeInstanceOf(ApiError);
  });

  it('includes response body details in API error messages', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(
      { error: 'Forbidden - invalid API key or unapproved app' },
      { status: 403 },
    ));

    await expect(requestJson('https://example.test/oauth/device/code', { fetchImpl }))
      .rejects.toThrow('Forbidden - invalid API key or unapproved app');
  });
});
