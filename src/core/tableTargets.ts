/**
 * 「查看数据」的多选目标收集。
 *
 * 与备份的 `collectBackupTargets` 是两套规则：备份一次只产出一个文件，所以跨连接的
 * 选中项必须拒绝；表数据预览是「一张表一个独立窗口」，跨连接各连各的反而更自然。
 *
 * 放在 core 层是因为它只处理数据、不认识 vscode（sidecar 子进程同样复用 core），
 * 冒烟测试可以直接 require。
 */

/** 树节点的最小结构化形状：与 `DbTreeItem.payload` 兼容，但 core 层不认识 TreeItem。 */
export interface TableDataNodeLike {
  kind?: string;
  profileId?: string;
  database?: string;
  schema?: string;
  table?: string;
  tableKind?: 'table' | 'view';
}

export interface TableDataTarget {
  profileId: string;
  database?: string;
  schema?: string;
  table: string;
  kind: 'table' | 'view';
}

export interface CollectedTableData {
  targets: TableDataTarget[];
  /** 校验失败的原因；有值时 targets 必为空。 */
  problem?: string;
}

/**
 * 从（可能多选的）树节点收集「查看数据」目标。
 *
 * 只认表 / 视图节点：列、库、连接节点在「查看数据」语境下没有意义。
 * 视图的 kind 同样是 `table`，靠 tableKind 区分——与树节点、备份目标保持一致。
 */
export function collectTableDataTargets(nodes: TableDataNodeLike[]): CollectedTableData {
  const tableNodes = nodes.filter((node) => node?.kind === 'table' && !!node.table && !!node.profileId);
  if (tableNodes.length === 0) {
    return { targets: [], problem: '没有选中任何数据表' };
  }

  const seen = new Set<string>();
  const targets: TableDataTarget[] = [];
  for (const node of tableNodes) {
    const target: TableDataTarget = {
      profileId: node.profileId!,
      database: node.database,
      schema: node.schema,
      table: node.table!,
      kind: node.tableKind ?? 'table',
    };
    // 同名表可能出现在不同库 / schema / 连接下，去重键必须带全命名空间
    const key = tableDataPanelKey(target);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push(target);
  }

  return { targets };
}

/**
 * 面板复用键。
 *
 * 必须含连接：两个连接里的同名表不能挤进同一个窗口——那会让「表 A 的数据」在用户
 * 没察觉的情况下被「表 B 的数据」顶掉，正是本次要修掉的问题。
 */
export function tableDataPanelKey(target: {
  profileId: string;
  database?: string;
  schema?: string;
  table: string;
}): string {
  return `table:${target.profileId}|${target.database ?? ''}|${target.schema ?? ''}|${target.table}`;
}

/**
 * 窗口标题：库名.表名。
 *
 * PostgreSQL 的两段式是 schema.table、MySQL 是 database.table，所以 schema 优先——
 * 与结果面板头部展示的 target 文本用同一条规则，两处不会各说各话。
 * 两段都缺时只给表名，不留一个前导点。
 */
export function tableDataPanelTitle(target: { database?: string; schema?: string; table: string }): string {
  const qualifier = target.schema ?? target.database;
  return qualifier ? `${qualifier}.${target.table}` : target.table;
}
