/**
 * MySQL 备份方言层。
 *
 * 只做三件事：建一条专供备份的连接、把该数据库的元数据/DDL/数据读成通用结构、
 * 声明备份文件的头部说明。游标推进与 INSERT 拼装由 `backupCore` 负责。
 *
 * 连接由调用方（驱动）提供工厂函数而不是在这里自己拼配置，原因有二：
 * - 连接参数与错误归一化本来就在驱动里，不该有第二份；
 * - 避免 `mysql.ts ↔ mysqlBackup.ts` 的循环依赖。
 */

import type { Connection, FieldPacket, RowDataPacket } from 'mysql2/promise';

import { mysqlQualified, quoteMysqlIdent, toBackupLiteral } from '../core/sqlText';
import { BackupTarget, DatabaseError } from '../core/types';
import { BackupDialect, BackupReadParams, BackupTableMeta } from './backupCore';

export interface MysqlBackupContext {
  /** 建立一条独立的备份连接（已配置 dateStrings 等保真选项）。 */
  connect: () => Promise<Connection>;
  /** 释放连接，必须可重复调用。 */
  release: (connection: Connection) => Promise<void>;
}

export class MysqlBackupSession {
  private connection?: Connection;

  constructor(private readonly ctx: MysqlBackupContext) {}

  async open(): Promise<void> {
    // 上一轮备份若被取消，连接会留在这里；开新的一轮前先收干净
    await this.close();
    this.connection = await this.ctx.connect();
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (connection) {
      await this.ctx.release(connection);
    }
  }

  dialect(): BackupDialect {
    return {
      generator: 'DBViewer 内置导出（逐表 SELECT）',
      notes: [
        '不含 DROP TABLE 语句：导入前请确认目标库中不存在同名表',
        '数据为逐表快照，备份期间若有并发写入，各表之间不保证同一时间点',
        '生成列（GENERATED）由表达式算出，不参与 INSERT',
      ],
      // 导入用的客户端未必是 utf8mb4，显式声明可避免中文在还原时变问号
      prologue: 'SET NAMES utf8mb4;',
      qualify: (target) => mysqlQualified(this.requireDatabase(target), target.table),
      quoteIdent: quoteMysqlIdent,
      literal: (value) => toBackupLiteral(value, 'mysql'),
      tableMeta: (target, timeoutMs) => this.tableMeta(target, timeoutMs),
      createSql: (target, timeoutMs) => this.createSql(target, timeoutMs),
      readRows: (params) => this.readRows(params),
      open: () => this.open(),
      close: () => this.close(),
    };
  }

  // ---------------------------------------------------------------- 元数据

  private async tableMeta(target: BackupTarget, timeoutMs: number): Promise<BackupTableMeta> {
    const rows = await this.query<{ COLUMN_NAME: string; COLUMN_KEY: string; EXTRA: string | null }>(
      `SELECT COLUMN_NAME, COLUMN_KEY, EXTRA
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [this.requireDatabase(target), target.table],
      timeoutMs,
    );
    const columns = rows
      // 生成列的值由表达式算出，显式插入会直接报错
      .filter((row) => !/GENERATED/i.test(row.EXTRA ?? ''))
      .map((row) => row.COLUMN_NAME);
    const keys = rows.filter((row) => row.COLUMN_KEY === 'PRI').map((row) => row.COLUMN_NAME);
    return {
      columns,
      // 只有单列主键才用 keyset 分页：复合主键要做行值比较，收益不值这份复杂度，
      // 由状态机自动退回 OFFSET
      keyColumn: keys.length === 1 ? keys[0] : undefined,
    };
  }

  private async createSql(target: BackupTarget, timeoutMs: number): Promise<string | undefined> {
    const rows = await this.query<Record<string, string>>(
      `SHOW CREATE TABLE ${this.dialectQualified(target)}`,
      [],
      timeoutMs,
    );
    const row = rows[0];
    // 视图返回的列名是 Create View，表是 Create Table
    return row?.['Create Table'] ?? row?.['Create View'] ?? undefined;
  }

  private async readRows(params: BackupReadParams): Promise<Record<string, unknown>[]> {
    const { target, columns, keyColumn, afterKey, offset, limit, timeoutMs } = params;
    const qualified = this.dialectQualified(target);
    let sql = `SELECT ${columns.map(quoteMysqlIdent).join(', ')} FROM ${qualified}`;
    const values: unknown[] = [];

    if (keyColumn) {
      if (afterKey !== undefined && afterKey !== null) {
        sql += ` WHERE ${quoteMysqlIdent(keyColumn)} > ?`;
        values.push(afterKey);
      }
      sql += ` ORDER BY ${quoteMysqlIdent(keyColumn)}`;
    }

    if (!keyColumn && offset > 0) {
      // 无单列主键时只能 OFFSET：偏移越大扫得越多，属已知取舍，会在文件头注明
      sql += ` LIMIT ${limit} OFFSET ${offset}`;
    } else {
      sql += ` LIMIT ${limit}`;
    }
    return this.query<Record<string, unknown>>(sql, values, timeoutMs);
  }

  // ---------------------------------------------------------------- 基础

  private dialectQualified(target: BackupTarget): string {
    return mysqlQualified(this.requireDatabase(target), target.table);
  }

  private requireDatabase(target: BackupTarget): string {
    if (!target.database) {
      throw new DatabaseError(
        `表 ${target.table} 缺少所属数据库信息，无法生成全限定名`,
        'ENO_DATABASE',
      );
    }
    return target.database;
  }

  private async query<T>(sql: string, params: unknown[], timeoutMs: number): Promise<T[]> {
    const connection = this.connection;
    if (!connection) {
      throw new DatabaseError('备份连接尚未建立', 'ENOT_CONNECTED');
    }
    try {
      const [rows] = (await connection.query({ sql, values: params, timeout: timeoutMs })) as [
        RowDataPacket[],
        FieldPacket[] | undefined,
      ];
      return (rows ?? []) as unknown as T[];
    } catch (err) {
      throw err instanceof DatabaseError ? err : new DatabaseError((err as Error).message);
    }
  }
}
