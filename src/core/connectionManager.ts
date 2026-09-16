/**
 * 连接管理器：负责连接的建立、复用与释放。
 *
 * 职责边界：
 * - 决定驱动实例的创建方式（in-process / sidecar），这是唯一的模式分支点；
 * - 把用户填写的逻辑主机解析成当前环境可达的真实地址；
 * - 维护会话状态供树视图渲染。
 *
 * 上层（命令、树视图）只与 `ConnectionSession` 打交道，不感知驱动实现细节。
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { ConnectionStore } from './connectionStore';
import { DriverRegistry } from './driverRegistry';
import { SidecarDriverProxy } from '../drivers/sidecarProxy';
import {
  CellUpdateRequest,
  CellUpdateResult,
  ConnectionProfile,
  DatabaseError,
  DriverConnectOptions,
  IDatabaseDriver,
  QueryResult,
  ResolvedConnection,
} from './types';
import { withTimeout } from './sqlText';
import { RuntimeEnvironment } from '../platform/environment';
import { HostResolver, HostResolution } from '../platform/hostResolver';

export type SessionState = 'disconnected' | 'connecting' | 'connected' | 'error';
export type DriverHostMode = 'inProcess' | 'sidecar';

export interface ConnectionSession {
  readonly profileId: string;
  readonly profile: {
    id: string;
    name: string;
    driver: string;
    host: string;
    port: number;
    user: string;
    database?: string;
    readOnly?: boolean;
  };
  driver?: IDatabaseDriver;
  state: SessionState;
  error?: string;
  /** 主机别名解析结果，用于界面上说明「为什么连的是这个 IP」。 */
  resolvedHost?: string;
  hostNote?: string;
  hostWarnings: string[];
  connectedAt?: number;
  mode: DriverHostMode;
  /** 会话级的数据库覆盖值（不落盘），用于在不修改配置的前提下切换目标库。 */
  databaseOverride?: string;
}

export interface ConnectResult {
  session: ConnectionSession;
  resolution: HostResolution;
}

/** 「测试连接」结果：面向表单展示，因此错误信息完整回传而不是抛出。 */
export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  /** 实际连接的地址（别名解析后）。 */
  host?: string;
  hostNote?: string;
  warning?: string;
  /** 连接成功后顺带探测到的库列表，供表单的「默认数据库」做候选。 */
  databases?: string[];
  detail?: string;
}

export class ConnectionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, ConnectionSession>();
  private readonly changed = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeSession = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ConnectionStore,
    private readonly registry: DriverRegistry,
    private readonly env: RuntimeEnvironment,
  ) {}

  /** 读取配置构造解析器（配置可热更新，因此每次现取）。 */
  get resolver(): HostResolver {
    const config = vscode.workspace.getConfiguration('dbviewer');
    return new HostResolver(this.env, {
      autoResolve: config.get<boolean>('autoResolveHost', true),
      userAliases: config.get<Record<string, string>>('hostAliases', {}) ?? {},
    });
  }

  get hostMode(): DriverHostMode {
    const value = vscode.workspace.getConfiguration('dbviewer').get<string>('driverHostMode', 'inProcess');
    return value === 'sidecar' ? 'sidecar' : 'inProcess';
  }

  get queryTimeoutMs(): number {
    return Math.max(1000, vscode.workspace.getConfiguration('dbviewer').get<number>('queryTimeoutMs', 60_000));
  }

  get connectTimeoutMs(): number {
    return Math.max(1000, vscode.workspace.getConfiguration('dbviewer').get<number>('connectTimeoutMs', 15_000));
  }

  get pageSize(): number {
    return Math.max(0, vscode.workspace.getConfiguration('dbviewer').get<number>('defaultPageSize', 200));
  }

  get maxResultRows(): number {
    return Math.max(0, vscode.workspace.getConfiguration('dbviewer').get<number>('maxResultRows', 5000));
  }

  /** 获取会话；不存在时创建「未连接」占位会话，保证树视图始终有稳定引用。 */
  session(profileId: string): ConnectionSession {
    const existing = this.sessions.get(profileId);
    if (existing) {
      return existing;
    }
    const profile = this.store.get(profileId);
    if (!profile) {
      throw new DatabaseError(`连接配置不存在：${profileId}`, 'ENO_PROFILE');
    }
    const session: ConnectionSession = {
      profileId,
      profile: {
        id: profile.id,
        name: profile.name,
        driver: profile.driver,
        host: profile.host,
        port: profile.port,
        user: profile.user,
        database: profile.database,
        readOnly: profile.readOnly,
      },
      state: 'disconnected',
      hostWarnings: [],
      mode: this.hostMode,
    };
    this.sessions.set(profileId, session);
    return session;
  }

  /** 已建立（或正在建立）连接的会话列表。 */
  activeSessions(): ConnectionSession[] {
    return [...this.sessions.values()].filter((s) => s.state === 'connected' || s.state === 'connecting');
  }

  /** 建立连接。已连接时直接复用；传入 database 可切换目标库（会话级，不写入配置）。 */
  async connect(profileId: string, database?: string): Promise<ConnectResult> {
    const session = this.session(profileId);
    if (database !== undefined && database !== session.databaseOverride) {
      // 切换目标库需要重建连接：PostgreSQL 的库在握手阶段就确定，无法中途切换
      if (session.state === 'connected') {
        await this.disconnect(profileId);
      }
      session.databaseOverride = database || undefined;
    }
    if (session.state === 'connected' && session.driver?.isConnected()) {
      return {
        session,
        resolution: {
          input: session.profile.host,
          host: session.resolvedHost ?? session.profile.host,
          source: 'literal',
        },
      };
    }

    const stored = this.store.get(profileId);
    if (!stored) {
      throw new DatabaseError(`连接配置不存在：${profileId}`, 'ENO_PROFILE');
    }
    if (!this.registry.has(stored.driver)) {
      throw new DatabaseError(
        `未安装驱动「${stored.driver}」。可用驱动：${this.registry
          .list()
          .map((d) => d.id)
          .join(', ')}`,
        'ENO_DRIVER',
      );
    }

    const effectiveDatabase = session.databaseOverride ?? stored.database;
    const profile = { ...stored, database: effectiveDatabase };
    session.profile.database = effectiveDatabase;

    const resolution = this.resolver.resolve(profile.host);
    const password = await this.store.getPassword(profile.id);

    const connection: ResolvedConnection = {
      profile,
      host: resolution.host,
      hostNote: resolution.note,
      password,
    };

    session.state = 'connecting';
    session.error = undefined;
    session.resolvedHost = resolution.host;
    session.hostNote = resolution.note;
    session.hostWarnings = resolution.warning ? [resolution.warning] : [];
    session.mode = this.hostMode;
    this.changed.fire(profileId);

    const driver = this.createDriver(profile);
    const options: DriverConnectOptions = {
      connection,
      connectTimeoutMs: this.connectTimeoutMs,
      queryTimeoutMs: this.queryTimeoutMs,
    };

    try {
      // 驱动自身的连接超时是主保护，这里再加一层兜底，防止个别驱动忽略配置
      await withTimeout(
        driver.connect(options),
        this.connectTimeoutMs + 5_000,
        `连接超时（${this.connectTimeoutMs}ms 未完成握手）`,
      );
      session.driver = driver;
      session.state = 'connected';
      session.connectedAt = Date.now();
    } catch (err) {
      session.state = 'error';
      session.error = (err as Error).message;
      session.driver = undefined;
      try {
        await driver.disconnect();
      } catch {
        /* 忽略 */
      }
      this.changed.fire(profileId);
      throw err;
    }

    this.changed.fire(profileId);
    return { session, resolution };
  }

  /**
   * 用「未保存的配置」试连一次，随后立即断开。
   *
   * 供连接表单的「测试连接」按钮使用：用户不必先保存一条错误配置再回来改。
   * 复用 createDriver，因此 inProcess / sidecar 两种模式的行为完全一致。
   */
  async testProfile(profile: ConnectionProfile, password?: string): Promise<ConnectionTestResult> {
    const resolution = this.resolver.resolve(profile.host);
    const base = {
      host: resolution.host,
      hostNote: resolution.note,
      warning: resolution.warning,
    };

    if (!this.registry.has(profile.driver)) {
      return { ok: false, message: `未安装驱动「${profile.driver}」`, ...base };
    }

    let driver: IDatabaseDriver | undefined;
    try {
      driver = this.createDriver(profile);
      await withTimeout(
        driver.connect({
          connection: { profile, host: resolution.host, hostNote: resolution.note, password },
          connectTimeoutMs: this.connectTimeoutMs,
          queryTimeoutMs: this.queryTimeoutMs,
        }),
        this.connectTimeoutMs + 5_000,
        `连接超时（${this.connectTimeoutMs}ms 未完成握手）`,
      );

      // 库列表属于「锦上添花」：权限不足或超时都不应让测试整体失败
      let databases: string[] | undefined;
      try {
        const list = await withTimeout(driver.listDatabases(), 8_000, '读取数据库列表超时');
        databases = list.map((db) => db.name);
      } catch {
        databases = undefined;
      }

      return { ok: true, message: '连接成功', databases, ...base };
    } catch (err) {
      return {
        ok: false,
        message: (err as Error).message,
        detail: err instanceof DatabaseError ? err.detail : undefined,
        ...base,
      };
    } finally {
      if (driver) {
        try {
          await driver.disconnect();
        } catch {
          /* 测试连接失败时断开也可能失败，忽略 */
        }
      }
    }
  }

  /** 断开连接并释放驱动资源。 */
  async disconnect(profileId: string): Promise<void> {
    const session = this.sessions.get(profileId);
    if (!session) {
      return;
    }
    const driver = session.driver;
    session.driver = undefined;
    session.state = 'disconnected';
    session.connectedAt = undefined;
    session.error = undefined;
    this.changed.fire(profileId);
    if (driver) {
      try {
        await driver.disconnect();
      } catch {
        /* 断开失败不影响状态一致性 */
      }
    }
  }

  /** 更新会话内的 profile 快照（编辑连接后调用）。 */
  refreshProfile(profileId: string): void {
    const session = this.sessions.get(profileId);
    if (!session) {
      return;
    }
    const profile = this.store.get(profileId);
    if (!profile) {
      return;
    }
    Object.assign(session.profile, {
      name: profile.name,
      driver: profile.driver,
      host: profile.host,
      port: profile.port,
      user: profile.user,
      database: profile.database,
      readOnly: profile.readOnly,
    });
    this.changed.fire(profileId);
  }

  /** 执行 SQL。驱动内部负责多语句拆分，返回多组结果集。 */
  async execute(profileId: string, sql: string, limitOverride?: number): Promise<QueryResult> {
    const session = await this.connect(profileId);
    const driver = session.session.driver;
    if (!driver) {
      throw new DatabaseError('连接未就绪', 'ENOT_CONNECTED');
    }
    return driver.execute(sql, {
      limit: limitOverride ?? this.pageSize,
      timeoutMs: this.queryTimeoutMs,
      sanitize: true,
    });
  }

  /**
   * 执行单元格更新（结果面板的表格编辑入口）。
   *
   * 这里只做「能力检查 + 转发」：SQL 的生成与执行全部交给驱动，
   * 因为标识符引用与字面量转义规则因数据库而异，通用层拼装必然出错。
   */
  async updateCell(profileId: string, request: CellUpdateRequest): Promise<CellUpdateResult> {
    const { session } = await this.connect(profileId);
    const driver = session.driver;
    if (!driver) {
      throw new DatabaseError('连接未就绪', 'ENOT_CONNECTED');
    }
    if (!driver.capabilities.editable || typeof driver.updateCell !== 'function') {
      throw new DatabaseError(`驱动「${driver.displayName}」不支持直接编辑结果`, 'ENO_EDIT');
    }
    return driver.updateCell(request, { limit: 0, timeoutMs: this.queryTimeoutMs, sanitize: true });
  }

  /** 释放所有会话，插件停用时调用。 */
  async disposeAll(): Promise<void> {    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      try {
        await this.disconnect(id);
      } catch {
        /* 忽略 */
      }
    }
  }

  dispose(): void {
    this.changed.dispose();
  }

  /**
   * 驱动实例创建——本插件唯一的「模式分支」。
   *
   * inProcess：直接在当前进程实例化驱动，延迟最低；
   * sidecar  ：创建代理对象，实际执行发生在 fork 出的子进程内。
   */
  private createDriver(profile: {
    id: string;
    driver: string;
  }): IDatabaseDriver {
    const definition = this.registry.definition(profile.driver);
    if (!definition) {
      throw new DatabaseError(`未找到驱动「${profile.driver}」`, 'ENO_DRIVER');
    }
    if (this.hostMode === 'sidecar') {
      return new SidecarDriverProxy({
        definition,
        hostModulePath: path.join(this.context.extensionPath, 'out', 'sidecar', 'host.js'),
        connectionId: profile.id,
        // RPC 超时必须大于查询超时，否则长查询会被通道提前掐断
        requestTimeoutMs: this.queryTimeoutMs + 10_000,
        onLog: (line) => {
          if (line) {
            console.warn(`[dbviewer-sidecar] ${line}`);
          }
        },
      });
    }
    return this.registry.create(profile.driver);
  }
}
