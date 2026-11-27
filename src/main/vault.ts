import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export class KeyVault {
  private readonly filePath: string;
  private cached: string | null | undefined;

  constructor(directory: string) { this.filePath = path.join(directory, 'deepseek-key.bin'); }

  async get(): Promise<string | null> {
    if (this.cached !== undefined) return this.cached;
    if (!existsSync(this.filePath)) return (this.cached = null);
    try {
      const encrypted = readFileSync(this.filePath);
      if (typeof safeStorage.decryptStringAsync === 'function') {
        const decrypted = await safeStorage.decryptStringAsync(encrypted);
        this.cached = decrypted.result;
        if (decrypted.shouldReEncrypt) await this.set(decrypted.result);
      } else {
        this.cached = safeStorage.decryptString(encrypted);
      }
      return this.cached;
    } catch { return (this.cached = null); }
  }

  async set(key: string): Promise<void> {
    if (!key) {
      if (existsSync(this.filePath)) unlinkSync(this.filePath);
      this.cached = null;
      return;
    }
    const asynchronous = typeof safeStorage.isAsyncEncryptionAvailable === 'function';
    const available = asynchronous ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
    if (!available) throw new Error('系统密钥保护暂不可用，请稍后重新保存。');
    const encrypted = asynchronous ? await safeStorage.encryptStringAsync(key) : safeStorage.encryptString(key);
    writeFileSync(`${this.filePath}.tmp`, encrypted);
    renameSync(`${this.filePath}.tmp`, this.filePath);
    this.cached = key;
  }
}
