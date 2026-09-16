/**
 * 连接配置持久化。
 *
 * 存储策略：
 * - 连接元数据（主机、端口、用户名等）存 globalState，可随设置同步；
 * - **密码单独存入 SecretStorage**（Windows 走 DPAPI、WSL 走 libsecret），
 *   绝不写入 JSON 设置文件，避免被意外提交进版本库。
 */

import * as vscode from 'vscode';

import { ConnectionProfile } from './types';

const STORAGE_KEY = 'dbviewer.connections.v1';
const SECRET_PREFIX = 'dbviewer.password.';

export interface ConnectionInput {
  name: string;
  driver: string;
  host: string;
  port: number;
  user: string;
  database?: string;
  password?: string;
  ssl?: boolean;
  readOnly?: boolean;
  group?: string;
  options?: Record<string, string | number | boolean>;
}

export class ConnectionStore {
  private cache: ConnectionProfile[] | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** 全部连接配置（按分组、名称排序）。 */
  list(): ConnectionProfile[] {
    if (!this.cache) {
      this.cache = this.context.globalState.get<ConnectionProfile[]>(STORAGE_KEY, []);
    }
    return [...this.cache].sort((a, b) => {
      const ga = a.group ?? '';
      const gb = b.group ?? '';
      if (ga !== gb) {
        return ga.localeCompare(gb);
      }
      return a.name.localeCompare(b.name);
    });
  }

  get(id: string): ConnectionProfile | undefined {
    return this.list().find((item) => item.id === id);
  }

  async add(input: ConnectionInput): Promise<ConnectionProfile> {
    const now = Date.now();
    const profile: ConnectionProfile = {
      id: createId(),
      name: uniqueName(input.name, this.list().map((p) => p.name)),
      driver: input.driver,
      host: input.host.trim(),
      port: input.port,
      user: input.user.trim(),
      database: input.database?.trim() || undefined,
      ssl: input.ssl,
      readOnly: input.readOnly,
      group: input.group?.trim() || undefined,
      options: input.options,
      hasPassword: !!input.password,
      createdAt: now,
      updatedAt: now,
    };
    if (input.password) {
      await this.setPassword(profile.id, input.password);
    }
    await this.persist([...this.list(), profile]);
    return profile;
  }

  async update(id: string, patch: Partial<ConnectionInput>): Promise<ConnectionProfile | undefined> {
    const current = this.get(id);
    if (!current) {
      return undefined;
    }
    const next: ConnectionProfile = {
      ...current,
      name: patch.name?.trim() || current.name,
      driver: patch.driver ?? current.driver,
      host: patch.host !== undefined ? patch.host.trim() : current.host,
      port: patch.port ?? current.port,
      user: patch.user !== undefined ? patch.user.trim() : current.user,
      database: patch.database !== undefined ? patch.database.trim() || undefined : current.database,
      ssl: patch.ssl ?? current.ssl,
      readOnly: patch.readOnly ?? current.readOnly,
      group: patch.group !== undefined ? patch.group.trim() || undefined : current.group,
      options: patch.options ?? current.options,
      updatedAt: Date.now(),
    };
    if (patch.password !== undefined) {
      if (patch.password) {
        await this.setPassword(id, patch.password);
        next.hasPassword = true;
      } else {
        await this.deletePassword(id);
        next.hasPassword = false;
      }
    }
    const all = this.list().map((item) => (item.id === id ? next : item));
    await this.persist(all);
    return next;
  }

  async remove(id: string): Promise<void> {
    await this.deletePassword(id);
    await this.persist(this.list().filter((item) => item.id !== id));
  }

  async duplicate(id: string): Promise<ConnectionProfile | undefined> {
    const source = this.get(id);
    if (!source) {
      return undefined;
    }
    const copy: ConnectionProfile = {
      ...source,
      id: createId(),
      name: uniqueName(`${source.name} 副本`, this.list().map((p) => p.name)),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const password = await this.getPassword(id);
    if (password) {
      await this.setPassword(copy.id, password);
      copy.hasPassword = true;
    }
    await this.persist([...this.list(), copy]);
    return copy;
  }

  async getPassword(id: string): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_PREFIX + id);
  }

  async setPassword(id: string, password: string): Promise<void> {
    await this.context.secrets.store(SECRET_PREFIX + id, password);
  }

  async deletePassword(id: string): Promise<void> {
    try {
      await this.context.secrets.delete(SECRET_PREFIX + id);
    } catch {
      /* 不存在时忽略 */
    }
  }

  private async persist(all: ConnectionProfile[]): Promise<void> {
    const sorted = [...all].sort((a, b) => a.createdAt - b.createdAt);
    this.cache = sorted;
    await this.context.globalState.update(STORAGE_KEY, sorted);
    this.changed.fire();
  }
}

function createId(): string {
  return `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueName(name: string, existing: string[]): string {
  const base = name.trim() || '未命名连接';
  if (!existing.includes(base)) {
    return base;
  }
  let index = 2;
  while (existing.includes(`${base} (${index})`)) {
    index++;
  }
  return `${base} (${index})`;
}
