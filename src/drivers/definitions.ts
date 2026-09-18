/**
 * 内置驱动的静态元数据。
 *
 * 刻意不 import 任何驱动 SDK——「新建连接」下拉框、状态栏等 UI 只需要这些数据，
 * 不应因此把 mysql2 / pg 加载进扩展宿主内存。
 *
 * 备份方式、原生工具参数同样以数据形式声明在这里：命令层只把列表渲染成选项，
 * 不需要知道背后是哪个数据库，新增驱动时 UI 代码零改动。
 */

import { BackupMode, DriverDefinition } from '../core/types';

/** 三种纯实现方式（不依赖外部命令）在所有驱动间共享，差异只体现在 SQL 方言上。 */
function pureBackupModes(importHint: string): BackupMode[] {
  return [
    {
      id: 'sql',
      label: '完整 SQL（结构 + 数据）',
      description: `${importHint}，可直接用客户端导入`,
      extension: 'sql',
      includesSchema: true,
      includesData: true,
    },
    {
      id: 'schema',
      label: '仅结构（建表语句）',
      description: '不含数据，适合建空库或比对表结构',
      extension: 'sql',
      includesSchema: true,
      includesData: false,
    },
    {
      id: 'data',
      label: '仅数据（INSERT 语句）',
      description: '不含建表语句，导入前目标表必须已存在',
      extension: 'sql',
      includesSchema: false,
      includesData: true,
    },
  ];
}

/**
 * 原生工具方式只支持整库导出。
 *
 * 原因是两种调用形态的参数结构不同：整库是 `工具 库名`，选表是 `工具 库名 表1 表2`
 * （PG 还要重复 `-t` 前缀）。与其在模板里塞条件分支，不如把范围声明出来，
 * 由命令层在表节点右键时过滤掉它。
 */
function nativeBackupMode(tool: string, detail: string): BackupMode {
  return {
    id: 'native',
    label: `原生 ${tool}`,
    description: detail,
    extension: 'sql',
    includesSchema: true,
    includesData: true,
    cliName: tool,
    scope: 'database',
  };
}

export const MYSQL_DEFINITION: DriverDefinition = {
  id: 'mysql',
  displayName: 'MySQL / MariaDB',
  defaultPort: 3306,
  aliases: ['mariadb'],
  capabilities: {
    columns: true,
    // MySQL 的 schema 与 database 同义，树视图上不再单独展开一层
    schemas: false,
    ddl: true,
    multiStatement: true,
    editable: true,
    manageDatabase: true,
    manageUser: true,
    backup: true,
  },
  description: '兼容 MySQL 5.7 / 8.x 与 MariaDB 10.x',
  sampleHost: '127.0.0.1 或 __windows_host__',
  icon: 'db-mysql.svg',
  backupModes: [
    ...pureBackupModes('均为标准 SQL，可用 mysql 客户端 source'),
    nativeBackupMode('mysqldump', '调用本机 mysqldump，额外包含索引、外键、触发器与例程'),
  ],
  nativeBackup: {
    command: 'mysqldump',
    args: [
      '--host=${host}',
      '--port=${port}',
      '--user=${user}',
      '--default-character-set=utf8mb4',
      // 不加 --lock-tables：长事务锁表会挡住线上业务，默认走一致性快照
      '--single-transaction',
      '--routines',
      '--events',
      '--triggers',
      '--skip-lock-tables',
      '${database}',
    ],
    passwordEnv: 'MYSQL_PWD',
  },
};

export const PG_DEFINITION: DriverDefinition = {
  id: 'postgresql',
  displayName: 'PostgreSQL',
  defaultPort: 5432,
  aliases: ['postgres', 'pg', 'pgsql'],
  capabilities: {
    columns: true,
    // PG 的 schema 与 database 是两级独立命名空间，必须分层展示
    schemas: true,
    ddl: true,
    multiStatement: true,
    editable: true,
    manageDatabase: true,
    manageUser: true,
    backup: true,
  },
  description: '兼容 PostgreSQL 10 及以上版本',
  sampleHost: '127.0.0.1 或 __wsl_host__',
  icon: 'db-postgresql.svg',
  backupModes: [
    ...pureBackupModes('均为标准 SQL，可用 psql 执行'),
    nativeBackupMode('pg_dump', '调用本机 pg_dump，额外包含索引、约束、序列与注释'),
  ],
  nativeBackup: {
    command: 'pg_dump',
    args: [
      '--host=${host}',
      '--port=${port}',
      '--username=${user}',
      '--dbname=${database}',
      // 去掉属主与授权语句：备份常在开发机还原，带上会因角色不存在而失败
      '--no-owner',
      '--no-privileges',
    ],
    passwordEnv: 'PGPASSWORD',
  },
};

export const BUILTIN_DEFINITIONS: DriverDefinition[] = [MYSQL_DEFINITION, PG_DEFINITION];

/** 供测试与诊断使用：校验备份方式声明的自洽性。 */
export function validateBackupMetadata(definition: DriverDefinition): string[] {
  const problems: string[] = [];
  const modes = definition.backupModes;
  if (!definition.capabilities.backup) {
    if (modes?.length) {
      problems.push(`驱动 ${definition.id} 未声明支持备份，却提供了 backupModes`);
    }
    return problems;
  }
  if (!modes?.length) {
    problems.push(`驱动 ${definition.id} 声明支持备份，但未提供 backupModes`);
    return problems;
  }
  const seen = new Set<string>();
  for (const mode of modes) {
    if (!mode.id) {
      problems.push(`驱动 ${definition.id} 的备份方式缺少 id`);
    } else if (seen.has(mode.id)) {
      problems.push(`驱动 ${definition.id} 的备份方式 id 重复：${mode.id}`);
    }
    seen.add(mode.id);
    if (!mode.extension) {
      problems.push(`驱动 ${definition.id} 的备份方式 ${mode.id} 缺少扩展名`);
    }
    if (!mode.includesSchema && !mode.includesData) {
      problems.push(`驱动 ${definition.id} 的备份方式 ${mode.id} 既不导结构也不导数据`);
    }
  }
  // 需要外部命令的方式必须能拿到工具名与参数模板，否则点了必然失败
  for (const mode of modes) {
    if (mode.cliName && definition.nativeBackup?.command !== mode.cliName) {
      problems.push(
        `驱动 ${definition.id} 的备份方式 ${mode.id} 声明依赖 ${mode.cliName}，但 nativeBackup 与之不匹配`,
      );
    }
  }
  if (definition.nativeBackup && !definition.nativeBackup.passwordEnv) {
    problems.push(`驱动 ${definition.id} 的 nativeBackup 未声明密码环境变量`);
  }
  return problems;
}

/** 参数模板里可用的占位符，平台层按此替换。 */
export const NATIVE_BACKUP_PLACEHOLDERS = ['host', 'port', 'user', 'database', 'schema', 'tables'] as const;
