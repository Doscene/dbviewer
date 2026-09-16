/**
 * 路径工具：Windows 与 WSL 之间的路径互转。
 *
 * 使用场景：
 * - 用户在 WSL 中工作，但 SQL 文件 / SSL 证书放在 Windows 盘（`C:\certs\ca.pem`）；
 * - 用户在 Windows 中工作，文件却在 WSL 的 `\\wsl.localhost\Ubuntu\...`；
 * - 连接配置里的证书、导出目录需要按目标环境转换。
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export type PathFlavor = 'windows' | 'wsl';

const WINDOWS_DRIVE_RE = /^([a-zA-Z]):[\\/](.*)$/;
const WSL_MOUNT_RE = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/;

/** 判断一个路径是否是 Windows 风格（`C:\x` 或 `C:/x` 或 UNC）。 */
export function isWindowsPath(value: string): boolean {
  return WINDOWS_DRIVE_RE.test(value) || value.startsWith('\\\\');
}

/** 判断一个路径是否是 WSL/Linux 风格。 */
export function isLinuxPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//');
}

/** `C:\a\b` → `/mnt/c/a/b`；输入非 Windows 路径时返回 undefined。 */
export function windowsToWslPath(value: string): string | undefined {
  const drive = WINDOWS_DRIVE_RE.exec(value);
  if (drive) {
    const rest = drive[2].replace(/\\/g, '/').replace(/\/+$/, '');
    return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
  }
  // UNC: \\wsl.localhost\Ubuntu\home\x → /home/x
  const unc = /^\\\\wsl(?:\.localhost)?\\[^\\]+\\(.*)$/.exec(value);
  if (unc) {
    return `/${unc[1].replace(/\\/g, '/')}`;
  }
  const smbUnc = /^\\\\([^\\]+)\\(.*)$/.exec(value);
  if (smbUnc) {
    // 普通 SMB 共享在 WSL 下需先挂载，无法直接转换，交给用户处理。
    return undefined;
  }
  return undefined;
}

/** `/mnt/c/a/b` → `C:\a\b`；输入非挂载路径时返回 undefined。 */
export function wslToWindowsPath(value: string): string | undefined {
  const mount = WSL_MOUNT_RE.exec(value);
  if (mount) {
    const rest = (mount[2] ?? '').replace(/\//g, '\\');
    return `${mount[1].toUpperCase()}:\\${rest}`;
  }
  return undefined;
}

/**
 * 把用户填写的路径转换成目标环境可用的路径。
 *
 * @param value 原始路径（任意风格）
 * @param target 目标环境
 * @returns 转换后的路径；无法转换时返回原值，保证不破坏用户输入
 */
export function adaptPath(value: string, target: PathFlavor): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  const expanded = expandHome(trimmed);
  if (target === 'wsl') {
    if (isLinuxPath(expanded)) {
      return expanded;
    }
    return windowsToWslPath(expanded) ?? expanded;
  }
  // target === 'windows'
  if (isWindowsPath(expanded)) {
    return expanded;
  }
  return wslToWindowsPath(expanded) ?? expanded;
}

/** 把当前运行环境下可用的路径转换成另一种风格的等价路径（用于展示给用户）。 */
export function toAlternatePath(value: string): string | undefined {
  return isWindowsPath(value) ? windowsToWslPath(value) : wslToWindowsPath(value);
}

/** 展开 `~` 前缀。 */
export function expandHome(value: string): string {
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(1));
  }
  return value;
}

/** 判断当前进程能否访问该路径（证书存在性校验等）。 */
export function pathAccessible(value: string): boolean {
  try {
    return fs.existsSync(value);
  } catch {
    return false;
  }
}

/**
 * 为当前环境生成一条路径兼容性提示。
 * 仅当用户填写的路径风格与运行环境不匹配时才返回内容。
 */
export function pathCompatibilityHint(value: string, env: { isWSL: boolean; family: string }): string | undefined {
  if (!value) {
    return undefined;
  }
  if (env.isWSL && isWindowsPath(value)) {
    const converted = windowsToWslPath(value);
    return converted
      ? `路径为 Windows 风格，在当前 WSL 环境中将按 \`${converted}\` 使用`
      : '检测到 Windows 风格路径，但当前运行在 WSL 内，该路径不可直接访问';
  }
  if (!env.isWSL && env.family === 'windows' && isLinuxPath(value)) {
    const converted = wslToWindowsPath(value);
    return converted
      ? `路径为 WSL 风格，在当前 Windows 环境中将按 \`${converted}\` 使用`
      : '检测到 Linux 风格路径，但当前运行在 Windows 上，该路径不可直接访问';
  }
  return undefined;
}
