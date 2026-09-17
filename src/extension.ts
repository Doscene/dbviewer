/**
 * 扩展入口。
 *
 * 启动顺序：环境探测 → 驱动注册 → 存储 → 连接管理器 → 树视图 → 命令。
 *
 * 关于 Windows / WSL 双环境的处理位置：
 * - `extensionKind: ["workspace", "ui"]`：Remote-WSL 场景下扩展优先运行在 WSL 侧，
 *   驱动直连 WSL 内的数据库，无需跨网络；纯 Windows 场景则运行在 Windows 侧。
 * - 环境探测结果会注入连接管理器，用于解析 `__windows_host__` / `__wsl_host__` 别名。
 */

import * as vscode from 'vscode';

import { registerCommands } from './commands';
import { ConnectionManager } from './core/connectionManager';
import { ConnectionStore } from './core/connectionStore';
import { DriverRegistry } from './core/driverRegistry';
import { loadExternalDrivers, registerBuiltinDrivers } from './drivers';
import { detectEnvironment } from './platform/environment';
import { ConnectionsTreeProvider } from './views/connectionsTree';
import { ResultPanel } from './views/resultPanel';
import { SqlShellPanel } from './views/sqlShellPanel';

let activeManager: ConnectionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('dbviewer');
  const env = detectEnvironment({
    remoteName: vscode.env.remoteName,
    // 默认不调用 wsl.exe 之类的外部命令：受管控环境下会被安全策略拦截
    allowExternalCommand: config.get<boolean>('allowExternalCommand', false),
  });
  const output = vscode.window.createOutputChannel('DBViewer');
  context.subscriptions.push(output);

  const registry = new DriverRegistry();
  registerBuiltinDrivers(registry);

  const externalErrors = loadExternalDrivers(registry, []);
  for (const error of externalErrors) {
    output.appendLine(`[warn] ${error}`);
  }

  const store = new ConnectionStore(context);
  const manager = new ConnectionManager(context, store, registry, env);
  activeManager = manager;

  const tree = new ConnectionsTreeProvider(manager, store, env, registry, context.extensionUri);
  const treeView = vscode.window.createTreeView('dbviewer.connections', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  const commands = registerCommands({
    context,
    manager,
    store,
    registry,
    env,
    output,
    refreshTree: () => tree.refresh(),
  });

  context.subscriptions.push(treeView, manager, ...commands);

  output.appendLine(
    [
      '[dbviewer] 已激活',
      `  运行环境 : ${env.describe}`,
      `  远程类型 : ${env.remoteKind}`,
      `  驱动     : ${registry
        .list()
        .map((d) => d.id)
        .join(', ')}`,
      ...env.notes.map((n) => `  提示     : ${n}`),
    ].join('\n'),
  );

  // 首次使用时给出引导，直接落到「添加连接」而不是让用户对着空视图发呆
  if (store.list().length === 0 && context.globalState.get('dbviewer.welcomed') !== true) {
    void context.globalState.update('dbviewer.welcomed', true);
    void vscode.window
      .showInformationMessage(
        `DBViewer 已就绪（运行在${env.isWSL ? ' WSL' : ' Windows'}）。是否现在添加一个数据库连接？`,
        '添加连接',
        '稍后',
      )
      .then((action) => {
        if (action === '添加连接') {
          void vscode.commands.executeCommand('dbviewer.addConnection');
        }
      });
  }
}

export async function deactivate(): Promise<void> {
  // 断开所有连接并回收面板，避免子进程 / socket 残留
  SqlShellPanel.disposeAll();
  if (activeManager) {
    await activeManager.disposeAll();
    activeManager = undefined;
  }
  await ResultPanel.instance?.dispose();
}
