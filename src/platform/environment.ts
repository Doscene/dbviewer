/**
 * 运行时环境探测：区分 Windows 原生、WSL 子系统、远程容器等场景。
 *
 * 设计原则：**默认不依赖外部命令**。
 *
 * 早期版本通过执行 `wsl.exe hostname -I` 获取 WSL 地址，但在受管控的机器上，
 * 安全策略常会禁止调用 `wsl.exe`——一旦被拦，探测流程不仅拿不到结果，
 * 还会拖慢启动甚至抛错。因此这里改为：
 *
 * 1. WSL → Windows：读 `/proc/net/route` 取默认网关（纯文件读取，零副作用）；
 * 2. Windows → WSL：默认返回 `127.0.0.1`，因为 WSL2 自带 localhost 转发，
 *    宿主访问 WSL 内服务本就可用回环地址；
 * 3. 仅当用户显式开启 `dbviewer.allowExternalCommand` 时，才尝试 `wsl.exe` / `wslinfo`。
 *
 * 本模块只依赖 Node 内置模块，可同时被扩展宿主与 sidecar 子进程复用。
 */

import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';

export type PlatformFamily = 'windows' | 'linux' | 'macos';
export type WslNetworkMode = 'nat' | 'mirrored' | 'unknown';

export interface RuntimeEnvironment {
  platform: NodeJS.Platform;
  family: PlatformFamily;
  arch: string;
  nodeVersion: string;
  /** 是否运行在 WSL 内。 */
  isWSL: boolean;
  wslDistro?: string;
  wslVersion?: 1 | 2;
  wslNetworkMode: WslNetworkMode;
  /** WSL 视角下的 Windows 宿主地址（NAT 模式为默认网关，镜像模式为 127.0.0.1）。 */
  windowsHostIp?: string;
  /** Windows 视角下的 WSL 发行版地址（镜像模式或 localhost 转发下为 127.0.0.1）。 */
  wslHostIp?: string;
  /** 是否成功从系统直接探测到 WSL 地址（未探测到时会退化为 127.0.0.1）。 */
  wslHostIpDetected: boolean;
  /** VS Code 的远程类型：local / wsl / ssh / container / unknown。 */
  remoteKind: 'local' | 'wsl' | 'ssh' | 'container' | 'unknown';
  /** 扩展宿主实际运行位置的可读描述。 */
  describe: string;
  /** 探测过程中产生的说明信息，用于诊断输出。 */
  notes: string[];
}

export interface DetectOptions {
  remoteName?: string;
  remoteDistro?: string;
  /**
   * 是否允许调用外部命令辅助探测（wsl.exe / wslinfo）。
   * 默认 false——受管控环境常禁止该行为。
   */
  allowExternalCommand?: boolean;
}

let cached: RuntimeEnvironment | undefined;

/** 探测当前运行环境。结果在进程生命周期内缓存（环境不会中途变化）。 */
export function detectEnvironment(options: DetectOptions = {}): RuntimeEnvironment {
  if (cached) {
    return cached;
  }
  const allowExec = options.allowExternalCommand ?? false;
  const platform = process.platform;
  const family: PlatformFamily =
    platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
  const isWSL = family === 'linux' && detectWSL();
  const notes: string[] = [];

  let remoteKind: RuntimeEnvironment['remoteKind'] = 'local';
  if (options.remoteName === 'wsl') {
    remoteKind = 'wsl';
  } else if (options.remoteName === 'ssh-remote') {
    remoteKind = 'ssh';
  } else if (options.remoteName?.startsWith('dev-container')) {
    remoteKind = 'container';
  } else if (options.remoteName) {
    remoteKind = 'unknown';
  }

  const wslVersion = isWSL ? detectWSLVersion() : undefined;
  const wslNetworkMode = isWSL ? detectWslNetworkMode(allowExec, notes) : 'unknown';

  const windowsHostIp = isWSL ? resolveWindowsHostIp(wslNetworkMode, notes) : undefined;
  const wslProbe = !isWSL && family === 'windows' ? resolveWslHostIp(allowExec, notes) : undefined;

  const env: RuntimeEnvironment = {
    platform,
    family,
    arch: process.arch,
    nodeVersion: process.version,
    isWSL,
    wslDistro: isWSL ? process.env.WSL_DISTRO_NAME || options.remoteDistro : undefined,
    wslVersion,
    wslNetworkMode,
    windowsHostIp,
    wslHostIp: wslProbe?.ip,
    wslHostIpDetected: !!wslProbe?.detected,
    remoteKind,
    describe: 'unknown',
    notes,
  };
  env.describe = describeEnvironment(env);
  cached = env;
  return env;
}

/** 清空缓存，仅用于测试。 */
export function resetEnvironmentCache(): void {
  cached = undefined;
}

function detectWSL(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP || process.env.WSLENV) {
    return true;
  }
  try {
    return /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function detectWSLVersion(): 1 | 2 | undefined {
  try {
    const release = fs.readFileSync('/proc/version', 'utf8');
    // WSL2 内核标识为 microsoft-standard-*，WSL1 只有 Microsoft
    if (/microsoft-standard/i.test(release)) {
      return 2;
    }
    if (/microsoft/i.test(release)) {
      return 1;
    }
  } catch {
    /* 忽略：无法读取时视为未知，不影响后续逻辑 */
  }
  return undefined;
}

/**
 * 判定 WSL 网络模式。
 *
 * - 允许外部命令时：以 `wslinfo --networking-mode` 为准；
 * - 否则依据 `/etc/resolv.conf` 与路由表推断：
 *   nameserver 为回环 → 镜像模式；nameserver 与默认网关一致 → NAT 模式。
 */
function detectWslNetworkMode(allowExec: boolean, notes: string[]): WslNetworkMode {
  if (allowExec) {
    try {
      const out = execFileSync('wslinfo', ['--networking-mode'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out === 'mirrored' || out === 'nat') {
        notes.push(`网络模式由 wslinfo 确认：${out}`);
        return out;
      }
    } catch {
      notes.push('wslinfo 不可用，改用 /etc/resolv.conf 与路由表推断网络模式');
    }
  }

  const nameserver = readResolvNameserver();
  if (nameserver && isLoopback(nameserver)) {
    return 'mirrored';
  }
  const gateway = readDefaultGateway();
  if (nameserver && gateway && nameserver === gateway) {
    return 'nat';
  }
  if (gateway) {
    return 'nat';
  }
  return 'unknown';
}

function readResolvNameserver(): string | undefined {
  try {
    return /^\s*nameserver\s+(\S+)/m.exec(fs.readFileSync('/etc/resolv.conf', 'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

/**
 * 解析 WSL 视角下的 Windows 宿主 IP。
 *
 * - 镜像模式：`127.0.0.1` 即为宿主，双向回环直通；
 * - NAT 模式：默认网关就是 Windows 宿主。
 */
function resolveWindowsHostIp(mode: WslNetworkMode, notes: string[]): string | undefined {
  if (mode === 'mirrored') {
    return '127.0.0.1';
  }
  const gateway = readDefaultGateway();
  if (gateway) {
    notes.push(`从 /proc/net/route 读到默认网关 ${gateway}（NAT 模式下即 Windows 宿主）`);
    return gateway;
  }
  notes.push('未能从 /proc/net/route 解析默认网关，__windows_host__ 将退化为 127.0.0.1');
  return undefined;
}

/** 从 `/proc/net/route` 读取默认网关（十六进制小端序）。 */
function readDefaultGateway(): string | undefined {
  try {
    const route = fs.readFileSync('/proc/net/route', 'utf8');
    for (const line of route.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 3 || cols[1] !== '00000000') {
        continue;
      }
      const raw = cols[2];
      if (!/^[0-9A-Fa-f]{8}$/.test(raw)) {
        continue;
      }
      // 小端序：0102A8C0 -> 192.168.2.1
      const bytes = [raw.slice(6, 8), raw.slice(4, 6), raw.slice(2, 4), raw.slice(0, 2)];
      return bytes.map((b) => parseInt(b, 16)).join('.');
    }
  } catch {
    /* 忽略：文件不存在或不可读 */
  }
  return undefined;
}

interface WslProbe {
  ip: string;
  detected: boolean;
}

/**
 * 解析 Windows 视角下的 WSL 地址。
 *
 * 默认策略：返回 `127.0.0.1` 并标记为「未探测」。WSL2 默认启用 localhost 转发，
 * 宿主通过回环地址即可访问 WSL 内监听的服务，因此这是可用且零副作用的选择。
 *
 * 若允许外部命令，则尝试 `wsl.exe hostname -I` 取发行版真实 IP（部分场景更可靠，
 * 例如容器内或转发被关闭时）。
 */
function resolveWslHostIp(allowExec: boolean, notes: string[]): WslProbe {
  if (!allowExec) {
    notes.push(
      '未启用外部命令探测：__wsl_host__ 按 127.0.0.1 处理（依赖 WSL2 默认的 localhost 转发）。' +
        '若转发被关闭，可开启 dbviewer.allowExternalCommand 或手工填写 WSL 的 `hostname -I` 结果。',
    );
    return { ip: '127.0.0.1', detected: false };
  }

  const distro = process.env.WSL_DISTRO_NAME;
  const commands: Array<[string, string[]]> = [['wsl.exe', ['hostname', '-I']]];
  if (distro) {
    commands.unshift(['wsl.exe', ['-d', distro, 'hostname', '-I']]);
  }
  for (const [cmd, args] of commands) {
    try {
      const out = execFileSync(cmd, args, {
        encoding: 'utf8',
        timeout: 4000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const ip = out
        .trim()
        .split(/\s+/)
        .find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value) && !isLoopback(value));
      if (ip) {
        notes.push(`通过 ${cmd} ${args.join(' ')} 解析到 WSL 地址 ${ip}`);
        return { ip, detected: true };
      }
    } catch {
      // 执行被安全策略拦截或 WSL 未安装，属预期内情况，继续尝试下一种方式
    }
  }
  notes.push('wsl.exe 调用失败（可能被安全策略拦截），__wsl_host__ 退化为 127.0.0.1');
  return { ip: '127.0.0.1', detected: false };
}

function isLoopback(ip: string): boolean {
  return ip.startsWith('127.') || ip === '::1';
}

function describeEnvironment(env: RuntimeEnvironment): string {
  if (env.isWSL) {
    const ver = env.wslVersion ? `WSL${env.wslVersion}` : 'WSL';
    return `${ver} 子系统 (${env.wslDistro ?? '未知发行版'}, 网络模式 ${env.wslNetworkMode})`;
  }
  if (env.family === 'windows') {
    return `Windows 原生 (${os.release()})`;
  }
  if (env.remoteKind === 'container') {
    return `容器内 Linux (${os.release()})`;
  }
  return `${env.family} (${os.release()})`;
}
