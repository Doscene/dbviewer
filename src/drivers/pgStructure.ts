/**
 * PostgreSQL 方言的表结构 / schema 属性变更语句生成。
 *
 * 与 MySQL 侧同样的理由抽成纯函数：不碰连接、不 require pg，冒烟测试可以直接断言 DDL。
 *
 * 与 MySQL 的关键差异（都在这里被消化）：
 * - 没有 `AFTER` 语义，列顺序不可调；
 * - 每条改动是独立语句（`ALTER COLUMN ... TYPE` / `SET NOT NULL` / `SET DEFAULT` / `COMMENT ON`），
 *   而不是 MySQL 那种「重写整列定义」的 MODIFY；
 * - 自增由 serial / identity 承担，既有列无法就地转换。
 */

import {
  diffPrimaryKey,
  diffProperties,
  diffTableColumns,
  normalizeTypeText,
  propertyChangeValue,
  summarizeColumnsDiff,
  validateColumnDefinitions,
  validateObjectName,
} from '../core/objectEditor';
import { defaultSignature } from '../core/columnSpecs';
import { pgQualified, quotePgIdent, quotePgString } from '../core/sqlText';
import {
  DatabaseChangeRequest,
  DatabaseError,
  DatabaseProperties,
  ObjectChangePlan,
  TableChangeRequest,
  TableColumnDefinition,
  TableStructure,
} from '../core/types';

/** 列类型候选：界面用 datalist 提示，不限制自由填写（PG 还有大量扩展类型）。 */
export const PG_COLUMN_TYPES = [
  'smallint',
  'integer',
  'bigint',
  'serial',
  'bigserial',
  'numeric(10,2)',
  'real',
  'double precision',
  'boolean',
  'text',
  'varchar(255)',
  'char(1)',
  'date',
  'time',
  'timestamp',
  'timestamptz',
  'interval',
  'uuid',
  'json',
  'jsonb',
  'bytea',
  'inet',
];

/**
 * 类型别名归一。
 *
 * `format_type` 返回全称（`character varying(255)`），用户在界面上多半填 `varchar(255)`；
 * 不做这层映射，「根本没改类型」的列每次都会被判定成有变化，白生成一条 ALTER。
 */
const PG_TYPE_ALIASES: Record<string, string> = {
  'character varying': 'varchar',
  character: 'char',
  'timestamp without time zone': 'timestamp',
  'timestamp with time zone': 'timestamptz',
  'time without time zone': 'time',
  'time with time zone': 'timetz',
  int: 'integer',
  int4: 'integer',
  int8: 'bigint',
  int2: 'smallint',
  bool: 'boolean',
  float8: 'double precision',
  float4: 'real',
  decimal: 'numeric',
};

export interface PgPlanContext {
  /** 取主键约束名，用于 `DROP CONSTRAINT`。 */
  primaryKeyConstraint(schema: string, table: string): Promise<string | undefined>;
}

/** 生成表结构变更计划。 */
export async function buildPgTablePlan(
  current: TableStructure,
  request: TableChangeRequest,
  context: PgPlanContext,
): Promise<ObjectChangePlan> {
  const schema = current.target.schema ?? 'public';
  const table = current.target.table;
  const qualified = pgQualified(schema, table);
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

  const diff = diffTableColumns(current.columns, desired, samePgColumn, false);
  const pk = diffPrimaryKey(current.columns, desired);
  if (diff.orderChanged) {
    warnings.push('PostgreSQL 的列顺序由物理位置决定，无法调整；本次改动的顺序已被忽略。');
  }

  // 主键先删后建：删掉主键列时 PG 会连带丢掉主键约束，之后再 DROP CONSTRAINT 必然报「约束不存在」
  if (pk.changed && current.columns.some((column) => column.isPrimaryKey)) {
    const constraint = await context.primaryKeyConstraint(schema, table);
    statements.push(
      constraint
        ? `ALTER TABLE ${qualified} DROP CONSTRAINT ${quotePgIdent(constraint)};`
        : `ALTER TABLE ${qualified} DROP CONSTRAINT IF EXISTS ${quotePgIdent(`${table}_pkey`)};`,
    );
    changes.push('删除主键');
  }

  for (const step of diff.steps) {
    const column = step.column;
    const name = quotePgIdent(column.name.trim());
    if (!step.origin) {
      statements.push(`ALTER TABLE ${qualified} ADD COLUMN ${renderPgColumn(column)};`);
      const comment = (column.comment ?? '').trim();
      if (comment) {
        statements.push(commentOnColumn(qualified, column.name, comment));
      }
      // 表里已有数据时，新增 NOT NULL 且无默认值的列会被服务端直接拒绝；
      // 与其让用户读到一句 23502，不如在预览阶段就说清楚
      if (!column.nullable && !String(column.defaultValue ?? '').trim()) {
        warnings.push(
          `新增列 ${column.name} 是 NOT NULL 且没有默认值：表里已有数据时 PostgreSQL 会拒绝这条语句，` +
            '请给它一个默认值，或允许为空。',
        );
      }
      continue;
    }

    const origin = step.origin;
    if (step.renamed) {
      statements.push(`ALTER TABLE ${qualified} RENAME COLUMN ${quotePgIdent(origin.name)} TO ${name};`);
    }
    if (normalizePgType(origin.dataType) !== normalizePgType(column.dataType)) {
      // 显式 USING：PG 只在存在隐式转换时才允许直接改类型，补上它覆盖面大得多
      const type = column.dataType.trim();
      statements.push(`ALTER TABLE ${qualified} ALTER COLUMN ${name} TYPE ${type} USING ${name}::${type};`);
    }
    if (!!origin.nullable !== !!column.nullable) {
      statements.push(`ALTER TABLE ${qualified} ALTER COLUMN ${name} ${column.nullable ? 'DROP' : 'SET'} NOT NULL;`);
    }
    if (defaultSignature(origin) !== defaultSignature(column)) {
      const text = pgDefaultText(column);
      statements.push(
        text
          ? `ALTER TABLE ${qualified} ALTER COLUMN ${name} SET DEFAULT ${text};`
          : `ALTER TABLE ${qualified} ALTER COLUMN ${name} DROP DEFAULT;`,
      );
    }
    if ((origin.comment ?? '').trim() !== (column.comment ?? '').trim()) {
      statements.push(commentOnColumn(qualified, column.name, (column.comment ?? '').trim()));
    }
    if (!!origin.autoIncrement !== !!column.autoIncrement) {
      warnings.push(
        `列 ${column.name} 的自增开关已忽略：PostgreSQL 不能把既有列就地改成自增，` +
          '需要新建序列并 SET DEFAULT，或重建该列。',
      );
    }
  }

  for (const column of diff.dropped) {
    statements.push(`ALTER TABLE ${qualified} DROP COLUMN ${quotePgIdent(column.name)};`);
  }

  if (pk.changed && pk.target.length) {
    statements.push(`ALTER TABLE ${qualified} ADD PRIMARY KEY (${pk.target.map(quotePgIdent).join(', ')});`);
    changes.push(`主键：${pk.target.join(', ')}`);
  }

  for (const change of propertyChanges) {
    if (change.key === 'name') {
      continue;
    }
    if (change.key === 'owner') {
      statements.push(`ALTER TABLE ${qualified} OWNER TO ${quotePgIdent(change.to)};`);
    } else if (change.key === 'comment') {
      statements.push(
        change.to
          ? `COMMENT ON TABLE ${qualified} IS ${quotePgString(change.to)};`
          : `COMMENT ON TABLE ${qualified} IS NULL;`,
      );
    } else {
      warnings.push(`未识别的表属性，已跳过：${change.label}`);
      continue;
    }
    changes.push(`${change.label}：${change.from || '(空)'} → ${change.to || '(空)'}`);
  }

  // 改名放最后：前面所有语句都按旧表名寻址
  if (rename && rename !== table) {
    statements.push(`ALTER TABLE ${qualified} RENAME TO ${quotePgIdent(rename)};`);
    changes.push(`重命名表：${table} → ${rename}`);
  }

  changes.unshift(...summarizeColumnsDiff(diff));
  if (diff.dropped.length) {
    // 列出列名：应用前那一秒，用户要能一眼看见到底哪几列的数据要没了
    warnings.push(
      `将删除 ${diff.dropped.length} 个列（${diff.dropped.map((column) => column.name).join('、')}）：` +
        '列上的数据会一起丢弃，且无法找回。',
    );
  }

  return { statements, changes, warnings: warnings.length ? warnings : undefined };
}

/** 生成 schema / 数据库属性变更计划。 */
export function buildPgDatabasePlan(
  current: DatabaseProperties,
  request: DatabaseChangeRequest,
): ObjectChangePlan {
  const isSchema = request.target.kind === 'schema';
  const objectSql = isSchema
    ? `SCHEMA ${quotePgIdent(request.target.name)}`
    : `DATABASE ${quotePgIdent(request.target.name)}`;
  const statements: string[] = [];
  const changes: string[] = [];
  const warnings: string[] = [];

  const propertyChanges = diffProperties(current.properties, request.properties ?? {});
  const rename = propertyChangeValue(propertyChanges, 'name');
  if (rename && rename !== request.target.name) {
    const problem = validateObjectName(rename, isSchema ? 'Schema 名' : '数据库名');
    if (problem) {
      throw new DatabaseError(problem, 'EINVALID_NAME');
    }
  }

  for (const change of propertyChanges) {
    if (change.key === 'name') {
      continue;
    }
    if (change.key === 'owner') {
      statements.push(`ALTER ${objectSql} OWNER TO ${quotePgIdent(change.to)};`);
    } else if (change.key === 'comment') {
      statements.push(`COMMENT ON ${objectSql} IS ${change.to ? quotePgString(change.to) : 'NULL'};`);
    } else {
      warnings.push(`未识别的属性，已跳过：${change.label}`);
      continue;
    }
    changes.push(`${change.label}：${change.from || '(空)'} → ${change.to || '(空)'}`);
  }

  // 改名放最后：前面的语句都按旧名寻址
  if (rename && rename !== request.target.name) {
    statements.push(`ALTER ${objectSql} RENAME TO ${quotePgIdent(rename)};`);
    changes.push(`重命名：${request.target.name} → ${rename}`);
  }

  return { statements, changes, warnings: warnings.length ? warnings : undefined };
}

/** 新列的完整定义；PG 的位置由追加决定，没有 AFTER 语义。 */
export function renderPgColumn(column: TableColumnDefinition): string {
  const parts = [quotePgIdent(column.name.trim()), column.dataType.trim()];
  const defaultValue = pgDefaultText(column);
  if (defaultValue) {
    parts.push(`DEFAULT ${defaultValue}`);
  }
  if (!column.nullable) {
    parts.push('NOT NULL');
  }
  return parts.join(' ');
}

/**
 * 默认值文本。
 *
 * `pg_get_expr` 读回来的是完整表达式（`'abc'::character varying` / `nextval(…)`），
 * 原样写回最稳；界面声明为「常量」时才走字符串字面量 —— PG 会把未定型字面量按列类型
 * 隐式转换，因此 `''` 与「没有默认值」也能区分开（这正是裸文本做不到的）。
 */
function pgDefaultText(column: TableColumnDefinition): string {
  const raw = column.defaultValue === null || column.defaultValue === undefined ? '' : String(column.defaultValue);
  if (column.defaultKind === 'constant') {
    return quotePgString(raw);
  }
  return raw.trim();
}

/** 列注释：PG 的注释是独立对象，清空要写 IS NULL，写 IS '' 会留下一个空注释。 */
function commentOnColumn(qualified: string, column: string, comment: string): string {
  return comment
    ? `COMMENT ON COLUMN ${qualified}.${quotePgIdent(column)} IS ${quotePgString(comment)};`
    : `COMMENT ON COLUMN ${qualified}.${quotePgIdent(column)} IS NULL;`;
}

/** 类型别名归一，见 `PG_TYPE_ALIASES`。 */
export function normalizePgType(type: string): string {
  let text = normalizeTypeText(type);
  // 多词别名先替换：`character varying` 必须在 `character` 之前处理
  for (const [alias, canonical] of Object.entries(PG_TYPE_ALIASES)) {
    if (alias.includes(' ')) {
      text = text.split(alias).join(canonical);
    }
  }
  for (const [alias, canonical] of Object.entries(PG_TYPE_ALIASES)) {
    if (!alias.includes(' ')) {
      text = text.replace(new RegExp(`\\b${alias}\\b`, 'g'), canonical);
    }
  }
  return text;
}

/** 除列名与主键外是否等价（这两项各自有专门的差异判定）。 */
export function samePgColumn(a: TableColumnDefinition, b: TableColumnDefinition): boolean {
  return (
    normalizePgType(a.dataType) === normalizePgType(b.dataType) &&
    !!a.nullable === !!b.nullable &&
    // 默认值连语义一起比：常量与表达式即使文本相同，渲染出来的语句也不同
    defaultSignature(a) === defaultSignature(b) &&
    (a.comment ?? '').trim() === (b.comment ?? '').trim()
  );
}
