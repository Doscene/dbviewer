# DBViewer

VS Code 数据库客户端插件。**同时兼容 Windows 原生与 WSL 子系统两种运行场景**，内置 MySQL、PostgreSQL 驱动，驱动层可插拔扩展。

---

## 1. 为什么单独处理 Windows / WSL

WSL2 默认使用 NAT 网络：WSL 发行版与 Windows 宿主各有独立 IP，两侧的 `localhost` 指向完全不同的实体。这导致同一个连接配置在「本地 Windows 打开」与「Remote-WSL 打开」时表现不一致，最典型的故障是 `ECONNREFUSED`。

本插件用**主机别名**消除这类配置漂移：

| 别名 | 含义 | WSL 内解析为 | Windows 上解析为 |
|---|---|---|---|
| `__windows_host__` | 数据库部署在 Windows | 默认网关（`/proc/net/route`） | `127.0.0.1` |
| `__wsl_host__` | 数据库部署在 WSL | `127.0.0.1` | `127.0.0.1`（依赖 WSL2 localhost 转发） |
| `__localhost__` | 强制本机回环 | `127.0.0.1` | `127.0.0.1` |

镜像网络模式（WSL 2.0+，`.wslconfig` 中 `networkingMode=mirrored`）下，两侧的 `127.0.0.1` 双向直通，别名同样适用。

### 三种典型场景

| 场景 | 插件运行位置 | 建议填写的主机 |
|---|---|---|
| Windows 原生打开，数据库装在 Windows | Windows 扩展宿主 | `127.0.0.1` |
| Remote-WSL 打开，数据库装在 WSL | WSL 扩展宿主 | `127.0.0.1` |
| Windows 打开，数据库装在 WSL | Windows 扩展宿主 | `__wsl_host__` |
| WSL 打开，数据库装在 Windows | WSL 扩展宿主 | `__windows_host__` |

> 扩展声明了 `extensionKind: ["workspace", "ui"]`：Remote-WSL 场景下优先运行在 WSL 侧，驱动直连数据库，不跨网络。

### 设计取舍：默认不执行外部命令

早期实现通过 `wsl.exe hostname -I` 获取 WSL 地址，但在受管控的机器上安全策略会拦截 `wsl.exe`。现在默认路径**完全不依赖子进程**：

- WSL → Windows：读取 `/proc/net/route`（零副作用）；
- Windows → WSL：返回 `127.0.0.1`，依赖 WSL2 自带的 localhost 转发；
- 仅当显式开启 `dbviewer.allowExternalCommand` 时才尝试调用 `wsl.exe` / `wslinfo`。

---

## 2. 功能

- **连接表单**：单页 Webview 表单，一次填完全部字段。数据库类型、主机、端口、用户名、密码、默认数据库、分组、SSL、只读模式、驱动私有参数都在同一屏；切换数据库类型会自动更新默认端口、驱动说明与专属参数项。表单内可**先测试连接再保存**，测试成功后「默认数据库」会填充候选列表。主机输入框实时回显别名解析结果，`localhost` 这类跨环境陷阱会即时给出警告。
- **连接管理**：分组树视图、增删改查、复制连接、只读模式；密码存入系统凭据存储（Windows DPAPI / WSL libsecret），不落配置文件。连接节点使用对应数据库的官方标志（MySQL 海豚 / PostgreSQL 大象），**未连接的节点点一下即连接**。
- **元数据浏览**：按驱动能力自适应层级。MySQL 为 `连接 → 数据库 → 表 → 列`；PostgreSQL 为 `连接 → schema → 表/视图 → 列`。
- **查询执行**：任意 SQL 文档（`.sql`）内 `Ctrl+Alt+E` 执行全文、`Ctrl+Alt+Shift+E` 执行选中；编辑器标题栏常驻 ▶ 执行全部 / 执行选中 / 切换连接三个按钮；多语句自动拆分逐条执行并分别展示结果集。
- **结果面板**：顶部是**本次实际执行的 SQL**（含自动追加的 `LIMIT`），可直接改、按「▶ 执行」或 `Ctrl+Enter` 重跑，也可一键还原；下方分页浏览、点击列头排序、单击单元格复制、复制当前页为 TSV。
- **结果表格编辑**：双击单元格就地改值 → 改动以橙色高亮挂起并计数 → 点「应用修改 (N)」才真正落库，旁边「放弃」整体撤销。扩展侧依据**主键**逐条生成 `UPDATE`，实际下发的 SQL 回显在面板上，单格失败不影响其余。无主键、主键不在结果列中、驱动未声明 `editable` 或连接为只读时，编辑入口自动关闭。
- **结果导出**：CSV（带 BOM，Excel 不乱码）、Excel（真 `.xlsx`，无第三方依赖，冻结表头 + 自动筛选 + 斑马纹 + 自适应列宽）、JSON、JSONL（每行一个对象，便于流式导入）。
- **表操作**：查看前 N 行、查看建表语句（PG 由系统目录拼装近似 DDL）、生成查询语句、复制名称。
- **写操作保护**：`INSERT / UPDATE / DELETE / DROP / TRUNCATE / ALTER` 等执行前二次确认；只读连接直接拦截。
- **环境诊断**：`DBViewer: 诊断运行环境（Windows / WSL）` 输出完整的网络与驱动状态，并给出针对性排查建议。

> 为什么不用 VS Code 原生的逐项弹窗（`showInputBox` 串行询问）？因为那种方式看不到已填内容、无法跳步回改、改一个字段要重走全流程，且每次弹窗都会打断输入焦点。表单能一次性呈现全部字段与上下文提示，符合「配置连接」这件事的实际使用方式。

### 结果表格编辑的安全边界

改一行数据比查一行数据的破坏力大得多，因此编辑能力是**推导出来的，不是默认给的**：

| 条件 | 结果 |
|---|---|
| 驱动 `capabilities.editable !== true` | 不可编辑 |
| `listColumns` 查不到主键 | 不可编辑（没有可靠的 `WHERE`） |
| 主键列未全部出现在结果列中 | 不可编辑（可能会改错行） |
| 本次执行是多语句 / 多结果集 | 不可编辑（第二组结果可能来自另一张表） |
| 语句不是单表 `SELECT`（CTE、UNION、`FROM (子查询)`） | 不可编辑 |
| 连接勾选了「只读模式」 | 不可编辑，驱动层直接拒绝写操作 |

生成的 `UPDATE` 由驱动完成标识符引用与字面量转义（MySQL 用反引号 + `\` 转义，PG 用双引号 + 双写单引号），通用层不参与拼装 SQL，避免跨方言错误与注入。

编辑动作也**不会**在失焦时立即执行：改动先挂在面板上（橙色高亮 + 计数），点「应用修改 (N)」才逐条提交，避免手滑碰一下就把数据改掉。改回列中现有值不会产生待提交项。

---

## 3. 快速开始

```bash
npm install
npm run compile
```

### 调试运行

1. 用 VS Code 打开本目录；
2. 按 `F5`（选择 "运行扩展"）启动扩展开发宿主；
3. 在新窗口左侧活动栏点击 DBViewer 图标 → 点击标题栏的 `+` 添加连接，填写表单后「保存并连接」。

### 打包安装

```bash
npm run package     # 生成 dbviewer-<version>.vsix
code --install-extension dbviewer-<version>.vsix
```

> 打包使用 `npm run package`（内部为 `npx @vscode/vsce@3 package --allow-missing-repository`）。
> **不要加 `--no-dependencies`**：那会把 `node_modules` 排除在外，安装后 `require('mysql2')` 直接失败。

### 测试

```bash
npm run test:smoke      # 核心逻辑冒烟测试（52 项，不依赖 VS Code）
npm run test:activate   # 扩展激活 + 连接表单 + 结果面板测试（51 项，mock vscode 后真实调用 activate）
npm test                # 依次执行上述两项
```

激活测试会校验：代码注册的命令与 `package.json` 声明双向一致、树视图创建、表单字段完整性、引导数据可解析、主机别名解析回传、非法输入不落盘、密码只进 SecretStorage、编辑模式下不误清已存密码；以及结果面板的 SQL 回传、面板内改写 SQL 的执行回调、按主键定位的单元格更新（含类型还原与 NULL 语义）、批量提交与单格失败隔离、只读结果集拒绝编辑、四种导出格式的落盘内容。

---

## 4. 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `dbviewer.defaultPageSize` | `200` | 查询结果默认最大返回行数，`0` 表示不限制 |
| `dbviewer.maxResultRows` | `5000` | 结果面板单次展示上限 |
| `dbviewer.queryTimeoutMs` | `60000` | 单条语句执行超时 |
| `dbviewer.connectTimeoutMs` | `15000` | 建立连接超时 |
| `dbviewer.driverHostMode` | `inProcess` | `inProcess` 在扩展宿主内执行；`sidecar` 在独立子进程中执行 |
| `dbviewer.autoResolveHost` | `true` | 是否自动解析主机别名 |
| `dbviewer.hostAliases` | `{}` | 自定义别名，如 `{"__prod__": "10.0.0.12"}` |
| `dbviewer.allowExternalCommand` | `false` | 是否允许调用 `wsl.exe` / `wslinfo` 辅助探测 |
| `dbviewer.confirmDestructiveStatements` | `true` | 写操作前二次确认 |

### 关于 `driverHostMode`

| 模式 | 执行位置 | 适用场景 |
|---|---|---|
| `inProcess` | 扩展宿主进程 | 默认。延迟最低，无 IPC 开销 |
| `sidecar` | fork 出的子进程 | 驱动阻塞 / 崩溃不拖累编辑器；扩展宿主不加载驱动 SDK |

两种模式下驱动实现完全相同，上层业务代码没有任何模式分支——差异被隔离在 `ProcessChannel` 与 `SidecarDriverProxy` 内。子进程启动会自动处理 Windows 特有细节（`ELECTRON_RUN_AS_NODE=1`、`windowsHide`、UTF-8 编码）。

---

## 5. 扩展新数据库驱动

新增一种数据库**不需要修改本插件任何现有代码**。

### 步骤 1：实现接口

在 `src/drivers/` 下新建 `xxx.ts`：

```ts
import { IDatabaseDriver /* 其余类型 */ } from '../core/types';

export class XxxDriver implements IDatabaseDriver {
  readonly id = 'xxx';
  readonly displayName = 'XXX 数据库';
  readonly defaultPort = 1234;
  readonly aliases = ['xxx-alias'];
  readonly capabilities = {
    columns: true,
    schemas: false,   // 决定树视图是「库 → 表」还是「schema → 表」
    ddl: true,        // 声明为 true 必须实现 showCreateTable()
    multiStatement: true,
    editable: false,  // 声明为 true 必须实现 updateCell()
  };

  async connect(options: DriverConnectOptions) { /* ... */ }
  async disconnect() { /* ... */ }
  isConnected() { /* ... */ }
  async ping() { /* ... */ }
  async listDatabases() { /* ... */ }
  async listSchemas() { /* ... */ }
  async listTables(target) { /* ... */ }
  async listColumns(target) { /* ... */ }
  async execute(sql, options) { /* ... */ }

  // 仅当 capabilities.editable 为 true 时需要。必须是 async：
  // sidecar 模式下驱动跑在子进程，同步方法无法跨进程调用。
  async updateCell(request: CellUpdateRequest, options: ExecuteOptions): Promise<CellUpdateResult> {
    const sql = `UPDATE ...`;           // 标识符引用与字面量转义由驱动自己负责
    const result = await this.execute(sql, { ...options, limit: 0 });
    return { sql, affectedRows: result.sets.reduce((n, s) => n + (s.affectedRows ?? 0), 0) };
  }
}
```

实现 `execute` 时**只需处理单条语句**，多语句拆分与结果汇总由 `src/drivers/support.ts` 的 `executeScript` 统一完成。

`DriverRegistry.validate(driver)` 用于自检能力声明与实现的对应关系：声明 `ddl: true` 却没实现 `showCreateTable()`、声明 `editable: true` 却没实现 `updateCell()`、声明 `columns: true` 却没实现 `listColumns()`、声明 `schemas: true` 却没实现 `listSchemas()`、默认端口非法，都会被逐条列出（内置驱动的测试里会对每个驱动断言该列表为空）。

### 步骤 2：登记元数据

在 `src/drivers/definitions.ts` 中追加定义（纯数据，**不要 import 驱动 SDK**，否则「新建连接」下拉框会白白加载几 MB 代码）：

```ts
export const XXX_DEFINITION: DriverDefinition = { /* ... */ };
export const BUILTIN_DEFINITIONS = [MYSQL_DEFINITION, PG_DEFINITION, XXX_DEFINITION];
```

### 步骤 3：注册（惰性工厂）

在 `src/drivers/index.ts` 的 `registerBuiltinDrivers` 中补一行。注意 `require` 写在工厂函数体内，实例化时才加载 SDK：

```ts
const factories: Record<string, DriverFactory> = {
  mysql: () => new (require('./mysql') as typeof import('./mysql')).MySqlDriver(),
  postgresql: () => new (require('./pg') as typeof import('./pg')).PostgresDriver(),
  xxx: () => new (require('./xxx') as typeof import('./xxx')).XxxDriver(),
};
```

编译即生效：树视图层级、连接向导下拉框、结果渲染都会自动适配。

### 外部驱动（不修改本插件源码）

独立 npm 包导出 `register(registry)` 即可，通过 `loadExternalDrivers()` 加载：

```ts
export function register(registry: DriverRegistry) {
  registry.register(MY_DEFINITION, () => new MyDriver());
}
```

---

## 6. 目录结构

```
src/
├── extension.ts                # 入口：环境探测 → 驱动注册 → 树视图 → 命令
├── core/
│   ├── types.ts                # 领域类型 + IDatabaseDriver 契约（不依赖 vscode）
│   ├── driverRegistry.ts       # 驱动注册表：元数据与工厂分离，支持别名解析
│   ├── connectionStore.ts      # 配置持久化 + SecretStorage 密码管理
│   ├── connectionManager.ts    # 连接生命周期；唯一的 inProcess/sidecar 分支点
│   └── sqlText.ts              # 语句切分、危险语句识别、标识符转义、值序列化
├── platform/                   # ← 跨环境差异全部收敛在此层
│   ├── environment.ts          # Windows / WSL 探测（不依赖外部命令）
│   ├── hostResolver.ts         # 主机别名解析与跨环境风险提示
│   ├── paths.ts                # Windows ↔ WSL 路径互转
│   └── processChannel.ts       # 跨平台子进程 RPC 通道
├── drivers/
│   ├── definitions.ts          # 驱动静态元数据（无 SDK 依赖）
│   ├── support.ts              # 多语句执行器（驱动共用）
│   ├── mysql.ts / pg.ts        # 具体驱动实现
│   ├── sidecarProxy.ts         # 把调用转发到子进程的驱动代理
│   └── index.ts                # 内置驱动注册
├── sidecar/host.ts             # 子进程入口
├── views/
│   ├── connectionsTree.ts      # 侧边栏树
│   ├── connectionFormPanel.ts  # 连接配置表单（新增 / 编辑）
│   └── resultPanel.ts          # Webview 结果面板
└── commands/index.ts           # 命令层：表单入口 / 执行 / 导出 / 诊断
media/                          # Webview 前端资源
├── connectionForm.css / .js    # 连接表单
├── result.css / .js            # 结果面板
└── dbviewer.svg                # 活动栏图标
scripts/                        # 冒烟测试与激活测试
```

---

## 7. 已知限制

- **连接节点是单击连接，不是双击**：VS Code 的树视图只暴露单击回调（`TreeItem.command`），没有双击事件。已连接的节点不挂该回调，单击仍只是选中 / 展开。
- **多语句依赖自行拆分**：MySQL 存储过程脚本若使用 `DELIMITER` 指令，会整体作为单条语句提交，此时脚本内的多条语句需服务器支持。常规 DDL/DML 脚本不受影响。
- **PG 跨库浏览**：PostgreSQL 的库在握手阶段确定，浏览其他库需通过连接右键「选择数据库…」重建连接（会话级切换，不修改保存的配置）。
- **PG 建表语句为近似结果**：由系统目录拼装，不含索引 / 触发器 / 外键。需要精确结构请用 `pg_dump --schema-only`。
- **`__wsl_host__` 在 Windows 侧默认按 `127.0.0.1` 处理**：若 WSL 的 localhost 转发被关闭，需手工填写 WSL 的 `hostname -I` 结果，或开启 `dbviewer.allowExternalCommand`（注意可能被安全策略拦截）。
- SSL 目前为「启用即跳过证书校验」，暂不支持指定 CA / 客户端证书路径。

---

## 8. 排查清单

连接失败时按顺序检查：

1. 执行 `DBViewer: 诊断运行环境`，确认插件运行在 Windows 还是 WSL、别名解析到了哪个 IP；
2. 若数据库监听 `127.0.0.1`（MySQL `bind-address` / PG `listen_addresses`），跨环境访问必然失败，需改为 `0.0.0.0`；
3. 账号授权范围：MySQL 的 Host 字段、PG 的 `pg_hba.conf` 需放行来源网段；
4. 宿主防火墙是否放行端口（Windows Defender 默认拦截入站）。

License: MIT
