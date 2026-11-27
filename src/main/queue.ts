import type { DataChange } from '../shared/types';
import { analyseOccurrence, AnalysisError } from './analysis';
import { ReaderStore } from './store';

export interface QueueOptions {
  getApiKey: () => Promise<string | null>;
  getModel: () => string;
  onChange: (change: DataChange) => void;
  fetchFn?: typeof fetch;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export class AnalysisQueue {
  private stopped = false;
  private online = true;
  private active = false;
  private authBlocked = false;
  private authMessage = '';
  private configurationVersion = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;

  constructor(private readonly store: ReaderStore, private readonly options: QueueOptions) {}

  start(): void { this.store.releaseHeld(); this.kick(); }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
  }

  setOnline(online: boolean): void {
    const changed = this.online !== online;
    this.online = online;
    if (online && changed) { this.store.releaseHeld(); this.options.onChange({ reason: 'vocabulary' }); }
    if (!online) {
      this.store.holdPending('waiting_network', '等待联网后自动解析。');
      this.controller?.abort();
      this.options.onChange({ reason: 'vocabulary' });
    }
    this.kick();
  }

  resume(): void {
    this.authBlocked = false;
    this.authMessage = '';
    this.configurationVersion += 1;
    this.store.releaseHeld(true);
    this.options.onChange({ reason: 'vocabulary' });
    this.kick();
  }

  kick(): void {
    if (this.stopped || this.active) return;
    if (this.authBlocked) {
      this.store.holdPending('failed', this.authMessage);
      this.options.onChange({ reason: 'vocabulary' });
      return;
    }
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.active || this.stopped || this.authBlocked) return;
    this.active = true;
    try {
      if (!this.online) {
        this.store.holdPending('waiting_network', '等待联网后自动解析。');
        this.options.onChange({ reason: 'vocabulary' });
        return;
      }
      while (!this.stopped && this.online && !this.authBlocked) {
        let apiKey: string | null;
        try { apiKey = await this.options.getApiKey(); }
        catch {
          if (this.stopped) return;
          this.store.holdPending('needs_key', 'API 密钥暂时无法读取，请在设置中重新保存。');
          this.options.onChange({ reason: 'vocabulary' });
          return;
        }
        if (this.stopped) return;
        // Connectivity can change while the system key provider is resolving.
        if (!this.online) {
          this.store.holdPending('waiting_network', '等待联网后自动解析。');
          this.options.onChange({ reason: 'vocabulary' });
          return;
        }
        if (!apiKey) {
          this.store.holdPending('needs_key', '请在设置中配置 DeepSeek API 密钥。');
          this.options.onChange({ reason: 'vocabulary' });
          return;
        }
        this.store.releaseDueNetwork(Date.now());
        const task = this.store.claim();
        if (!task) break;
        const occurrence = task.occurrence;
        const requestConfiguration = this.configurationVersion;
        this.options.onChange({ reason: 'vocabulary', bookId: occurrence.bookId });
        const controller = new AbortController();
        this.controller = controller;
        const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 90_000);
        try {
          const analysis = await analyseOccurrence(occurrence, { apiKey, model: this.options.getModel(), signal: controller.signal, fetchFn: this.options.fetchFn });
          if (this.stopped) return;
          this.store.complete(occurrence.id, analysis);
        } catch (error) {
          if (this.stopped) return;
          const failure = error instanceof AnalysisError ? error : new AnalysisError('解析未完成，请稍后重试。', 'invalid');
          if (!this.online) {
            this.store.setTaskState(occurrence.id, 'waiting_network', '等待联网后自动解析。');
          } else if (requestConfiguration !== this.configurationVersion) {
            this.store.setTaskState(occurrence.id, 'pending', null);
          } else if (failure.category === 'auth') {
            this.authBlocked = true;
            this.authMessage = failure.message;
            this.store.setTaskState(occurrence.id, 'failed', failure.message);
            this.store.holdPending('failed', failure.message);
            this.options.onChange({ reason: 'vocabulary' });
          } else if (task.attempts < 3) {
            const delay = (this.options.retryDelayMs ?? 2000) * 2 ** (task.attempts - 1);
            this.store.setTaskState(occurrence.id, failure.category === 'network' ? 'waiting_network' : 'pending', failure.message, Date.now() + delay);
          } else {
            this.store.setTaskState(occurrence.id, 'failed', failure.message);
          }
        } finally {
          clearTimeout(timeout);
          this.controller = undefined;
        }
        if (this.stopped) return;
        this.options.onChange({ reason: 'vocabulary', bookId: occurrence.bookId });
      }
    } finally {
      this.active = false;
      if (!this.stopped && this.online && !this.authBlocked) {
        const wake = this.store.nextWakeTime();
        if (wake !== undefined) this.timer = setTimeout(() => this.kick(), Math.max(10, wake - Date.now()));
      }
    }
  }
}
