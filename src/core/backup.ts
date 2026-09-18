/**
 * 备份编排核心。
 *
 * 本模块**不依赖 `vscode`**：它只负责「反复向驱动要一块文本 → 写进 sink」这个循环，
 * 因此可以在扩展宿主、sidecar 子进程与纯 Node 测试里复用。
 *
 * 为什么是分块而不是「驱动一次性产出整个文件」：
 * 1. 备份动辄上百 MB，整份文本同时存在于驱动内存 + IPC 消息 + 宿主内存里，三份拷贝；
 * 2. 分块后扩展侧可以边收边写盘，内存占用与库大小无关，进度也能逐块刷新；
 * 3. 取消只需在块之间检查一次，不必等一个可能跑几分钟的调用返回。
 *
 * 之所以把编排从命令层抽出来，是为了让「分块 → 落盘 → 取消 → 跳过汇总」这套逻辑
 * 能脱离 VS Code 被直接测试——命令层只保留选方式、选路径、显示进度这些壳。
 */

import { BackupChunk, BackupChunkRequest, BackupProgress, BackupSkip, BackupTarget, TableNode } from './types';

/** 单块最多读取的行数：太大则单次 RPC 体积膨胀，太小则往返次数过多。 */
export const DEFAULT_CHUNK_ROWS = 500;

/**
 * 取消令牌的结构化类型。
 *
 * 刻意不用 `vscode.CancellationToken`：本模块要保持纯 Node。由于类型是结构化的，
 * 命令层可以直接把 vscode 的 token 传进来，反之测试里传个普通对象即可。
 */
export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/** 写入目标。生产环境是文件流，测试与非文件 scheme 下是内存缓冲。 */
export interface BackupSink {
  write(text: string): Promise<void>;
  close(): Promise<void>;
  /** 中止并清理半成品，避免留下一个看似正常的残缺备份。 */
  abort(): Promise<void>;
}

/** 提供备份分块的来源（即驱动的 backupChunks）。 */
export interface BackupSource {
  backupChunks(request: BackupChunkRequest): Promise<BackupChunk>;
}

export interface BackupRunOptions {
  source: BackupSource;
  modeId: string;
  tables: BackupTarget[];
  sink: BackupSink;
  timeoutMs: number;
  chunkRows?: number;
  token?: CancellationLike;
  onProgress?: (progress: BackupProgress) => void;
}

export interface BackupRunResult {
  /** 目标对象总数。 */
  tables: number;
  /** 已导出的数据行数。 */
  rows: number;
  /** 写入字节数。 */
  bytes: number;
  /** 被跳过的对象及原因。 */
  skipped: BackupSkip[];
  /** 是否因用户取消而中断（此时文件已被清理）。 */
  cancelled: boolean;
}

/**
 * 执行一次备份：驱动持续产出分块，直到游标为 null。
 *
 * 中途取消会调用 `sink.abort()` 而不是 `close()`——一个截断的 SQL 文件比没有文件
 * 更危险，它看起来是完整的，导入时才爆出语法错误。
 */
export async function runBackup(options: BackupRunOptions): Promise<BackupRunResult> {
  const { source, modeId, tables, sink, timeoutMs, token, onProgress } = options;
  const chunkRows = Math.max(1, options.chunkRows ?? DEFAULT_CHUNK_ROWS);
  const result: BackupRunResult = { tables: tables.length, rows: 0, bytes: 0, skipped: [], cancelled: false };

  let cursor: string | undefined;
  for (;;) {
    if (token?.isCancellationRequested) {
      await sink.abort();
      return { ...result, cancelled: true };
    }

    const chunk = await source.backupChunks({ modeId, tables, cursor, chunkRows, timeoutMs });
    if (chunk.text) {
      await sink.write(chunk.text);
      result.bytes += Buffer.byteLength(chunk.text, 'utf8');
    }
    if (chunk.skipped?.length) {
      result.skipped.push(...chunk.skipped);
    }
    if (chunk.progress) {
      result.rows = chunk.progress.rows;
      onProgress?.(chunk.progress);
    }

    cursor = chunk.nextCursor ?? undefined;
    if (!cursor) {
      break;
    }
  }

  // 最后一块收完之后用户才点的取消：同样按取消处理，不留下半成品
  if (token?.isCancellationRequested) {
    await sink.abort();
    return { ...result, cancelled: true };
  }

  await sink.close();
  return result;
}

/** 内存 sink：供测试与非 `file` scheme（远程 / 虚拟文件系统）下使用。 */
export class MemorySink implements BackupSink {
  private readonly parts: string[] = [];
  private closed = false;
  private aborted = false;

  write(text: string): Promise<void> {
    this.parts.push(text);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  abort(): Promise<void> {
    this.parts.length = 0;
    this.aborted = true;
    return Promise.resolve();
  }

  get text(): string {
    return this.parts.join('');
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isAborted(): boolean {
    return this.aborted;
  }
}

// ---------------------------------------------------------------- 目标收集

/** 树节点的最小结构化形状：让 core 层不必认识 `vscode.TreeItem`。 */
export interface BackupNodeLike {
  kind: string;
  profileId?: string;
  database?: string;
  schema?: string;
  table?: string;
  tableKind?: 'table' | 'view';
}

export interface CollectedTargets {
  profileId?: string;
  /** 由节点推导出的默认库 / schema，用于生成文件名与 scope 描述。 */
  database?: string;
  schema?: string;
  targets: BackupTarget[];
  /** 校验失败的原因；有值时 targets 必为空。 */
  problem?: string;
}

/**
 * 从（可能多选的）树节点收集备份目标。
 *
 * 跨连接的选中项直接拒绝而不是分组导出：一次操作产出多个文件、每个还要各自选路径，
 * 用户很难预期结果；而且「一次备份 = 一个文件」也更便于事后查找。
 */
export function collectBackupTargets(nodes: BackupNodeLike[]): CollectedTargets {
  const tableNodes = nodes.filter((node) => node.kind === 'table' && !!node.table);
  if (tableNodes.length === 0) {
    return { targets: [], problem: '没有选中任何数据表' };
  }
  const profileId = tableNodes[0].profileId;
  if (!profileId) {
    return { targets: [], problem: '无法确定目标连接' };
  }
  if (tableNodes.some((node) => node.profileId !== profileId)) {
    return { targets: [], problem: '选中的数据表来自不同连接，请只选择同一个连接下的表' };
  }

  const seen = new Set<string>();
  const targets: BackupTarget[] = [];
  for (const node of tableNodes) {
    // 同名表可能出现在不同库 / schema 下，键必须带上命名空间
    const key = `${node.database ?? ''}|${node.schema ?? ''}|${node.table}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push({
      database: node.database,
      schema: node.schema,
      table: node.table!,
      kind: node.tableKind ?? 'table',
    });
  }

  return { profileId, database: tableNodes[0].database, schema: tableNodes[0].schema, targets };
}

/** 把 `listTables` 的结果转成备份目标（整库 / 整 schema 备份用）。 */
export function toBackupTargets(
  fallback: { database?: string; schema?: string },
  tables: TableNode[],
): BackupTarget[] {
  return tables.map((table) => ({
    database: fallback.database,
    schema: table.schema ?? fallback.schema,
    table: table.name,
    kind: table.kind,
  }));
}

/**
 * 按入口范围过滤备份方式。
 *
 * 原生工具只能整库导出（整库与选表的参数结构不同，见 definitions.ts），因此声明
 * `scope: 'database'` 的方式不该出现在表节点菜单里；schema 是库的下一级，同样给不出
 * 「整库」语义，所以只有 `both` 的方式能在 schema 入口使用。
 */
export function filterBackupModesForScope<T extends { scope?: 'database' | 'tables' | 'both' }>(
  modes: T[],
  entry: 'database' | 'schema' | 'tables',
): T[] {
  return modes.filter((mode) => {
    const declared = mode.scope ?? 'both';
    if (declared === 'both') {
      return true;
    }
    return declared === 'database' ? entry === 'database' : entry === 'tables';
  });
}

// ---------------------------------------------------------------- 文件头与文件名

export interface BackupHeaderInfo {
  connectionName: string;
  driverName: string;
  /** 范围描述，如「数据库 shop」或「3 个数据表」。 */
  scope: string;
  modeLabel: string;
  tableCount: number;
  viewCount: number;
  /** 生成器说明：是驱动纯实现还是原生工具。 */
  generator: string;
  notes?: string[];
  now?: Date;
}

/**
 * 生成备份文件头。
 *
 * 头部不只是好看：它是几个月后还原时唯一能说明「这份文件是什么、用什么导的、
 * 有什么已知缺口」的东西。因此方式、生成器与注意事项都必须写进去。
 */
export function buildBackupHeader(info: BackupHeaderInfo): string {
  const line = '-- ' + '='.repeat(60);
  const rows: string[] = [
    line,
    '-- DBViewer 数据库备份',
    `-- 连接    : ${info.connectionName}（${info.driverName}）`,
    `-- 范围    : ${info.scope}`,
    `-- 方式    : ${info.modeLabel}`,
    `-- 对象    : ${info.tableCount} 张表 / ${info.viewCount} 个视图`,
    `-- 生成于  : ${formatDateTime(info.now ?? new Date())}`,
    `-- 生成器  : ${info.generator}`,
  ];
  for (const note of info.notes ?? []) {
    rows.push(`-- 注意    : ${note}`);
  }
  rows.push(line, '');
  return rows.join('\n') + '\n';
}

/** 备份文件里的补记：跳过的对象要让还原者知道。 */
export function buildSkippedNotes(skipped: BackupSkip[]): string {
  if (skipped.length === 0) {
    return '';
  }
  return [
    '',
    '-- ------------------------------------------------------------',
    `-- 以下 ${skipped.length} 个对象未能导出，需要手工处理：`,
    ...skipped.map((item) => `--   · ${item.name}：${item.reason}`),
    '-- ------------------------------------------------------------',
    '',
  ].join('\n');
}

export function formatDateTime(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 文件名用的紧凑时间戳：`20260918-145003`。 */
export function backupTimestamp(date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 过滤文件名里的非法字符。连接名与库名都可以包含任意字符，直接拿去拼路径会失败。 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    // 以点开头的隐藏文件在资源管理器里默认不可见，容易被当成"备份没生成"
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'backup';
}

/** 组装备份文件名：`shop-20260918-145003.sql`。 */
export function buildBackupFileName(options: {
  base: string;
  mode: { extension: string };
  now?: Date;
}): string {
  return `${sanitizeFileName(options.base)}-${backupTimestamp(options.now)}.${options.mode.extension}`;
}
