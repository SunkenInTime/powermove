/*
 * Media on a remote host. The renderer keeps imported bytes in this
 * browser's IndexedDB under a content-addressed key. Another device opening
 * the same project has no such bytes, so every put is mirrored to the host
 * and a miss on get is answered from there.
 */
import { WEB, WEB_UPLOAD_CHUNK_BYTES } from '../../../shared/wire';

export interface MediaLink {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
}

type MediaStore = {
  put(id: string, blob: Blob, meta?: Record<string, unknown>): Promise<boolean>;
  get(value: unknown): Promise<Blob | null>;
  remove?(value: unknown): Promise<boolean>;
};

const storageKey = (value: unknown): string | null => {
  if (value && typeof value === 'object') {
    const record = value as { storageKey?: unknown; id?: unknown };
    return typeof record.storageKey === 'string' ? record.storageKey : typeof record.id === 'string' ? record.id : null;
  }
  return typeof value === 'string' ? value : null;
};

/** Files read from a copy the host staged (see server/host-import.ts): the copy's id and host path.
    Keyed by the import's own File, so nothing else stored under the same key is affected. */
const hostCopies = new WeakMap<Blob, { id: string; path: string }>();

interface StagedImport { id: string; path: string; name: string; size: number; type: string; lastModified: number }

/**
 * A file on the host's own disk, as a File the normal importer can take. The
 * host stages a copy; the bytes come down over HTTP like any host media, and
 * when the importer stores them the copy is filed under its key instead of
 * being uploaded back. Release it with releaseHostFile once the import is over.
 */
export async function readHostFile(link: MediaLink, path: string, maxBytes?: number): Promise<File> {
  const staged = await link.invoke<StagedImport>(WEB.mediaImportPath, { path, ...(Number.isFinite(maxBytes) ? { maxBytes } : {}) });
  try {
    const response = await fetch(`/__powermove/media-import?id=${encodeURIComponent(staged.id)}`, { credentials: 'same-origin' });
    if (!response.ok) throw new HostMediaError(`Host error ${response.status} while reading ${staged.name}`, response.status);
    const blob = await response.blob();
    if (blob.size !== staged.size) throw new Error(`The host sent ${blob.size} of ${staged.size} bytes of ${staged.name}`);
    const file = new File([blob], staged.name, { type: staged.type, lastModified: staged.lastModified });
    hostCopies.set(file, { id: staged.id, path: staged.path });
    return file;
  } catch (error) {
    await link.invoke(WEB.mediaImportRelease, staged.id).catch(() => undefined);
    throw error;
  }
}

/**
 * Drops the host's staged copy if the import did not file it. It does not wait
 * for the host: a host that stopped answering must not hold up the import's
 * own failure, and the host removes the copy anyway when it expires or the tab goes.
 */
export async function releaseHostFile(link: MediaLink, file: Blob): Promise<void> {
  const copy = hostCopies.get(file);
  if (!copy) return;
  hostCopies.delete(file);
  void link.invoke(WEB.mediaImportRelease, copy.id).catch(() => undefined);
}

class HostDeadlineError extends Error {}

/** Runs host work until the deadline (epoch ms); past it, aborts the work and rejects. */
async function byDeadline(deadline: number, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const seconds = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new HostDeadlineError(`The host did not confirm it stored the media within ${seconds} s. Nothing was changed.`));
      }, Math.max(0, deadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}

async function uploadBlob(link: MediaLink, key: string, blob: Blob, signal?: AbortSignal): Promise<void> {
  const id = await link.invoke<string>(WEB.uploadBegin, { name: 'blob', size: blob.size, kind: 'blob' });
  try {
    for (let offset = 0; offset < blob.size; offset += WEB_UPLOAD_CHUNK_BYTES) {
      signal?.throwIfAborted();
      const data = new Uint8Array(await blob.slice(offset, offset + WEB_UPLOAD_CHUNK_BYTES).arrayBuffer());
      await link.invoke(WEB.uploadChunk, { id, offset, data });
    }
    signal?.throwIfAborted();
    const hostPath = await link.invoke<string>(WEB.uploadFinish, id);
    await link.invoke(WEB.mediaCommit, { key, path: hostPath, type: blob.type || 'application/octet-stream' });
  } catch (error) {
    await link.invoke(WEB.uploadAbort, id).catch(() => undefined);
    throw error;
  }
}

/**
 * The host could not be asked for media, as opposed to not having it.
 * `status` is the HTTP status, or 0 when no response arrived.
 */
export class HostMediaError extends Error {
  constructor(message: string, readonly status: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HostMediaError';
  }
}

/** Wraps PM.MediaStore so puts reach the host and misses are filled from it. */
export interface RemoteMediaStore extends MediaStore {
  /** Sends up anything this browser has under these keys that the host lacks. */
  backfill(keys: string[]): Promise<void>;
  /** True while this key is being fetched from the host. */
  pending(key: unknown): boolean;
}

export function attachRemoteMedia(link: MediaLink, store: MediaStore, onChange: () => void = () => {}): RemoteMediaStore {
  const fetching = new Set<string>();
  const mirrored = new Set<string>();
  const inflight = new Map<string, Promise<void>>();

  /** Puts these bytes on the host under the key unless it has bytes there already. Rejects if it could not. */
  const toHost = async (key: string, blob: Blob, signal?: AbortSignal): Promise<void> => {
    const present = await link.invoke<string[]>(WEB.mediaHas, [key]);
    signal?.throwIfAborted();
    if (!present.includes(key)) {
      const copy = hostCopies.get(blob);
      // The host already has a staged copy's bytes; a failed move falls back to sending them.
      if (copy) await link.invoke(WEB.mediaCommit, { key, path: copy.path, type: blob.type || 'application/octet-stream' }).catch(() => uploadBlob(link, key, blob, signal));
      else await uploadBlob(link, key, blob, signal);
    }
    mirrored.add(key);
  };

  const mirror = (key: string, blob: Blob): Promise<void> => {
    if (mirrored.has(key)) return Promise.resolve();
    const existing = inflight.get(key);
    if (existing) return existing;
    const job = toHost(key, blob)
      .catch((error) => { console.warn('[remote-media] mirror failed', key, error); })
      .finally(() => { inflight.delete(key); });
    inflight.set(key, job);
    return job;
  };

  // Another device may still be uploading what this one is asking for, so a
  // 404 is retried before it means the host does not have the bytes. Any other
  // failure throws: the restore records why, instead of calling the file missing.
  const fetchFromHost = async (key: string, attempts = 4): Promise<Blob | null> => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response: Response;
      try {
        response = await fetch(`/__powermove/media?key=${encodeURIComponent(key)}`, { credentials: 'same-origin' });
        if (response.ok) return await response.blob();
      } catch (error) {
        throw new HostMediaError('Host unreachable · reload the page to try again', 0, { cause: error });
      }
      if (response.status === 401 || response.status === 403) {
        throw new HostMediaError('Not signed in to the host · open the editor link again', response.status);
      }
      if (response.status !== 404) {
        throw new HostMediaError(`Host error ${response.status} · reload the page to try again`, response.status);
      }
      await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    }
    return null;
  };

  /* media imported before the host kept copies, or on a host that lost them */
  const backfill = async (keys: string[]): Promise<void> => {
    const wanted = [...new Set(keys.filter((key) => key && !mirrored.has(key)))];
    if (!wanted.length) return;
    let present: string[] = [];
    try { present = await link.invoke<string[]>(WEB.mediaHas, wanted); } catch { return; }
    for (const key of present) mirrored.add(key);
    for (const key of wanted) {
      if (mirrored.has(key)) continue;
      const blob = await store.get({ storageKey: key, id: key }).catch(() => null);
      if (blob && blob.size > 0) await mirror(key, blob);
    }
  };

  const wrapped: RemoteMediaStore = {
    backfill,
    pending: (value) => { const key = storageKey(value); return !!key && fetching.has(key); },
    /**
     * Stores locally and mirrors to the host in the background. A caller that
     * passes `hostDeadline` (epoch ms), as an agent's import by host path does,
     * instead waits until the host holds the bytes and rejects if it does not
     * by then, so that import fails before the project gains the asset.
     */
    async put(id, blob, meta = {}) {
      const stored = await store.put(id, blob, meta);
      const key = storageKey({ storageKey: meta['storageKey'], id });
      if (!stored || !key || blob.size === 0) return stored;
      const deadline = meta['hostDeadline'];
      if (typeof deadline !== 'number') { void mirror(key, blob); return stored; }
      try { await byDeadline(deadline, signal => toHost(key, blob, signal)); }
      catch (error) {
        console.warn('[remote-media] host store failed', key, error);
        if (error instanceof HostDeadlineError) throw error;
        throw new Error(`The host could not store the media (${error instanceof Error ? error.message : String(error)}). Nothing was changed.`);
      }
      return stored;
    },
    async get(value) {
      const local = await store.get(value);
      if (local) return local;
      const key = storageKey(value);
      if (!key) return null;
      let remote: Blob | null = null;
      fetching.add(key); onChange();
      try { remote = await fetchFromHost(key); } catch (error) { console.warn('[remote-media] fetch failed', key, error); throw error; }
      finally { fetching.delete(key); onChange(); }
      if (!remote) return null;
      const stored = await store.put(key, remote, value && typeof value === 'object' ? (value as Record<string, unknown>) : { storageKey: key });
      mirrored.add(key);
      return stored ? (await store.get(value)) ?? remote : remote;
    },
    ...(store.remove ? { remove: (value: unknown) => store.remove!(value) } : {})
  };
  return wrapped;
}
