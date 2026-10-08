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

// ---------------------------------------------------------------- 对象属性编辑

/** 属性对应的界面控件类型。 */
export type EditablePropertyKind = 'text' | 'number' | 'select' | 'textarea' | 'switch';

/**
 * 一条可编辑属性（表级选项 / 库级选项）。
 *
 * 为什么以数据形式下发而不是在面板里写死字段：各家数据库能改的东西差别极大
 * （MySQL 有 ENGINE / 字符集 / 排序规则，PostgreSQL 只有属主与注释），
 * 声明式下发后，新增驱动不需要改任何界面代码，也不会出现「界面显示了但驱动不认」。
 *
 * 约定：
 * - 键名 `name` 保留给「对象名」（表名 / 库名 / schema 名），命令层据此识别重命名；
 * - `kind === 'switch'` 的取值统一为 `'1'` / `'0'`（差异比较是字符串比较，
 *   界面按 `'1'` 回传，驱动不要用 `'true'` 之类的写法，否则「没动过」也会被判成有变化）。
 */
export interface EditableProperty {
  key: string;
  label: string;
  value: string;
  kind: EditablePropertyKind;
  /** `kind === 'select'` 时的候选值。 */
  options?: string[];
  placeholder?: string;
  hint?: string;
  /** false 表示仅展示不可改（例如 PostgreSQL 的库编码）。 */
  editable?: boolean;
}

/**
 * 默认值的语义。
 *
 * 为什么要在文本之外单独给一个语义位：默认值文本本身是歧义的 —— MySQL 的 `now()`
 * 既可能是「字面量字符串」也可能是「函数调用」，PG 的 `'abc'::character varying`
 * 又只能按表达式原样写回。只靠文本形态推断，界面就没法表达「这就是个常量」。
 * 缺省（未触碰）时驱动仍按文本形态推断，第三方调用方与旧行为不受影响。
 */
export type DefaultKind = 'none' | 'constant' | 'expression';

/**
 * 列定义：既是读回来的现状，也是提交回去的目标状态。
 *
 * `originalName` 是「这一行原本是哪一列」的唯一凭据：没有它就无法区分
 * 「把 a 改名成 b」与「删掉 a、新增 b」，而后者会连同列上的数据一起丢掉。
 * 因此它只由驱动读回来的结果填充，界面只负责原样回传。
 */
export interface TableColumnDefinition {
  name: string;
  /** 完整类型文本，如 `varchar(255)` / `character varying(255)`。 */
  dataType: string;
  nullable: boolean;
  /** 默认值表达式原文；`null` / 缺省表示没有默认值。 */
  defaultValue?: string | null;
  /**
   * 界面显式声明的默认值语义；缺省表示「用户没动过」，驱动按文本形态推断
   * （见 `DefaultKind` 的说明）。
   */
  defaultKind?: DefaultKind;
  comment?: string;
  isPrimaryKey?: boolean;
  autoIncrement?: boolean;
  /** 读回来的原始列名；新增列为空。 */
  originalName?: string;
  /**
   * 驱动读回、必须原样保留的额外列子句（MySQL 的 `ON UPDATE CURRENT_TIMESTAMP`）。
   *
   * 单列一个字段的理由：这种子句不体现在类型 / 默认值 / 可空里，改写别的属性时一旦漏掉，
   * 就是**静默改变表行为**（时间戳列不再自动更新），而服务端一句话都不会报。
   * 界面不解释它的语义，只负责原样带回。
   */
  extraClauses?: string;
  /** 读回来的位置（从 1 开始），仅用于界面展示与列序比较。 */
  ordinal?: number;
}

/** 表结构描述（`IDatabaseDriver.describeTable` 的返回值）。 */
export interface TableStructure {
  target: QueryTarget & { table: string };
  columns: TableColumnDefinition[];
  /** 表级可编辑属性（含名为 `name` 的对象名属性）。 */
  properties: EditableProperty[];
  /** 数据类型候选；为空表示由用户自由填写。 */
  dataTypes?: string[];
  /** 界面无法提供的编辑能力及原因，直接展示给用户。 */
  limitations: string[];
  /** 是否支持调整列顺序（PostgreSQL 的列序由物理位置决定，没有 AFTER 语义）。 */
  allowReorder: boolean;
  /** 是否支持切换自增（PostgreSQL 的既有列无法就地转成 serial）。 */
  allowAutoIncrement: boolean;
  /**
   * 是否支持 `ON UPDATE CURRENT_TIMESTAMP` 开关（目前只有 MySQL）。
   *
   * 与 `allowReorder` 同样是「驱动给界面的数据」：视图层据此决定要不要渲染开关，
   * 不得按驱动名分支。缺省视为不支持。
   */
  allowAutoUpdate?: boolean;
  /** 驱动给的建表语句，供用户在应用前核对。 */
  ddl?: string;
}

/** 库 / schema 定位（树视图层级里没有「数据库」节点的驱动用 schema 代替）。 */
export interface DatabaseObjectTarget {
  /** MySQL：数据库名；PostgreSQL：schema 名。 */
  name: string;
  kind: 'database' | 'schema';
  /** 所属数据库（PostgreSQL 的 schema 挂在库下；MySQL 忽略）。 */
  database?: string;
}

/** 库 / schema 属性描述。 */
export interface DatabaseProperties {
  target: DatabaseObjectTarget;
  /** 对象类别文案：数据库 / Schema。 */
  label: string;
  properties: EditableProperty[];
  limitations: string[];
}

/** 表结构变更请求：只描述目标状态，现状由驱动自己重读。 */
export interface TableChangeRequest {
  target: QueryTarget & { table: string };
  /** 目标列定义，顺序即目标列序。 */
  columns: TableColumnDefinition[];
  /** 表级属性的目标值，键同 `TableStructure.properties[].key`。 */
  properties: Record<string, string>;
}

/** 库 / schema 属性变更请求。 */
export interface DatabaseChangeRequest {
  target: DatabaseObjectTarget;
  properties: Record<string, string>;
}

/**
 * 变更计划。
 *
 * 预览与实际执行共用同一份语句：分开生成迟早会出现「预览说会这么改、执行却改了别的」，
 * 而结构变更恰恰是最不能靠猜的一类操作。
 */
export interface ObjectChangePlan {
  /** 待下发的语句，按执行顺序排列。空数组表示没有任何变更。 */
  statements: string[];
  /** 人类可读的变更摘要（新增列 a、删除列 b…）。 */
  changes: string[];
  /** 被跳过的变更及原因（该数据库不支持、需要手工处理等）。 */
  warnings?: string[];
}

/** 变更执行结果。 */
export interface ObjectChangeResult extends ObjectChangePlan {
  /** 实际执行成功的语句数；小于 `statements.length` 说明中途失败。 */
  executed: number;
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
  /** 支持编辑表结构（增删改列、调整列序、表级属性）。 */
  editTableStructure: boolean;
  /** 支持编辑数据库 / schema 级别的属性。 */
  editDatabaseProperties: boolean;
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

  /** 读取表结构（列、主键、表级属性）；`capabilities.editTableStructure` 为 true 时实现。 */
  describeTable?(target: QueryTarget & { table: string }): Promise<TableStructure>;
  /** 生成表结构变更语句，不执行——界面的「预览」入口走这里。 */
  planTableChange?(request: TableChangeRequest): Promise<ObjectChangePlan>;
  /**
   * 应用表结构变更。`capabilities.editTableStructure` 为 true 时实现。
   *
   * 与 `updateCell` 同一个理由：语句生成与执行都在驱动层完成。列定义怎么拼、
   * 位置子句怎么写、主键怎么删了重建，全都是方言知识，通用层拼装必然出错；
   * 而且该接口必须是异步的，sidecar 模式下同步方法无法跨进程调用。
   */
  applyTableChange?(request: TableChangeRequest): Promise<ObjectChangeResult>;

  /** 读取库 / schema 属性；`capabilities.editDatabaseProperties` 为 true 时实现。 */
  describeDatabaseProperties?(target: DatabaseObjectTarget): Promise<DatabaseProperties>;
  /** 生成库 / schema 属性变更语句，不执行。 */
  planDatabaseChange?(request: DatabaseChangeRequest): Promise<ObjectChangePlan>;
  /** 应用库 / schema 属性变更。 */
  applyDatabaseChange?(request: DatabaseChangeRequest): Promise<ObjectChangeResult>;

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
