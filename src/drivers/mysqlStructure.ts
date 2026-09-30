/**
 * MySQL 方言的表结构 / 库属性变更语句生成。
 *
 * 刻意与驱动实现分开：这里是纯函数（外加一个查默认排序规则的回调），不碰连接、
 * 不 require mysql2，因此冒烟测试可以直接 require 它并断言生成的 DDL ——
 * 一条写错的 ALTER 是会丢数据的，这一段必须能被测试咬住。
 *
 * 驱动侧只负责「读现状」与「执行语句」，差异怎么算、子句怎么拼全在这里。
 */

import {
  diffPrimaryKey,
  diffProperties,
  diffTableColumns,
  normalizeDefaultText,
  normalizeTypeText,
  propertyChangeValue,
  summarizeColumnsDiff,
  validateColumnDefinitions,
  validateObjectName,
} from '../core/objectEditor';
import { mysqlQualified, quoteMysqlIdent, quoteMysqlString } from '../core/sqlText';
import {
  DatabaseChangeRequest,
  DatabaseError,
  DatabaseProperties,
  ObjectChangePlan,
  TableChangeRequest,
  TableColumnDefinition,
  TableStructure,
} from '../core/types';

/** 列类型候选：界面用 datalist 提示，不限制自由填写（MySQL 的类型组合太多）。 */
export const MYSQL_COLUMN_TYPES = [
  'int',
  'bigint',
  'smallint',
  'tinyint',
  'mediumint',
  'int unsigned',
  'bigint unsigned',
  'decimal(10,2)',
  'float',
  'double',
  'char(1)',
  'varchar(255)',
  'text',
  'mediumtext',
  'longtext',
  'json',
  'date',
  'time',
  'datetime',
  'timestamp',
  'year',
  'binary(16)',
  'varbinary(255)',
  'blob',
];

/** 默认值需要补引号的类型：这些类型的 `COLUMN_DEFAULT` 是不带引号的裸文本。 */
const QUOTED_DEFAULT_TYPE_RE =
  /(char|varchar|text|enum|set|date|time|timestamp|year|binary|varbinary|blob|json|geometry)/i;

/** MySQL 里可以不加括号写的默认值关键字。 */
const BARE_DEFAULT_KEYWORDS_RE =
  /^(current_timestamp|current_date|current_time|localtimestamp|localtime|null|true|false)(\(\d*\))?$/i;

/**
 * 只能写**表达式默认值**的类型。
 *
 * MySQL 8.0.13 起才允许它们有默认值，且必须写成 `DEFAULT (…)`；
 * 裸着写会得到 `BLOB, TEXT, GEOMETRY or JSON column can't have a default value`（真库实测）。
 */
const EXPRESSION_ONLY_TYPES = new Set([
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
  'json',
  'geometry',
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geometrycollection',
]);

/**
 * MySQL 读回的表达式默认值会带字符集引导符，且引号被反斜杠转义：
 * `DEFAULT ('hello')` 在 `information_schema` 里是 `_utf8mb4\'hello\'`。
 */
const CHARSET_INTRODUCER_RE = /^_[A-Za-z0-9]+\s*\\?'/;

export interface MysqlPlanContext {
  /** 查某字符集的默认排序规则；只改字符集时用它补齐 COLLATE。 */
  defaultCollationOf(charset: string): Promise<string | undefined>;
}

/**
 * 生成表结构变更计划。
 *
 * `ALTER TABLE` 的所有子句合并成一条语句：MySQL 对「同一列出现两次」直接报错，
 * 拆成多条反而更容易踩到（改定义 + 调位置本质是同一列的同一件事）。
 */
export async function buildMysqlTablePlan(
  current: TableStructure,
  request: TableChangeRequest,
  context: MysqlPlanContext,
): Promise<ObjectChangePlan> {
  const database = current.target.database ?? '';
  const table = current.target.table;
  const qualified = mysqlQualified(database, table);
  const desired = request.columns ?? [];

  const invalid = validateColumnDefinitions(desired);
  if (invalid) {
    throw new DatabaseError(invalid, 'EINVALID_STRUCTURE');
  }

  const statements: string[] = [];
  const changes: string[] = [];
  const warnings: string[] = [];

  const propertyChanges = diffProperties(current.properties, request.properties ?? {});
  const rename = propertyChangeValue(propertyChanges, 'name');
  if (rename && rename !== table) {
    const problem = validateObjectName(rename, '表名');
    if (problem) {
      throw new DatabaseError(problem, 'EINVALID_NAME');
    }
  }

  const diff = diffTableColumns(current.columns, desired, sameMysqlColumn, true);
  const pk = diffPrimaryKey(current.columns, desired);
  const clauses: string[] = [];

  // 主键的删除必须排在删列之前：删掉主键列时 MySQL 会连带丢掉主键，
  // 那时再执行 DROP PRIMARY KEY 反而会报「主键不存在」
  if (pk.changed && current.columns.some((column) => column.isPrimaryKey)) {
    clauses.push('DROP PRIMARY KEY');
  }

  // 按目标顺序逐列生成子句；列顺序只在这里被表达一次，不会出现重复列名的子句
  for (const step of diff.steps) {
    const definition = renderMysqlColumn(step.column);
    if (!step.origin) {
      clauses.push(`ADD COLUMN ${definition}${positionClause(step.after)}`);
    } else if (step.renamed) {
      clauses.push(
        `CHANGE COLUMN ${quoteMysqlIdent(step.origin.name)} ${definition}` +
          (step.reposition ? positionClause(step.after) : ''),
      );
    } else if (step.modified || step.reposition) {
      clauses.push(`MODIFY COLUMN ${definition}${step.reposition ? positionClause(step.after) : ''}`);
    }
  }
  for (const column of diff.dropped) {
    clauses.push(`DROP COLUMN ${quoteMysqlIdent(column.name)}`);
  }

  if (pk.changed) {
    if (pk.target.length) {
      clauses.push(`ADD PRIMARY KEY (${pk.target.map(quoteMysqlIdent).join(', ')})`);
    }
    changes.push(pk.target.length ? `主键：${pk.target.join(', ')}` : '删除主键');
  }

  for (const change of propertyChanges) {
    if (change.key === 'name') {
      continue;
    }
    if (change.key === 'engine') {
      clauses.push(`ENGINE = ${optionValue(change.to)}`);
    } else if (change.key === 'charset') {
      clauses.push(`DEFAULT CHARACTER SET = ${optionValue(change.to)}`);
      // 只改字符集时补上该字符集的默认排序规则：否则服务端可能沿用旧的、与之不兼容的排序规则
      if (!propertyChanges.some((item) => item.key === 'collation')) {
        const fallback = await context.defaultCollationOf(change.to);
        if (fallback) {
          clauses.push(`COLLATE = ${optionValue(fallback)}`);
        }
      }
    } else if (change.key === 'collation') {
      clauses.push(`COLLATE = ${optionValue(change.to)}`);
    } else if (change.key === 'comment') {
      clauses.push(`COMMENT = ${quoteMysqlString(change.to)}`);
    } else {
      warnings.push(`未识别的表属性，已跳过：${change.label}`);
      continue;
    }
    changes.push(`${change.label}：${change.from || '(空)'} → ${change.to || '(空)'}`);
  }

  changes.unshift(...summarizeColumnsDiff(diff));
  if (diff.dropped.length) {
    // 列出列名：应用前那一秒，用户要能一眼看见到底哪几列的数据要没了
    warnings.push(
      `将删除 ${diff.dropped.length} 个列（${diff.dropped.map((column) => column.name).join('、')}）：` +
        '列上的数据会一起丢弃，且无法回滚。',
    );
  }
  if (desired.some((column) => column.autoIncrement) && !desired.some((column) => column.isPrimaryKey)) {
    warnings.push('AUTO_INCREMENT 列必须被索引：请把它设为主键，或先自行添加唯一索引。');
  }

  if (clauses.length) {
    statements.push(`ALTER TABLE ${qualified}\n  ${clauses.join(',\n  ')};`);
  }
  // 改名放在最后：前面的子句都按旧表名寻址，先改名会让它们全部失效
  if (rename && rename !== table) {
    statements.push(`RENAME TABLE ${qualified} TO ${mysqlQualified(database, rename)};`);
    changes.push(`重命名表：${table} → ${rename}`);
  }

  return { statements, changes, warnings: warnings.length ? warnings : undefined };
}

/**
 * 生成库属性变更计划；MySQL 的库级可改项只有字符集与排序规则。
 *
 * 注意 `ALTER DATABASE` 与 `ALTER TABLE` 的语法差别：它**不接受逗号分隔的多个选项**
 * （真库实测 `CHARACTER SET = a, COLLATE = b` 直接语法错误），只能空格连着写。
 */
export async function buildMysqlDatabasePlan(
  current: DatabaseProperties,
  request: DatabaseChangeRequest,
  context: MysqlPlanContext,
): Promise<ObjectChangePlan> {
  const changes: string[] = [];
  const clauses: string[] = [];
  const propertyChanges = diffProperties(current.properties, request.properties ?? {});

  for (const change of propertyChanges) {
    if (change.key === 'charset') {
      clauses.push(`CHARACTER SET = ${optionValue(change.to)}`);
      if (!propertyChanges.some((item) => item.key === 'collation')) {
        const fallback = await context.defaultCollationOf(change.to);
        if (fallback) {
          clauses.push(`COLLATE = ${optionValue(fallback)}`);
        }
      }
    } else if (change.key === 'collation') {
      clauses.push(`COLLATE = ${optionValue(change.to)}`);
    } else {
      continue;
    }
    changes.push(`${change.label}：${change.from || '(空)'} → ${change.to || '(空)'}`);
  }

  const statements = clauses.length
    ? [`ALTER DATABASE ${quoteMysqlIdent(request.target.name)} ${clauses.join(' ')};`]
    : [];
  return { statements, changes };
}

/** 目标位置子句：MySQL 用 FIRST / AFTER，两者必须择一给出。 */
export function positionClause(after?: string): string {
  return after ? ` AFTER ${quoteMysqlIdent(after)}` : ' FIRST';
}

/**
 * 引擎名 / 字符集 / 排序规则这类「选项值」的字面量。
 *
 * 纯字母数字下划线就直接输出：这些值要么来自 `SHOW` 的结果，要么来自界面上的下拉选项，
 * 给每个都套一层反引号会让预览里的 DDL 不像人手写的；不满足白名单的一律加引号，
 * 免得一个带分号的怪值拼进语句里。
 */
function optionValue(value: string): string {
  const text = (value ?? '').trim();
  return /^[A-Za-z0-9_]+$/.test(text) ? text : quoteMysqlIdent(text);
}

/**
 * 渲染一列的完整定义。
 *
 * 可空列省略 `NULL`：显式写 `NULL` 在 `explicit_defaults_for_timestamp=OFF` 的老服务端上
 * 会顺带改掉时间列的默认行为，不写才是「保持可空」的中性表达。
 */
export function renderMysqlColumn(column: TableColumnDefinition): string {
  const parts = [quoteMysqlIdent(column.name.trim()), column.dataType.trim()];
  if (!column.nullable) {
    parts.push('NOT NULL');
  }
  const defaultValue = renderMysqlDefault(column);
  if (defaultValue) {
    parts.push(defaultValue);
  }
  // 顺序跟着 MySQL 自己的写法走：DEFAULT … ON UPDATE … AUTO_INCREMENT … COMMENT …
  const extra = (column.extraClauses ?? '').trim();
  if (extra) {
    parts.push(extra);
  }
  if (column.autoIncrement) {
    parts.push('AUTO_INCREMENT');
  }
  const comment = (column.comment ?? '').trim();
  if (comment) {
    parts.push(`COMMENT ${quoteMysqlString(comment)}`);
  }
  return parts.join(' ');
}

/**
 * 渲染默认值子句。
 *
 * 三个真库实测出来的坑（都只能靠连真库才撞得出来）：
 * 1. `information_schema.COLUMNS.COLUMN_DEFAULT` 给的是**不带引号的裸文本**
 *    （`DEFAULT 'abc'` 读回来是 `abc`，`DEFAULT 0` 读回来是 `0`），因此必须结合列类型
 *    判断要不要补引号；MariaDB 会把引号一起返回，已带引号的按原样使用。
 * 2. 表达式默认值读回来是**转义过**的，且带字符集引导符
 *    （`DEFAULT ('hello')` → `_utf8mb4\'hello\'`），原样写回会报语法错误，必须先反转义。
 * 3. MySQL 8 要求表达式默认值写成 `DEFAULT (expr)`（内置时间函数除外），
 *    而 TEXT / BLOB / JSON / GEOMETRY 列**只能**用表达式形式。
 */
export function renderMysqlDefault(column: TableColumnDefinition): string {
  if (column.defaultValue === null || column.defaultValue === undefined) {
    return '';
  }
  const text = String(column.defaultValue).trim();
  const expressionOnly = isExpressionOnlyType(column.dataType);
  if (text === '') {
    // 空串默认值与「没有默认值」是两回事，不能合并
    return expressionOnly ? "DEFAULT ('')" : "DEFAULT ''";
  }
  if (isExpressionDefault(text)) {
    const expression = unescapeMysqlText(text);
    if (isAlreadyWritableExpression(expression)) {
      return `DEFAULT ${expression}`;
    }
    return `DEFAULT (${expression})`;
  }
  if (expressionOnly) {
    // 用户在界面上给 TEXT / JSON 列填了普通值：服务端只认 DEFAULT ('…') 这种表达式写法
    return `DEFAULT (${quoteMysqlString(text)})`;
  }
  if (QUOTED_DEFAULT_TYPE_RE.test(column.dataType)) {
    return `DEFAULT ${quoteMysqlString(text)}`;
  }
  // 走到这里只剩数字 / 布尔类型：纯数字字面量裸写，其余（如 `3 * 7`）按表达式加括号——
  // MySQL 8 不接受不带括号的裸表达式默认值
  if (text.startsWith('(') || /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) {
    return `DEFAULT ${text}`;
  }
  return `DEFAULT (${text})`;
}

/** 默认值是否已是完整表达式（字符串字面量、函数调用、时间关键字、字符集引导符）。 */
function isExpressionDefault(text: string): boolean {
  if (BARE_DEFAULT_KEYWORDS_RE.test(text) || CHARSET_INTRODUCER_RE.test(text)) {
    return true;
  }
  if (isQuotedLiteral(text)) {
    return true;
  }
  return /\w\s*\(/.test(text);
}

/** 已经可以原样跟在 `DEFAULT` 后面的形态：不必再补括号。 */
function isAlreadyWritableExpression(expression: string): boolean {
  return (
    expression.startsWith('(') ||
    BARE_DEFAULT_KEYWORDS_RE.test(expression) ||
    isQuotedLiteral(expression)
  );
}

/** 字符串字面量：`'abc'` / `x'ff'` / `b'0'`。 */
function isQuotedLiteral(text: string): boolean {
  return /^'[\s\S]*'$/.test(text) || /^[xXbB]'[^']*'$/.test(text);
}

/** 类型是否属于「只能写表达式默认值」的一类（忽略长度与 unsigned 之类的修饰）。 */
function isExpressionOnlyType(dataType: string): boolean {
  const base = normalizeTypeText(dataType).replace(/\([\s\S]*$/, '').replace(/\s+(unsigned|zerofill)$/i, '').trim();
  return EXPRESSION_ONLY_TYPES.has(base);
}

/**
 * 反转义 `information_schema` 给出的表达式文本。
 *
 * 单次从左到右扫描而不是连续 replace：`\\'`（转义反斜杠 + 真正的引号）在先替换反斜杠的
 * 写法里会被误伤成 `\'`，于是引号又被吃掉一层。
 */
function unescapeMysqlText(text: string): string {
  const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '0': '\0', b: '\b', Z: '\u001a' };
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && index + 1 < text.length) {
      index += 1;
      const next = text[index];
      out += next in escapes ? escapes[next] : next;
    } else {
      out += char;
    }
  }
  return out;
}

/** 除列名外是否等价：列名差异由「重命名」单独判定，主键由主键差异单独判定。 */
export function sameMysqlColumn(a: TableColumnDefinition, b: TableColumnDefinition): boolean {
  return (
    normalizeTypeText(a.dataType) === normalizeTypeText(b.dataType) &&
    !!a.nullable === !!b.nullable &&
    normalizeDefaultText(a.defaultValue) === normalizeDefaultText(b.defaultValue) &&
    !!a.autoIncrement === !!b.autoIncrement &&
    // 两边大小写可能不同（服务端给的是 `on update …`，我们拼的是 `ON UPDATE …`）
    (a.extraClauses ?? '').trim().toLowerCase() === (b.extraClauses ?? '').trim().toLowerCase() &&
    (a.comment ?? '').trim() === (b.comment ?? '').trim()
  );
}

/**
 * 客户端没回传的 `extraClauses` 从读回的现状里继承。
 *
 * 界面不认识这个字段时不该被理解成「用户把 ON UPDATE 删了」——那会静默改掉表行为。
 * 因此这里按 `originalName` 兜底：请求里缺什么，就从现状里补什么。
 */
export function inheritMysqlExtraClauses(
  current: TableStructure,
  request: TableChangeRequest,
): TableChangeRequest {
  if (!request.columns) {
    return request;
  }
  const originals = new Map<string, TableColumnDefinition>();
  for (const column of current.columns) {
    originals.set(column.originalName ?? column.name, column);
  }
  return {
    ...request,
    columns: request.columns.map((column) => {
      if (column.extraClauses || !column.originalName) {
        return column;
      }
      const origin = originals.get(column.originalName);
      if (!origin?.extraClauses) {
        return column;
      }
      return { ...column, extraClauses: origin.extraClauses };
    }),
  };
}
