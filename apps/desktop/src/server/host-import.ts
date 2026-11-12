/*
 * Importing media by a path on the host's own disk (the agents' import_media
 * and replace_media in a browser tab).
 *
 * The host copies the file into a staging folder beside browser uploads and
 * hands the tab a one-time id. The tab reads the copy over HTTP and imports it
 * with the normal importer, so the key, posters, proxies and asset record are
 * exactly what a dropped file would get. When the importer stores those bytes,
 * the tab's media store files the staged copy under its key (WEB.mediaCommit)
 * instead of uploading it back. A file the importer converted (an HEVC proxy,
 * a TIFF made PNG) is uploaded as usual, because the store holds what the
 * editor saved.
 *
 * Which files: a regular file whose real location lies inside one of the
 * host's import roots (the home directory unless the host was told otherwise)
 * and whose extension is a media type Powermove imports. The file is opened
 * once; its type and real location come from that open descriptor, and the
 * copy is read from it, so a path swapped after the check cannot change what
 * is read. A hard link inside a root to a file elsewhere counts as inside: the
 * name used is what is checked.
 */
import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { mkdir, open, readlink, realpath, rm, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { AGENT_MEDIA_MAX_BYTES, AUDIO_EXTENSIONS, CONVERTED_IMAGE_EXTENSIONS, CONVERTED_VIDEO_EXTENSIONS, NATIVE_IMAGE_EXTENSIONS, NATIVE_VIDEO_EXTENSIONS, mediaExtension } from '../shared/media-formats';
import { MIME_TYPES } from '../main/mime';
import { mediaFingerprint } from '../main/media-path-cache';

/** What the importer accepts: images, video, audio, 3D models and LUTs. */
const IMPORTABLE = new Set<string>([
  ...NATIVE_IMAGE_EXTENSIONS, ...CONVERTED_IMAGE_EXTENSIONS, ...NATIVE_VIDEO_EXTENSIONS, ...CONVERTED_VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS, 'obj', 'glb', 'gltf', 'cube'
]);
/** Staged copies live here, under the uploads root that WEB.mediaCommit accepts. Nothing in it outlives a host run. */
const STAGING = 'host-imports';
/** Long enough for an import to read and file its copy; an id unused by then is gone. */
const STAGED_LIFETIME_MS = 5 * 60_000;

/** The staged copy, as the tab needs it to build a File. */
export interface StagedImport {
  id: string;
  /** Where the copy sits under the uploads root; WEB.mediaCommit accepts it. */
  path: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  /** The Media Store key of these bytes: what the importer will store under. */
  key: string;
}

interface Owner {
  once(event: 'destroyed', listener: () => void): unknown;
  removeListener(event: 'destroyed', listener: () => void): unknown;
}

const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

/** Where an open file really is: from the descriptor on Linux, else a fresh resolution that must name the same file. */
async function locate(handle: FileHandle, requested: string, info: { dev: number; ino: number }): Promise<string> {
  const located = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => realpath(requested));
  const named = await stat(located).catch(() => null);
  if (!named || named.dev !== info.dev || named.ino !== info.ino) throw new Error('The file changed while it was being opened. Try again.');
  return located;
}

/**
 * Opens a host file a client may import, or says why not. The caller reads
 * from the returned handle and closes it; the checks describe that handle.
 */
export async function openImportSource(requested: unknown, roots: readonly string[]): Promise<{ handle: FileHandle; path: string; size: number; mtimeMs: number }> {
  if (typeof requested !== 'string' || requested.length > 4096 || requested.includes('\0') || !path.isAbsolute(requested)) {
    throw new Error('Provide an absolute path to a media file on the host.');
  }
  // Non-blocking, so naming a pipe cannot hang the open; it is refused below as not a regular file.
  let handle: FileHandle;
  try { handle = await open(requested, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY); }
  catch { throw new Error(`There is no file at ${requested} on the host.`); }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Import a regular media file, not a folder, pipe or device.');
    const located = await locate(handle, requested, info);
    const realRoots = await Promise.all(roots.map(root => realpath(root).catch(() => path.resolve(root))));
    if (!realRoots.some(root => inside(root, located))) {
      throw new Error(`The host only imports files inside ${realRoots.join(', ')}. Move or copy the file there first.`);
    }
    if (!IMPORTABLE.has(mediaExtension(located))) throw new Error('That is not a media file Powermove imports.');
    return { handle, path: located, size: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** The real path of a host file a client may import, or an error that says why not. */
export async function resolveImportPath(requested: unknown, roots: readonly string[]): Promise<{ path: string; size: number; mtimeMs: number }> {
  const { handle, ...source } = await openImportSource(requested, roots);
  await handle.close();
  return source;
}

/** Copies from the open source, stopping once it passes the limit (a file can grow while it is read). */
async function copyBounded(source: FileHandle, target: string, limit: number, tooLarge: () => Error): Promise<number> {
  let copied = 0;
  await pipeline(
    source.createReadStream({ start: 0, autoClose: false }),
    new Transform({ transform(chunk: Buffer, _encoding, done) { copied += chunk.length; done(copied > limit ? tooLarge() : null, chunk); } }),
    createWriteStream(target, { flags: 'wx', mode: 0o600 })
  );
  return copied;
}

interface Entry { path: string; owner: Owner; served: boolean; drop(): void }

export class HostImports {
  private readonly staged = new Map<string, Entry>();
  private readonly working = new Set<Promise<unknown>>();
  private readonly maxBytes: number;
  private readonly lifetime: number;

  constructor(private readonly uploadsRoot: string, private readonly roots: readonly string[], options: { maxBytes?: number; ttlMs?: number } = {}) {
    this.maxBytes = options.maxBytes ?? AGENT_MEDIA_MAX_BYTES;
    this.lifetime = options.ttlMs ?? STAGED_LIFETIME_MS;
  }

  private get root(): string { return path.join(this.uploadsRoot, STAGING); }

  /** Removes copies a previous host run left behind; nothing records them across runs. */
  async reclaim(): Promise<void> { await rm(this.root, { recursive: true, force: true }); }

  /**
   * Copies the file into staging. The copy is removed when it is committed,
   * released, unused for its lifetime, or its tab goes away, including while
   * it is still being made.
   */
  stage(owner: Owner, requested: unknown, maxBytes: unknown): Promise<StagedImport> {
    const work = this.make(owner, requested, maxBytes);
    this.working.add(work);
    const done = () => { this.working.delete(work); };
    work.then(done, done);
    return work;
  }

  private async make(owner: Owner, requested: unknown, maxBytes: unknown): Promise<StagedImport> {
    const limit = typeof maxBytes === 'number' && Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, this.maxBytes) : this.maxBytes;
    const tooLarge = () => new Error(`Media imports are limited to ${Math.floor(limit / 1048576)} MiB.`);
    let gone = false;
    const disconnected = () => { gone = true; };
    owner.once('destroyed', disconnected);
    const id = randomUUID();
    const dir = path.join(this.root, id);
    try {
      const source = await openImportSource(requested, this.roots);
      try {
        if (source.size > limit) throw tooLarge();
        const name = path.basename(source.path);
        const target = path.join(dir, name);
        await mkdir(dir, { recursive: true });
        const size = await copyBounded(source.handle, target, limit, tooLarge);
        const key = `media:${await mediaFingerprint(target)}`;
        if (gone) throw new Error('The tab that asked for this import disconnected.');
        this.keep(id, target, owner);
        return { id, path: target, name, size, type: MIME_TYPES[path.extname(name).toLowerCase()] ?? '', lastModified: Math.round(source.mtimeMs), key };
      } finally { await source.handle.close().catch(() => undefined); }
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    } finally { owner.removeListener('destroyed', disconnected); }
  }

  private keep(id: string, target: string, owner: Owner): void {
    const drop = () => { void this.forget(id); };
    const timer = setTimeout(drop, this.lifetime);
    timer.unref?.();
    owner.once('destroyed', drop);
    this.staged.set(id, { path: target, owner, served: false, drop: () => { clearTimeout(timer); owner.removeListener('destroyed', drop); } });
  }

  private async forget(id: string): Promise<void> {
    const entry = this.staged.get(id);
    if (!entry) return;
    this.staged.delete(id);
    entry.drop();
    await rm(path.dirname(entry.path), { recursive: true, force: true });
  }

  /** The staged file to serve for an id, once. The id is a random, short-lived capability. */
  file(id: string): string | null {
    const entry = this.staged.get(id);
    if (!entry || entry.served) return null;
    entry.served = true;
    return entry.path;
  }

  /** Removes the copy if WEB.mediaCommit has not already moved it into the store. */
  async release(owner: Owner, id: unknown): Promise<void> {
    if (typeof id === 'string' && this.staged.get(id)?.owner === owner) await this.forget(id);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.working]);
    await Promise.all([...this.staged.keys()].map(id => this.forget(id)));
  }
}
