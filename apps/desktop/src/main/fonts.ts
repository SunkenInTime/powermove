import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { IPC } from '../shared/ipc';

type Native = typeof import('@powermove/macos-haptics');
let addon: Promise<Native | null> | undefined;
/** Loaded lazily: the standalone `powermove serve` host does not ship the desktop addon. */
function native(): Promise<Native | null> {
  return addon ??= import('@powermove/macos-haptics').then(module =>
    (module as Native & { default?: Native }).default ?? module).catch(() => null);
}

export function registerFontsIpc(ipc: Pick<IpcMain, 'handle'>, ctx: {
  isTrustedSenderContents(sender: IpcMainInvokeEvent['sender']): boolean;
}) {
  let cached: { version: number; families: string[] } | null = null;
  ipc.handle(IPC.fontFamilies, async event => {
    if (!ctx.isTrustedSenderContents(event.sender)) return null;
    const addon = await native();
    if (!addon) return null;
    const { fontFamilies, fontRegistryVersion } = addon;
    const version = fontRegistryVersion();
    if (version !== null && cached?.version === version) return cached.families.slice();
    const families = fontFamilies();
    // Retain a successful snapshot only when the registry stayed unchanged
    // throughout enumeration. Failed/empty reads and older native addons keep
    // their existing fresh-read behavior and can recover on the next request.
    cached = version !== null && families?.length && fontRegistryVersion() === version
      ? { version, families: families.slice() } : null;
    return families;
  });
}
