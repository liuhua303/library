import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import electron from 'electron';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
process.chdir(projectRoot);
console.log('正在构建桌面主进程…');
await import('./build-main.mjs');
const server = await createServer({ server: { host: '127.0.0.1', port: 5173, strictPort: false } });
await server.listen();
const rendererUrl = server.resolvedUrls?.local[0];
if (!rendererUrl) { await server.close(); throw new Error('开发服务未能提供本机地址。'); }
const env = { ...process.env, ELECTRON_RENDERER_URL: rendererUrl };
delete env.ELECTRON_RUN_AS_NODE;
delete env.APP_TEST_MODE;
console.log(`开发服务已就绪：${rendererUrl}`);
console.log('正在打开“阅间”桌面窗口，按 Ctrl+C 停止开发服务。');
const child = spawn(electron, [projectRoot], { cwd: projectRoot, stdio: 'inherit', env, windowsHide: false });
let closing = false;
async function close() { if (closing) return; closing = true; child.kill(); await server.close(); }
child.on('error', async error => { console.error('桌面程序启动失败：', error.message); await close(); process.exit(1); });
child.on('exit', async code => { await close(); process.exit(code ?? 0); });
process.on('SIGINT', async () => { await close(); process.exit(0); });
process.on('SIGTERM', async () => { await close(); process.exit(0); });

