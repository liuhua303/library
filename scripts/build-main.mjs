import { build } from 'esbuild';
await build({ entryPoints: { main: 'src/main/index.ts', preload: 'src/main/preload.ts' }, bundle: true, platform: 'node', format: 'cjs', target: 'node24', outdir: 'app', outExtension: { '.js': '.cjs' }, external: ['electron', 'node:sqlite'], sourcemap: true });

