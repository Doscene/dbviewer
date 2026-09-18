/**
 * 驱动注册表：插件可扩展性的核心。
 *
 * 扩展方式（无需修改本插件任何现有代码）：
 * 1. 实现 `IDatabaseDriver` 接口；
 * 2. 调用 `registry.register(definition, factory)`；
 * 3. 目录/tree 视图与查询流程会自动适配新驱动。
 *
 * 元数据（definition）与实例（factory）分离的原因：
 * - 元数据用于填充「新建连接」的下拉选项，属于纯数据，不应触发 SDK 加载；
 * - 工厂保持惰性，只有在真正建立连接时才 `require` 具体驱动 SDK，
 *   这样即便某个驱动依赖体积大或安装失败，也不影响插件其余功能。
 */

import { DriverCapabilities, DriverDefinition, DriverFactory, DriverId, IDatabaseDriver } from './types';

export class DriverRegistry {
  private readonly factories = new Map<DriverId, DriverFactory>();
  private readonly definitions = new Map<DriverId, DriverDefinition>();
  /** 别名（小写）→ 主 id */
  private readonly aliasIndex = new Map<string, DriverId>();

  /**
   * 注册驱动。
   * @throws 当 id 或别名与已注册驱动冲突时抛出，避免静默覆盖造成行为诡异。
   */
  register(definition: DriverDefinition, factory: DriverFactory): void {
    const id = definition.id;
    if (!id || !/^[a-z][a-z0-9_-]*$/i.test(id)) {
      throw new Error(`驱动 id 非法：${id}（要求字母开头，仅含字母数字下划线连字符）`);
    }
    if (this.factories.has(id)) {
      throw new Error(`驱动 ${id} 已注册，请勿重复注册`);
    }
    for (const alias of definition.aliases ?? []) {
      const key = alias.toLowerCase();
      const exist = this.aliasIndex.get(key);
      if (exist) {
        throw new Error(`驱动别名 ${alias} 已被 ${exist} 占用`);
      }
    }
    this.factories.set(id, factory);
    this.definitions.set(id, definition);
    this.aliasIndex.set(id.toLowerCase(), id);
    for (const alias of definition.aliases ?? []) {
      this.aliasIndex.set(alias.toLowerCase(), id);
    }
  }

  /** 已注册驱动的元数据列表（按显示名排序，供 UI 下拉使用）。 */
  list(): DriverDefinition[] {
    return [...this.definitions.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** 获取驱动元数据。 */
  definition(id: DriverId): DriverDefinition | undefined {
    const real = this.resolveId(id);
    return real ? this.definitions.get(real) : undefined;
  }

  /**
   * 宽松解析驱动 id：支持别名与大小写差异（如 `postgres` → `postgresql`）。
   */
  resolveId(id: DriverId): DriverId | undefined {
    if (!id) {
      return undefined;
    }
    const key = id.toLowerCase();
    return this.aliasIndex.get(key);
  }

  has(id: DriverId): boolean {
    return this.resolveId(id) !== undefined;
  }

  /** 实例化驱动。延迟到此刻才会加载具体驱动 SDK。 */
  create(id: DriverId): IDatabaseDriver {
    const real = this.resolveId(id);
    if (!real) {
      throw new Error(`未找到驱动「${id}」，已注册：${[...this.definitions.keys()].join(', ')}`);
    }
    const factory = this.factories.get(real);
    if (!factory) {
      throw new Error(`驱动 ${real} 未提供工厂函数`);
    }
    return factory();
  }

  /** 校验驱动的能力声明与实际实现是否一致，注册后自检用。 */
  validate(driver: IDatabaseDriver): string[] {
    const problems: string[] = [];
    const caps: DriverCapabilities = driver.capabilities;
    if (caps.ddl && typeof driver.showCreateTable !== 'function') {
      problems.push(`驱动 ${driver.id} 声明支持 ddl，但未实现 showCreateTable()`);
    }
    if (caps.editable && typeof driver.updateCell !== 'function') {
      problems.push(`驱动 ${driver.id} 声明支持编辑，但未实现 updateCell()`);
    }
    if (caps.columns && typeof driver.listColumns !== 'function') {
      problems.push(`驱动 ${driver.id} 声明支持列元数据，但未实现 listColumns()`);
    }
    if (caps.backup && typeof driver.backupChunks !== 'function') {
      problems.push(`驱动 ${driver.id} 声明支持备份，但未实现 backupChunks()`);
    }
    // 声明支持 schema 才要求实现；不支持的驱动（如 MySQL）本就不该有这个方法
    if (caps.schemas && typeof driver.listSchemas !== 'function') {
      problems.push(`驱动 ${driver.id} 声明支持 schema，但未实现 listSchemas()`);
    }
    if (driver.defaultPort <= 0 || driver.defaultPort > 65535) {
      problems.push(`驱动 ${driver.id} 默认端口非法：${driver.defaultPort}`);
    }
    return problems;
  }
}
