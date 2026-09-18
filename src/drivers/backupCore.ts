/**
 * 驱动共用的备份状态机。
 *
 * 分层的理由与 `support.ts` 的 `executeScript` 一致：**流程与方言分离**。
 * 这里负责「游标推进、分页、INSERT 拼装、跳过失败对象、产出进度」这套与数据库无关的流程，
 * 具体方言只通过 `BackupDialect` 注入五个小方法。
 *
 * 这样做的直接收益：
 * - 两个驱动的备份实现各自只剩几十行方言代码，不会有第二份分页逻辑漂移；
 * - 状态机可以在纯 Node 测试里用一个假方言跑完整流程（含取消、跳过、多表切换），
 *   不需要真的连数据库。
 *
 * 关于游标：状态编码进游标字符串而不是放在驱动实例字段上，因为扩展侧可能同时发起
 * 多个备份（不同范围），实例字段会被互相覆盖；游标随请求往返，天然支持并发。
 */

import { BackupChunk, BackupChunkRequest, BackupMode, BackupSkip, BackupTarget } from '../core/types';
import { DatabaseError } from '../core/types';

/** 每条 INSERT 语句携带的最大行数：再多单条语句会过长，出错时定位也困难。 */
const INSERT_BATCH = 100;

export interface BackupTableMeta {
  /** 参与 INSERT 的列（已排除生成列，写进去会报错）。 */
  columns: string[];
  /** 可用于 keyset 分页的单列主键；没有则退回 OFFSET 分页。 */
  keyColumn?: string;
}

export interface BackupReadParams {
  target: BackupTarget;
  columns: string[];
  keyColumn?: string;
  /** keyset 分页：只取该值之后的行。 */
  afterKey?: unknown;
  /** OFFSET 分页：已跳过的行数。 */
  offset: number;
  limit: number;
  timeoutMs: number;
}

/**
 * 一种数据库方言的备份适配层。
 *
 * 所有 SQL 生成（标识符引用、字面量转义、分页语法）都经由这里，因此通用层
 * 不会出现任何数据库特有的拼装，新增驱动只需实现这几个方法。
 */
export interface BackupDialect {
  /** 写进文件头的生成器说明。 */
  generator: string;
  /** 写进文件头的已知缺口。 */
  notes: string[];
  /** 文件开头的连接级设置（如 `SET NAMES utf8mb4;`）。 */
  prologue: string;
  /** 全限定名。 */
  qualify(target: BackupTarget): string;
  /** 标识符引用。 */
  quoteIdent(name: string): string;
  /** 值 → SQL 字面量（保真优先，见 `toBackupLiteral`）。 */
  literal(value: unknown): string;
  /** 读取表结构元数据：可插入列 + 单列主键。 */
  tableMeta(target: BackupTarget, timeoutMs: number): Promise<BackupTableMeta>;
  /** 建表语句（视图则是视图定义）。 */
  createSql(target: BackupTarget, timeoutMs: number): Promise<string | undefined>;
  /** 读取一段数据。 */
  readRows(params: BackupReadParams): Promise<Record<string, unknown>[]>;
  /** 备份开始：建立独立连接（不影响用户正在用的那条）。 */
  open?(): Promise<void>;
  /** 备份结束 / 取消：释放连接，必须可重复调用。 */
  close?(): Promise<void>;
}

interface BackupCursorState {
  /** 当前表下标。 */
  t: number;
  /** OFFSET 分页已跳过的行数。 */
  o: number;
  /** keyset 分页的上一行主键值。 */
  k?: unknown;
  /** 当前表的结构是否已输出。 */
  d?: boolean;
  /** 累计已导出的数据行数。 */
  r: number;
  /** 当前表的可插入列。 */
  cols?: string[];
  /** 当前表的单列主键。 */
  pk?: string;
}

/**
 * 产出备份文本片段。
 *
 * 每次调用做「有限的工作量」（默认一块 = chunkRows 行），做完就带着新游标返回，
 * 由调用方决定继续、暂停还是取消。空表、纯结构模式、读取失败都会推进游标，
 * 因此不存在「反复返回同一游标」的死循环。
 */
export async function runBackupChunks(
  dialect: BackupDialect,
  mode: BackupMode,
  request: BackupChunkRequest,
): Promise<BackupChunk> {
  const totalTables = request.tables.length;
  const state = decodeCursor(request.cursor);
  const out: string[] = [];
  const skipped: BackupSkip[] = [];

  if (!request.cursor) {
    await dialect.open?.();
    if (dialect.prologue) {
      out.push(`${dialect.prologue}\n`);
    }
  }

  if (totalTables === 0) {
    await dialect.close?.();
    return { text: out.join(''), nextCursor: null, progress: { rows: 0, doneTables: 0, totalTables: 0 } };
  }

  let budget = Math.max(1, request.chunkRows);

  while (budget > 0 && state.t < totalTables) {
    const target = request.tables[state.t];
    const label = qualifiedLabel(target);

    try {
      if (!state.d) {
        out.push(`\n-- ${'-'.repeat(60)}\n-- ${label}\n-- ${'-'.repeat(60)}\n`);
        if (mode.includesSchema) {
          const ddl = await dialect.createSql(target, request.timeoutMs);
          out.push(ddl ? `${withSemicolon(ddl)}\n` : `-- 未能获取建表语句\n`);
        }
        state.d = true;
        // 视图的数据是派生的，导定义就够了；强行 INSERT 进视图在多数数据库上不成立
        const needData = mode.includesData && target.kind === 'table';
        if (needData) {
          const meta = await dialect.tableMeta(target, request.timeoutMs);
          state.cols = meta.columns;
          state.pk = meta.keyColumn;
        }
        if (!needData || !state.cols?.length) {
          advance(state);
          continue;
        }
        state.o = 0;
        state.k = undefined;
      }

      const columns = state.cols ?? [];
      const limit = Math.min(budget, Math.max(1, request.chunkRows));
      const rows = await dialect.readRows({
        target,
        columns,
        keyColumn: state.pk,
        afterKey: state.pk ? state.k : undefined,
        offset: state.o,
        limit,
        timeoutMs: request.timeoutMs,
      });

      if (rows.length) {
        out.push(buildInsert(dialect, target, columns, rows));
        state.r += rows.length;
        if (state.pk) {
          state.k = rows[rows.length - 1][state.pk];
        } else {
          state.o += rows.length;
        }
      }
      budget -= rows.length;

      // 读回的行数少于请求上限，说明这张表已经读完
      if (rows.length < limit) {
        advance(state);
      }
    } catch (err) {
      // 单张表失败（权限不足、表被删等）不该毁掉整次备份：记下来继续下一张
      skipped.push({ name: label, reason: firstLine(err) });
      advance(state);
    }
  }

  const done = state.t >= totalTables;
  if (done) {
    await dialect.close?.();
  }

  return {
    text: out.join(''),
    nextCursor: done ? null : encodeCursor(state),
    skipped: skipped.length ? skipped : undefined,
    progress: {
      table: done ? undefined : qualifiedLabel(request.tables[state.t]),
      rows: state.r,
      doneTables: done ? totalTables : state.t,
      totalTables,
    },
  };
}

/** 表名带上命名空间，供文件注释与进度显示——只写表名在跨库备份里会分不清。 */
export function qualifiedLabel(target: BackupTarget): string {
  const prefix = target.schema ?? target.database;
  return prefix ? `${prefix}.${target.table}` : target.table;
}

function buildInsert(
  dialect: BackupDialect,
  target: BackupTarget,
  columns: string[],
  rows: Record<string, unknown>[],
): string {
  const qualified = dialect.qualify(target);
  const columnList = columns.map((column) => dialect.quoteIdent(column)).join(', ');
  const statements: string[] = [];
  for (let index = 0; index < rows.length; index += INSERT_BATCH) {
    const batch = rows.slice(index, index + INSERT_BATCH);
    const values = batch
      .map((row) => `  (${columns.map((column) => dialect.literal(row[column])).join(', ')})`)
      .join(',\n');
    statements.push(`INSERT INTO ${qualified} (${columnList}) VALUES\n${values};`);
  }
  return `${statements.join('\n')}\n`;
}

function advance(state: BackupCursorState): void {
  state.t += 1;
  state.d = false;
  state.o = 0;
  state.k = undefined;
  state.cols = undefined;
  state.pk = undefined;
}

function withSemicolon(sql: string): string {
  const trimmed = sql.trimEnd();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

function firstLine(err: unknown): string {
  const message = (err as Error)?.message ?? String(err);
  return message.split('\n')[0];
}

export function encodeCursor(state: BackupCursorState): string {
  return JSON.stringify(state);
}

export function decodeCursor(cursor?: string): BackupCursorState {
  if (!cursor) {
    return { t: 0, o: 0, r: 0 };
  }
  try {
    const parsed = JSON.parse(cursor) as Partial<BackupCursorState>;
    return {
      t: Math.max(0, Number(parsed.t) || 0),
      o: Math.max(0, Number(parsed.o) || 0),
      k: parsed.k,
      d: !!parsed.d,
      r: Math.max(0, Number(parsed.r) || 0),
      cols: Array.isArray(parsed.cols) ? parsed.cols : undefined,
      pk: typeof parsed.pk === 'string' ? parsed.pk : undefined,
    };
  } catch {
    throw new DatabaseError('备份游标已损坏，请重新开始备份', 'EBAD_CURSOR');
  }
}
