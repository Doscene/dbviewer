/**
 * 数据库与用户管理表单（Webview）。
 *
 * 集中处理两类管理操作：
 * - 创建数据库（MySQL / PG 的字符集语义不同，由驱动层消化）；
 * - 创建用户并授权（权限粒度随数据库方言变化）。
 *
 * 与连接表单一致：扩展侧持有校验与执行逻辑，Webview 只负责渲染与收集。
 */

import * as vscode from 'vscode';

export type ManagementMode = 'createDatabase' | 'createUser';

export interface GrantFormValue {
  target: string;
  table: string;
  privileges: string;
}

export interface ManagementFormValues {
  /** 创建数据库模式。 */
  dbName: string;
  charset: string;
  collation: string;
  /** 创建用户模式。 */
  username: string;
  password: string;
  host: string;
  grants: GrantFormValue[];
}

export interface ManagementFormHost {
  mode: ManagementMode;
  driverId: string;
  driverName: string;
  /** 候选目标（MySQL 为数据库，PG 为 schema）。 */
  targets: string[];
  submit(values: ManagementFormValues): Promise<void>;
}

interface IncomingMessage {
  type: string;
  [key: string]: unknown;
}

export class ManagementFormPanel {
  private static current: ManagementFormPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  static get instance(): ManagementFormPanel | undefined {
    return ManagementFormPanel.current;
  }

  static open(extensionUri: vscode.Uri, host: ManagementFormHost): ManagementFormPanel {
    ManagementFormPanel.current?.dispose();

    const title = host.mode === 'createDatabase' ? '创建数据库' : '创建用户并授权';
    const panel = vscode.window.createWebviewPanel('dbviewer.managementForm', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    const instance = new ManagementFormPanel(panel, extensionUri, host);
    ManagementFormPanel.current = instance;
    return instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly host: ManagementFormHost,
  ) {
    this.panel = panel;
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'managementForm.js'));
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'managementForm.css'));
    this.panel.webview.html = this.buildHtml(panel.webview, scriptUri, styleUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: IncomingMessage) => this.onMessage(message),
      null,
      this.disposables,
    );
    this.panel.iconPath = new vscode.ThemeIcon(host.mode === 'createDatabase' ? 'database' : 'person-add');
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (ManagementFormPanel.current === this) {
      ManagementFormPanel.current = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.panel.dispose();
  }

  private async onMessage(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case 'submit': {
        const values = message.values as ManagementFormValues;
        const validation = validate(this.host.mode, values);
        if (validation) {
          this.post({ type: 'error', message: validation });
          return;
        }
        this.post({ type: 'saving' });
        try {
          await this.host.submit(values);
          this.post({ type: 'saved' });
          this.dispose();
        } catch (err) {
          this.post({ type: 'error', message: (err as Error).message });
        }
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

    const bootstrap = {
      mode: this.host.mode,
      driverId: this.host.driverId,
      driverName: this.host.driverName,
      targets: this.host.targets,
    };

    const isDb = this.host.mode === 'createDatabase';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>${isDb ? '创建数据库' : '创建用户并授权'}</title>
</head>
<body>
  <script type="application/json" id="bootstrap">${escapeJsonForScript(JSON.stringify(bootstrap))}</script>

  <header class="page-head">
    <h1>${isDb ? '创建数据库' : '创建用户并授权'}</h1>
    <p class="env">${this.host.driverName}</p>
  </header>

  <datalist id="targetOptions">
    ${bootstrap.targets.map((t) => `<option value="${escapeHtml(t)}"></option>`).join('')}
  </datalist>

  <main>
    <section id="createDatabase" class="card" ${isDb ? '' : 'hidden'}>
      <h2>数据库设置</h2>
      <div class="grid">
        <label class="field">
          <span>数据库名 <em>*</em></span>
          <input id="dbName" type="text" autocomplete="off" spellcheck="false" />
        </label>
        <label class="field">
          <span id="charsetLabel">字符集 / 编码</span>
          <input id="charset" type="text" autocomplete="off" spellcheck="false" placeholder="${isDb && this.host.driverId === 'postgresql' ? 'UTF8' : 'utf8mb4'}" />
          <small class="hint" id="charsetHint">${this.host.driverId === 'postgresql' ? 'PostgreSQL 使用 ENCODING' : 'MySQL 使用 CHARACTER SET'}</small>
        </label>
      </div>
      <div class="grid" id="collationRow">
        <label class="field">
          <span>排序规则</span>
          <input id="collation" type="text" autocomplete="off" spellcheck="false" placeholder="如 utf8mb4_unicode_ci" />
          <small class="hint">仅 MySQL 有效</small>
        </label>
      </div>
    </section>

    <section id="createUser" class="card" ${isDb ? 'hidden' : ''}>
      <h2>用户设置</h2>
      <div class="grid">
        <label class="field">
          <span>用户名 <em>*</em></span>
          <input id="username" type="text" autocomplete="off" spellcheck="false" />
        </label>
        <label class="field">
          <span>密码 <em>*</em></span>
          <input id="password" type="password" autocomplete="new-password" />
        </label>
      </div>
      <div class="grid" id="hostRow">
        <label class="field">
          <span>主机</span>
          <input id="host" type="text" autocomplete="off" spellcheck="false" placeholder="%" />
          <small class="hint">仅 MySQL 有效；为空表示 %</small>
        </label>
      </div>

      <h2>授权</h2>
      <p class="hint">留空则不授予任何权限；创建后可用 SQL 单独授权。</p>
      <div id="grants"></div>
      <button type="button" id="addGrant" class="secondary">添加授权</button>
    </section>

    <section id="resultBox" class="result-box" hidden></section>
  </main>

  <footer class="page-foot">
    <div class="left"></div>
    <div class="right">
      <button type="button" id="cancel" class="secondary">取消</button>
      <button type="button" id="save" class="primary emphasis">创建</button>
    </div>
  </footer>

  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export function validate(mode: ManagementMode, values: ManagementFormValues): string | undefined {
  if (mode === 'createDatabase') {
    if (!values.dbName?.trim()) {
      return '数据库名不能为空';
    }
    return undefined;
  }
  if (!values.username?.trim()) {
    return '用户名不能为空';
  }
  if (!values.password) {
    return '密码不能为空';
  }
  return undefined;
}

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
