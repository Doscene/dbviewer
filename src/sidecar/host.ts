/**
 * Sidecar 子进程入口（`dbviewer.driverHostMode = "sidecar"` 时使用）。
 *
 * 该进程由扩展宿主通过 `child_process.fork` 启动，独立承载数据库驱动 SDK：
 * - 驱动阻塞（同步 DNS、大结果集反序列化）不会卡住扩展宿主 UI；
 * - 驱动崩溃 / 内存泄漏不会拖垮整个编辑器；
 * - 该进程本身不认识 VS Code，纯 Node 环境，可在 Windows 与 WSL 下原样运行。
 *
 * 通信协议：JSON-RPC over IPC，请求由宿主侧 ProcessChannel 发起。
 */

import { DriverRegistry } from '../core/driverRegistry';
import { registerBuiltinDrivers } from '../drivers';
import {
  CellUpdateRequest,
  CreateDatabaseOptions,
  CreateUserRequest,
  DatabaseError,
  DriverConnectOptions,
  ExecuteOptions,
  IDatabaseDriver,
  QueryTarget,
} from '../core/types';
import { executeScript } from '../drivers/support';

interface SessionEntry {
  driverId: string;
  driver: IDatabaseDriver;
}

const registry = new DriverRegistry();
registerBuiltinDrivers(registry);

const sessions = new Map<string, SessionEntry>();

interface RpcMessage {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

function send(payload: Record<string, unknown>): void {
  if (process.send) {
    process.send(payload);
  }
}

function serializeError(err: unknown): { message: string; code?: string; detail?: string } {
  if (err instanceof DatabaseError) {
    return { message: err.message, code: err.code, detail: err.detail };
  }
  const e = err as { message?: string; code?: string };
  return { message: e?.message ?? String(err), code: e?.code };
}

function requireSession(connectionId: string): SessionEntry {
  const session = sessions.get(connectionId);
  if (!session) {
    throw new DatabaseError(`连接会话 ${connectionId} 不存在或已释放`, 'ENO_SESSION');
  }
  return session;
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'connect': {
      const connectionId = String(params.connectionId);
      const driverId = String(params.driver);
      const options = params.options as DriverConnectOptions;
      await closeSession(connectionId);
      const driver = registry.create(driverId);
      await driver.connect(options);
      sessions.set(connectionId, { driverId, driver });
      return { ok: true };
    }
    case 'disconnect': {
      await closeSession(String(params.connectionId));
      return { ok: true };
    }
    case 'ping': {
      await requireSession(String(params.connectionId)).driver.ping();
      return { ok: true };
    }
    case 'listDatabases': {
      return requireSession(String(params.connectionId)).driver.listDatabases();
    }
    case 'listSchemas': {
      return requireSession(String(params.connectionId)).driver.listSchemas(params.database as string | undefined);
    }
    case 'listTables': {
      return requireSession(String(params.connectionId)).driver.listTables(params.target as QueryTarget);
    }
    case 'listColumns': {
      return requireSession(String(params.connectionId)).driver.listColumns(
        params.target as QueryTarget & { table: string },
      );
    }
    case 'showCreateTable': {
      const session = requireSession(String(params.connectionId));
      if (!session.driver.showCreateTable) {
        return undefined;
      }
      return session.driver.showCreateTable(params.target as QueryTarget & { table: string });
    }
    case 'updateCell': {
      const session = requireSession(String(params.connectionId));
      if (!session.driver.updateCell) {
        throw new DatabaseError(`驱动「${session.driverId}」不支持结果编辑`, 'ENOT_EDITABLE');
      }
      return session.driver.updateCell(params.request as CellUpdateRequest, params.options as ExecuteOptions);
    }
    case 'dropTable': {
      const session = requireSession(String(params.connectionId));
      if (!session.driver.dropTable) {
        throw new DatabaseError(`驱动「${session.driverId}」不支持删除表`, 'ENOT_MANAGE');
      }
      return session.driver.dropTable(params.target as QueryTarget & { table: string });
    }
    case 'dropDatabase': {
      const session = requireSession(String(params.connectionId));
      if (!session.driver.dropDatabase) {
        throw new DatabaseError(`驱动「${session.driverId}」不支持删除数据库`, 'ENOT_MANAGE');
      }
      return session.driver.dropDatabase(String(params.name));
    }
    case 'createDatabase': {
      const session = requireSession(String(params.connectionId));
      if (!session.driver.createDatabase) {
        throw new DatabaseError(`驱动「${session.driverId}」不支持创建数据库`, 'ENOT_MANAGE');
      }
      return session.driver.createDatabase(params.options as CreateDatabaseOptions);
    }
    case 'createUser': {
      const session = requireSession(String(params.connectionId));
      if (!session.driver.createUser) {
        throw new DatabaseError(`驱动「${session.driverId}」不支持创建用户`, 'ENOT_MANAGE');
      }
      return session.driver.createUser(params.request as CreateUserRequest);
    }
    case 'grantPrivileges': {
      const session = requireSession(String(params.connectionId));
      if (!session.driver.grantPrivileges) {
        throw new DatabaseError(`驱动「${session.driverId}」不支持授权`, 'ENOT_MANAGE');
      }
      return session.driver.grantPrivileges(params.request as CreateUserRequest);
    }
    case 'execute': {
      const session = requireSession(String(params.connectionId));
      const sql = String(params.sql);
      const jsonOptions = params.options as { limit: number; timeoutMs: number };
      // 直接复用与 in-process 模式完全相同的执行器，保证两种模式下结果结构一致
      return executeScript(sql, jsonOptions, async (statement, limit, timeoutMs) => {
        const single = await session.driver.execute(statement, {
          limit,
          timeoutMs,
          sanitize: true,
        });
        return single.sets[0];
      });
    }
    case 'info': {
      return {
        pid: process.pid,
        platform: process.platform,
        node: process.version,
        drivers: registry.list().map((d) => d.id),
      };
    }
    case '__shutdown': {
      await shutdown();
      return { ok: true };
    }
    default:
      throw new DatabaseError(`子进程不支持的调用：${method}`, 'ENO_METHOD');
  }
}

async function closeSession(connectionId: string): Promise<void> {
  const session = sessions.get(connectionId);
  if (!session) {
    return;
  }
  sessions.delete(connectionId);
  try {
    await session.driver.disconnect();
  } catch {
    /* 断开异常无需上报，避免掩盖主流程错误 */
  }
}

async function shutdown(): Promise<void> {
  for (const id of [...sessions.keys()]) {
    await closeSession(id);
  }
  // 留出 IPC 冲刷时间后退出，避免宿主侧收到半截消息
  setTimeout(() => process.exit(0), 50).unref();
}

process.on('message', (raw: unknown) => {
  const message = raw as RpcMessage;
  if (!message || typeof message.method !== 'string') {
    return;
  }
  const requestId = typeof message.id === 'number' ? message.id : undefined;
  handle(message.method, message.params ?? {}).then(
    (result) => {
      if (requestId !== undefined) {
        send({ id: requestId, result });
      }
    },
    (err) => {
      if (requestId !== undefined) {
        send({ id: requestId, error: serializeError(err) });
      }
    },
  );
});

// 宿主异常退出时，父进程断开 IPC 会导致子进程成为孤儿；主动退出以免残留
process.on('disconnect', () => {
  shutdown().finally(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  // 驱动层抛出未捕获异常时保命：记录后退出，由宿主重新拉起
  process.stderr.write(`[dbviewer-sidecar] uncaughtException: ${err?.stack ?? err}\n`);
  process.exit(1);
});

send({ method: '__ready', params: { pid: process.pid } });
