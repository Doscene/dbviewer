/**
 * 核心领域类型。
 *
 * 设计约束：本文件不得依赖 `vscode` 模块。
 * 驱动实现、sidecar 子进程都会引用这些类型，保持纯 Node 可移植性。
 */

/** 驱动标识，如 `mysql`、`postgresql`。第三方驱动可注册任意 id。 */
export type DriverId = string;

/** 持久化的连接配置（不含明文密码，密码单独走 secretStorage）。 */
export interface ConnectionProfile {
  id: string;
  name: string;
  driver: DriverId;
  /** 支持别名占位符，如 `__windows_host__` / `__wsl_host__`。 */
  host: string;
  port: number;
  user: string;
  database?: string;
  /** 是否启用 SSL/TLS。 */
  ssl?: boolean;
  /** 驱动私有参数，例如 MySQL 的 `charset`、PG 的 `application_name`。 */
  options?: Record<string, string | number | boolean>;
  /** 归属分组，仅用于树视图折叠归类。 */
  group?: string;
  /** 只读模式：拦截写语句。 */
  readOnly?: boolean;
  /** 是否已保存密码（真实密码在 SecretStorage）。 */
  hasPassword?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 连接配置的运行时视图：密码已注入，主机别名已解析。 */
export interface ResolvedConnection {
  profile: ConnectionProfile;
  /** 解析后的真实主机地址（用于建立 socket）。 */
  host: string;
  /** 主机解析的说明信息，用于 UI 提示。 */
  hostNote?: string;
  password?: string;
}

export interface DatabaseNode {
  name: string;
  /** 系统库（information_schema / postgres 等），UI 上折叠或弱化。 */
  isSystem?: boolean;
}

export interface TableNode {
  name: string;
  schema?: string;
  kind: 'table' | 'view';
}

export interface ColumnNode {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey?: boolean;
  defaultValue?: string | null;
  comment?: string;
}

/** 元数据查询的定位坐标（不同数据库的层级语义不同）。 */
export interface QueryTarget {
  database?: string;
  schema?: string;
}

export interface ExecuteOptions {
  /** 结果行数上限，`0` 表示不限制。 */
  limit: number;
  /** 单条语句超时（毫秒）。 */
  timeoutMs: number;
  /** 值类型转换：保证结果可安全序列化进 JSON（BigInt/Date/Buffer 等）。 */
  sanitize?: boolean;
}

/** 统一查询结果。所有驱动的输出都必须归一化成该结构。 */
export interface QueryResult {
  /** 语句产生的多个结果集（多语句执行时会有多个）。 */
  sets: ResultSet[];
  /** 总耗时（毫秒）。 */
  durationMs: number;
  /** 执行的原始 SQL。 */
  sql: string;
  /** 是否因达到 limit 被截断。 */
  truncated: boolean;
}

export interface ResultSet {
  /** 语句类型：SELECT / INSERT / UPDATE / DDL 等。 */
  statement: string;
  /** 产生该结果集的完整 SQL 文本，结果面板需要原样展示给用户。 */
  sql: string;
  fields: string[];
  rows: Record<string, unknown>[];
  /** SELECT 返回的行数；DML 返回受影响行数。 */
  rowCount: number;
  affectedRows?: number;
  notices?: string[];
}

/** 单元格编辑请求：结果面板改一格，最终落到驱动生成的一条 UPDATE。 */
export interface CellUpdateRequest {
  target: QueryTarget & { table: string };
  /** 主键列名 → 原值，构成 WHERE 条件；为空表示该表无法精确定位行。 */
  identity: Record<string, unknown>;
  /** 待更新的列名 → 新值。 */
  changes: Record<string, unknown>;
}

/** 单元格更新结果。 */
export interface CellUpdateResult {
  /** 实际下发的 SQL，回传给结果面板展示，便于用户核对改了什么。 */
  sql: string;
  affectedRows: number;
}

export interface DriverCapabilities {
  /** 支持列级元数据浏览。 */
  columns: boolean;
  /** 支持 schema 层级（PG 需要，MySQL 的 schema 即 database）。 */
  schemas: boolean;
  /** 支持查看建表语句。 */
  ddl: boolean;
  /** 支持多语句一次执行。 */
  multiStatement: boolean;
  /** 支持结果表格编辑（需要能依据主键生成单行 UPDATE）。 */
  editable: boolean;
  /** 支持删除表 / 数据库等管理操作。 */
  manageDatabase: boolean;
  /** 支持创建用户与授权。 */
  manageUser: boolean;
  /** 支持把表 / 库导出成备份文件。 */
  backup: boolean;
}

/** 驱动建立连接所需的完整入参。 */
export interface DriverConnectOptions {
  connection: ResolvedConnection;
  connectTimeoutMs: number;
  queryTimeoutMs: number;
}

/**
 * 数据库驱动契约。
 *
 * 新增一种数据库 = 实现该接口 + 注册到 DriverRegistry，无需改动其他任何模块。
 */
export interface IDatabaseDriver {
  readonly id: DriverId;
  readonly displayName: string;
  readonly defaultPort: number;
  /** 兼容的别名，用于 `driver` 字段的宽松匹配，例如 mysql 驱动接受 `mariadb`。 */
  readonly aliases?: string[];
  readonly capabilities: DriverCapabilities;

  connect(options: DriverConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  ping(): Promise<void>;

  listDatabases(): Promise<DatabaseNode[]>;
  listSchemas(database?: string): Promise<string[]>;
  listTables(target: QueryTarget): Promise<TableNode[]>;
  listColumns(target: QueryTarget & { table: string }): Promise<ColumnNode[]>;

  execute(sql: string, options: ExecuteOptions): Promise<QueryResult>;

  /** 生成 `SELECT ... LIMIT n` 预览语句；不实现则由上层拼接。 */
  previewSql?(target: QueryTarget & { table: string }, limit: number): string;
  /** 获取建表语句；`capabilities.ddl` 为 false 时可省略。 */
  showCreateTable?(target: QueryTarget & { table: string }): Promise<string | undefined>;
  /**
   * 执行单元格更新。当 `capabilities.editable` 为 true 时必须实现。
   *
   * 为什么由驱动完成「生成 SQL + 执行」这个整体动作，而不是上层先生成再执行：
   * 标识符引用符号（`` ` `` / `"`）与字符串字面量转义规则因数据库而异，通用层拼装
   * 极易产出跨方言错误甚至可注入的 SQL；同时该接口必须是异步的——sidecar 模式下
   * 驱动运行在子进程，任何同步方法都无法跨进程调用。
   */
  updateCell?(request: CellUpdateRequest, options: ExecuteOptions): Promise<CellUpdateResult>;

  /** 删除数据表；`capabilities.manageDatabase` 为 true 时实现。 */
  dropTable?(target: QueryTarget & { table: string }): Promise<void>;
  /** 删除数据库；`capabilities.manageDatabase` 为 true 时实现。 */
  dropDatabase?(name: string): Promise<void>;
  /** 创建数据库；`capabilities.manageDatabase` 为 true 时实现。 */
  createDatabase?(options: CreateDatabaseOptions): Promise<void>;
  /** 创建用户；`capabilities.manageUser` 为 true 时实现。 */
  createUser?(request: CreateUserRequest): Promise<void>;
  /** 授权；`capabilities.manageUser` 为 true 时实现。 */
  grantPrivileges?(request: CreateUserRequest): Promise<void>;
  /**
   * 产出备份文本片段；`capabilities.backup` 为 true 时实现。
   *
   * 为什么是「分块 + 游标」而不是「一次性返回整个 dump」：备份动辄上百 MB，
   * 一次性返回会同时撑爆驱动所在进程的内存与 IPC 通道（sidecar 模式下尤其明显）。
   * 分块后扩展侧可以边收边写盘，内存占用与库大小无关。
   *
   * 另一个关键点：这里**不能复用 `execute()`**。执行链路会把 Date / Buffer / BigInt
   * 洗成可 JSON 序列化的字符串（那是给结果面板用的），用它生成的 INSERT 会失真。
   * 备份路径必须拿到原始值，再用 `toBackupLiteral` 按方言转义。
   */
  backupChunks?(request: BackupChunkRequest): Promise<BackupChunk>;
}

/**
 * 驱动的静态元数据。
 *
 * 与实例分离存放，使得「新建连接」表单渲染驱动下拉框时无需加载任何驱动 SDK。
 */
export interface DriverDefinition {
  id: DriverId;
  displayName: string;
  defaultPort: number;
  /** 兼容别名，用于宽松匹配历史配置，如 `postgres` → `postgresql`。 */
  aliases?: string[];
  capabilities: DriverCapabilities;
  description?: string;
  /** 该驱动默认的连接串模板，用于 UI 提示。 */
  sampleHost?: string;
  /**
   * 树视图与表单中使用的图标（`media/` 目录下的文件名，如 `db-mysql.svg`）。
   * 第三方驱动同样可以携带自己的图标——因此这是数据而不是渲染分支。
   */
  icon?: string;
  /**
   * 可用的备份方式。与 `icon` 同理：命令层只负责把这份列表渲染成选项，
   * 不需要为每个数据库写分支，第三方驱动自带方式即可直接被支持。
   */
  backupModes?: BackupMode[];
  /** 原生备份工具的参数模板；存在时才提供需外部命令的备份方式。 */
  nativeBackup?: NativeBackupTool;
}

// ---------------------------------------------------------------- 备份

/**
 * 一种备份方式。
 *
 * 以数据形式声明，因此「这个数据库支持哪几种备份」对 UI 完全透明。
 */
export interface BackupMode {
  /** 稳定标识，驱动内部据此分发（`sql` / `schema` / `data` / `native`）。 */
  id: string;
  label: string;
  description?: string;
  /** 导出文件的扩展名，不含点。 */
  extension: string;
  /** 是否包含结构（DDL）。 */
  includesSchema: boolean;
  /** 是否包含数据（INSERT）。 */
  includesData: boolean;
  /**
   * 需要外部命令行工具时填写工具名（如 `mysqldump`）。
   * 这类方式受 `dbviewer.allowExternalCommand` 管控，默认关闭。
   */
  cliName?: string;
  /**
   * 适用的入口范围。原生工具方式通常只能整库导出（两种调用形态的参数结构不同），
   * 声明为 `database` 后就不会出现在表节点的右键菜单里。
   */
  scope?: 'database' | 'tables' | 'both';
}

/** 备份对象。视图只导出定义，不导出数据。 */
export interface BackupTarget extends QueryTarget {
  table: string;
  kind: 'table' | 'view';
}

/** 分块备份请求：驱动每次产出一段可直接追加写盘的 SQL 文本。 */
export interface BackupChunkRequest {
  modeId: string;
  tables: BackupTarget[];
  /** 上次返回的续传游标；`undefined` 表示从头开始。 */
  cursor?: string;
  /** 单块最多读取的行数。 */
  chunkRows: number;
  timeoutMs: number;
}

/** 备份分块：一段 SQL 文本 + 下次调用所需的游标。 */
export interface BackupChunk {
  /** 本块产出的 SQL 文本。 */
  text: string;
  /** 续传游标；`null` 表示已全部完成。 */
  nextCursor: string | null;
  /** 块内跳过的对象与原因（权限不足等）：会写入文件注释并汇总给用户。 */
  skipped?: BackupSkip[];
  /** 进度信息。 */
  progress?: BackupProgress;
}

export interface BackupProgress {
  /** 当前正在导出的对象名。 */
  table?: string;
  /** 已导出的行数（累计）。 */
  rows: number;
  /** 已完成的对象数。 */
  doneTables: number;
  /** 对象总数。 */
  totalTables: number;
}

export interface BackupSkip {
  name: string;
  reason: string;
}

/**
 * 原生备份工具的参数模板。
 *
 * 参数以数组形式给出、由平台层原样传给 `spawn`（`shell: false`），
 * 值永远不会被 shell 解释，命令层也不必为每种数据库写拼接分支。
 */
export interface NativeBackupTool {
  /** 可执行文件名，如 `mysqldump`。 */
  command: string;
  /**
   * 参数模板，支持 `${host}` `${port}` `${user}` `${database}` `${schema}` 占位符；
   * 单独成项的 `${tables}` 会展开为零个或多个参数。
   */
  args: string[];
  /** 密码环境变量名（`MYSQL_PWD` / `PGPASSWORD`）——密码绝不能出现在命令行参数里。 */
  passwordEnv: string;
}

/** 创建数据库的选项。 */
export interface CreateDatabaseOptions {
  name: string;
  /** MySQL 用字符集，PG 用编码名，为空时由驱动决定默认值。 */
  charset?: string;
  /** MySQL 排序规则。 */
  collation?: string;
}

/** 权限粒度。 */
export interface GrantRequest {
  /** 目标数据库（MySQL）或 schema（PG）。 */
  target: string;
  /** 目标表；为空表示该数据库 / schema 下的全部表。 */
  table?: string;
  /** 权限列表，如 ['ALL PRIVILEGES']、['SELECT', 'INSERT']。 */
  privileges: string[];
}

/** 创建用户并授权的一体化请求。 */
export interface CreateUserRequest {
  username: string;
  password: string;
  /** MySQL 的主机匹配模式，为空时使用 '%'。 */
  host?: string;
  /** 初始授权列表，为空则不授权。 */
  grants?: GrantRequest[];
}

/** 驱动构造函数签名，注册表按此实例化。 */
export type DriverFactory = () => IDatabaseDriver;

/** 归一化后的错误：驱动层负责把各家 SDK 的错误翻译成统一结构。 */
export class DatabaseError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}
