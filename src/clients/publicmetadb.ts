import { ApiError, requestJson } from '../http/request.js';
import type {
  MediaType,
  PublicMetaDBClientLike,
  PublicMetaDBCreateWatchedInput,
  PublicMetaDBWatchedItem,
} from '../sync/types.js';

type PublicMetaDBOptions = {
  baseUrl: string;
  apiKey: string;
};

export class PublicMetaDBClient implements PublicMetaDBClientLike {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: PublicMetaDBOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
  }

  async getAllWatched(): Promise<PublicMetaDBWatchedItem[]> {
    const items: PublicMetaDBWatchedItem[] = [];
    const perPage = 500;

    for (let page = 1; ; page++) {
      const response = await requestJson<{
        items?: PublicMetaDBWatchedItem[];
        totalPages?: number;
      }>(this.url('/api/external/watched', { page, perPage }), {
        headers: this.authHeaders(),
      });

      const pageItems = response.items ?? [];
      items.push(...pageItems);

      if (pageItems.length === 0 || (response.totalPages !== undefined && page >= response.totalPages)) {
        return items;
      }
    }
  }

  async createWatched(input: PublicMetaDBCreateWatchedInput): Promise<PublicMetaDBWatchedItem> {
    const response = await requestJson<{ item?: PublicMetaDBWatchedItem } & PublicMetaDBWatchedItem>(
      this.url('/api/external/watched'),
      {
        method: 'POST',
        headers: this.jsonHeaders(),
        body: JSON.stringify(input),
      },
    );
    return response.item ?? response;
  }

  async patchWatched(id: string, input: { watched_at: string | null }): Promise<PublicMetaDBWatchedItem> {
    const response = await requestJson<{ item?: PublicMetaDBWatchedItem } & PublicMetaDBWatchedItem>(
      this.url(`/api/external/watched/${encodeURIComponent(id)}`),
      {
        method: 'PATCH',
        headers: this.jsonHeaders(),
        body: JSON.stringify(input),
      },
    );
    return response.item ?? response;
  }

  async deleteWatched(id: string): Promise<void> {
    await requestJson(this.url(`/api/external/watched/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
  }

  async lookupTmdbId(idType: string, idValue: string, mediaType: MediaType): Promise<number | null> {
    try {
      const response = await requestJson<{
        results?: Array<{ tmdb_id?: number; media_type?: MediaType }>;
      }>(this.url('/api/external/mappings/lookup', {
        id_type: idType,
        id_value: idValue,
        media_type: mediaType,
      }), {
        headers: this.authHeaders(),
      });

      return response.results?.find((item) => item.media_type === mediaType || item.media_type === undefined)?.tmdb_id ?? null;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private url(path: string, query?: Record<string, string | number>): string {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private authHeaders(): HeadersInit {
    return {
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private jsonHeaders(): HeadersInit {
    return {
      ...this.authHeaders(),
      'content-type': 'application/json',
    };
  }
}
