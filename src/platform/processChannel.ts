/**
 * 跨平台进程通道：为驱动提供「独立子进程」运行模式（sidecar）。
 *
 * 为什么要抽这一层：
 * 1. Windows 与 WSL 的进程创建语义不同——Windows 下没有 POSIX 信号，
 *    `SIGTERM` 实际走 TerminateProcess；WSL 下需要处理孤儿进程。
 * 2. VS Code 扩展宿主的 `process.execPath` 在 Windows 上是 `Code.exe`，
 *    直接 fork 会启动一个 IDE 窗口而不是 Node 进程，必须注入 `ELECTRON_RUN_AS_NODE=1`。
 * 3. WSL 中通过 `/mnt/c/...` 访问 Windows 侧脚本时，工作目录与路径分隔符都需要适配。
 *
 * 通道协议：基于 child_process.fork 的 IPC，JSON-RPC 风格（id/method/params）。
 * 不依赖任何第三方库，Node 内置能力即可。
 */

import { ChildProcess, ForkOptions, fork } from 'child_process';
import * as path from 'path';
import { EventEmitter } from 'events';

export interface RpcRequest {
  id: number;
  method: string;
  params: unknown;
}

export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { message: string; code?: string; detail?: string };
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface ProcessChannelOptions {
  /** 要启动的入口脚本（编译后的 JS 绝对路径）。 */
  modulePath: string;
  /** 传给脚本的参数。 */
  args?: string[];
  /** 单次请求超时（毫秒）。 */
  requestTimeoutMs?: number;
  /** 子进程启动失败时的重试次数。 */
  retries?: number;
  cwd?: string;
}

export class ProcessChannelError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ProcessChannelError';
  }
}

export class ProcessChannel extends EventEmitter {
  private child?: ChildProcess;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private disposed = false;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: ProcessChannelOptions) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  get running(): boolean {
    return !!this.child && !this.child.killed && this.child.exitCode === null;
  }

  /** 启动子进程；已启动则直接复用。 */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    if (this.disposed) {
      throw new ProcessChannelError('通道已释放，无法复用');
    }

    const retries = this.options.retries ?? 1;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.spawn();
        return;
      } catch (err) {
        lastError = err as Error;
        this.killChild();
      }
    }
    throw new ProcessChannelError(
      `驱动子进程启动失败：${lastError?.message ?? '未知原因'}`,
      'EPROCESS_START',
    );
  }

  private spawn(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // 关键点：Windows 上 extensionHost 的 execPath 是 Code.exe，
        // 不加这个变量 fork 出来的是 IDE 而不是 Node。
        ELECTRON_RUN_AS_NODE: '1',
        DBVIEWER_SIDECAR: '1',
        // 强制 UTF-8，避免 Windows 下 GBK 控制台编码导致结果乱码。
        LANG: process.env.LANG || 'C.UTF-8',
        LC_ALL: process.env.LC_ALL || 'C.UTF-8',
      };

      let child: ChildProcess;
      try {
        // windowsHide 未出现在 ForkOptions 的公开类型中，但对 Windows 有实际意义：
        // 不隐藏会短暂闪出控制台窗口，因此显式声明类型后传入。
        const forkOptions: ForkOptions & { windowsHide: boolean } = {
          env,
          cwd: this.options.cwd ?? path.dirname(this.options.modulePath),
          // stdio 保留 ipc，stdout/stderr 由本进程接管，便于把驱动日志回传
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          execPath: resolveExecPath(),
          windowsHide: true,
        };
        child = fork(this.options.modulePath, this.options.args ?? [], forkOptions);
      } catch (err) {
        reject(err as Error);
        return;
      }

      this.child = child;
      let settled = false;

      const onSpawn = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const onError = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (!settled) {
          settled = true;
          reject(
            new ProcessChannelError(
              `驱动子进程启动后立即退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`,
              'EPROCESS_EXIT',
            ),
          );
        }
        this.rejectAll(new ProcessChannelError('驱动子进程已退出', 'EPROCESS_GONE'));
        this.emit('exit', code, signal);
      };

      child.once('spawn', onSpawn);
      child.once('error', onError);
      child.on('exit', onExit);

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => this.emit('stdout', chunk));
      child.stderr?.on('data', (chunk: string) => this.emit('stderr', chunk));

      // 参数类型收窄：Node 的监听器签名是 (message: Serializable)，此处显式转成协议类型
      child.on('message', (raw: unknown) => this.onMessage(raw as RpcResponse | RpcNotification));
    });
  }

  private onMessage(message: RpcResponse | RpcNotification): void {
    if (message && typeof message === 'object' && 'id' in message && typeof message.id === 'number') {
      const entry = this.pending.get(message.id);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new ProcessChannelError(message.error.message, message.error.code));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    this.emit('notification', message);
  }

  /** 发送一次 RPC 请求，等待应答。 */
  async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (!this.running) {
      await this.start();
    }
    const child = this.child;
    if (!child?.connected) {
      throw new ProcessChannelError('驱动子进程 IPC 不可用', 'EPROCESS_IPC');
    }
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProcessChannelError(`驱动子进程响应超时（${method}，${this.requestTimeoutMs}ms）`, 'EPROCESS_TIMEOUT'));
      }, this.requestTimeoutMs);
      // 不阻塞事件循环退出
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        child.send({ id, method, params } satisfies RpcRequest);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  private rejectAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private killChild(): void {
    const child = this.child;
    if (!child) {
      return;
    }
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
    this.child = undefined;
  }

  /** 优雅关闭：先请求子进程自退，超时后强制终止。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.rejectAll(new ProcessChannelError('通道已关闭', 'EPROCESS_CLOSED'));
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = undefined;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      child.once('exit', finish);
      try {
        if (child.connected) {
          child.send({ method: '__shutdown', params: {} });
        }
      } catch {
        /* 忽略 */
      }
      const timer = setTimeout(() => {
        // 兜底强杀：Windows 下等同于 TerminateProcess，WSL 下为 SIGKILL
        try {
          child.kill('SIGKILL');
        } catch {
          /* 忽略 */
        }
        finish();
      }, 3000);
      timer.unref?.();
    });
  }
}

/**
 * 解析用于 fork 的可执行文件。
 *
 * Windows：扩展宿主中 `process.execPath` 为 Code.exe，配合 ELECTRON_RUN_AS_NODE 可直接当 Node 用。
 * WSL/Linux：直接使用当前进程的可执行文件，保证版本一致。
 */
function resolveExecPath(): string {
  return process.execPath;
}
