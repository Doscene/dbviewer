/**
 * 激活测试：在纯 Node 环境下 mock `vscode` 模块，真实调用扩展的 activate()。
 *
 * 运行：node scripts/activate-test.js
 *
 * 价值在于捕获「只有真正实例化时才会暴露」的问题：
 * - 扩展入口在加载期是否存在未定义的引用；
 * - 代码里注册的命令与 package.json 中声明的命令是否一一对应（拼写不一致是插件最常见故障）；
 * - 树视图首次渲染、环境诊断等同步路径是否会抛异常。
 */

const path = require('path');
const assert = require('assert');
const Module = require('module');
const fs = require('fs');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'out');

// ------------------------------------------------------------------ vscode mock

const registeredCommands = new Map();
const executedCommands = [];
const outputLines = [];
const treeViews = [];
/** 捕获创建过的 Webview 面板，供表单与结果面板相关断言使用。 */
const webviewPanels = [];
/** 捕获写盘调用，用于断言导出内容。 */
const writtenFiles = [];
/** 模拟保存对话框的返回值；undefined 表示用户取消。 */
let saveDialogResult;

class Disposable {
  constructor(fn) {
    this._fn = fn;
  }
  dispose() {
    if (this._fn) {
      this._fn();
    }
  }
}

class EventEmitter {
  constructor() {
    this._listeners = [];
    this.event = (listener) => {
      this._listeners.push(listener);
      return new Disposable(() => {
        this._listeners = this._listeners.filter((l) => l !== listener);
      });
    };
  }
  fire(payload) {
    for (const listener of this._listeners) {
      listener(payload);
    }
  }
  dispose() {
    this._listeners = [];
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

/**
 * 取消令牌源。
 *
 * mock 里必须提供：`withProgress` 的真实回调签名是 `(progress, token)`，备份这类
 * 长任务会在回调里注册 `token.onCancellationRequested`。少了它，相关代码会直接
 * 抛 TypeError 并被自身的 try/catch 吞掉，测试反而「通过」。
 */
class CancellationTokenSource {
  constructor() {
    const listeners = [];
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener) => {
        listeners.push(listener);
        return new Disposable(() => {
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        });
      },
    };
    this._fire = () => {
      this.token.isCancellationRequested = true;
      for (const listener of [...listeners]) {
        listener();
      }
    };
  }
  cancel() {
    this._fire();
  }
  dispose() {
    this._fire = () => undefined;
  }
}

class MarkdownString {
  constructor(value) {
    this.value = value ?? '';
  }
  appendText(v) {
    this.value += v;
    return this;
  }
}

const Uri = {
  file: (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => `file://${p}` }),
  joinPath: (base, ...parts) => Uri.file(path.join(base.fsPath ?? base.path, ...parts)),
  parse: (v) => ({ fsPath: v, toString: () => v }),
};

const workspaceConfig = {
  'dbviewer.allowExternalCommand': false,
  'dbviewer.autoResolveHost': true,
  'dbviewer.hostAliases': {},
  'dbviewer.driverHostMode': 'inProcess',
  'dbviewer.queryTimeoutMs': 60000,
  'dbviewer.connectTimeoutMs': 15000,
  'dbviewer.defaultPageSize': 200,
  'dbviewer.maxResultRows': 5000,
  'dbviewer.confirmDestructiveStatements': true,
};

const vscodeMock = {
  version: '1.90.0',
  Disposable,
  EventEmitter,
  TreeItem,
  ThemeIcon,
  ThemeColor,
  CancellationTokenSource,
  MarkdownString,
  Uri,
  Selection: class {
    constructor(a, b, c, d) {
      this.start = { line: a, character: b };
      this.end = { line: c, character: d };
      this.isEmpty = a === c && b === d;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  InputBoxValidationSeverity: { Error: 1, Warning: 2, Info: 3 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  env: {
    remoteName: undefined,
    clipboard: {
      writeText: async () => undefined,
      readText: async () => '',
    },
  },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({
      appendLine: (line) => outputLines.push(line),
      append: (line) => outputLines.push(line),
      clear: () => (outputLines.length = 0),
      show: () => undefined,
      dispose: () => undefined,
      name: 'DBViewer',
    }),
    createStatusBarItem: () => ({
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
      text: '',
      tooltip: '',
      command: '',
    }),
    createTreeView: (id, options) => {
      const view = { id, options, dispose: () => undefined };
      treeViews.push(view);
      return view;
    },
    registerTreeDataProvider: () => new Disposable(),
    onDidChangeActiveTextEditor: () => new Disposable(),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showSaveDialog: async () => saveDialogResult,
    showTextDocument: async () => ({ selection: undefined, document: undefined }),
    setStatusBarMessage: () => new Disposable(),
    withProgress: async (_options, task) =>
      task(
        { report: () => undefined },
        new CancellationTokenSource().token,
      ),
    createWebviewPanel: (viewType, title, viewColumn, options) => {
      const received = [];
      const posted = [];
      let listener;
      const panel = {
        viewType,
        title,
        options,
        iconPath: undefined,
        posted,
        received,
        webview: {
          html: '',
          cspSource: 'vscode-webview://test',
          asWebviewUri: (uri) => uri,
          postMessage: async (message) => {
            posted.push(message);
            return true;
          },
          onDidReceiveMessage: (fn) => {
            listener = fn;
            return new Disposable();
          },
        },
        onDidDispose: () => new Disposable(),
        reveal: () => undefined,
        dispose: () => undefined,
        /** 测试专用：模拟 Webview 向扩展发消息，并等待扩展侧处理完成。 */
        async send(message) {
          received.push(message);
          if (listener) {
            await listener(message);
          }
        },
      };
      webviewPanels.push(panel);
      return panel;
    },
  },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(root), name: 'dbviewer', index: 0 }],
    getConfiguration: (section) => ({
      get: (key, fallback) => {
        const full = `${section}.${key}`;
        return workspaceConfig[full] !== undefined ? workspaceConfig[full] : fallback;
      },
      update: async () => undefined,
    }),
    fs: {
      writeFile: async (uri, data) => {
        writtenFiles.push({ uri, data });
      },
    },
    openTextDocument: async (options) => ({
      uri: Uri.file(path.join(root, 'untitled.sql')),
      languageId: options?.language ?? 'sql',
      getText: () => options?.content ?? '',
      getTextRange: () => ({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }),
      lineCount: (options?.content ?? '').split('\n').length,
    }),
    onDidChangeConfiguration: () => new Disposable(),
  },
  commands: {
    registerCommand: (id, handler) => {
      if (registeredCommands.has(id)) {
        throw new Error(`命令重复注册：${id}`);
      }
      registeredCommands.set(id, handler);
      return new Disposable(() => registeredCommands.delete(id));
    },
    executeCommand: async (id, ...args) => {
      executedCommands.push({ id, args });
      const handler = registeredCommands.get(id);
      if (handler) {
        return handler(...args);
      }
      return undefined;
    },
  },
  languages: {
    registerCodeLensProvider: () => new Disposable(),
  },
};

// 拦截 require('vscode')
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return originalLoad.apply(this, arguments);
};

// ------------------------------------------------------------------ 测试执行

const failures = [];
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [OK] ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  [FAIL] ${name} -> ${err.message}`);
  }
}

function makeContext() {
  const globalState = new Map();
  const secrets = new Map();
  // 直接读真实清单：publisher / name 一旦调整，硬编码的扩展 id 会悄悄对不上
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const subscriptions = [];
  return {
    subscriptions,
    extensionPath: root,
    extensionUri: Uri.file(root),
    // 供测试直接检视落盘结果
    _globalState: globalState,
    _secrets: secrets,
    globalState: {
      get: (key, fallback) => (globalState.has(key) ? globalState.get(key) : fallback),
      update: async (key, value) => void globalState.set(key, value),
      keys: () => [...globalState.keys()],
      setKeysForSync: () => undefined,
    },
    workspaceState: {
      get: (key, fallback) => fallback,
      update: async () => undefined,
    },
    secrets: {
      get: async (key) => secrets.get(key),
      store: async (key, value) => void secrets.set(key, value),
      delete: async (key) => void secrets.delete(key),
      onDidChange: new EventEmitter().event,
    },
    environmentVariableCollection: { replace: () => undefined },
    extension: { id: `${manifest.publisher}.${manifest.name}`, packageJSON: manifest },
    asAbsolutePath: (p) => path.join(root, p),
    storageUri: Uri.file(path.join(root, '.storage')),
    globalStorageUri: Uri.file(path.join(root, '.storage')),
    logUri: Uri.file(path.join(root, '.log')),
    extensionMode: 2,
  };
}

(async function main() {
  console.log('\n=== 扩展激活测试 ===');

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declaredCommands = packageJson.contributes.commands.map((c) => c.command);

  let extension;
  await check('out/extension.js 可加载', () => {
    extension = require(path.join(outDir, 'extension.js'));
    assert.strictEqual(typeof extension.activate, 'function');
    assert.strictEqual(typeof extension.deactivate, 'function');
  });

  const context = makeContext();
  await check('activate() 无异常', () => {
    extension.activate(context);
  });

  await check('命令注册数量与实现一致', () => {
    assert.ok(registeredCommands.size > 0, '未注册任何命令');
    for (const id of declaredCommands) {
      assert.ok(registeredCommands.has(id), `package.json 声明了 ${id}，但代码未注册`);
    }
  });

  await check('无多余的未声明命令', () => {
    const extra = [...registeredCommands.keys()].filter((id) => !declaredCommands.includes(id));
    assert.deepStrictEqual(extra, [], `代码注册了未在 package.json 声明的命令：${extra.join(', ')}`);
  });

  await check('activationEvents 中的命令均已实现', () => {
    for (const event of packageJson.activationEvents) {
      if (event.startsWith('onCommand:')) {
        const id = event.slice('onCommand:'.length);
        assert.ok(registeredCommands.has(id), `activationEvents 引用了不存在的命令 ${id}`);
      }
      if (event.startsWith('onView:')) {
        const id = event.slice('onView:'.length);
        const hasView = packageJson.contributes.views.dbviewer.some((v) => v.id === id);
        assert.ok(hasView, `activationEvents 引用了不存在的视图 ${id}`);
      }
    }
  });

  await check('菜单 when 条件引用的命令均已注册', () => {
    const menus = packageJson.contributes.menus;
    for (const [location, items] of Object.entries(menus)) {
      for (const item of items) {
        assert.ok(
          registeredCommands.has(item.command) || declaredCommands.includes(item.command),
          `${location} 引用了未声明的命令 ${item.command}`,
        );
      }
    }
  });

  await check('快捷键绑定的命令均已注册', () => {
    for (const binding of packageJson.contributes.keybindings) {
      assert.ok(registeredCommands.has(binding.command), `快捷键引用了未注册命令 ${binding.command}`);
    }
  });

  await check('树视图已创建', () => {
    assert.strictEqual(treeViews.length, 1);
    assert.strictEqual(treeViews[0].id, 'dbviewer.connections');
  });

  await check('激活日志已输出且包含环境信息', () => {
    const text = outputLines.join('\n');
    assert.ok(text.includes('已激活'), '缺少激活日志');
    assert.ok(text.includes('运行环境'), '缺少环境信息');
  });

  // 逐个调用无参命令，验证不会抛异常（无连接时应优雅退出而非崩溃）
  const safeCommands = [
    'dbviewer.refresh',
    'dbviewer.showEnvironment',
    'dbviewer.showTableData',
    'dbviewer.showTableDdl',
    'dbviewer.openTableInQuery',
    'dbviewer.copyName',
    'dbviewer.connect',
    'dbviewer.disconnect',
    'dbviewer.deleteConnection',
    'dbviewer.duplicateConnection',
    'dbviewer.editConnection',
    'dbviewer.selectDatabase',
    'dbviewer.newQuery',
    'dbviewer.exportResult',
    'dbviewer.clearResult',
    'dbviewer.pickConnection',
    'dbviewer.backupTables',
    'dbviewer.backupDatabase',
  ];
  for (const id of safeCommands) {
    await check(`${id} 空参调用不抛异常`, async () => {
      const handler = registeredCommands.get(id);
      assert.ok(handler, '命令未注册');
      await handler(undefined);
    });
  }

  await check('无编辑器时 runQuery 不抛异常', async () => {
    await registeredCommands.get('dbviewer.runQuery')(undefined);
  });

  // ------------------------------------------------------------ 连接表单

  console.log('\n--- 连接表单 ---');

  webviewPanels.length = 0;
  await check('新建连接打开的是表单面板', async () => {
    await registeredCommands.get('dbviewer.addConnection')(undefined);
    assert.strictEqual(webviewPanels.length, 1, '未创建表单面板');
    assert.strictEqual(webviewPanels[0].viewType, 'dbviewer.connectionForm');
    assert.strictEqual(webviewPanels[0].title, '新建数据库连接');
  });

  const form = webviewPanels[0];
  await check('表单一次性包含全部关键字段', () => {
    const html = form.webview.html;
    const required = [
      'name',
      'driver',
      'host',
      'port',
      'user',
      'password',
      'database',
      'group',
      'ssl',
      'readOnly',
      'extraFields',
      'test',
      'save',
      'saveAndConnect',
    ];
    for (const id of required) {
      assert.ok(html.includes(`id="${id}"`), `表单缺少字段 #${id}`);
    }
  });

  await check('引导数据为合法 JSON 且含驱动与别名信息', () => {
    const matched = /<script type="application\/json" id="bootstrap">([\s\S]*?)<\/script>/.exec(form.webview.html);
    assert.ok(matched, '未找到 bootstrap 数据块');
    const data = JSON.parse(matched[1]);
    assert.strictEqual(data.mode, 'create');
    assert.ok(Array.isArray(data.drivers) && data.drivers.length >= 2, '驱动列表为空');
    assert.ok(data.drivers.some((d) => d.id === 'mysql'));
    assert.ok(data.drivers.some((d) => d.id === 'postgresql'));
    assert.strictEqual(data.contextInfo.aliases.length, 2);
    assert.ok(data.extraFields.mysql.length > 0, 'MySQL 私有字段未注入');
    assert.ok(data.extraFields.postgresql.length > 0, 'PG 私有字段未注入');
  });

  await check('主机别名实时解析并回传', async () => {
    form.posted.length = 0;
    await form.send({ type: 'resolveHost', host: '__windows_host__' });
    const reply = form.posted.find((m) => m.type === 'hostResolved');
    assert.ok(reply, '未回传解析结果');
    assert.strictEqual(reply.input, '__windows_host__');
    assert.ok(/^\d+\.\d+\.\d+\.\d+$/.test(reply.resolved), `解析结果不是 IP：${reply.resolved}`);
  });

  await check('localhost 会给出跨环境警告', async () => {
    form.posted.length = 0;
    await form.send({ type: 'resolveHost', host: 'localhost' });
    const reply = form.posted.find((m) => m.type === 'hostResolved');
    assert.ok(reply && reply.warning, '未给出跨环境提示');
  });

  await check('字段非法时不落盘', async () => {
    form.posted.length = 0;
    await form.send({
      type: 'submit',
      connectNow: false,
      passwordTouched: true,
      values: {
        name: '',
        driver: 'mysql',
        host: '',
        port: 0,
        user: '',
        password: '',
        database: '',
        group: '',
        ssl: false,
        readOnly: false,
        options: {},
      },
    });
    assert.ok(form.posted.some((m) => m.type === 'error'), '未回传校验错误');
    assert.strictEqual(context._globalState.get('dbviewer.connections.v1'), undefined, '非法数据被写入');
  });

  await check('提交后保存配置、写入凭据并回传 saved', async () => {
    form.posted.length = 0;
    await form.send({
      type: 'submit',
      connectNow: false,
      passwordTouched: true,
      values: {
        name: '本地 MySQL',
        driver: 'mysql',
        host: '__windows_host__',
        port: 3306,
        user: 'root',
        password: 'secret',
        database: 'app',
        group: '本地',
        ssl: false,
        readOnly: true,
        options: { charset: 'utf8mb4' },
      },
    });
    assert.ok(form.posted.some((m) => m.type === 'saved'), '未回传 saved');

    const profiles = context._globalState.get('dbviewer.connections.v1');
    assert.ok(Array.isArray(profiles) && profiles.length === 1, '配置未落盘');
    const profile = profiles[0];
    assert.strictEqual(profile.name, '本地 MySQL');
    assert.strictEqual(profile.host, '__windows_host__');
    assert.strictEqual(profile.port, 3306);
    assert.strictEqual(profile.readOnly, true);
    assert.strictEqual(profile.group, '本地');
    assert.strictEqual(profile.hasPassword, true);
    assert.strictEqual(profile.options.charset, 'utf8mb4');
    // 密码只允许进 SecretStorage
    assert.strictEqual(context._secrets.get(`dbviewer.password.${profile.id}`), 'secret');
    assert.ok(!JSON.stringify(profile).includes('secret'), '明文密码泄漏到配置文件');
  });

  await check('编辑模式预填且密码未改动时不覆盖凭据', async () => {
    const profileId = context._globalState.get('dbviewer.connections.v1')[0].id;
    webviewPanels.length = 0;
    await registeredCommands.get('dbviewer.editConnection')({ payload: { profileId } });
    assert.strictEqual(webviewPanels.length, 1, '未打开编辑表单');
    const editForm = webviewPanels[0];
    assert.strictEqual(editForm.title, '编辑数据库连接');

    const matched = /<script type="application\/json" id="bootstrap">([\s\S]*?)<\/script>/.exec(editForm.webview.html);
    const data = JSON.parse(matched[1]);
    assert.strictEqual(data.mode, 'edit');
    assert.strictEqual(data.initial.name, '本地 MySQL');
    assert.strictEqual(data.initial.port, 3306);
    assert.strictEqual(data.initial.readOnly, true);
    assert.strictEqual(data.initial.options.charset, 'utf8mb4');
    assert.strictEqual(data.passwordSaved, true);

    // 用户只改了名称，没碰密码框
    await editForm.send({
      type: 'submit',
      connectNow: false,
      passwordTouched: false,
      values: { ...data.initial, password: '', name: '本地 MySQL（改）' },
    });
    const profiles = context._globalState.get('dbviewer.connections.v1');
    assert.strictEqual(profiles[0].name, '本地 MySQL（改）');
    assert.strictEqual(
      context._secrets.get(`dbviewer.password.${profileId}`),
      'secret',
      '已保存密码被误清空',
    );
  });

  await check('编辑不存在的连接不会崩', async () => {
    webviewPanels.length = 0;
    await registeredCommands.get('dbviewer.editConnection')({ payload: { profileId: 'not-exist' } });
    assert.strictEqual(webviewPanels.length, 0, '不应为不存在的连接打开表单');
  });

  // ------------------------------------------------------------ 结果面板

  console.log('\n--- 结果面板 ---');

  const { ResultPanel } = require(path.join(outDir, 'views', 'resultPanel.js'));

  const fakeResult = {
    sets: [
      {
        statement: 'SELECT',
        sql: 'SELECT `id`, `name`, `score` FROM `app`.`users` LIMIT 2',
        fields: ['id', 'name', 'score'],
        rows: [
          { id: 1, name: '张三', score: null },
          { id: 2, name: '李四', score: 10 },
        ],
        rowCount: 2,
      },
    ],
    durationMs: 12,
    sql: 'SELECT `id`, `name`, `score` FROM `app`.`users`',
    truncated: false,
  };

  webviewPanels.length = 0;
  const panel = ResultPanel.show(Uri.file(root));
  const resultView = webviewPanels[webviewPanels.length - 1];
  /** 记录扩展侧收到的编辑请求。 */
  const applied = [];

  await check('结果面板含 SQL 编辑区、改动提交按钮与四种导出入口', () => {
    assert.strictEqual(resultView.viewType, 'dbviewer.result');
    const html = resultView.webview.html;
    for (const id of [
      'sqlEditor',
      'sqlRun',
      'sqlReset',
      'sqlToggle',
      'sqlCopy',
      'editLog',
      'applyEdits',
      'discardEdits',
      'copyTsv',
      'exportCsv',
      'exportJson',
      'exportJsonl',
      'exportXlsx',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `结果面板缺少 #${id}`);
    }
    assert.ok(!html.includes('<pre id="sqlView"'), 'SQL 区应为可编辑控件而非只读 pre');
  });

  await check('结果回传包含实际执行的 SQL 与可编辑标记', () => {
    resultView.posted.length = 0;
    panel.update(fakeResult, {
      connectionName: '本地 MySQL',
      target: 'app.users',
      edit: { database: 'app', table: 'users', identity: ['id'] },
      applyEdit: async ({ identity, changes }) => {
        applied.push({ identity, changes });
        return { sql: 'UPDATE `app`.`users` SET `name` = 1 WHERE `id` = 2', affectedRows: 1 };
      },
    });
    const payload = resultView.posted.find((m) => m.type === 'result');
    assert.ok(payload, '未回传结果');
    assert.strictEqual(payload.sql, fakeResult.sql);
    assert.strictEqual(payload.sets[0].sql, fakeResult.sets[0].sql, '未携带单条语句的 SQL');
    assert.strictEqual(payload.editable, true, '可编辑标记未置位');
    assert.deepStrictEqual(payload.sets[0].rows[1], [2, '李四', 10], '行未按列顺序投影');
  });

  await check('面板 SQL 可执行：回传 execute 会走命令层回调', async () => {
    const executed = [];
    resultView.posted.length = 0;
    panel.update(fakeResult, {
      connectionName: '本地 MySQL',
      executeSql: async (sql) => {
        executed.push(sql);
      },
    });
    const payload = resultView.posted.find((m) => m.type === 'result');
    assert.strictEqual(payload.canExecute, true, '未标记可执行');

    resultView.posted.length = 0;
    await resultView.send({ type: 'execute', sql: 'SELECT 1 + 1' });
    assert.deepStrictEqual(executed, ['SELECT 1 + 1'], '改写后的 SQL 未下发');
  });

  await check('面板 SQL 为空或未绑定连接时不执行', async () => {
    resultView.posted.length = 0;
    await resultView.send({ type: 'execute', sql: '   ' });
    assert.ok(
      resultView.posted.find((m) => m.type === 'executeFailed'),
      '空 SQL 应被拒绝',
    );

    resultView.posted.length = 0;
    panel.update(fakeResult, { connectionName: '本地 MySQL' });
    await resultView.send({ type: 'execute', sql: 'SELECT 1' });
    const failed = resultView.posted.find((m) => m.type === 'executeFailed');
    assert.ok(failed, '未绑定连接时应拒绝执行');
    assert.ok(failed.reason.includes('连接'), `错误提示不明确：${failed.reason}`);
  });

  await check('无编辑目标时结果集为只读', () => {
    resultView.posted.length = 0;
    panel.update(fakeResult, { connectionName: '本地 MySQL' });
    const payload = resultView.posted.find((m) => m.type === 'result');
    assert.strictEqual(payload.editable, false);
  });

  await check('单元格编辑：按主键定位并改写字符串列', async () => {
    panel.update(fakeResult, {
      connectionName: '本地 MySQL',
      edit: { database: 'app', table: 'users', identity: ['id'] },
      applyEdit: async ({ identity, changes }) => {
        applied.push({ identity, changes });
        return { sql: "UPDATE `app`.`users` SET `name` = 'x' WHERE `id` = 2", affectedRows: 1 };
      },
    });
    resultView.posted.length = 0;
    await resultView.send({
      type: 'updateCell',
      setIndex: 0,
      rowIndex: 1,
      column: 'name',
      value: '李四（改）',
      isNull: false,
    });

    assert.strictEqual(applied.length, 1, '未提交更新');
    assert.deepStrictEqual(applied[0].identity, { id: 2 }, 'WHERE 条件未取原始行主键值');
    assert.deepStrictEqual(applied[0].changes, { name: '李四（改）' });

    const updated = resultView.posted.find((m) => m.type === 'cellUpdated');
    assert.ok(updated, '未回传更新结果');
    assert.ok(updated.sql.startsWith('UPDATE'), '未回传实际执行的 UPDATE');
    assert.strictEqual(panel.result.sets[0].rows[1].name, '李四（改）', '扩展侧副本未同步');
  });

  await check('单元格编辑：数字列按原值类型还原', async () => {
    applied.length = 0;
    await resultView.send({
      type: 'updateCell',
      setIndex: 0,
      rowIndex: 1,
      column: 'score',
      value: '42',
      isNull: false,
    });
    assert.deepStrictEqual(applied[0].changes, { score: 42 }, '数字列被写成字符串');
  });

  await check('单元格编辑：空值语义跟随原值', async () => {
    applied.length = 0;
    await resultView.send({
      type: 'updateCell',
      setIndex: 0,
      rowIndex: 0,
      column: 'score',
      value: '',
      isNull: true,
    });
    assert.deepStrictEqual(applied[0].changes, { score: null });
    assert.deepStrictEqual(applied[0].identity, { id: 1 });
  });

  await check('单元格编辑：只读连接的错误回传到面板', async () => {
    resultView.posted.length = 0;
    panel.update(fakeResult, {
      connectionName: '只读库',
      edit: { table: 'users', identity: ['id'] },
      applyEdit: async () => {
        throw new Error('当前连接为只读模式，已拦截写操作');
      },
    });
    await resultView.send({
      type: 'updateCell',
      setIndex: 0,
      rowIndex: 0,
      column: 'name',
      value: 'x',
      isNull: false,
    });
    const failed = resultView.posted.find((m) => m.type === 'cellEditFailed');
    assert.ok(failed, '未回传失败信息');
    assert.ok(failed.reason.includes('只读'), `错误原文未透传：${failed.reason}`);
  });

  await check('单元格编辑：无编辑目标时直接拒绝', async () => {
    resultView.posted.length = 0;
    panel.update(fakeResult, { connectionName: '本地 MySQL' });
    await resultView.send({
      type: 'updateCell',
      setIndex: 0,
      rowIndex: 0,
      column: 'name',
      value: 'x',
      isNull: false,
    });
    const failed = resultView.posted.find((m) => m.type === 'cellEditFailed');
    assert.ok(failed, '只读结果集不应接受编辑');
  });

  await check('批量提交：一次提交多格，逐条按主键定位', async () => {
    applied.length = 0;
    // 用独立夹具：前序用例会就地改写 fakeResult 的单元格值，
    // 复用同一份会让"按原值类型还原"的断言依赖于用例顺序
    const batchResult = {
      sets: [
        {
          statement: 'SELECT',
          sql: 'SELECT `id`, `name`, `score` FROM `app`.`users` LIMIT 2',
          fields: ['id', 'name', 'score'],
          rows: [
            { id: 1, name: '张三', score: null },
            { id: 2, name: '李四', score: 10 },
          ],
          rowCount: 2,
        },
      ],
      durationMs: 12,
      sql: 'SELECT `id`, `name`, `score` FROM `app`.`users`',
      truncated: false,
    };
    panel.update(batchResult, {
      connectionName: '本地 MySQL',
      edit: { database: 'app', table: 'users', identity: ['id'] },
      applyEdit: async ({ identity, changes }) => {
        applied.push({ identity, changes });
        return { sql: `UPDATE set ${Object.keys(changes)[0]}`, affectedRows: 1 };
      },
    });
    resultView.posted.length = 0;
    await resultView.send({
      type: 'applyEdits',
      edits: [
        { setIndex: 0, rowIndex: 1, column: 'name', value: '王五', isNull: false },
        { setIndex: 0, rowIndex: 1, column: 'score', value: '99', isNull: false },
      ],
    });

    assert.strictEqual(applied.length, 2, '未逐条提交');
    assert.deepStrictEqual(applied[0].identity, { id: 2 });
    assert.deepStrictEqual(applied[0].changes, { name: '王五' });
    assert.deepStrictEqual(applied[1].identity, { id: 2 });
    assert.deepStrictEqual(applied[1].changes, { score: 99 }, '数字列未按原值类型还原');

    const summary = resultView.posted.find((m) => m.type === 'cellsUpdated');
    assert.ok(summary, '未回传批量提交结果');
    assert.strictEqual(summary.results.length, 2);
    assert.ok(!summary.results[0].error);
    assert.strictEqual(panel.result.sets[0].rows[1].name, '王五', '扩展侧副本未同步');
    assert.strictEqual(panel.result.sets[0].rows[1].score, 99);
  });

  await check('批量提交：单格失败不影响其余', async () => {
    let calls = 0;
    panel.update(fakeResult, {
      connectionName: '本地 MySQL',
      edit: { database: 'app', table: 'users', identity: ['id'] },
      applyEdit: async ({ changes }) => {
        calls += 1;
        if (changes.score !== undefined) {
          throw new Error('数值超出列范围');
        }
        return { sql: 'UPDATE ok', affectedRows: 1 };
      },
    });
    resultView.posted.length = 0;
    await resultView.send({
      type: 'applyEdits',
      edits: [
        { setIndex: 0, rowIndex: 1, column: 'name', value: 'ok', isNull: false },
        { setIndex: 0, rowIndex: 0, column: 'score', value: '1', isNull: false },
      ],
    });

    const summary = resultView.posted.find((m) => m.type === 'cellsUpdated');
    assert.strictEqual(calls, 2, '失败后应继续提交其余单元格');
    assert.ok(!summary.results[0].error, '正常格被误判为失败');
    assert.ok(summary.results[1].error.includes('超出列范围'), '失败原因未透传');
  });

  await check('批量提交：非数组入参不会崩', async () => {
    resultView.posted.length = 0;
    await resultView.send({ type: 'applyEdits', edits: undefined });
    const summary = resultView.posted.find((m) => m.type === 'cellsUpdated');
    assert.ok(summary && summary.results.length === 0);
  });

  await check('导出 CSV / JSONL / Excel 均落盘且内容正确', async () => {
    panel.update(fakeResult, { connectionName: '本地 MySQL' });
    writtenFiles.length = 0;

    saveDialogResult = Uri.file(path.join(root, 'tmp-export.csv'));
    await panel.exportActive('csv');
    const csv = writtenFiles[0].data.toString('utf8');
    assert.ok(csv.startsWith('\uFEFF'), 'CSV 缺少 BOM');
    assert.ok(csv.includes('id,name,score'), `CSV 表头异常：${csv.split('\r\n')[0]}`);

    saveDialogResult = Uri.file(path.join(root, 'tmp-export.jsonl'));
    await panel.exportActive('jsonl');
    const jsonl = writtenFiles[1].data.toString('utf8');
    assert.strictEqual(jsonl.trimEnd().split('\n').length, 2);
    assert.deepStrictEqual(Object.keys(JSON.parse(jsonl.split('\n')[0])), ['id', 'name', 'score']);

    saveDialogResult = Uri.file(path.join(root, 'tmp-export.xlsx'));
    await panel.exportActive('xlsx');
    assert.strictEqual(writtenFiles[2].data.readUInt32LE(0), 0x04034b50, '导出的不是 XLSX(ZIP)');

    assert.strictEqual(writtenFiles.length, 3);
  });

  await check('导出对话框被取消时不写盘', async () => {
    writtenFiles.length = 0;
    saveDialogResult = undefined;
    await panel.exportActive('csv');
    assert.strictEqual(writtenFiles.length, 0);
  });

  // ------------------------------------------------------------ SQL Shell

  console.log('\n--- SQL Shell ---');

  const { SqlShellPanel } = require(path.join(outDir, 'views', 'sqlShellPanel.js'));
  /** 记录扩展侧注入的回调被调用的情况。 */
  const shellCalls = { executed: [], switched: [] };

  const shellHost = {
    connectionName: '本地 MySQL',
    driverName: 'MySQL',
    target: 'root@127.0.0.1:3306/app',
    environment: 'Windows 原生',
    database: 'app',
    metaHelp: '可用命令：\\? \\l \\dt \\c \\clear \\q',
    execute: async (sql) => {
      shellCalls.executed.push(sql);
      if (sql === 'boom') {
        return { status: 'error', message: '表不存在', hints: ['· 检查表名'] };
      }
      if (sql === 'no') {
        return { status: 'cancelled' };
      }
      return {
        status: 'ok',
        result: {
          sets: [
            {
              statement: 'SELECT',
              sql: 'SELECT `id`, `name` FROM `app`.`users` LIMIT 2',
              fields: ['id', 'name'],
              rows: [
                { id: 1, name: '张三' },
                { id: 2, name: '李四' },
              ],
              rowCount: 5,
            },
          ],
          durationMs: 7,
          sql,
          truncated: false,
        },
      };
    },
    listDatabases: async () => ['information_schema', 'app'],
    listTables: async () => ['app.users', 'app.orders'],
    switchDatabase: async (name) => {
      shellCalls.switched.push(name);
      return `已切换到数据库 ${name}`;
    },
  };

  webviewPanels.length = 0;
  const shell = SqlShellPanel.open(Uri.file(root), 'profile-1', shellHost);
  const shellView = webviewPanels[webviewPanels.length - 1];

  await check('连接节点右键菜单包含打开 SQL Shell', () => {
    const item = packageJson.contributes.menus['view/item/context'].find(
      (m) => m.command === 'dbviewer.openSqlShell',
    );
    assert.ok(item, '未在树节点右键菜单声明 openSqlShell');
    assert.ok(item.when.includes('view == dbviewer.connections'), `when 未限定树视图：${item.when}`);
    assert.ok(item.when.includes('^dbviewer\\.connection'), `when 未匹配连接节点：${item.when}`);
  });

  await check('SQL Shell 面板创建成功且标题带连接名', () => {
    assert.strictEqual(shellView.viewType, 'dbviewer.sqlShell');
    assert.strictEqual(shellView.title, 'SQL Shell · 本地 MySQL');
  });

  await check('SQL Shell 界面含输入框、元命令入口与执行提示', () => {
    const html = shellView.webview.html;
    for (const id of ['input', 'clearBtn', 'helpBtn', 'output', 'bootstrap']) {
      assert.ok(html.includes(`id="${id}"`), `SQL Shell 缺少 #${id}`);
    }
    // 执行入口已改为 Enter 直接提交（不再有独立执行按钮），故只断言提示行存在
    assert.ok(html.includes('class="input-hint"'), 'SQL Shell 缺少执行提示行');
  });

  await check('引导数据带连接信息与元命令帮助', () => {
    const matched = /<script type="application\/json" id="bootstrap">([\s\S]*?)<\/script>/.exec(shellView.webview.html);
    assert.ok(matched, '未找到 bootstrap 数据块');
    const data = JSON.parse(matched[1]);
    assert.strictEqual(data.host.connectionName, '本地 MySQL');
    assert.strictEqual(data.host.database, 'app');
    assert.ok(data.host.metaHelp.includes('\\q'), '缺少元命令帮助');
  });

  await check('提交 SQL 经命令层回调执行并回传结果', async () => {
    shellView.posted.length = 0;
    await shellView.send({ type: 'submit', sql: 'SELECT * FROM users' });
    assert.deepStrictEqual(shellCalls.executed, ['SELECT * FROM users'], 'SQL 未下发到命令层');

    const entry = shellView.posted.filter((m) => m.type === 'entry').pop();
    assert.ok(entry, '未回传条目');
    assert.strictEqual(entry.entry.status, 'ok');
    assert.strictEqual(entry.entry.durationMs, 7);
    assert.deepStrictEqual(entry.entry.sets[0].rows, [[1, '张三'], [2, '李四']], '行未按列顺序投影');
    assert.strictEqual(entry.entry.sets[0].rowCount, 5);
  });

  await check('执行失败在输出流中显示错误与排查建议', async () => {
    shellView.posted.length = 0;
    await shellView.send({ type: 'submit', sql: 'boom' });
    const entry = shellView.posted.filter((m) => m.type === 'entry').pop().entry;
    assert.strictEqual(entry.status, 'error');
    assert.strictEqual(entry.message, '表不存在');
    assert.deepStrictEqual(entry.hints, ['· 检查表名']);
  });

  await check('取消危险语句不显示为错误', async () => {
    shellView.posted.length = 0;
    await shellView.send({ type: 'submit', sql: 'no' });
    const entry = shellView.posted.filter((m) => m.type === 'entry').pop().entry;
    assert.strictEqual(entry.status, 'notice');
    assert.ok(entry.message.includes('取消'));
  });

  await check('元命令 \\l / \\dt 在扩展侧处理，不发给驱动', async () => {
    shellView.posted.length = 0;
    await shellView.send({ type: 'submit', sql: '\\l' });
    const list = shellView.posted.filter((m) => m.type === 'entry').pop().entry;
    assert.strictEqual(list.status, 'notice');
    assert.ok(list.message.includes('information_schema'), '未列出数据库');

    shellView.posted.length = 0;
    await shellView.send({ type: 'submit', sql: '\\dt' });
    const tables = shellView.posted.filter((m) => m.type === 'entry').pop().entry;
    assert.ok(tables.message.includes('app.users'), '未列出数据表');

    assert.ok(!shellCalls.executed.includes('\\l'), '元命令被误发给驱动');
  });

  await check('\\c 切库会下发到命令层', async () => {
    shellView.posted.length = 0;
    await shellView.send({ type: 'submit', sql: '\\c analytics' });
    assert.deepStrictEqual(shellCalls.switched, ['analytics']);
    const entry = shellView.posted.filter((m) => m.type === 'entry').pop().entry;
    assert.ok(entry.message.includes('analytics'));
  });

  await check('ready 回放输出缓冲，历史不丢', async () => {
    shellView.posted.length = 0;
    await shellView.send({ type: 'ready' });
    const hydrate = shellView.posted.find((m) => m.type === 'hydrate');
    assert.ok(hydrate, '未回放输出缓冲');
    assert.ok(hydrate.entries.length >= 5, `输出缓冲不完整：${hydrate.entries.length}`);
    assert.strictEqual(hydrate.host.connectionName, '本地 MySQL');
  });

  await check('清空输出后缓冲同步清空', async () => {
    await shellView.send({ type: 'clear' });
    shellView.posted.length = 0;
    await shellView.send({ type: 'ready' });
    const hydrate = shellView.posted.find((m) => m.type === 'hydrate');
    assert.strictEqual(hydrate.entries.length, 0);
  });

  await check('updateHost 推送新的目标库信息', () => {
    shellView.posted.length = 0;
    shell.updateHost({ database: 'analytics', target: 'root@127.0.0.1:3306/analytics' });
    const message = shellView.posted.filter((m) => m.type === 'host').pop();
    assert.ok(message, '未推送 host 消息');
    assert.strictEqual(message.host.database, 'analytics');
  });

  await check('同一连接重复打开复用面板，关闭后可重建', () => {
    webviewPanels.length = 0;
    SqlShellPanel.open(Uri.file(root), 'profile-1', shellHost);
    assert.strictEqual(webviewPanels.length, 0, '重复打开不应创建新面板');

    shell.dispose();
    webviewPanels.length = 0;
    SqlShellPanel.open(Uri.file(root), 'profile-1', shellHost);
    assert.strictEqual(webviewPanels.length, 1, '面板关闭后应能重新创建');
    SqlShellPanel.disposeAll();
  });

  await check('deactivate() 无异常', async () => {
    await extension.deactivate();
  });

  console.log(`\n激活测试：通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log('\n失败明细：');
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exitCode = 1;
  } else {
    console.log('全部通过。');
  }
})();
