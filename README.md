# DBViewer

**在 VS Code 里连数据库 —— 包括 WSL 连 Windows、Windows 连 WSL。**

连接管理、SQL 编辑执行、结果浏览编辑导出、表与账号管理，全部在编辑器内完成。
内置 MySQL 与 PostgreSQL 驱动，可直接使用；架构上支持新增数据库类型而不改动现有代码。

<!-- 截图位：把截图放进仓库后取消注释（市场页只认绝对地址）
![结果面板与 SQL Shell](https://raw.githubusercontent.com/Doscene/dbviewer/main/docs/screenshot.png)
-->

## 亮点

- **跨 Windows / WSL 直连** —— 不用再手工查 WSL 的 IP，也不用改连接配置在两套环境间来回切。
- **连接配置是单页表单** —— 所有字段一屏可见可改，切换数据库类型自动更新默认端口与专属参数，保存前可先测连接。
- **查询执行顺手** —— `.sql` 文件按快捷键即跑，多语句自动拆分、逐条出结果、出错能定位到具体某条。
- **结果不只是看** —— 可排序、可改 SQL 重跑、可双击改单元格（改完确认才落库）、可导出 CSV / Excel / JSON / JSONL。
- **能备份** —— 多选数据表一次性导出，或右键整库 / 整个 schema 备份；走内置纯 SQL 导出，也可借力本机的 `mysqldump` / `pg_dump`。
- **写操作有护栏** —— 危险语句执行前二次确认；只读连接从驱动层直接拒绝写操作。
- **凭据不进配置文件** —— 密码存系统凭据存储（Windows DPAPI / WSL libsecret）。

## 安装

从扩展市场安装（推荐）：在 VS Code 扩展面板搜索 **DBViewer**，或在命令面板执行

```
ext install doscene-cloud.dbviewer-dsc
```

命令行安装：

```bash
code --install-extension doscene-cloud.dbviewer-dsc
```

离线安装：下载 `.vsix` 后执行 `code --install-extension dbviewer-x.y.z.vsix`。

## 三步上手

1. 左侧活动栏点击 **DBViewer** 图标 → 点标题栏的 `+`；
2. 填写连接表单，点「测试连接」确认能通，再点「保存并连接」；
3. 连上后即可：**展开节点**浏览库 / 表 / 列，**右键表**查看数据或建表语句，**右键连接**打开 SQL Shell 或新建查询。

> 已保存的连接节点**点一下就连接**，不必先右键。

## 跨 Windows / WSL 连接

WSL2 默认用 NAT 网络：WSL 与 Windows 各有独立 IP，两侧的 `localhost` 指向完全不同的实体。同一个连接配置在「Windows 打开」和「Remote-WSL 打开」时表现不一致，最常见的现象就是 `ECONNREFUSED`。

DBViewer 用**主机别名**抹平这件事 —— 主机栏填别名，插件按当前运行环境自动解析成真实地址：

| 别名 | 含义 | WSL 中解析为 | Windows 中解析为 |
|---|---|---|---|
| `__windows_host__` | 数据库装在 Windows 上 | 默认网关 | `127.0.0.1` |
| `__wsl_host__` | 数据库装在 WSL 里 | `127.0.0.1` | `127.0.0.1`（走 WSL2 localhost 转发） |
| `__localhost__` | 强制本机回环 | `127.0.0.1` | `127.0.0.1` |

**你该填哪个：**

| 你的情况 | 主机填 |
|---|---|
| 在 Windows 打开 VS Code，数据库也在 Windows | `127.0.0.1` |
| 用 Remote-WSL 打开，数据库也装在 WSL | `127.0.0.1` |
| 在 Windows 打开 VS Code，数据库装在 WSL | `__wsl_host__` |
| 用 Remote-WSL 打开，数据库装在 Windows | `__windows_host__` |

主机输入框会**实时回显解析结果**，填 `localhost` 这类跨环境陷阱时会即时警告，别名可点击直接填入。也可在设置里用 `dbviewer.hostAliases` 自定义别名（例如 `{ "__prod__": "10.0.0.12" }`），自定义别名优先级更高。

> 插件在 Remote-WSL 场景下优先运行在 WSL 侧（`extensionKind: ["workspace", "ui"]`），驱动直连数据库，不跨网络。
> 镜像网络模式（`.wslconfig` 中 `networkingMode=mirrored`）下两侧 `127.0.0.1` 双向直通，别名同样适用。

## 写 SQL 并执行

在任意 `.sql` 文件中：

| 操作 | 快捷键 |
|---|---|
| 执行全文 | `Ctrl+Alt+E` |
| 执行选中 | `Ctrl+Alt+Shift+E` |
| 新建查询 | `Ctrl+Alt+N` |

编辑器标题栏常驻 **▶ 执行全文 / 执行选中 / 切换连接** 三个按钮，右键菜单也有同样入口，不必记快捷键。多语句脚本会按分号自动拆分、逐条执行，每句单独一个结果集标签，哪句失败一眼可见。

`SELECT` 类语句会自动追加 `LIMIT`，避免误写 `SELECT *` 把整表拉进内存。

## 结果面板

- **顶部是本次实际执行的 SQL**（含自动追加的 `LIMIT`）—— 可以直接改完按 `Ctrl+Enter` 重跑，也可以一键还原。
- **下方浏览结果**：分页翻页、点击列头排序、单击单元格复制、一键复制整页为 TSV，多结果集用标签切换。
- **双击单元格可改值**：改动先以橙色高亮挂起，工具栏显示「应用修改 (N)」，点它才真正写库，点「放弃」整体撤销 —— 手滑碰一下不会改坏线上数据。
- **导出**：CSV（带 BOM，Excel 打开不乱码）、Excel（真 `.xlsx`，冻结表头 + 自动筛选 + 斑马纹 + 自适应列宽）、JSON、JSONL（每行一个对象，便于流式导入）。

### 什么时候可以编辑

改数据比查数据的破坏力大，所以编辑入口是**推导出来的，不是默认给的**：

| 情况 | 结果 |
|---|---|
| 驱动未声明支持编辑 | 只读 |
| 表没有主键，或主键列不在结果列中 | 只读（否则可能改错行） |
| 语句不是单表 `SELECT`（CTE / UNION / 子查询 / 多语句） | 只读 |
| 连接勾选了「只读模式」 | 只读，驱动层直接拒绝写操作 |

生成的 `UPDATE` 由驱动负责标识符引用与字面量转义（MySQL 反引号、PostgreSQL 双引号），实际下发的 SQL 会回显在面板上供核对。多格一起提交时逐条执行，某一格失败不影响其余。

## SQL Shell

连接节点右键「打开 SQL Shell」，得到一个交互式终端：输入即执行，结果流式追加，支持取消与上下键回溯历史。

元命令在本地处理，不会下发给数据库：

| 命令 | 作用 |
|---|---|
| `\?` | 查看帮助 |
| `\l` | 列出数据库 |
| `\dt` | 列出表 |
| `\c <名字>` | 切换目标数据库 |
| `\clear` | 清空输出 |
| `\q` | 关闭面板 |

Shell 走的是和结果面板完全一样的执行链路 —— 只读拦截、危险语句确认、超时、错误翻译一个不少。

## 数据库与账号管理

树视图右键即可完成日常管理，无需离开编辑器：

| 操作 | 入口 |
|---|---|
| 查看前 N 行数据 / 查看建表语句 / 生成查询语句 | 表节点右键 |
| 创建数据库（可选字符集、编码） | 已连接节点右键 |
| 创建用户并授权（可加多条授权记录） | 已连接节点右键 |
| 删除表 / 删除数据库 | 表节点、数据库节点右键 |
| 切换数据库会话 | 已连接节点右键（PostgreSQL 需要） |

删除表 / 库会先弹确认框再执行，执行后自动刷新树视图。

## 备份

### 备份选中的数据表

在连接树里 **Ctrl / Shift 多选**表（或视图），右键 →「备份数据表…」，选中的表导出到**同一个** SQL 文件。

选中的节点来自不同连接时会被拒绝 —— 一次操作只产出一个文件，事后才好找；同名表出现在不同库 / schema 下也不会被漏掉。

### 备份整个数据库

| 右键的位置 | 备份范围 |
|---|---|
| 数据库节点（MySQL）/ schema 节点（PostgreSQL） | 该库 / 该 schema 下的全部对象 |
| 已连接的连接节点 | 该连接可见的全部对象（PostgreSQL 为所有 schema） |

### 备份方式

MySQL 与 PostgreSQL 都提供四种，弹出列表会按入口范围自动过滤：

| 方式 | 内容 | 依赖 |
|---|---|---|
| 完整 SQL | 建表语句 + 数据 | 内置，无需额外安装 |
| 仅表结构 | 只导建表语句 | 内置 |
| 仅数据 | 只导 `INSERT` | 内置 |
| 原生 `mysqldump` / `pg_dump` | 额外包含索引、外键、触发器、序列、注释等 | 需本机已安装该工具，并开启 `dbviewer.allowExternalCommand` |

原生方式只支持整库导出，因此不会出现在表节点右键菜单里；选中它时若外部命令仍被关闭，会弹出提示并可直接改用内置方式，不必重跑一次命令。

内置导出的几个特点：

- **流式写盘** —— 按块读取、边收边写，内存占用与库大小无关，进度逐表刷新，随时可取消；取消后不会留下半截文件（截断的 `.sql` 看起来是完整的，导入到一半才报错）。
- **单表失败不拖累其余** —— 某张表读不动就跳过它继续，并在**文件尾部**写明跳过了什么、为什么。
- **数据保真** —— 时间列按服务端原样字符串写出（不经时区往返换算），二进制列按十六进制，PostgreSQL 数组按数组字面量。
- 视图只导定义，不导数据。

生成的 `.sql` 文件头写明了连接、范围、方式、对象数量与生成时间 —— 几个月后需要还原时，这份文件自己就能说明它是什么、有什么缺口。

还原用对应客户端即可：

```bash
mysql -u 用户名 -p 库名 < 备份文件.sql
psql -U 用户名 -d 库名 -f 备份文件.sql
```

## 数据安全

- **密码只进系统凭据存储**，不写入任何配置文件或工作区设置。
- **危险语句二次确认**：`INSERT` / `UPDATE` / `DELETE` / `DROP` / `TRUNCATE` / `ALTER` 执行前弹确认，可在设置中关闭（`dbviewer.confirmDestructiveStatements`）。
- **只读连接**：勾选后驱动层直接拒绝写语句，不依赖上层判断。
- **改动先挂起**：结果表格编辑与批量提交都要显式确认，不会失焦即落库。

## 配置项

设置中搜索 `DBViewer`，或直接编辑 `settings.json`：

| 配置 | 默认 | 说明 |
|---|---|---|
| `dbviewer.defaultPageSize` | `200` | 查询默认返回行数，`0` 表示不限制 |
| `dbviewer.maxResultRows` | `5000` | 结果面板单次展示上限 |
| `dbviewer.queryTimeoutMs` | `60000` | 单条语句执行超时（毫秒） |
| `dbviewer.connectTimeoutMs` | `15000` | 建立连接超时（毫秒） |
| `dbviewer.confirmDestructiveStatements` | `true` | 写操作前二次确认 |
| `dbviewer.autoResolveHost` | `true` | 自动解析主机别名，关闭后需填真实地址 |
| `dbviewer.hostAliases` | `{}` | 自定义别名映射，优先级高于内置别名 |
| `dbviewer.driverHostMode` | `inProcess` | `inProcess` 在扩展宿主内执行；`sidecar` 在独立子进程执行，驱动崩溃或阻塞不会拖累编辑器 |
| `dbviewer.allowExternalCommand` | `false` | 是否允许调用外部命令：探测网络环境的 `wsl.exe` / `wslinfo`，以及备份时的 `mysqldump` / `pg_dump`。默认关闭 —— 受管控的机器上这类调用常被安全策略拦截 |
| `dbviewer.backupToolPaths` | `{}` | 原生备份工具的路径映射，如 `{ "mysqldump": "C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqldump.exe" }`。留空则按 `PATH` 查找 |

> 默认路径**完全不依赖子进程**：WSL → Windows 读 `/proc/net/route` 取默认网关，Windows → WSL 直接用 `127.0.0.1`。只有显式打开 `dbviewer.allowExternalCommand` 才会尝试调外部命令。

## 常见问题

**连不上，怎么办？**
执行命令面板的 `DBViewer: 诊断运行环境（Windows / WSL）`，会输出插件运行位置、别名解析结果、驱动状态和针对性建议。多数问题出在这三处：

1. 数据库只监听 `127.0.0.1`（MySQL `bind-address` / PostgreSQL `listen_addresses`）→ 跨环境访问必然失败，需改为 `0.0.0.0`；
2. 账号授权范围不够 —— MySQL 看 Host 字段，PostgreSQL 看 `pg_hba.conf`；
3. 宿主机防火墙未放行端口（Windows Defender 默认拦截入站）。

**为什么连接节点是单击连接，不是双击？**
VS Code 树视图本身不提供双击事件，只能挂单击回调。已连接的节点不挂该回调，单击仍是选中 / 展开。

**PostgreSQL 怎么浏览别的库？**
PostgreSQL 的库在握手阶段就确定了，需在已连接节点右键「选择数据库…」重建会话（不改动已保存的配置）。

**建表语句和实际结构有出入？**
PostgreSQL 的建表语句由系统目录拼装，是近似结果，不含索引 / 触发器 / 外键。需要精确结构请用 `pg_dump --schema-only`。

## 面向开发者：扩展数据库驱动

新增一种数据库**不需要修改插件任何现有代码**。实现 `IDatabaseDriver` 接口 → 在驱动定义表里登记元数据 → 在注册表里补一行工厂函数，编译即生效：树视图层级、连接表单下拉框、结果渲染都会自动适配。

```ts
export class XxxDriver implements IDatabaseDriver {
  readonly id = 'xxx';
  readonly displayName = 'XXX 数据库';
  readonly defaultPort = 1234;
  readonly capabilities = {
    columns: true,
    schemas: false,   // 决定树视图是「库 → 表」还是「schema → 表」
    ddl: true,        // 声明为 true 必须实现 showCreateTable()
    multiStatement: true,
    editable: false,  // 声明为 true 必须实现 updateCell()
    backup: false,    // 声明为 true 必须实现 backupChunks()
  };
  // connect / disconnect / isConnected / ping
  // listDatabases / listSchemas / listTables / listColumns / execute
}
```

`execute()` 只需处理单条语句，多语句拆分与结果汇总由公共框架完成。驱动 SDK 是**惰性加载**的 —— 只有在真正建立连接时才 `require`，因此「新建连接」下拉框不会额外加载数 MB 代码。

备份同理按数据声明：驱动在元数据里列出 `backupModes`（方式名、扩展名、是否含结构 / 数据、是否依赖外部命令、适用范围），命令层只负责把这份列表渲染成选项。原生工具的参数模板也写在元数据里（`nativeBackup`），占位符由框架替换、密码只走环境变量。

第三方驱动也可以做成独立 npm 包，导出 `register(registry)` 即可接入，无需本插件发版。

## 已知限制

- 多语句脚本依赖按分号自动拆分；MySQL 存储过程脚本若使用 `DELIMITER` 指令，会整体作为单条语句提交，此时脚本内多条语句需服务器支持（常规 DDL / DML 脚本不受影响）。
- 内置备份按逐表 `SELECT` 导出，**不包含**索引、外键、触发器、存储过程与序列；需要完整结构请改用原生方式，或在命令行跑 `mysqldump` / `pg_dump`。生成的文件里也不含 `CREATE DATABASE` / `CREATE SCHEMA`，还原前需先建好库 / schema。
- `__wsl_host__` 在 Windows 侧默认按 `127.0.0.1` 处理。若 WSL 的 localhost 转发被关闭，需手工填写 WSL 的真实 IP，或开启 `dbviewer.allowExternalCommand`（注意可能被安全策略拦截）。
- SSL 暂不支持指定 CA 与客户端证书路径。

---

License: MIT
