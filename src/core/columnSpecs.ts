/**
 * 列定义的「结构化表达」：数据类型、默认值语义、`ON UPDATE` 子句。
 *
 * 放在 core 层的原因与 `objectEditor.ts` 相同：不认识 vscode、不认识驱动，
 * 只做纯数据变换，冒烟测试可以直接 require。
 *
 * 三条不变式（改这里的代码就是在动它们）：
 * 1. **未触碰即原样回传**：面板只在控件被改过时才回传 `typeSpec` / `defaultSpec`，
 *    否则一律沿用读回来的原文。`int(10) unsigned zerofill`、`timestamp(3) with time zone`
 *    这类界面没有暴露的写法因此逐字节往返，不可能被静默改写。
 * 2. **解析不确信就退回原始文本**：只有「解析 → 合成」能回到同一类型文本时才给出结构化结果，
 *    否则返回 `undefined`，界面渲染成文本输入框。绝不猜着改。
 * 3. **SQL 文本只在扩展侧合成**：面板回传结构化目标，`varchar(255)` / `DEFAULT …` /
 *    `ON UPDATE …` 一律由这里拼装，避免同一份规则在 Webview 的 JS 里再写一遍。
 */

import { normalizeDefaultText, normalizeTypeText } from './objectEditor';
import { DefaultKind, TableColumnDefinition } from './types';

/** 类型参数在界面上的输入形态。 */
export type TypeArgsKind = 'none' | 'length' | 'precision' | 'seconds' | 'values';

/** 类型下拉的一项；`dataTypes` 是「带参数的候选」，这里归纳成「基础类型 + 参数形态」。 */
export interface TypeOption {
  base: string;
  argsKind: TypeArgsKind;
  /** 该基础类型是否支持 `unsigned` 修饰。 */
  unsigned: boolean;
}

/** 发给界面的类型编辑描述。 */
export interface ColumnTypeEditor {
  mode: 'structured' | 'raw';
  /** 读回来的类型原文，raw 模式下直接展示。 */
  raw: string;
  base?: string;
  args?: string;
  unsigned?: boolean;
  enumValues?: string[];
  /** 未暴露成控件的尾部修饰（`zerofill` / `with time zone`），原样带回。 */
  suffix?: string;
  argsKind?: TypeArgsKind;
  /** raw 模式的原因，界面直接展示。 */
  note?: string;
}

/** 发给界面的默认值编辑描述。 */
export interface ColumnDefaultEditor {
  kind: DefaultKind;
  value: string;
}

/** 发给界面的 `ON UPDATE` 开关描述。 */
export interface ColumnOnUpdateEditor {
  /** false 表示这条额外子句无法用开关表达 —— 界面必须原样透传，不得丢弃。 */
  supported: boolean;
  enabled: boolean;
  precision?: number;
}

/** 面板回传的类型目标；`mode: 'structured'` 时才算「被改过」。 */
export type ColumnTypeSpec =
  | {
      mode: 'structured';
      base: string;
      args?: string;
      unsigned?: boolean;
      enumValues?: string[];
      suffix?: string;
    }
  | { mode: 'raw'; text: string };

/** 面板回传的默认值目标。 */
export interface ColumnDefaultSpec {
  kind: DefaultKind;
  value?: string;
}

/** 面板回传的列定义：在列定义之上挂「结构化的目标状态」。 */
export interface EditorColumnTarget extends TableColumnDefinition {
  typeSpec?: ColumnTypeSpec;
  defaultSpec?: ColumnDefaultSpec;
  /** 仅在用户**翻转**开关时出现；缺省表示原样保留 `extraClauses`。 */
  onUpdateTimestamp?: boolean;
}

/** 解析结果。 */
interface ColumnTypeParts {
  base: string;
  args: string[];
  modifiers: string[];
  suffix?: string;
  enumValues?: string[];
  argsKind: TypeArgsKind;
}

/** 参数是长度（单个整数）的类型。 */
const LENGTH_TYPES = new Set([
  'bit',
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'integer',
  'bigint',
  'char',
  'varchar',
  'binary',
  'varbinary',
]);

/** 参数是「精度[, 小数位]」的类型。 */
const PRECISION_TYPES = new Set(['decimal', 'numeric', 'dec', 'fixed', 'float', 'double', 'real']);

/** 参数是「秒精度」的时间类型。 */
const SECONDS_TYPES = new Set(['time', 'datetime', 'timestamp']);

/**
 * 长度**必填**的类型。
 *
 * 只有这几个：`varchar` / `char` / `binary` / `varbinary` 少了长度在 MySQL 直接是语法错误；
 * 整数类型与 `bit` 的裸形态是合法的（`int` / `bit`），`decimal` 裸写也有默认精度，
 * 都不该拦着用户 —— 拦错了比放过更难用（PG 的无长度 varchar 还能走「原始文本」）。
 */
const LENGTH_REQUIRED_TYPES = new Set(['char', 'varchar', 'binary', 'varbinary']);

/** 支持 `unsigned` 修饰的类型。 */
const UNSIGNED_TYPES = new Set([...LENGTH_TYPES, ...PRECISION_TYPES]);

/** 类型名允许的形态：一到多个字母数字下划线单词。 */
const TYPE_NAME_RE = /^[a-z][a-z0-9_]*(?:\s+[a-z][a-z0-9_]*)*$/;

/**
 * 可以从末尾剥掉的修饰与后缀，长的在前（`unsigned zerofill` 要先于 `unsigned` 匹配）。
 *
 * `zerofill` 必须记成 suffix 而不是「剥掉就完」：它不在任何控件里，靠 suffix 原样带回。
 * 只剥不带回来的话，自检的「解析 → 合成」对不上，`int(10) unsigned zerofill` 会整条退回
 * 原始文本框 —— 保真没丢，但白扔了能结构化的形态。
 */
const TRAILING_TOKENS: Array<{ text: string; modifier?: string; suffix?: string }> = [
  { text: 'unsigned zerofill', modifier: 'unsigned', suffix: 'zerofill' },
  { text: 'zerofill', suffix: 'zerofill' },
  { text: 'unsigned', modifier: 'unsigned' },
  { text: 'with local time zone', suffix: 'with local time zone' },
  { text: 'without time zone', suffix: 'without time zone' },
  { text: 'with time zone', suffix: 'with time zone' },
];

/**
 * 简单常量（不是表达式）的形态：不含引号 / 百分号 / 括号 / 反斜杠。
 *
 * 这条判定只用于决定界面**初次**选中哪个语义，真正的渲染仍由驱动按语义走，
 * 因此宁可把可疑的形态都归到「表达式」——表达式是原样下发，不会擅自加引号。
 */
const SIMPLE_CONSTANT_RE = /^[^'"()`\\]*$/;

/** MySQL 里可以裸写的默认值关键字（`DEFAULT NULL` / `DEFAULT CURRENT_TIMESTAMP`）。 */
const BARE_DEFAULT_KEYWORD_RE =
  /^(current_timestamp|current_date|current_time|localtimestamp|localtime|null|true|false)(\(\d*\))?$/i;

/** 把候选类型归纳成下拉选项：去参数、去重，同名以「带 unsigned 的那个」为准。 */
export function baseTypeOptions(dataTypes: string[]): TypeOption[] {
  const byBase = new Map<string, TypeOption>();
  for (const candidate of dataTypes ?? []) {
    const parts = parseColumnType(candidate);
    if (!parts) {
      continue;
    }
    const option: TypeOption = {
      base: parts.base,
      argsKind: parts.argsKind,
      unsigned: parts.modifiers.includes('unsigned'),
    };
    const existing = byBase.get(parts.base);
    if (!existing || (!existing.unsigned && option.unsigned)) {
      byBase.set(parts.base, option);
    }
  }
  return [...byBase.values()];
}

/**
 * 解析类型文本；**不确信就返回 undefined**（界面退回原始文本）。
 *
 * 最后那步「解析 → 合成 → 归一比较」是这里的关键：只有能完整还原的形态才允许结构化，
 * 于是 `geometry(POINT,4326)` 这类没见过的参数、`enum` 里服务端转义形态不认识的引号，
 * 都会自动落到原始文本模式，而不是被猜着重写成别的东西。
 */
export function parseColumnType(text: string): ColumnTypeParts | undefined {
  const raw = (text ?? '').trim();
  if (!raw) {
    return undefined;
  }

  const open = raw.indexOf('(');
  let head = raw;
  let argsText: string | undefined;
  let tail = '';
  if (open >= 0) {
    // 类型的参数里不会出现嵌套括号，取最后一个 `)` 即可（`enum('a(b)')` 也能对）
    const close = raw.lastIndexOf(')');
    if (close < open) {
      return undefined;
    }
    head = raw.slice(0, open).trim();
    argsText = raw.slice(open + 1, close).trim();
    tail = raw.slice(close + 1).trim();
  }

  const stripped = stripTrailingTokens(head, tail);
  if (!stripped) {
    return undefined;
  }
  const base = normalizeTypeText(stripped.head);
  if (!base || !TYPE_NAME_RE.test(base)) {
    return undefined;
  }

  const argsKind = argsKindOf(base);
  if (argsKind === 'none' && argsText !== undefined) {
    // 没见过的「带参数类型」：不猜它的参数含义
    return undefined;
  }

  const parts: ColumnTypeParts = {
    base,
    args: [],
    modifiers: stripped.modifiers,
    suffix: stripped.suffix,
    argsKind,
  };

  if (argsText !== undefined) {
    if (argsKind === 'values') {
      const values = parseSqlStringList(argsText);
      if (!values) {
        return undefined;
      }
      parts.enumValues = values;
    } else {
      const args = splitArgs(argsText);
      if (!args) {
        return undefined;
      }
      parts.args = args;
    }
  }

  if (!isValidArgs(parts)) {
    return undefined;
  }

  // 自检：合成结果必须与原文等价，否则这个形态只能当文本处理
  const rebuilt = normalizeTypeText(formatParts(parts));
  if (rebuilt !== normalizeTypeText(raw)) {
    return undefined;
  }
  return parts;
}

/**
 * 合成类型文本。
 *
 * 这里**不做校验也不报错**（缺参数就只输出基础类型）：解析的自检要调用它，
 * 报错得由 `validateTypeSpec()` 单独负责，否则 `int unsigned` 这种合法形态会在自检里炸掉。
 */
export function formatColumnType(spec: ColumnTypeSpec): string {
  if (spec.mode === 'raw') {
    return (spec.text ?? '').trim();
  }
  const base = normalizeTypeText(spec.base ?? '');
  if (!base) {
    return '';
  }
  const argsKind = argsKindOf(base);
  const pieces: string[] = [];
  if (argsKind === 'values') {
    const values = spec.enumValues ?? [];
    if (values.length) {
      pieces.push(`${base}(${values.map(quoteSqlString).join(',')})`);
    } else {
      pieces.push(base);
    }
  } else {
    const args = normalizeArgs(spec.args, argsKind);
    pieces.push(args ? `${base}(${args})` : base);
  }
  if (spec.unsigned && UNSIGNED_TYPES.has(base)) {
    pieces.push('unsigned');
  }
  const suffix = (spec.suffix ?? '').trim();
  if (suffix) {
    pieces.push(suffix);
  }
  return pieces.join(' ');
}

/** 提交前的类型校验；返回中文问题描述，`undefined` 表示没问题。 */
export function validateTypeSpec(spec: ColumnTypeSpec): string | undefined {
  if (spec.mode === 'raw') {
    return undefined;
  }
  const base = normalizeTypeText(spec.base ?? '');
  if (!base) {
    return '数据类型不能为空';
  }
  const argsKind = argsKindOf(base);
  if (argsKind === 'values') {
    return (spec.enumValues ?? []).length ? undefined : `${base} 至少需要一个取值`;
  }
  const args = normalizeArgs(spec.args, argsKind);
  if (argsKind === 'length' && !args && LENGTH_REQUIRED_TYPES.has(base)) {
    return `${base} 需要填写长度`;
  }
  if (argsKind === 'seconds' && spec.args !== undefined && spec.args !== '' && !args) {
    return `${base} 的秒精度需要是 0–6 的整数`;
  }
  return undefined;
}

/** 生成界面的类型描述。 */
export function describeColumnTypeEditor(dataType: string): ColumnTypeEditor {
  const raw = (dataType ?? '').trim();
  const parts = parseColumnType(raw);
  if (!parts) {
    return {
      mode: 'raw',
      raw,
      note: '这个类型无法用控件表达，已退回文本填写。',
    };
  }
  return {
    mode: 'structured',
    raw,
    base: parts.base,
    args: parts.args.join(','),
    unsigned: parts.modifiers.includes('unsigned'),
    enumValues: parts.enumValues,
    suffix: parts.suffix,
    argsKind: parts.argsKind,
  };
}

/**
 * 默认值的语义。
 *
 * `null` / 缺省是「没有默认值」，空串是「默认值为空串」，两者不可混淆
 * （与 `objectEditor.normalizeDefaultText` 的约定一致）。
 */
export function classifyDefaultKind(column: TableColumnDefinition): DefaultKind {
  const value = column.defaultValue;
  if (value === null || value === undefined) {
    return 'none';
  }
  const text = String(value).trim();
  if (text === '') {
    return 'constant';
  }
  if (BARE_DEFAULT_KEYWORD_RE.test(text) || !SIMPLE_CONSTANT_RE.test(text)) {
    return 'expression';
  }
  return 'constant';
}

/** 生成界面的默认值描述。 */
export function describeColumnDefaultEditor(column: TableColumnDefinition): ColumnDefaultEditor {
  const kind = column.defaultKind ?? classifyDefaultKind(column);
  if (kind === 'none') {
    return { kind: 'none', value: '' };
  }
  return { kind, value: column.defaultValue === null || column.defaultValue === undefined ? '' : String(column.defaultValue) };
}

/**
 * 默认值的比较签名：文本 + 语义。
 *
 * 语义必须参与比较，否则「把常量改成表达式」这种值没变、渲染结果不同的改动会被判定成
 * 「没改」而静默丢掉。两侧都走同一个兜底（缺省时按文本形态归类），所以**完全没动过**的列
 * 仍然判等 —— 读回来的列没有 `defaultKind`，界面未触碰时也不会带上它。
 */
export function defaultSignature(column: TableColumnDefinition): string {
  const kind = column.defaultKind ?? classifyDefaultKind(column);
  return `${normalizeDefaultText(column.defaultValue)}\u0000${kind}`;
}

/**
 * 生成 `ON UPDATE` 开关描述。
 *
 * 只有整条子句就是 `ON UPDATE CURRENT_TIMESTAMP[(n)]` 时才给出开关；
 * 其余形态（第三方驱动的额外子句、`ON UPDATE` 的罕见写法）一律 `supported: false`，
 * 界面照旧原样透传，绝不因为「看不懂」而丢掉它。
 */
export function describeOnUpdate(
  extraClauses: string | undefined,
  allow: boolean,
  _dataType: string,
): ColumnOnUpdateEditor {
  if (!allow) {
    return { supported: false, enabled: false };
  }
  const text = (extraClauses ?? '').trim();
  if (!text) {
    return { supported: true, enabled: false };
  }
  const match = /^on update\s+current_timestamp(?:\((\d+)\))?$/i.exec(text);
  if (!match) {
    return { supported: false, enabled: false };
  }
  return { supported: true, enabled: true, precision: match[1] ? Number(match[1]) : undefined };
}

/** 合成 `ON UPDATE` 子句；开关关掉即整段移除。 */
export function composeOnUpdateClause(
  original: string | undefined,
  enabled: boolean,
  dataType: string,
): string {
  const text = (original ?? '').trim();
  if (!enabled) {
    return '';
  }
  const info = describeOnUpdate(text, true, dataType);
  if (text && !info.supported) {
    // 看不懂的子句原样保留，不能因为用户动了开关就把它抹掉
    return text;
  }
  // 精度优先沿用原子句：不这样，`timestamp(3)` 上的 ON UPDATE 会在界面没动时掉到秒精度
  const precision = info.precision ?? fractionalSeconds(dataType);
  return precision === undefined ? 'ON UPDATE CURRENT_TIMESTAMP' : `ON UPDATE CURRENT_TIMESTAMP(${precision})`;
}

/** 把面板回传的结构化目标还原成列定义（交给驱动的唯一形态）。 */
export function resolveEditorColumns(columns: EditorColumnTarget[]): TableColumnDefinition[] {
  const resolved: TableColumnDefinition[] = [];
  for (const column of columns ?? []) {
    const name = (column.name ?? '').trim();
    let dataType = (column.dataType ?? '').trim();
    if (column.typeSpec) {
      if (column.typeSpec.mode === 'raw') {
        dataType = (column.typeSpec.text ?? '').trim();
      } else {
        const problem = validateTypeSpec(column.typeSpec);
        if (problem) {
          throw new Error(`${name || '新列'}：${problem}`);
        }
        dataType = formatColumnType(column.typeSpec).trim();
      }
    }

    let defaultValue = column.defaultValue ?? null;
    let defaultKind = column.defaultKind;
    if (column.defaultSpec) {
      defaultKind = column.defaultSpec.kind;
      defaultValue = column.defaultSpec.kind === 'none' ? null : (column.defaultSpec.value ?? '');
    }

    let extraClauses = column.extraClauses;
    if (typeof column.onUpdateTimestamp === 'boolean') {
      extraClauses = composeOnUpdateClause(column.extraClauses, column.onUpdateTimestamp, dataType) || undefined;
    }

    resolved.push({
      ...stripEditorKeys(column),
      name,
      dataType,
      defaultValue,
      defaultKind,
      extraClauses,
    });
  }
  return resolved;
}

// ---------------------------------------------------------------- 内部实现

/** 去掉只有界面认识的字段，避免它们混进发给驱动的请求。 */
function stripEditorKeys(column: EditorColumnTarget): TableColumnDefinition {
  const copy: Record<string, unknown> = { ...column };
  for (const key of ['typeSpec', 'defaultSpec', 'onUpdateTimestamp']) {
    delete copy[key];
  }
  return copy as unknown as TableColumnDefinition;
}

/** 基础类型名 → 参数形态。 */
function argsKindOf(base: string): TypeArgsKind {
  if (base === 'enum' || base === 'set') {
    return 'values';
  }
  if (LENGTH_TYPES.has(base)) {
    return 'length';
  }
  if (PRECISION_TYPES.has(base)) {
    return 'precision';
  }
  if (SECONDS_TYPES.has(base)) {
    return 'seconds';
  }
  return 'none';
}

/**
 * 从类型名的末尾（无参数时）或参数之后（有参数时）剥掉修饰与后缀。
 *
 * 有参数时后缀必须**全部**识别：`int(10) 某个没见过的词` 只能当文本处理，
 * 猜着丢掉一段是静默改表行为。
 */
function stripTrailingTokens(
  head: string,
  tail: string,
): { head: string; modifiers: string[]; suffix?: string } | undefined {
  const modifiers: string[] = [];
  let suffix: string | undefined;

  if (tail) {
    let rest = tail;
    let matched = true;
    while (matched && rest) {
      matched = false;
      for (const token of TRAILING_TOKENS) {
        if (rest.toLowerCase() === token.text) {
          if (token.modifier) {
            modifiers.push(token.modifier);
          }
          if (token.suffix) {
            suffix = token.suffix;
          }
          rest = '';
          matched = true;
          break;
        }
      }
    }
    if (rest) {
      return undefined;
    }
  }

  let rest = head.trim();
  let matched = true;
  while (matched) {
    matched = false;
    const lower = rest.toLowerCase();
    for (const token of TRAILING_TOKENS) {
      if (lower.endsWith(` ${token.text}`)) {
        if (token.modifier) {
          modifiers.push(token.modifier);
        }
        if (token.suffix) {
          suffix = token.suffix;
        }
        rest = rest.slice(0, rest.length - token.text.length - 1).trim();
        matched = true;
        break;
      }
    }
  }

  return { head: rest, modifiers, suffix };
}

/** 参数文本 → 数组；出现空段或非法字符就放弃（返回 undefined）。 */
function splitArgs(text: string): string[] | undefined {
  const args = text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (!args.length) {
    return undefined;
  }
  return args.every((item) => /^\d+$/.test(item)) ? args : undefined;
}

/** 参数个数与取值范围检查；不通过就当文本处理。 */
function isValidArgs(parts: ColumnTypeParts): boolean {
  switch (parts.argsKind) {
    case 'length':
      return parts.args.length <= 1;
    case 'precision':
      return parts.args.length >= 1 && parts.args.length <= 2;
    case 'seconds':
      return parts.args.length <= 1 && (parts.args.length === 0 || Number(parts.args[0]) <= 6);
    default:
      return parts.args.length === 0;
  }
}

/** 界面回传的参数文本 → 规范化后的参数；不合法返回 undefined。 */
function normalizeArgs(args: string | undefined, kind: TypeArgsKind): string | undefined {
  const items = (args ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (!items.length) {
    return undefined;
  }
  if (kind === 'length') {
    return items.length === 1 && /^\d+$/.test(items[0]) ? items[0] : undefined;
  }
  if (kind === 'precision') {
    if (items.length > 2 || !items.every((item) => /^\d+$/.test(item))) {
      return undefined;
    }
    return items.join(',');
  }
  if (kind === 'seconds') {
    if (items.length !== 1 || !/^\d+$/.test(items[0]) || Number(items[0]) > 6) {
      return undefined;
    }
    return items[0];
  }
  return undefined;
}

/** 合成时用的类型文本（自检路径），与 formatColumnType 共用同一份参数处理。 */
function formatParts(parts: ColumnTypeParts): string {
  return formatColumnType({
    mode: 'structured',
    base: parts.base,
    args: parts.args.join(','),
    unsigned: parts.modifiers.includes('unsigned'),
    enumValues: parts.enumValues,
    suffix: parts.suffix,
  });
}

/** 取时间类型的秒精度（`timestamp(3)` → 3）。 */
function fractionalSeconds(dataType: string): number | undefined {
  const parts = parseColumnType(dataType);
  if (!parts || parts.argsKind !== 'seconds' || !parts.args.length) {
    return undefined;
  }
  return Number(parts.args[0]);
}

/**
 * 解析 SQL 字符串列表（`enum` / `set` 的取值）。
 *
 * 同时认 `''` 与 `\'` 两种转义：认不出来就返回 undefined，让整列退回原始文本 ——
 * 服务端的转义形态各版本并不一致，猜错一次就是一条写坏的 DDL。
 */
function parseSqlStringList(text: string): string[] | undefined {
  const values: string[] = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) {
      index += 1;
    }
    if (text[index] !== "'") {
      return undefined;
    }
    index += 1;
    let value = '';
    let closed = false;
    while (index < text.length) {
      const char = text[index];
      if (char === '\\' && index + 1 < text.length) {
        value += text[index + 1];
        index += 2;
        continue;
      }
      if (char === "'") {
        if (text[index + 1] === "'") {
          value += "'";
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      value += char;
      index += 1;
    }
    if (!closed) {
      return undefined;
    }
    values.push(value);
    while (index < text.length && /\s/.test(text[index])) {
      index += 1;
    }
    if (index >= text.length) {
      break;
    }
    if (text[index] !== ',') {
      return undefined;
    }
    index += 1;
  }
  return values.length ? values : undefined;
}

/**
 * SQL 字符串字面量。
 *
 * 反斜杠与单引号都按 MySQL / PostgreSQL 都接受的写法转义（`\\` 与 `''`）；
 * 若服务端给出的形态与此不一致，解析阶段的自检会把整列挡回原始文本。
 */
function quoteSqlString(value: string): string {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}
