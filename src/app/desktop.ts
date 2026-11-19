/**
 * The desktop app (a separate repository: Jarvis's own address in an
 * Electron window) puts this bridge on the page, on Jarvis's origin only.
 * Everywhere else there is none and nothing here changes anything. Why, and
 * the contract: docs/DESIGN.md, "The desktop app".
 */

export interface DesktopBridge {
  version: 1;
  /** The computer was used in the last 120 s and is not locked. */
  inUse(): Promise<boolean>;
  /** inUse() has changed. */
  onPresence(cb: () => void): void;
  /** Shown as a native notification. */
  notify(a: { id: string; title: string; text: string }): void;
  /** The talk shortcut was pressed, wherever the person was. */
  onTalk(cb: () => void): void;
  /** False where the platform's passkey cannot work (Electron on a Mac). */
  passkeys: boolean;
}

declare global {
  interface Window {
    jarvisDesktop?: { version?: unknown };
  }
}

const found = typeof window === "undefined" ? undefined : window.jarvisDesktop;

/** The bridge, when this page is in the desktop app and speaks version 1. */
export const desktop: DesktopBridge | null = found?.version === 1 ? (found as DesktopBridge) : null;

/**
 * Whether someone can see this screen: the page is in front, or the desktop
 * app says the computer is in use. Idle or locked is not seen, so an alert
 * still goes on to the phone ("Open is not seen", docs/DESIGN.md).
 */
export function seenHere(docVisible: boolean, inUse: boolean | undefined): boolean {
  return docVisible || inUse === true;
}
