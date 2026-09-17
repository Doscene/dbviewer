/**
 * SQL Shell 面板（Webview 交互式控制台）。
 *
 * 与 ResultPanel 走同一条边界：扩展侧持有输出缓冲与执行权，Webview 只负责输入与渲染。
 * 面板自己不接触驱动——执行、危险语句二次确认、超时、错误翻译全部由命令层注入的回调完成。
 * 绕开命令层就等于把只读拦截和二次确认这两道安全网拆掉。
 */

import * as vscode from 'vscode';

import { QueryResult, ResultSet } from '../core/types';

/** 推给 Webview 的结果集投影：行按列顺序展开成数组，避免对象键名在传输里重复 N 遍。 */
export interface ShellResultSet {
  statement: string;
  sql: string;
  fields: string[];
  rows: unknown[][];
  rowCount: number;
  affectedRows?: number;
  notices: string[];
}

/**
 * 一次执行的结果。
 *
 * 用「返回状态」而不是抛异常：取消执行（用户在二次确认里点了否）既不是成功也不是错误，
 * 面板要据此显示不同的样式，靠异常区分会把它混进真实的失败里。
 */
export type ShellExecutionOutcome =
  | { status: 'ok'; result: QueryResult }
  | { status: 'cancelled' }
  | { status: 'error'; message: string; hints?: string[] };

export interface SqlShellHost {
  connectionName: string;
  driverName: string;
  /** 连接目标描述，如 `root@127.0.0.1:3306/app`。 */
  target: string;
  environment: string;
  database?: string;
  /** 元命令帮助文本，由命令层按驱动能力生成。 */
  metaHelp: string;
  execute: (sql: string) => Promise<ShellExecutionOutcome>;
  listDatabases: () => Promise<string[]>;
  listTables: () => Promise<string[]>;
  /** 切换目标库（会重建连接），返回给用户看的提示。 */
  switchDatabase: (name: string) => Promise<string>;
  /** 面板关闭时通知命令层释放引用。 */
  onDispose?: () => void;
}

/** 单条输出最多推给 Webview 的行数：再多对"看一眼"没有价值，只会拖慢渲染。 */
const MAX_SHELL_ROWS = 200;

interface ShellEntry {
  id: number;
  at: number;
  sql: string;
  status: 'running' | 'ok' | 'error' | 'notice';
  durationMs?: number;
  truncated?: boolean;
  sets?: ShellResultSet[];
  message?: string;
  hints?: string[];
}

export class SqlShellPanel {
  /** 按连接持有实例：不同连接各开一个 shell，输出互不串台。 */
  private static readonly panels = new Map<string, SqlShellPanel>();

  private readonly disposables: vscode.Disposable[] = [];
  private readonly entries: ShellEntry[] = [];
  private host: SqlShellHost;
  private nextId = 1;
  private disposed = false;

  static open(extensionUri: vscode.Uri, profileId: string, host: SqlShellHost): SqlShellPanel {
    const existing = SqlShellPanel.panels.get(profileId);
    if (existing) {
      // 同一连接只留一个 shell：重复打开时更新连接信息并前置，而不是再开一个窗
      existing.host = host;
      existing.panel.title = title(host);
      existing.panel.reveal(vscode.ViewColumn.Beside, true);
      existing.post({ type: 'host', host: hostPayload(host) });
      return existing;
    }

    const panel = vscode.window.createWebviewPanel('dbviewer.sqlShell', title(host), vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    const instance = new SqlShellPanel(panel, extensionUri, profileId, host);
    SqlShellPanel.panels.set(profileId, instance);
    return instance;
  }

  static disposeAll(): void {
    for (const instance of [...SqlShellPanel.panels.values()]) {
      instance.dispose();
    }
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly profileId: string,
    host: SqlShellHost,
  ) {
    this.host = host;
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sqlShell.js'));
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sqlShell.css'));
    panel.webview.html = buildHtml(panel.webview, scriptUri, styleUri, host);
    panel.iconPath = new vscode.ThemeIcon('terminal');
    panel.onDidDispose(() => this.cleanup(), null, this.disposables);
    panel.webview.onDidReceiveMessage((message) => this.onMessage(message), null, this.disposables);
  }

  /** 目标库等信息变化后刷新标题栏（`\c` 切库后调用）。 */
  updateHost(patch: Partial<SqlShellHost>): void {
    this.host = { ...this.host, ...patch };
    this.panel.title = title(this.host);
    this.post({ type: 'host', host: hostPayload(this.host) });
  }

  dispose(): void {
    this.cleanup();
    this.panel.dispose();
  }

  // ---------------------------------------------------------------- 内部

  private cleanup(): void {
    // panel.dispose() 也会触发 onDidDispose，这里必须幂等
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    SqlShellPanel.panels.delete(this.profileId);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.host.onDispose?.();
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(message: { type?: string; [key: string]: unknown }): Promise<void> {
    switch (message?.type) {
      case 'ready':
        // Webview 被隐藏后重建时回放输出缓冲，历史不丢
        this.post({ type: 'hydrate', host: hostPayload(this.host), entries: this.entries });
        break;
      case 'submit':
        await this.handleSubmit(String(message.sql ?? ''));
        break;
      case 'clear':
        this.entries.length = 0;
        this.post({ type: 'cleared' });
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(String(message.text ?? ''));
        break;
      default:
        break;
    }
  }

  private async handleSubmit(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) {
      return;
    }
    if (/^(exit|quit)$/i.test(text)) {
      this.dispose();
      return;
    }
    const meta = /^\\([a-zA-Z?]+)\s*([\s\S]*)$/.exec(text);
    if (meta) {
      await this.runMetaCommand(meta[1].toLowerCase(), meta[2].trim(), text);
      return;
    }
    const entry = this.startEntry(text);
    this.settle(entry, await this.host.execute(text));
  }

  /**
   * 元命令：以 `\` 开头，全部在扩展侧完成。
   *
   * 它们本质是「快捷方式」而不是 SQL——交给驱动执行只会得到语法错误。
   */
  private async runMetaCommand(name: string, argument: string, raw: string): Promise<void> {
    switch (name) {
      case 'q':
      case 'quit':
        this.dispose();
        return;
      case 'clear':
        this.entries.length = 0;
        this.post({ type: 'cleared' });
        return;
      case '?':
      case 'help':
        this.pushNotice(raw, this.host.metaHelp);
        return;
      case 'l':
        await this.withEntry(raw, async () => {
          const names = await this.host.listDatabases();
          return names.length ? names.map((n) => `  ${n}`).join('\n') : '(没有可见的数据库)';
        });
        return;
      case 'dt':
      case 'd':
        await this.withEntry(raw, async () => {
          const names = await this.host.listTables();
          return names.length ? names.map((n) => `  ${n}`).join('\n') : '(当前库没有数据表)';
        });
        return;
      case 'c':
        if (!argument) {
          this.pushNotice(raw, '用法：\\c <数据库名>');
          return;
        }
        await this.withEntry(raw, () => this.host.switchDatabase(argument));
        return;
      default:
        this.pushNotice(raw, `未知命令 \\${name}，输入 \\? 查看可用命令。`);
    }
  }

  /** 元命令统一包一层：成功当普通输出、失败当错误，都不需要动输出缓冲结构。 */
  private async withEntry(raw: string, task: () => Promise<string>): Promise<void> {
    const entry = this.startEntry(raw);
    try {
      entry.status = 'notice';
      entry.message = await task();
    } catch (err) {
      entry.status = 'error';
      entry.message = (err as Error).message;
    }
    this.post({ type: 'entry', entry });
  }

  private pushNotice(sql: string, message: string): void {
    const entry = this.startEntry(sql);
    entry.status = 'notice';
    entry.message = message;
    this.post({ type: 'entry', entry });
  }

  private startEntry(sql: string): ShellEntry {
    const entry: ShellEntry = { id: this.nextId++, at: Date.now(), sql, status: 'running' };
    this.entries.push(entry);
    this.post({ type: 'entry', entry });
    return entry;
  }

  private settle(entry: ShellEntry, outcome: ShellExecutionOutcome): void {
    if (outcome.status === 'ok') {
      entry.status = 'ok';
      entry.durationMs = outcome.result.durationMs;
      entry.truncated = outcome.result.truncated || outcome.result.sets.some((s) => s.rows.length > MAX_SHELL_ROWS);
      entry.sets = outcome.result.sets.map(projectSet);
    } else if (outcome.status === 'cancelled') {
      entry.status = 'notice';
      entry.message = '已取消执行';
    } else {
      entry.status = 'error';
      entry.message = outcome.message;
      entry.hints = outcome.hints;
    }
    this.post({ type: 'entry', entry });
  }
}

function projectSet(set: ResultSet): ShellResultSet {
  const rows = set.rows.slice(0, MAX_SHELL_ROWS);
  return {
    statement: set.statement,
    sql: set.sql,
    fields: set.fields,
    rows: rows.map((row) => set.fields.map((field) => row[field] ?? null)),
    rowCount: set.rowCount,
    affectedRows: set.affectedRows,
    notices: set.notices ?? [],
  };
}

function title(host: SqlShellHost): string {
  return `SQL Shell · ${host.connectionName}`;
}

function hostPayload(host: SqlShellHost): Record<string, unknown> {
  return {
    connectionName: host.connectionName,
    driverName: host.driverName,
    target: host.target,
    environment: host.environment,
    database: host.database ?? '',
    // 帮助文案随连接一起推给前端：前端不硬编码命令列表，扩展侧改一处即可
    metaHelp: host.metaHelp,
  };
}

function buildHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  styleUri: vscode.Uri,
  host: SqlShellHost,
): string {
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');

  // 引导数据内嵌：面板首次渲染就要显示连接信息，绕一圈 API 只会多一次闪烁
  const bootstrap = JSON.stringify({ host: hostPayload(host) }).replace(/<\/script/gi, '<\\/script');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>SQL Shell</title>
</head>
<body>
  <header class="toolbar">
    <span id="connName" class="conn">—</span>
    <span id="connTarget" class="stats"></span>
    <span class="grow"></span>
    <span id="envInfo" class="stats"></span>
    <button id="helpBtn" type="button" class="ghost" title="查看元命令">\\?</button>
    <button id="clearBtn" type="button" title="清空输出区">清空</button>
  </header>
  <main id="output" class="output">
    <div id="welcome" class="welcome"></div>
  </main>
  <footer class="input-area">
    <span class="prompt">sql&gt;</span>
    <textarea id="input" rows="2" spellcheck="false" autocomplete="off"
      placeholder="输入 SQL，Enter 或 Ctrl+Enter 执行，Shift+Enter 换行；\\? 查看命令"></textarea>
    <button id="runBtn" type="button" class="primary">执行</button>
  </footer>
  <div id="toast" class="toast"></div>
  <script type="application/json" id="bootstrap">${bootstrap}</script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
