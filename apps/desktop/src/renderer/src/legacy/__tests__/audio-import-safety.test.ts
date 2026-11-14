import { afterEach, describe, expect, it, vi } from 'vitest';

import { makePM } from './make-pm';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe('audio import project safety oracle', () => {
  it('refuses an import while the document is held, storing nothing and adding nothing', async () => {
    vi.stubGlobal('window', {
      document: { createElement: () => ({ getContext: () => ({}) }) },
      navigator: { hardwareConcurrency: 4 },
      URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
      setTimeout, clearTimeout,
    });
    const project = { id: 'A', assets: {}, layers: [] };
    const PM = makePM('core/history', 'gl/raster');
    PM.proj = project;
    PM.uid = () => 'asset-new';
    PM.Audio = { accepts: () => true, prepareAsset: async () => ({ id: 'asset-new', name: 'held.mp3', kind: 'audio' }), disposeAsset() {}, rebalanceCache() {} };
    const put = vi.fn(async () => true);
    PM.MediaStore = { put };
    PM.MediaImport = {
      fingerprint: async () => 'fingerprint',
      storageKeyFor: (value: string) => `media:${value}`,
      match: () => ({ canonicalId: null, aliases: [] }),
      coalesce: () => 0,
      mapBounded: async (items: unknown[], _limit: number, worker: (item: unknown) => unknown) => Promise.all(items.map(worker)),
    };
    PM.touch = () => {};
    // The extension API's assets.add is PM.assets.add; agent media imports use it too.
    const release = PM.hist.hold('Connecting to the host…');
    await expect(PM.assets.add({ name: 'held.mp3', type: 'audio/mpeg', size: 10 })).rejects.toThrow('Connecting to the host…');
    expect(put).not.toHaveBeenCalled();
    expect(project.assets).toEqual({});
    expect(PM.assets.map.size).toBe(0);
    release();
    await PM.assets.add({ name: 'held.mp3', type: 'audio/mpeg', size: 10 });
    expect(Object.keys(project.assets)).toEqual(['asset-new']);
  });

  it('discards a slow decode if its originating project is no longer active', async () => {
    vi.stubGlobal('window', {
      document: { createElement: () => ({ getContext: () => ({}) }) },
      navigator: { hardwareConcurrency: 4 },
      URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
      setTimeout, clearTimeout,
    });
    const preparation = deferred<any>();
    const decodingStarted = deferred<void>();
    const disposed: any[] = [];
    const projectA = { id: 'A', assets: {}, layers: [] };
    const projectB = { id: 'B', assets: {}, layers: [] };
    const PM = makePM('gl/raster');
    PM.proj = projectA;
    PM.uid = () => 'asset-new';
    PM.Audio = {
      accepts: () => true,
      prepareAsset: () => { decodingStarted.resolve(); return preparation.promise; },
      disposeAsset: (asset: any) => disposed.push(asset),
      rebalanceCache() {},
    };
    PM.MediaStore = { put: async () => true };
    PM.MediaImport = {
      fingerprint: async () => 'fingerprint',
      storageKeyFor: (value: string) => `media:${value}`,
      match: () => ({ canonicalId: null, aliases: [] }),
      coalesce: () => 0,
      mapBounded: async (items: unknown[], _limit: number, worker: (item: unknown) => unknown) => Promise.all(items.map(worker)),
    };
    PM.touch = () => {};

    const importing = PM.assets.add({ name: 'slow.mp3', type: 'audio/mpeg', size: 10 });
    // Media preparation now yields before decoding (bf26d9b3e); switch only once
    // the slow decode is actually in flight, so disposal remains exercised.
    await decodingStarted.promise;
    PM.proj = projectB;
    PM.assets.clear();
    const prepared = { id: 'asset-new', name: 'slow.mp3', kind: 'audio' };
    preparation.resolve(prepared);

    await expect(importing).rejects.toThrow(/switched projects/);
    expect(projectA.assets).toEqual({});
    expect(projectB.assets).toEqual({});
    expect(PM.assets.map.size).toBe(0);
    expect(disposed).toEqual([prepared]);
  });
});
