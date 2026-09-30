/**
 * 表结构与对象属性的「差异计算 + 输入校验」。
 *
 * 放在 core 层的原因与 `editTarget.ts` / `tableTargets.ts` 相同：既不认识 vscode，
 * 也不认识任何数据库驱动，只做纯数据变换，冒烟测试可以直接 require。
 *
 * 边界：这里只回答「改了什么」，具体语句长什么样由驱动决定 —— 列定义怎么拼、
 * 位置子句怎么写、主键是 `DROP PRIMARY KEY` 还是 `DROP CONSTRAINT`，全是方言知识，
 * 放进通用层必然产出跨方言错误的 SQL。
 */

import { EditableProperty, TableColumnDefinition } from './types';

/** 类型文本归一化：忽略大小写与空白差异（`INT ( 11 )` 与 `int(11)` 视为同一类型）。 */
export function normalizeTypeText(type: string): string {
  return (type ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)/g, ')')
    .replace(/\s*,\s*/g, ',');
}

/**
 * 默认值文本归一化。
 *
 * 各家驱动对字符串默认值的呈现并不一致（MySQL 8 给 `abc`、MariaDB 给 `'abc'`），
 * 比较时必须剥掉外层引号，否则「根本没动过」的列会被判成有变化，白白生成一条 ALTER。
 * 注意 `null`（没有默认值）与 `''`（默认值为空串）是两回事，前者归一化成空标记，
 * 后者保留引号形态以免在重写列定义时把空串默认值弄丢。
 */
export function normalizeDefaultText(value?: string | null): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = String(value).trim();
  if (text.length >= 2 && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"')))) {
    const inner = text.slice(1, -1);
    // 空串默认值保留成 `''`，与「无默认值」区分开
    return inner === '' ? "''" : inner;
  }
  return text;
}

/** 单个目标列的变更判定。 */
export interface ColumnChange {
  /** 目标列定义。 */
  column: TableColumnDefinition;
  /** 对应的原列；新增列为空。 */
  origin?: TableColumnDefinition;
  renamed: boolean;
  /** 除列名以外的定义有变化（类型 / 可空 / 默认值 / 注释 / 自增）。 */
  modified: boolean;
  /** 需要（重新）指定位置：新增列恒为真，既有列仅在列序变化时为真。 */
  reposition: boolean;
  /** 目标位置的前一列（按目标顺序），最前为 `undefined`。 */
  after?: string;
}

export interface ColumnsDiff {
  /** 按目标顺序排列的列变更步骤。 */
  steps: ColumnChange[];
  /** 待删除的原列（按原顺序）。 */
  dropped: TableColumnDefinition[];
  /** 列序是否发生变化（驱动不支持调序时可以据此给出提示）。 */
  orderChanged: boolean;
}

/**
 * 比较原列与目标列。
 *
 * 认列靠 `originalName`（驱动读回来的原始列名）而不是下标或名字相似度：
 * 下标会因增删而整体漂移，相似度匹配则会在「删 a、加 a2」这类操作上做出危险猜测。
 *
 * @param sameDefinition 除列名外是否等价；类型与默认值的比较规则因方言而异，由驱动提供。
 */
export function diffTableColumns(
  original: TableColumnDefinition[],
  desired: TableColumnDefinition[],
  sameDefinition: (a: TableColumnDefinition, b: TableColumnDefinition) => boolean,
  allowReorder = true,
): ColumnsDiff {
  const originalByName = new Map((original ?? []).map((column) => [column.name, column]));
  const matched = new Set<string>();
  const survivors: string[] = [];

  const steps: ColumnChange[] = (desired ?? []).map((column) => {
    const origin = column.originalName ? originalByName.get(column.originalName) : undefined;
    if (origin) {
      matched.add(origin.name);
      survivors.push(origin.name);
    }
    return {
      column,
      origin,
      renamed: !!origin && origin.name !== column.name,
      modified: !!origin && !sameDefinition(origin, column),
      reposition: false,
    };
  });

  // 「列序有没有变」只在**本来就存在**的列之间比较：新增列插在哪里由驱动按目标顺序摆放，
  // 不该让一次纯新增被判定成「整表重排」而多生成一堆 MODIFY
  const survivingOriginal = (original ?? []).filter((column) => matched.has(column.name)).map((column) => column.name);
  const orderChanged = survivors.join('\u0000') !== survivingOriginal.join('\u0000');

  steps.forEach((step, index) => {
    step.after = index > 0 ? desired[index - 1].name : undefined;
    step.reposition = !step.origin || (allowReorder && orderChanged);
  });

  const dropped = (original ?? []).filter((column) => !matched.has(column.name));
  return { steps, dropped, orderChanged };
}

/** 变更摘要文案，供面板与状态栏展示。 */
export function summarizeColumnsDiff(
  diff: ColumnsDiff,
  formatColumn: (column: TableColumnDefinition) => string = (column) => column.name,
): string[] {
  const lines: string[] = [];
  for (const step of diff.steps) {
    if (!step.origin) {
      lines.push(`新增列 ${formatColumn(step.column)}`);
    } else if (step.renamed) {
      lines.push(`重命名列 ${step.origin.name} → ${formatColumn(step.column)}${step.modified ? '（并更新定义）' : ''}`);
    } else if (step.modified) {
      lines.push(`修改列 ${formatColumn(step.column)}`);
    }
  }
  for (const column of diff.dropped) {
    lines.push(`删除列 ${formatColumn(column)}`);
  }
  if (diff.orderChanged) {
    lines.push('调整列顺序');
  }
  return lines;
}

export interface PrimaryKeyDiff {
  /** 需要加入主键的列（已用目标列名）。 */
  added: string[];
  /** 需要从主键中移除的列（原列名）。 */
  removed: string[];
  /** 目标主键列（按目标顺序）。 */
  target: string[];
  changed: boolean;
}

/** 主键差异：主键在列定义之外，必须单独比较，否则重命名 / 换主键都会静默漏掉。 */
export function diffPrimaryKey(
  original: TableColumnDefinition[],
  desired: TableColumnDefinition[],
): PrimaryKeyDiff {
  const originalPk = (original ?? []).filter((column) => column.isPrimaryKey).map((column) => column.name);
  const target = (desired ?? []).filter((column) => column.isPrimaryKey).map((column) => column.name);
  const targetAsOriginal = (desired ?? [])
    .filter((column) => column.isPrimaryKey)
    .map((column) => column.originalName ?? column.name);

  const added = (desired ?? [])
    .filter((column) => column.isPrimaryKey && !(column.originalName && originalPk.includes(column.originalName)))
    .map((column) => column.name);
  const removed = (original ?? [])
    .filter((column) => column.isPrimaryKey && !targetAsOriginal.includes(column.name))
    .map((column) => column.name);

  return {
    added,
    removed,
    target,
    changed: originalPk.join('\u0000') !== targetAsOriginal.join('\u0000'),
  };
}

/** 单条属性的变更。 */
export interface PropertyChange {
  key: string;
  label: string;
  from: string;
  to: string;
}

/** 属性差异：只比较驱动声明为可编辑、且请求里给了新值的那些键。 */
export function diffProperties(current: EditableProperty[], desired: Record<string, string>): PropertyChange[] {
  const changes: PropertyChange[] = [];
  for (const property of current ?? []) {
    if (property.editable === false || !desired || !(property.key in desired)) {
      continue;
    }
    const before = String(property.value ?? '').trim();
    const next = String(desired[property.key] ?? '').trim();
    if (before !== next) {
      changes.push({ key: property.key, label: property.label, from: before, to: next });
    }
  }
  return changes;
}

/** 从属性变更里取某个键的目标值。 */
export function propertyChangeValue(changes: PropertyChange[], key: string): string | undefined {
  return changes.find((change) => change.key === key)?.to;
}

/**
 * 提交前的列定义校验。
 *
 * 全部在这里拦下：列名空、列名重复（大小写不敏感 —— MySQL 的列名本身不分大小写，
 * 放过去只会得到一句服务端报错）、类型为空。这些错误在界面上就阻断，
 * 比发一条注定失败的 DDL 更省事。
 */
export function validateColumnDefinitions(columns: TableColumnDefinition[]): string | undefined {
  if (!columns || columns.length === 0) {
    return '表至少要保留一列';
  }
  const seen = new Set<string>();
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const name = (column?.name ?? '').trim();
    if (!name) {
      return `第 ${index + 1} 行的列名不能为空`;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      return `列名重复：${name}`;
    }
    seen.add(key);
    if (!(column.dataType ?? '').trim()) {
      return `列 ${name} 的数据类型不能为空`;
    }
  }
  return undefined;
}

/** 对象名（表 / 库 / schema）校验；63 是 MySQL 与 PostgreSQL 里更严的那个上限。 */
export function validateObjectName(name: string, label: string): string | undefined {
  const text = (name ?? '').trim();
  if (!text) {
    return `${label}不能为空`;
  }
  if (text.length > 63) {
    return `${label}过长（上限 63 字符）`;
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    return `${label}不能包含控制字符`;
  }
  return undefined;
}

/** 变更计划是否为空（界面据此提示「没有检测到任何变更」）。 */
export function planIsEmpty(plan: { statements: string[] } | undefined): boolean {
  return !plan || plan.statements.length === 0;
}
