import path from 'node:path';

export function packageExecutablePath(input, { platform = process.platform, productName = '阅间' } = {}) {
  const candidate = input || (platform === 'darwin'
    ? `release/mac-arm64/mac-arm64/${productName}.app`
    : `release/win-unpacked/${productName}.exe`);
  const absolute = path.resolve(candidate);
  return path.extname(absolute).toLowerCase() === '.app'
    ? path.join(absolute, 'Contents', 'MacOS', productName)
    : absolute;
}
