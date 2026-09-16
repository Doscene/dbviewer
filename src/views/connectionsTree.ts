/**
 * 侧边栏连接树。
 *
 * 层级结构随驱动能力自适应——这是驱动可扩展性在 UI 上的体现：
 * - MySQL（`capabilities.schemas === false`）：连接 → 数据库 → 数据表 → 列
 * - PostgreSQL（`capabilities.schemas === true`）：连接 → schema → 数据表/视图 → 列
 *
 * 树节点全部懒加载，展开才发起元数据查询，避免连接后一次性打爆数据库。
 */

import * as vscode from 'vscode';

import { ConnectionManager, ConnectionSession } from '../core/connectionManager';
import { ConnectionStore } from '../core/connectionStore';
import { DriverRegistry } from '../core/driverRegistry';
import { ColumnNode, TableNode } from '../core/types';
import { RuntimeEnvironment } from '../platform/environment';

export type DbNodeKind = 'connection' | 'database' | 'schema' | 'table' | 'column' | 'message';

export interface DbNodePayload {
  kind: DbNodeKind;
  profileId?: string;
  database?: string;
  schema?: string;
  table?: string;
  tableKind?: 'table' | 'view';
  column?: ColumnNode;
  /** message 节点专用：错误文本。 */
  message?: string;
}

export class DbTreeItem extends vscode.TreeItem {
  constructor(
    readonly payload: DbNodePayload,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsibleState);
  }
}

export class ConnectionsTreeProvider implements vscode.TreeDataProvider<DbTreeItem> {
  private readonly changed = new vscode.EventEmitter<DbTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly store: ConnectionStore,
    private readonly env: RuntimeEnvironment,
    private readonly registry: DriverRegistry,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.manager.onDidChangeSession(() => this.refresh());
    this.store.onDidChange(() => this.refresh());
  }

  /**
   * 连接节点的图标取驱动自带的图标文件。
   *
   * 之所以是「数据」而不是分支判断：第三方驱动注册时自带 `icon` 文件名，
   * 树视图不需要知道 mysql / postgresql 的存在。缺图标时退回主题图标。
   */
  private driverIcon(driverId: string): vscode.Uri | vscode.ThemeIcon {
    const icon = this.registry.definition(driverId)?.icon;
    return icon ? vscode.Uri.joinPath(this.extensionUri, 'media', icon) : new vscode.ThemeIcon('database');
  }

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(element: DbTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DbTreeItem): Promise<DbTreeItem[]> {
    try {
      if (!element) {
        return this.connectionNodes();
      }
      const payload = element.payload;
      switch (payload.kind) {
        case 'connection':
          return await this.connectionChildren(payload.profileId!);
        case 'database':
        case 'schema':
          return await this.tableNodes(payload);
        case 'table':
          return await this.columnNodes(payload);
        default:
          return [];
      }
    } catch (err) {
      return [messageItem(friendlyError(err))];
    }
  }

  // ------------------------------------------------------------------ 各层构建

  private connectionNodes(): DbTreeItem[] {
    const profiles = this.store.list();
    if (profiles.length === 0) {
      return [];
    }
    return profiles.map((profile) => {
      const session = this.manager.session(profile.id);
      const item = new DbTreeItem(
        { kind: 'connection', profileId: profile.id },
        profile.name,
        session.state === 'connected'
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      const target = `${profile.user}@${profile.host}:${profile.port}${profile.database ? `/${profile.database}` : ''}`;
      item.description = session.state === 'connected' ? target : `${target} · ${stateText(session.state)}`;
      item.contextValue =
        session.state === 'connected'
          ? 'dbviewer.connectionConnected'
          : session.state === 'connecting'
            ? 'dbviewer.connectionConnecting'
            : 'dbviewer.connectionDisconnected';
      // 图标表达「这是什么数据库」，状态由 description 承担——
      // 图标换成主题图标会让用户认不出连接类型，反而丢失信息
      item.iconPath = this.driverIcon(profile.driver);
      item.tooltip = buildConnectionTooltip(profile.name, target, session, this.env);
      item.id = `conn:${profile.id}`;
      // 未连接时点一下就连——树视图本身只有单击事件，没有双击回调，
      // 用 command 挂在单击上是最接近"点开它"的原生做法。
      // 已连接的节点不挂 command：那里单击应当只是选中/展开。
      if (session.state !== 'connected' && session.state !== 'connecting') {
        item.command = {
          command: 'dbviewer.connect',
          title: '连接',
          arguments: [item],
        };
      }
      return item;
    });
  }

  private async connectionChildren(profileId: string): Promise<DbTreeItem[]> {
    const session = this.manager.session(profileId);
    if (session.state !== 'connected' || !session.driver) {
      return [];
    }
    const driver = session.driver;

    if (driver.capabilities.schemas) {
      const schemas = await driver.listSchemas(session.profile.database);
      return schemas.map((name) => {
        const item = new DbTreeItem(
          { kind: 'schema', profileId, database: session.profile.database, schema: name },
          name,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.contextValue = 'dbviewer.schema';
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.tooltip = `${session.profile.database ?? ''}.${name}`;
        return item;
      });
    }

    const databases = await driver.listDatabases();
    return databases.map((db) => {
      const item = new DbTreeItem(
        { kind: 'database', profileId, database: db.name },
        db.name,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.contextValue = 'dbviewer.database';
      item.iconPath = new vscode.ThemeIcon('database');
      item.description = db.isSystem ? '系统库' : undefined;
      return item;
    });
  }

  private async tableNodes(payload: DbNodePayload): Promise<DbTreeItem[]> {
    const session = this.manager.session(payload.profileId!);
    if (session.state !== 'connected' || !session.driver) {
      return [];
    }
    const tables = await session.driver.listTables({
      database: payload.database,
      schema: payload.schema,
    });
    return tables.map((table) => tableItem(payload, table));
  }

  private async columnNodes(payload: DbNodePayload): Promise<DbTreeItem[]> {
    const session = this.manager.session(payload.profileId!);
    if (session.state !== 'connected' || !session.driver) {
      return [];
    }
    const columns = await session.driver.listColumns({
      database: payload.database,
      schema: payload.schema,
      table: payload.table!,
    });
    return columns.map((column) => {
      const flags: string[] = [column.dataType];
      if (column.isPrimaryKey) {
        flags.push('PK');
      }
      if (!column.nullable) {
        flags.push('NOT NULL');
      }
      const item = new DbTreeItem(
        {
          kind: 'column',
          profileId: payload.profileId,
          database: payload.database,
          schema: payload.schema,
          table: payload.table,
          column,
        },
        column.name,
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = flags.join(' · ');
      item.contextValue = 'dbviewer.column';
      item.iconPath = new vscode.ThemeIcon(column.isPrimaryKey ? 'key' : 'symbol-field');
      item.tooltip = new vscode.MarkdownString(
        [
          `**${column.name}**`,
          '',
          `- 类型：\`${column.dataType}\``,
          `- 可空：${column.nullable ? '是' : '否'}`,
          `- 主键：${column.isPrimaryKey ? '是' : '否'}`,
          column.defaultValue ? `- 默认值：\`${column.defaultValue}\`` : '',
          column.comment ? `- 注释：${column.comment}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return item;
    });
  }
}

function tableItem(parent: DbNodePayload, table: TableNode): DbTreeItem {
  const item = new DbTreeItem(
    {
      kind: 'table',
      profileId: parent.profileId,
      database: parent.database,
      schema: table.schema ?? parent.schema,
      table: table.name,
      tableKind: table.kind,
    },
    table.name,
    vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.contextValue = table.kind === 'view' ? 'dbviewer.view' : 'dbviewer.table';
  item.iconPath = new vscode.ThemeIcon(table.kind === 'view' ? 'list-flat' : 'table');
  item.tooltip = `${table.schema ? `${table.schema}.` : ''}${table.name}`;
  item.command = {
    command: 'dbviewer.showTableData',
    title: '查看数据',
    arguments: [item],
  };
  return item;
}

function messageItem(message: string): DbTreeItem {
  const item = new DbTreeItem({ kind: 'message', message }, message.split('\n')[0], vscode.TreeItemCollapsibleState.None);
  item.contextValue = 'dbviewer.message';
  item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
  item.tooltip = message;
  return item;
}

/**
 * 连接节点的富文本提示。
 *
 * 这是排查「Windows / WSL 到底连到了哪台机器」的第一现场：
 * 把解析前后的主机地址、解析依据、潜在风险一次性摊开。
 */
function buildConnectionTooltip(
  name: string,
  target: string,
  session: ConnectionSession,
  env: RuntimeEnvironment,
): vscode.MarkdownString {
  const lines: string[] = [`**${name}**`, '', `- 目标：\`${target}\``, `- 状态：${stateText(session.state)}`];
  if (session.resolvedHost && session.resolvedHost !== session.profile.host) {
    lines.push(`- 主机解析：\`${session.profile.host}\` → \`${session.resolvedHost}\``);
  }
  if (session.hostNote) {
    lines.push(`- 解析说明：${session.hostNote}`);
  }
  lines.push(`- 运行环境：${env.describe}`);
  lines.push(`- 驱动进程：${session.mode === 'sidecar' ? '独立子进程 (sidecar)' : '扩展宿主内 (in-process)'}`);
  if (session.connectedAt) {
    lines.push(`- 建立于：${new Date(session.connectedAt).toLocaleTimeString()}`);
  }
  if (session.error) {
    lines.push('', `**错误**`, '', '```text', session.error, '```');
  }
  for (const warning of session.hostWarnings) {
    lines.push('', `> ⚠️ ${warning}`);
  }
  const md = new vscode.MarkdownString(lines.join('\n'));
  md.supportThemeIcons = true;
  return md;
}

function stateText(state: ConnectionSession['state']): string {
  switch (state) {
    case 'connected':
      return '已连接';
    case 'connecting':
      return '连接中…';
    case 'error':
      return '连接失败';
    default:
      return '未连接';
  }
}

function friendlyError(err: unknown): string {
  const e = err as { message?: string; code?: string };
  const message = e?.message ?? String(err);
  const detail = e?.code ? `（${e.code}）` : '';
  return `加载失败${detail}：${message}`;
}
