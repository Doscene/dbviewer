/**
 * MySQL / MariaDB 驱动实现。
 *
 * 依赖：mysql2（纯 JS 实现，无原生扩展，因此在 Windows 与 WSL 上都能直接安装，
 * 不需要按平台重新编译 node-gyp 模块——这是选择 mysql2 而非 mysql 的关键原因）。
 */

import type { ConnectionOptions, FieldPacket, OkPacket, RowDataPacket } from 'mysql2';
import * as mysql from 'mysql2/promise';

import { MYSQL_DEFINITION } from './definitions';
import { MysqlBackupSession } from './mysqlBackup';
import { runBackupChunks } from './backupCore';
import {
  buildMysqlDatabasePlan,
  buildMysqlTablePlan,
  inheritMysqlExtraClauses,
  MYSQL_COLUMN_TYPES,
} from './mysqlStructure';
import { buildResultSet, executeScript } from './support';
import {
  BackupChunk,
  BackupChunkRequest,
  CellUpdateRequest,
  CellUpdateResult,
  ColumnNode,
  CreateDatabaseOptions,
  CreateUserRequest,
  DatabaseChangeRequest,
  DatabaseError,
  DatabaseNode,
  DatabaseObjectTarget,
  DatabaseProperties,
  DriverCapabilities,
  DriverConnectOptions,
  EditableProperty,
  ExecuteOptions,
  IDatabaseDriver,
  ObjectChangePlan,
  ObjectChangeResult,
  QueryResult,
  QueryTarget,
  ResultSet,
  TableChangeRequest,
  TableColumnDefinition,
  TableNode,
  TableStructure,
} from '../core/types';
import { mysqlQualified, quoteMysqlIdent, quoteMysqlString, sanitizeRow, toSqlLiteral } from '../core/sqlText';

const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

export class MySqlDriver implements IDatabaseDriver {
  readonly id = MYSQL_DEFINITION.id;
  readonly displayName = MYSQL_DEFINITION.displayName;
  readonly defaultPort = MYSQL_DEFINITION.defaultPort;
  readonly aliases = MYSQL_DEFINITION.aliases;
  readonly capabilities: DriverCapabilities = MYSQL_DEFINITION.capabilities;

  private connection?: mysql.Connection;
  private defaultDatabase?: string;
  private queryTimeoutMs = 60_000;
  private readOnly = false;
  /**
   * 保留连接入参：备份需要另开一条连接，而密码只有这里拿得到。
   * 存的是内存里的副本，不落盘；`disconnect()` 会连同它一起清掉。
   */
  private connectOptions?: DriverConnectOptions;
  private backupSession?: MysqlBackupSession;

  async connect(options: DriverConnectOptions): Promise<void> {
    await this.disconnect();
    const { connection, connectTimeoutMs, queryTimeoutMs } = options;
    const profile = connection.profile;

    const config: ConnectionOptions = {
      host: connection.host,
      port: profile.port,
      user: profile.user,
      password: connection.password,
      database: profile.database || undefined,
      connectTimeout: connectTimeoutMs,
      // 多语句由上层自行拆分执行，这里关闭以缩小攻击面
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: false,
      charset: str(profile.options?.charset) ?? 'utf8mb4',
      timezone: str(profile.options?.timezone) ?? 'local',
      ssl: profile.ssl ? { rejectUnauthorized: false } : undefined,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
    };

    try {
      this.connection = await mysql.createConnection(config);
    } catch (err) {
      throw normalizeMysqlError(err, connection.host, profile.port);
    }
    this.defaultDatabase = profile.database || undefined;
    this.queryTimeoutMs = queryTimeoutMs;
    this.readOnly = !!profile.readOnly;
    this.connectOptions = options;
  }

  async disconnect(): Promise<void> {
    // 备份连接先收：它可能正卡在一张大表的读取上，让主连接先走会留下孤儿连接
    const backup = this.backupSession;
    this.backupSession = undefined;
    this.connectOptions = undefined;
    if (backup) {
      try {
        await backup.close();
      } catch {
        /* 备份连接断开失败不影响主连接状态 */
      }
    }

    const conn = this.connection;
    this.connection = undefined;
    if (conn) {
      try {
        await conn.end();
      } catch {
        // 连接已断开时 end() 抛错属于正常情况；兜底销毁句柄
        try {
          conn.destroy();
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  isConnected(): boolean {
    return !!this.connection;
  }

  async ping(): Promise<void> {
    const conn = this.require();
    try {
      await conn.query({ sql: 'SELECT 1', timeout: this.queryTimeoutMs });
    } catch (err) {
      throw normalizeMysqlError(err);
    }
  }

  async listDatabases(): Promise<DatabaseNode[]> {
    const rows = await this.rawQuery<{ Database: string }>('SHOW DATABASES');
    return rows.map((row) => ({
      name: row.Database,
      isSystem: SYSTEM_DATABASES.has(row.Database),
    }));
  }

  /** MySQL 中 schema 与 database 同义，此处不单独提供层级。 */
  async listSchemas(): Promise<string[]> {
    return [];
  }

  async listTables(target: QueryTarget): Promise<TableNode[]> {
    const database = target.database ?? this.defaultDatabase;
    if (!database) {
      throw new DatabaseError('未指定数据库，无法列举数据表', 'ENO_DATABASE');
    }
    const rows = await this.rawQuery<{ TABLE_NAME: string; TABLE_TYPE: string }>(
      `SELECT TABLE_NAME, TABLE_TYPE
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME`,
      [database],
    );
    return rows.map((row) => ({
      name: row.TABLE_NAME,
      schema: database,
      kind: /VIEW/i.test(row.TABLE_TYPE) ? 'view' : 'table',
    }));
  }

  async listColumns(target: QueryTarget & { table: string }): Promise<ColumnNode[]> {
    const database = target.database ?? this.defaultDatabase;
    if (!database) {
      throw new DatabaseError('未指定数据库，无法读取列信息', 'ENO_DATABASE');
    }
    const rows = await this.rawQuery<{
      COLUMN_NAME: string;
      COLUMN_TYPE: string;
      IS_NULLABLE: string;
      COLUMN_KEY: string;
      COLUMN_DEFAULT: string | null;
      COLUMN_COMMENT: string | null;
    }>(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, COLUMN_COMMENT
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [database, target.table],
    );
    return rows.map((row) => ({
      name: row.COLUMN_NAME,
      dataType: row.COLUMN_TYPE,
      nullable: row.IS_NULLABLE === 'YES',
      isPrimaryKey: row.COLUMN_KEY === 'PRI',
      defaultValue: row.COLUMN_DEFAULT,
      comment: row.COLUMN_COMMENT ?? undefined,
    }));
  }

  async execute(sql: string, options: ExecuteOptions): Promise<QueryResult> {
    const conn = this.require();
    if (this.readOnly) {
      assertReadOnly(sql);
    }
    return executeScript(sql, options, (statement, limit, timeoutMs) => this.runStatement(conn, statement, limit, timeoutMs));
  }

  previewSql(target: QueryTarget & { table: string }, limit: number): string {
    return `SELECT * FROM ${mysqlQualified(target.database ?? this.defaultDatabase, target.table)} LIMIT ${limit};`;
  }

  async showCreateTable(target: QueryTarget & { table: string }): Promise<string | undefined> {
    const qualified = mysqlQualified(target.database ?? this.defaultDatabase, target.table);
    const rows = await this.rawQuery<Record<string, string>>(`SHOW CREATE TABLE ${qualified}`);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    // 视图返回的列名是 Create View，表是 Create Table
    return row['Create Table'] ?? row['Create View'] ?? undefined;
  }

  /**
   * 执行单元格更新。
   *
   * 复用 `execute` 而非直连底层连接，是为了让只读模式、超时、错误归一化等既有逻辑
   * 对新入口同样生效——否则「只读连接」会在这里被绕过。
   */
  async updateCell(request: CellUpdateRequest, options: ExecuteOptions): Promise<CellUpdateResult> {
    const sql = this.buildUpdate(request);
    const result = await this.execute(sql, { ...options, limit: 0 });
    const affectedRows = result.sets.reduce((sum, set) => sum + (set.affectedRows ?? 0), 0);
    return { sql, affectedRows };
  }

  // ---------------------------------------------------------------- 数据库与用户管理

  async dropTable(target: QueryTarget & { table: string }): Promise<void> {
    const qualified = mysqlQualified(target.database ?? this.defaultDatabase, target.table);
    await this.execute(`DROP TABLE IF EXISTS ${qualified};`, { limit: 0, timeoutMs: this.queryTimeoutMs });
  }

  async dropDatabase(name: string): Promise<void> {
    await this.execute(`DROP DATABASE IF EXISTS ${quoteMysqlIdent(name)};`, {
      limit: 0,
      timeoutMs: this.queryTimeoutMs,
    });
  }

  async createDatabase(options: CreateDatabaseOptions): Promise<void> {
    const charset = options.charset?.trim() || 'utf8mb4';
    const collation = options.collation?.trim();
    let sql = `CREATE DATABASE IF NOT EXISTS ${quoteMysqlIdent(options.name)} CHARACTER SET ${quoteMysqlIdent(charset)}`;
    if (collation) {
      sql += ` COLLATE ${quoteMysqlIdent(collation)}`;
    }
    await this.execute(`${sql};`, { limit: 0, timeoutMs: this.queryTimeoutMs });
  }

  async createUser(request: CreateUserRequest): Promise<void> {
    const host = request.host?.trim() || '%';
    const sql = `CREATE USER IF NOT EXISTS ${quoteMysqlUser(request.username, host)} IDENTIFIED BY ${quoteMysqlString(request.password)};`;
    const grants = this.buildGrants(request.username, host, request.grants);
    await this.execute([sql, ...grants].join('\n'), { limit: 0, timeoutMs: this.queryTimeoutMs });
  }

  async grantPrivileges(request: CreateUserRequest): Promise<void> {
    const host = request.host?.trim() || '%';
    const grants = this.buildGrants(request.username, host, request.grants);
    if (grants.length === 0) {
      throw new DatabaseError('未指定要授予的权限', 'ENO_GRANTS');
    }
    await this.execute(grants.join('\n'), { limit: 0, timeoutMs: this.queryTimeoutMs });
  }

  private buildGrants(username: string, host: string, grants: CreateUserRequest['grants']): string[] {
    if (!grants || grants.length === 0) {
      return [];
    }
    return grants.map((grant) => {
      const privileges = grant.privileges.join(', ');
      const target = grant.table
        ? `${quoteMysqlIdent(grant.target)}.${quoteMysqlIdent(grant.table)}`
        : `${quoteMysqlIdent(grant.target)}.*`;
      return `GRANT ${privileges} ON ${target} TO ${quoteMysqlUser(username, host)};`;
    });
  }

  /**
   * 生成单行 UPDATE。
   *
   * 列名与值都经过转义后拼装：列名来自驱动自己的元数据查询结果（非用户输入），
   * 值一律走 `toSqlLiteral` 转成字面量，杜绝把用户输入当 SQL 片段执行。
   */
  private buildUpdate(request: CellUpdateRequest): string {
    const changes = Object.entries(request.changes);
    if (changes.length === 0) {
      throw new DatabaseError('没有需要更新的列', 'ENO_CHANGES');
    }
    const identity = Object.entries(request.identity);
    if (identity.length === 0) {
      throw new DatabaseError('该结果没有可用的主键信息，无法生成安全的 UPDATE 语句', 'ENO_IDENTITY');
    }
    const qualified = mysqlQualified(request.target.database ?? this.defaultDatabase, request.target.table);
    const setClause = changes
      .map(([column, value]) => `${quoteMysqlIdent(column)} = ${toSqlLiteral(value, 'mysql')}`)
      .join(', ');
    const whereClause = identity
      .map(([column, value]) => `${quoteMysqlIdent(column)} = ${toSqlLiteral(value, 'mysql')}`)
      .join(' AND ');
    return `UPDATE ${qualified} SET ${setClause} WHERE ${whereClause};`;
  }

  // ---------------------------------------------------------------- 表结构与对象属性

  /**
   * 读取表结构。
   *
   * 列信息来自 `information_schema.COLUMNS` 而不是 `SHOW COLUMNS`：前者能一次拿到
   * 类型全称（含 unsigned / 长度）、默认值、注释与主键标记，省掉多轮往返。
   */
  async describeTable(target: QueryTarget & { table: string }): Promise<TableStructure> {
    const database = target.database ?? this.defaultDatabase;
    if (!database) {
      throw new DatabaseError('未指定数据库，无法读取表结构', 'ENO_DATABASE');
    }
    const rows = await this.rawQuery<{
      COLUMN_NAME: string;
      COLUMN_TYPE: string;
      IS_NULLABLE: string;
      COLUMN_DEFAULT: string | null;
      EXTRA: string | null;
      COLUMN_KEY: string;
      COLUMN_COMMENT: string | null;
    }>(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_KEY, COLUMN_COMMENT
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [database, target.table],
    );
    if (rows.length === 0) {
      throw new DatabaseError(`表不存在或无权访问：${database}.${target.table}`, 'ENO_TABLE');
    }

    const [meta] = await this.rawQuery<{
      ENGINE: string | null;
      TABLE_COLLATION: string | null;
      TABLE_COMMENT: string | null;
    }>(
      `SELECT ENGINE, TABLE_COLLATION, TABLE_COMMENT
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, target.table],
    );

    const collation = meta?.TABLE_COLLATION ?? '';
    // 排序规则名恒以字符集名开头（utf8mb4_unicode_ci → utf8mb4），无需再查一次
    const charset = collation ? collation.split('_')[0] : '';
    const engines = (await this.rawQuery<{ Engine: string; Support: string }>('SHOW ENGINES'))
      .filter((row) => /^(YES|DEFAULT)$/i.test(row.Support ?? ''))
      .map((row) => row.Engine);
    const charsets = (await this.rawQuery<{ Charset: string }>('SHOW CHARACTER SET')).map((row) => row.Charset);
    const collations = (await this.rawQuery<{ Collation: string }>('SHOW COLLATION')).map((row) => row.Collation);

    const columns: TableColumnDefinition[] = rows.map((row, index) => ({
      name: row.COLUMN_NAME,
      originalName: row.COLUMN_NAME,
      dataType: row.COLUMN_TYPE,
      nullable: row.IS_NULLABLE === 'YES',
      defaultValue: row.COLUMN_DEFAULT,
      comment: row.COLUMN_COMMENT || undefined,
      isPrimaryKey: row.COLUMN_KEY === 'PRI',
      autoIncrement: /auto_increment/i.test(row.EXTRA ?? ''),
      // `ON UPDATE CURRENT_TIMESTAMP` 只出现在 EXTRA 里，带上它才不会在改写别的属性时被静默抹掉
      extraClauses: mysqlExtraClauses(row.EXTRA),
      ordinal: index + 1,
    }));

    const properties: EditableProperty[] = [
      {
        key: 'name',
        label: '表名',
        value: target.table,
        kind: 'text',
        hint: '改名使用 RENAME TABLE，不影响数据',
      },
      {
        key: 'engine',
        label: '存储引擎',
        value: meta?.ENGINE ?? '',
        kind: 'select',
        options: engines,
        hint: 'MyISAM 不支持事务；改引擎会重建表',
      },
      { key: 'charset', label: '字符集', value: charset, kind: 'select', options: charsets },
      {
        key: 'collation',
        label: '排序规则',
        value: collation,
        kind: 'select',
        options: collations,
        hint: '需与字符集匹配，仅改字符集时自动取该字符集的默认排序规则',
      },
      { key: 'comment', label: '表注释', value: meta?.TABLE_COMMENT ?? '', kind: 'text' },
    ];

    return {
      target: { database, table: target.table },
      columns,
      properties,
      dataTypes: [...MYSQL_COLUMN_TYPES],
      limitations: [
        '本编辑器只处理列、主键与表级属性；索引、外键、触发器、分区请用 SQL 修改。',
        '改列类型时 MySQL 会按新类型转换既有数据，超长内容可能被截断，建议先在副本上试。',
      ],
      allowReorder: true,
      allowAutoIncrement: true,
      // ON UPDATE CURRENT_TIMESTAMP 只存在于 EXTRA 里，界面用开关表达它（见 extraClauses）
      allowAutoUpdate: true,
      ddl: await this.showCreateTable({ database, table: target.table }).catch(() => undefined),
    };
  }

  /**
   * 生成表结构变更计划。
   *
   * 语句怎么拼全在 `mysqlStructure.ts` 的纯函数里：它不碰连接，因此能被冒烟测试
   * 直接断言生成的 DDL —— 这里只负责把「现状」读出来喂给它。
   */
  async planTableChange(request: TableChangeRequest): Promise<ObjectChangePlan> {
    const current = await this.describeTable(request.target);
    return buildMysqlTablePlan(current, inheritMysqlExtraClauses(current, request), {
      defaultCollationOf: (charset) => this.defaultCollationOf(charset),
    });
  }

  /**
   * 应用表结构变更。
   *
   * 逐条执行而不是合成一个脚本：MySQL 的 DDL 无法整体回滚，逐条执行才能准确报出
   * 「第几条失败、前几条已经生效」，用户据此判断接下来该手工补什么。
   */
  async applyTableChange(request: TableChangeRequest): Promise<ObjectChangeResult> {
    return this.executePlan(await this.planTableChange(request));
  }

  async describeDatabaseProperties(target: DatabaseObjectTarget): Promise<DatabaseProperties> {
    const [row] = await this.rawQuery<{ DEFAULT_CHARACTER_SET_NAME: string; DEFAULT_COLLATION_NAME: string }>(
      `SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
         FROM information_schema.SCHEMATA
        WHERE SCHEMA_NAME = ?`,
      [target.name],
    );
    if (!row) {
      throw new DatabaseError(`数据库不存在或无权访问：${target.name}`, 'ENO_DATABASE');
    }
    const charsets = (await this.rawQuery<{ Charset: string }>('SHOW CHARACTER SET')).map((item) => item.Charset);
    const collations = (await this.rawQuery<{ Collation: string }>('SHOW COLLATION')).map((item) => item.Collation);

    return {
      target,
      label: '数据库',
      properties: [
        {
          key: 'name',
          label: '数据库名',
          value: target.name,
          kind: 'text',
          editable: false,
          hint: 'MySQL 不支持重命名数据库',
        },
        {
          key: 'charset',
          label: '默认字符集',
          value: row.DEFAULT_CHARACTER_SET_NAME,
          kind: 'select',
          options: charsets,
          hint: '只影响之后新建的表；已有表要逐表修改',
        },
        {
          key: 'collation',
          label: '默认排序规则',
          value: row.DEFAULT_COLLATION_NAME,
          kind: 'select',
          options: collations,
          hint: '需与默认字符集匹配',
        },
      ],
      limitations: ['MySQL 不支持数据库注释，也不支持在线重命名数据库（需另行导出导入）。'],
    };
  }

  async planDatabaseChange(request: DatabaseChangeRequest): Promise<ObjectChangePlan> {
    const current = await this.describeDatabaseProperties(request.target);
    return buildMysqlDatabasePlan(current, request, {
      defaultCollationOf: (charset) => this.defaultCollationOf(charset),
    });
  }

  async applyDatabaseChange(request: DatabaseChangeRequest): Promise<ObjectChangeResult> {
    return this.executePlan(await this.planDatabaseChange(request));
  }

  /** 逐条执行变更语句，失败时说明「第几条挂了、前几条已生效」。 */
  private async executePlan(plan: ObjectChangePlan): Promise<ObjectChangeResult> {
    let executed = 0;
    for (const statement of plan.statements) {
      try {
        await this.execute(statement, { limit: 0, timeoutMs: this.queryTimeoutMs });
      } catch (err) {
        const detail = err instanceof DatabaseError ? err.detail : undefined;
        const code = err instanceof DatabaseError ? err.code : undefined;
        throw new DatabaseError(
          `第 ${executed + 1} 条语句执行失败（共 ${plan.statements.length} 条，前 ${executed} 条已生效）：${
            (err as Error).message
          }`,
          code,
          detail,
        );
      }
      executed += 1;
    }
    return { ...plan, executed };
  }

  /** 查字符集的默认排序规则；只改字符集时用它补齐 COLLATE，避免服务端报不兼容。 */
  private async defaultCollationOf(charset: string): Promise<string | undefined> {
    if (!charset) {
      return undefined;
    }
    const rows = await this.rawQuery<Record<string, string>>(`SHOW CHARACTER SET LIKE ${quoteMysqlString(charset)}`);
    return rows[0]?.['Default collation'] || undefined;
  }

  // ---------------------------------------------------------------- 备份

  /**
   * 产出备份文本片段。
   *
   * 走**独立连接**而不是复用当前连接：一条大表的 SELECT 会把 mysql2 单连接的请求队列
   * 占满，期间树视图展开、查询执行全部排队等待，用户会以为插件卡死。
   * 游标推进与 INSERT 拼装交给 `runBackupChunks`，这里只提供方言。
   */
  async backupChunks(request: BackupChunkRequest): Promise<BackupChunk> {
    if (!this.connectOptions) {
      throw new DatabaseError('MySQL 连接尚未建立', 'ENOT_CONNECTED');
    }
    const mode = MYSQL_DEFINITION.backupModes?.find((item) => item.id === request.modeId);
    if (!mode) {
      throw new DatabaseError(`未知的备份方式：${request.modeId}`, 'ENO_BACKUP_MODE');
    }
    if (!this.backupSession) {
      this.backupSession = new MysqlBackupSession({
        connect: () => this.createBackupConnection(),
        release: async (connection) => {
          try {
            await connection.end();
          } catch {
            try {
              connection.destroy();
            } catch {
              /* 已失效，忽略 */
            }
          }
        },
      });
    }
    return runBackupChunks(this.backupSession.dialect(), mode, request);
  }

  /**
   * 建备份专用连接。
   *
   * 与主连接的唯一区别是 `dateStrings: true`：备份要的是「服务端原样给出的那个字符串」。
   * 走 Date 对象会经历「字符串 → Date（按时区换算）→ 字符串（再换回来）」的往返，
   * 时区配置稍有出入整列时间就会偏移。也不指定默认库，全部用全限定名访问，
   * 跨库选表备份才不会因当前库不同而解析到别的表。
   */
  private async createBackupConnection(): Promise<mysql.Connection> {
    const options = this.connectOptions;
    if (!options) {
      throw new DatabaseError('MySQL 连接尚未建立', 'ENOT_CONNECTED');
    }
    const profile = options.connection.profile;
    try {
      return await mysql.createConnection({
        host: options.connection.host,
        port: profile.port,
        user: profile.user,
        password: options.connection.password,
        connectTimeout: options.connectTimeoutMs,
        multipleStatements: false,
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
        charset: str(profile.options?.charset) ?? 'utf8mb4',
        timezone: str(profile.options?.timezone) ?? 'local',
        ssl: profile.ssl ? { rejectUnauthorized: false } : undefined,
      });
    } catch (err) {
      throw normalizeMysqlError(err, options.connection.host, profile.port);
    }
  }

  // ---------------------------------------------------------------- 内部实现

  private async runStatement(
    conn: mysql.Connection,
    statement: string,
    limit: number,
    timeoutMs: number,
  ): Promise<ResultSet> {
    const finalSql = appendLimit(statement, limit);
    const notices: string[] = [];
    if (finalSql !== statement) {
      notices.push(`已自动追加 LIMIT ${limit} 以限制返回行数`);
    }
    try {
      const [result, fields] = (await conn.query({
        sql: finalSql,
        timeout: timeoutMs,
      })) as [RowDataPacket[] | RowDataPacket[][] | OkPacket, FieldPacket[] | undefined];

      if (Array.isArray(result)) {
        return buildResultSet({
          sql: statement,
          executedSql: finalSql,
          fields: (fields ?? []).map((f) => f.name),
          rows: (result as RowDataPacket[]).map((row) => sanitizeRow(row as Record<string, unknown>)),
          notices: notices.length ? notices : undefined,
        });
      }

      // 非查询语句：OkPacket
      const ok = result as OkPacket & { warningStatus?: number };
      const affected = ok?.affectedRows ?? 0;
      const affectedNotices = [...notices];
      if (ok?.insertId && Number(ok.insertId) > 0) {
        affectedNotices.push(`最后插入 ID：${ok.insertId}`);
      }
      if (ok?.warningStatus) {
        affectedNotices.push(`警告数：${ok.warningStatus}`);
      }
      if (ok?.changedRows !== undefined) {
        affectedNotices.push(`实际变更行数：${ok.changedRows}`);
      }
      return buildResultSet({
        sql: statement,
        executedSql: finalSql,
        fields: [],
        rows: [],
        affectedRows: affected,
        notices: affectedNotices.length ? affectedNotices : undefined,
      });
    } catch (err) {
      throw normalizeMysqlError(err);
    }
  }

  /** 执行元数据查询并返回对象行（用于 driver 内部，不做截断）。 */
  private async rawQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const conn = this.require();
    try {
      const [rows] = (await conn.query({ sql, values: params, timeout: this.queryTimeoutMs })) as [
        RowDataPacket[],
        FieldPacket[] | undefined,
      ];
      return (rows ?? []) as unknown as T[];
    } catch (err) {
      throw normalizeMysqlError(err);
    }
  }

  private require(): mysql.Connection {
    if (!this.connection) {
      throw new DatabaseError('MySQL 连接尚未建立', 'ENOT_CONNECTED');
    }
    return this.connection;
  }
}

/** 仅对查询类语句追加 LIMIT；用户已显式写过 LIMIT 时不干预。 */
function appendLimit(sql: string, limit: number): string {
  if (!limit || limit <= 0) {
    return sql;
  }
  if (!/^\s*(select|with|table|values|show)\b/i.test(sql)) {
    return sql;
  }
  if (/\blimit\s+\d+(\s*,\s*\d+)?(\s+offset\s+\d+)?\s*;?\s*$/i.test(sql)) {
    return sql;
  }
  return `${sql.replace(/;\s*$/, '')} LIMIT ${limit}`;
}

function assertReadOnly(sql: string): void {
  if (/^\s*(insert|update|delete|replace|drop|truncate|alter|create|grant|revoke|rename)\b/i.test(sql)) {
    throw new DatabaseError('当前连接已启用只读模式，写操作被拦截', 'EREADONLY');
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * 从 `information_schema.COLUMNS.EXTRA` 里挑出必须原样保留的列子句。
 *
 * 只有 `ON UPDATE …` 会被漏掉：它在 EXTRA 里自成一段（如
 * `DEFAULT_GENERATED on update CURRENT_TIMESTAMP`），而 `auto_increment` 已由
 * `autoIncrement` 字段单独表达。EXTRA 剩下的取值（`STORAGE DISK/MEMORY`、
 * `COLUMN_FORMAT …`）只对 NDB / 压缩表有意义，暂不处理。
 */
function mysqlExtraClauses(extra: string | null | undefined): string | undefined {
  const match = /(?:^|\s)on update\s+(.+)$/i.exec(extra ?? '');
  return match ? `ON UPDATE ${match[1].trim()}` : undefined;
}

/** 生成 MySQL 用户账号字面量 `'user'@'host'`。 */
function quoteMysqlUser(username: string, host: string): string {
  return `${quoteMysqlString(username)}@${quoteMysqlString(host)}`;
}

/**
 * 把 mysql2 的错误翻译成统一结构。
 *
 * 除透传原始信息外，针对最常见的两类环境问题补充可执行建议——
 * 这两类错误在 Windows/WSL 混用场景下出现频率极高。
 */
export function normalizeMysqlError(err: unknown, host?: string, port?: number): DatabaseError {
  const e = err as { code?: string; errno?: number; sqlMessage?: string; sqlState?: string; message?: string };
  const code = e?.code ?? (e?.errno !== undefined ? `ERRNO_${e.errno}` : undefined);
  const rawMessage = e?.sqlMessage || e?.message || String(err);
  let hint = '';

  switch (code) {
    case 'ECONNREFUSED':
      hint =
        `\n\n连接被拒绝（${host ?? '?'}:${port ?? '?'}）。排查方向：\n` +
        '1) 数据库是否已启动，端口是否正确；\n' +
        '2) Windows 与 WSL 是两个独立网络空间，跨环境访问需用 __windows_host__ / __wsl_host__ 而非 localhost；\n' +
        '3) MySQL 的 bind-address 若为 127.0.0.1，则仅本机可连，跨环境需改为 0.0.0.0 并授权对应网段。';
      break;
    case 'ETIMEDOUT':
    case 'ETIMEOUT':
      hint = '\n\n连接超时。跨环境（Windows ↔ WSL）访问时请确认宿主防火墙已放行该端口。';
      break;
    case 'ENOTFOUND':
      hint = `\n\n主机名解析失败：${host ?? '?'}。请改用 IP，或使用 __windows_host__ / __wsl_host__ 别名。`;
      break;
    case 'ER_ACCESS_DENIED_ERROR':
      hint = '\n\n账号或密码错误。若为跨环境访问，还需确认该账号的授权范围（Host 字段）允许当前来源 IP，例如 `%` 或对应网段。';
      break;
    case 'ER_BAD_DB_ERROR':
      hint = '\n\n指定的数据库不存在。';
      break;
    case 'PROTOCOL_CONNECTION_LOST':
    case 'ECONNRESET':
      hint = '\n\n连接被服务端中断。常见于 max_connections 超限或服务端 wait_timeout 到期。';
      break;
    default:
      break;
  }

  return new DatabaseError(rawMessage + hint, code, e?.sqlState ? `SQLSTATE ${e.sqlState}` : undefined);
}
