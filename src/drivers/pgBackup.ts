/**
 * PostgreSQL 备份方言层。
 *
 * 与 MySQL 侧的关键差异在于「怎么拿到不失真的原始值」。
 * pg 默认会把 timestamp 解析成 `Date`、把 `int8` 解析成字符串、把数组解析成 JS 数组、
 * 把 `bytea` 解析成 `Buffer`——每一种在还原时都要再做一次「对象 → SQL 字面量」的逆向换算，
 * 而 jsonb / 数组 / 复合类型很难无损逆向。
 *
 * 因此备份连接统一装上**原样文本类型解析器**：任何类型都原封不动地拿到服务端返回的文本，
 * 写回时一律作为字符串字面量（PostgreSQL 对无类型字面量会按目标列隐式转换）。
 * 这也是 `pg_dump` 的做法，只是它走的是 COPY 通道。
 */

import { Client } from 'pg';

import { pgQualified, quotePgIdent, toBackupLiteral, withTimeout } from '../core/sqlText';
import { BackupTarget, DatabaseError } from '../core/types';
import { BackupDialect, BackupReadParams, BackupTableMeta } from './backupCore';

/** 原样文本：不做任何类型换算，服务端给什么就是什么。 */
const RAW_TEXT_TYPES = {
  getTypeParser: () => (value: string) => value,
};

export interface PgBackupContext {
  /** 建立一条独立的备份连接，已装配原样文本解析器。 */
  connect: () => Promise<Client>;
  /** 释放连接，必须可重复调用。 */
  release: (client: Client) => Promise<void>;
  /** 复用驱动已有的建表语句拼装，避免出现第二份 DDL 逻辑。 */
  createTableSql: (target: BackupTarget) => Promise<string | undefined>;
}

export class PgBackupSession {
  private client?: Client;
  /** PG 12 起才有 `attgenerated`；老版本要退回不查生成列的语句。 */
  private modernServer?: boolean;

  constructor(private readonly ctx: PgBackupContext) {}

  async open(): Promise<void> {
    await this.close();
    this.client = await this.ctx.connect();
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      await this.ctx.release(client);
    }
  }

  dialect(): BackupDialect {
    return {
      generator: 'DBViewer 内置导出（逐表 SELECT）',
      notes: [
        '不含 DROP 语句：导入前请确认目标 schema 中不存在同名对象',
        '数据为逐表快照，备份期间若有并发写入，各表之间不保证同一时间点',
        '表结构为近似 DDL（不含索引 / 触发器 / 外键），需要精确结构请用 pg_dump',
        '视图与物化视图只导出定义，不含数据',
      ],
      prologue: `SET client_encoding = 'UTF8';`,
      qualify: (target) => pgQualified(this.schemaOf(target), target.table),
      quoteIdent: quotePgIdent,
      literal: (value) => toBackupLiteral(value, 'postgresql'),
      tableMeta: (target, timeoutMs) => this.tableMeta(target, timeoutMs),
      createSql: (target, timeoutMs) => this.createSql(target, timeoutMs),
      readRows: (params) => this.readRows(params),
      open: () => this.open(),
      close: () => this.close(),
    };
  }

  // ---------------------------------------------------------------- 元数据

  private async tableMeta(target: BackupTarget, timeoutMs: number): Promise<BackupTableMeta> {
    const generatedFilter = (await this.isModernServer(timeoutMs)) ? `AND a.attgenerated = ''` : '';
    const rows = await this.query<{ name: string; is_pk: boolean }>(
      `SELECT a.attname AS name,
              EXISTS (
                SELECT 1 FROM pg_constraint con
                 WHERE con.conrelid = a.attrelid
                   AND con.contype = 'p'
                   AND a.attnum = ANY (con.conkey)
              ) AS is_pk
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE a.attnum > 0
          AND NOT a.attisdropped
          ${generatedFilter}
          AND n.nspname = $1
          AND c.relname = $2
        ORDER BY a.attnum`,
      [this.schemaOf(target), target.table],
      timeoutMs,
    );
    const columns = rows.map((row) => row.name);
    const keys = rows.filter((row) => truthy(row.is_pk)).map((row) => row.name);
    return { columns, keyColumn: keys.length === 1 ? keys[0] : undefined };
  }

  private async createSql(target: BackupTarget, timeoutMs: number): Promise<string | undefined> {
    if (target.kind === 'view') {
      return this.viewDefinition(target, timeoutMs);
    }
    return this.ctx.createTableSql(target);
  }

  /**
   * 视图定义。
   *
   * `pg_get_viewdef` 拿到的是服务端记录的原始定义，比从 information_schema 反推准确得多；
   * 物化视图需要另一个关键字，靠 relkind 区分。
   */
  private async viewDefinition(target: BackupTarget, timeoutMs: number): Promise<string | undefined> {
    const rows = await this.query<{ kind: string; def: string | null }>(
      `SELECT c.relkind AS kind, pg_get_viewdef(c.oid, true) AS def
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [this.schemaOf(target), target.table],
      timeoutMs,
    );
    const row = rows[0];
    if (!row?.def) {
      return undefined;
    }
    const keyword = row.kind === 'm' ? 'CREATE MATERIALIZED VIEW' : 'CREATE OR REPLACE VIEW';
    // pg_get_viewdef 自带结尾分号，这里统一交给上层补齐，避免出现 `;;`
    return `${keyword} ${pgQualified(this.schemaOf(target), target.table)} AS\n${row.def.trim().replace(/;\s*$/, '')}`;
  }

  private async readRows(params: BackupReadParams): Promise<Record<string, unknown>[]> {
    const { target, columns, keyColumn, afterKey, offset, limit, timeoutMs } = params;
    const qualified = pgQualified(this.schemaOf(target), target.table);
    let sql = `SELECT ${columns.map(quotePgIdent).join(', ')} FROM ${qualified}`;
    const values: unknown[] = [];

    if (keyColumn) {
      if (afterKey !== undefined && afterKey !== null) {
        sql += ` WHERE ${quotePgIdent(keyColumn)} > $1`;
        values.push(afterKey);
      }
      sql += ` ORDER BY ${quotePgIdent(keyColumn)}`;
    }

    sql += keyColumn || offset === 0 ? ` LIMIT ${limit}` : ` LIMIT ${limit} OFFSET ${offset}`;

    const client = this.requireClient();
    try {
      // rowMode: 'array' + 显式列名：同名列（JOIN / 重复列）不会被互相覆盖，
      // 列顺序由我们自己给出的 columns 决定，比依赖服务端返回的字段名稳
      const res = await withTimeout(
        client.query({ text: sql, values: values as never[], rowMode: 'array' }),
        timeoutMs,
        `备份读取超时（${timeoutMs}ms）`,
      );
      const raw = res.rows as unknown[][];
      return raw.map((row) => {
        const item: Record<string, unknown> = {};
        for (let index = 0; index < columns.length; index++) {
          item[columns[index]] = row[index];
        }
        return item;
      });
    } catch (err) {
      throw err instanceof DatabaseError ? err : new DatabaseError((err as Error).message, (err as { code?: string }).code);
    }
  }

  // ---------------------------------------------------------------- 基础

  private schemaOf(target: BackupTarget): string {
    return target.schema ?? 'public';
  }

  private async isModernServer(timeoutMs: number): Promise<boolean> {
    if (this.modernServer === undefined) {
      try {
        const rows = await this.query<{ version: string }>(
          `SELECT current_setting('server_version_num') AS version`,
          [],
          Math.min(timeoutMs, 5_000),
        );
        this.modernServer = Number(rows[0]?.version ?? 0) >= 120_000;
      } catch {
        // 探测失败就按老版本处理：少列出的生成列最多让 INSERT 失败，状态机会跳过该表
        this.modernServer = false;
      }
    }
    return this.modernServer;
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new DatabaseError('备份连接尚未建立', 'ENOT_CONNECTED');
    }
    return this.client;
  }

  private async query<T>(sql: string, params: unknown[], timeoutMs: number): Promise<T[]> {
    const client = this.requireClient();
    try {
      const res = await withTimeout(
        client.query(sql, params as never[]),
        timeoutMs,
        `备份读取超时（${timeoutMs}ms）`,
      );
      return (res.rows ?? []) as T[];
    } catch (err) {
      throw err instanceof DatabaseError ? err : new DatabaseError((err as Error).message, (err as { code?: string }).code);
    }
  }
}

/** 备份连接的类型解析器配置：交给驱动装配 Client 时使用。 */
export const PG_BACKUP_TYPE_PARSERS = RAW_TEXT_TYPES;

function truthy(value: unknown): boolean {
  return value === true || value === 't' || value === 'true' || value === 1 || value === '1';
}
