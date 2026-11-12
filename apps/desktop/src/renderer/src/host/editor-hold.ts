/*
 * Holds the document while this tab waits for the host to answer a project
 * join. The answer replaces the document, so anything written before it
 * arrives would be lost; instead nothing is written until then.
 *
 * The document is a plain object written in place, so there is no single
 * write call to gate. The hold lives in history (PM.hist.hold): every edit
 * starts there, and the few writes that persist without an undo step ask it
 * first (PM.hist.assertEditable). A refused write throws "Connecting to the
 * host…" before anything changes, for a person, an extension or an agent tool
 * alike. Everything that does not write the document (navigation, panels,
 * search, selection, playback) works as usual.
 *
 * The user sees why: a quiet status where connection notices already appear,
 * shown once the wait outlasts a blink or as soon as a write is refused.
 */

export const HOLD_MESSAGE = 'Connecting to the host…';
const HOLD_TOAST = 'host-join';
/** Joins that finish sooner than this show nothing. */
const HOLD_STATUS_DELAY_MS = 400;

export interface HoldRegistry {
  hist?: { hold?(reason: string, onRefused?: () => void): () => void };
  toast?(text: string, ms?: number, options?: { key?: string; sticky?: boolean; dismissible?: boolean; error?: boolean }): void;
  dismissToast?(key: string): void;
}

export interface EditorHold {
  /** Lets writes through again and takes the status down. */
  release(): void;
  /** What the status says, now; null hides it while another notice explains the wait. */
  say(text: string | null): void;
}

export function holdEditor(PM: HoldRegistry): EditorHold {
  let text: string | null = HOLD_MESSAGE;
  let shown = false;
  const show = () => {
    if (shown || !text) return;
    shown = true;
    PM.toast?.(text, 0, { key: HOLD_TOAST, sticky: true, dismissible: false, error: false });
  };
  const hide = () => {
    if (shown) PM.dismissToast?.(HOLD_TOAST);
    shown = false;
  };
  const timer = setTimeout(show, HOLD_STATUS_DELAY_MS);
  const releaseHistory = PM.hist?.hold?.(HOLD_MESSAGE, show);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    releaseHistory?.();
    hide();
  };
  const say = (next: string | null) => {
    if (released) return;
    clearTimeout(timer);
    hide();
    text = next;
    show();
  };
  return { release, say };
}
