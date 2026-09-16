/**
 * 连接配置表单（Webview）。
 *
 * 设计取舍：用单页表单替代 VS Code 原生的「逐项弹窗」向导。
 * 逐项弹窗的问题在于——用户看不到已填内容、无法跳步回改、改一个字段要重走全流程，
 * 且每次弹窗都会打断输入焦点。表单可以一次性看到全部字段、驱动切换即时联动、
 * 并且能在保存前先「测试连接」。
 *
 * 通信约定：
 * - 扩展侧持有真实配置与校验逻辑，Webview 只负责渲染与收集；
 * - 数据通过 `postMessage` 双向传递，密码仅在内存中流转，落盘与否由用户勾选决定。
 */

import * as vscode from 'vscode';

import { ConnectionProfile } from '../core/types';

/** 表单收集到的原始值。 */
export interface ConnectionFormValues {
  name: string;
  driver: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  group: string;
  ssl: boolean;
  readOnly: boolean;
  /** 驱动私有参数（字符集、application_name 等）。 */
  options: Record<string, string>;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  host?: string;
  hostNote?: string;
  warning?: string;
  databases?: string[];
  detail?: string;
}

/** 面板与扩展侧之间的契约，由命令层实现。 */
export interface ConnectionFormHost {
  mode: 'create' | 'edit';
  drivers: Array<{
    id: string;
    displayName: string;
    defaultPort: number;
    description?: string;
    sampleHost?: string;
    /** 驱动图标文件名（`media/` 目录下），面板会转成 Webview 可访问的 URI。 */
    icon?: string;
  }>;
  /** 编辑模式下的现有配置（密码不回填，仅标记是否已保存）。 */
  initial?: Partial<ConnectionFormValues>;
  passwordSaved: boolean;
  /** 运行时环境信息，用于顶部提示条。 */
  contextInfo: {
    environment: string;
    aliases: Array<{ alias: string; resolved: string; note: string }>;
    tips: string[];
  };
  resolveHost(host: string): { host: string; note?: string; warning?: string };
  test(values: ConnectionFormValues): Promise<ConnectionTestResult>;
  save(values: ConnectionFormValues, passwordTouched: boolean): Promise<ConnectionProfile>;
  afterSave(profile: ConnectionProfile, connectNow: boolean): Promise<void>;
}

/** 驱动私有字段声明：新增驱动时在这里追加即可，前端会自动渲染。 */
export const DRIVER_EXTRA_FIELDS: Record<
  string,
  Array<{ key: string; label: string; placeholder?: string; hint?: string }>
> = {
  mysql: [
    { key: 'charset', label: '字符集', placeholder: 'utf8mb4', hint: '留空使用默认 utf8mb4' },
    { key: 'timezone', label: '时区', placeholder: 'local', hint: '影响 DATETIME 解析，如 +08:00' },
  ],
  postgresql: [
    {
      key: 'applicationName',
      label: 'application_name',
      placeholder: 'vscode-dbviewer',
      hint: '会出现在 pg_stat_activity 中，便于区分连接来源',
    },
  ],
};

interface IncomingMessage {
  type: string;
  [key: string]: unknown;
}

export class ConnectionFormPanel {
  private static current: ConnectionFormPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  /** 表单被取消时触发（用于测试断言）。 */
  static get instance(): ConnectionFormPanel | undefined {
    return ConnectionFormPanel.current;
  }

  /**
   * 打开表单面板。同一时刻只保留一个表单——两个连接表单同时打开没有意义，
   * 反而会让「保存后刷新树视图」的目标变得含糊。
   */
  static open(extensionUri: vscode.Uri, host: ConnectionFormHost): ConnectionFormPanel {
    ConnectionFormPanel.current?.dispose();

    const title = host.mode === 'create' ? '新建数据库连接' : '编辑数据库连接';
    const panel = vscode.window.createWebviewPanel('dbviewer.connectionForm', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    const instance = new ConnectionFormPanel(panel, extensionUri, host);
    ConnectionFormPanel.current = instance;
    return instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly host: ConnectionFormHost,
  ) {
    this.panel = panel;
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'connectionForm.js'));
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'connectionForm.css'));
    this.panel.webview.html = this.buildHtml(panel.webview, scriptUri, styleUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      // 不用 void 吞掉 Promise：把 Promise 交回给调用方，便于自动化测试等待处理完成
      (message: IncomingMessage) => this.onMessage(message),
      null,
      this.disposables,
    );
    this.panel.iconPath = new vscode.ThemeIcon('plug');
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (ConnectionFormPanel.current === this) {
      ConnectionFormPanel.current = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.panel.dispose();
  }

  // ------------------------------------------------------------------ 消息处理

  private async onMessage(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case 'resolveHost': {
        const input = String(message.host ?? '');
        const resolution = input.trim()
          ? this.host.resolveHost(input)
          : { host: '', note: undefined, warning: undefined };
        this.post({
          type: 'hostResolved',
          // 回传原始输入，前端据此判断该响应是否对应当前输入框内容
          input,
          resolved: resolution.host,
          note: resolution.note,
          warning: resolution.warning,
        });
        break;
      }
      case 'test': {
        const values = message.values as ConnectionFormValues;
        const validation = validate(values);
        if (validation) {
          this.post({ type: 'testResult', ok: false, message: validation });
          return;
        }
        this.post({ type: 'testing' });
        try {
          const result = await this.host.test(values);
          this.post({ type: 'testResult', ...result });
        } catch (err) {
          this.post({ type: 'testResult', ok: false, message: (err as Error).message });
        }
        break;
      }
      case 'submit': {
        const values = message.values as ConnectionFormValues;
        const validation = validate(values);
        if (validation) {
          this.post({ type: 'error', message: validation });
          return;
        }
        const connectNow = !!message.connectNow;
        const passwordTouched = !!message.passwordTouched;
        try {
          const profile = await this.host.save(values, passwordTouched);
          this.post({ type: 'saved', name: profile.name });
          // 先关闭面板再执行连接：连接的进度提示应落在编辑器窗口，而不是被面板遮挡
          this.dispose();
          await this.host.afterSave(profile, connectNow);
        } catch (err) {
          this.post({
            type: 'error',
            message: `保存失败：${(err as Error).message}`,
          });
        }
        break;
      }
      case 'cancel': {
        this.dispose();
        break;
      }
      case 'copy': {
        await vscode.env.clipboard.writeText(String(message.text ?? ''));
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

    // 引导数据走 application/json 脚本块：既是合法 JSON 又不触发 CSP 的脚本限制
    const bootstrap = {
      mode: this.host.mode,
      drivers: this.host.drivers.map((driver) => ({
        ...driver,
        // 图标需要转成 Webview 能加载的 URI；没有图标的驱动前端自动隐藏图标位
        iconUri: driver.icon
          ? webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', driver.icon)).toString()
          : null,
      })),
      initial: this.host.initial ?? null,
      passwordSaved: this.host.passwordSaved,
      contextInfo: this.host.contextInfo,
      extraFields: DRIVER_EXTRA_FIELDS,
    };

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>${this.host.mode === 'create' ? '新建数据库连接' : '编辑数据库连接'}</title>
</head>
<body>
  <script type="application/json" id="bootstrap">${escapeJsonForScript(JSON.stringify(bootstrap))}</script>

  <header class="page-head">
    <h1>${this.host.mode === 'create' ? '新建数据库连接' : '编辑数据库连接'}</h1>
    <p class="env" id="envLine"></p>
  </header>

  <main>
    <section class="card">
      <h2>基本信息</h2>
      <div class="grid">
        <label class="field">
          <span>连接名称 <em>*</em></span>
          <input id="name" type="text" autocomplete="off" placeholder="例如：本地开发库" />
        </label>
        <label class="field">
          <span>数据库类型 <em>*</em></span>
          <span class="driver-pick">
            <img id="driverIcon" class="driver-icon" alt="" hidden />
            <select id="driver"></select>
          </span>
          <small id="driverDesc" class="hint"></small>
        </label>
      </div>
      <div class="grid">
        <label class="field">
          <span>主机 <em>*</em></span>
          <input id="host" type="text" autocomplete="off" spellcheck="false" placeholder="127.0.0.1" />
          <small id="hostFeedback" class="hint"></small>
        </label>
        <label class="field narrow">
          <span>端口 <em>*</em></span>
          <input id="port" type="number" min="1" max="65535" />
        </label>
      </div>
      <div class="alias-bar" id="aliasBar">
        <span class="alias-label">可用别名：</span>
      </div>
    </section>

    <section class="card">
      <h2>认证</h2>
      <div class="grid">
        <label class="field">
          <span>用户名 <em>*</em></span>
          <input id="user" type="text" autocomplete="off" spellcheck="false" />
        </label>
        <label class="field">
          <span>密码</span>
          <span class="password-wrap">
            <input id="password" type="password" autocomplete="new-password" />
            <button type="button" id="togglePassword" class="ghost" title="显示 / 隐藏密码">显示</button>
          </span>
          <small id="passwordHint" class="hint"></small>
        </label>
      </div>
      <p class="secure-note">密码保存在操作系统凭据存储中（Windows DPAPI / Linux libsecret），不会写入配置文件。</p>
    </section>

    <section class="card">
      <h2>目标数据库与分组</h2>
      <div class="grid">
        <label class="field">
          <span>默认数据库</span>
          <input id="database" type="text" list="databaseOptions" autocomplete="off" spellcheck="false" placeholder="可留空" />
          <datalist id="databaseOptions"></datalist>
          <small class="hint" id="databaseHint">测试连接成功后，这里会出现候选列表</small>
        </label>
        <label class="field">
          <span>分组</span>
          <input id="group" type="text" autocomplete="off" placeholder="用于在连接树中归类，可留空" />
        </label>
      </div>
    </section>

    <section class="card">
      <h2>高级选项</h2>
      <div id="extraFields" class="grid"></div>
      <div class="checks">
        <label class="check">
          <input id="ssl" type="checkbox" />
          <span>启用 SSL/TLS</span>
          <small>云数据库通常需要；当前实现跳过证书校验</small>
        </label>
        <label class="check">
          <input id="readOnly" type="checkbox" />
          <span>只读模式</span>
          <small>拦截 INSERT / UPDATE / DELETE / DDL</small>
        </label>
      </div>
    </section>

    <section id="resultBox" class="result-box" hidden></section>
  </main>

  <footer class="page-foot">
    <div class="left">
      <button type="button" id="test" class="secondary">测试连接</button>
    </div>
    <div class="right">
      <button type="button" id="cancel" class="secondary">取消</button>
      <button type="button" id="save" class="primary">保存</button>
      <button type="button" id="saveAndConnect" class="primary emphasis">保存并连接</button>
    </div>
  </footer>

  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** 表单基础校验（扩展侧兜底，前端也会先校验一遍）。 */
export function validate(values: ConnectionFormValues): string | undefined {
  if (!values.name?.trim()) {
    return '连接名称不能为空';
  }
  if (!values.host?.trim()) {
    return '主机不能为空';
  }
  if (!Number.isInteger(values.port) || values.port <= 0 || values.port > 65535) {
    return '端口需为 1-65535 的整数';
  }
  if (!values.user?.trim()) {
    return '用户名不能为空';
  }
  return undefined;
}

/**
 * 把 JSON 转义成可安全内嵌于 `<script type="application/json">` 的形式。
 * 只需处理 `</script` 与 HTML 注释起始序列，避免提前闭合脚本块。
 */
function escapeJsonForScript(json: string): string {
  return json.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\u0021--');
}
