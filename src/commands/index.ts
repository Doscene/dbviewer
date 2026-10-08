/**
 * 命令注册层：连接管理、查询执行、结果导出、环境诊断。
 *
 * 这里是 UI 与核心能力的粘合层，负责：
 * - 把连接表单收集到的值整理成 `ConnectionInput`；
 * - 执行前的危险语句二次确认；
 * - 把驱动错误翻译成带排查建议的提示（尤其是 Windows ↔ WSL 网络问题）。
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { ConnectionManager, ConnectResult } from '../core/connectionManager';
import {
  baseTypeOptions,
  describeColumnDefaultEditor,
  describeColumnTypeEditor,
  describeOnUpdate,
  resolveEditorColumns,
} from '../core/columnSpecs';
import { ConnectionInput, ConnectionStore } from '../core/connectionStore';
import { DriverRegistry } from '../core/driverRegistry';
import { EditTarget, resolveEditTarget } from '../core/editTarget';
import { ExportFormat } from '../core/exporters';
import { planIsEmpty } from '../core/objectEditor';
import { isDestructiveStatement } from '../core/sqlText';
import {
  collectTableDataTargets,
  TableDataNodeLike,
  TableDataTarget,
  tableDataPanelKey,
  tableDataPanelTitle,
} from '../core/tableTargets';
import {
  ConnectionProfile,
  CreateDatabaseOptions,
  CreateUserRequest,
  DatabaseError,
  DatabaseObjectTarget,
  GrantRequest,
  IDatabaseDriver,
  QueryResult,
  QueryTarget,
} from '../core/types';
import { RuntimeEnvironment } from '../platform/environment';
import { HOST_ALIAS_WINDOWS, HOST_ALIAS_WSL } from '../platform/hostResolver';
import { registerBackupCommands } from './backup';
import { DbTreeItem } from '../views/connectionsTree';
import { ConnectionFormHost, ConnectionFormPanel, ConnectionFormValues } from '../views/connectionFormPanel';
import { ManagementFormPanel, ManagementFormValues } from '../views/managementFormPanel';
import {
  ObjectEditorChange,
  ObjectEditorHost,
  ObjectEditorModel,
  ObjectEditorPanel,
} from '../views/objectEditorPanel';
import { ResultPanel } from '../views/resultPanel';
import { ShellExecutionOutcome, SqlShellPanel } from '../views/sqlShellPanel';

export interface CommandDeps {
  context: vscode.ExtensionContext;
  manager: ConnectionManager;
  store: ConnectionStore;
  registry: DriverRegistry;
  env: RuntimeEnvironment;
  output: vscode.OutputChannel;
  refreshTree: () => void;
}

/** SQL 文档 → 目标连接的映射（工作区内有效）。 */
const documentTargets = new Map<string, string>();

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { context, manager, store, env, output, refreshTree } = deps;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'dbviewer.pickConnection';
  context.subscriptions.push(status);

  const track = (editor: vscode.TextEditor | undefined) => updateStatus(editor, status, store);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(track));
  track(vscode.window.activeTextEditor);

  const disposables: vscode.Disposable[] = [];

  const register = (id: string, handler: (...args: any[]) => unknown) => {
    disposables.push(vscode.commands.registerCommand(id, handler));
  };

  // ------------------------------------------------------------ 连接管理

  register('dbviewer.addConnection', async () => {
    await openConnectionForm(deps, 'create');
  });

  register('dbviewer.editConnection', async (node: DbTreeItem) => {
    const profileId = node?.payload?.profileId;
    if (!profileId) {
      return;
    }
    await openConnectionForm(deps, 'edit', profileId);
  });

  register('dbviewer.duplicateConnection', async (node: DbTreeItem) => {
    const profileId = node?.payload?.profileId;
    if (!profileId) {
      return;
    }
    const copy = await store.duplicate(profileId);
    refreshTree();
    if (copy) {
      vscode.window.showInformationMessage(`已复制为「${copy.name}」`);
    }
  });

  register('dbviewer.deleteConnection', async (node: DbTreeItem) => {
    const profileId = node?.payload?.profileId;
    if (!profileId) {
      return;
    }
    const profile = store.get(profileId);
    if (!profile) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `确定删除连接「${profile.name}」？保存的密码也会一并清除。`,
      { modal: true },
      '删除',
    );
    if (answer !== '删除') {
      return;
    }
    await manager.disconnect(profileId);
    await store.remove(profileId);
    refreshTree();
  });

  register('dbviewer.connect', async (node: DbTreeItem) => {
    const profileId = node?.payload?.profileId;
    if (profileId) {
      await connectById(deps, profileId);
    }
  });

  register('dbviewer.disconnect', async (node: DbTreeItem) => {
    const profileId = node?.payload?.profileId;
    if (!profileId) {
      return;
    }
    await manager.disconnect(profileId);
    refreshTree();
  });

  register('dbviewer.selectDatabase', async (node: DbTreeItem) => {
    const profileId = node?.payload?.profileId;
    if (!profileId) {
      return;
    }
    const session = manager.session(profileId);
    if (!session.driver) {
      await connectById(deps, profileId);
    }
    const driver = manager.session(profileId).driver;
    if (!driver) {
      return;
    }
    const databases = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: '正在读取数据库列表…' },
      () => driver.listDatabases(),
    );
    const picked = await vscode.window.showQuickPick(
      databases.map((db) => ({
        label: db.name,
        description: db.name === session.profile.database ? '当前' : db.isSystem ? '系统库' : undefined,
      })),
      { title: '选择目标数据库', placeHolder: '选择后将重新建立连接' },
    );
    if (!picked || picked.label === session.profile.database) {
      return;
    }
    await connectById(deps, profileId, picked.label);
  });

  register('dbviewer.refresh', () => refreshTree());

  register('dbviewer.pickConnection', async () => {
    const profiles = store.list();
    if (profiles.length === 0) {
      await vscode.commands.executeCommand('dbviewer.addConnection');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      profiles.map((p) => ({ label: p.name, description: `${p.driver} · ${p.user}@${p.host}:${p.port}` })),
      { title: '切换当前查询目标连接' },
    );
    if (!picked) {
      return;
    }
    const profile = profiles.find((p) => p.name === picked.label);
    const editor = vscode.window.activeTextEditor;
    if (profile && editor) {
      documentTargets.set(editor.document.uri.toString(), profile.id);
      updateStatus(editor, status, store);
    }
  });

  // ------------------------------------------------------------ 查询执行

  register('dbviewer.newQuery', async (node?: DbTreeItem) => {
    const profiles = store.list();
    if (profiles.length === 0) {
      await vscode.commands.executeCommand('dbviewer.addConnection');
      return;
    }
    let profileId = node?.payload?.profileId;
    if (!profileId) {
      const picked = await vscode.window.showQuickPick(
        profiles.map((p) => ({ label: p.name, description: `${p.driver} · ${p.user}@${p.host}:${p.port}` })),
        { title: '为查询选择连接' },
      );
      if (!picked) {
        return;
      }
      profileId = profiles.find((p) => p.name === picked.label)?.id;
    }
    if (!profileId) {
      return;
    }
    const profile = store.get(profileId);
    const target = node?.payload;
    const qualified = target?.table
      ? `${target.schema ?? target.database ?? ''}.${target.table}`
      : (profile?.database ?? '');
    const header = [
      `-- 连接：${profile?.name ?? profileId} (${profile?.driver ?? ''})`,
      `-- 环境：${env.describe}`,
      `-- 目标：${qualified || '(未指定)'}`,
      '-- 执行：点右上角 ▶（执行全部，Ctrl+Alt+E）或选中后按 Ctrl+Alt+Shift+E',
      '',
      '',
    ].join('\n');

    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: header });
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    documentTargets.set(doc.uri.toString(), profileId);
    const line = doc.lineCount - 1;
    editor.selection = new vscode.Selection(line, 0, line, 0);
    updateStatus(editor, status, store);
  });

  register('dbviewer.openSqlShell', async (node?: DbTreeItem) => {
    // 树视图右键带节点；命令面板调用时没有节点，走「唯一连接直接用、多个则让用户选」
    const profileId = await resolveProfileIdOrPrompt(deps, node, '选择要打开 SQL Shell 的连接');
    if (profileId) {
      await openSqlShell(deps, profileId);
    }
  });

  register('dbviewer.runQuery', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('请先打开一个 SQL 编辑器');
      return;
    }
    await runSql(editor.document.getText(), deps);
  });

  register('dbviewer.runSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const selection = editor.selection;
    if (selection.isEmpty) {
      vscode.window.showWarningMessage('未选中任何内容');
      return;
    }
    await runSql(editor.document.getText(selection), deps);
  });

  // ------------------------------------------------------------ 表操作

  register('dbviewer.showTableData', async (node?: DbTreeItem, selected?: DbTreeItem[]) => {
    // 多选时 VS Code 把「右键点中的那一项」放在第一个参数、全部选中项放在第二个参数，
    // 与备份命令同一套规则（见 commands/backup.ts 的 pickNodes）
    const collected = collectTableDataTargets(pickTableDataNodes(node, selected));
    if (collected.targets.length === 0) {
      // 空参（命令面板 / 测试路径）或选中的全是列、库之类的非表节点：静默返回
      return;
    }
    await openTableData(deps, collected.targets);
  });

  register('dbviewer.showTableDdl', async (node: DbTreeItem) => {
    const payload = node?.payload;
    if (!payload?.table || !payload.profileId) {
      return;
    }
    const session = await manager.connect(payload.profileId);
    const driver = session.session.driver;
    if (!driver?.showCreateTable) {
      vscode.window.showWarningMessage('当前驱动不支持查看建表语句');
      return;
    }
    const ddl = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: '正在生成建表语句…' },
      () =>
        driver.showCreateTable!({
          database: payload.database,
          schema: payload.schema,
          table: payload.table!,
        }),
    );
    if (!ddl) {
      vscode.window.showWarningMessage('未能获取建表语句');
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: ddl });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  register('dbviewer.openTableInQuery', async (node: DbTreeItem) => {
    const payload = node?.payload;
    if (!payload?.table || !payload.profileId) {
      return;
    }
    const session = manager.session(payload.profileId);
    const qualified =
      session.profile.driver === 'postgresql' || session.driver?.capabilities.schemas
        ? `"${payload.schema ?? 'public'}"."${payload.table}"`
        : `\`${payload.database ?? ''}\`.\`${payload.table}\``;
    const doc = await vscode.workspace.openTextDocument({
      language: 'sql',
      content: `SELECT * FROM ${qualified} LIMIT 100;\n`,
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    documentTargets.set(doc.uri.toString(), payload.profileId);
  });

  register('dbviewer.copyName', async (node: DbTreeItem) => {
    const payload = node?.payload;
    const name = payload?.column?.name ?? payload?.table ?? payload?.schema ?? payload?.database;
    if (name) {
      await vscode.env.clipboard.writeText(name);
      vscode.window.setStatusBarMessage(`已复制：${name}`, 2000);
    }
  });

  // ------------------------------------------------------------ 结果面板

  register('dbviewer.exportResult', async () => {
    const panel = ResultPanel.instance;
    if (!panel) {
      vscode.window.showWarningMessage('当前没有结果面板');
      return;
    }
    const choices: Array<{ label: string; description: string; format: ExportFormat }> = [
      { label: 'CSV', description: '逗号分隔，带 BOM，Excel 直接双击可开', format: 'csv' },
      { label: 'Excel', description: '真正的 .xlsx 工作簿（无第三方依赖）', format: 'xlsx' },
      { label: 'JSON', description: '对象数组，格式化为可读缩进', format: 'json' },
      { label: 'JSONL', description: 'JSON Lines，每行一个对象，便于流式导入', format: 'jsonl' },
    ];
    const picked = await vscode.window.showQuickPick(choices, {
      title: '导出当前结果集',
      placeHolder: '选择导出格式',
    });
    if (!picked) {
      return;
    }
    await panel.exportActive(picked.format);
  });

  register('dbviewer.clearResult', async () => {
    await ResultPanel.instance?.clear();
  });

  // ------------------------------------------------------------ 数据库与用户管理

  register('dbviewer.dropTable', async (node: DbTreeItem) => {
    const payload = node?.payload;
    if (!payload?.table || !payload.profileId) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `确定删除表「${payload.table}」？该操作不可恢复。`,
      { modal: true },
      '删除',
    );
    if (answer !== '删除') {
      return;
    }
    try {
      const session = await manager.connect(payload.profileId);
      const driver = session.session.driver;
      if (!driver?.dropTable) {
        vscode.window.showWarningMessage('当前驱动不支持删除表');
        return;
      }
      await driver.dropTable({
        database: payload.database,
        schema: payload.schema,
        table: payload.table,
      });
      vscode.window.setStatusBarMessage(`已删除表 ${payload.table}`, 3000);
      refreshTree();
    } catch (err) {
      vscode.window.showErrorMessage(`删除表失败：${(err as Error).message}`);
    }
  });

  register('dbviewer.dropDatabase', async (node: DbTreeItem) => {
    const payload = node?.payload;
    if (!payload?.database || !payload.profileId) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `确定删除数据库「${payload.database}」？该操作不可恢复，库内所有对象将一并删除。`,
      { modal: true },
      '删除',
    );
    if (answer !== '删除') {
      return;
    }
    try {
      const session = await manager.connect(payload.profileId);
      const driver = session.session.driver;
      if (!driver?.dropDatabase) {
        vscode.window.showWarningMessage('当前驱动不支持删除数据库');
        return;
      }
      await driver.dropDatabase(payload.database);
      vscode.window.setStatusBarMessage(`已删除数据库 ${payload.database}`, 3000);
      refreshTree();
    } catch (err) {
      vscode.window.showErrorMessage(`删除数据库失败：${(err as Error).message}`);
    }
  });

  register('dbviewer.createDatabase', async (node?: DbTreeItem) => {
    const profileId = await resolveProfileIdForManagement(deps, node);
    if (!profileId) {
      return;
    }
    try {
      const session = await manager.connect(profileId);
      const driver = session.session.driver;
      if (!driver?.createDatabase) {
        vscode.window.showWarningMessage('当前驱动不支持创建数据库');
        return;
      }
      const targets = await listManagementTargets(driver, session.session.profile.driver);
      ManagementFormPanel.open(context.extensionUri, {
        mode: 'createDatabase',
        driverId: session.session.profile.driver,
        driverName: driver.displayName,
        targets,
        submit: async (values: ManagementFormValues) => {
          const options: CreateDatabaseOptions = {
            name: values.dbName.trim(),
            charset: values.charset.trim() || undefined,
            collation: values.collation.trim() || undefined,
          };
          await driver.createDatabase!(options);
          vscode.window.setStatusBarMessage(`已创建数据库 ${options.name}`, 3000);
          refreshTree();
        },
      });
    } catch (err) {
      vscode.window.showErrorMessage(`创建数据库失败：${(err as Error).message}`);
    }
  });

  register('dbviewer.createUser', async (node?: DbTreeItem) => {
    const profileId = await resolveProfileIdForManagement(deps, node);
    if (!profileId) {
      return;
    }
    try {
      const session = await manager.connect(profileId);
      const driver = session.session.driver;
      if (!driver?.createUser) {
        vscode.window.showWarningMessage('当前驱动不支持创建用户');
        return;
      }
      const targets = await listManagementTargets(driver, session.session.profile.driver);
      ManagementFormPanel.open(context.extensionUri, {
        mode: 'createUser',
        driverId: session.session.profile.driver,
        driverName: driver.displayName,
        targets,
        submit: async (values: ManagementFormValues) => {
          const grants = parseGrantFormValues(values.grants);
          const request: CreateUserRequest = {
            username: values.username.trim(),
            password: values.password,
            host: values.host.trim() || undefined,
            grants: grants.length ? grants : undefined,
          };
          await driver.createUser!(request);
          vscode.window.setStatusBarMessage(`已创建用户 ${request.username}`, 3000);
        },
      });
    } catch (err) {
      vscode.window.showErrorMessage(`创建用户失败：${(err as Error).message}`);
    }
  });

  // ------------------------------------------------------------ 对象属性编辑

  // 表结构与库属性分成两条命令：菜单里要给出各自明确的名字，
  // 合并成「编辑属性」再在命令里猜对象类型，标签只能写成含糊的「编辑…」
  register('dbviewer.editTableStructure', async (node: DbTreeItem) => {
    const payload = node?.payload;
    if (!payload?.table || !payload.profileId || payload.tableKind === 'view') {
      return;
    }
    await openObjectEditor(deps, payload.profileId, {
      mode: 'table',
      target: { database: payload.database, schema: payload.schema, table: payload.table },
    });
  });

  register('dbviewer.editDatabaseProperties', async (node: DbTreeItem) => {
    const payload = node?.payload;
    if (!payload?.profileId) {
      return;
    }
    // 库节点与 schema 节点都要支持：PG 的库级属性（owner / 注释）在库节点上，
    // 而表挂 schema 之下，用户更常右键到的是 schema
    const target: DatabaseObjectTarget | undefined =
      payload.kind === 'schema' && payload.schema
        ? { kind: 'schema', name: payload.schema, database: payload.database }
        : payload.kind === 'database' && payload.database
          ? { kind: 'database', name: payload.database }
          : undefined;
    if (!target) {
      return;
    }
    await openObjectEditor(deps, payload.profileId, { mode: 'database', target });
  });

  // ------------------------------------------------------------ 环境诊断

  register('dbviewer.showEnvironment', async () => {
    const lines = buildDiagnostics(deps);
    output.clear();
    output.appendLine(lines.join('\n'));
    output.show(true);
    const action = await vscode.window.showInformationMessage(
      `当前环境：${env.describe}`,
      '复制诊断信息',
      '打开设置',
    );
    if (action === '复制诊断信息') {
      await vscode.env.clipboard.writeText(lines.join('\n'));
    } else if (action === '打开设置') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'dbviewer');
    }
  });

  // ------------------------------------------------------------ 备份

  // 备份自带一套「选方式 → 选路径 → 进度 → 流式写盘」的流程，实现放在 commands/backup.ts，
  // 这里只把它并进命令生命周期，保证随扩展一起释放
  disposables.push(...registerBackupCommands(deps));

  return disposables;
}

// ---------------------------------------------------------------- 辅助函数

async function connectById(deps: CommandDeps, profileId: string, database?: string): Promise<void> {
  const { manager, refreshTree } = deps;
  try {
    const { resolution } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在建立数据库连接…', cancellable: false },
      () => manager.connect(profileId, database),
    );
    refreshTree();
    const detail = resolution.note ? `（${resolution.note}）` : '';
    vscode.window.setStatusBarMessage(`已连接${detail}`, 4000);
  } catch (err) {
    refreshTree();
    await reportConnectionError(err, deps, profileId);
  }
}

/** 连接失败时给出结构化的排查指引，而不是只弹一句原始错误。 */
async function reportConnectionError(err: unknown, deps: CommandDeps, profileId: string): Promise<void> {
  const { manager, store, output, env } = deps;
  const profile = store.get(profileId);
  const message = (err as Error).message;
  const suggestions = profile ? manager.resolver.suggestions(profile.host) : [];
  const tips = [
    `连接失败：${message}`,
    '',
    `运行环境：${env.describe}`,
    profile ? `配置主机：${profile.host}` : '',
    ...suggestions.map((s) => `· ${s}`),
  ].filter(Boolean);

  output.appendLine('--------------------------------------------------------------');
  output.appendLine(tips.join('\n'));
  if (err instanceof DatabaseError && err.detail) {
    output.appendLine(`detail: ${err.detail}`);
  }

  const action = await vscode.window.showErrorMessage(
    `连接失败：${message.split('\n')[0]}`,
    '查看排查建议',
    '编辑连接',
  );
  if (action === '查看排查建议') {
    output.show(true);
    // 把完整建议也放到输出面板中，便于复制
    output.appendLine(tips.slice(3).join('\n'));
  } else if (action === '编辑连接') {
    await vscode.commands.executeCommand('dbviewer.editConnection', { payload: { profileId } });
  }
}

/**
 * 危险语句的二次确认。
 *
 * 抽成独立函数是因为结果面板与 SQL Shell 都要走这一步：两套判定早晚会漂移，
 * 而漂移的方向通常是「某个入口漏了确认」。
 */
async function confirmDestructive(sql: string): Promise<boolean> {
  const confirmNeeded = vscode.workspace
    .getConfiguration('dbviewer')
    .get<boolean>('confirmDestructiveStatements', true);
  if (!confirmNeeded || !isDestructiveStatement(sql)) {
    return true;
  }
  const answer = await vscode.window.showWarningMessage(
    '即将执行写操作，可能修改或删除数据。确认继续？',
    { modal: true, detail: sql.length > 800 ? `${sql.slice(0, 800)}…` : sql },
    '执行',
  );
  return answer === '执行';
}

/** 执行 SQL 的可选行为：表数据预览与批量入口靠它调整进度、报错与窗口归属。 */
interface RunSqlOptions {
  profileId?: string;
  /** 面板头部展示的目标文本（表数据预览 = 库.表）。缺省为「连接名/库名」。 */
  target?: string;
  /** 窗口标签标题；缺省「查询结果」。 */
  title?: string;
  /** 面板复用键：同键复用同一个窗口（表数据预览靠它做到一表一窗）。 */
  panelKey?: string;
  /** 批量开窗时置 true：新窗口不抢焦点。 */
  preserveFocus?: boolean;
  /** 已知目标表时直接传入，比从 SQL 文本反推可靠。 */
  editFallback?: QueryTarget & { table: string };
  /** 进度通知文案；`null` 表示由调用方统一显示进度（批量入口）。 */
  progressTitle?: string | null;
  /** 失败是否弹提示；批量入口置 `false`，自己汇总成一条。 */
  notifyError?: boolean;
  /** 是否刷新树；批量入口置 `false`，整批结束后刷一次。 */
  refreshTree?: boolean;
}

/** 单次执行的结局：批量入口靠它决定要不要汇总报错。 */
type RunSqlOutcome =
  | { status: 'ok' }
  | { status: 'failed'; profileId: string; message: string }
  | { status: 'skipped' };

/**
 * 执行 SQL：解析目标连接 → 危险语句确认 → 执行 → 渲染结果。
 *
 * `editFallback` 由调用方在已知目标表时传入（树视图的「查看数据」），
 * 比从 SQL 里推导更可靠；临时 SELECT 则自动尝试推导，推不出来就结果只读。
 */
async function runSql(sql: string, deps: CommandDeps, options: RunSqlOptions = {}): Promise<RunSqlOutcome> {
  const { manager, store, refreshTree } = deps;
  const text = sql.trim();
  if (!text) {
    vscode.window.showWarningMessage('SQL 为空');
    return { status: 'skipped' };
  }

  const resolvedId = options.profileId ?? (await resolveTargetProfileId(deps));
  if (!resolvedId) {
    return { status: 'skipped' };
  }
  const profile = store.get(resolvedId);
  if (!profile) {
    return { status: 'skipped' };
  }

  if (!(await confirmDestructive(text))) {
    return { status: 'skipped' };
  }

  const panel = ResultPanel.show(deps.context.extensionUri, {
    key: options.panelKey,
    title: options.title,
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: options.preserveFocus,
  });
  panel.showRunning(text);

  try {
    // 批量入口自己显示一条覆盖整批的进度（progressTitle === null）；否则 N 张表会
    // 依次弹出 N 条「正在执行 SQL…」，把通知中心刷满
    const result =
      options.progressTitle === null
        ? await manager.execute(resolvedId, text)
        : await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: options.progressTitle ?? '正在执行 SQL…',
              cancellable: false,
            },
            () => manager.execute(resolvedId, text),
          );
    if (options.refreshTree !== false) {
      refreshTree();
    }

    const edit = await deriveEditTarget(manager, resolvedId, result, options.editFallback);
    // 面板里改完 SQL 直接执行：复用同一条链路（危险语句确认、超时、错误翻译照旧）并留在
    // 同一个窗口；批量开窗用的静默报错与「由外层显示进度」不外溢到交互式重跑
    const rerun: RunSqlOptions = {
      ...options,
      progressTitle: undefined,
      notifyError: true,
      preserveFocus: false,
      refreshTree: true,
    };
    panel.update(result, {
      connectionName: profile.name,
      target: options.target ?? `${profile.name}${profile.database ? `/${profile.database}` : ''}`,
      edit,
      applyEdit: edit
        ? ({ identity, changes }) =>
            manager.updateCell(resolvedId, {
              target: {
                database: edit.database,
                schema: edit.schema,
                table: edit.table,
              },
              identity,
              changes,
            })
        : undefined,
      executeSql: async (nextSql) => {
        await runSql(nextSql, deps, rerun);
      },
    });
    return { status: 'ok' };
  } catch (err) {
    if (options.refreshTree !== false) {
      refreshTree();
    }
    const message = (err as Error).message;
    panel.showError(message, text);
    // 批量入口不在这里弹提示：N 张表各弹一次会把界面刷满，由调用方汇总成一条
    if (options.notifyError !== false) {
      const suggestions = manager.resolver.suggestions(profile.host);
      const action = await vscode.window.showErrorMessage(
        `执行失败：${message.split('\n')[0]}`,
        ...(suggestions.length ? ['查看排查建议'] : []),
      );
      if (action === '查看排查建议') {
        deps.output.appendLine('--------------------------------------------------------------');
        deps.output.appendLine(suggestions.map((s) => `· ${s}`).join('\n'));
        deps.output.show(true);
      }
    }
    return { status: 'failed', profileId: resolvedId, message };
  }
}

/**
 * 打开「查看数据」窗口：一张表一个窗口，多选时按顺序逐个读取。
 *
 * 顺序而不是并发：驱动是单连接（`mysql.createConnection` / `new Client`），并发只会让
 * 排队语义、超时判定与错误归属变复杂；顺序读取也让进度能准确说清「读到第几张」。
 */
async function openTableData(deps: CommandDeps, targets: TableDataTarget[]): Promise<void> {
  const { manager, refreshTree } = deps;
  const multiple = targets.length > 1;
  const failures: Array<{ title: string; message: string; profileId: string }> = [];
  let cancelled = false;

  const openOne = async (target: TableDataTarget, index: number): Promise<void> => {
    const title = tableDataPanelTitle(target);
    let driver: IDatabaseDriver | undefined;
    let sessionDatabase: string | undefined;
    try {
      const session = await manager.connect(target.profileId);
      driver = session.session.driver;
      sessionDatabase = session.session.profile.database;
    } catch (err) {
      // 连接失败只影响这一张表：剩下的照常开窗，最后汇总成一条提示
      failures.push({ title, message: (err as Error).message, profileId: target.profileId });
      return;
    }
    if (!driver) {
      failures.push({ title, message: '连接未就绪', profileId: target.profileId });
      return;
    }

    const limit = manager.pageSize || 200;
    const query: QueryTarget & { table: string } = {
      database: target.database,
      schema: target.schema,
      table: target.table,
    };
    const sql = driver.previewSql?.(query, limit) ?? `SELECT * FROM ${target.table} LIMIT ${limit};`;
    const outcome = await runSql(sql, deps, {
      profileId: target.profileId,
      // 窗口标题与头部目标都写「库.表」：多窗口并存时，标签是唯一能一眼分清身份的线索
      title,
      target: title,
      panelKey: tableDataPanelKey(target),
      preserveFocus: multiple && index > 0,
      // 表数据预览是最常见的编辑场景，这里直接把目标表交给结果面板，
      // 不依赖从 SQL 文本反推表名
      editFallback: {
        database: target.database ?? (driver.capabilities.schemas ? undefined : sessionDatabase),
        schema: target.schema,
        table: target.table,
      },
      // 多选时进度与报错都由本函数统一处理，避免 N 条通知刷屏
      progressTitle: multiple ? null : undefined,
      notifyError: !multiple,
      refreshTree: !multiple,
    });
    if (outcome.status === 'failed') {
      failures.push({ title, message: outcome.message, profileId: outcome.profileId });
    }
  };

  if (!multiple) {
    await openOne(targets[0], 0);
  } else {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在读取 ${targets.length} 张数据表…`,
        cancellable: true,
      },
      async (progress, token) => {
        for (let i = 0; i < targets.length; i += 1) {
          if (token.isCancellationRequested) {
            cancelled = true;
            break;
          }
          progress.report({
            message: `${i + 1}/${targets.length} · ${tableDataPanelTitle(targets[i])}`,
            increment: 100 / targets.length,
          });
          await openOne(targets[i], i);
        }
      },
    );
    // 整批只刷一次树：逐条刷会在选中几十张表时打出几十个刷新事件
    refreshTree();
  }

  if (cancelled) {
    vscode.window.setStatusBarMessage('已取消：剩余数据表未读取', 4000);
  }
  if (failures.length) {
    await reportBatchFailures(deps, failures);
  }
}

/**
 * 批量「查看数据」的失败汇总。
 *
 * 失败的那张表已经在自己的窗口里渲染了错误；界面只再弹一条，明细写进输出通道 ——
 * 选了 20 张表就弹 20 个错误提示的话，用户除了把它们逐个关掉什么也做不了。
 */
async function reportBatchFailures(
  deps: CommandDeps,
  failures: Array<{ title: string; message: string; profileId: string }>,
): Promise<void> {
  const { store, manager, output } = deps;
  output.appendLine('--------------------------------------------------------------');
  output.appendLine(`[查看数据] ${failures.length} 张表读取失败：`);
  output.appendLine(failures.map((f) => `· ${f.title}：${f.message.split('\n')[0]}`).join('\n'));

  const first = failures[0];
  const profile = store.get(first.profileId);
  const suggestions = profile ? manager.resolver.suggestions(profile.host) : [];
  const action = await vscode.window.showErrorMessage(
    `${failures.length} 张表读取失败：${first.title}（${first.message.split('\n')[0]}）`,
    '查看日志',
    ...(suggestions.length ? ['查看排查建议'] : []),
  );
  if (action === '查看日志') {
    output.show(true);
  } else if (action === '查看排查建议') {
    output.appendLine(suggestions.map((s) => `· ${s}`).join('\n'));
    output.show(true);
  }
}

/**
 * 树节点 → 「查看数据」目标。
 *
 * 与备份命令同一套多选规则：右键点中的项若不在选中集合里就补到最前 ——
 * 那才是用户当下的意图；已在集合里就不要重复计入。
 */
function pickTableDataNodes(node?: DbTreeItem, selected?: DbTreeItem[]): TableDataNodeLike[] {
  const list = (selected ?? []).filter(Boolean);
  const effective = node && !list.includes(node) ? [node, ...list] : list.length ? list : node ? [node] : [];
  return effective.map((item) => ({
    kind: item.payload?.kind,
    profileId: item.payload?.profileId,
    database: item.payload?.database,
    schema: item.payload?.schema,
    table: item.payload?.table,
    tableKind: item.payload?.tableKind,
  }));
}

/**
 * 推导本次结果集能不能编辑。
 *
 * 只在「单条语句 + 只有一组结果集 + 有行」时开启：多语句执行时第二组结果集
 * 可能来自完全不同的表，给它挂上编辑入口比不给更危险。
 */
async function deriveEditTarget(
  manager: ConnectionManager,
  profileId: string,
  result: QueryResult,
  fallback?: QueryTarget & { table: string },
): Promise<EditTarget | undefined> {
  if (result.sets.length !== 1) {
    return undefined;
  }
  const driver = manager.session(profileId).driver;
  if (!driver) {
    return undefined;
  }
  const set = result.sets[0];
  if (set.fields.length === 0 || set.rows.length === 0) {
    return undefined;
  }
  // 用实际执行的 SQL（可能已被追加 LIMIT）而不是编辑器里的原文，两者表名一致
  return resolveEditTarget(driver, set.sql || result.sql, set.fields, fallback);
}

// ---------------------------------------------------------------- SQL Shell

/** SQL Shell 的元命令帮助文案：单一来源在扩展侧，前端只负责显示。 */
const SHELL_META_HELP = [
  '可用命令：',
  '  \\?            显示本帮助',
  '  \\l            列出数据库',
  '  \\dt           列出当前库的数据表',
  '  \\c <数据库>   切换目标数据库（会重建连接）',
  '  \\clear        清空输出',
  '  \\q            关闭本面板（quit / exit 同义）',
  '',
  '快捷键：Enter 或 Ctrl+Enter 执行，Shift+Enter 换行，↑ / ↓ 翻历史。',
].join('\n');

/**
 * 打开 SQL Shell。
 *
 * 未连接时先连：shell 的全部价值都建立在「已经连上」这件事上，
 * 先开一个连不上的空面板、再让用户回去点连接，纯属多一步。
 */
async function openSqlShell(deps: CommandDeps, profileId: string): Promise<void> {
  const { manager, store, env, refreshTree } = deps;
  const profile = store.get(profileId);
  if (!profile) {
    return;
  }

  let connected: ConnectResult;
  try {
    connected = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在建立数据库连接…', cancellable: false },
      () => manager.connect(profileId),
    );
  } catch (err) {
    refreshTree();
    await reportConnectionError(err, deps, profileId);
    return;
  }
  refreshTree();

  const driver = connected.session.driver;
  const describe = (): string => {
    const session = manager.session(profileId);
    const database = session.profile.database;
    return `${session.profile.user}@${session.profile.host}:${session.profile.port}${database ? `/${database}` : ''}`;
  };

  // 闭包内要回写这个引用（切库后刷新标题、面板关闭后清引用），显式初始化以满足严格模式
  let shell: SqlShellPanel | undefined = undefined;
  shell = SqlShellPanel.open(deps.context.extensionUri, profileId, {
    connectionName: profile.name,
    driverName: driver?.displayName ?? profile.driver,
    target: describe(),
    environment: env.describe,
    database: manager.session(profileId).profile.database,
    metaHelp: SHELL_META_HELP,
    execute: (sql) => executeForShell(deps, profileId, sql),

    listDatabases: async () => (await requireDriver(manager, profileId).listDatabases()).map((db) => db.name),

    listTables: async () => {
      const current = requireDriver(manager, profileId);
      // MySQL 的表挂在 database 下、PG 挂在 schema 下：按能力位选目标，
      // 命令层不出现「驱动是不是 postgresql」这类分支
      const target: QueryTarget = current.capabilities.schemas
        ? {}
        : { database: manager.session(profileId).profile.database };
      const tables = await current.listTables(target);
      const lines = tables
        .slice(0, 500)
        .map((table) => (current.capabilities.schemas && table.schema ? `${table.schema}.${table.name}` : table.name));
      if (tables.length > lines.length) {
        lines.push(`… 共 ${tables.length} 个对象，仅列出前 ${lines.length} 个`);
      }
      return lines;
    },

    switchDatabase: async (name) => {
      const { session: next } = await manager.connect(profileId, name);
      refreshTree();
      shell?.updateHost({ database: next.profile.database, target: describe() });
      return `已切换到数据库 ${next.profile.database ?? name}`;
    },

    onDispose: () => {
      shell = undefined;
    },
  });
}

/**
 * Shell 内执行 SQL。
 *
 * 与结果面板同源的处理链路，只是结果交给 shell 渲染。错误在这里被翻译成结构化返回值
 * 而不是抛出——shell 要把错误留在输出流里，弹模态提示会打断连续操作。
 */
async function executeForShell(
  deps: CommandDeps,
  profileId: string,
  sql: string,
): Promise<ShellExecutionOutcome> {
  const { manager, store, refreshTree } = deps;
  const profile = store.get(profileId);
  if (!profile) {
    return { status: 'error', message: '连接配置已不存在，请重新打开 SQL Shell' };
  }
  if (!(await confirmDestructive(sql))) {
    return { status: 'cancelled' };
  }
  try {
    const result = await vscode.window.withProgress(
      // 状态栏进度而不是通知：shell 是连续交互，每次执行都弹通知会一直抢焦点
      { location: vscode.ProgressLocation.Window, title: '正在执行 SQL…' },
      () => manager.execute(profileId, sql),
    );
    refreshTree();
    return { status: 'ok', result };
  } catch (err) {
    refreshTree();
    return {
      status: 'error',
      message: (err as Error).message,
      hints: manager.resolver.suggestions(profile.host),
    };
  }
}

function requireDriver(manager: ConnectionManager, profileId: string): IDatabaseDriver {
  const driver = manager.session(profileId).driver;
  if (!driver) {
    throw new DatabaseError('连接未就绪，请重新连接后重试', 'ENOT_CONNECTED');
  }
  return driver;
}

/** 对象编辑器要编辑的东西：表结构或库 / schema 属性。 */
type ObjectEditorRequest =
  | { mode: 'table'; target: QueryTarget & { table: string } }
  | { mode: 'database'; target: DatabaseObjectTarget };

/**
 * 打开对象编辑器。
 *
 * 只在这里做「读现状 → 生成语句 → 应用」的编排，真正的差异计算与 DDL 拼装都在驱动层：
 * 命令层一旦开始按驱动拼 SQL，第三个数据库接进来时就得改这里。
 */
async function openObjectEditor(deps: CommandDeps, profileId: string, request: ObjectEditorRequest): Promise<void> {
  const { manager, store, refreshTree } = deps;
  const profile = store.get(profileId);
  if (!profile) {
    return;
  }

  let connected: ConnectResult;
  try {
    connected = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在读取对象结构…', cancellable: false },
      () => manager.connect(profileId),
    );
  } catch (err) {
    refreshTree();
    await reportConnectionError(err, deps, profileId);
    return;
  }

  const driver = connected.session.driver;
  if (!driver) {
    vscode.window.showWarningMessage('连接未就绪，无法读取对象结构');
    return;
  }

  const isTable = request.mode === 'table';
  // 能力位与实现都要检查：能力位是驱动自己声明的，第三方驱动可能声明了却没实现
  const capable = isTable
    ? driver.capabilities.editTableStructure && typeof driver.describeTable === 'function'
    : driver.capabilities.editDatabaseProperties && typeof driver.describeDatabaseProperties === 'function';
  if (!capable) {
    vscode.window.showWarningMessage(
      `驱动「${driver.displayName}」不支持${isTable ? '编辑表结构' : '编辑数据库属性'}`,
    );
    return;
  }

  const tableTarget = request.mode === 'table' ? request.target : undefined;
  const databaseTarget = request.mode === 'database' ? request.target : undefined;
  const connectionLabel = `${profile.name} · ${driver.displayName}`;

  const load = async (): Promise<ObjectEditorModel> => {
    if (tableTarget) {
      const structure = await driver.describeTable!(tableTarget);
      // 结构化的编辑描述在这里算好：Webview 只渲染控件，不参与类型文本与子句的拼装
      const allowAutoUpdate = !!structure.allowAutoUpdate;
      return {
        mode: 'table',
        title: tableDataPanelTitle(tableTarget),
        objectLabel: '数据表',
        connectionLabel,
        properties: structure.properties,
        columns: structure.columns.map((column) => ({
          ...column,
          typeEditor: describeColumnTypeEditor(column.dataType),
          defaultEditor: describeColumnDefaultEditor(column),
          onUpdate: describeOnUpdate(column.extraClauses, allowAutoUpdate, column.dataType),
        })),
        typeOptions: baseTypeOptions(structure.dataTypes ?? []),
        allowReorder: structure.allowReorder,
        allowAutoIncrement: structure.allowAutoIncrement,
        allowAutoUpdate,
        limitations: structure.limitations,
        ddl: structure.ddl,
        readOnly: !!connected.session.profile.readOnly,
      };
    }
    const described = await driver.describeDatabaseProperties!(databaseTarget!);
    return {
      mode: 'database',
      title: databaseTarget!.name,
      objectLabel: described.label,
      connectionLabel,
      properties: described.properties,
      allowReorder: false,
      allowAutoIncrement: false,
      limitations: described.limitations,
      readOnly: !!connected.session.profile.readOnly,
    };
  };

  /**
   * 生成计划。
   *
   * 预览与应用共用它，且每次都让驱动重读现状——面板里的「原始值」只用于渲染，
   * 绝不能作为生成 DDL 的依据，否则面板停留久了就会按过期结构下发语句。
   */
  const generate = async (change: ObjectEditorChange) => {
    const properties = change.properties ?? {};
    if (tableTarget) {
      return driver.planTableChange!({
        target: tableTarget,
        columns: resolveEditorColumns(change.columns ?? []),
        properties,
      });
    }
    return driver.planDatabaseChange!({ target: databaseTarget!, properties });
  };

  const host: ObjectEditorHost = {
    load,
    plan: generate,
    apply: async (change) => {
      const plan = await generate(change);
      if (planIsEmpty(plan)) {
        throw new Error('没有检测到任何变更');
      }
      // 结构变更的破坏性不比 DELETE 小（删列直接丢数据），复用同一套二次确认
      if (!(await confirmDestructive(plan.statements.join(';\n')))) {
        return undefined;
      }
      const result = tableTarget
        ? await driver.applyTableChange!({
            target: tableTarget,
            columns: resolveEditorColumns(change.columns ?? []),
            properties: change.properties ?? {},
          })
        : await driver.applyDatabaseChange!({ target: databaseTarget!, properties: change.properties ?? {} });
      refreshTree();
      vscode.window.setStatusBarMessage(`已执行 ${result.executed} 条语句`, 4000);
      return result;
    },
  };

  try {
    const model = await load();
    ObjectEditorPanel.open(deps.context.extensionUri, host, model, {
      icon: isTable ? 'table' : 'database',
    });
  } catch (err) {
    vscode.window.showErrorMessage(`读取对象结构失败：${(err as Error).message}`);
  }
}

/** 确定 SQL 应发往哪个连接：优先文档绑定，其次让用户选择。 */async function resolveTargetProfileId(deps: CommandDeps): Promise<string | undefined> {
  const { store } = deps;
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const bound = documentTargets.get(editor.document.uri.toString());
    if (bound && store.get(bound)) {
      return bound;
    }
  }
  const profiles = store.list();
  if (profiles.length === 0) {
    const action = await vscode.window.showWarningMessage('尚未配置任何数据库连接', '添加连接');
    if (action === '添加连接') {
      await vscode.commands.executeCommand('dbviewer.addConnection');
    }
    return undefined;
  }
  if (profiles.length === 1) {
    return profiles[0].id;
  }
  const picked = await vscode.window.showQuickPick(
    profiles.map((p) => ({ label: p.name, description: `${p.driver} · ${p.user}@${p.host}:${p.port}` })),
    { title: '选择执行目标连接', placeHolder: '提示：可用「新建查询」将文档绑定到固定连接' },
  );
  if (!picked) {
    return undefined;
  }
  const profile = profiles.find((p) => p.name === picked.label);
  if (profile && editor) {
    documentTargets.set(editor.document.uri.toString(), profile.id);
  }
  return profile?.id;
}

/**
 * 打开连接表单。
 *
 * 取代早期的「逐项弹窗」向导。逐项弹窗的问题是：看不到已填内容、无法跳步回改、
 * 改一个字段要重走全流程、每次弹窗都打断输入焦点。表单则能一次看到全部字段、
 * 切换驱动即时联动，并在保存前先验证连通性，避免「保存 → 连接失败 → 回来改」的往复。
 */
async function openConnectionForm(deps: CommandDeps, mode: 'create' | 'edit', profileId?: string): Promise<void> {
  const { registry, manager, store, env } = deps;

  const drivers = registry.list();
  if (drivers.length === 0) {
    void vscode.window.showErrorMessage('没有任何可用驱动');
    return;
  }

  const existing = mode === 'edit' && profileId ? store.get(profileId) : undefined;
  if (mode === 'edit' && !existing) {
    void vscode.window.showWarningMessage('未找到要编辑的连接配置');
    return;
  }

  ConnectionFormPanel.open(deps.context.extensionUri, {
    mode,
    drivers: drivers.map((d) => ({
      id: d.id,
      displayName: d.displayName,
      defaultPort: d.defaultPort,
      description: d.description,
      sampleHost: d.sampleHost,
      icon: d.icon,
    })),
    passwordSaved: !!existing?.hasPassword,
    initial: existing
      ? {
          name: existing.name,
          driver: registry.resolveId(existing.driver) ?? existing.driver,
          host: existing.host,
          port: existing.port,
          user: existing.user,
          database: existing.database ?? '',
          group: existing.group ?? '',
          ssl: !!existing.ssl,
          readOnly: !!existing.readOnly,
          options: toStringMap(existing.options),
        }
      : undefined,

    contextInfo: buildFormContext(manager, env),

    resolveHost: (host) => {
      const resolution = manager.resolver.resolve(host);
      return { host: resolution.host, note: resolution.note, warning: resolution.warning };
    },

    test: async (values) => {
      const password = values.password || (existing ? await store.getPassword(existing.id) : undefined);
      return manager.testProfile(toTempProfile(values, existing), password);
    },

    save: async (values, passwordTouched) => {
      const input: ConnectionInput = {
        name: values.name.trim(),
        driver: values.driver,
        host: values.host.trim(),
        port: values.port,
        user: values.user.trim(),
        database: values.database.trim() || undefined,
        ssl: values.ssl,
        readOnly: values.readOnly,
        group: values.group.trim() || undefined,
        options: Object.keys(values.options).length ? values.options : undefined,
      };
      // 仅在用户确实动过密码框时才覆盖已保存的凭据：
      // 编辑场景下密码框是空的，若一律覆盖会把已存密码清掉。
      if (passwordTouched) {
        input.password = values.password;
      }
      if (mode === 'edit' && existing) {
        const updated = await store.update(existing.id, input);
        if (!updated) {
          throw new Error('连接配置已不存在，可能已被删除');
        }
        manager.refreshProfile(existing.id);
        return updated;
      }
      return store.add(input);
    },

    afterSave: async (profile, connectNow) => {
      deps.refreshTree();
      if (connectNow) {
        await connectById(deps, profile.id);
        return;
      }
      const action = await vscode.window.showInformationMessage(`连接「${profile.name}」已保存`, '立即连接');
      if (action === '立即连接') {
        await connectById(deps, profile.id);
      }
    },
  });
}

/** 用表单值构造一个临时 profile，仅用于「测试连接」，不落盘。 */
function toTempProfile(
  values: ConnectionFormValues,
  existing: ConnectionProfile | undefined,
): ConnectionProfile {
  return {
    id: existing?.id ?? 'unsaved',
    name: values.name.trim() || '(未命名)',
    driver: values.driver,
    host: values.host.trim(),
    port: values.port,
    user: values.user.trim(),
    database: values.database.trim() || undefined,
    ssl: values.ssl,
    readOnly: values.readOnly,
    group: values.group.trim() || undefined,
    options: values.options,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
}

/** 表单顶部的环境说明与别名提示。 */
function buildFormContext(
  manager: ConnectionManager,
  env: RuntimeEnvironment,
): ConnectionFormHost['contextInfo'] {
  const aliases = [HOST_ALIAS_WINDOWS, HOST_ALIAS_WSL].map((alias) => {
    const resolution = manager.resolver.resolve(alias);
    return {
      alias,
      resolved: resolution.host,
      note: resolution.warning ?? resolution.note ?? '',
    };
  });
  const tips = env.isWSL
    ? ['数据库部署在 Windows 上时，主机填 __windows_host__']
    : ['数据库部署在 WSL 内时，主机填 __wsl_host__'];
  return {
    environment: `${env.describe} · 驱动进程：${
      manager.hostMode === 'sidecar' ? '独立子进程 (sidecar)' : '扩展宿主内 (in-process)'
    }`,
    aliases,
    tips,
  };
}

function toStringMap(options?: Record<string, string | number | boolean>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(options ?? {})) {
    result[key] = String(value);
  }
  return result;
}

function updateStatus(
  editor: vscode.TextEditor | undefined,
  status: vscode.StatusBarItem,
  store: ConnectionStore,
): void {
  if (!editor || editor.document.languageId !== 'sql') {
    status.hide();
    return;
  }
  const bound = documentTargets.get(editor.document.uri.toString());
  const profile = bound ? store.get(bound) : undefined;
  status.text = profile ? `$(database) ${profile.name}` : '$(database) 选择连接';
  status.tooltip = profile
    ? `当前文档目标连接：${profile.name}（${profile.user}@${profile.host}:${profile.port}）\n点击切换`
    : '当前文档未绑定连接，点击选择';
  status.show();
}

/** 生成环境诊断报告。 */
function buildDiagnostics(deps: CommandDeps): string[] {
  const { env, registry, manager, store, context } = deps;
  const resolver = manager.resolver;
  const lines: string[] = [
    '========== DBViewer 运行环境诊断 ==========',
    `时间            : ${new Date().toLocaleString()}`,
    `运行位置        : ${env.describe}`,
    `platform        : ${env.platform} / ${env.arch}`,
    `Node            : ${env.nodeVersion}`,
    `是否 WSL        : ${env.isWSL ? '是' : '否'}`,
    `WSL 发行版      : ${env.wslDistro ?? '-'}`,
    `WSL 版本        : ${env.wslVersion ?? '-'}`,
    `WSL 网络模式    : ${env.wslNetworkMode}`,
    `Windows 宿主 IP : ${env.windowsHostIp ?? '(未探测到)'}`,
    `WSL IP          : ${env.wslHostIp ?? '(未探测到)'}${env.wslHostIpDetected ? '' : '  (回退值，未实测)'}`,
    `外部命令探测    : ${vscode.workspace.getConfiguration('dbviewer').get('allowExternalCommand', false) ? '已开启' : '已关闭（默认，规避 wsl.exe 被拦截）'}`,
    `VS Code 远程类型: ${env.remoteKind}`,
    `扩展目录        : ${context.extensionPath}`,
    '',
    '---------- 主机别名解析 ----------',
  ];

  for (const alias of [HOST_ALIAS_WINDOWS, HOST_ALIAS_WSL]) {
    const resolution = resolver.resolve(alias);
    lines.push(`${alias.padEnd(18)}: ${resolution.host}${resolution.note ? `  // ${resolution.note}` : ''}`);
    if (resolution.warning) {
      lines.push(`${''.padEnd(18)}  ⚠ ${resolution.warning}`);
    }
  }

  lines.push('', '---------- 驱动 ----------', `驱动进程模式    : ${manager.hostMode}`);
  for (const definition of registry.list()) {
    lines.push(
      `${definition.id.padEnd(14)}: ${definition.displayName}  默认端口 ${definition.defaultPort}` +
        `  能力[列:${definition.capabilities.columns ? 'Y' : 'N'}` +
        ` schema:${definition.capabilities.schemas ? 'Y' : 'N'}` +
        ` ddl:${definition.capabilities.ddl ? 'Y' : 'N'}]`,
    );
  }

  lines.push('', '---------- 连接 ----------');
  for (const profile of store.list()) {
    const session = manager.session(profile.id);
    const resolution = resolver.resolve(profile.host);
    lines.push(
      `${profile.name.padEnd(20)} ${profile.driver} ${profile.user}@${profile.host}:${profile.port}` +
        `  状态=${session.state}` +
        (resolution.host !== profile.host ? `  实际连接=${resolution.host}` : ''),
    );
  }

  lines.push(
    '',
    '---------- 排查提示 ----------',
    '· Windows 与 WSL2 默认处于不同网络空间，跨环境访问不能使用 localhost。',
    '· 在 WSL 中访问 Windows 上的数据库：主机填 __windows_host__（解析为默认网关）。',
    '· 在 Windows 中访问 WSL 内的数据库：主机填 __wsl_host__（解析为发行版 IP）。',
    '· 镜像网络模式（WSL 2.0+ / .wslconfig 中 networkingMode=mirrored）下两者都可用 127.0.0.1。',
    '· 若数据库仅监听 127.0.0.1，跨环境必然失败：MySQL 调 bind-address、PG 调 listen_addresses。',
    '· 本机若禁止执行 wsl.exe，__wsl_host__ 无法自动解析，请手工填入 WSL 的 `hostname -I` 结果。',
    '',
    `工作区路径      : ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '-'}`,
    `扩展宿主路径分隔符: ${path.sep}`,
  );

  return lines;
}

// ---------------------------------------------------------------- 管理操作辅助函数

/** 管理类命令入口：与 SQL Shell 共用同一套「取目标连接」规则。 */
async function resolveProfileIdForManagement(deps: CommandDeps, node?: DbTreeItem): Promise<string | undefined> {
  return resolveProfileIdOrPrompt(deps, node, '选择目标连接');
}

/**
 * 取目标连接 id。
 *
 * 节点自带就用节点的（树视图右键）；否则唯一连接直接用、多个才让用户选。
 * shell、建库、建用户三个入口共享它，避免各自实现出不同的兜底行为。
 */
async function resolveProfileIdOrPrompt(
  deps: CommandDeps,
  node: DbTreeItem | undefined,
  title: string,
): Promise<string | undefined> {
  const { store } = deps;
  const profileId = node?.payload?.profileId;
  if (profileId && store.get(profileId)) {
    return profileId;
  }
  const profiles = store.list();
  if (profiles.length === 0) {
    await vscode.commands.executeCommand('dbviewer.addConnection');
    return undefined;
  }
  if (profiles.length === 1) {
    return profiles[0].id;
  }
  const picked = await vscode.window.showQuickPick(
    profiles.map((p) => ({ label: p.name, description: `${p.driver} · ${p.user}@${p.host}:${p.port}` })),
    { title },
  );
  if (!picked) {
    return undefined;
  }
  return profiles.find((p) => p.name === picked.label)?.id;
}

async function listManagementTargets(driver: import('../core/types').IDatabaseDriver, _driverId: string): Promise<string[]> {
  if (driver.capabilities.schemas) {
    return driver.listSchemas();
  }
  const databases = await driver.listDatabases();
  return databases.map((db) => db.name);
}

function parseGrantFormValues(grants: ManagementFormValues['grants']): GrantRequest[] {
  return grants
    .filter((g) => g.target.trim())
    .map((g) => ({
      target: g.target.trim(),
      table: g.table.trim() || undefined,
      privileges: g.privileges
        .split(/[,\s]+/)
        .map((p) => p.trim())
        .filter(Boolean),
    }));
}
