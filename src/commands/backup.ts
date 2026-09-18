/**
 * 备份命令。
 *
 * 只负责 UI 与落盘：收集范围 → 选方式 → 选路径 → 显示进度 → 汇总。
 * 分块推进、游标、跳过汇总在 `core/backup.ts`，方言 SQL 在驱动层，
 * 需要外部命令的原生方式走 `platform/externalTool.ts`——这一层因此没有一句 SQL 拼接，
 * 也没有任何 `if (driver === 'mysql')` 式分支。
 *
 * 单独成文件而不是塞进 `commands/index.ts`：后者已经承载连接、查询、面板、管理等全部入口，
 * 而备份自带一套「方式选择 + 进度 + 文件写入」的流程，独立出来更好读。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  BackupNodeLike,
  BackupRunResult,
  BackupSink,
  BackupSource,
  MemorySink,
  buildBackupFileName,
  buildBackupHeader,
  buildSkippedNotes,
  collectBackupTargets,
  filterBackupModesForScope,
  runBackup,
  toBackupTargets,
} from '../core/backup';
import { BackupMode, BackupTarget, IDatabaseDriver } from '../core/types';
import { expandNativeArgs, runExternalTool } from '../platform/externalTool';
import type { CommandDeps } from './index';

/** 入口范围。schema 与 database 分开，是因为原生工具给不出 schema 级备份。 */
type BackupScope = 'database' | 'schema' | 'tables';

type BackupOutcome = 'done' | 'cancelled' | 'failed';

/** 树节点在命令层的最小形状：与 views 层的 DbTreeItem 结构兼容。 */
interface TreeNodeLike {
  payload?: {
    kind?: string;
    profileId?: string;
    database?: string;
    schema?: string;
    table?: string;
    tableKind?: 'table' | 'view';
  };
}

interface BackupFlowOptions {
  profileId: string;
  scope: BackupScope;
  targets: BackupTarget[];
  /** 进度与提示里的范围描述，如「数据库 shop」。 */
  scopeLabel: string;
  /** 文件名主体。 */
  baseName: string;
  /** 原生工具需要的库 / schema。 */
  native: { database?: string; schema?: string };
}

export function registerBackupCommands(deps: CommandDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      'dbviewer.backupTables',
      (node?: TreeNodeLike, selected?: TreeNodeLike[]) => backupTables(deps, node, selected),
    ),
    vscode.commands.registerCommand('dbviewer.backupDatabase', (node?: TreeNodeLike) =>
      backupDatabase(deps, node),
    ),
  ];
}

// ---------------------------------------------------------------- 入口

/**
 * 备份选中的数据表（支持树视图多选）。
 *
 * 多选时 VS Code 把「右键点中的那一项」放在第一个参数、全部选中项放在第二个参数。
 * 若点中的项不在选中集合里（右键了一个未勾选的节点），以点中的项为准——
 * 那才是用户当下的意图；反过来若它已在集合里，就不要重复计入。
 */
async function backupTables(
  deps: CommandDeps,
  node?: TreeNodeLike,
  selected?: TreeNodeLike[],
): Promise<void> {
  const collected = collectBackupTargets(pickNodes(node, selected));
  if (collected.problem || !collected.profileId) {
    vscode.window.showWarningMessage(collected.problem ?? '没有可备份的对象');
    return;
  }
  await runBackupFlow(deps, {
    profileId: collected.profileId,
    scope: 'tables',
    targets: collected.targets,
    scopeLabel: `${collected.targets.length} 个数据表`,
    baseName: defaultBaseName(deps, collected.profileId, collected.database ?? collected.schema),
    native: { database: collected.database, schema: collected.schema },
  });
}

/** 备份整个数据库（MySQL 库节点）/ 整个 schema（PG）/ 当前连接的整个库。 */
async function backupDatabase(deps: CommandDeps, node?: TreeNodeLike): Promise<void> {
  const payload = node?.payload;
  const profileId = payload?.profileId;
  if (!profileId) {
    return;
  }
  const profile = deps.store.get(profileId);
  if (!profile) {
    return;
  }

  const database = payload?.kind === 'database' ? payload.database : undefined;
  const schema = payload?.kind === 'schema' ? payload.schema : undefined;

  let targets: BackupTarget[];
  try {
    const { session } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在读取对象列表…', cancellable: false },
      () => deps.manager.connect(profileId),
    );
    const driver = session.driver;
    if (!driver) {
      vscode.window.showWarningMessage('连接未就绪，请重试');
      return;
    }
    // 连接节点入口不带 schema，即「该连接可见的全部 schema」
    const tables = await driver.listTables({ database, schema });
    if (tables.length === 0) {
      vscode.window.showWarningMessage('该范围内没有任何可备份的对象');
      return;
    }
    targets = toBackupTargets({ database, schema }, tables);
  } catch (err) {
    vscode.window.showErrorMessage(`读取对象列表失败：${(err as Error).message}`);
    return;
  }

  const scope: BackupScope = schema ? 'schema' : 'database';
  const label = schema
    ? `schema ${schema}`
    : `数据库 ${database ?? profile.database ?? '(当前连接默认库)'}`;

  await runBackupFlow(deps, {
    profileId,
    scope,
    targets,
    scopeLabel: label,
    baseName: defaultBaseName(deps, profileId, schema ?? database),
    native: { database: database ?? profile.database, schema },
  });
}

// ---------------------------------------------------------------- 主流程

async function runBackupFlow(deps: CommandDeps, options: BackupFlowOptions): Promise<void> {
  const { store, registry, output } = deps;
  const profile = store.get(options.profileId);
  if (!profile) {
    return;
  }
  const definition = registry.definition(profile.driver);
  if (!definition?.capabilities.backup) {
    vscode.window.showWarningMessage(`驱动「${definition?.displayName ?? profile.driver}」不支持备份`);
    return;
  }

  let modes = filterBackupModesForScope(definition.backupModes ?? [], options.scope).filter(
    (mode) => !mode.cliName || !!definition.nativeBackup,
  );
  if (modes.length === 0) {
    vscode.window.showWarningMessage('该驱动没有可用的备份方式');
    return;
  }

  // 原生方式需要外部命令，默认关闭；用户拒绝后自动退回内置方式，不必重跑一次命令
  let mode: BackupMode | undefined;
  for (;;) {
    const picked = await vscode.window.showQuickPick(
      modes.map((item) => ({
        label: item.label,
        description: item.cliName ? `需外部命令 ${item.cliName}` : '内置',
        detail: item.description,
        mode: item,
      })),
      { title: `备份 ${options.scopeLabel}`, placeHolder: '选择备份方式' },
    );
    if (!picked) {
      return;
    }
    if (!picked.mode.cliName || allowExternalCommand()) {
      mode = picked.mode;
      break;
    }
    const action = await vscode.window.showWarningMessage(
      `「${picked.mode.label}」需要调用外部命令 ${picked.mode.cliName}，当前被 dbviewer.allowExternalCommand 关闭。`,
      { modal: true },
      '改用内置方式',
      '打开设置',
    );
    if (action === '打开设置') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'dbviewer.allowExternalCommand',
      );
      return;
    }
    if (action !== '改用内置方式') {
      return;
    }
    modes = modes.filter((item) => !item.cliName);
    if (modes.length === 0) {
      return;
    }
  }

  const saveUri = await vscode.window.showSaveDialog({
    title: `保存备份（${options.scopeLabel}）`,
    defaultUri: defaultSaveUri(buildBackupFileName({ base: options.baseName, mode })),
    filters: { 备份文件: [mode.extension], 所有文件: ['*'] },
  });
  if (!saveUri) {
    return;
  }

  const outcome =
    mode.cliName && definition.nativeBackup
      ? await runNativeBackup(deps, options, definition.nativeBackup, saveUri)
      : await runBuiltinBackup(deps, options, mode, saveUri);

  if (outcome === 'done') {
    output.appendLine(`[backup] ${options.scopeLabel} · ${mode.label} → ${saveUri.fsPath}`);
  }
}

// ---------------------------------------------------------------- 内置方式

async function runBuiltinBackup(
  deps: CommandDeps,
  options: BackupFlowOptions,
  mode: BackupMode,
  saveUri: vscode.Uri,
): Promise<BackupOutcome> {
  const { manager, store, registry } = deps;
  const profile = store.get(options.profileId);
  if (!profile) {
    return 'failed';
  }

  let driver: IDatabaseDriver | undefined;
  try {
    const { session } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在建立备份连接…', cancellable: false },
      () => manager.connect(options.profileId),
    );
    driver = session.driver;
  } catch (err) {
    vscode.window.showErrorMessage(`备份失败：${(err as Error).message}`);
    return 'failed';
  }
  // 备份编排在闭包里推进，而闭包内 TS 不保留对 let 变量的收窄：先把驱动与备份方法
  // 取到 const 上，闭包内类型才是确定的「已定义」，也不必写非空断言。
  // 驱动实现里 backupChunks 依赖 this，所以仍以 .call 绑定原驱动对象。
  const backupDriver = driver;
  if (!backupDriver) {
    vscode.window.showErrorMessage('备份失败：未能建立驱动会话');
    return 'failed';
  }
  const backupChunks = backupDriver.backupChunks;
  if (!backupChunks) {
    vscode.window.showWarningMessage('当前驱动未实现备份能力');
    return 'failed';
  }
  const source: BackupSource = { backupChunks: (request) => backupChunks.call(backupDriver, request) };

  const views = options.targets.filter((target) => target.kind === 'view').length;
  const header = buildBackupHeader({
    connectionName: profile.name,
    driverName: registry.definition(profile.driver)?.displayName ?? profile.driver,
    scope: options.scopeLabel,
    modeLabel: mode.label,
    tableCount: options.targets.length - views,
    viewCount: views,
    generator: 'DBViewer 内置导出（逐表 SELECT）',
  });

  const sink = createSink(saveUri);
  const cancellation = new vscode.CancellationTokenSource();
  let lastPercent = 0;
  let result: BackupRunResult | undefined;
  let failure: Error | undefined;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在备份 ${options.scopeLabel}`,
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => cancellation.cancel());
        try {
          await sink.write(header);
          result = await runBackup({
            source,
            modeId: mode.id,
            tables: options.targets,
            sink,
            // 单块读取超时：大表一整张读不完也不算失败，下一块继续；
            // 这里给的是「一块卡住多久算卡死」的上限
            timeoutMs: Math.max(30_000, manager.queryTimeoutMs),
            token: cancellation.token,
            onProgress: (info) => {
              const percent = info.totalTables
                ? Math.floor((info.doneTables / info.totalTables) * 100)
                : 0;
              progress.report({
                message: `${info.doneTables}/${info.totalTables} 张表 · 已导出 ${info.rows} 行${
                  info.table ? ` · ${info.table}` : ''
                }`,
                increment: Math.max(0, percent - lastPercent),
              });
              lastPercent = percent;
            },
          });
        } catch (err) {
          failure = err as Error;
          await sink.abort().catch(() => undefined);
        }
      },
    );
  } finally {
    cancellation.dispose();
  }

  if (failure) {
    vscode.window.showErrorMessage(`备份失败：${failure.message}`);
    return 'failed';
  }
  if (!result) {
    return 'failed';
  }
  if (result.cancelled) {
    vscode.window.showInformationMessage('备份已取消，未完成的文件已清理。');
    return 'cancelled';
  }

  if (result.skipped.length) {
    deps.output.appendLine(`[backup] 跳过 ${result.skipped.length} 个对象：`);
    for (const item of result.skipped) {
      deps.output.appendLine(`  · ${item.name}：${item.reason}`);
    }
    // 把跳过明细补进文件尾部：还原时若发现少了东西，文件自己会说明原因
    await appendToFile(saveUri, buildSkippedNotes(result.skipped));
  }

  const skippedText = result.skipped.length ? `，跳过 ${result.skipped.length} 个对象` : '';
  const action = await vscode.window.showInformationMessage(
    `备份完成：${result.tables} 个对象 / ${result.rows} 行 / ${formatBytes(result.bytes)}${skippedText}`,
    ...(result.skipped.length ? ['查看日志'] : []),
    '打开所在文件夹',
  );
  if (action === '查看日志') {
    deps.output.show(true);
  } else if (action === '打开所在文件夹') {
    await vscode.commands.executeCommand('revealFileInOS', saveUri);
  }
  return 'done';
}

// ---------------------------------------------------------------- 原生方式

async function runNativeBackup(
  deps: CommandDeps,
  options: BackupFlowOptions,
  tool: { command: string; args: string[]; passwordEnv: string },
  saveUri: vscode.Uri,
): Promise<BackupOutcome> {
  const { manager, store } = deps;
  const profile = store.get(options.profileId);
  if (!profile) {
    return 'failed';
  }
  if (saveUri.scheme !== 'file') {
    vscode.window.showWarningMessage('原生工具只能写入本地文件，请选择一个本地路径。');
    return 'failed';
  }

  const database = options.native.database;
  if (!database) {
    vscode.window.showWarningMessage(
      `原生 ${tool.command} 需要明确的数据库名：请在连接配置里指定默认数据库，或从数据库节点发起备份。`,
    );
    return 'failed';
  }

  const session = manager.session(options.profileId);
  const password = await store.getPassword(profile.id);
  const args = expandNativeArgs(tool.args, {
    // 用解析后的真实地址：原生工具与插件在同一台机器上，但它不认识 __wsl_host__ 这类别名
    host: session.resolvedHost ?? profile.host,
    port: profile.port,
    user: profile.user,
    database,
    schema: options.native.schema,
    // 原生方式的模板一律整库导出（definitions.ts 里声明 scope: 'database'），
    // 由 filterBackupModesForScope 保证它不会出现在表节点入口，因此这里没有表名可填。
    tables: [],
  });

  try {
    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在调用 ${tool.command} 备份 ${database}`,
        cancellable: true,
      },
      (_progress, token) =>
        runExternalTool({
          command: configuredToolPath(tool.command) ?? tool.command,
          args,
          // 密码只走环境变量：命令行参数在进程列表里对同机其他用户可见
          env: password ? { [tool.passwordEnv]: password } : undefined,
          stdoutFile: saveUri.fsPath,
          // 原生工具在导出大库时可能跑几十分钟，超时上限给得比交互查询宽得多
          timeoutMs: Math.max(10 * 60_000, manager.queryTimeoutMs * 10),
          token,
        }),
    );

    if (outcome.cancelled) {
      await fs.promises.unlink(saveUri.fsPath).catch(() => undefined);
      vscode.window.showInformationMessage('备份已取消，未完成的文件已清理。');
      return 'cancelled';
    }
    const action = await vscode.window.showInformationMessage(
      `${tool.command} 备份完成：${formatBytes(outcome.bytes)}`,
      '打开所在文件夹',
    );
    if (action === '打开所在文件夹') {
      await vscode.commands.executeCommand('revealFileInOS', saveUri);
    }
    return 'done';
  } catch (err) {
    deps.output.appendLine(`[backup] ${(err as Error).message}`);
    const action = await vscode.window.showErrorMessage(
      `备份失败：${(err as Error).message.split('\n')[0]}`,
      '查看日志',
    );
    if (action === '查看日志') {
      deps.output.show(true);
    }
    return 'failed';
  }
}

// ---------------------------------------------------------------- 落盘

/**
 * 文件 sink。
 *
 * 用 Node 流逐块写盘，而不是攒完再调 `workspace.fs.writeFile`：备份可能上百 MB，
 * 全量攒在内存里既慢又危险。只有目标不是本地文件（虚拟文件系统 / 远程）时才退回内存模式，
 * 那时 `close()` 一次性落盘。
 */
class FileSink implements BackupSink {
  private stream?: fs.WriteStream;
  private readonly memory = new MemorySink();

  constructor(private readonly uri: vscode.Uri) {}

  private get localFile(): boolean {
    return this.uri.scheme === 'file' && !!this.uri.fsPath;
  }

  async write(text: string): Promise<void> {
    if (!this.localFile) {
      await this.memory.write(text);
      return;
    }
    if (!this.stream) {
      await fs.promises.mkdir(path.dirname(this.uri.fsPath), { recursive: true });
      this.stream = fs.createWriteStream(this.uri.fsPath, { encoding: 'utf8' });
    }
    const stream = this.stream;
    // 用回调形式而不是 await stream.write()：回调触发时才代表这一块真正落盘，
    // 否则「进度显示 100%」与「内容确实写完了」会脱节
    await new Promise<void>((resolve, reject) => {
      stream.write(text, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (!this.localFile) {
      await this.memory.close();
      await vscode.workspace.fs.writeFile(this.uri, Buffer.from(this.memory.text, 'utf8'));
      return;
    }
    const stream = this.stream;
    this.stream = undefined;
    if (!stream) {
      // 连文件头都没写进去（例如范围内一个对象都没有），落一个空文件比什么都不留清楚
      await vscode.workspace.fs.writeFile(this.uri, Buffer.alloc(0));
      return;
    }
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject);
      stream.end(() => resolve());
    });
  }

  /**
   * 中止：删掉半成品。
   *
   * 一个被截断的 .sql 看起来是完整的，导入到一半才报语法错——比起没有文件，
   * 它更容易让人误以为「备份是好的」。
   */
  async abort(): Promise<void> {
    if (!this.localFile) {
      await this.memory.abort();
      return;
    }
    const stream = this.stream;
    this.stream = undefined;
    if (stream) {
      stream.destroy();
    }
    await fs.promises.unlink(this.uri.fsPath).catch(() => undefined);
  }
}

function createSink(uri: vscode.Uri): BackupSink {
  return new FileSink(uri);
}

async function appendToFile(uri: vscode.Uri, text: string): Promise<void> {
  if (!text || uri.scheme !== 'file' || !uri.fsPath) {
    return;
  }
  await fs.promises.appendFile(uri.fsPath, text, 'utf8').catch(() => undefined);
}

// ---------------------------------------------------------------- 辅助

function pickNodes(node: TreeNodeLike | undefined, selected: TreeNodeLike[] | undefined): BackupNodeLike[] {
  const list = (selected ?? []).filter(Boolean);
  const effective = node && !list.includes(node) ? [node, ...list] : list.length ? list : node ? [node] : [];
  return effective.map((item) => ({
    kind: item.payload?.kind ?? '',
    profileId: item.payload?.profileId,
    database: item.payload?.database,
    schema: item.payload?.schema,
    table: item.payload?.table,
    tableKind: item.payload?.tableKind,
  }));
}

function defaultBaseName(deps: CommandDeps, profileId: string, qualifier?: string): string {
  const name = deps.store.get(profileId)?.name ?? 'db';
  return qualifier ? `${name}-${qualifier}` : name;
}

function defaultSaveUri(fileName: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder
    ? vscode.Uri.joinPath(folder, fileName)
    : vscode.Uri.file(path.join(os.homedir(), fileName));
}

function allowExternalCommand(): boolean {
  return vscode.workspace.getConfiguration('dbviewer').get<boolean>('allowExternalCommand', false);
}

function configuredToolPath(command: string): string | undefined {
  const map = vscode.workspace.getConfiguration('dbviewer').get<Record<string, string>>('backupToolPaths', {});
  const value = map?.[command];
  return value && value.trim() ? value.trim() : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
