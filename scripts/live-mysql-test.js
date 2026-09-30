/**
 * MySQL 真库联调（**不属于 `npm test` 门禁**：需要一台真实 MySQL）。
 *
 * 为什么要有它：DDL 生成只能靠纯函数测试断言「语句长什么样」，但「服务端到底收不收这条语句」
 * 只能问服务端。本脚本用编译产物里的**真实驱动**跑一遍
 * 「读结构 → 生成计划 → 执行 → 复读校验」，断言的不只是「语句能跑通」，
 * 还有「跑完之后表结构真的变成了目标状态」。它已经抓到过三个只有真库才会暴露的问题：
 * `ALTER DATABASE` 不接受逗号分隔、TEXT/JSON 默认值必须写成表达式形式、
 * 以及改写别的属性时 `ON UPDATE CURRENT_TIMESTAMP` 被静默抹掉。
 *
 * 用法（凭据只走环境变量，绝不进命令行历史 / 仓库）：
 *   $env:DBVIEWER_TEST_MYSQL_USER='root'
 *   $env:DBVIEWER_TEST_MYSQL_PASSWORD='…'
 *   npm run test:live            # 可选 DBVIEWER_TEST_MYSQL_HOST / _PORT / _DATABASE_SUFFIX
 *
 * 安全性：只创建并操作自建的 `__dbviewer_probe_<时间戳>` 库，结束时 DROP DATABASE；
 * 任何一步挂掉都会走 finally 清理。
 */

const path = require('path');
const assert = require('assert');

const outDir = path.join(__dirname, '..', 'out');
const { MySqlDriver } = require(path.join(outDir, 'drivers', 'mysql.js'));

const user = process.env.DBVIEWER_TEST_MYSQL_USER;
const password = process.env.DBVIEWER_TEST_MYSQL_PASSWORD || '';
const host = process.env.DBVIEWER_TEST_MYSQL_HOST || '127.0.0.1';
const port = process.env.DBVIEWER_TEST_MYSQL_PORT || '3306';
if (!user) {
  console.error('缺少环境变量 DBVIEWER_TEST_MYSQL_USER（密码走 DBVIEWER_TEST_MYSQL_PASSWORD）。');
  console.error('例：$env:DBVIEWER_TEST_MYSQL_USER=\'root\'; $env:DBVIEWER_TEST_MYSQL_PASSWORD=\'…\'; npm run test:live');
  process.exit(2);
}

const stamp = Date.now().toString(36);
const database = `__dbviewer_probe_${stamp}`;
const table = 'users';

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    const value = fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
    return value;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✘ ${name} -> ${err.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✘ ${name} -> ${err.message}`);
  }
}

const profile = {
  id: 'probe',
  name: 'probe',
  driver: 'mysql',
  host,
  port: Number(port),
  user,
  createdAt: 0,
  updatedAt: 0,
};

const options = {
  connection: { profile, host, password },
  connectTimeoutMs: 10_000,
  queryTimeoutMs: 30_000,
};

/** 执行一条管理语句（建库 / 建表 / 清库），失败直接抛。 */
async function sql(driver, text) {
  return driver.execute(text, { limit: 0, timeoutMs: 30_000 });
}

(async function main() {
  const driver = new MySqlDriver();
  console.log(`\n=== 真库联调：MySQL ${user}@${host}:${port} → ${database} ===`);

  try {
    await driver.connect(options);
  } catch (err) {
    // 连不上时库还没建，不需要清理；只把原始错误说出来
    console.error(`连接失败（${user}@${host}:${port}）：${err && err.message ? err.message : err}`);
    process.exitCode = 1;
    return;
  }
  check('连接成功', () => assert.strictEqual(driver.isConnected(), true));

  let failed = false;
  try {
    await sql(driver, `DROP DATABASE IF EXISTS \`${database}\``);
    await sql(driver, `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
    await sql(
      driver,
      `CREATE TABLE \`${database}\`.\`${table}\` (
         \`id\` int NOT NULL AUTO_INCREMENT,
         \`name\` varchar(50) NOT NULL DEFAULT 'anon' COMMENT '昵称',
         \`email\` varchar(120) DEFAULT NULL,
         \`score\` decimal(10,2) NOT NULL DEFAULT '0.00',
         \`note\` text DEFAULT ('hello'),
         \`payload\` json DEFAULT ('{}'),
         \`calc\` int DEFAULT (1 + 2),
         \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
         \`flag\` tinyint(1) NOT NULL DEFAULT '0',
         PRIMARY KEY (\`id\`)
       ) ENGINE=InnoDB COMMENT='联调表'`,
    );

    // ---------------------------------------------------------------- 读结构

    const target = { database, table };
    const before = await driver.describeTable(target);

    check('读结构：列、顺序与主键标记', () => {
      assert.deepStrictEqual(
        before.columns.map((c) => c.name),
        ['id', 'name', 'email', 'score', 'note', 'payload', 'calc', 'created_at', 'flag'],
      );
      assert.strictEqual(before.columns[0].isPrimaryKey, true);
      assert.strictEqual(before.columns[0].autoIncrement, true);
      assert.strictEqual(before.columns[1].comment, '昵称');
      assert.strictEqual(before.columns[1].nullable, false);
      assert.strictEqual(before.columns[2].nullable, true);
      assert.strictEqual(before.columns[0].originalName, 'id');
    });

    check('读结构：属性含引擎 / 字符集 / 排序规则 / 注释', () => {
      const value = (key) => before.properties.find((p) => p.key === key).value;
      assert.strictEqual(value('engine'), 'InnoDB');
      assert.strictEqual(value('charset'), 'utf8mb4');
      assert.strictEqual(value('collation'), 'utf8mb4_general_ci');
      assert.strictEqual(value('comment'), '联调表');
      assert.strictEqual(value('name'), 'users');
    });

    check('读结构：默认值原样带回（含 CURRENT_TIMESTAMP 与裸数字）', () => {
      const byName = (name) => before.columns.find((c) => c.name === name);
      assert.strictEqual(byName('name').defaultValue, 'anon');
      assert.strictEqual(byName('email').defaultValue, null);
      assert.strictEqual(byName('score').defaultValue, '0.00');
      assert.match(String(byName('created_at').defaultValue), /CURRENT_TIMESTAMP/i);
    });

    check('读结构：候选类型与限制随结构下发', () => {
      assert.ok(before.dataTypes.includes('varchar(255)'));
      assert.strictEqual(before.allowReorder, true);
      assert.strictEqual(before.allowAutoIncrement, true);
      assert.ok(before.limitations.length >= 1);
      assert.ok(String(before.ddl || '').includes('CREATE TABLE'));
    });

    // ---------------------------------------------------------------- 无改动

    await checkAsync('无改动时不生成任何语句', async () => {
      const plan = await driver.planTableChange({ target, columns: before.columns, properties: {} });
      assert.deepStrictEqual(plan.statements, []);
    });

    await checkAsync('只提交原样的属性值也不生成语句', async () => {
      const same = {};
      for (const property of before.properties) {
        same[property.key] = property.value;
      }
      const plan = await driver.planTableChange({ target, columns: before.columns, properties: same });
      assert.deepStrictEqual(plan.statements, []);
    });

    // ---------------------------------------------------------------- 一次完整变更

    const desired = before.columns.map((column) => Object.assign({}, column));
    const byName = (name) => desired.find((c) => c.name === name);

    // 先把要改的列全部按引用抓出来：改名之后就再也按旧名找不到了
    const nameColumn = byName('name');
    const scoreColumn = byName('score');
    const emailColumn = byName('email');
    const noteColumn = byName('note');
    const payloadColumn = byName('payload');
    const calcColumn = byName('calc');
    const createdAtColumn = byName('created_at');
    const flagColumn = byName('flag');

    nameColumn.name = 'nickname'; // 改名 + 注释变更
    nameColumn.comment = '昵称（改名后）';
    scoreColumn.dataType = 'decimal(12,4)'; // 改类型
    emailColumn.nullable = false; // 允许 NULL → NOT NULL
    emailColumn.defaultValue = 'n/a'; // 补默认值
    noteColumn.comment = '文本默认值原样保留'; // 迫使 TEXT 列走 MODIFY（表达式默认值必须能写回）
    payloadColumn.comment = 'JSON 默认值原样保留';
    calcColumn.defaultValue = '3 * 7'; // 用户手打的表达式：必须补括号才合法
    createdAtColumn.comment = '创建时间'; // 迫使渲染 CURRENT_TIMESTAMP
    flagColumn.dataType = 'tinyint'; // 类型写法变化（宽度差异）
    desired.splice(2, 0, {
      // 插到中间的新列，且必须落到 nickname 之后
      name: 'code',
      dataType: 'varchar(16)',
      nullable: false,
      defaultValue: 'x',
      comment: '编码',
    });
    desired.push({
      name: 'uuid',
      dataType: 'char(36)',
      nullable: true,
      defaultValue: null,
      comment: '外部标识',
    });
    desired.push({
      name: 'alias',
      dataType: 'varchar(10)',
      nullable: true,
      defaultValue: '', // 空串默认值：与「没有默认值」必须区分开
      comment: '别名',
    });
    // 主键改成复合主键（id + code）
    byName('code').isPrimaryKey = true;
    // 位置：把 email 挪到最后
    const email = desired.splice(desired.indexOf(emailColumn), 1)[0];
    desired.push(email);

    const propertyValues = {};
    for (const property of before.properties) {
      propertyValues[property.key] = property.value;
    }
    propertyValues.comment = '联调表（已改）';
    propertyValues.charset = 'utf8mb4';
    propertyValues.collation = 'utf8mb4_unicode_ci';
    propertyValues.engine = 'MyISAM'; // 顺带验证 ENGINE 子句

    let plan;
    await checkAsync('生成计划：一条 ALTER + 无遗留问题', async () => {
      plan = await driver.planTableChange({ target, columns: desired, properties: propertyValues });
      assert.strictEqual(plan.statements.length, 1, `语句数异常：${plan.statements.length}\n${plan.statements.join('\n')}`);
      const text = plan.statements[0];
      assert.ok(text.startsWith('ALTER TABLE `' + database + '`.`users`'), text);
      assert.ok(text.includes('DROP PRIMARY KEY'), text);
      assert.ok(text.includes('ADD PRIMARY KEY (`id`, `code`)'), text);
      assert.ok(text.includes('CHANGE COLUMN `name` `nickname`'), text);
      assert.ok(text.includes('ADD COLUMN `code` varchar(16) NOT NULL DEFAULT \'x\' COMMENT \'编码\' AFTER `nickname`'), text);
      assert.ok(text.includes("DEFAULT ''"), '空串默认值必须带上引号：' + text);
      assert.ok(text.includes('COLLATE = utf8mb4_unicode_ci'), text);
      assert.ok(text.includes('ENGINE = MyISAM'), text);
      assert.ok(text.includes("COMMENT = '联调表（已改）'"), text);
      // 表达式默认值：TEXT / JSON 用读回来的原文（带字符集引导符），手打表达式补括号
      assert.ok(text.includes("`note` text DEFAULT (_utf8mb4'hello')"), text);
      assert.ok(text.includes("`payload` json DEFAULT (_utf8mb4'{}')"), text);
      assert.ok(text.includes('`calc` int DEFAULT (3 * 7)'), text);
      assert.ok(text.includes('`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP'), text);
      console.log('    计划摘要：' + (plan.changes || []).join('；'));
    });

    let applied;
    await checkAsync('执行计划成功', async () => {
      applied = await driver.applyTableChange({ target, columns: desired, properties: propertyValues });
      assert.ok(applied.executed >= 1);
    });

    const after = await driver.describeTable(target);

    check('执行后：列集合与顺序符合目标', () => {
      assert.deepStrictEqual(
        after.columns.map((c) => c.name),
        ['id', 'nickname', 'code', 'score', 'note', 'payload', 'calc', 'created_at', 'flag', 'uuid', 'alias', 'email'],
        `实际：${after.columns.map((c) => c.name).join(',')}`,
      );
    });

    check('执行后：类型 / 可空 / 默认值 / 注释真的落了库', () => {
      const col = (name) => after.columns.find((c) => c.name === name);
      assert.match(col('nickname').dataType, /varchar\(50\)/);
      assert.strictEqual(col('nickname').comment, '昵称（改名后）');
      assert.match(col('score').dataType, /decimal\(12,4\)/);
      assert.strictEqual(col('email').nullable, false);
      assert.strictEqual(col('email').defaultValue, 'n/a');
      assert.strictEqual(col('alias').defaultValue, '');
      assert.strictEqual(col('code').comment, '编码');
      assert.strictEqual(col('uuid').comment, '外部标识');
      assert.match(col('flag').dataType, /tinyint/);
      assert.match(col('created_at').defaultValue, /CURRENT_TIMESTAMP|now\(\)/i);
    });

    check('执行后：TEXT / JSON / 表达式的默认值没被改坏', () => {
      const col = (name) => after.columns.find((c) => c.name === name);
      // 写回的是反转义后的原文，MySQL 会重新归一成 `_charset\'…\'` 的形式
      assert.match(col('note').defaultValue, /^_utf8mb4\\'hello\\'$/, String(col('note').defaultValue));
      assert.match(col('payload').defaultValue, /^_utf8mb4\\'\{\}\\'$/, String(col('payload').defaultValue));
      assert.strictEqual(col('calc').defaultValue, '(3 * 7)');
      assert.strictEqual(col('note').comment, '文本默认值原样保留');
      assert.strictEqual(col('payload').comment, 'JSON 默认值原样保留');
      assert.strictEqual(col('created_at').comment, '创建时间');
    });

    check('执行后：主键变为复合主键，自增保留', () => {
      const pk = after.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
      assert.deepStrictEqual(pk, ['id', 'code']);
      assert.strictEqual(after.columns.find((c) => c.name === 'id').autoIncrement, true);
    });

    check('执行后：表属性已更新', () => {
      const value = (key) => after.properties.find((p) => p.key === key).value;
      assert.strictEqual(value('comment'), '联调表（已改）');
      assert.strictEqual(value('collation'), 'utf8mb4_unicode_ci');
      assert.strictEqual(value('engine'), 'MyISAM');
    });

    await checkAsync('复读结构后再算一次差异应该为空（幂等）', async () => {
      const again = await driver.planTableChange({ target, columns: after.columns, properties: propertyValues });
      assert.deepStrictEqual(again.statements, [], again.statements.join('\n'));
    });

    // ---------------------------------------------------------------- 删列 / 删主键 / 改名

    const trimmed = after.columns
      .filter((column) => !['note', 'uuid', 'payload'].includes(column.name))
      .map((column) => Object.assign({}, column));
    for (const column of trimmed) {
      if (column.name === 'code') {
        column.isPrimaryKey = false;
      }
    }
    await checkAsync('删列 + 撤掉复合主键 + 改表名 + 换引擎：语句顺序与执行结果', async () => {
      const renameProps = Object.assign({}, propertyValues, { name: 'members', engine: 'InnoDB' });
      const removal = await driver.planTableChange({
        target,
        columns: trimmed,
        properties: renameProps,
      });
      const text = removal.statements.join('\n');
      assert.ok(text.includes('DROP COLUMN `note`'), text);
      assert.ok(text.includes('DROP COLUMN `uuid`'), text);
      assert.ok(text.includes('DROP COLUMN `payload`'), text);
      assert.ok(text.includes('ENGINE = InnoDB'), text);
      assert.ok(text.indexOf('DROP PRIMARY KEY') < text.indexOf('DROP COLUMN `note`'), text);
      assert.ok(removal.statements[removal.statements.length - 1].startsWith('RENAME TABLE'), text);

      const result = await driver.applyTableChange({ target, columns: trimmed, properties: renameProps });
      assert.ok(result.executed >= 1);

      const renamed = await driver.describeTable({ database, table: 'members' });
      assert.deepStrictEqual(
        renamed.columns.map((c) => c.name),
        ['id', 'nickname', 'code', 'score', 'calc', 'created_at', 'flag', 'alias', 'email'],
      );
      assert.deepStrictEqual(renamed.columns.filter((c) => c.isPrimaryKey).map((c) => c.name), ['id']);
      assert.strictEqual(renamed.properties.find((p) => p.key === 'engine').value, 'InnoDB');
    });

    // ---------------------------------------------------------------- 保真：ON UPDATE 与冷门类型

    await checkAsync('保真：ON UPDATE 子句与冷门类型（unsigned zerofill / enum / set / bit / binary / timestamp(3)）不被改写坏', async () => {
      const other = 'audit';
      await sql(
        driver,
        `CREATE TABLE \`${database}\`.\`${other}\` (
           id int NOT NULL AUTO_INCREMENT,
           ts timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
           updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
           u int unsigned zerofill DEFAULT 0,
           e enum('a','b') DEFAULT 'a',
           s set('x','y') DEFAULT 'x',
           b bit(1) DEFAULT b'0',
           bin binary(4) DEFAULT NULL,
           PRIMARY KEY (id)
         )`,
      );
      const otherTarget = { database, table: other };
      const read = await driver.describeTable(otherTarget);
      const ts = read.columns.find((c) => c.name === 'ts');
      assert.strictEqual(ts.extraClauses, 'ON UPDATE CURRENT_TIMESTAMP(3)', JSON.stringify(ts));

      // 只加一列：其余列都不该被写成 MODIFY（说明 extraClauses 的比较是稳定的）
      const grown = read.columns.map((c) => Object.assign({}, c));
      grown.push({ name: 'note', dataType: 'varchar(20)', nullable: true });
      const addOnly = await driver.planTableChange({ target: otherTarget, columns: grown, properties: {} });
      assert.strictEqual(addOnly.statements.length, 1, addOnly.statements.join('\n'));
      assert.ok(!addOnly.statements[0].includes('MODIFY'), addOnly.statements.join('\n'));
      await driver.applyTableChange({ target: otherTarget, columns: grown, properties: {} });

      // 改时间戳列的注释：ON UPDATE 必须跟着一起写回去，否则就是静默改表行为
      const touched = (await driver.describeTable(otherTarget)).columns.map((c) => Object.assign({}, c));
      touched.find((c) => c.name === 'ts').comment = '改了注释';
      const modify = await driver.planTableChange({ target: otherTarget, columns: touched, properties: {} });
      assert.ok(modify.statements[0].includes('ON UPDATE CURRENT_TIMESTAMP(3)'), modify.statements.join('\n'));
      await driver.applyTableChange({ target: otherTarget, columns: touched, properties: {} });

      const raw = await driver.execute(`SHOW CREATE TABLE \`${database}\`.\`${other}\``, { limit: 0, timeoutMs: 30_000 });
      const ddl = raw.sets[0].rows[0]['Create Table'];
      assert.ok(ddl.includes('ON UPDATE CURRENT_TIMESTAMP(3)'), ddl);
      assert.ok(ddl.includes('ON UPDATE CURRENT_TIMESTAMP'), ddl);
      assert.ok(ddl.includes("`ts` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '改了注释'"), ddl);
      assert.ok(ddl.includes('int(10) unsigned zerofill'), ddl);
      assert.ok(ddl.includes("enum('a','b')"), ddl);
      assert.ok(ddl.includes("set('x','y')"), ddl);
      assert.ok(ddl.includes('bit(1)'), ddl);
      assert.ok(ddl.includes('binary(4)'), ddl);
      console.log('    时间戳列最终形态：' + ddl.split('\n').find((line) => line.includes('`ts`')).trim());

      await sql(driver, `DROP TABLE \`${database}\`.\`${other}\``);
    });

    // ---------------------------------------------------------------- 失败路径与告警

    await checkAsync('失败路径：报出「第几条失败」，并说明已生效条数（MySQL 无 DDL 事务）', async () => {
      // 造一个「第一条已生效、第二条才失败」的场景：第 2 条要把表改名成已存在的 users
      await sql(driver, `CREATE TABLE \`${database}\`.\`users\` (\`x\` int) COMMENT '占位表'`);

      const current = await driver.describeTable({ database, table: 'members' });
      const half = current.columns.map((c) => Object.assign({}, c));
      half.push({ name: 'added_col', dataType: 'int', nullable: true, comment: '半路生效' });
      const halfProps = Object.assign({}, propertyValues, { name: 'users', engine: 'MyISAM' });

      const preview = await driver.planTableChange({ target: { database, table: 'members' }, columns: half, properties: halfProps });
      assert.strictEqual(preview.statements.length, 2, preview.statements.join('\n'));

      let error;
      try {
        await driver.applyTableChange({ target: { database, table: 'members' }, columns: half, properties: halfProps });
      } catch (err) {
        error = err;
      }
      assert.ok(error, '应当抛错');
      assert.match(error.message, /第 2 条语句执行失败（共 2 条，前 1 条已生效）/, error.message);
      console.log('    真实报错：' + error.message.split('\n')[0]);

      // 第一条（ALTER）确实已经落库——这正是提示里那句话要传达的信息
      const partial = await driver.describeTable({ database, table: 'members' });
      assert.ok(partial.columns.some((c) => c.name === 'added_col'), '第一条应当已生效');
      assert.strictEqual(partial.properties.find((p) => p.key === 'engine').value, 'MyISAM');

      // 连接仍然可用
      await driver.ping();

      // 清掉占位表与半路加上的列，后续用例继续用 members
      await sql(driver, `DROP TABLE \`${database}\`.\`users\``);
      const back = partial.columns.filter((c) => c.name !== 'added_col').map((c) => Object.assign({}, c));
      const undo = await driver.planTableChange({ target: { database, table: 'members' }, columns: back, properties: { engine: 'InnoDB' } });
      await driver.applyTableChange({ target: { database, table: 'members' }, columns: back, properties: { engine: 'InnoDB' } });
      assert.ok(undo.warnings.some((w) => w.includes('added_col')), JSON.stringify(undo.warnings));
    });

    await checkAsync('删列会给出丢数据告警', async () => {
      const current = await driver.describeTable({ database, table: 'members' });
      const drop = current.columns.filter((c) => c.name !== 'email').map((c) => Object.assign({}, c));
      const dropPlan = await driver.planTableChange({ target: { database, table: 'members' }, columns: drop, properties: {} });
      assert.ok(dropPlan.warnings.some((w) => w.includes('数据')), JSON.stringify(dropPlan.warnings));
    });

    // ---------------------------------------------------------------- 库属性

    await checkAsync('库属性：读 → 只改字符集（自动补默认排序规则）→ 复读校验', async () => {
      const dbTarget = { kind: 'database', name: database };
      const described = await driver.describeDatabaseProperties(dbTarget);
      assert.strictEqual(described.properties.find((p) => p.key === 'charset').value, 'utf8mb4');
      assert.strictEqual(described.properties.find((p) => p.key === 'name').editable, false);
      assert.strictEqual(described.properties.find((p) => p.key === 'name').value, database);

      // 只提交 charset：驱动应补齐 latin1 的默认排序规则，否则服务端会报不兼容
      const dbPlan = await driver.planDatabaseChange({ target: dbTarget, properties: { charset: 'latin1' } });
      assert.strictEqual(dbPlan.statements.length, 1, dbPlan.statements.join('\n'));
      assert.ok(dbPlan.statements[0].startsWith(`ALTER DATABASE \`${database}\``), dbPlan.statements.join('\n'));
      assert.ok(dbPlan.statements[0].includes('CHARACTER SET = latin1'), dbPlan.statements.join('\n'));
      assert.ok(dbPlan.statements[0].includes('COLLATE = latin1_swedish_ci'), dbPlan.statements.join('\n'));
      assert.ok(!dbPlan.statements[0].includes(','), 'ALTER DATABASE 不接受逗号分隔：' + dbPlan.statements.join('\n'));

      const result = await driver.applyDatabaseChange({ target: dbTarget, properties: { charset: 'latin1' } });
      assert.strictEqual(result.executed, 1);

      const reread = await driver.describeDatabaseProperties(dbTarget);
      assert.strictEqual(reread.properties.find((p) => p.key === 'charset').value, 'latin1');
      assert.strictEqual(reread.properties.find((p) => p.key === 'collation').value, 'latin1_swedish_ci');
    });

    await checkAsync('库属性：只改排序规则', async () => {
      const dbTarget = { kind: 'database', name: database };
      const only = await driver.planDatabaseChange({ target: dbTarget, properties: { collation: 'latin1_general_ci' } });
      assert.ok(only.statements[0].includes('COLLATE = latin1_general_ci'), only.statements.join('\n'));
      assert.ok(!only.statements[0].includes('CHARACTER SET'), only.statements.join('\n'));
      await driver.applyDatabaseChange({ target: dbTarget, properties: { collation: 'latin1_general_ci' } });
      const reread = await driver.describeDatabaseProperties(dbTarget);
      assert.strictEqual(reread.properties.find((p) => p.key === 'collation').value, 'latin1_general_ci');
    });

    await checkAsync('非法输入在生成阶段被拦下（不碰服务端）', async () => {
      await assert.rejects(
        () => driver.planTableChange({ target: { database, table: 'members' }, columns: [], properties: {} }),
        /至少/,
      );
      await assert.rejects(
        () =>
          driver.planTableChange({
            target: { database, table: 'members' },
            columns: [
              { name: 'a', dataType: 'int', nullable: true },
              { name: 'A', dataType: 'int', nullable: true },
            ],
            properties: {},
          }),
        /重复/,
      );
    });
  } catch (err) {
    failed = true;
    console.error('\n联调中断：', err && err.message ? err.message : err);
  } finally {
    await checkAsync('清理：删除临时库', async () => {
      await sql(driver, `DROP DATABASE IF EXISTS \`${database}\``);
      const rows = await driver.execute(
        `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${database}'`,
        { limit: 0, timeoutMs: 30_000 },
      );
      assert.strictEqual(rows.sets[0].rows.length, 0, '临时库未被删除');
    });
    await driver.disconnect();
    check('断开连接', () => assert.strictEqual(driver.isConnected(), false));
  }

  console.log(`\n真库联调（MySQL ${host}:${port}）：通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log('\n失败明细：');
    for (const item of failures) {
      console.log('  - ' + item);
    }
  }
  process.exitCode = failures.length || failed ? 1 : 0;
})().catch((err) => {
  console.error('\n真库联调中断：' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
