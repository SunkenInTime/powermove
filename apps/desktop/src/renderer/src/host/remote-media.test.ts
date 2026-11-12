import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostMediaError, attachRemoteMedia, type MediaLink } from './remote-media';

const KEY = 'media:v2:3:abc';

/** A browser cache with nothing in it, which records what the wrapper writes back. */
function emptyCache() {
  const saved = new Map<string, Blob>();
  return {
    saved,
    put: vi.fn(async (id: string, blob: Blob) => { saved.set(id, blob); return true; }),
    get: vi.fn(async (value: unknown) => {
      const key = typeof value === 'string' ? value : (value as { storageKey?: string }).storageKey;
      return (key && saved.get(key)) || null;
    })
  };
}

const link: MediaLink = { invoke: vi.fn(async () => [] as never) };

function respond(...statuses: number[]) {
  const fetch = vi.fn(async () => {
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
    return status === 200 ? new Response(new Blob(['abc'], { type: 'video/mp4' })) : new Response('no', { status });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('remote media get', () => {
  it('loads and caches what the host returns', async () => {
    respond(200);
    const cache = emptyCache();
    const store = attachRemoteMedia(link, cache);

    const blob = await store.get({ storageKey: KEY, id: 'clip' });

    expect(await blob?.text()).toBe('abc');
    expect(cache.saved.has(KEY)).toBe(true);
  });

  it.each([401, 403])('says the session is not signed in when the host answers %i', async (status) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = respond(status);
    const cache = emptyCache();
    const store = attachRemoteMedia(link, cache);

    const read = store.get({ storageKey: KEY, id: 'clip' });

    await expect(read).rejects.toBeInstanceOf(HostMediaError);
    await expect(read).rejects.toThrow('Not signed in to the host · open the editor link again');
    // Signing in again is the only fix, so it is not retried.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.put).not.toHaveBeenCalled();
    expect(store.pending(KEY)).toBe(false);
  });

  it('names the status of any other host failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respond(503);
    const store = attachRemoteMedia(link, emptyCache());

    await expect(store.get({ storageKey: KEY, id: 'clip' }))
      .rejects.toThrow('Host error 503 · reload the page to try again');
  });

  it('says the host could not be reached when no response arrives', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const store = attachRemoteMedia(link, emptyCache());

    const read = store.get({ storageKey: KEY, id: 'clip' });

    await expect(read).rejects.toThrow('Host unreachable · reload the page to try again');
    await expect(read).rejects.toMatchObject({ status: 0, cause: expect.any(TypeError) });
  });

  it('reports media the host does not have as absent after retrying', async () => {
    vi.useFakeTimers();
    const fetch = respond(404);
    const store = attachRemoteMedia(link, emptyCache());

    const read = store.get({ storageKey: KEY, id: 'clip' });
    await vi.runAllTimersAsync();

    await expect(read).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('loads media another device finishes uploading during the retries', async () => {
    vi.useFakeTimers();
    respond(404, 404, 200);
    const store = attachRemoteMedia(link, emptyCache());

    const read = store.get({ storageKey: KEY, id: 'clip' });
    await vi.runAllTimersAsync();

    expect(await (await read)?.text()).toBe('abc');
  });
});
