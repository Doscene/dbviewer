/**
 * Sidecar 驱动代理：在扩展宿主侧实现 `IDatabaseDriver`，把调用转发到子进程。
 *
 * 对上层（连接管理器、树视图、查询服务）而言，它与 in-process 驱动完全等价，
 * 因此「进程通信差异」被彻底隔离在本文件与 ProcessChannel 内，
 * 业务代码不需要写任何 `if (mode === 'sidecar')` 分支。
 *
 * 附带收益：sidecar 模式下扩展宿主完全不 require 驱动 SDK，
 * 若某个驱动安装失败或体积巨大，也不会影响编辑器启动性能。
 */

import { ProcessChannel } from '../platform/processChannel';
import {
  CellUpdateRequest,
  CellUpdateResult,
  ColumnNode,
  CreateDatabaseOptions,
  CreateUserRequest,
  DatabaseError,
  DatabaseNode,
  DriverCapabilities,
  DriverConnectOptions,
  DriverDefinition,
  ExecuteOptions,
  IDatabaseDriver,
  QueryResult,
  QueryTarget,
  TableNode,
} from '../core/types';

export interface SidecarProxyOptions {
  definition: DriverDefinition;
  /** 编译后的 `out/sidecar/host.js` 绝对路径。 */
  hostModulePath: string;
  /** 由连接管理器分配，用于在子进程内定位会话。 */
  connectionId: string;
  /** 单次 RPC 超时，应大于最长查询耗时。 */
  requestTimeoutMs: number;
  /** 子进程启动 / 退出事件回调，便于上层做重连与日志。 */
  onLog?: (line: string) => void;
}

export class SidecarDriverProxy implements IDatabaseDriver {
  readonly id: string;
  readonly displayName: string;
  readonly defaultPort: number;
  readonly aliases?: string[];
  readonly capabilities: DriverCapabilities;

  private readonly channel: ProcessChannel;
  private connected = false;

  constructor(private readonly options: SidecarProxyOptions) {
    this.id = options.definition.id;
    this.displayName = options.definition.displayName;
    this.defaultPort = options.definition.defaultPort;
    this.aliases = options.definition.aliases;
    this.capabilities = options.definition.capabilities;

    this.channel = new ProcessChannel({
      modulePath: options.hostModulePath,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    this.channel.on('stderr', (chunk: string) => options.onLog?.(chunk.trimEnd()));
    this.channel.on('exit', (code: number | null) => {
      this.connected = false;
      options.onLog?.(`驱动子进程退出（code=${code ?? 'null'}）`);
    });
  }

  async connect(options: DriverConnectOptions): Promise<void> {
    await this.channel.start();
    await this.channel.request('connect', {
      connectionId: this.options.connectionId,
      driver: this.id,
      options,
    });
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      if (this.channel.running) {
        await this.channel.request('disconnect', { connectionId: this.options.connectionId });
      }
    } catch {
      /* 子进程可能已退出，忽略 */
    }
    await this.channel.dispose();
  }

  isConnected(): boolean {
    return this.connected && this.channel.running;
  }

  async ping(): Promise<void> {
    await this.call('ping');
  }

  async listDatabases(): Promise<DatabaseNode[]> {
    return this.call<DatabaseNode[]>('listDatabases');
  }

  async listSchemas(database?: string): Promise<string[]> {
    return this.call<string[]>('listSchemas', { database });
  }

  async listTables(target: QueryTarget): Promise<TableNode[]> {
    return this.call<TableNode[]>('listTables', { target });
  }

  async listColumns(target: QueryTarget & { table: string }): Promise<ColumnNode[]> {
    return this.call<ColumnNode[]>('listColumns', { target });
  }

  async execute(sql: string, options: ExecuteOptions): Promise<QueryResult> {
    return this.call<QueryResult>('execute', { sql, options });
  }

  async showCreateTable(target: QueryTarget & { table: string }): Promise<string | undefined> {
    if (!this.capabilities.ddl) {
      return undefined;
    }
    return this.call<string | undefined>('showCreateTable', { target });
  }

  /**
   * 单元格更新同样转发到子进程执行。
   *
   * 注意这里传的是「请求」而不是「SQL 文本」：语句生成留在驱动内，
   * 保证 sidecar 与 inProcess 两种模式生成的 SQL 完全一致。
   */
  async updateCell(request: CellUpdateRequest, options: ExecuteOptions): Promise<CellUpdateResult> {
    if (!this.capabilities.editable) {
      throw new DatabaseError(`驱动「${this.id}」不支持结果编辑`, 'ENOT_EDITABLE');
    }
    return this.call<CellUpdateResult>('updateCell', { request, options });
  }

  async dropTable(target: QueryTarget & { table: string }): Promise<void> {
    if (!this.capabilities.manageDatabase) {
      throw new DatabaseError(`驱动「${this.id}」不支持删除表`, 'ENOT_MANAGE');
    }
    await this.call<void>('dropTable', { target });
  }

  async dropDatabase(name: string): Promise<void> {
    if (!this.capabilities.manageDatabase) {
      throw new DatabaseError(`驱动「${this.id}」不支持删除数据库`, 'ENOT_MANAGE');
    }
    await this.call<void>('dropDatabase', { name });
  }

  async createDatabase(options: CreateDatabaseOptions): Promise<void> {
    if (!this.capabilities.manageDatabase) {
      throw new DatabaseError(`驱动「${this.id}」不支持创建数据库`, 'ENOT_MANAGE');
    }
    await this.call<void>('createDatabase', { options });
  }

  async createUser(request: CreateUserRequest): Promise<void> {
    if (!this.capabilities.manageUser) {
      throw new DatabaseError(`驱动「${this.id}」不支持创建用户`, 'ENOT_MANAGE');
    }
    await this.call<void>('createUser', { request });
  }

  async grantPrivileges(request: CreateUserRequest): Promise<void> {
    if (!this.capabilities.manageUser) {
      throw new DatabaseError(`驱动「${this.id}」不支持授权`, 'ENOT_MANAGE');
    }
    await this.call<void>('grantPrivileges', { request });
  }

  previewSql(target: QueryTarget & { table: string }, limit: number): string {
    // 纯字符串拼接，无需跨进程；保持与驱动一致的输出格式
    const qualify = this.id === 'postgresql' ? `"${target.schema ?? 'public'}"."${target.table}"` : `\`${target.database ?? ''}\`.\`${target.table}\``;
    return `SELECT * FROM ${qualify} LIMIT ${limit};`;
  }

  private async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.channel.request<T>(method, { connectionId: this.options.connectionId, ...params });
    } catch (err) {
      // 进程通道错误与数据库错误统一抛出，上层只需处理一种异常类型
      throw err instanceof DatabaseError ? err : new DatabaseError((err as Error).message, (err as { code?: string }).code);
    }
  }
}
