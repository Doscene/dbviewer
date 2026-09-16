/**
 * 结果集的「可编辑目标」推导。
 *
 * 单元格编辑要能落地，必须同时知道两件事：**真实的表名** 与 **能唯一定位一行的列**。
 * 这两样都不能仅靠正则从 SQL 里"猜"出来当权威——猜错的后果是生成一条改错行的 UPDATE，
 * 而且没有 undo。所以这里的策略是：
 *
 * 1. 表名可以推导（表数据预览直接给；临时 SELECT 从 `FROM` 子句里读）；
 * 2. 主键一律回源到 `listColumns`，绝不从 SQL 或结果列名里臆断；
 * 3. 主键列必须全部出现在结果列中，否则拒绝提供编辑能力。
 *
 * 结论：推导不出来就不给编辑入口，而不是"尽力而为"地改一行。
 */

import { ColumnNode, IDatabaseDriver, QueryTarget } from './types';

export interface EditTarget {
  database?: string;
  schema?: string;
  table: string;
  /** 构成 WHERE 条件的列名（主键），必然全部存在于结果列中。 */
  identity: string[];
}

/**
 * 解析 `FROM` 子句里的表名，支持 `db.t` / `"schema"."t"` / `` `db`.`t` `` / `[dbo].[t]`。
 *
 * 只认第一个 `FROM`，且其后必须紧跟标识符链——`FROM (subquery)` 这类直接放弃，
 * 否则会把内层子查询的表当成目标表。
 */
export function extractFromTable(sql: string): { qualifier?: string; table: string } | undefined {
  const masked = maskLiterals(sql);
  const match = /\bfrom\b/i.exec(masked);
  if (!match) {
    return undefined;
  }
  const rest = masked.slice(match.index + match[0].length);
  const ident = '("[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
  const chain = new RegExp(`^\\s*(${ident}(?:\\s*\\.\\s*${ident})?)`).exec(rest);
  if (!chain) {
    return undefined;
  }
  const parts = chain[1].split('.').map((part) => unquoteIdent(part.trim()));
  if (parts.some((part) => !part)) {
    return undefined;
  }
  return parts.length > 1 ? { qualifier: parts[0], table: parts[1] } : { table: parts[0] };
}

/**
 * 推导结果集是否可编辑。
 *
 * `fallback` 由调用方在已知目标表时提供（例如树视图的「查看数据」），
 * 它比正则推导可靠，优先级更高。
 */
export async function resolveEditTarget(
  driver: IDatabaseDriver,
  sql: string,
  fields: string[],
  fallback?: QueryTarget & { table: string },
): Promise<EditTarget | undefined> {
  // 能力声明与实现必须同时具备：sidecar 代理在没有 updateCell 时调用会直接抛错
  if (!driver.capabilities.editable || typeof driver.updateCell !== 'function') {
    return undefined;
  }

  const target = fallback ?? deriveTargetFromSql(driver, sql);
  if (!target) {
    return undefined;
  }

  let columns: ColumnNode[];
  try {
    columns = await driver.listColumns(target);
  } catch {
    // 元数据读取失败（权限、超时）只影响编辑能力，不应打断查询结果的展示
    return undefined;
  }

  const identity = columns.filter((column) => column.isPrimaryKey).map((column) => column.name);
  if (identity.length === 0) {
    return undefined;
  }
  const present = new Set(fields);
  if (!identity.every((name) => present.has(name))) {
    return undefined;
  }
  return { database: target.database, schema: target.schema, table: target.table, identity };
}

function deriveTargetFromSql(
  driver: IDatabaseDriver,
  sql: string,
): (QueryTarget & { table: string }) | undefined {
  const masked = maskLiterals(sql);
  // 只认最简单的单表 SELECT。CTE / UNION / JOIN 都可能有歧义，直接放弃。
  if (!/^\s*select\b/i.test(masked)) {
    return undefined;
  }
  const parsed = extractFromTable(masked);
  if (!parsed) {
    return undefined;
  }
  if (parsed.qualifier) {
    // PG 的两段式是 schema.table，MySQL 的两段式是 database.table——由能力声明区分
    return driver.capabilities.schemas
      ? { schema: parsed.qualifier, table: parsed.table }
      : { database: parsed.qualifier, table: parsed.table };
  }
  return { table: parsed.table };
}

function unquoteIdent(part: string): string {
  if (part.length >= 2 && /^["`[]/.test(part[0]) && /["`\]]$/.test(part[part.length - 1])) {
    const inner = part.slice(1, -1);
    // 双引号 / 反引号的转义是重复两次
    return inner.replace(/""/g, '"').replace(/``/g, '`');
  }
  return part;
}

/**
 * 把字面量与注释替换成等长空白。
 *
 * 保持长度不变很关键——这样才能拿掩码后的下标去原始文本里取表名。
 * 双引号与反引号是标识符，必须保留；只有单引号字符串、`--` / `/* *\/` 注释需要抹掉。
 */
function maskLiterals(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      out += ' ';
      i += 1;
      while (i < sql.length) {
        // '' 与 \' 都是转义，整体跳过避免提前结束字符串
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += '  ';
          i += 2;
          continue;
        }
        if (sql[i] === '\\' && sql[i + 1] !== undefined) {
          out += '  ';
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          out += ' ';
          i += 1;
          break;
        }
        out += ' ';
        i += 1;
      }
      continue;
    }
    // MySQL 里 `--` 必须后跟空白才算注释，避免把 `1--2` 误判为注释
    if (ch === '-' && sql[i + 1] === '-' && (sql[i + 2] === undefined || /\s/.test(sql[i + 2]))) {
      while (i < sql.length && sql[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += ' ';
        i += 1;
      }
      if (i < sql.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
