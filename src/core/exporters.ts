/**
 * 查询结果序列化：CSV / JSON / JSONL / XLSX。
 *
 * 本模块**不依赖 `vscode`**，也不依赖任何第三方库，因此可以被扩展宿主、
 * sidecar 子进程以及测试脚本共同引用。
 *
 * 关于 XLSX：没有引入 `xlsx`(SheetJS) 或 `exceljs`，原因有三：
 * 1. npm 上的 `xlsx` 已停止维护且带有已知原型污染漏洞（CVE-2023-30533），
 *    在企业环境里很可能被依赖扫描直接拦下；
 * 2. 我们只需要「写」这一件事，不需要解析，通用库的体积与风险都不划算；
 * 3. XLSX 本质是一个 ZIP 容器 + 若干 XML（见 ECMA-376），用 Node 内置的
 *    `zlib.deflateRaw` 手写一个最小生成器即可，代码量可控且行为完全可预期。
 *
 * 样式上刻意只做「阅读友好」这一档：冻结表头、自动筛选、斑马纹、细分割线、
 * 按内容（含 CJK 双宽）自适应列宽。不做字号/主题色等主观装饰——导出文件的
 * 第一诉求是别人能一眼看完，而不是好看。
 */

import * as zlib from 'zlib';

export type ExportFormat = 'csv' | 'json' | 'jsonl' | 'xlsx';

export interface ExportPayload {
  data: string | Buffer;
  extension: string;
  /** 写文件时用不到，但便于将来走剪贴板 / 远程通道时判断。 */
  mimeType: string;
  label: string;
}

export function serializeResult(
  format: ExportFormat,
  fields: string[],
  rows: Record<string, unknown>[],
  sheetName = 'result',
): ExportPayload {
  switch (format) {
    case 'json':
      return {
        data: JSON.stringify(rows, null, 2),
        extension: 'json',
        mimeType: 'application/json',
        label: 'JSON',
      };
    case 'jsonl':
      return {
        data: rows.map((row) => JSON.stringify(projectRow(fields, row))).join('\n') + (rows.length ? '\n' : ''),
        extension: 'jsonl',
        mimeType: 'application/x-ndjson',
        label: 'JSONL',
      };
    case 'xlsx':
      return {
        data: toXlsx(sheetName, fields, rows),
        extension: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        label: 'Excel',
      };
    case 'csv':
    default:
      return {
        // 前置 BOM：Excel 打开 UTF-8 CSV 时缺少 BOM 会按本地代码页解析导致中文乱码
        data: `\uFEFF${toCsv(fields, rows)}`,
        extension: 'csv',
        mimeType: 'text/csv',
        label: 'CSV',
      };
  }
}

/** 按列顺序取值，避免对象键顺序与列顺序不一致。 */
function projectRow(fields: string[], row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    out[field] = row[field] ?? null;
  }
  return out;
}

/** CSV 序列化：按 RFC 4180 转义引号、逗号与换行。 */
export function toCsv(fields: string[], rows: Record<string, unknown>[]): string {
  const lines = [fields.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    lines.push(fields.map((field) => escapeCsvCell(row[field])).join(','));
  }
  return lines.join('\r\n');
}

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// ---------------------------------------------------------------- XLSX

/**
 * 单元格样式索引，必须与 `cellXfs` 中的顺序一一对应。
 *
 * 用「角色」而不是「颜色」命名：换配色时只改 `STYLES_XML`，调用处不动。
 */
const STYLE = {
  plain: 0,
  header: 1,
  body: 2,
  bodyAlt: 3,
} as const;

/** 品牌主色，与结果面板/表头保持一致的一点视觉锚定。 */
const HEADER_FILL = 'FF2563EB';
const ALT_FILL = 'FFF6F8FB';
const BORDER_COLOR = 'FFE5E7EB';
const TEXT_COLOR = 'FF1F2937';

/**
 * 生成单工作表 XLSX。
 *
 * 采用 `inlineStr` 内联字符串，省掉 `sharedStrings.xml` 与配套的 rels 关系，
 * 代价是文件略大——对查询结果导出这个场景可以接受。
 */
export function toXlsx(sheetName: string, fields: string[], rows: Record<string, unknown>[]): Buffer {
  const sheetXml = buildSheetXml(fields, rows);
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_XML, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS_XML, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(buildWorkbookXml(sheetName), 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WORKBOOK_RELS_XML, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
  ];
  return createZip(entries);
}

/**
 * 组装工作表 XML。
 *
 * 元素顺序不是随意的：CT_Worksheet 在 ECMA-376 里是 `xsd:sequence`，
 * `cols` 必须在 `sheetData` 之前、`autoFilter` 必须在 `sheetData` 之后，
 * 顺序错了 Excel 会直接判定文件损坏。
 */
function buildSheetXml(fields: string[], rows: Record<string, unknown>[]): string {
  const lastColumn = columnName(Math.max(fields.length - 1, 0));
  const totalRows = rows.length + 1;
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="A1:${lastColumn}${totalRows}"/>`,
    '<sheetViews><sheetView workbookViewId="0">',
    // 冻结首行：结果集动辄上千行，滚下去看不到表头等于丢了列语义
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>',
    '</sheetView></sheetViews>',
    '<sheetFormatPr defaultRowHeight="16.5"/>',
    buildColsXml(fields, rows),
    '<sheetData>',
  ];

  parts.push(buildRowXml(1, fields, STYLE.header));
  rows.forEach((row, index) => {
    parts.push(
      buildRowXml(index + 2, fields.map((field) => row[field]), index % 2 ? STYLE.bodyAlt : STYLE.body),
    );
  });

  parts.push('</sheetData>');

  // 空结果集挂自动筛选会被 Excel 判为无效区域
  if (fields.length > 0 && rows.length > 0) {
    parts.push(`<autoFilter ref="A1:${lastColumn}${totalRows}"/>`);
  }

  parts.push('</worksheet>');
  return parts.join('');
}

/** 列宽声明。按内容实测宽度，单位是「默认字体下字符 '0' 的个数」。 */
function buildColsXml(fields: string[], rows: Record<string, unknown>[]): string {
  if (fields.length === 0) {
    return '';
  }
  const cols = fields.map((field, index) => {
    const width = columnWidth(field, rows);
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  });
  return `<cols>${cols.join('')}</cols>`;
}

function columnWidth(field: string, rows: Record<string, unknown>[]): number {
  let widest = displayWidth(field);
  for (const row of rows) {
    const value = row[field];
    if (value === null || value === undefined) {
      continue;
    }
    widest = Math.max(widest, displayWidth(typeof value === 'object' ? JSON.stringify(value) : String(value)));
    if (widest >= 52) {
      break;
    }
  }
  // 左右各留一点边距，并夹在合理区间——太窄看不懂，太宽逼用户横向滚动
  return Math.min(52, Math.max(9, widest + 2));
}

const WIDE_CHAR = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/**
 * 计算显示宽度，CJK / 全角字符按 2 计。
 *
 * 只看前 200 个字符：宽度最终会被夹到 52，长文本再扫下去纯属浪费。
 * 用「字符数」而不是 `Buffer.byteLength`，因为 Excel 的列宽单位不是字节。
 */
function displayWidth(text: string): number {
  let width = 0;
  let seen = 0;
  for (const char of text) {
    width += WIDE_CHAR.test(char) ? 2 : 1;
    if (++seen >= 200) {
      break;
    }
  }
  return width;
}

function buildRowXml(rowNumber: number, values: unknown[], style: number): string {
  // 表头行加高：默认行高下 11pt 粗体几乎贴着上下边框，观感很挤
  const height = style === STYLE.header ? ' ht="22" customHeight="1"' : '';
  const cells: string[] = [`<row r="${rowNumber}"${height}>`];
  values.forEach((value, columnIndex) => {
    const ref = `${columnName(columnIndex)}${rowNumber}`;
    cells.push(buildCellXml(ref, value, style));
  });
  cells.push('</row>');
  return cells.join('');
}

function buildCellXml(ref: string, value: unknown, style: number): string {
  if (value === null || value === undefined) {
    // 空单元格只带样式，不写 t 属性——写成空字符串会让 COUNT 类公式算错
    return `<c r="${ref}" s="${style}"/>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  // 对象（JSON 列、数组）统一序列化为文本；Excel 不认嵌套结构
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

/** 0 → A，25 → Z，26 → AA。 */
export function columnName(index: number): string {
  let name = '';
  let current = index;
  while (current >= 0) {
    name = String.fromCharCode(65 + (current % 26)) + name;
    current = Math.floor(current / 26) - 1;
  }
  return name;
}

/** XML 文本转义，并剔除 XML 1.0 不允许的控制字符（Excel 会因此判定文件损坏）。 */
function escapeXml(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 工作表名规则：≤31 字符，不能含 : \ / ? * [ ]。 */
export function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, '_').trim();
  const fallback = cleaned || 'result';
  return fallback.slice(0, 31);
}

function buildWorkbookXml(sheetName: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<sheets><sheet name="${escapeXml(sanitizeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>`,
    '</workbook>',
  ].join('');
}

const CONTENT_TYPES_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '<Default Extension="xml" ContentType="application/xml"/>',
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
  '</Types>',
].join('');

const ROOT_RELS_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
  '</Relationships>',
].join('');

const WORKBOOK_RELS_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
  '</Relationships>',
].join('');

/**
 * 样式表。
 *
 * 固定约定（ECMA-376 强制）：
 * - `fills` 的第 0、1 项必须是 `none` 与 `gray125`，业务填充从索引 2 起；
 * - `cellXfs` 的下标就是单元格 `s` 属性的取值，顺序必须与 `STYLE` 常量一致。
 */
const STYLES_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
  '<fonts count="2">',
  `<font><sz val="11"/><color rgb="${TEXT_COLOR}"/><name val="Calibri"/><family val="2"/></font>`,
  '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>',
  '</fonts>',
  '<fills count="4">',
  '<fill><patternFill patternType="none"/></fill>',
  '<fill><patternFill patternType="gray125"/></fill>',
  `<fill><patternFill patternType="solid"><fgColor rgb="${HEADER_FILL}"/><bgColor indexed="64"/></patternFill></fill>`,
  `<fill><patternFill patternType="solid"><fgColor rgb="${ALT_FILL}"/><bgColor indexed="64"/></patternFill></fill>`,
  '</fills>',
  '<borders count="2">',
  '<border><left/><right/><top/><bottom/><diagonal/></border>',
  `<border><left/><right/><top/><bottom style="thin"><color rgb="${BORDER_COLOR}"/></bottom><diagonal/></border>`,
  '</borders>',
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
  '<cellXfs count="4">',
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>`,
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>`,
  `<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>`,
  '</cellXfs>',
  '</styleSheet>',
].join('');

// ---------------------------------------------------------------- ZIP 容器

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * 生成 ZIP（deflate 压缩）。
 *
 * 只实现 XLSX 所需的子集：无目录项、无加密、无 ZIP64、文件名全为 ASCII。
 * 结构参照 PKWARE APPNOTE：本地文件头 → 数据 → 中央目录 → 中央目录结束记录。
 */
export function createZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'ascii');
    const compressed = zlib.deflateRawSync(entry.data);
    // 极端情况下压缩反而变大（如极小文件），此时退回存储模式
    const useDeflate = compressed.length < entry.data.length;
    const payload = useDeflate ? compressed : entry.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    localHeader.writeUInt16LE(20, 4); // 解压所需版本
    localHeader.writeUInt16LE(0, 6); // 通用标志
    localHeader.writeUInt16LE(method, 8); // 压缩方法
    localHeader.writeUInt16LE(0, 10); // 修改时间
    localHeader.writeUInt16LE(0x21, 12); // 修改日期（1980-01-01，固定值保证可复现）
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // 扩展字段长度

    localParts.push(localHeader, nameBytes, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // 中央目录头签名
    centralHeader.writeUInt16LE(20, 4); // 创建版本
    centralHeader.writeUInt16LE(20, 6); // 解压所需版本
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // 扩展字段
    centralHeader.writeUInt16LE(0, 32); // 注释
    centralHeader.writeUInt16LE(0, 34); // 起始磁盘号
    centralHeader.writeUInt16LE(0, 36); // 内部属性
    centralHeader.writeUInt32LE(0, 38); // 外部属性
    centralHeader.writeUInt32LE(offset, 42); // 本地头偏移

    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentral = Buffer.alloc(22);
  endOfCentral.writeUInt32LE(0x06054b50, 0); // 中央目录结束记录签名
  endOfCentral.writeUInt16LE(0, 4); // 当前磁盘号
  endOfCentral.writeUInt16LE(0, 6); // 中央目录起始磁盘号
  endOfCentral.writeUInt16LE(entries.length, 8);
  endOfCentral.writeUInt16LE(entries.length, 10);
  endOfCentral.writeUInt32LE(centralDirectory.length, 12);
  endOfCentral.writeUInt32LE(offset, 16);
  endOfCentral.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...localParts, centralDirectory, endOfCentral]);
}

let crcTable: Uint32Array | undefined;

/** 标准 CRC-32（IEEE 802.3，反射多项式 0xEDB88320）。 */
function crc32(data: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[i] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
