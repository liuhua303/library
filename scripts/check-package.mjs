import { _electron as electron } from 'playwright';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { packageExecutablePath } from './package-paths.mjs';

const userData = await mkdtemp(join(tmpdir(), 'yuejian-package-'));
const env = { ...process.env, APP_TEST_MODE: '1', READER_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const productName = metadata.build.mac?.executableName || metadata.build.productName;
const executablePath = packageExecutablePath(process.argv[2], { productName });
await mkdir(resolve('artifacts'), { recursive: true });
const app = await electron.launch({ executablePath, args: [], env, timeout: 30000 });
try {
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), userData, '打包验证必须使用独立测试目录');
  const page = await app.firstWindow({ timeout: 15000 });
  await page.waitForFunction(() => Boolean(window.readerApi));
  const result = await page.evaluate(async () => ({ title: document.title, booksReadable: Array.isArray(await window.readerApi.listBooks()), settingsReadable: typeof (await window.readerApi.getSettings()).hasApiKey === 'boolean' }));
  assert.ok(result.title.includes('阅间'));
  assert.ok(result.booksReadable && result.settingsReadable);
  const runtime = await app.evaluate(({ app }) => ({ version: app.getVersion(), platform: process.platform, arch: process.arch }));
  if (runtime.platform === 'darwin') assert.equal(runtime.arch, 'arm64', 'Mac 交付仅支持 Apple Silicon arm64');
  const record = { passed: true, ...runtime, ...result, executablePath, recordedAt: new Date().toISOString() };
  await page.screenshot({ path: resolve('artifacts/packaged-startup.png') });
  await writeFile(resolve('artifacts/package-result.json'), JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
} finally {
  await app.close();
}
