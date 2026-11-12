import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { HostImports, resolveImportPath } from './host-import';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function layout() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pm-host-import-')); dirs.push(dir);
  const root = path.join(dir, 'media'), uploads = path.join(dir, 'Remote Uploads'), outside = path.join(dir, 'private');
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(root, 'clip.mp4'), 'synthetic video bytes');
  await writeFile(path.join(outside, 'secret.png'), 'not for clients');
  await writeFile(path.join(outside, 'serve-token'), 'token');
  return { dir, root, uploads, outside };
}

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

  it('refuses relative, missing and folder paths', async () => {
    const { root } = await layout();
    await mkdir(path.join(root, 'folder.mov'));
    await expect(resolveImportPath('clip.mp4', [root])).rejects.toThrow('absolute path');
    await expect(resolveImportPath(path.join(root, 'gone.mp4'), [root])).rejects.toThrow('There is no file');
    await expect(resolveImportPath(path.join(root, 'folder.mov'), [root])).rejects.toThrow('regular media file');
  });
});

describe('HostImports', () => {
  it('stages a byte-identical copy and leaves the original alone', async () => {
    const { root, uploads } = await layout();
    const imports = new HostImports(uploads, [root], 1024);
    const staged = await imports.stage(new EventEmitter(), path.join(root, 'clip.mp4'), undefined);
    expect(staged).toMatchObject({ name: 'clip.mp4', size: 21, type: 'video/mp4' });
    expect(path.dirname(path.dirname(staged.path))).toBe(uploads);
    expect(await readFile(staged.path, 'utf8')).toBe('synthetic video bytes');
    expect(await readFile(path.join(root, 'clip.mp4'), 'utf8')).toBe('synthetic video bytes');
    expect(imports.file(staged.id)).toBe(staged.path);
  });

  it('holds to the smaller of the client and host limits without leaving a copy', async () => {
    const { root, uploads } = await layout();
    const imports = new HostImports(uploads, [root], 1024);
    await expect(imports.stage(new EventEmitter(), path.join(root, 'clip.mp4'), 20)).rejects.toThrow('limited');
    await expect(new HostImports(uploads, [root], 20).stage(new EventEmitter(), path.join(root, 'clip.mp4'), 4096)).rejects.toThrow('limited');
    expect(await readdir(uploads).catch(() => [])).toEqual([]);
  });

  it('drops the copy on release by its owner, or when the owner goes away', async () => {
    const { root, uploads } = await layout();
    const imports = new HostImports(uploads, [root], 1024);
    const owner = new EventEmitter(), other = new EventEmitter();
    const first = await imports.stage(owner, path.join(root, 'clip.mp4'), undefined);
    await imports.release(other, first.id);
    expect(imports.file(first.id)).toBe(first.path);
    await imports.release(owner, first.id);
    expect(imports.file(first.id)).toBeNull();
    const second = await imports.stage(owner, path.join(root, 'clip.mp4'), undefined);
    owner.emit('destroyed');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(imports.file(second.id)).toBeNull();
    expect(await readdir(uploads)).toEqual([]);
  });
});
