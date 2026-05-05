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

  it('throws typed API errors for exhausted 5xx responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('Bad gateway', { status: 502 }));

    await expect(requestJson('https://example.test', { fetchImpl, sleep: async () => {}, maxRetries: 1 }))
      .rejects.toMatchObject({ status: 502, retryable: true });
    await expect(requestJson('https://example.test', { fetchImpl, sleep: async () => {}, maxRetries: 1 }))
      .rejects.toBeInstanceOf(ApiError);
  });
});
