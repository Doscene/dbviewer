/**
 * SQL 文本处理工具：语句切分、危险语句识别、标识符转义、值序列化。
 *
 * 这些能力与具体数据库无关，供所有驱动复用。
 */

/** 判定语句是否为写操作 / 危险操作。 */
const DESTRUCTIVE_RE =
  /^\s*(?:with\b[\s\S]*?\b(?:update|delete|insert)\b|update|delete|insert|replace|drop|truncate|alter|create|grant|revoke|rename|comment)\b/i;

export function isDestructiveStatement(sql: string): boolean {
  return DESTRUCTIVE_RE.test(stripLeadingComments(sql));
}

/** 提取语句的首个关键字，用于结果集的 statement 标记。 */
export function statementKind(sql: string): string {
  const cleaned = stripLeadingComments(sql).trim();
  const match = /^([a-zA-Z]+)/.exec(cleaned);
  return match ? match[1].toUpperCase() : 'UNKNOWN';
}

function stripLeadingComments(sql: string): string {
  let text = sql;
  // 循环剥离前置的空格与注释，避免 `/* hi */ select` 被误判
  for (;;) {
    const next = text.replace(/^\s+/, '').replace(/^(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)/, '');
    if (next === text) {
      return text;
    }
    text = next;
  }
}

/**
 * 按分号切分多条语句。
 *
 * 需要处理字符串字面量、引用标识符、行/块注释以及 PostgreSQL 的 `$$ ... $$` 块，
 * 否则函数体里的分号会被错误切分。
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let buffer = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 行注释
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      buffer += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // 块注释（PG 支持嵌套）
    if (ch === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      buffer += sql.slice(i, j);
      i = j;
      continue;
    }

    // PG 美元引用：$$ ... $$ 或 $tag$ ... $tag$
    if (ch === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        buffer += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    // 字符串字面量与引用标识符
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\' && ch === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            // 转义写法：'' 或 "" 或 ``
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      buffer += sql.slice(i, Math.min(j + 1, sql.length));
      i = j + 1;
      continue;
    }

    if (ch === ';') {
      const trimmed = buffer.trim();
      if (trimmed) {
        statements.push(trimmed);
      }
      buffer = '';
      i++;
      continue;
    }

    buffer += ch;
    i++;
  }

  const tail = buffer.trim();
  if (tail) {
    statements.push(tail);
  }
  return statements;
}

/** MySQL 标识符转义：反引号包裹，内部反引号双写。 */
export function quoteMysqlIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

/** PostgreSQL / 标准 SQL 标识符转义：双引号包裹，内部双引号双写。 */
export function quotePgIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 全限定名拼接（MySQL：`db`.`table`）。 */
export function mysqlQualified(database: string | undefined, table: string): string {
  return database ? `${quoteMysqlIdent(database)}.${quoteMysqlIdent(table)}` : quoteMysqlIdent(table);
}

/** 全限定名拼接（PG：`schema`.`table`，schema 缺省走 search_path）。 */
export function pgQualified(schema: string | undefined, table: string): string {
  return schema ? `${quotePgIdent(schema)}.${quotePgIdent(table)}` : quotePgIdent(table);
}

/**
 * MySQL 字符串字面量。
 *
 * 反斜杠在 MySQL 中默认是转义引导符（除非服务端开启 `NO_BACKSLASH_ESCAPES`），
 * 因此必须连同反斜杠一起转义——只双写单引号会让 `a\b` 这类值被解释成控制字符。
 */
export function quoteMysqlString(text: string): string {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/\u0000/g, '\\0')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u001a/g, '\\Z');
  return `'${escaped}'`;
}

/**
 * PostgreSQL 字符串字面量。
 *
 * `standard_conforming_strings` 自 9.1 起默认为 on，反斜杠不再具有转义含义，
 * 因此只需双写单引号；否则值里的反斜杠会被二次解释。
 */
export function quotePgString(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * 把 JavaScript 值渲染成 SQL 字面量。
 *
 * 用于结果面板的单元格编辑：只有走这一步，用户输入的字符串才不会被当成 SQL 片段执行。
 */
export function toSqlLiteral(value: unknown, dialect: 'mysql' | 'postgresql'): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return dialect === 'mysql' ? (value ? '1' : '0') : value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return dialect === 'mysql' ? quoteMysqlString(text) : quotePgString(text);
}

/**
 * 把驱动返回的原生值转换成可安全 JSON 序列化的形式。
 *
 * 结果面板与导出都要经过这一步，否则 BigInt / Buffer / Date 会直接抛错。
 */
export function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  const type = typeof value;
  if (type === 'bigint') {
    return (value as bigint).toString();
  }
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    // 二进制列用 hex 展示，保留可辨识性且不撑爆内存
    const buf = value as Buffer;
    return buf.length > 1024 ? `<binary ${buf.length} bytes>` : `0x${buf.toString('hex')}`;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (type === 'object') {
    // pg 的 Point/几何类型、mysql2 的 Decimal 等都带 toString，优先采用
    const obj = value as { toString?: () => string; toPostgres?: () => string };
    if (typeof obj.toPostgres === 'function') {
      return obj.toPostgres();
    }
    if (obj.constructor && obj.constructor.name !== 'Object' && typeof obj.toString === 'function') {
      const text = obj.toString();
      if (text && text !== '[object Object]') {
        return text;
      }
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = sanitizeValue(v);
    }
    return result;
  }
  return String(value);
}

/** 批量清理结果行。 */
export function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = sanitizeValue(value);
  }
  return out;
}

/**
 * 依据超时时间包裹 Promise。
 * 驱动自身通常也支持超时，这里是兜底，防止个别驱动忽略配置造成界面永久卡住。
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------- 备份字面量

/**
 * 把原始值渲染成备份文件里可用的 SQL 字面量。
 *
 * 与 `toSqlLiteral` 的区别是「保真优先」，因为备份文件的唯一用途是**还原**：
 * - `Date` 用本地时区的 `'YYYY-MM-DD HH:mm:ss.SSS'`，而不是 ISO 串 —— ISO 里的
 *   `T` 与 `Z` 在 MySQL 下语义不明确，跨时区还原会偏移；
 * - `Buffer` 用十六进制字节字面量（MySQL `X'..'`、PG `'\x..'::bytea`），
 *   `toString()` 会把二进制彻底毁掉；
 * - PG 的数组用数组字面量 `'{...}'`，JSON 化后 `int[]` 列会插入失败。
 *
 * 只负责「值 → 字面量」，标识符引用交给 `quoteMysqlIdent` / `quotePgIdent`。
 */
export function toBackupLiteral(value: unknown, dialect: 'mysql' | 'postgresql'): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return dialect === 'mysql' ? (value ? '1' : '0') : value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return quoteTimestamp(value, dialect);
  }
  if (Buffer.isBuffer(value)) {
    const hex = value.toString('hex');
    return dialect === 'mysql' ? `X'${hex}'` : `'\\x${hex}'::bytea`;
  }
  if (Array.isArray(value)) {
    // MySQL 没有数组类型，走到这里只可能是 JSON 列里嵌的数组
    const text = dialect === 'mysql' ? JSON.stringify(value) : pgArrayLiteral(value);
    return dialect === 'mysql' ? quoteMysqlString(text) : quotePgString(text);
  }
  if (typeof value === 'object') {
    // PG 的 json / jsonb 会反序列化成对象，写回 JSON 文本即可被隐式转换
    const text = JSON.stringify(value);
    return dialect === 'mysql' ? quoteMysqlString(text) : quotePgString(text);
  }
  const text = String(value);
  return dialect === 'mysql' ? quoteMysqlString(text) : quotePgString(text);
}

function quoteTimestamp(value: Date, dialect: 'mysql' | 'postgresql'): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const text =
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` +
    ` ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}` +
    `.${pad(value.getMilliseconds(), 3)}`;
  return dialect === 'mysql' ? quoteMysqlString(text) : quotePgString(text);
}

/**
 * PG 数组字面量。
 *
 * 元素一律用双引号包裹并转义反斜杠与引号，空元素写 `NULL`——
 * 这样无论元素是数字、时间还是含逗号的文本都能被解析回原值；
 * 嵌套数组直接递归拼接（PG 期望 `{{1,2},{3,4}}`，外层不能再加引号）。
 */
export function pgArrayLiteral(values: unknown[]): string {
  const parts = values.map((item) => {
    if (item === null || item === undefined) {
      return 'NULL';
    }
    if (Array.isArray(item)) {
      return pgArrayLiteral(item);
    }
    const text = item instanceof Date ? item.toISOString() : String(item);
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${parts.join(',')}}`;
}
