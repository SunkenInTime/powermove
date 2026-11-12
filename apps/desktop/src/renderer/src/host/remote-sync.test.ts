import { describe, expect, it, vi } from 'vitest';

import { WEB } from '../../../shared/wire';
import { attachRemoteSync, type SyncLink } from './remote-sync';

/** A tab with every asset already loaded, joined to a host. */
function syncedTab(hostDoc: unknown) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const on = (channel: string, listener: (...args: any[]) => void) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(listener);
    return () => listeners.get(channel)!.delete(listener);
  };
  const link: SyncLink = {
    invoke: vi.fn(async (channel: string) => (channel === WEB.syncJoin ? { seq: 1, doc: hostDoc } : 1)) as SyncLink['invoke'],
    send: vi.fn(),
    on: (channel, listener) => on(channel, listener),
  };
  const PM = {
    proj: { id: 'project', name: 'Ours', assets: { clip: { id: 'clip' } } } as any,
    assets: { get: (id: string) => ({ id }) },
    restoreProjectAssets: vi.fn(async () => undefined),
    sel: {},
    bus: { on, emit: vi.fn() },
    replaceProject: vi.fn((next: unknown) => { PM.proj = next; return next; }),
  };
  const remote = (payload: unknown) => { for (const listener of listeners.get(WEB.syncPatch) ?? []) listener(payload); };
  return { PM, link, remote };
}

describe('remote sync asset restore', () => {
  it('restores for a whole new document even when every asset is already loaded', async () => {
    const hostDoc = { id: 'project', name: 'Theirs', assets: { clip: { id: 'clip' } } };
    const { PM, link } = syncedTab(hostDoc);
    attachRemoteSync(link, PM);
    await vi.waitFor(() => expect(PM.replaceProject).toHaveBeenCalled());
    expect(PM.proj).toEqual(hostDoc);
    // The pass adopts the loaded media for the new document, so a restore
    // still running for the old one cannot take it back.
    expect(PM.restoreProjectAssets).toHaveBeenCalledWith(PM.proj, false);
  });

  it('does not restore for an in-place edit when every asset is loaded', async () => {
    const { PM, link, remote } = syncedTab(null);
    attachRemoteSync(link, PM);
    await vi.waitFor(() => expect(link.invoke).toHaveBeenCalledWith(WEB.syncJoin, expect.anything()));
    await Promise.resolve();
    const before = PM.proj;
    remote({ projectId: 'project', seq: 2, from: 9, patches: [{ path: ['name'], exists: true, value: 'Renamed' }] });
    expect(PM.proj).toBe(before);
    expect(PM.proj.name).toBe('Renamed');
    expect(PM.restoreProjectAssets).not.toHaveBeenCalled();
  });
});
