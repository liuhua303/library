import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planMacBuild } from './mac-build-options.mjs';

try {
  const plan = planMacBuild({ args: process.argv.slice(2) });
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // npm's entry point is available for npm run; direct invocation falls back to npm.
  const npmEntry = process.env.npm_execpath;
  await new Promise((resolve, reject) => {
    const child = spawn(npmEntry ? process.execPath : 'npm', npmEntry ? [npmEntry, 'run', 'build'] : ['run', 'build'], {
      cwd: projectRoot, env, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error('生产构建未完成：' + (signal || code))));
  });
  const { build, Platform, Arch } = await import('electron-builder');
  const files = await build({
    projectDir: projectRoot, targets: Platform.MAC.createTarget([plan.target], Arch.arm64),
    config: plan.config, publish: 'never',
  });
  console.log(plan.local ? 'Mac arm64 本机试用包已生成（ad-hoc 签名，未公证）：' : 'Mac arm64 正式签名及公证构建已完成：');
  for (const file of files) console.log(file);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
