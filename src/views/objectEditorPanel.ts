/**
 * 对象属性 / 表结构编辑器（Webview）。
 *
 * 用同一个面板承载两类编辑，因为它们的交互骨架完全一样：「读一次现状 → 改 →
 * 生成 SQL 预览 → 应用」，差别只在表结构多一张列定义表格，而表格的字段也全部由
 * 驱动声明（`EditableProperty` / `TableColumnDefinition`），前端不认识任何数据库。
 *
 * 与结果面板的单元格编辑同一条安全边界：**改动的判定与 SQL 的生成都在扩展侧**。
 * Webview 只回传「目标状态长什么样」，扩展侧自己重读现状、自己算差异，因此
 * Webview 里的任何状态漂移都不可能变成一条打错表的 DDL。
 */

import * as vscode from 'vscode';

import {
  ColumnDefaultEditor,
  ColumnOnUpdateEditor,
  ColumnTypeEditor,
  EditorColumnTarget,
  TypeOption,
} from '../core/columnSpecs';
import { EditableProperty, ObjectChangePlan, ObjectChangeResult, TableColumnDefinition } from '../core/types';

export type ObjectEditorMode = 'table' | 'database';

/**
 * 面板看到的列定义：在列定义之上挂「结构化的编辑描述」。
 *
 * 描述由扩展侧的纯函数（`core/columnSpecs.ts`）算好下发，Webview 只负责渲染控件、
 * 回传目标状态 —— 类型文本与子句的拼装不落在 JS 里，避免同一份规则两处实现。
 */
export interface ColumnEditorView extends TableColumnDefinition {
  typeEditor: ColumnTypeEditor;
  defaultEditor: ColumnDefaultEditor;
  onUpdate: ColumnOnUpdateEditor;
}

/**
 * 面板模型。
 *
 * 命令层把驱动的输出（`TableStructure` / `DatabaseProperties`）与连接信息组装成它，
 * Webview 拿到后只做渲染；`mode` 决定要不要画列定义表格。
 */
export interface ObjectEditorModel {
  mode: ObjectEditorMode;
  /** 对象显示名（库.表 / 库名），同时作为面板标签。 */
  title: string;
  /** 对象类别文案：数据表 / 数据库 / Schema。 */
  objectLabel: string;
  /** 「连接名 · 驱动名」，多个编辑器窗口并存时用来分辨对象来源。 */
  connectionLabel: string;
  properties: EditableProperty[];
  /** 仅表结构模式：列定义，顺序即目标列序。 */
  columns?: ColumnEditorView[];
  /** 数据类型候选（下拉选项，已归纳成基础类型 + 参数形态）。 */
  typeOptions?: TypeOption[];
  allowReorder: boolean;
  allowAutoIncrement: boolean;
  /** 是否提供 `ON UPDATE CURRENT_TIMESTAMP` 开关。 */
  allowAutoUpdate?: boolean;
  /** 界面无法提供的编辑能力及原因，直接展示。 */
  limitations: string[];
  /** 驱动给出的建表语句，供核对。 */
  ddl?: string;
  /** 只读连接：可以看结构，但不能提交。 */
  readOnly: boolean;
}

/** Webview 回传的编辑结果。 */
export interface ObjectEditorChange {
  /** 属性目标值，键同模型 `properties[].key`。 */
  properties: Record<string, string>;
  /** 目标列定义（表结构模式）；只有被改过的部分才带结构化目标。 */
  columns?: EditorColumnTarget[];
}

/** 面板与扩展侧之间的契约，由命令层实现。 */
export interface ObjectEditorHost {
  /** 重新读取对象现状；应用成功后也会再读一次，避免面板停留在旧状态。 */
  load(): Promise<ObjectEditorModel>;
  /** 生成变更语句但不执行，用于「生成 SQL」预览。 */
  plan(change: ObjectEditorChange): Promise<ObjectChangePlan>;
  /** 应用变更；用户取消（例如危险变更确认框点了取消）时返回 undefined。 */
  apply(change: ObjectEditorChange): Promise<ObjectChangeResult | undefined>;
}

interface IncomingMessage {
  type: string;
  [key: string]: unknown;
}

export class ObjectEditorPanel {
  /**
   * 同一时刻只保留一个编辑器。
   *
   * 结构编辑是有状态的长任务（改到一半的列定义只存在于面板里），两个对象同时开着
   * 会让「刚才那份改动到底属于谁」变得含糊；连接表单从早期版本起就是同样的取舍。
   */
  private static current: ObjectEditorPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private model: ObjectEditorModel;
  private disposed = false;

  static get instance(): ObjectEditorPanel | undefined {
    return ObjectEditorPanel.current;
  }

  static open(
    extensionUri: vscode.Uri,
    host: ObjectEditorHost,
    model: ObjectEditorModel,
    options: { icon?: string } = {},
  ): ObjectEditorPanel {
    ObjectEditorPanel.current?.dispose();

    const panel = vscode.window.createWebviewPanel('dbviewer.objectEditor', model.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    const instance = new ObjectEditorPanel(panel, extensionUri, host, model, options);
    ObjectEditorPanel.current = instance;
    return instance;
  }

  /** 释放全部编辑器（插件停用时调用）。 */
  static disposeAll(): void {
    ObjectEditorPanel.current?.dispose();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly host: ObjectEditorHost,
    model: ObjectEditorModel,
    options: { icon?: string },
  ) {
    this.panel = panel;
    this.model = model;
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'objectEditor.js'));
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'objectEditor.css'));
    this.panel.webview.html = this.buildHtml(panel.webview, scriptUri, styleUri);
    if (options.icon) {
      this.panel.iconPath = new vscode.ThemeIcon(options.icon);
    }

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // 不要把 Promise void 掉：测试要能 await 到处理结束（约定见 MEMORY 第 11 条）
    this.panel.webview.onDidReceiveMessage((message: IncomingMessage) => this.onMessage(message), null, this.disposables);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (ObjectEditorPanel.current === this) {
      ObjectEditorPanel.current = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.panel.dispose();
  }

  private async onMessage(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case 'ready': {
        // 面板创建时已经带着模型（避免先空一屏再闪出来），这里只作确认回执
        this.post({ type: 'model', model: this.model });
        break;
      }
      case 'preview':
      case 'apply': {
        await this.handleChange(message, message.type === 'apply' ? 'apply' : 'plan');
        break;
      }
      case 'reload': {
        await this.reload();
        break;
      }
      case 'cancel': {
        this.dispose();
        break;
      }
      default:
        break;
    }
  }

  private async handleChange(message: IncomingMessage, action: 'plan' | 'apply'): Promise<void> {
    const change = message.change as ObjectEditorChange;
    this.post({ type: 'busy', busy: true });
    try {
      if (action === 'plan') {
        const plan = await this.host.plan(change);
        this.post({ type: 'plan', plan });
        return;
      }
      const result = await this.host.apply(change);
      if (!result) {
        this.post({ type: 'notice', message: '已取消，未做任何修改' });
        return;
      }
      // 先刷新模型：改列顺序、重命名这类操作会让面板上的旧状态全部失效
      await this.reload();
      this.post({ type: 'applied', result });
    } catch (err) {
      this.post({ type: 'error', message: (err as Error)?.message ?? String(err) });
    } finally {
      this.post({ type: 'busy', busy: false });
    }
  }

  private async reload(): Promise<void> {
    try {
      this.model = await this.host.load();
      this.panel.title = this.model.title;
      this.post({ type: 'model', model: this.model });
    } catch (err) {
      this.post({ type: 'error', message: `重新读取对象失败：${(err as Error)?.message ?? String(err)}` });
    }
  }

  private post(message: unknown): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  private buildHtml(webview: vscode.Webview, scriptUri: vscode.Uri, styleUri: vscode.Uri): string {
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');

    const model = this.model;
    const isTable = model.mode === 'table';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>${escapeHtml(model.title)}</title>
</head>
<body>
  <script type="application/json" id="bootstrap">${escapeJsonForScript(JSON.stringify(model))}</script>

  <header class="page-head">
    <h1 id="objectTitle">${escapeHtml(model.title)}</h1>
    <p class="env"><span id="objectLabel">${escapeHtml(model.objectLabel)}</span> · <span id="objectSource">${escapeHtml(
      model.connectionLabel,
    )}</span></p>
  </header>

  <div id="readOnlyBanner" class="banner warn" ${model.readOnly ? '' : 'hidden'}>
    当前连接勾选了「只读模式」，可以查看结构但不能提交任何变更。
  </div>

  <main>
    <details id="limitsCard" class="card limits" ${model.limitations.length ? '' : 'hidden'}>
      <summary>这个对象的编辑限制（${model.limitations.length}）</summary>
      <ul id="limits"></ul>
    </details>

    <section class="card">
      <h2>对象属性</h2>
      <div class="grid" id="properties"></div>
    </section>

    <section class="card" id="columnsCard" ${isTable ? '' : 'hidden'}>
      <div class="card-head">
        <h2>列定义</h2>
        <button type="button" class="secondary" id="addColumn">新增列</button>
      </div>
      <p class="hint" id="columnsHint">
        类型用下拉与参数框填写；无法用控件表达的类型会退回「原始文本」。默认值请选语义：常量只填值，表达式直接写 SQL 片段。
      </p>
      <div class="columns-wrap">
        <table class="columns">
          <thead>
            <tr>
              <th class="col-order">#</th>
              <th class="col-name">列名</th>
              <th class="col-type">数据类型</th>
              <th class="col-flag">可空</th>
              <th class="col-default">默认值</th>
              <th class="col-flag">主键</th>
              <th class="col-flag" id="autoIncHead">自增</th>
              <th class="col-comment">注释</th>
              <th class="col-actions"></th>
            </tr>
          </thead>
          <tbody id="columns"></tbody>
        </table>
      </div>
    </section>

    <details class="card" id="sqlCard">
      <summary>将要执行的语句 <span class="changes" id="changes"></span></summary>
      <pre class="sql-preview" id="sqlPreview">（点「生成 SQL」预览将要下发的语句）</pre>
      <ul class="warnings" id="warnings" hidden></ul>
    </details>

    <details class="card" id="ddlCard" ${model.ddl ? '' : 'hidden'}>
      <summary>当前建表语句（只读，供核对）</summary>
      <pre class="sql-preview" id="ddl">${escapeHtml(model.ddl ?? '')}</pre>
    </details>

    <div class="result-box" id="resultBox" hidden></div>
  </main>

  <footer class="page-foot">
    <span class="hint" id="footHint">改完先「生成 SQL」核对，再「应用变更」。</span>
    <div class="right">
      <button type="button" class="secondary" id="reset">放弃修改</button>
      <button type="button" class="secondary" id="preview">生成 SQL</button>
      <button type="button" class="primary emphasis" id="apply">应用变更</button>
    </div>
  </footer>

  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/**
 * 把 JSON 转义成可安全内嵌于 `<script type="application/json">` 的形式。
 * 只需处理 `</script` 与 HTML 注释起始序列，避免提前闭合脚本块。
 */
function escapeJsonForScript(json: string): string {
  return json.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\u0021--');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
