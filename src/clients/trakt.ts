import { ApiError, requestJson, requestJsonWithResponse } from '../http/request.js';
import type { Logger } from '../logger.js';
import type { StoredToken, SyncDatabase } from '../storage/database.js';
import type { TraktClientLike, TraktHistoryItem } from '../sync/types.js';

type TraktClientOptions = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  db: SyncDatabase;
  logger?: Logger;
};

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
};

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  created_at?: number;
};

const HISTORY_PATHS = [
  '/sync/history/movies',
  '/sync/history/episodes',
] as const;

export class TraktClient implements TraktClientLike {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly db: SyncDatabase;
  private readonly logger?: Logger;

  constructor(options: TraktClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.redirectUri = options.redirectUri;
    this.db = options.db;
    this.logger = options.logger;
  }

  async authenticateDeviceFlow(onCode: (code: DeviceCodeResponse) => void): Promise<StoredToken> {
    const code = await requestJson<DeviceCodeResponse>(this.url('/oauth/device/code'), {
      method: 'POST',
      headers: this.jsonHeaders(false),
      body: JSON.stringify({ client_id: this.clientId }),
    });
    onCode(code);

    const expiresAt = Date.now() + code.expires_in * 1000;
    while (Date.now() < expiresAt) {
      await sleep(code.interval * 1000);
      try {
        const token = await requestJson<TokenResponse>(this.url('/oauth/device/token'), {
          method: 'POST',
          headers: this.jsonHeaders(false),
          body: JSON.stringify({
            code: code.device_code,
            client_id: this.clientId,
            client_secret: this.clientSecret,
          }),
          maxRetries: 0,
        });
        return this.storeToken(token);
      } catch (error) {
        if (error instanceof ApiError && error.status === 400) {
          continue;
        }
        throw error;
      }
    }

    throw new Error('Trakt device code expired before authorization completed');
  }

  async *getHistory(options: { startAt?: string; endAt?: string; limit?: number } = {}): AsyncGenerator<TraktHistoryItem[]> {
    for (const path of HISTORY_PATHS) {
      for await (const page of this.getHistoryFromPath(path, options)) {
        yield page;
      }
    }
  }

  private async *getHistoryFromPath(
    path: typeof HISTORY_PATHS[number],
    options: { startAt?: string; endAt?: string; limit?: number },
  ): AsyncGenerator<TraktHistoryItem[]> {
    const limit = options.limit ?? 100;
    const seenHistoryIds = new Set<number>();
    let endAt = options.endAt;

    for (;;) {
      let oldestWatchedAt: string | null = null;

      for (let page = 1; ; page++) {
        const { data, response } = await this.requestAuthed<TraktHistoryItem[]>(path, {
          page,
          limit,
          ...(options.startAt ? { start_at: options.startAt } : {}),
          ...(endAt ? { end_at: endAt } : {}),
        });

        if (data.length === 0) {
          return;
        }

        oldestWatchedAt = olderTimestamp(oldestWatchedAt, oldestTimestamp(data));
        const unseen = data.filter((item) => {
          if (seenHistoryIds.has(item.id)) {
            return false;
          }
          seenHistoryIds.add(item.id);
          return true;
        });
        if (unseen.length > 0) {
          yield unseen;
        }

        const pageCount = Number(response.headers.get('X-Pagination-Page-Count'));
        if (Number.isFinite(pageCount) && page >= pageCount) {
          break;
        }
        if (data.length < limit) {
          return;
        }
      }

      if (options.startAt) {
        return;
      }

      const nextEndAt = beforeTimestamp(oldestWatchedAt);
      if (!nextEndAt || nextEndAt === endAt) {
        return;
      }
      endAt = nextEndAt;
    }
  }

  private async requestAuthed<T>(
    path: string,
    query: Record<string, string | number>,
    retryAfterRefresh = true,
  ): Promise<{ data: T; response: Response }> {
    const token = await this.validAccessToken();
    try {
      return await requestJsonWithResponse<T>(this.url(path, query), {
        headers: this.jsonHeaders(true, token),
      });
    } catch (error) {
      if (retryAfterRefresh && error instanceof ApiError && error.status === 401) {
        this.logger?.warn('Trakt token rejected, refreshing and retrying');
        await this.refreshToken();
        return this.requestAuthed<T>(path, query, false);
      }
      throw error;
    }
  }

  private async validAccessToken(): Promise<string> {
    const token = this.db.getToken();
    if (!token) {
      throw new Error('No Trakt token found. Run `betterer-sync auth` first.');
    }

    const refreshAt = token.expires_at - 300;
    if (Math.floor(Date.now() / 1000) >= refreshAt) {
      const refreshed = await this.refreshToken();
      return refreshed.access_token;
    }

    return token.access_token;
  }

  private async refreshToken(): Promise<StoredToken> {
    const token = this.db.getToken();
    if (!token) {
      throw new Error('No Trakt token found. Run `betterer-sync auth` first.');
    }

    const response = await requestJson<TokenResponse>(this.url('/oauth/token'), {
      method: 'POST',
      headers: this.jsonHeaders(false),
      body: JSON.stringify({
        refresh_token: token.refresh_token,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'refresh_token',
      }),
    });
    return this.storeToken(response);
  }

  private storeToken(token: TokenResponse): StoredToken {
    const createdAt = token.created_at ?? Math.floor(Date.now() / 1000);
    const stored = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_type: token.token_type,
      scope: token.scope,
      expires_at: createdAt + token.expires_in,
    };
    this.db.saveToken(stored);
    return stored;
  }

  private url(path: string, query?: Record<string, string | number>): string {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private jsonHeaders(authed: boolean, accessToken?: string): HeadersInit {
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': this.clientId,
      'user-agent': 'betterer-sync/0.1.0 (+https://github.com/itsrenoria/betterer-sync)',
      ...(authed && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function oldestTimestamp(items: TraktHistoryItem[]): string | null {
  return items.reduce<string | null>((oldest, item) => olderTimestamp(oldest, item.watched_at), null);
}

function olderTimestamp(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) {
    return right;
  }
  if (!Number.isFinite(rightMs)) {
    return left;
  }
  return rightMs < leftMs ? right : left;
}

function beforeTimestamp(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed - 1).toISOString();
}
