/**
 * 外部命令行工具调用。
 *
 * 仅用于「原生备份」这一类需要借力现成工具的场合（mysqldump / pg_dump），
 * 并且**只在用户显式开启 `dbviewer.allowExternalCommand` 后才会被走到**——
 * 受管控的机器上这类调用常被安全策略拦截，默认路径必须完全不依赖子进程。
 *
 * 两条安全底线：
 * 1. `shell: false` + 参数数组：值永远不会被 shell 解释，注入无从谈起；
 * 2. 密码只走环境变量（MYSQL_PWD / PGPASSWORD），绝不进命令行——命令行参数在
 *    进程列表里对同机其他用户可见。
 *
 * 本模块不 import `vscode`：调用方传入的取消令牌只要求结构化兼容。
 */

import { spawn, ChildProcess } from 'child_process';
import { createWriteStream, WriteStream } from 'fs';

import type { CancellationLike } from '../core/backup';
import { DatabaseError } from '../core/types';

export interface ExternalToolSpec {
  command: string;
  args: string[];
  /** 追加到子进程环境的键值（密码走这里）。 */
  env?: Record<string, string>;
  cwd?: string;
  /** 把 stdout 直接写进该文件；不指定则累积到内存返回。 */
  stdoutFile?: string;
  timeoutMs: number;
  token?: CancellationLike;
  /** 内存模式下保留的 stdout 上限，避免误用大输出把扩展宿主撑爆。 */
  maxCaptureBytes?: number;
}

export interface ExternalToolResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdoutFile 模式下实际写入的字节数。 */
  bytes: number;
  cancelled: boolean;
}

const DEFAULT_MAX_CAPTURE = 256 * 1024;

/**
 * 执行外部命令并等待结束。
 *
 * 失败分三类，报错文案要能直接指向根因：
 * - 进程起不来（ENOENT）：命令不在 PATH 里，指引用户配置绝对路径；
 * - 超时：主动 kill 并说明超时可调；
 * - 非 0 退出：附上 stderr 尾部（多数工具把真正的错误写在最后几行）。
 */
export async function runExternalTool(spec: ExternalToolSpec): Promise<ExternalToolResult> {
  const timeoutMs = Math.max(1000, spec.timeoutMs);
  const maxCapture = spec.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE;
  assertSafeArgs(spec.args);

  return new Promise<ExternalToolResult>((resolve, reject) => {
    let settled = false;
    let child: ChildProcess;
    let stream: WriteStream | undefined;
    let bytes = 0;
    let stdout = '';
    let stderr = '';
    let cancelled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill();
    }, timeoutMs);
    timer.unref?.();

    const subscription = spec.token?.onCancellationRequested(() => {
      cancelled = true;
      child?.kill();
    });

    const cleanup = () => {
      clearTimeout(timer);
      subscription?.dispose();
    };

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };

    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        // 关键：不走 shell。参数原样交给进程，值里的引号、&、$ 都不会被解释
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish(() => reject(wrapSpawnFailure(err, spec.command)));
      return;
    }

    if (spec.stdoutFile) {
      stream = createWriteStream(spec.stdoutFile);
      stream.on('error', (err) => {
        child.kill();
        finish(() => reject(new DatabaseError(`无法写入备份文件：${err.message}`, 'EWRITE_FAILED')));
      });
      child.stdout?.pipe(stream);
      child.stdout?.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
    } else {
      child.stdout?.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (stdout.length < maxCapture) {
          stdout += chunk.toString('utf8');
        }
      });
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      // stderr 只留尾部：报错信息总在最后，而工具可能刷出大量进度噪音
      stderr = (stderr + chunk.toString('utf8')).slice(-8_000);
    });

    child.on('error', (err) => {
      finish(() => reject(wrapSpawnFailure(err, spec.command)));
    });

    child.on('close', (code) => {
      const finishStream = (fn: () => void) => {
        if (stream) {
          stream.end(() => finish(fn));
        } else {
          finish(fn);
        }
      };

      if (cancelled || timedOut) {
        finishStream(() =>
          resolve({ code: code ?? -1, stdout, stderr, bytes, cancelled: true }),
        );
        return;
      }
      if (code !== 0) {
        finishStream(() =>
          reject(
            new DatabaseError(
              `${spec.command} 退出码 ${code ?? 'null'}：${lastLines(stderr) || '（无输出）'}`,
              'ETOOL_FAILED',
              stderr.trim() || undefined,
            ),
          ),
        );
        return;
      }
      finishStream(() => resolve({ code: 0, stdout, stderr, bytes, cancelled: false }));
    });
  });
}

/**
 * 按模板展开原生工具的参数。
 *
 * 值一律产生**独立的参数元素**，绝不与模板拼进同一个字符串：这是配合 `shell: false`
 * 之后仍然必须守住的一步，否则 `--table=a b` 这种把两个值塞进一个参数的写法
 * 会让参数被工具误解。
 *
 * 单独成项的 `${tables}` 展开为零个或多个参数；其余占位符做字符串替换。
 */
export function expandNativeArgs(
  template: string[],
  values: {
    host: string;
    port: number;
    user: string;
    database?: string;
    schema?: string;
    tables?: string[];
  },
): string[] {
  const args: string[] = [];
  for (const item of template) {
    if (item === '${tables}') {
      for (const table of values.tables ?? []) {
        args.push(table);
      }
      continue;
    }
    const expanded = item.replace(/\$\{(\w+)\}/g, (_match, key: string) => {
      switch (key) {
        case 'host':
          return values.host;
        case 'port':
          return String(values.port);
        case 'user':
          return values.user;
        case 'database':
          return values.database ?? '';
        case 'schema':
          return values.schema ?? '';
        default:
          return '';
      }
    });
    args.push(expanded);
  }
  return args;
}

/** 参数里出现空字节会让 spawn 直接抛错，提前拦下并给出可理解的提示。 */
function assertSafeArgs(args: string[]): void {
  for (const arg of args) {
    if (arg.includes('\u0000')) {
      throw new DatabaseError('备份参数包含非法字符（空字节）', 'EBAD_ARGUMENT');
    }
  }
}

function wrapSpawnFailure(err: unknown, command: string): DatabaseError {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'ENOENT') {
    return new DatabaseError(
      `未找到命令「${command}」。请确认它已安装并加入 PATH，或在设置 dbviewer.backupToolPaths 中填写绝对路径。`,
      'ENOENT',
      e.message,
    );
  }
  if (e?.code === 'EACCES') {
    return new DatabaseError(`没有权限执行「${command}」，请检查文件权限。`, 'EACCES', e.message);
  }
  return new DatabaseError(`无法启动「${command}」：${e?.message ?? String(err)}`, e?.code);
}

function lastLines(text: string, count = 6): string {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-count).join('\n');
}
