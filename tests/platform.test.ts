import { describe, expect, it, vi } from 'vitest';
import { applicationMenuTemplate, DesktopLifecycle, type DesktopWindow } from '../src/main/platform';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = () => yes(); reject = no; });
  return { promise, resolve, reject };
}

function preventableEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

/** Simulates Electron's before-quit -> window close -> will-quit sequence. */
function desktop(platform: NodeJS.Platform, { initialWindow = true, createGate }: { initialWindow?: boolean; createGate?: Promise<void> } = {}) {
  const events: string[] = [];
  const saves: ReturnType<typeof deferred>[] = [];
  const decisions: ('retry' | 'cancel' | 'discard' | 'dialog-error')[] = [];
  let current: FakeWindow | null = null;
  let nextId = 0, quitAttempts = 0, disposed = 0, created = 0, prompts = 0;
  let lifecycle!: DesktopLifecycle<FakeWindow>;

  class FakeWindow implements DesktopWindow {
    readonly id = ++nextId;
    destroyed = false;
    minimized = false;
    enabled = true;
    shown = 0;
    focused = 0;
    restored = 0;
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; this.restored++; }
    show() { this.shown++; }
    focus() { this.focused++; }
    setEnabled(value: boolean) { this.enabled = value; }
    close() {
      if (this.destroyed) return;
      const event = preventableEvent();
      lifecycle.handleClose(this, event);
      if (event.prevented) return;
      events.push(`closed:${this.id}`);
      this.destroyed = true;
      if (current === this) current = null;
      lifecycle.windowClosed(this);
      lifecycle.allWindowsClosed();
    }
  }

  function addWindow() {
    current = new FakeWindow();
    lifecycle.attachWindow(current);
    created++;
    return current;
  }

  function quit() {
    quitAttempts++;
    events.push('quit-request');
    const event = preventableEvent();
    lifecycle.beforeQuit(event);
    if (event.prevented) return;
    current?.close();
    const final = preventableEvent();
    lifecycle.willQuit(final);
    if (!final.prevented) events.push('quit-complete');
  }

  lifecycle = new DesktopLifecycle<FakeWindow>({
    platform,
    getWindow: () => current,
    createWindow: async () => { if (createGate) await createGate; addWindow(); },
    prepareClose: window => {
      const save = deferred();
      const index = saves.push(save);
      events.push(`prepare:${window.id}`);
      return save.promise.then(() => { events.push(`saved:${index}`); });
    },
    promptCloseFailure: async () => {
      prompts++;
      const decision = decisions.shift() ?? 'cancel';
      events.push(`decision:${decision}`);
      if (decision === 'dialog-error') throw new Error('The native dialog was closed');
      return decision;
    },
    quit,
    dispose: () => { disposed++; events.push('queue-stop', 'database-close'); },
  });
  if (initialWindow) addWindow();
  return { lifecycle, events, saves, decisions, quit, get current() { return current; }, get quitAttempts() { return quitAttempts; }, get disposed() { return disposed; }, get created() { return created; }, get prompts() { return prompts; } };
}

describe('platform application menus', () => {
  it('retains the Windows window without an application menu', () => {
    expect(applicationMenuTemplate('win32')).toBeNull();
  });

  it('provides native macOS application, editing and window roles plus Close for Cmd+W', () => {
    const template = applicationMenuTemplate('darwin')!;
    expect(template.map(item => item.role).filter(Boolean)).toEqual(['appMenu', 'editMenu', 'windowMenu']);
    const file = template.find(item => item.label === '文件');
    expect(file?.submenu).toEqual([{ role: 'close' }]);
  });
});

describe('desktop save and quit lifecycle', () => {
  it('on Windows keeps storage alive while a normal close saves, then quits and disposes once', async () => {
    const app = desktop('win32');
    const window = app.current!;
    window.close();
    window.close();
    expect(app.saves).toHaveLength(1);
    expect(window.enabled).toBe(false);
    expect(window.destroyed).toBe(false);
    expect(app.disposed).toBe(0);
    expect(app.quitAttempts).toBe(0);

    app.saves[0].resolve();
    await vi.waitFor(() => expect(app.disposed).toBe(1));
    expect(window.destroyed).toBe(true);
    expect(app.events.indexOf('saved:1')).toBeLessThan(app.events.indexOf('closed:1'));
    expect(app.events.indexOf('closed:1')).toBeLessThan(app.events.indexOf('database-close'));
    app.lifecycle.willQuit(preventableEvent());
    expect(app.disposed).toBe(1);
  });

  it('on macOS saves each close, stays alive, reopens from Dock, and requires a fresh save on the new window', async () => {
    const app = desktop('darwin');
    const first = app.current!;
    first.close();
    app.saves[0].resolve();
    await vi.waitFor(() => expect(first.destroyed).toBe(true));
    expect(app.current).toBeNull();
    expect(app.quitAttempts).toBe(0);
    expect(app.disposed).toBe(0);

    await app.lifecycle.activate();
    const second = app.current!;
    expect(second).not.toBe(first);
    expect(app.created).toBe(2);
    second.close();
    expect(app.saves).toHaveLength(2);
    expect(second.destroyed).toBe(false);
    expect(second.enabled).toBe(false);
    expect(app.disposed).toBe(0);
    app.saves[1].resolve();
    await vi.waitFor(() => expect(second.destroyed).toBe(true));
    expect(app.quitAttempts).toBe(0);
    expect(app.disposed).toBe(0);

    app.quit();
    expect(app.disposed).toBe(1);
    expect(app.events.indexOf('saved:2')).toBeLessThan(app.events.indexOf('database-close'));
  });

  it('on macOS intercepts Cmd+Q until the renderer flush completes, even with repeated quit requests', async () => {
    const app = desktop('darwin');
    const window = app.current!;
    app.quit();
    app.quit();
    expect(app.saves).toHaveLength(1);
    expect(window.destroyed).toBe(false);
    expect(app.disposed).toBe(0);
    expect(app.events).not.toContain('quit-complete');
    await app.lifecycle.activate();
    expect(app.created).toBe(1);

    app.saves[0].resolve();
    await vi.waitFor(() => expect(app.disposed).toBe(1));
    expect(app.events.indexOf('saved:1')).toBeLessThan(app.events.indexOf('queue-stop'));
    expect(app.events.indexOf('saved:1')).toBeLessThan(app.events.indexOf('database-close'));
    expect(window.destroyed).toBe(true);
    expect(app.events.filter(event => event === 'quit-complete')).toHaveLength(1);
  });

  it('joins an in-progress ordinary window save when macOS quit is requested', async () => {
    const app = desktop('darwin');
    app.current!.close();
    app.quit();
    expect(app.saves).toHaveLength(1);
    expect(app.disposed).toBe(0);
    app.saves[0].resolve();
    await vi.waitFor(() => expect(app.disposed).toBe(1));
    expect(app.events.filter(event => event.startsWith('prepare:'))).toHaveLength(1);
  });

  it('cancels macOS application quit when saving fails, and a later normal close still leaves the app running', async () => {
    const app = desktop('darwin');
    const window = app.current!;
    app.decisions.push('cancel');
    app.quit();
    app.saves[0].reject(new Error('Disk is unavailable'));
    await vi.waitFor(() => expect(app.prompts).toBe(1));
    expect(window.enabled).toBe(true);
    expect(window.destroyed).toBe(false);
    expect(app.disposed).toBe(0);

    window.close();
    expect(app.saves).toHaveLength(2);
    app.saves[1].resolve();
    await vi.waitFor(() => expect(window.destroyed).toBe(true));
    expect(app.quitAttempts).toBe(1);
    expect(app.disposed).toBe(0);
    await app.lifecycle.activate();
    expect(app.created).toBe(2);
  });

  it('retries a failed save without closing storage between attempts', async () => {
    const app = desktop('darwin');
    app.decisions.push('retry');
    app.quit();
    app.saves[0].reject(new Error('Transient write failure'));
    await vi.waitFor(() => expect(app.saves).toHaveLength(2));
    expect(app.current!.destroyed).toBe(false);
    expect(app.disposed).toBe(0);
    app.saves[1].resolve();
    await vi.waitFor(() => expect(app.disposed).toBe(1));
    expect(app.events.indexOf('saved:2')).toBeLessThan(app.events.indexOf('database-close'));
  });

  it('only discards a failed save after the user explicitly chooses to close anyway', async () => {
    const app = desktop('win32');
    app.decisions.push('discard');
    app.current!.close();
    app.saves[0].reject(new Error('Persistent write failure'));
    await vi.waitFor(() => expect(app.disposed).toBe(1));
    expect(app.events.indexOf('decision:discard')).toBeLessThan(app.events.indexOf('database-close'));
    expect(app.events.some(event => event.startsWith('saved:'))).toBe(false);
  });

  it('keeps unsaved state when the native failure dialog itself rejects', async () => {
    const app = desktop('darwin');
    const window = app.current!;
    app.decisions.push('dialog-error');
    app.quit();
    app.saves[0].reject(new Error('Write failure'));
    await vi.waitFor(() => expect(app.prompts).toBe(1));
    expect(window.destroyed).toBe(false);
    expect(window.enabled).toBe(true);
    expect(app.disposed).toBe(0);
    await app.lifecycle.activate();
    expect(window.focused).toBe(1);
  });

  it('coalesces concurrent Dock activations into one recreated window', async () => {
    const gate = deferred();
    const app = desktop('darwin', { initialWindow: false, createGate: gate.promise });
    const first = app.lifecycle.activate();
    const second = app.lifecycle.activate();
    expect(app.created).toBe(0);
    gate.resolve();
    await Promise.all([first, second]);
    expect(app.created).toBe(1);
    expect(app.current).not.toBeNull();
  });

  it('restores and focuses an existing minimized window instead of creating another', async () => {
    const app = desktop('darwin');
    const window = app.current!;
    window.minimized = true;
    await app.lifecycle.activate();
    expect(app.created).toBe(1);
    expect(window.restored).toBe(1);
    expect(window.shown).toBe(1);
    expect(window.focused).toBe(1);
  });

  it('does not create a queued Dock window after an application quit has already disposed storage', async () => {
    const app = desktop('darwin', { initialWindow: false });
    const opening = app.lifecycle.activate();
    app.quit();
    await opening;
    expect(app.disposed).toBe(1);
    expect(app.created).toBe(0);
    expect(app.current).toBeNull();
  });

  it('does not dispose storage if a premature will-quit occurs before the renderer save', async () => {
    const app = desktop('darwin');
    const event = preventableEvent();
    app.lifecycle.willQuit(event);
    expect(event.prevented).toBe(true);
    expect(app.disposed).toBe(0);
    expect(app.saves).toHaveLength(1);
    app.saves[0].resolve();
    await vi.waitFor(() => expect(app.disposed).toBe(1));
  });
});
