import type { MenuItemConstructorOptions } from 'electron';

/** macOS keeps the application menu alive after its last window closes. */
export function applicationMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null;
  return [
    { role: 'appMenu' },
    { label: '文件', submenu: [{ role: 'close' }] },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
}

export interface DesktopWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  setEnabled(enabled: boolean): void;
  close(): void;
}

interface PreventableEvent { preventDefault(): void }
type CloseDecision = 'retry' | 'cancel' | 'discard';
interface CloseState { allowed: boolean; preparing: boolean }

interface LifecycleOptions<Window extends DesktopWindow> {
  platform: NodeJS.Platform;
  getWindow(): Window | null;
  createWindow(): Promise<void>;
  prepareClose(window: Window): Promise<void>;
  promptCloseFailure(window: Window, error: Error): Promise<CloseDecision>;
  quit(): void;
  dispose(): void;
}

/**
 * Coordinates native app events with the renderer's asynchronous save handshake.
 * It uses one close state per window, so reopening a macOS window never inherits
 * permission to bypass the previous window's completed handshake.
 */
export class DesktopLifecycle<Window extends DesktopWindow> {
  private readonly windows = new WeakMap<Window, CloseState>();
  private quitRequested = false;
  private disposed = false;
  private opening: Promise<void> | undefined;

  constructor(private readonly options: LifecycleOptions<Window>) {}

  attachWindow(window: Window): void {
    this.windows.set(window, { allowed: false, preparing: false });
  }

  handleClose(window: Window, event: PreventableEvent): void {
    const state = this.stateFor(window);
    if (state.allowed) return;
    event.preventDefault();
    if (state.preparing) return;
    state.preparing = true;
    window.setEnabled(false);
    void this.saveAndClose(window, state);
  }

  /** Cancel native termination until the window has acknowledged its last save. */
  beforeQuit(event: PreventableEvent): void {
    this.quitRequested = true;
    const window = this.options.getWindow();
    if (!window || window.isDestroyed() || this.stateFor(window).allowed) return;
    event.preventDefault();
    window.close();
  }

  windowClosed(window: Window): void {
    this.windows.delete(window);
    // app.quit() was prevented while saving. Resume it after the close, including
    // on macOS, where an ordinary window-all-closed intentionally does not quit.
    if (this.quitRequested) this.options.quit();
  }

  allWindowsClosed(): void {
    if (this.options.platform !== 'darwin' && !this.quitRequested) this.options.quit();
  }

  async activate(): Promise<void> {
    if (this.quitRequested || this.disposed) return;
    const window = this.options.getWindow();
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return;
    }
    if (!this.opening) {
      this.opening = Promise.resolve().then(() => {
        if (this.quitRequested || this.disposed) return;
        return this.options.createWindow();
      }).finally(() => { this.opening = undefined; });
    }
    await this.opening;
  }

  willQuit(event: PreventableEvent): void {
    const window = this.options.getWindow();
    if (window && !window.isDestroyed() && !this.stateFor(window).allowed) {
      this.beforeQuit(event);
      return;
    }
    if (this.disposed) return;
    this.disposed = true;
    this.options.dispose();
  }

  /** Initialization failed before a usable reading window was available. */
  abortStartup(): void {
    this.quitRequested = true;
    const window = this.options.getWindow();
    if (window) this.stateFor(window).allowed = true;
    this.options.quit();
  }

  private stateFor(window: Window): CloseState {
    let state = this.windows.get(window);
    if (!state) {
      state = { allowed: false, preparing: false };
      this.windows.set(window, state);
    }
    return state;
  }

  private async saveAndClose(window: Window, state: CloseState): Promise<void> {
    try {
      await this.options.prepareClose(window);
      if (window.isDestroyed()) return;
      state.allowed = true;
      state.preparing = false;
      window.setEnabled(true);
      window.close();
    } catch (cause) {
      if (window.isDestroyed()) return;
      window.setEnabled(true);
      let decision: CloseDecision;
      try {
        decision = await this.options.promptCloseFailure(window, cause instanceof Error ? cause : new Error(String(cause)));
      } catch {
        // A failed/closed native dialog must not approve losing unsaved state.
        decision = 'cancel';
      }
      if (window.isDestroyed()) return;
      state.preparing = false;
      if (decision === 'retry') window.close();
      else if (decision === 'discard') { state.allowed = true; window.close(); }
      else this.quitRequested = false;
    }
  }
}
