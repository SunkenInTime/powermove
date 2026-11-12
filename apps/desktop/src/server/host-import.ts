/*
 * Importing media by a path on the host's own disk (the agents' import_media
 * and replace_media in a browser tab).
 *
 * The host copies the file to where browser uploads land and hands the tab a
 * one-time id. The tab reads the copy over HTTP and imports it with the normal
 * importer, so the key, posters, proxies and asset record are exactly what a
 * dropped file would get. When the importer stores those bytes, the tab's
 * media store files the staged copy under its key (WEB.mediaCommit) instead of
 * uploading it back. A file the importer converted (an HEVC proxy, a TIFF made
 * PNG) is uploaded as usual, because the store holds what the editor saved.
 *
 * Which files: a regular file whose real path lies inside one of the host's
 * import roots (the home directory unless the host was told otherwise) and
 * whose extension is a media type Powermove imports. Symlinks are followed
 * before both checks, so a link cannot reach outside the roots or disguise a
 * file as media.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { AUDIO_EXTENSIONS, CONVERTED_IMAGE_EXTENSIONS, CONVERTED_VIDEO_EXTENSIONS, NATIVE_IMAGE_EXTENSIONS, NATIVE_VIDEO_EXTENSIONS, mediaExtension } from '../shared/media-formats';
import { MIME_TYPES } from '../main/mime';

/** What the importer accepts: images, video, audio, 3D models and LUTs. */
const IMPORTABLE = new Set<string>([
  ...NATIVE_IMAGE_EXTENSIONS, ...CONVERTED_IMAGE_EXTENSIONS, ...NATIVE_VIDEO_EXTENSIONS, ...CONVERTED_VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS, 'obj', 'glb', 'gltf', 'cube'
]);

/** The staged copy, as the tab needs it to build a File. */
export interface StagedImport {
  id: string;
  /** Where the copy sits under the uploads root; WEB.mediaCommit accepts it. */
  path: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

interface Owner { once(event: 'destroyed', listener: () => void): unknown }

const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

/** The real path of a host file a client may import, or an error that says why not. */
export async function resolveImportPath(requested: unknown, roots: readonly string[]): Promise<{ path: string; size: number; mtimeMs: number }> {
  if (typeof requested !== 'string' || requested.length > 4096 || requested.includes('\0') || !path.isAbsolute(requested)) {
    throw new Error('Provide an absolute path to a media file on the host.');
  }
  let resolved: string;
  try { resolved = await realpath(requested); } catch { throw new Error(`There is no file at ${requested} on the host.`); }
  const realRoots = await Promise.all(roots.map(root => realpath(root).catch(() => path.resolve(root))));
  if (!realRoots.some(root => inside(root, resolved))) {
    throw new Error(`The host only imports files inside ${realRoots.join(', ')}. Move or copy the file there first.`);
  }
  if (!IMPORTABLE.has(mediaExtension(resolved))) throw new Error('That is not a media file Powermove imports.');
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error('Import a regular media file, not a folder or device.');
  return { path: resolved, size: info.size, mtimeMs: info.mtimeMs };
}

export class HostImports {
  private readonly staged = new Map<string, { path: string; owner: Owner }>();

  constructor(private readonly uploadsRoot: string, private readonly roots: readonly string[], private readonly maxBytes: number) {}

  /** Copies the file next to browser uploads. Kept until committed, released, or its tab goes away. */
  async stage(owner: Owner, requested: unknown, maxBytes: unknown): Promise<StagedImport> {
    const limit = typeof maxBytes === 'number' && Number.isSafeInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, this.maxBytes) : this.maxBytes;
    const source = await resolveImportPath(requested, this.roots);
    const tooLarge = () => new Error(`Media imports are limited to ${Math.floor(limit / 1048576)} MiB.`);
    if (source.size > limit) throw tooLarge();
    const id = randomUUID();
    const dir = path.join(this.uploadsRoot, id);
    const name = path.basename(source.path);
    const target = path.join(dir, name);
    await mkdir(dir, { recursive: true });
    try {
      // A clone where the filesystem has them; otherwise the kernel copies without loading the file.
      await copyFile(source.path, target, constants.COPYFILE_FICLONE);
      // The copy is what the tab will read and the store will keep, so it is what gets measured.
      const size = (await stat(target)).size;
      if (size > limit) throw tooLarge();
      this.staged.set(id, { path: target, owner });
      owner.once('destroyed', () => { void this.release(owner, id); });
      return { id, path: target, name, size, type: MIME_TYPES[path.extname(name).toLowerCase()] ?? '', lastModified: Math.round(source.mtimeMs) };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** The staged file to serve for an id. The id is a random one-time capability. */
  file(id: string): string | null { return this.staged.get(id)?.path ?? null; }

  /** Removes the copy if WEB.mediaCommit has not already moved it into the store. */
  async release(owner: Owner, id: unknown): Promise<void> {
    const entry = typeof id === 'string' ? this.staged.get(id) : undefined;
    if (!entry || entry.owner !== owner) return;
    this.staged.delete(id as string);
    await rm(path.dirname(entry.path), { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    const dirs = [...this.staged.values()].map(entry => path.dirname(entry.path));
    this.staged.clear();
    await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  }
}
