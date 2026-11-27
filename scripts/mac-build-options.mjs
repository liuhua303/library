/** Validate the two supported Mac build modes before compiling or contacting Apple. */
export function planMacBuild({ platform = process.platform, args = [], env = process.env } = {}) {
  if (platform !== 'darwin') throw new Error('Mac arm64 安装包需在 macOS 上构建。请在 M 系列 Mac 上执行此命令。');
  if (args.length > 1 || (args.length === 1 && args[0] !== '--local')) {
    throw new Error('Mac 构建固定为 arm64，仅支持默认正式构建或 --local 本机试用构建。');
  }
  const local = args[0] === '--local';
  if (!local) requireNotarizationCredentials(env);
  return {
    arch: 'arm64', target: 'dmg', local,
    config: {
      directories: { output: local ? 'release/mac-arm64-local' : 'release/mac-arm64' },
      forceCodeSigning: !local,
      mac: {
        target: [{ target: 'dmg', arch: ['arm64'] }],
        ...(local ? {
          artifactName: 'Yuejian-${version}-mac-${arch}-local.${ext}',
          identity: '-', hardenedRuntime: false, notarize: false,
        } : { type: 'distribution', hardenedRuntime: true, notarize: true }),
      },
    },
  };
}

function requireNotarizationCredentials(env) {
  // Match electron-builder 26's credential precedence, reporting names, never values.
  const groups = [
    ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
  ];
  for (const group of groups) {
    const candidates = group[0] === 'APPLE_ID' ? group.slice(0, 2) : group;
    if (!candidates.some(name => env[name])) continue;
    const missing = group.filter(name => !env[name]);
    if (missing.length) throw new Error('Mac 公证配置不完整，缺少：' + missing.join(', '));
    return;
  }
  if (env.APPLE_KEYCHAIN_PROFILE) return;
  throw new Error('正式 Mac 构建需要 Developer ID 证书与公证凭据。请配置 APPLE_KEYCHAIN_PROFILE 或完整的 Apple 公证环境变量；本机试用可使用 npm run dist:mac:local。');
}
