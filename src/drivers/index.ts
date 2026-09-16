/**
 * 内置驱动注册入口。
 *
 * 关键设计：驱动工厂内部使用惰性 `require`，模块级别的 import 全部是 `import type`，
 * 因此注册阶段不会把 mysql2 / pg 的代码加载进内存——
 * 「新建连接」下拉框只需要元数据，加载 SDK 是浪费（每个驱动包都在 MB 级别）。
 */

import { DriverRegistry } from '../core/driverRegistry';
import { DriverFactory } from '../core/types';
import { BUILTIN_DEFINITIONS } from './definitions';

export function registerBuiltinDrivers(registry: DriverRegistry): void {
  const factories: Record<string, DriverFactory> = {
    mysql: () => new (require('./mysql') as typeof import('./mysql')).MySqlDriver(),
    postgresql: () => new (require('./pg') as typeof import('./pg')).PostgresDriver(),
  };

  for (const definition of BUILTIN_DEFINITIONS) {
    const factory = factories[definition.id];
    if (factory) {
      registry.register(definition, factory);
    }
  }
}

/**
 * 加载外部驱动模块（扩展点）。
 *
 * 约定：外部模块需导出 `register(registry: DriverRegistry): void`。
 * 目前通过 `dbviewer.externalDrivers`（暂未在 package.json 暴露，属预留能力）或
 * 其他扩展调用 `registerBuiltinDrivers` 后自行注册。
 *
 * 加载失败不会中断插件启动，仅收集错误供诊断输出使用。
 */
export function loadExternalDrivers(registry: DriverRegistry, moduleIds: string[]): string[] {
  const errors: string[] = [];
  for (const moduleId of moduleIds) {
    try {
      const mod = require(moduleId) as { register?: (r: DriverRegistry) => void };
      if (typeof mod.register !== 'function') {
        errors.push(`外部驱动 ${moduleId} 未导出 register(registry) 函数`);
        continue;
      }
      mod.register(registry);
    } catch (err) {
      errors.push(`外部驱动 ${moduleId} 加载失败：${(err as Error).message}`);
    }
  }
  return errors;
}
