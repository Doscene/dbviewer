# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

VS Code 数据库客户端扩展（内置 MySQL / PostgreSQL，驱动可插拔），**必须同时兼容 Windows 原生与 WSL**。
扩展标识符 `dbviewer-dsc` 在市场全站唯一，**不要改 `package.json` 的 `name`**；命令 / 配置 / 视图 ID 恒为 `dbviewer.*`，与扩展名无关。

## 命令

```powershell
npm run compile        # tsc 编译到 out/
npm run watch          # 增量编译
npm run lint           # tsc --noEmit，没有 ESLint
npm run test:smoke     # 核心逻辑断言（纯 Node，不加载 vscode）
npm run test:activate  # mock vscode 后真实调用 activate()
npm test               # compile + 两项测试，唯一完整门禁
npm run test:live      # 真库联调（需 MySQL，凭据走环境变量，不在门禁内）
npm run package        # 出 vsix
```

测试不是测试框架，是 `scripts/` 下三个手写断言脚本：加用例直接改 `scripts/smoke-test.js`、`scripts/activate-test.js` 或 `scripts/live-mysql-test.js`。
前两者读编译产物 `out/`，单独运行前必须先 `npm run compile`。

**DDL 生成（结构编辑 / 备份 / 任何拼 SQL 的改动）除了跑门禁，还要跑一次 `npm run test:live`**：它对着真实 MySQL 建库建表、执行语句、再把结构读回来比对。纯逻辑测试只能断言「语句长什么样」，收不收得下只有服务端知道 —— 已经靠它抓到过 `ALTER DATABASE` 不接受逗号、TEXT / JSON 默认值必须写成表达式形式、改写列时 `ON UPDATE CURRENT_TIMESTAMP` 被静默抹掉这三个只在真库暴露的问题。

```powershell
$env:DBVIEWER_TEST_MYSQL_USER='root'; $env:DBVIEWER_TEST_MYSQL_PASSWORD='…'; npm run test:live
```

## 架构不变量（改代码必守）

1. `core/types.ts`、`core/tableTargets.ts`、`platform/*` **禁止 import vscode** —— sidecar 子进程要复用这些文件，必须纯 Node。
2. 跨平台差异只允许写在 `src/platform/`；drivers / views / commands 里不要出现 `isWSL` 分支。
3. `drivers/definitions.ts` **禁止 import 驱动 SDK**；`mysql2` / `pg` 只在 `drivers/index.ts` 的工厂函数体内 `require`（惰性加载，否则「新建连接」下拉框会拖进数 MB 代码）。
4. in-process / sidecar 的**唯一分支点**是 `ConnectionManager.createDriver()`。
5. `driver.execute()` 只处理**单条语句**；多语句拆分、逐条执行与结果汇总统一由 `drivers/support.ts` 的 `executeScript` 负责。
6. 驱动返回值必须过 `sqlText.sanitizeValue` / `sanitizeRow` —— BigInt / Buffer / Date 过不了 Webview 的 JSON 序列化。
7. 数据库差异优先声明为 `drivers/definitions.ts` 里的数据（`capabilities` / `backupModes` / `nativeBackup`），新增驱动时 UI 层零改动，不要按驱动名分支。
8. 密码只进 `SecretStorage`，绝不写入配置文件或 `globalState`。
9. 连接配置一律走 Webview 表单（`views/connectionFormPanel.ts`），**不要退回 `showInputBox` 串行弹窗**。
10. 编辑能力必须推导，`core/editTarget.ts` 是唯一判定入口，不能默认开启；`updateCell()` 必须 async —— sidecar 模式调不到同步方法。
11. 结果面板是按复用键的注册表（`ResultPanel.show(uri, { key })`），不是单例；排序**只改 `set.order`，不得改 `rows` 顺序** —— Webview 行下标必须恒等于扩展侧原始行下标，否则按主键更新会改错行。

## 代码风格

- TypeScript strict，另开 `noUnusedLocals` / `noUnusedParameters`：用不到的参数加 `_` 前缀。
- 2 空格缩进，带分号。
- 注释一律中文，且只写「为什么」，不复述代码在做什么。README、CHANGELOG、UI 文案同样是中文。

## 提交

Conventional Commits + 中文描述，**直接提交到 `main`**，不开 PR（如 `feat: 数据库与数据表备份导出（0.6.0）`）。

## 打包陷阱

- `npm run package` **不能加 `--no-dependencies`**，否则 `node_modules` 不进包，安装后 `require('mysql2')` 直接失败。
- `media/*.js` 不参与 tsc 编译；改完必须重新打包，提交前用 `node --check media/xxx.js` 自检。
