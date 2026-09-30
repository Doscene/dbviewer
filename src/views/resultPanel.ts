/**
 * 查询结果面板（Webview）。
 *
 * 采用「扩展侧持有数据、Webview 只做渲染」的结构：
 * 结果集先留在扩展宿主内，仅在需要时按批次推给 Webview，
 * 避免把几十万行数据一次性塞进 HTML 造成渲染卡死。
 *
 * 单元格编辑同样遵循这条边界：Webview 只回传「第几行第几列改成了什么」，
 * 行定位（主键值）由扩展侧从自己持有的原始结果里取——Webview 里的排序、
 * 分页都可能让下标漂移，信任它等于把 UPDATE 打到错误的行上。
 *
 * 面板本身按「复用键」持有多个实例（键由调用方给出，表数据预览按「连接 + 库 / schema + 表」
 * 生成）：一张表一个窗口，各自持有自己的结果集，互不覆盖。SQL 编辑器的临时查询用缺省键，
 * 仍旧共用一个「查询结果」窗口。
 */

import * as vscode from 'vscode';

import { EditTarget } from '../core/editTarget';
import { ExportFormat, serializeResult } from '../core/exporters';
import { CellUpdateResult, QueryResult } from '../core/types';

export interface ResultContext {
  connectionName: string;
  /** 目标库 / schema，用于标题展示。 */
  target?: string;
  /** 可编辑目标；缺省表示当前结果只读。 */
  edit?: EditTarget;
  /** 提交单元格修改。由命令层注入，内部走 ConnectionManager.updateCell。 */
  applyEdit?: (params: {
    identity: Record<string, unknown>;
    changes: Record<string, unknown>;
  }) => Promise<CellUpdateResult>;
  /**
   * 执行面板里编辑过的 SQL。
   *
   * 由命令层注入而非面板自己发起：连接选择、危险语句确认、错误提示这一整套
   * 逻辑都住在 `commands/index.ts`，绕开它等于把安全网拆掉。
   */
  executeSql?: (sql: string) => Promise<void>;
}

export type { ExportFormat };

const EXPORT_FORMATS: ExportFormat[] = ['csv', 'json', 'jsonl', 'xlsx'];

export interface ResultPanelOptions {
  /** 复用键：同键复用同一个窗口。缺省为通用的「查询结果」面板。 */
  key?: string;
  /** 窗口标签标题（同时作为 Webview 的 `<title>`）。缺省「查询结果」。 */
  title?: string;
  viewColumn?: vscode.ViewColumn;
  /** 批量开窗时置 true：新窗口不抢焦点，避免每开一个窗口都把用户视线扯走一次。 */
  preserveFocus?: boolean;
}

export class ResultPanel {
  /** 按复用键持有实例：不同表 / 不同连接各占一个窗口，结果互不覆盖。 */
  private static readonly panels = new Map<string, ResultPanel>();
  /** 缺省键：SQL 编辑器里的临时查询共用一个窗口，行为与本特性之前一致。 */
  private static readonly DEFAULT_KEY = 'query-result';

  /**
   * 最近获得焦点的面板。
   *
   * 导出 / 清空这两条命令面板入口没有编辑器上下文，只能作用于「用户当前在看的那一个」；
   * 跟踪焦点状态由 `onDidChangeViewState` 驱动，取不到时退回最近一次显示的窗口。
   */
  private static focused: ResultPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly key: string;
  private disposed = false;
  private result?: QueryResult;
  private context: ResultContext = { connectionName: '' };
  /** 当前激活的结果集下标，由 Webview 回传，用于导出对应结果。 */
  private activeSetIndex = 0;
  /** 最近一次单元格编辑生成的 SQL，回传 Webview 展示，便于用户核对改了什么。 */
  private lastEditSql?: string;

  static show(extensionUri: vscode.Uri, options: ResultPanelOptions = {}): ResultPanel {
    const key = options.key ?? ResultPanel.DEFAULT_KEY;
    const title = options.title ?? '查询结果';
    const viewColumn = options.viewColumn ?? vscode.ViewColumn.Beside;

    const existing = ResultPanel.panels.get(key);
    if (existing) {
      // 同一张表再次「查看数据」= 刷新已有窗口，而不是再开一个重名的
      existing.setTitle(title);
      existing.panel.reveal(viewColumn, !options.preserveFocus);
      if (!options.preserveFocus) {
        ResultPanel.focused = existing;
      }
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      'dbviewer.result',
      title,
      options.preserveFocus ? { viewColumn, preserveFocus: true } : viewColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    const instance = new ResultPanel(panel, extensionUri, key, title);
    ResultPanel.panels.set(key, instance);
    if (!options.preserveFocus) {
      ResultPanel.focused = instance;
    }
    return instance;
  }

  static get instance(): ResultPanel | undefined {
    return ResultPanel.focused ?? ResultPanel.panels.values().next().value;
  }

  /** 释放全部面板（插件停用时调用）。 */
  static disposeAll(): void {
    for (const instance of [...ResultPanel.panels.values()]) {
      instance.dispose();
    }
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    key: string,
    title: string,
  ) {
    this.panel = panel;
    this.key = key;
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'result.js'));
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'result.css'));
    panel.title = title;
    panel.webview.html = buildHtml(panel.webview, scriptUri, styleUri, title);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.active) {
          ResultPanel.focused = this;
        }
      },
      null,
      this.disposables,
    );
    this.panel.webview.onDidReceiveMessage(
      (message: { type: string; [key: string]: unknown }) => this.onMessage(message),
      null,
      this.disposables,
    );
    this.panel.iconPath = new vscode.ThemeIcon('table');
    // 首个窗口没有焦点事件也要能被 instance 取到（命令面板入口的兜底）
    if (!ResultPanel.focused) {
      ResultPanel.focused = this;
    }
  }

  /** 展示新的查询结果。 */
  update(result: QueryResult, context: ResultContext): void {
    this.result = result;
    this.context = context;
    this.lastEditSql = undefined;
    this.post(this.buildPayload());
  }

  /** 展示错误信息（复用结果面板，避免另开一个只读文档）。 */
  showError(message: string, sql?: string): void {
    this.post({ type: 'error', message, sql });
  }

  /** 追加一个执行中的占位提示。 */
  showRunning(sql: string): void {
    this.post({ type: 'running', sql });
  }

  /** 清空面板内容。 */
  async clear(): Promise<void> {
    this.result = undefined;
    this.activeSetIndex = 0;
    this.lastEditSql = undefined;
    this.post({ type: 'clear' });
  }

  /** 导出当前激活的结果集（供命令面板 / 外部命令调用）。 */
  async exportActive(format: ExportFormat): Promise<void> {
    await this.exportResult(this.activeSetIndex, format);
  }

  /** 更新窗口标签（表数据预览每次「查看数据」都按命名空间重算，避免标题过期）。 */
  setTitle(title: string): void {
    this.panel.title = title;
  }

  /**
   * 关闭面板。
   *
   * 同步从注册表注销（而不是等 `onDidDispose` 回调）：关闭后同一张表要能马上重新开窗，
   * 依赖异步回调会留下「刚关掉又点一次，窗口没出来」的空档，测试里也无从等待。
   * 幂等：`onDidDispose` 触发的第二次调用直接返回。
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    ResultPanel.panels.delete(this.key);
    if (ResultPanel.focused === this) {
      ResultPanel.focused = ResultPanel.panels.values().next().value;
    }
    this.panel.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private buildPayload(): Record<string, unknown> {
    const result = this.result;
    if (!result) {
      return { type: 'clear' };
    }
    return {
      type: 'result',
      connectionName: this.context.connectionName,
      target: this.context.target,
      durationMs: result.durationMs,
      truncated: result.truncated,
      editable: !!(this.context.edit && this.context.applyEdit),
      canExecute: !!this.context.executeSql,
      sql: result.sql,
      // 带上最近一次编辑的 SQL：面板重载（Webview 被销毁重建）后仍能看到改了什么
      lastEditSql: this.lastEditSql ?? '',
      sets: result.sets.map((set) => ({
        statement: set.statement,
        sql: set.sql,
        fields: set.fields,
        // 行以数组传递：相比对象数组，序列化体积可减少一半以上
        rows: set.rows.map((row) => set.fields.map((field) => row[field] ?? null)),
        rowCount: set.rowCount,
        affectedRows: set.affectedRows,
        notices: set.notices ?? [],
      })),
    };
  }

  private async onMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
    switch (message.type) {
      case 'ready': {
        // Webview 首次加载完成，回放当前结果（buildPayload 在没有结果时返回 clear）
        this.post(this.buildPayload());
        break;
      }
      case 'export': {
        const format = EXPORT_FORMATS.includes(message.format as ExportFormat)
          ? (message.format as ExportFormat)
          : 'csv';
        await this.exportResult(Number(message.setIndex ?? 0), format);
        break;
      }
      case 'updateCell': {
        await this.handleCellEdit(message);
        break;
      }
      case 'applyEdits': {
        await this.handleCellEdits(message);
        break;
      }
      case 'execute': {
        await this.handleExecute(message);
        break;
      }
      case 'activeSet': {
        this.activeSetIndex = Number(message.index ?? 0) || 0;
        break;
      }
      case 'copy': {
        await vscode.env.clipboard.writeText(String(message.text ?? ''));
        break;
      }
      case 'revealError': {
        await vscode.window.showErrorMessage(String(message.message ?? '执行失败'));
        break;
      }
      default:
        break;
    }
  }

  /**
   * 处理单个单元格编辑（兼容旧前端的即时提交路径）。
   *
   * 关键点：Webview 传回的是**原始行下标**（前端排序只换显示顺序，不改数组），
   * 因此可以直接用它从扩展侧持有的结果里取主键值，构造可靠的 WHERE。
   */
  private async handleCellEdit(message: { [key: string]: unknown }): Promise<void> {
    const setIndex = Number(message.setIndex ?? 0) || 0;
    const rowIndex = Number(message.rowIndex ?? -1);
    const column = String(message.column ?? '');
    const outcome = await this.applyCellEdit(setIndex, rowIndex, column, message);
    if ('error' in outcome) {
      this.post({ type: 'cellEditFailed', setIndex, rowIndex, column, reason: outcome.error });
      return;
    }
    this.post({
      type: 'cellUpdated',
      setIndex,
      rowIndex,
      column,
      value: outcome.value,
      affectedRows: outcome.affectedRows,
      sql: outcome.sql,
    });
  }

  /**
   * 批量提交单元格编辑。
   *
   * 面板改成了「先攒着、点确认再落库」，所以这里是主路径。逐条提交而不是拼成
   * 一条大 UPDATE：不同单元格可能落在不同行，拼 SQL 就回到了通用层拼装 FROM 的
   * 老问题；逐条失败也只影响那一格，其余照常生效。
   */
  private async handleCellEdits(message: { [key: string]: unknown }): Promise<void> {
    const edits = Array.isArray(message.edits) ? (message.edits as Array<Record<string, unknown>>) : [];
    const results: Array<Record<string, unknown>> = [];
    for (const edit of edits) {
      const setIndex = Number(edit.setIndex ?? 0) || 0;
      const rowIndex = Number(edit.rowIndex ?? -1);
      const column = String(edit.column ?? '');
      const outcome = await this.applyCellEdit(setIndex, rowIndex, column, edit);
      results.push({ setIndex, rowIndex, column, ...outcome });
    }
    this.post({ type: 'cellsUpdated', results });
  }

  /** 执行面板里被改过的 SQL。 */
  private async handleExecute(message: { [key: string]: unknown }): Promise<void> {
    const sql = String(message.sql ?? '').trim();
    if (!sql) {
      this.post({ type: 'executeFailed', reason: 'SQL 为空' });
      return;
    }
    if (!this.context.executeSql) {
      this.post({ type: 'executeFailed', reason: '当前面板未绑定可执行连接' });
      return;
    }
    try {
      await this.context.executeSql(sql);
    } catch (err) {
      // 正常路径下命令层已把错误渲染进面板；这里兜住回调本身抛出的意外异常
      this.post({ type: 'executeFailed', reason: (err as Error).message });
    }
  }

  /**
   * 提交一格修改并同步扩展侧的权威副本。
   *
   * 返回 `error` 字段表示失败，调用方决定怎么回传——批量路径要保留失败格子的
   * pending 状态，单条路径要弹提示，两者对失败的处理不同，所以不在这里 post。
   */
  private async applyCellEdit(
    setIndex: number,
    rowIndex: number,
    column: string,
    message: { [key: string]: unknown },
  ): Promise<{ value?: unknown; affectedRows?: number; sql?: string; error?: string }> {
    const edit = this.context.edit;
    const apply = this.context.applyEdit;
    const set = this.result?.sets[setIndex];

    if (!edit || !apply || !set) {
      return { error: '当前结果集不支持编辑' };
    }
    const row = set.rows[rowIndex];
    if (!row || !column) {
      return { error: '定位不到要修改的行或列，请重新执行查询' };
    }
    if (!set.fields.includes(column)) {
      return { error: `结果集中不存在列「${column}」` };
    }

    const identity: Record<string, unknown> = {};
    for (const key of edit.identity) {
      identity[key] = row[key];
    }
    const changes: Record<string, unknown> = { [column]: coerceValue(row[column], message) };

    try {
      const outcome = await apply({ identity, changes });
      // 同步权威副本，后续再编辑同一行时 identity 取的才是最新值
      set.rows[rowIndex][column] = changes[column];
      this.lastEditSql = outcome.sql;
      return { value: changes[column], affectedRows: outcome.affectedRows, sql: outcome.sql };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /** 导出结果集，落盘走 VS Code 原生保存对话框。 */
  private async exportResult(setIndex: number, format: ExportFormat): Promise<void> {
    const result = this.result;
    if (!result) {
      await vscode.window.showWarningMessage('当前没有可导出的结果');
      return;
    }
    const set = result.sets[setIndex];
    if (!set) {
      await vscode.window.showWarningMessage('未找到对应的结果集');
      return;
    }

    const payload = serializeResult(
      format,
      set.fields,
      set.rows,
      `${this.context.connectionName || 'result'}_${setIndex + 1}`,
    );
    const base = `${sanitizeFileName(this.context.connectionName || 'result')}-${timestamp()}`;
    const target = await vscode.window.showSaveDialog({
      title: `导出为 ${payload.label}`,
      defaultUri: vscode.Uri.file(`${base}.${payload.extension}`),
      filters: { [payload.label]: [payload.extension] },
    });
    if (!target) {
      return;
    }

    // 文本格式显式以 UTF-8 编码；xlsx 已是二进制缓冲区，原样写入
    const bytes = typeof payload.data === 'string' ? Buffer.from(payload.data, 'utf8') : payload.data;
    try {
      await vscode.workspace.fs.writeFile(target, bytes);
      const action = await vscode.window.showInformationMessage(
        `已导出 ${set.rows.length} 行到 ${target.fsPath}`,
        '打开文件',
      );
      if (action === '打开文件') {
        await vscode.commands.executeCommand('vscode.open', target);
      }
    } catch (err) {
      await vscode.window.showErrorMessage(`导出失败：${(err as Error).message}`);
    }
  }
}

/**
 * 把 Webview 回传的文本还原成合适的 JS 值。
 *
 * 输入框里一律是字符串，但直接当字符串写回去会让 `int` 列收到 `'1'`——
 * MySQL 能隐式转换，PG 虽然在字面量场景也能转，但类型不匹配的报错对用户毫无帮助。
 * 这里按「原值类型」推断：原来是数字就试着转数字，原来是布尔就认 true/false。
 */
function coerceValue(previous: unknown, message: { [key: string]: unknown }): unknown {
  if (message.isNull) {
    return null;
  }
  const text = String(message.value ?? '');
  if (typeof previous === 'number') {
    const num = Number(text);
    if (text.trim() !== '' && Number.isFinite(num)) {
      return num;
    }
  }
  if (typeof previous === 'boolean') {
    if (/^(true|1)$/i.test(text)) {
      return true;
    }
    if (/^(false|0)$/i.test(text)) {
      return false;
    }
  }
  return text;
}

/** 连接名可能带 `/` `:` 等字符，直接拼进路径会失败。 */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'result';
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 库名 / 表名来自数据库元数据，拼进 HTML 前一律转义。 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function buildHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  styleUri: vscode.Uri,
  title: string,
): string {
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <header class="toolbar">
    <div class="meta">
      <span id="target" class="target">—</span>
      <span id="stats" class="stats"></span>
    </div>
    <div class="actions">
      <label class="pagesize">每页
        <select id="pageSize">
          <option value="50">50</option>
          <option value="100" selected>100</option>
          <option value="500">500</option>
          <option value="0">全部</option>
        </select>
      </label>
      <button id="prev" type="button" title="上一页">◀</button>
      <span id="pageinfo" class="pageinfo">-</span>
      <button id="next" type="button" title="下一页">▶</button>
      <span class="sep"></span>
      <span class="edit-group" id="editGroup" hidden>
        <button id="applyEdits" type="button" class="primary" disabled>应用修改</button>
        <button id="discardEdits" type="button" disabled>放弃</button>
      </span>
      <span class="sep" id="editSep" hidden></span>
      <button id="copyTsv" type="button" title="复制当前页为 TSV">复制</button>
      <span class="export-group">
        <span class="export-label">导出</span>
        <button id="exportCsv" type="button" title="导出为 CSV">CSV</button>
        <button id="exportJson" type="button" title="导出为 JSON">JSON</button>
        <button id="exportJsonl" type="button" title="导出为 JSON Lines（每行一个对象）">JSONL</button>
        <button id="exportXlsx" type="button" title="导出为 Excel 工作簿">Excel</button>
      </span>
    </div>
  </header>
  <nav id="tabs" class="tabs"></nav>
  <div id="notices" class="notices"></div>
  <section id="sqlBox" class="sql-box">
    <div class="sql-head">
      <button id="sqlToggle" type="button" class="ghost">▾ 执行的 SQL</button>
      <span id="sqlStats" class="stats"></span>
      <span class="grow"></span>
      <span id="sqlHint" class="stats" hidden>可修改后重新执行（Ctrl+Enter）</span>
      <button id="sqlRun" type="button" class="primary" hidden>▶ 执行</button>
      <button id="sqlReset" type="button" class="ghost" hidden>还原</button>
      <button id="sqlCopy" type="button" class="ghost" disabled>复制</button>
    </div>
    <textarea id="sqlEditor" class="sql-editor" spellcheck="false" wrap="off"></textarea>
    <div id="editLog" class="edit-log" hidden></div>
  </section>
  <main id="content" class="content">
    <div class="placeholder">执行查询后，结果将显示在此处。</div>
  </main>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}
