import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostMediaError, attachRemoteMedia, readHostFile, releaseHostFile, type MediaLink } from './remote-media';
import { WEB } from '../../../shared/wire';

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

/** A host that has staged footage.mp4 and has nothing under any key yet. */
function stagingHost(...failures: string[]) {
  const failing = new Set(failures);
  const calls: Array<[string, unknown]> = [];
  const host: MediaLink = {
    invoke: vi.fn(async (channel: string, payload?: unknown) => {
      calls.push([channel, payload]);
      if (channel === WEB.mediaImportPath) return { id: 'stage-1', path: '/host/Remote Uploads/stage-1/footage.mp4', name: 'footage.mp4', size: 3, type: 'video/mp4', lastModified: 5, key: KEY } as never;
      if (failing.has(channel)) throw new Error(`${channel} failed: disk full`);
      if (channel === WEB.mediaHas) return [] as never;
      if (channel === WEB.uploadBegin) return 'upload-1' as never;
      if (channel === WEB.uploadFinish) return '/host/Remote Uploads/upload-1/blob' as never;
      return undefined as never;
    }) as MediaLink['invoke']
  };
  return { host, calls, channels: () => calls.map(([channel]) => channel) };
}

describe('import by host path', () => {
  // What the agent's import passes with each store: the host must hold the bytes by then.
  const agentStore = (seconds = 60) => ({ storageKey: KEY, hostDeadline: Date.now() + seconds * 1000 });

  it('reads the staged copy and files it under its key without uploading it back', async () => {
    const fetch = respond(200);
    const { host, calls, channels } = stagingHost();
    const file = await readHostFile(host, '/home/me/footage.mp4', 512);

    expect(calls[0]).toEqual([WEB.mediaImportPath, { path: '/home/me/footage.mp4', maxBytes: 512 }]);
    expect(fetch).toHaveBeenCalledWith('/__powermove/media-import?id=stage-1', { credentials: 'same-origin' });
    expect(file).toMatchObject({ name: 'footage.mp4', type: 'video/mp4', size: 3, lastModified: 5 });

    // put resolves only once the host has filed the copy.
    await attachRemoteMedia(host, emptyCache()).put(KEY, file, agentStore());
    expect(calls.at(-1)).toEqual([WEB.mediaCommit, { key: KEY, path: '/host/Remote Uploads/stage-1/footage.mp4', type: 'video/mp4' }]);
    expect(channels()).not.toContain(WEB.uploadBegin);
  });

  it('uploads what the importer saved when it is not the staged file', async () => {
    respond(200);
    const { host, channels } = stagingHost();
    await readHostFile(host, '/home/me/footage.mp4');
    // A playback proxy stored under the original's key is new bytes the host has not seen.
    const proxy = new Blob(['webm'], { type: 'video/webm' });

    await attachRemoteMedia(host, emptyCache()).put(KEY, proxy, agentStore());

    expect(channels()).toEqual([WEB.mediaImportPath, WEB.mediaHas, WEB.uploadBegin, WEB.uploadChunk, WEB.uploadFinish, WEB.mediaCommit]);
  });

  it('fails the store when the host keeps neither the staged copy nor an upload', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respond(200);
    const { host } = stagingHost(WEB.mediaCommit, WEB.uploadChunk);
    const file = await readHostFile(host, '/home/me/footage.mp4');

    await expect(attachRemoteMedia(host, emptyCache()).put(KEY, file, agentStore()))
      .rejects.toThrow('The host could not store the media');
  });

  it('fails the store when the importer saved a converted file the host did not get', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respond(200);
    const { host } = stagingHost(WEB.uploadChunk);
    await readHostFile(host, '/home/me/footage.mp4');
    const proxy = new Blob(['webm'], { type: 'video/webm' });

    await expect(attachRemoteMedia(host, emptyCache()).put(KEY, proxy, agentStore()))
      .rejects.toThrow('The host could not store');
  });

  it('gives up on a connected host that stops answering, once the import\'s deadline passes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respond(200);
    const { host } = stagingHost();
    await readHostFile(host, '/home/me/footage.mp4');
    vi.useFakeTimers();
    // The socket stays open; nothing comes back.
    const silent: MediaLink = { invoke: vi.fn(() => new Promise(() => {})) as MediaLink['invoke'] };
    const store = attachRemoteMedia(silent, emptyCache());
    const proxy = new Blob(['webm'], { type: 'video/webm' });

    const settled = vi.fn();
    const stored = store.put(KEY, proxy, agentStore(30));
    stored.then(settled, settled);
    await vi.advanceTimersByTimeAsync(31_000);

    expect(settled).toHaveBeenCalled();
    await expect(stored).rejects.toThrow('The host did not confirm it stored the media within 30 s');
  });

  it('releases without waiting on a host that stops answering', async () => {
    respond(200);
    const { host } = stagingHost();
    const file = await readHostFile(host, '/home/me/footage.mp4');
    const silent: MediaLink = { invoke: vi.fn(() => new Promise(() => {})) as MediaLink['invoke'] };

    const settled = vi.fn();
    releaseHostFile(silent, file).then(settled, settled);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settled).toHaveBeenCalled();
    expect(silent.invoke).toHaveBeenCalledWith(WEB.mediaImportRelease, 'stage-1');
  });

  it('leaves a drop of the same media alone while an agent imports it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    respond(200);
    const { host } = stagingHost(WEB.uploadChunk);
    const agentFile = await readHostFile(host, '/home/me/footage.mp4');
    const store = attachRemoteMedia(host, emptyCache());
    const dropped = new File(['abc'], 'footage.mp4', { type: 'video/mp4' });

    // A drop stores in the background exactly as before, even under the agent's key and with a failing upload.
    await expect(store.put(KEY, dropped, { storageKey: KEY })).resolves.toBe(true);
    // The agent's own store still waits, and fails.
    await expect(store.put(KEY, new Blob(['webm']), agentStore())).rejects.toThrow('The host could not store');
    await releaseHostFile(host, agentFile);
  });

  it('keeps ordinary imports in the background, as before', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { host } = stagingHost(WEB.uploadChunk);
    const dropped = new Blob(['png'], { type: 'image/png' });

    await expect(attachRemoteMedia(host, emptyCache()).put('media:v2:3:dropped', dropped, { storageKey: 'media:v2:3:dropped' })).resolves.toBe(true);
  });

  it('releases the staged copy once, and when the read fails', async () => {
    respond(200);
    const { host, calls } = stagingHost();
    const file = await readHostFile(host, '/home/me/footage.mp4');
    await releaseHostFile(host, file);
    await releaseHostFile(host, file);
    expect(calls.filter(([channel]) => channel === WEB.mediaImportRelease)).toEqual([[WEB.mediaImportRelease, 'stage-1']]);

    respond(500);
    await expect(readHostFile(host, '/home/me/footage.mp4')).rejects.toThrow('Host error 500');
    expect(calls.filter(([channel]) => channel === WEB.mediaImportRelease)).toHaveLength(2);
  });
});
