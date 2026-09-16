/**
 * PostgreSQL 驱动实现。
 *
 * 依赖：pg（纯 JS，无原生编译步骤，Windows / WSL 通用）。
 *
 * 与 MySQL 驱动的关键差异（均由本文件在驱动层内消化，上层无感知）：
 * - 存在 database → schema → table 三级命名空间；
 * - 无 `SHOW CREATE TABLE`，建表语句需自行拼装；
 * - 查询结果默认按对象返回时，同名列（JOIN 场景）会互相覆盖，
 *   因此这里改用数组行模式 + 列名去重，避免数据丢失。
 */

import { Client, ClientConfig } from 'pg';

import { PG_DEFINITION } from './definitions';
import { buildResultSet, executeScript } from './support';
import { pgQualified, quotePgIdent, quotePgString, sanitizeValue, toSqlLiteral, withTimeout } from '../core/sqlText';
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

const SYSTEM_DATABASES = new Set(['postgres', 'template0', 'template1']);

export class PostgresDriver implements IDatabaseDriver {
  readonly id = PG_DEFINITION.id;
  readonly displayName = PG_DEFINITION.displayName;
  readonly defaultPort = PG_DEFINITION.defaultPort;
  readonly aliases = PG_DEFINITION.aliases;
  readonly capabilities: DriverCapabilities = PG_DEFINITION.capabilities;

  private client?: Client;
  private queryTimeoutMs = 60_000;
  private readOnly = false;

  async connect(options: DriverConnectOptions): Promise<void> {
    await this.disconnect();
    const { connection, connectTimeoutMs, queryTimeoutMs } = options;
    const profile = connection.profile;

    const config: ClientConfig = {
      host: connection.host,
      port: profile.port,
      user: profile.user,
      password: connection.password,
      database: profile.database || 'postgres',
      connectionTimeoutMillis: connectTimeoutMs,
      // 服务端级超时，配合客户端超时形成双层保护
      statement_timeout: queryTimeoutMs,
      query_timeout: queryTimeoutMs,
      application_name: str(profile.options?.applicationName) ?? 'vscode-dbviewer',
      keepAlive: true,
      ssl: profile.ssl ? { rejectUnauthorized: false } : undefined,
    };

    const client = new Client(config);
    try {
      await client.connect();
    } catch (err) {
      // 连接失败必须显式结束，否则 pg 会留下悬空的 socket 与定时器
      try {
        await client.end();
      } catch {
        /* 忽略 */
      }
      throw normalizePgError(err, connection.host, profile.port);
    }
    this.client = client;
    this.queryTimeoutMs = queryTimeoutMs;
    this.readOnly = !!profile.readOnly;
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      try {
        await client.end();
      } catch {
        /* 连接已失效，忽略 */
      }
    }
  }

  isConnected(): boolean {
    return !!this.client;
  }

  async ping(): Promise<void> {
    const client = this.require();
    try {
      await withTimeout(client.query('SELECT 1'), this.queryTimeoutMs, `ping 超时（${this.queryTimeoutMs}ms）`);
    } catch (err) {
      throw normalizePgError(err);
    }
  }

  async listDatabases(): Promise<DatabaseNode[]> {
    const rows = await this.rawQuery<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname`,
    );
    return rows.map((row) => ({ name: row.datname, isSystem: SYSTEM_DATABASES.has(row.datname) }));
  }

  async listSchemas(): Promise<string[]> {
    const rows = await this.rawQuery<{ schema_name: string }>(
      `SELECT schema_name
         FROM information_schema.schemata
        WHERE schema_name <> 'information_schema'
          AND schema_name NOT LIKE 'pg\\_%'
        ORDER BY schema_name`,
    );
    // 当前连接的库可能存在自定义 schema，若为空则给出默认值保证树视图不空
    return rows.length ? rows.map((r) => r.schema_name) : ['public'];
  }

  async listTables(target: QueryTarget): Promise<TableNode[]> {
    const schema = target.schema;
    const params: unknown[] = [];
    let filter = `n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'`;
    if (schema) {
      params.push(schema);
      filter = `n.nspname = $1`;
    }
    const rows = await this.rawQuery<{ name: string; schema: string; kind: string }>(
      `SELECT c.relname AS name, n.nspname AS schema, c.relkind AS kind
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND ${filter}
        ORDER BY n.nspname, c.relname`,
      params,
    );
    return rows.map((row) => ({
      name: row.name,
      schema: row.schema,
      kind: row.kind === 'v' || row.kind === 'm' ? 'view' : 'table',
    }));
  }

  async listColumns(target: QueryTarget & { table: string }): Promise<ColumnNode[]> {
    const schema = target.schema ?? 'public';
    const rows = await this.rawQuery<{
      name: string;
      data_type: string;
      nullable: boolean;
      default_value: string | null;
      is_primary_key: boolean;
    }>(
      `SELECT a.attname                                        AS name,
              format_type(a.atttypid, a.atttypmod)             AS data_type,
              NOT a.attnotnull                                 AS nullable,
              pg_get_expr(ad.adbin, ad.adrelid)                AS default_value,
              EXISTS (
                SELECT 1 FROM pg_constraint con
                 WHERE con.conrelid = a.attrelid
                   AND con.contype = 'p'
                   AND a.attnum = ANY (con.conkey)
              )                                                AS is_primary_key
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
        WHERE a.attnum > 0
          AND NOT a.attisdropped
          AND n.nspname = $1
          AND c.relname = $2
        ORDER BY a.attnum`,
      [schema, target.table],
    );
    return rows.map((row) => ({
      name: row.name,
      dataType: row.data_type,
      nullable: !!row.nullable,
      isPrimaryKey: !!row.is_primary_key,
      defaultValue: row.default_value,
    }));
  }

  async execute(sql: string, options: ExecuteOptions): Promise<QueryResult> {
    const client = this.require();
    if (this.readOnly) {
      assertReadOnly(sql);
    }
    return executeScript(sql, options, (statement, limit, timeoutMs) =>
      this.runStatement(client, statement, limit, timeoutMs),
    );
  }

  previewSql(target: QueryTarget & { table: string }, limit: number): string {
    return `SELECT * FROM ${pgQualified(target.schema ?? 'public', target.table)} LIMIT ${limit};`;
  }

  /** PostgreSQL 无 SHOW CREATE TABLE，此处依据系统目录拼装等价 DDL（标注为近似结果）。 */
  async showCreateTable(target: QueryTarget & { table: string }): Promise<string | undefined> {
    const schema = target.schema ?? 'public';
    const columns = await this.rawQuery<{
      name: string;
      data_type: string;
      nullable: boolean;
      default_value: string | null;
    }>(
      `SELECT a.attname                            AS name,
              format_type(a.atttypid, a.atttypmod) AS data_type,
              NOT a.attnotnull                     AS nullable,
              pg_get_expr(ad.adbin, ad.adrelid)     AS default_value
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
        WHERE a.attnum > 0 AND NOT a.attisdropped AND n.nspname = $1 AND c.relname = $2
        ORDER BY a.attnum`,
      [schema, target.table],
    );
    if (columns.length === 0) {
      return undefined;
    }
    const constraints = await this.rawQuery<{ def: string }>(
      `SELECT pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'p'`,
      [schema, target.table],
    );

    const lines = columns.map((col) => {
      let line = `    ${quoteIdent(col.name)} ${col.data_type}`;
      if (col.default_value) {
        line += ` DEFAULT ${col.default_value}`;
      }
      if (!col.nullable) {
        line += ' NOT NULL';
      }
      return line;
    });
    for (const pk of constraints) {
      lines.push(`    ${pk.def}`);
    }

    return [
      `-- 近似结果：由系统目录拼装，索引 / 触发器 / 外键等未包含在内`,
      `-- 精确结构：pg_dump -t ${schema}.${target.table} --schema-only`,
      `CREATE TABLE ${pgQualified(schema, target.table)} (`,
      lines.join(',\n'),
      ');',
    ].join('\n');
  }

  // ---------------------------------------------------------------- 内部实现

  /** 执行单元格更新。复用 `execute`，让只读模式与超时控制对新入口同样生效。 */
  async updateCell(request: CellUpdateRequest, options: ExecuteOptions): Promise<CellUpdateResult> {
    const sql = this.buildUpdate(request);
    const result = await this.execute(sql, { ...options, limit: 0 });
    const affectedRows = result.sets.reduce((sum, set) => sum + (set.affectedRows ?? 0), 0);
    return { sql, affectedRows };
  }

  // ---------------------------------------------------------------- 数据库与用户管理

  async dropTable(target: QueryTarget & { table: string }): Promise<void> {
    const qualified = pgQualified(target.schema ?? 'public', target.table);
    await this.execute(`DROP TABLE IF EXISTS ${qualified} CASCADE;`, { limit: 0, timeoutMs: this.queryTimeoutMs });
  }

  async dropDatabase(name: string): Promise<void> {
    await this.execute(`DROP DATABASE IF EXISTS ${quotePgIdent(name)} WITH (FORCE);`, {
      limit: 0,
      timeoutMs: this.queryTimeoutMs,
    });
  }

  async createDatabase(options: CreateDatabaseOptions): Promise<void> {
    const encoding = options.charset?.trim() || 'UTF8';
    await this.execute(`CREATE DATABASE ${quotePgIdent(options.name)} ENCODING ${quotePgString(encoding)};`, {
      limit: 0,
      timeoutMs: this.queryTimeoutMs,
    });
  }

  async createUser(request: CreateUserRequest): Promise<void> {
    const sql = `CREATE USER ${quotePgIdent(request.username)} WITH PASSWORD ${quotePgString(request.password)};`;
    const grants = this.buildGrants(request.username, request.grants);
    await this.execute([sql, ...grants].join('\n'), { limit: 0, timeoutMs: this.queryTimeoutMs });
  }

  async grantPrivileges(request: CreateUserRequest): Promise<void> {
    const grants = this.buildGrants(request.username, request.grants);
    if (grants.length === 0) {
      throw new DatabaseError('未指定要授予的权限', 'ENO_GRANTS');
    }
    await this.execute(grants.join('\n'), { limit: 0, timeoutMs: this.queryTimeoutMs });
  }

  private buildGrants(username: string, grants: CreateUserRequest['grants']): string[] {
    if (!grants || grants.length === 0) {
      return [];
    }
    const lines: string[] = [];
    for (const grant of grants) {
      const schema = grant.target;
      const privileges = grant.privileges.join(', ');
      if (grant.table) {
        lines.push(
          `GRANT ${privileges} ON TABLE ${pgQualified(schema, grant.table)} TO ${quotePgIdent(username)};`,
        );
      } else {
        lines.push(`GRANT USAGE ON SCHEMA ${quotePgIdent(schema)} TO ${quotePgIdent(username)};`);
        lines.push(
          `GRANT ${privileges} ON ALL TABLES IN SCHEMA ${quotePgIdent(schema)} TO ${quotePgIdent(username)};`,
        );
      }
    }
    return lines;
  }

  /**
   * 生成单行 UPDATE。
   *
   * 标识符用双引号引用（PG 对大小写敏感，「混合大小写列名」必须引用才正确）；
   * 值走 `toSqlLiteral` 转成标准 SQL 字面量。
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
    const qualified = pgQualified(request.target.schema ?? 'public', request.target.table);
    const setClause = changes
      .map(([column, value]) => `${quotePgIdent(column)} = ${toSqlLiteral(value, 'postgresql')}`)
      .join(', ');
    const whereClause = identity
      .map(([column, value]) => `${quotePgIdent(column)} = ${toSqlLiteral(value, 'postgresql')}`)
      .join(' AND ');
    return `UPDATE ${qualified} SET ${setClause} WHERE ${whereClause};`;
  }

  private async runStatement(
    client: Client,
    statement: string,
    limit: number,
    timeoutMs: number,
  ): Promise<ResultSet> {
    const finalSql = appendLimit(statement, limit);
    const notices: string[] = [];
    if (finalSql !== statement) {
      notices.push(`已自动追加 LIMIT ${limit} 以限制返回行数`);
    }

    const noticeHandler = (notice: { severity?: string; message?: string }) => {
      if (notice?.message) {
        notices.push(`${notice.severity ?? 'NOTICE'}: ${notice.message}`);
      }
    };
    client.on('notice', noticeHandler);

    try {
      // rowMode: 'array' —— 规避同名列覆盖问题，列名由 fields 单独维护
      // 超时双保险：客户端级 query_timeout + 此处硬性兜底
      const res = await withTimeout(
        client.query({ text: finalSql, rowMode: 'array' }),
        timeoutMs,
        `语句执行超时（${timeoutMs}ms）`,
      );
      const names = uniquifyNames(res.fields.map((f) => f.name));
      const rows = (res.rows as unknown[][]).map((raw) => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < names.length; i++) {
          obj[names[i]] = sanitizeValue(raw[i]);
        }
        return obj;
      });

      const affectedRows = isQueryCommand(res.command) ? undefined : res.rowCount ?? 0;
      return buildResultSet({
        sql: statement,
        executedSql: finalSql,
        statement: res.command || undefined,
        fields: names,
        rows,
        affectedRows,
        notices: notices.length ? notices : undefined,
      });
    } catch (err) {
      throw normalizePgError(err);
    } finally {
      client.removeListener('notice', noticeHandler);
    }
  }

  private async rawQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const client = this.require();
    try {
      const res = await client.query(sql, params as never[]);
      return (res.rows ?? []) as T[];
    } catch (err) {
      throw normalizePgError(err);
    }
  }

  private require(): Client {
    if (!this.client) {
      throw new DatabaseError('PostgreSQL 连接尚未建立', 'ENOT_CONNECTED');
    }
    return this.client;
  }
}

function isQueryCommand(command: string | undefined): boolean {
  return /^(select|show|fetch|describe|explain|values|table)$/i.test(command ?? '');
}

/**
 * 追加 LIMIT。
 * PG 支持 `LIMIT n`，但不能追加到 SHOW / EXPLAIN 之后，需按语句类型区分。
 */
function appendLimit(sql: string, limit: number): string {
  if (!limit || limit <= 0) {
    return sql;
  }
  if (!/^\s*(select|with|values|table)\b/i.test(sql)) {
    return sql;
  }
  if (/\blimit\s+\d+(\s+offset\s+\d+)?\s*;?\s*$/i.test(sql)) {
    return sql;
  }
  return `${sql.replace(/;\s*$/, '')} LIMIT ${limit}`;
}

function assertReadOnly(sql: string): void {
  if (/^\s*(insert|update|delete|drop|truncate|alter|create|grant|revoke|comment|copy)\b/i.test(sql)) {
    throw new DatabaseError('当前连接已启用只读模式，写操作被拦截', 'EREADONLY');
  }
}

/** 同名列去重：`id`、`id_2`、`id_3`，保证 JOIN 查询不丢列。 */
export function uniquifyNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const base = name || 'column';
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * 把 pg 的错误翻译成统一结构，并针对跨环境（Windows ↔ WSL）场景补充排查建议。
 */
export function normalizePgError(err: unknown, host?: string, port?: number): DatabaseError {
  const e = err as { code?: string; message?: string; detail?: string; severity?: string; routine?: string };
  const code = e?.code;
  const rawMessage = e?.message || String(err);
  let hint = '';

  switch (code) {
    case 'ECONNREFUSED':
      hint =
        `\n\n连接被拒绝（${host ?? '?'}:${port ?? '?'}）。排查方向：\n` +
        '1) 数据库是否已启动，端口是否为 5432；\n' +
        '2) Windows 与 WSL 处于不同网络空间，跨环境访问须使用 __windows_host__ / __wsl_host__；\n' +
        '3) postgresql.conf 的 listen_addresses 需为 `*` 或包含目标网卡地址；\n' +
        '4) pg_hba.conf 需为来源网段添加 host 记录，否则会报 no pg_hba.conf entry。';
      break;
    case 'ETIMEDOUT':
      hint = '\n\n连接超时。跨环境访问时请确认宿主防火墙已放行 5432 端口。';
      break;
    case 'ENOTFOUND':
      hint = `\n\n主机名解析失败：${host ?? '?'}。建议改用 IP 或主机别名。`;
      break;
    case '28P01':
      hint = '\n\n密码认证失败（28P01）。请核对密码，或检查 pg_hba.conf 的认证方式是否为 md5/scram-sha-256。';
      break;
    case '28000':
      hint =
        '\n\n该来源地址未被 pg_hba.conf 授权（28000）。需为当前网段追加一条 host 记录后重载配置（SELECT pg_reload_conf();）。';
      break;
    case '3D000':
      hint = '\n\n目标数据库不存在。';
      break;
    case '42501':
      hint = '\n\n权限不足（42501），当前角色无权访问该对象。';
      break;
    case '57014':
      hint = '\n\n语句被取消（57014），通常是超出了 statement_timeout。可调大 dbviewer.queryTimeoutMs。';
      break;
    default:
      break;
  }

  return new DatabaseError(rawMessage + hint, code, e?.detail);
}
