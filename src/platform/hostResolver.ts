/**
 * 主机地址解析：抹平 Windows / WSL 之间的网络可达性差异。
 *
 * 核心问题：WSL2 默认 NAT 网络下，WSL 与 Windows 各有独立 IP，`localhost` 在两侧
 * 指向不同实体。用户在切换开发场景（本地 Windows 打开 vs Remote-WSL 打开）时，
 * 连接配置里的 host 往往不再有效。
 *
 * 解法：引入主机别名占位符，由本模块在建立连接前解析为当前环境的真实地址。
 *
 * - `__windows_host__`  部署在 Windows 上的数据库（WSL 中访问宿主）
 * - `__wsl_host__`      部署在 WSL 内的数据库（Windows 中访问 WSL）
 * - `__localhost__`     强制使用当前环境的回环地址
 */

import { RuntimeEnvironment } from './environment';

export const HOST_ALIAS_WINDOWS = '__windows_host__';
export const HOST_ALIAS_WSL = '__wsl_host__';
export const HOST_ALIAS_LOCALHOST = '__localhost__';

export type HostResolutionSource = 'literal' | 'userAlias' | 'builtinAlias' | 'auto';

export interface HostResolution {
  /** 用户填写的原始值。 */
  input: string;
  /** 解析后用于实际建立连接的主机地址。 */
  host: string;
  source: HostResolutionSource;
  /** 面向用户展示的解析说明（成功路径）。 */
  note?: string;
  /** 面向用户展示的告警（解析失败或存在风险）。 */
  warning?: string;
}

export interface HostResolverOptions {
  autoResolve: boolean;
  userAliases: Record<string, string>;
}

export class HostResolver {
  constructor(
    private readonly env: RuntimeEnvironment,
    private readonly options: HostResolverOptions,
  ) {}

  /** 解析单个主机值。 */
  resolve(raw: string): HostResolution {
    const input = (raw ?? '').trim();
    if (!input) {
      return { input, host: '127.0.0.1', source: 'literal', warning: '主机地址为空，已回退到 127.0.0.1' };
    }

    // 1) 用户自定义别名优先级最高，便于覆盖内网固定 IP。
    const userAlias = matchAlias(input, this.options.userAliases);
    if (userAlias) {
      return { input, host: userAlias[1], source: 'userAlias', note: `${userAlias[0]} → ${userAlias[1]}（自定义别名）` };
    }

    if (!this.options.autoResolve) {
      return { input, host: stripAliasSyntax(input), source: 'literal' };
    }

    const key = normalizeAliasKey(input);

    // 2) Windows -> WSL
    if (key === HOST_ALIAS_WSL) {
      if (!this.env.isWSL && this.env.family === 'windows') {
        if (this.env.wslHostIp) {
          const loopback = this.env.wslHostIp === '127.0.0.1';
          let note: string;
          if (!loopback) {
            note = `__wsl_host__ → ${this.env.wslHostIp}（WSL2 NAT 模式，发行版独立 IP）`;
          } else if (this.env.wslNetworkMode === 'mirrored') {
            note = '__wsl_host__ → 127.0.0.1（WSL 镜像网络模式，回环直通）';
          } else {
            note =
              '__wsl_host__ → 127.0.0.1（依赖 WSL2 默认的 localhost 转发）。' +
              '若连接被拒绝，请在 WSL 内执行 `hostname -I` 获取发行版 IP 后手工填写；' +
              '或开启 dbviewer.allowExternalCommand 让插件自动探测。';
          }
          return { input, host: this.env.wslHostIp, source: 'builtinAlias', note };
        }
        return {
          input,
          host: '127.0.0.1',
          source: 'builtinAlias',
          warning:
            '__wsl_host__ 解析失败：未能获取 WSL 地址。' +
            '请在 WSL 内执行 `hostname -I` 获取 IP 后手工填写。',
        };
      }
      if (this.env.isWSL) {
        return {
          input,
          host: '127.0.0.1',
          source: 'builtinAlias',
          note: '__wsl_host__ → 127.0.0.1（当前已在 WSL 内，直连本机）',
        };
      }
      return { input, host: '127.0.0.1', source: 'builtinAlias', note: '__wsl_host__ → 127.0.0.1' };
    }

    // 3) WSL -> Windows
    if (key === HOST_ALIAS_WINDOWS) {
      if (this.env.isWSL) {
        if (this.env.windowsHostIp) {
          const mirrored = this.env.wslNetworkMode === 'mirrored';
          return {
            input,
            host: this.env.windowsHostIp,
            source: 'builtinAlias',
            note: mirrored
              ? '__windows_host__ → 127.0.0.1（WSL 镜像网络模式，回环直通宿主）'
              : `__windows_host__ → ${this.env.windowsHostIp}（WSL2 NAT 模式默认网关 = Windows 宿主）`,
          };
        }
        return {
          input,
          host: '127.0.0.1',
          source: 'builtinAlias',
          warning:
            '__windows_host__ 解析失败：未能从 /proc/net/route 读到默认网关。' +
            '可在 WSL 内执行 `ip route show default` 确认网关地址后手工填写。',
        };
      }
      if (this.env.family === 'windows') {
        return {
          input,
          host: '127.0.0.1',
          source: 'builtinAlias',
          note: '__windows_host__ → 127.0.0.1（当前已在 Windows 上，直连本机）',
        };
      }
      return { input, host: '127.0.0.1', source: 'builtinAlias', note: '__windows_host__ → 127.0.0.1' };
    }

    // 4) 显式回环。注意：用户直接输入 `localhost` / `127.0.0.1` 也会走到这里
    //    （别名匹配对大小写与下划线宽容），因此必须保留跨环境风险提示，
    //    否则「在 Windows 上填 localhost，切到 Remote-WSL 就连不上」的经典问题会被静默吞掉。
    if (key === HOST_ALIAS_LOCALHOST) {
      return {
        input,
        host: '127.0.0.1',
        source: 'builtinAlias',
        note: '__localhost__ → 127.0.0.1',
        warning: this.crossEnvironmentHint(input),
      };
    }

    // 5) 普通主机名 / IP，原样返回，但附带跨环境风险提示。
    return { input, host: input, source: 'literal', warning: this.crossEnvironmentHint(input) };
  }

  /**
   * 当用户写死 `localhost` 时，提示跨环境切换会踩的坑。
   * 这是高频事故点：在 Windows 侧新增连接测好，切到 Remote-WSL 就报 ECONNREFUSED。
   */
  private crossEnvironmentHint(host: string): string | undefined {
    if (!/^(localhost|127\.0\.0\.1|::1)$/i.test(host)) {
      return undefined;
    }
    if (this.env.isWSL) {
      return '当前运行在 WSL 内，`localhost` 指向 WSL 自身。若数据库装在 Windows 上，请改用 __windows_host__。';
    }
    if (this.env.family === 'windows' && this.env.wslHostIp) {
      return '当前运行在 Windows 上，`localhost` 指向 Windows 自身。若数据库装在 WSL 内，请改用 __wsl_host__。';
    }
    return undefined;
  }

  /** 生成解析失败的替代建议列表，用于错误弹窗。 */
  suggestions(failedHost: string): string[] {
    const tips: string[] = [];
    if (this.env.isWSL) {
      tips.push(`数据库在 Windows 侧？把主机改为 ${HOST_ALIAS_WINDOWS}`);
      if (this.env.windowsHostIp) {
        tips.push(`当前 Windows 宿主地址：${this.env.windowsHostIp}`);
      } else {
        tips.push('在 WSL 内执行 `ip route show default`，取 default 后的首个 IP 即 Windows 宿主');
      }
      tips.push('数据库在 WSL 内？主机填 __wsl_host__ 或 127.0.0.1');
    } else if (this.env.family === 'windows') {
      tips.push(`数据库在 WSL 内？把主机改为 ${HOST_ALIAS_WSL}`);
      if (this.env.wslHostIp) {
        tips.push(`当前 WSL 地址：${this.env.wslHostIp}`);
      } else {
        tips.push('在 WSL 内执行 `hostname -I` 获取发行版 IP（本机策略可能禁止读取，需手工执行）');
      }
    }
    if (/^(localhost|127\.0\.0\.1|::1)$/i.test(failedHost) && this.env.isWSL) {
      tips.push('确认数据库监听地址：bind-address 为 127.0.0.1 时，仅 WSL 内部可连，宿主侧需改为 0.0.0.0');
    }
    return tips;
  }
}

function matchAlias(input: string, aliases: Record<string, string>): [string, string] | undefined {
  for (const [key, value] of Object.entries(aliases ?? {})) {
    if (normalizeAliasKey(key) === normalizeAliasKey(input)) {
      return [key, value];
    }
  }
  return undefined;
}

/** 别名匹配大小写不敏感，并容忍用户漏写双下划线。 */
function normalizeAliasKey(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.startsWith('__')) {
    return v;
  }
  return `__${v.replace(/^_+|_+$/g, '')}__`;
}

function stripAliasSyntax(value: string): string {
  return value.trim();
}
