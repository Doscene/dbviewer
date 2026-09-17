# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [0.5.0] - 2026-09-17

### 新增

- **右键删除表 / 数据库**：连接树中，表节点右键可删除当前表，数据库节点（MySQL）右键可删除整个数据库。操作前弹出 modal 二次确认，执行后自动刷新树视图。
- **创建数据库**：已连接节点右键打开 Webview 表单，支持填写数据库名与字符集/编码；MySQL 追加 `CHARACTER SET` / `COLLATE`，PostgreSQL 使用 `ENCODING`。
- **创建用户并授权**：已连接节点右键打开 Webview 表单，支持用户名、密码、主机（MySQL），并可添加多条授权记录（目标库/schema、表可选、权限列表）。MySQL 生成 `'user'@'host'` 账号与 `GRANT ... ON db.table`；PostgreSQL 生成 `CREATE USER ... WITH PASSWORD` 与 `GRANT USAGE ON SCHEMA` + `GRANT ... ON ALL TABLES IN SCHEMA`（或具体到表）。
- 扩展 `IDatabaseDriver` 与 `DriverCapabilities`：新增 `manageDatabase`、`manageUser`、`dropTable`、`dropDatabase`、`createDatabase`、`createUser`、`grantPrivileges`。
- Sidecar 模式同步支持上述管理操作：代理层与 sidecar host 增加对应 RPC，inProcess / sidecar 行为一致。
- 新增 `views/managementFormPanel.ts`、`media/managementForm.js`、`media/managementForm.css`。
- **SQL Shell**：连接节点右键打开交互式终端面板，输入即执行、结果按流式追加，支持取消与历史回溯。元命令 `\?` `\l` `\dt` `\c` `\clear` `\q` 在扩展侧直接处理，不会下发给驱动；`\c` 切换目标库后同步刷新面板标题与目标信息。
  - 执行链路与结果面板完全一致：只读拦截、危险语句二次确认、超时、错误翻译全部走命令层注入的回调，面板自身不直接触碰驱动。
  - 单条输出最多保留 200 行，避免大结果集撑爆 Webview；每个连接复用同一个面板实例，关闭后可重新打开。
  - 新增 `views/sqlShellPanel.ts`、`media/sqlShell.js`、`media/sqlShell.css`。

### 变更

- `package.json` 注册 4 条新命令（`dropTable`、`dropDatabase`、`createDatabase`、`createUser`）与对应右键菜单；`activationEvents` 增加 `onCommand:dbviewer.createDatabase` / `createUser`。
- `.vscodeignore` 追加 `.tmp-vsix/` 与 `.*.log`，避免打包时混入临时目录与构建日志。
- **扩展内部名 `name` 由 `dbviewer` 改为 `dbviewer-dsc`**：Marketplace 对扩展名是全局唯一约束。`dbviewer` 与 `db-viewer` 连续被服务端以 `The extension '<name>' already exists in the Marketplace` 拒绝 —— 公开检索看不到任何同名扩展（已下架者的名字会被市场永久保留），占用者也非本组织的历史 publisher（`srdcloud.*` / `doscene.*` 均查无此扩展）。结论是 `db` 系通用词已被批量占位，只能改带品牌前缀的名字，`dsc` 取 `doscene.cloud` 缩写。命令 ID、配置项前缀、视图 ID 仍全部保持 `dbviewer.*`，仅扩展标识符变化。

### 测试

- `npm test` 全绿：52 项冒烟测试 + 64 项激活测试通过。
- `vsce package --out dbviewer-0.5.0.vsix` 成功，包内无日志/临时目录残留。
- 首次发布至 Visual Studio Marketplace，扩展 ID `doscene-cloud.dbviewer-dsc`。

## [0.4.0] - 2026-09-16

### 变更

- **单元格编辑改为「先攒、后确认」**：双击单元格只记录改动（橙色高亮 + 条目计数），点工具栏「应用修改 (N)」才真正写库，旁边的「放弃」可整体撤销。此前改完失焦即落库，手滑碰一下就会改到线上数据。
  - 扩展侧逐条按主键提交，单格失败不影响其余；返回汇总结果，失败格保持待提交状态并在面板上给出原因。
  - 改回列中现有值不会产生待提交项；错误返回时提示语明确区分「哪一项失败了」。
- **结果面板的 SQL 可直接改、直接跑**：SQL 区从只读 `<pre>` 换成可编辑文本框，配「▶ 执行 / 还原 / 复制」；`Ctrl+Enter` 亦可执行。执行走与文档执行完全相同的链路（连接选择、危险语句确认、超时、错误翻译），不会把结果集换到别的连接上。
- **查询编辑器新增执行按钮**：SQL 文档的编辑器标题栏常驻 ▶ 执行全部 / 执行选中 / 切换连接三个入口，新建查询时顶部注释也会提示快捷键。
- **Excel 导出改为现代版式**：冻结首行、自动筛选、表头品牌蓝实心 + 白字、隔行浅灰斑马纹、细分割线、按内容自适应列宽（中文与全角字符按双宽计算）。
- **连接节点单击即连接**：未连接的连接项挂上 `dbviewer.connect`，点一下直接连（VS Code 树视图只提供单击回调，没有双击事件）；已连接节点保持单击仅选中/展开。
- **恢复官方品牌图标**：连接树与连接表单改用 MySQL 海豚 / PostgreSQL 大象的官方标志（源自 devicon，各自补齐品牌色 `#00618A` / `#336791`），并在文件头注明商标归属。

### 修复

- `scripts/build-brand-icons.js` 的注释声称「丢掉 width/height」，模板却仍在输出内联尺寸，导致图标的实际尺寸由文件决定而非由使用方 CSS 决定；已按注释修正。

### 测试

- 冒烟测试从 47 项扩展到 52 项：新增 XLSX 的冻结首行 / 自动筛选 / 列宽声明 / 元素顺序（`cols` 先于 `sheetData`、`autoFilter` 后于 `sheetData`）/ 四档样式 / 空结果集不生成筛选 / 输出可复现等断言。
- 激活测试从 46 项扩展到 51 项：新增面板 SQL 执行回调、空 SQL 与未绑定连接时拒绝执行、批量提交的多格定位与类型还原、单格失败不影响其余、非数组入参不崩。

## [0.3.0] - 2026-09-16

### 新增

- **结果面板展示执行的 SQL**：顶部常驻显示本次实际下发的 SQL（含自动追加的 `LIMIT`），可折叠、可一键复制。多语句执行时跟随结果集标签切换；单元格编辑产生的 `UPDATE` 也会追加展示，便于核对改了什么。
- **结果表格就地编辑**：双击单元格修改，扩展侧按主键生成 `UPDATE` 并执行，实际 SQL 回显到面板。
  - 按原值类型还原：数字列写回数字、布尔列认 `true/false`；空输入框的语义跟随原值（原本是 `NULL` 则仍写 `NULL`）。
  - 编辑能力是推导出来的：驱动需声明 `capabilities.editable`、`listColumns` 能查到主键、主键列全部出现在结果列中、本次为单结果集的单表 `SELECT`、连接非只读——任一不满足即关闭编辑入口。
  - SQL 的生成与执行全部在驱动层完成（`IDatabaseDriver.updateCell()`），复用 `execute` 的只读拦截、超时与错误归一化；接口是异步的，因此 sidecar 模式同样可用。
- **结果导出扩展到四种格式**：CSV（BOM + RFC 4180）、Excel（真 `.xlsx`）、JSON、JSONL（JSON Lines）。命令面板的「导出结果」提供带说明的格式选择。
  - Excel 采用零依赖实现（`zlib.deflateRawSync` + CRC32 手写 ZIP 容器 + `inlineStr` 工作表），避免引入已停止维护且带 CVE-2023-30533 的 `xlsx`(SheetJS)。
- **按数据库类型显示图标**：连接树与连接表单使用驱动自带的图标（`db-mysql.svg` / `db-postgresql.svg`）。图标属于驱动元数据（`DriverDefinition.icon`），第三方驱动自带图标即可，UI 无需分支判断。
- 新增 `DriverCapabilities.editable`、`DriverDefinition.icon`、`ResultSet.sql`，以及 `CellUpdateRequest` / `CellUpdateResult` 类型。

### 修复

- `DriverRegistry.validate()` 的 schema 判定方向写反了：原本要求「不声明 schema 支持的驱动」也必须实现 `listSchemas()`，现改为「声明支持 `schemas` 才要求实现」。同时补上 `columns` 的对应校验。
- 冒烟测试中的异步断言此前未被 `await`，失败会被静默吞掉；现改为真正的异步断言，失败能够正确影响退出码。

### 测试

- 冒烟测试从 28 项扩展到 47 项：新增编辑目标推导（`FROM` 子句解析、注释/字符串干扰、子查询、主键缺失、元数据读取失败降级）、`toSqlLiteral` 注入防护、四种导出格式的内容校验（含解压 XLSX 验证工作表数据与控制字符剔除）。
- 激活测试从 36 项扩展到 46 项：新增结果面板的 SQL 回传、可编辑标记、按主键定位的单元格更新（字符串 / 数字 / `NULL` 三种值语义）、只读结果集拒绝编辑、导出落盘内容与「取消保存对话框不写盘」。

### 说明

- `npm run package` 已修正为 `npx @vscode/vsce@3 package --allow-missing-repository`。**不要加 `--no-dependencies`**，否则 `node_modules` 不会被打进 vsix，安装后 `require('mysql2')` 直接失败。

## [0.2.0] - 2026-09-16

### 变更

- **连接配置改为单页表单**：新增 / 编辑连接不再使用 `showInputBox` 串行弹窗，改为 Webview 表单。
  - 全部字段（类型、主机、端口、用户名、密码、默认数据库、分组、SSL、只读、驱动私有参数）一屏可见可改；
  - 切换数据库类型自动更新默认端口、驱动说明与专属参数项；
  - 表单内提供「测试连接」，测试成功后自动把探测到的数据库填入「默认数据库」候选列表；
  - 主机输入框实时回显别名解析结果，`localhost` 等跨环境陷阱即时警告，别名可点击填入；
  - 支持 `Enter` 提交 / `Ctrl+Enter` 保存并连接 / `Esc` 取消，`Tab` 顺序自然。
- 新增 `ConnectionManager.testProfile()`：用未保存的配置试连后立即断开，复用 inProcess / sidecar 双模式。

### 修复

- 直接输入 `localhost` 时被内置别名分支提前返回，导致跨环境警告丢失。

### 测试

- 激活测试从 27 项扩展到 36 项，新增连接表单的字段完整性、引导数据解析、别名实时解析回传、
  非法输入不落盘、密码只进 SecretStorage、编辑模式不误清已存密码等断言。

## [0.1.0] - 2026-09-16

首个可用版本。

### 新增

- **连接管理**：侧边栏连接树，支持新增 / 编辑 / 复制 / 删除、分组、只读模式；密码存入系统凭据存储（Windows DPAPI / WSL libsecret），不写入配置文件。
- **跨环境主机解析**：`__windows_host__` / `__wsl_host__` / `__localhost__` 三个内置别名，自动抹平 Windows 原生与 WSL 子系统的网络空间差异；支持用户自定义别名映射。
- **路径互转**：Windows 与 WSL 风格路径双向转换（含 UNC 路径），并对风格不匹配的输入给出提示。
- **MySQL / PostgreSQL 驱动**：连接、ping、库 / schema / 表 / 列元数据、查询执行、建表语句查看。
- **可插拔驱动架构**：`IDatabaseDriver` 契约 + `DriverRegistry` 注册表，元数据与工厂分离，驱动 SDK 惰性加载。新增数据库无需改动现有代码。
- **查询执行**：多语句自动拆分逐条执行，每语句独立结果集与错误定位；`SELECT` 类语句自动追加 `LIMIT` 防止误拉全表。
- **结果面板**：分页、列头排序、单元格复制、整页复制为 TSV、导出 CSV（含 BOM）/ JSON。
- **写操作保护**：危险语句执行前二次确认；只读连接直接拦截写语句。
- **驱动进程隔离**：`sidecar` 模式将驱动运行在独立子进程，跨平台处理进程创建差异（`ELECTRON_RUN_AS_NODE`、`windowsHide`、UTF-8 编码、优雅退出）。
- **环境诊断命令**：输出运行环境、主机别名解析结果、驱动状态与针对性排查建议。
- **错误归一化**：把驱动原生错误翻译为统一结构，并针对 `ECONNREFUSED` / `ETIMEDOUT` / `28P01` / `ER_ACCESS_DENIED_ERROR` 等补充可执行的排查步骤。
- **测试**：28 项核心逻辑冒烟测试 + 27 项扩展激活测试（mock `vscode` 后真实调用 `activate()`，校验命令注册与 package.json 声明一致）。

### 说明

- 默认不调用外部命令（`wsl.exe` / `wslinfo`）：受管控环境下这类调用常被安全策略拦截。需要时可开启 `dbviewer.allowExternalCommand`。
