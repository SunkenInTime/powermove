/*
 * Holds the editor while this tab waits for the host to answer a project join.
 * The answer replaces the document, so anything changed before it arrives
 * would be lost; instead nothing can change it until then.
 *
 * Two gates, one per layer. History refuses every edit that would start
 * (interface, shortcuts, extensions, agent tools, undo and redo all begin
 * one there). A few interface actions write the document without history
 * (renaming the project, notes, some settings), so the editor's input is held
 * too: one capture listener on the window stops pointer, keyboard, paste and
 * drop before any handler sees them. Scrolling and hovering still work.
 *
 * The user sees why: a quiet status where connection notices already appear,
 * shown once the wait outlasts a blink or as soon as input is refused.
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

const REFUSED = ['pointerdown', 'mousedown', 'touchstart', 'click', 'dblclick', 'auxclick', 'contextmenu', 'keydown', 'beforeinput', 'paste', 'cut', 'drop', 'dragstart'] as const;
/** Part of an interaction that was already refused; stopped without a second notice. */
const QUIET = ['keypress', 'dragenter', 'dragover'] as const;

const editable = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return !!element && typeof element.matches === 'function' && (element.isContentEditable || element.matches('input, textarea, select'));
};

export interface EditorHold {
  /** Lets edits through again and takes the status down. */
  release(): void;
  /** What the status says, now; null hides it while another notice explains the wait. */
  say(text: string | null): void;
}

export function holdEditor(PM: HoldRegistry, view: Window = window): EditorHold {
  // A field being typed in commits on blur; let that land before the hold.
  const active = view.document.activeElement as HTMLElement | null;
  if (active && active !== view.document.body && typeof active.blur === 'function') active.blur();

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
  const timer = view.setTimeout(show, HOLD_STATUS_DELAY_MS);

  const stop = (event: Event, refused: boolean) => {
    // Reloading and other browser keys stay the user's; only editor handlers and typing are stopped.
    if (event.type !== 'keydown' || editable(event.target)) event.preventDefault();
    const transfer = (event as DragEvent).dataTransfer;
    if (transfer) transfer.dropEffect = 'none';
    event.stopImmediatePropagation();
    if (refused) show();
  };
  const refuse = (event: Event) => stop(event, true);
  const quiet = (event: Event) => stop(event, false);
  // A drag that began before the hold must not keep editing.
  const move = (event: Event) => { if ((event as MouseEvent).buttons) stop(event, false); };

  // Not passive: touchstart on the window is passive by default and could not be refused.
  const listen = { capture: true, passive: false };
  for (const type of REFUSED) view.addEventListener(type, refuse, listen);
  for (const type of QUIET) view.addEventListener(type, quiet, listen);
  view.addEventListener('pointermove', move, listen);
  view.addEventListener('mousemove', move, listen);
  view.document.documentElement.classList.add('host-joining');
  const releaseHistory = PM.hist?.hold?.(HOLD_MESSAGE, show);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    view.clearTimeout(timer);
    for (const type of REFUSED) view.removeEventListener(type, refuse, true);
    for (const type of QUIET) view.removeEventListener(type, quiet, true);
    view.removeEventListener('pointermove', move, true);
    view.removeEventListener('mousemove', move, true);
    view.document.documentElement.classList.remove('host-joining');
    releaseHistory?.();
    hide();
  };
  const say = (next: string | null) => {
    if (released) return;
    view.clearTimeout(timer);
    hide();
    text = next;
    show();
  };
  return { release, say };
}
