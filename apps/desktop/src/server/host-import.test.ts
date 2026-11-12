import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A hook on mkdir: staging creates its folder after the source is chosen and
// before any bytes are copied, which is where a swap or a disconnect lands.
const io = vi.hoisted(() => ({ beforeMkdir: null as null | (() => Promise<void> | void) }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
    const hook = io.beforeMkdir; io.beforeMkdir = null;
    await hook?.();
    return fs.mkdir(...args);
  } };
});

import { HostImports, resolveImportPath } from './host-import';

const dirs: string[] = [];
afterEach(async () => {
  io.beforeMkdir = null;
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function layout() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pm-host-import-')); dirs.push(dir);
  const root = path.join(dir, 'media'), uploads = path.join(dir, 'Remote Uploads'), outside = path.join(dir, 'private');
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(root, 'clip.mp4'), 'synthetic video bytes');
  await writeFile(path.join(outside, 'secret.png'), 'not for clients');
  await writeFile(path.join(outside, 'secret'), 'synthetic secret');
  await writeFile(path.join(outside, 'serve-token'), 'token');
  return { dir, root, uploads, outside };
}
const staging = async (uploads: string) => (await readdir(uploads, { recursive: true }).catch(() => [])).filter(name => !/^host-imports$/.test(String(name)));

describe('resolveImportPath', () => {
  it('accepts a media file inside a root', async () => {
    const { root } = await layout();
    await expect(resolveImportPath(path.join(root, 'clip.mp4'), [root])).resolves.toMatchObject({ path: path.join(root, 'clip.mp4'), size: 21 });
  });

  it('refuses files outside the roots, including through a link or ..', async () => {
    const { root, outside } = await layout();
    await symlink(path.join(outside, 'secret.png'), path.join(root, 'linked.png'));
    for (const requested of [path.join(outside, 'secret.png'), path.join(root, 'linked.png'), path.join(root, '..', 'private', 'secret.png')]) {
      await expect(resolveImportPath(requested, [root])).rejects.toThrow(`The host only imports files inside ${root}`);
    }
  });

  it('refuses a non-media file even when a link gives it a media name', async () => {
    const { root } = await layout();
    await writeFile(path.join(root, 'notes.txt'), 'text');
    await symlink(path.join(root, 'notes.txt'), path.join(root, 'notes.mp4'));
    await expect(resolveImportPath(path.join(root, 'notes.txt'), [root])).rejects.toThrow('not a media file');
    await expect(resolveImportPath(path.join(root, 'notes.mp4'), [root])).rejects.toThrow('not a media file');
  });

  it('refuses relative, missing, folder and pipe paths without waiting on a pipe', async () => {
    const { root } = await layout();
    await mkdir(path.join(root, 'folder.mov'));
    execFileSync('mkfifo', [path.join(root, 'pipe.mp4')]);
    await expect(resolveImportPath('clip.mp4', [root])).rejects.toThrow('absolute path');
    await expect(resolveImportPath(path.join(root, 'gone.mp4'), [root])).rejects.toThrow('There is no file');
    await expect(resolveImportPath(path.join(root, 'folder.mov'), [root])).rejects.toThrow('regular media file');
    await expect(resolveImportPath(path.join(root, 'pipe.mp4'), [root])).rejects.toThrow('regular media file');
  });
});

describe('HostImports', () => {
  it('stages a byte-identical copy and leaves the original alone', async () => {
    const { root, uploads } = await layout();
    const imports = new HostImports(uploads, [root]);
    const staged = await imports.stage(new EventEmitter(), path.join(root, 'clip.mp4'), undefined);
    expect(staged).toMatchObject({ name: 'clip.mp4', size: 21, type: 'video/mp4' });
    expect(path.relative(uploads, staged.path).split(path.sep)).toHaveLength(3);
    expect(await readFile(staged.path, 'utf8')).toBe('synthetic video bytes');
    expect(await readFile(path.join(root, 'clip.mp4'), 'utf8')).toBe('synthetic video bytes');
  });

  it('copies the file it checked, even if the path is swapped before the copy', async () => {
    const { root, uploads, outside } = await layout();
    await writeFile(path.join(root, 'race.png'), 'png bytes');
    await mkdir(path.join(root, 'shots'));
    await writeFile(path.join(root, 'shots', 'race.png'), 'png bytes');
    const imports = new HostImports(uploads, [root]);
    // The file becomes a link to an outside, extensionless file.
    io.beforeMkdir = async () => { await rm(path.join(root, 'race.png')); await symlink(path.join(outside, 'secret'), path.join(root, 'race.png')); };
    const swappedFile = await imports.stage(new EventEmitter(), path.join(root, 'race.png'), undefined);
    expect(await readFile(swappedFile.path, 'utf8')).toBe('png bytes');
    // A parent folder becomes a link to an outside folder holding the same name.
    await writeFile(path.join(outside, 'race.png'), 'synthetic secret');
    io.beforeMkdir = async () => { await rename(path.join(root, 'shots'), path.join(root, 'shots-old')); await symlink(outside, path.join(root, 'shots')); };
    const swappedParent = await imports.stage(new EventEmitter(), path.join(root, 'shots', 'race.png'), undefined);
    expect(await readFile(swappedParent.path, 'utf8')).toBe('png bytes');
  });

  it('holds to the smaller of the client and host limits without leaving a copy', async () => {
    const { root, uploads } = await layout();
    await expect(new HostImports(uploads, [root], { maxBytes: 1024 }).stage(new EventEmitter(), path.join(root, 'clip.mp4'), 20)).rejects.toThrow('limited');
    await expect(new HostImports(uploads, [root], { maxBytes: 20 }).stage(new EventEmitter(), path.join(root, 'clip.mp4'), 4096)).rejects.toThrow('limited');
    expect(await staging(uploads)).toEqual([]);
  });

  it('drops a copy whose tab disconnected while it was being made', async () => {
    const { root, uploads } = await layout();
    const imports = new HostImports(uploads, [root]);
    const owner = new EventEmitter();
    io.beforeMkdir = () => { owner.emit('destroyed'); };
    await expect(imports.stage(owner, path.join(root, 'clip.mp4'), undefined)).rejects.toThrow('disconnected');
    expect(await staging(uploads)).toEqual([]);
    expect(owner.listenerCount('destroyed')).toBe(0);
  });

  it('drops the copy on release by its owner, or when the owner goes away, without keeping listeners', async () => {
    const { root, uploads } = await layout();
    const imports = new HostImports(uploads, [root]);
    const owner = new EventEmitter(), other = new EventEmitter();
    for (let round = 0; round < 12; round++) {
      const staged = await imports.stage(owner, path.join(root, 'clip.mp4'), undefined);
      await imports.release(other, staged.id);
      await expect(readFile(staged.path, 'utf8')).resolves.toBe('synthetic video bytes');
      await imports.release(owner, staged.id);
    }
    expect(owner.listenerCount('destroyed')).toBe(0);
    expect(await staging(uploads)).toEqual([]);
    const second = await imports.stage(owner, path.join(root, 'clip.mp4'), undefined);
    owner.emit('destroyed');
    await vi.waitFor(async () => expect(await staging(uploads)).toEqual([]));
    expect(imports.file(second.id)).toBeNull();
  });

  it('serves a staged id once, and forgets it after its lifetime', async () => {
    const { root, uploads } = await layout();
    const owner = new EventEmitter();
    const imports = new HostImports(uploads, [root], { ttlMs: 60_000 });
    const staged = await imports.stage(owner, path.join(root, 'clip.mp4'), undefined);
    expect(imports.file(staged.id)).toBe(staged.path);
    expect(imports.file(staged.id)).toBeNull();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const unread = await imports.stage(owner, path.join(root, 'clip.mp4'), undefined);
    vi.advanceTimersByTime(60_001);
    vi.useRealTimers();
    expect(imports.file(unread.id)).toBeNull();
    await vi.waitFor(async () => expect((await staging(uploads)).sort()).toEqual([path.relative(uploads, path.dirname(staged.path)), path.relative(uploads, staged.path)].sort()));
    expect(owner.listenerCount('destroyed')).toBe(1);
  });

  it('removes copies an earlier run left behind', async () => {
    const { root, uploads } = await layout();
    await mkdir(path.join(uploads, 'host-imports', 'left-over'), { recursive: true });
    await writeFile(path.join(uploads, 'host-imports', 'left-over', 'clip.mp4'), 'stale');
    await writeFile(path.join(uploads, 'someone-elses-upload'), 'keep');
    await new HostImports(uploads, [root]).reclaim();
    expect(await readdir(uploads, { recursive: true })).toEqual(['someone-elses-upload']);
  });
});
