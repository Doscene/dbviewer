/**
 * 内置驱动的静态元数据。
 *
 * 刻意不 import 任何驱动 SDK——「新建连接」下拉框、状态栏等 UI 只需要这些数据，
 * 不应因此把 mysql2 / pg 加载进扩展宿主内存。
 */

import { DriverDefinition } from '../core/types';

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
  },
  description: '兼容 MySQL 5.7 / 8.x 与 MariaDB 10.x',
  sampleHost: '127.0.0.1 或 __windows_host__',
  icon: 'db-mysql.svg',
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
  },
  description: '兼容 PostgreSQL 10 及以上版本',
  sampleHost: '127.0.0.1 或 __wsl_host__',
  icon: 'db-postgresql.svg',
};

export const BUILTIN_DEFINITIONS: DriverDefinition[] = [MYSQL_DEFINITION, PG_DEFINITION];
