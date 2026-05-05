export type FetchLike = typeof fetch;

export type RequestJsonOptions = RequestInit & {
  fetchImpl?: FetchLike;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly retryable: boolean;

  constructor(message: string, status: number, body: unknown, retryable: boolean) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

export async function requestJson<T = unknown>(
  url: string,
  options: RequestJsonOptions = {},
): Promise<T> {
  const { data } = await requestJsonWithResponse<T>(url, options);
  return data;
}

export async function requestJsonWithResponse<T = unknown>(
  url: string,
  options: RequestJsonOptions = {},
): Promise<{ data: T; response: Response }> {
  const {
    fetchImpl = fetch,
    maxRetries = 4,
    sleep = defaultSleep,
    ...requestOptions
  } = options;

  for (let attempt = 0; ; attempt++) {
    const response = await fetchImpl(url, requestOptions);
    const retryable = response.status === 429 || response.status >= 500;

    if (response.ok) {
      const data = response.status === 204
        ? undefined
        : await parseResponseBody(response);
      return { data: data as T, response };
    }

    const body = await parseResponseBody(response);
    if (retryable && attempt < maxRetries) {
      const delay = retryDelayMs(response, attempt);
      await sleep(delay);
      continue;
    }

    throw new ApiError(
      apiErrorMessage(response.status, url, body),
      response.status,
      body,
      retryable,
    );
  }
}

function apiErrorMessage(status: number, url: string, body: unknown): string {
  const detail = responseBodyDetail(body);
  return detail
    ? `HTTP ${status} for ${url}: ${detail}`
    : `HTTP ${status} for ${url}`;
}

function responseBodyDetail(body: unknown): string | null {
  if (body === undefined || body === null) {
    return null;
  }
  if (typeof body === 'string') {
    return body.slice(0, 500);
  }
  if (typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const direct = record.error ?? record.message ?? record.description;
    if (typeof direct === 'string') {
      return direct;
    }

    try {
      return JSON.stringify(body).slice(0, 500);
    } catch {
      return null;
    }
  }
  return String(body);
}

async function parseResponseBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (text.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }

    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }
  }

  return Math.min(30_000, 1000 * 2 ** attempt);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
