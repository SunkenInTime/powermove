/*
 * Import by host path against a real host: stage, read the copy over HTTP,
 * file it under its key, and serve it as ordinary host media.
 */
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('electron', () => import('./electron-stub'));

import { Connection, type LinkSocket } from '../shared/link';
import { WEB } from '../shared/wire';
import { mediaFingerprint } from '../main/media-path-cache';
import type { StagedImport } from './host-import';
import { serve, type RunningServer } from './index';

let dir: string, media: string, server: RunningServer, link: Connection;
const sockets: WebSocket[] = [];

function open(): Promise<LinkSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${new URL(server.url).host}/__powermove/ws`, { headers: { cookie: `pm_session=${server.token}` } });
    sockets.push(socket);
    socket.once('open', () => resolve(socket as unknown as LinkSocket));
    socket.once('error', reject);
  });
}
/** One connection per request (no keep-alive pool), so each answer stands alone. */
function get(pathname: string, signedIn = true): Promise<{ status: number; type: string | undefined; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const call = request(new URL(pathname, server.url), { agent: false, headers: signedIn ? { cookie: `pm_session=${server.token}` } : {} }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, type: response.headers['content-type'], body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    call.on('error', reject);
    call.end();
  });
}

beforeAll(async () => {
  process.env['POWERMOVE_FONTCONFIG'] = '0';
  dir = await mkdtemp(path.join(tmpdir(), 'pm-host-import-it-'));
  media = path.join(dir, 'media');
  await mkdir(media);
  server = await serve({
    host: '127.0.0.1', port: 0, userData: path.join(dir, 'profile'), exportsDir: path.join(dir, 'exports'),
    rendererDir: path.join(dir, 'renderer'), resourcesDir: path.join(dir, 'resources'), appPath: dir,
    version: '0.0.0-test', codexBinary: null, claudeBinary: null, engineScript: null, installKind: 'source', insecure: true,
    importRoots: [media], log: () => undefined
  });
  link = new Connection(await open());
}, 30_000);

afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

describe('import by host path', () => {
  it('files the staged copy under the key of its bytes, with no upload', async () => {
    // Bigger than one fingerprint sample at each of the three offsets.
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + (index >> 12)) & 0xff;
    const source = path.join(media, 'footage.mov');
    await writeFile(source, bytes);

    const staged = await link.invoke<StagedImport>(WEB.mediaImportPath, { path: source, maxBytes: 512 * 1024 * 1024 });
    expect(staged).toMatchObject({ name: 'footage.mov', size: bytes.length, type: 'video/quicktime' });
    expect((await get(`/__powermove/media-import?id=${staged.id}`, false)).status).toBe(401);
    expect((await get(`/__powermove/media-import?id=${staged.id}`)).body.equals(bytes)).toBe(true);

    // The editor computes the key from what it read; the host's reading of the same algorithm agrees.
    const key = `media:${await mediaFingerprint(source)}`;
    await link.invoke(WEB.mediaCommit, { key, path: staged.path, type: staged.type });
    expect(await link.invoke<string[]>(WEB.mediaHas, [key])).toEqual([key]);
    const stored = path.join(dir, 'profile', 'Media Store', key.replace(/[^A-Za-z0-9._-]/g, '_'));
    expect(`media:${await mediaFingerprint(stored)}`).toBe(key);
    expect(createHash('sha256').update(await readFile(stored)).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    await expect(stat(path.dirname(staged.path))).rejects.toThrow();
    expect((await readFile(source)).equals(bytes)).toBe(true);

    const served = await get(`/__powermove/media?key=${encodeURIComponent(key)}`);
    expect(served.type).toBe('video/quicktime');
    expect(served.body.equals(bytes)).toBe(true);
    await link.invoke(WEB.mediaImportRelease, staged.id);
  });

  it('refuses a path outside the import roots', async () => {
    await expect(link.invoke(WEB.mediaImportPath, { path: path.join(dir, 'profile', 'serve-token') })).rejects.toThrow(`only imports files inside ${media}`);
  });

  it('drops an uncommitted copy on release', async () => {
    await writeFile(path.join(media, 'still.png'), 'png bytes');
    const staged = await link.invoke<StagedImport>(WEB.mediaImportPath, { path: path.join(media, 'still.png') });
    await link.invoke(WEB.mediaImportRelease, staged.id);
    expect((await get(`/__powermove/media-import?id=${staged.id}`)).status).toBe(404);
    await expect(stat(staged.path)).rejects.toThrow();
  });
});
