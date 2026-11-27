import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// These Node CLI helpers are JavaScript and are also executed directly by npm.
const { planMacBuild } = await import(new URL('../scripts/mac-build-options.mjs', import.meta.url).href);
const { packageExecutablePath } = await import(new URL('../scripts/package-paths.mjs', import.meta.url).href);

describe('Apple Silicon distribution entry points', () => {
  it('stops unsupported build hosts before any build or credential operation', () => {
    const env = new Proxy({}, { get() { throw new Error('Credentials must not be read'); } });
    expect(() => planMacBuild({ platform: 'win32', env })).toThrow('需在 macOS 上构建');
    expect(() => planMacBuild({ platform: 'linux', env })).toThrow('需在 macOS 上构建');
  });

  it('keeps local trial builds separate and fixed to arm64 without Apple credentials', () => {
    const plan = planMacBuild({ platform: 'darwin', args: ['--local'], env: {} });
    expect(plan).toMatchObject({ arch: 'arm64', target: 'dmg', local: true });
    expect(plan.config).toMatchObject({
      directories: { output: 'release/mac-arm64-local' }, forceCodeSigning: false,
      mac: { identity: '-', notarize: false, hardenedRuntime: false, target: [{ target: 'dmg', arch: ['arm64'] }] },
    });
    expect(plan.config.mac.artifactName).toContain('-local.');
  });

  it('rejects Intel, universal and arbitrary extra flags', () => {
    for (const args of [['--x64'], ['--universal'], ['--local', '--x64'], ['--publish', 'always']]) {
      expect(() => planMacBuild({ platform: 'darwin', args, env: {} })).toThrow('固定为 arm64');
    }
  });

  it('does not silently ship an unnotarized release when credentials are absent or incomplete', () => {
    expect(() => planMacBuild({ platform: 'darwin', env: {} })).toThrow('公证凭据');
    expect(() => planMacBuild({ platform: 'darwin', env: { APPLE_ID: 'test@example.invalid' } })).toThrow('APPLE_APP_SPECIFIC_PASSWORD');
    expect(() => planMacBuild({ platform: 'darwin', env: { APPLE_API_KEY: '/tmp/example.p8' } })).toThrow('APPLE_API_KEY_ID');
  });

  it('requires complete credentials using the same precedence as electron-builder', () => {
    const env = { APPLE_ID: 'test@example.invalid', APPLE_KEYCHAIN_PROFILE: 'test-profile' };
    expect(() => planMacBuild({ platform: 'darwin', env })).toThrow('APPLE_APP_SPECIFIC_PASSWORD');
  });

  it.each([
    { APPLE_KEYCHAIN_PROFILE: 'test-profile' },
    { APPLE_ID: 'test@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'synthetic-test-only', APPLE_TEAM_ID: 'TESTTEAM' },
    { APPLE_API_KEY: '/tmp/example.p8', APPLE_API_KEY_ID: 'TESTKEY', APPLE_API_ISSUER: 'TESTISSUER' },
  ])('keeps valid formal plans signed, notarized and arm64-only', env => {
    const plan = planMacBuild({ platform: 'darwin', env });
    expect(plan.config).toMatchObject({
      directories: { output: 'release/mac-arm64' }, forceCodeSigning: true,
      mac: { type: 'distribution', hardenedRuntime: true, notarize: true, target: [{ target: 'dmg', arch: ['arm64'] }] },
    });
    expect(plan.config.mac.identity).toBeUndefined();
  });

  it('keeps the package defaults native to Apple Silicon and declares the Electron OS minimum', () => {
    const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(metadata.build.mac.target).toEqual([{ target: 'dmg', arch: ['arm64'] }]);
    expect(metadata.build.mac.minimumSystemVersion).toBe('13.0.0');
    const entitlements = readFileSync(new URL('../build/entitlements.mac.plist', import.meta.url), 'utf8');
    expect(entitlements).toContain('com.apple.security.cs.allow-jit');
    expect(entitlements).not.toContain('com.apple.security.app-sandbox');
  });
});

describe('packaged application path selection', () => {
  it('accepts a Mac app bundle as well as its direct executable', () => {
    const bundle = path.resolve('release/mac-arm64-local/mac-arm64/阅间.app');
    const binary = path.join(bundle, 'Contents', 'MacOS', '阅间');
    expect(packageExecutablePath(bundle, { platform: 'darwin' })).toBe(binary);
    expect(packageExecutablePath(binary, { platform: 'darwin' })).toBe(binary);
    expect(packageExecutablePath(undefined, { platform: 'darwin' })).toBe(path.resolve('release/mac-arm64/mac-arm64/阅间.app/Contents/MacOS/阅间'));
  });

  it('preserves the Windows executable default and explicit version paths', () => {
    expect(packageExecutablePath(undefined, { platform: 'win32' })).toBe(path.resolve('release/win-unpacked/阅间.exe'));
    expect(packageExecutablePath('release/0.3.3/win-unpacked/阅间.exe', { platform: 'win32' })).toBe(path.resolve('release/0.3.3/win-unpacked/阅间.exe'));
  });
});
