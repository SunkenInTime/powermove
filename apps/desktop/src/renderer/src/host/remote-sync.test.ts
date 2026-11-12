// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WEB } from '../../../shared/wire';
import { createServicesRegistry } from '../kernel/services';
import { install as installHistory } from '../legacy/core/history';
import { HOLD_MESSAGE } from './editor-hold';
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

/**
 * A tab with the real history, opening a project whose join waits until the
 * test answers it (or drops the connection).
 */
function openingTab(ours: any) {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const on = (channel: string, listener: (...args: any[]) => void) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(listener);
    return () => listeners.get(channel)!.delete(listener);
  };
  const fire = (channel: string, ...args: unknown[]) => { for (const listener of [...(listeners.get(channel) ?? [])]) listener(...args); };
  const joins: Array<{ resolve(result: unknown): void; reject(error: unknown): void }> = [];
  const sent: unknown[] = [];
  const link: SyncLink = {
    invoke: vi.fn((channel: string, payload: any) => {
      if (channel === WEB.syncJoin) return new Promise((resolve, reject) => { joins.push({ resolve, reject }); });
      sent.push(payload.patches);
      return Promise.resolve(2);
    }) as SyncLink['invoke'],
    send: vi.fn(),
    on: (channel, listener) => on(`link:${channel}`, listener),
  };
  let nextId = 0;
  const PM: any = {
    Kernel: { services: createServicesRegistry() },
    proj: ours,
    sel: {},
    uid: (prefix: string) => `${prefix}-${++nextId}`,
    bus: { on, emit: (event: string, ...args: unknown[]) => fire(event, ...args) },
    replaceProject: vi.fn((next: unknown) => { PM.proj = next; return next; }),
    touch: vi.fn(),
    invalidate: vi.fn(),
    autosave: vi.fn(),
    toast: vi.fn(),
    dismissToast: vi.fn(),
    store: { get: (_key: string, fallback: unknown) => fallback, set: vi.fn() },
  };
  installHistory(PM);
  attachRemoteSync(link, PM);
  const settle = async () => { await vi.advanceTimersByTimeAsync(1000); };
  const answer = async (doc: unknown) => { joins.at(-1)!.resolve({ seq: 1, doc }); await settle(); };
  const drop = async () => { joins.at(-1)!.reject(new Error('The connection to the Powermove host closed.')); await settle(); };
  const reconnect = () => fire('link:__reconnected');
  const rename = (name: string) => PM.hist.do('Rename', () => { PM.proj.name = name; });
  return { PM, sent, joins, answer, drop, reconnect, rename, settle };
}

describe('remote sync holds the editor until the host answers the join', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refuses an edit made before the answer: the document is unchanged and nothing is sent', async () => {
    const { PM, sent, rename, answer } = openingTab({ id: 'project', name: 'Film', layers: [] });
    expect(() => rename('Renamed')).toThrow(HOLD_MESSAGE);
    expect(PM.proj.name).toBe('Film');
    expect(PM.hist.canUndo()).toBe(false);
    // Refusing it says why, at once.
    expect(PM.toast).toHaveBeenCalledWith(HOLD_MESSAGE, 0, expect.objectContaining({ sticky: true, error: false }));
    await answer(null);
    expect(PM.proj.name).toBe('Film');
    expect(sent).toEqual([]);
  });

  it('takes the same edit once the answer is applied, and sends and saves it', async () => {
    const { PM, sent, rename, answer, settle } = openingTab({ id: 'project', name: 'Film', layers: [] });
    await answer(null);
    rename('Renamed');
    await settle();
    expect(PM.proj.name).toBe('Renamed');
    expect(sent).toEqual([[{ path: ['name'], exists: true, value: 'Renamed' }]]);
    expect(PM.autosave).toHaveBeenCalled();
    expect(PM.dismissToast).not.toHaveBeenCalled();
  });

  it('gives a tab behind the host the host copy, then lets it edit', async () => {
    const { PM, sent, rename, answer, settle } = openingTab({ id: 'project', name: 'Old', layers: [{ id: 'a', x: 0 }] });
    const host = { id: 'project', name: 'New', layers: [{ id: 'a', x: 10 }, { id: 'b', x: 0 }] };
    await answer(structuredClone(host));
    expect(PM.proj).toEqual(host);
    expect(sent).toEqual([]);
    rename('Mine');
    await settle();
    expect(sent).toEqual([[{ path: ['name'], exists: true, value: 'Mine' }]]);
  });

  it('stays held through a dropped connection, joins again on reconnect and opens on that answer', async () => {
    const { PM, sent, joins, rename, answer, drop, reconnect, settle } = openingTab({ id: 'project', name: 'Film', layers: [] });
    await vi.advanceTimersByTimeAsync(500);
    expect(PM.toast).toHaveBeenCalledWith(HOLD_MESSAGE, 0, expect.anything());
    await drop();
    // The link's own notice says the connection was lost; this one steps aside
    // instead of claiming it is still connecting, and no reload is demanded.
    expect(PM.dismissToast).toHaveBeenCalled();
    expect(PM.toast).not.toHaveBeenCalledWith(expect.stringContaining('Reload'), expect.anything(), expect.anything());
    expect(() => rename('While down')).toThrow(HOLD_MESSAGE);
    expect(PM.proj.name).toBe('Film');
    reconnect();
    expect(joins).toHaveLength(2);
    expect(PM.toast).toHaveBeenLastCalledWith(HOLD_MESSAGE, 0, expect.anything());
    await answer(null);
    rename('After reconnect');
    await settle();
    expect(sent).toEqual([[{ path: ['name'], exists: true, value: 'After reconnect' }]]);
  });

  it('holds input too, for edits that do not go through history', async () => {
    const { answer } = openingTab({ id: 'project', name: 'Film', layers: [] });
    const reached: string[] = [];
    const note = (event: Event) => reached.push(event.type);
    for (const type of ['pointerdown', 'keydown', 'paste', 'wheel']) window.addEventListener(type, note);
    try {
      for (const type of ['pointerdown', 'keydown', 'paste', 'wheel']) document.body.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
      expect(reached).toEqual(['wheel']);
      await answer(null);
      document.body.dispatchEvent(new Event('keydown', { bubbles: true, cancelable: true }));
      expect(reached).toEqual(['wheel', 'keydown']);
    } finally {
      for (const type of ['pointerdown', 'keydown', 'paste', 'wheel']) window.removeEventListener(type, note);
    }
  });
});
