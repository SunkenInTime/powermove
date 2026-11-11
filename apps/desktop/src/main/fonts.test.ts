import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@powermove/macos-haptics', () => {
  const native = { fontFamilies: vi.fn(() => ['New font']), fontRegistryVersion: vi.fn(() => null) };
  return { ...native, default: native };
});
import { fontFamilies, fontRegistryVersion } from '@powermove/macos-haptics';
import { registerFontsIpc } from './fonts';
import { IPC } from '../shared/ipc';

beforeEach(() => {
  vi.mocked(fontFamilies).mockReset().mockReturnValue(['New font']);
  vi.mocked(fontRegistryVersion).mockReset().mockReturnValue(null);
});

function reader() {
  const handle = vi.fn(), sender = {} as any;
  registerFontsIpc({ handle }, { isTrustedSenderContents: value => value === sender });
  const read = handle.mock.calls[0]![1];
  return () => read({ sender }) as Promise<string[]>;
}

it('reads a fresh native font list only for trusted editor requests', async () => {
  const handle = vi.fn();
  const sender = {} as any;
  registerFontsIpc({ handle }, { isTrustedSenderContents: value => value === sender });
  expect(handle.mock.calls[0]![0]).toBe(IPC.fontFamilies);
  const read = handle.mock.calls[0]![1];
  expect(await read({ sender: {} })).toBeNull();
  expect(fontFamilies).not.toHaveBeenCalled();
  expect(fontRegistryVersion).not.toHaveBeenCalled();
  expect(await read({ sender })).toEqual(['New font']);
  expect(await read({ sender })).toEqual(['New font']);
  expect(fontFamilies).toHaveBeenCalledTimes(2);
});

it('reuses a stable native snapshot without exposing its mutable array', async () => {
  vi.mocked(fontRegistryVersion).mockReturnValue(0);
  const read = reader();
  const first = await read(); first.push('Caller mutation');
  const next = await read(); next.push('Another mutation');
  expect(await read()).toEqual(['New font']);
  expect(fontFamilies).toHaveBeenCalledTimes(1);
});

it('refreshes on a native font registry change across editor requests', async () => {
  vi.mocked(fontRegistryVersion).mockReturnValue(3);
  const read = reader();
  expect(await read()).toEqual(['New font']);
  vi.mocked(fontFamilies).mockReturnValue(['Installed font']);
  vi.mocked(fontRegistryVersion).mockReturnValue(4);
  expect(await read()).toEqual(['Installed font']);
  expect(await read()).toEqual(['Installed font']);
  expect(fontFamilies).toHaveBeenCalledTimes(2);
});

it('retries when the registry changes during enumeration', async () => {
  vi.mocked(fontRegistryVersion).mockReturnValueOnce(1).mockReturnValue(2);
  const read = reader(); await read(); await read(); await read();
  expect(fontFamilies).toHaveBeenCalledTimes(2);
});

it('retries unavailable and empty snapshots even when the revision stays stable', async () => {
  vi.mocked(fontRegistryVersion).mockReturnValue(0);
  vi.mocked(fontFamilies).mockReturnValueOnce(null).mockReturnValueOnce([]).mockReturnValue(['Recovered']);
  const read = reader();
  expect(await read()).toBeNull(); expect(await read()).toEqual([]);
  expect(await read()).toEqual(['Recovered']); expect(await read()).toEqual(['Recovered']);
  expect(fontFamilies).toHaveBeenCalledTimes(3);
});

it('recovers after an enumeration error without caching the failed revision', async () => {
  vi.mocked(fontRegistryVersion).mockReturnValue(0);
  const read = reader(); await read();
  vi.mocked(fontRegistryVersion).mockReturnValue(1);
  vi.mocked(fontFamilies).mockImplementationOnce(() => { throw new Error('Temporary native failure'); });
  await expect(read()).rejects.toThrow('Temporary native failure');
  expect(await read()).toEqual(['New font']); expect(await read()).toEqual(['New font']);
  expect(fontFamilies).toHaveBeenCalledTimes(3);
});
