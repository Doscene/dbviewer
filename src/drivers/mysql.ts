/**
 * MySQL / MariaDB 驱动实现。
 *
 * 依赖：mysql2（纯 JS 实现，无原生扩展，因此在 Windows 与 WSL 上都能直接安装，
 * 不需要按平台重新编译 node-gyp 模块——这是选择 mysql2 而非 mysql 的关键原因）。
 */

import type { ConnectionOptions, FieldPacket, OkPacket, RowDataPacket } from 'mysql2';
import * as mysql from 'mysql2/promise';

import { MYSQL_DEFINITION } from './definitions';
import { buildResultSet, executeScript } from './support';
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
  ExecuteOptions,
  IDatabaseDriver,
  QueryResult,
  QueryTarget,
  ResultSet,
  TableNode,
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
  }

  async disconnect(): Promise<void> {
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
