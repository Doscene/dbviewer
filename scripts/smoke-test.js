/**
 * 冒烟测试：不依赖 VS Code 与真实数据库，验证核心逻辑的正确性。
 *
 * 运行：node scripts/smoke-test.js
 *
 * 覆盖范围：
 * - 运行环境探测（Windows / WSL 判定）
 * - 主机别名解析与跨环境提示
 * - 路径互转
 * - SQL 语句切分、危险语句识别、值序列化
 * - 驱动注册表与两个内置驱动的能力声明
 */

const path = require('path');
const assert = require('assert');

const outDir = path.join(__dirname, '..', 'out');

const { detectEnvironment } = require(path.join(outDir, 'platform', 'environment.js'));
const { HostResolver, HOST_ALIAS_WINDOWS, HOST_ALIAS_WSL } = require(path.join(outDir, 'platform', 'hostResolver.js'));
const paths = require(path.join(outDir, 'platform', 'paths.js'));
const sqlText = require(path.join(outDir, 'core', 'sqlText.js'));
const { DriverRegistry } = require(path.join(outDir, 'core', 'driverRegistry.js'));
const { registerBuiltinDrivers } = require(path.join(outDir, 'drivers', 'index.js'));

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✘ ${name} -> ${err.message}`);
  }
}

/** check 的异步版本：必须 await，否则断言失败会被静默吞掉。 */
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

console.log('\n=== 1. 运行环境探测 ===');
const env = detectEnvironment();
console.log(`  平台      : ${env.platform} / ${env.arch}`);
console.log(`  环境描述  : ${env.describe}`);
console.log(`  是否 WSL  : ${env.isWSL}`);
console.log(`  WSL 发行版: ${env.wslDistro ?? '-'}  网络模式: ${env.wslNetworkMode}`);
console.log(`  Windows 宿主 IP: ${env.windowsHostIp ?? '(未探测到)'}`);
console.log(`  WSL IP    : ${env.wslHostIp ?? '(未探测到)'}`);
check('环境对象字段完整', () => {
  assert.ok(typeof env.family === 'string');
  assert.ok(typeof env.isWSL === 'boolean');
  assert.ok(typeof env.describe === 'string' && env.describe.length > 0);
});

console.log('\n=== 2. 主机别名解析 ===');
const resolver = new HostResolver(env, { autoResolve: true, userAliases: {} });
const toWindows = resolver.resolve(HOST_ALIAS_WINDOWS);
const toWsl = resolver.resolve(HOST_ALIAS_WSL);
console.log(`  __windows_host__ -> ${toWindows.host}  ${toWindows.note ?? ''}`);
console.log(`  __wsl_host__     -> ${toWsl.host}  ${toWsl.note ?? ''}`);
console.log(`  localhost 提示   : ${resolver.resolve('localhost').warning ?? '(无)'}`);
check('别名均解析出地址', () => {
  assert.ok(/^\d+\.\d+\.\d+\.\d+$/.test(toWindows.host));
  assert.ok(/^\d+\.\d+\.\d+\.\d+$/.test(toWsl.host));
});
check('自定义别名优先于内置别名', () => {
  const custom = new HostResolver(env, { autoResolve: true, userAliases: { prod: '10.1.2.3' } });
  const res = custom.resolve('__prod__');
  assert.strictEqual(res.host, '10.1.2.3');
  assert.strictEqual(res.source, 'userAlias');
});
check('关闭自动解析时原样返回', () => {
  const off = new HostResolver(env, { autoResolve: false, userAliases: {} });
  assert.strictEqual(off.resolve(HOST_ALIAS_WINDOWS).host, HOST_ALIAS_WINDOWS);
});
check('建议列表非空（用于连接失败提示）', () => {
  assert.ok(resolver.suggestions('127.0.0.1').length > 0);
});

console.log('\n=== 3. 路径互转 ===');
check('C:\\a\\b -> /mnt/c/a/b', () => {
  assert.strictEqual(paths.windowsToWslPath('C:\\certs\\ca.pem'), '/mnt/c/certs/ca.pem');
});
check('/mnt/d/work -> D:\\work', () => {
  assert.strictEqual(paths.wslToWindowsPath('/mnt/d/work'), 'D:\\work');
});
check('UNC 路径转换', () => {
  assert.strictEqual(paths.windowsToWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\a.sql'), '/home/me/a.sql');
});
check('adaptPath 按目标环境转换', () => {
  assert.strictEqual(paths.adaptPath('C:\\x\\y.pem', 'wsl'), '/mnt/c/x/y.pem');
  assert.strictEqual(paths.adaptPath('/mnt/c/x/y.pem', 'windows'), 'C:\\x\\y.pem');
});
check('路径兼容性提示', () => {
  const hint = paths.pathCompatibilityHint('C:\\certs\\ca.pem', { isWSL: true, family: 'linux' });
  assert.ok(!hint || hint.includes('/mnt/c'));
});

console.log('\n=== 4. SQL 文本处理 ===');
check('基础多语句拆分', () => {
  assert.deepStrictEqual(sqlText.splitStatements('SELECT 1; SELECT 2'), ['SELECT 1', 'SELECT 2']);
});
check('字符串内的分号不拆分', () => {
  assert.strictEqual(sqlText.splitStatements("SELECT ';';").length, 1);
});
check('注释内的分号不拆分', () => {
  assert.strictEqual(sqlText.splitStatements('SELECT 1 -- a;b\n;').length, 1);
  assert.strictEqual(sqlText.splitStatements('SELECT 1 /* a;b */;').length, 1);
});
check('PG 美元引用块不拆分', () => {
  const sql = 'CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END; $$ LANGUAGE plpgsql;';
  assert.strictEqual(sqlText.splitStatements(sql).length, 1);
});
check('转义引号处理', () => {
  assert.strictEqual(sqlText.splitStatements("SELECT 'it''s;ok';").length, 1);
});
check('危险语句识别', () => {
  assert.ok(sqlText.isDestructiveStatement('DELETE FROM t'));
  assert.ok(sqlText.isDestructiveStatement('/* c */ UPDATE t SET a=1'));
  assert.ok(!sqlText.isDestructiveStatement('SELECT * FROM t'));
  assert.ok(!sqlText.isDestructiveStatement('SELECT update_count FROM t'));
});
check('标识符转义', () => {
  assert.strictEqual(sqlText.quoteMysqlIdent('we`ird'), '`we``ird`');
  assert.strictEqual(sqlText.quotePgIdent('we"ird'), '"we""ird"');
});
check('值序列化：BigInt / Date / Buffer / 嵌套', () => {
  assert.strictEqual(sqlText.sanitizeValue(10n), '10');
  assert.strictEqual(sqlText.sanitizeValue(new Date('2024-01-02T03:04:05Z')), '2024-01-02T03:04:05.000Z');
  assert.strictEqual(sqlText.sanitizeValue(Buffer.from([1, 2])), '0x0102');
  assert.deepStrictEqual(sqlText.sanitizeValue([1n, null]), ['1', null]);
  assert.strictEqual(sqlText.sanitizeValue(undefined), null);
});
check('JSON 序列化不抛错', () => {
  const row = sqlText.sanitizeRow({ a: 1n, b: Buffer.from('x'), c: { d: new Date(0) } });
  assert.doesNotThrow(() => JSON.stringify(row));
});

console.log('\n=== 5. 驱动注册表 ===');
const registry = new DriverRegistry();
registerBuiltinDrivers(registry);
const definitions = registry.list();
console.log(`  已注册驱动: ${definitions.map((d) => d.id).join(', ')}`);
check('内置驱动已注册', () => {
  assert.ok(registry.has('mysql'));
  assert.ok(registry.has('postgresql'));
});
check('别名可解析', () => {
  assert.strictEqual(registry.resolveId('mariadb'), 'mysql');
  assert.strictEqual(registry.resolveId('postgres'), 'postgresql');
  assert.strictEqual(registry.resolveId('PG'), 'postgresql');
});
check('驱动实例可创建且能力声明合法', () => {
  for (const id of ['mysql', 'postgresql']) {
    const driver = registry.create(id);
    assert.strictEqual(driver.isConnected(), false);
    assert.deepStrictEqual(registry.validate(driver), []);
  }
});
check('MySQL 不声明 schema 层级，PG 声明', () => {
  assert.strictEqual(registry.definition('mysql').capabilities.schemas, false);
  assert.strictEqual(registry.definition('postgresql').capabilities.schemas, true);
});
check('重复注册被拒绝', () => {
  assert.throws(() => registerBuiltinDrivers(registry), /已注册/);
});
check('未知驱动创建时给出明确错误', () => {
  assert.throws(() => registry.create('oracle'), /未找到驱动/);
});
check('previewSql 使用各驱动正确的标识符风格', () => {
  const mysql = registry.create('mysql');
  const pg = registry.create('postgresql');
  assert.ok(mysql.previewSql({ database: 'app', table: 'users' }, 10).includes('`app`.`users`'));
  assert.ok(pg.previewSql({ schema: 'public', table: 'users' }, 10).includes('"public"."users"'));
});
check('能力声明与实现不一致时 validate 报出问题', () => {
  const broken = {
    id: 'broken',
    displayName: '坏驱动',
    defaultPort: 0,
    capabilities: { columns: true, schemas: true, ddl: true, multiStatement: false, editable: true },
  };
  const problems = registry.validate(broken);
  for (const keyword of ['showCreateTable', 'updateCell', 'listColumns', 'listSchemas', '端口']) {
    assert.ok(
      problems.some((p) => p.includes(keyword)),
      `未报出 ${keyword} 相关的问题：${problems.join(' | ')}`,
    );
  }
});
check('不声明 schema 的驱动不要求 listSchemas', () => {
  const mysql = registry.create('mysql');
  // MySQL 用的是 database 而非 schema 层级，validate 不应因此报错
  assert.deepStrictEqual(registry.validate(mysql), []);
});

console.log('\n=== 6. 结果结构一致性 ===');
const { executeScript } = require(path.join(outDir, 'drivers', 'support.js'));
const editTarget = require(path.join(outDir, 'core', 'editTarget.js'));
const exporters = require(path.join(outDir, 'core', 'exporters.js'));
const zlib = require('zlib');

/** 造一个只实现本次测试所需方法的假驱动。 */
function fakeDriver(options) {
  const settings = Object.assign(
    {
      editable: true,
      schemas: false,
      columns: [{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true }],
      listColumns: undefined,
    },
    options,
  );
  return {
    id: settings.schemas ? 'postgresql' : 'mysql',
    displayName: 'fake',
    defaultPort: 0,
    capabilities: {
      columns: true,
      schemas: settings.schemas,
      ddl: true,
      multiStatement: true,
      editable: settings.editable,
    },
    async listColumns() {
      if (settings.listColumns) {
        return settings.listColumns();
      }
      return settings.columns;
    },
    updateCell: settings.editable
      ? async () => ({ sql: 'UPDATE t SET a = 1', affectedRows: 1 })
      : undefined,
  };
}

(async function main() {
  await checkAsync('executeScript 顺序执行并汇总耗时', async () => {
    const calls = [];
    const result = await executeScript('SELECT 1; SELECT 2', { limit: 10, timeoutMs: 1000 }, async (sql) => {
      calls.push(sql);
      return { statement: 'SELECT', fields: ['n'], rows: [{ n: 1 }], rowCount: 1 };
    });
    assert.deepStrictEqual(calls, ['SELECT 1', 'SELECT 2']);
    assert.strictEqual(result.sets.length, 2);
    assert.ok(typeof result.durationMs === 'number');
  });
  await checkAsync('空 SQL 抛出明确错误', async () => {
    await assert.rejects(
      () => executeScript('   ', { limit: 10, timeoutMs: 1000 }, async () => ({})),
      /SQL 为空/,
    );
  });

  console.log('\n=== 7. 单元格编辑目标推导 ===');
  check('FROM 子句解析：各种标识符风格', () => {
    assert.deepStrictEqual(editTarget.extractFromTable('SELECT * FROM users'), { table: 'users' });
    assert.deepStrictEqual(editTarget.extractFromTable('SELECT * FROM `app`.`users`'), {
      qualifier: 'app',
      table: 'users',
    });
    assert.deepStrictEqual(editTarget.extractFromTable('SELECT * FROM "public"."users"'), {
      qualifier: 'public',
      table: 'users',
    });
    assert.deepStrictEqual(editTarget.extractFromTable('SELECT * FROM [dbo].[users]'), {
      qualifier: 'dbo',
      table: 'users',
    });
    assert.deepStrictEqual(editTarget.extractFromTable('select *\nfrom\n  users\nlimit 10'), { table: 'users' });
  });
  check('注释与字符串里的 from 不会被误认', () => {
    assert.deepStrictEqual(editTarget.extractFromTable('SELECT * FROM users -- FROM other'), {
      table: 'users',
    });
    assert.deepStrictEqual(editTarget.extractFromTable("SELECT * FROM users WHERE name = 'from x'"), {
      table: 'users',
    });
    assert.deepStrictEqual(editTarget.extractFromTable('SELECT * /* from fake */ FROM users'), {
      table: 'users',
    });
  });
  check('子查询不作为目标表', () => {
    assert.strictEqual(editTarget.extractFromTable('SELECT * FROM (SELECT * FROM inner_t) x'), undefined);
  });

  await checkAsync('主键齐备时推导出可编辑目标', async () => {
    const driver = fakeDriver({});
    const target = await editTarget.resolveEditTarget(
      driver,
      'SELECT `id`, `name` FROM `app`.`users`',
      ['id', 'name'],
    );
    assert.ok(target, '未推导出编辑目标');
    assert.strictEqual(target.table, 'users');
    assert.strictEqual(target.database, 'app');
    assert.deepStrictEqual(target.identity, ['id']);
  });
  await checkAsync('PG 的两段式解析为 schema', async () => {
    const driver = fakeDriver({ schemas: true });
    const target = await editTarget.resolveEditTarget(driver, 'SELECT * FROM "public"."users"', ['id']);
    assert.ok(target);
    assert.strictEqual(target.schema, 'public');
    assert.strictEqual(target.database, undefined);
  });
  await checkAsync('fallback 目标优先于正则推导', async () => {
    const driver = fakeDriver({});
    const target = await editTarget.resolveEditTarget(driver, 'SELECT 1', ['id'], {
      database: 'app',
      table: 'orders',
    });
    assert.ok(target);
    assert.strictEqual(target.table, 'orders');
  });
  await checkAsync('主键不在结果列中则拒绝编辑', async () => {
    const driver = fakeDriver({});
    const target = await editTarget.resolveEditTarget(driver, 'SELECT * FROM users', ['name', 'email']);
    assert.strictEqual(target, undefined);
  });
  await checkAsync('无主键则拒绝编辑', async () => {
    const driver = fakeDriver({
      columns: [{ name: 'name', dataType: 'text', nullable: true }],
    });
    const target = await editTarget.resolveEditTarget(driver, 'SELECT * FROM users', ['name']);
    assert.strictEqual(target, undefined);
  });
  await checkAsync('驱动不支持编辑时直接拒绝', async () => {
    const driver = fakeDriver({ editable: false });
    const target = await editTarget.resolveEditTarget(driver, 'SELECT * FROM users', ['id']);
    assert.strictEqual(target, undefined);
  });
  await checkAsync('非 SELECT 语句不提供编辑', async () => {
    const driver = fakeDriver({});
    assert.strictEqual(
      await editTarget.resolveEditTarget(driver, 'UPDATE users SET name = 1', ['id']),
      undefined,
    );
    assert.strictEqual(
      await editTarget.resolveEditTarget(driver, 'WITH x AS (SELECT 1) SELECT * FROM x', ['id']),
      undefined,
    );
  });
  await checkAsync('元数据读取失败只降级为只读，不抛错', async () => {
    const driver = fakeDriver({
      listColumns: async () => {
        throw new Error('permission denied');
      },
    });
    const target = await editTarget.resolveEditTarget(driver, 'SELECT * FROM users', ['id']);
    assert.strictEqual(target, undefined);
  });

  console.log('\n=== 8. 导出序列化 ===');
  const demoRows = [
    { id: 1, name: '张三', note: null },
    { id: 2, name: 'a,b"c', note: 'x\ny' },
  ];
  check('CSV：BOM + RFC4180 转义', () => {
    const payload = exporters.serializeResult('csv', ['id', 'name', 'note'], demoRows);
    assert.strictEqual(payload.extension, 'csv');
    assert.ok(payload.data.startsWith('\uFEFF'), '缺少 BOM，Excel 会乱码');
    assert.ok(payload.data.includes('"a,b""c"'), '逗号与引号未转义');
    assert.ok(payload.data.includes('"x\ny"'), '换行未转义');
    assert.ok(payload.data.split('\r\n').length === 3);
  });
  check('JSONL：每行一个对象且以换行结尾', () => {
    const payload = exporters.serializeResult('jsonl', ['id', 'name'], demoRows);
    assert.strictEqual(payload.extension, 'jsonl');
    assert.ok(payload.data.endsWith('\n'));
    const lines = payload.data.trimEnd().split('\n');
    assert.strictEqual(lines.length, 2);
    for (const line of lines) {
      assert.deepStrictEqual(Object.keys(JSON.parse(line)), ['id', 'name'], '键顺序应与列顺序一致');
    }
  });
  check('JSON：数组 + 缩进', () => {
    const payload = exporters.serializeResult('json', ['id'], demoRows);
    assert.strictEqual(payload.extension, 'json');
    assert.strictEqual(JSON.parse(payload.data).length, 2);
  });
  check('XLSX：是合法 ZIP 且内含工作表数据', () => {
    const payload = exporters.serializeResult('xlsx', ['id', 'name'], demoRows, '结果/1');
    assert.strictEqual(payload.extension, 'xlsx');
    assert.ok(Buffer.isBuffer(payload.data), 'XLSX 必须是二进制');
    assert.strictEqual(payload.data.readUInt32LE(0), 0x04034b50, '缺少 ZIP 本地文件头');

    const sheet = readZipEntry(payload.data, 'xl/worksheets/sheet1.xml').toString('utf8');
    assert.ok(sheet.includes('张三'), '工作表缺少数据');
    // 单元格带样式索引（s=2 表体 / s=3 斑马纹），因此只校验值与类型，不锁死属性串
    assert.ok(/<c r="A2"[^>]*><v>1<\/v><\/c>/.test(sheet), '数字未按数值写入');
    assert.ok(sheet.includes('xml:space="preserve"'), '文本单元格应保留空白');

    const workbook = readZipEntry(payload.data, 'xl/workbook.xml').toString('utf8');
    assert.ok(workbook.includes('结果_1'), '非法工作表名未被替换');
    // OOXML 必需的固定成员都必须在包里
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml']) {
      assert.ok(readZipEntry(payload.data, name), `缺少 ${name}`);
    }
  });
  check('XLSX：冻结首行 + 自动筛选 + 列宽自适应', () => {
    const payload = exporters.serializeResult('xlsx', ['id', '名称'], demoRows);
    const sheet = readZipEntry(payload.data, 'xl/worksheets/sheet1.xml').toString('utf8');
    assert.ok(sheet.includes('state="frozen"'), '表头未冻结');
    assert.ok(sheet.includes('<autoFilter ref="A1:B3"/>'), `自动筛选区域不对：${sheet.match(/<autoFilter[^>]*>/)}`);
    assert.ok(/<col min="2" max="2" width="\d+" customWidth="1"\/>/.test(sheet), '缺少列宽声明');

    // cols 必须排在 sheetData 之前、autoFilter 必须在其后，否则 Excel 判文件损坏
    assert.ok(sheet.indexOf('<cols>') < sheet.indexOf('<sheetData>'), 'cols 顺序错误');
    assert.ok(sheet.indexOf('</sheetData>') < sheet.indexOf('<autoFilter'), 'autoFilter 顺序错误');
  });
  check('XLSX：样式表含表头/表体/斑马纹四档', () => {
    const payload = exporters.serializeResult('xlsx', ['id'], demoRows);
    const styles = readZipEntry(payload.data, 'xl/styles.xml').toString('utf8');
    assert.ok(styles.includes('<cellXfs count="4">'), 'cellXfs 档位数量不对');
    // fills 前两项必须是 none / gray125，业务填充从索引 2 起（ECMA-376 强制）
    assert.ok(
      styles.indexOf('patternType="none"') < styles.indexOf('patternType="gray125"'),
      'fills 保留项顺序错误',
    );
    assert.ok(styles.includes('<fills count="4">'), '缺少表头与斑马纹填充');
    // 导出必须复现一次同样的字节，否则说明混入了时间戳之类的不确定量
    assert.ok(
      exporters.serializeResult('xlsx', ['id'], demoRows).data.equals(payload.data),
      'XLSX 输出不可复现',
    );
  });
  check('XLSX：空结果集不生成自动筛选', () => {
    const sheet = readZipEntry(
      exporters.serializeResult('xlsx', ['a', 'b'], []).data,
      'xl/worksheets/sheet1.xml',
    ).toString('utf8');
    assert.ok(!sheet.includes('<autoFilter'), '空结果集不应有筛选区域');
    assert.ok(sheet.includes('state="frozen"'), '空结果集也应冻结表头');
  });
  check('XLSX：控制字符被剔除且 XML 正确转义', () => {
    const payload = exporters.serializeResult('xlsx', ['v'], [{ v: 'a<b>&"\u0007' }]);
    const sheet = readZipEntry(payload.data, 'xl/worksheets/sheet1.xml').toString('utf8');
    assert.ok(sheet.includes('a&lt;b&gt;&amp;&quot;'), 'XML 未转义');
    assert.ok(!sheet.includes('\u0007'), 'XML 1.0 非法控制字符未剔除');
  });
  check('工作表名长度与非法字符规范化', () => {
    assert.strictEqual(exporters.sanitizeSheetName('a/b:c*d?e[f]'), 'a_b_c_d_e_f_');
    assert.strictEqual(exporters.sanitizeSheetName('').length, 6);
    assert.strictEqual(exporters.sanitizeSheetName('x'.repeat(50)).length, 31);
  });
  check('列号换算', () => {
    assert.strictEqual(exporters.columnName(0), 'A');
    assert.strictEqual(exporters.columnName(25), 'Z');
    assert.strictEqual(exporters.columnName(26), 'AA');
    assert.strictEqual(exporters.columnName(701), 'ZZ');
    assert.strictEqual(exporters.columnName(702), 'AAA');
  });
  check('SQL 字面量转义杜绝注入', () => {
    assert.strictEqual(sqlText.toSqlLiteral("O'Brien", 'mysql'), "'O''Brien'");
    assert.strictEqual(sqlText.toSqlLiteral("O'Brien", 'postgresql'), "'O''Brien'");
    assert.strictEqual(sqlText.toSqlLiteral(null, 'mysql'), 'NULL');
    assert.strictEqual(sqlText.toSqlLiteral(true, 'mysql'), '1');
    assert.strictEqual(sqlText.toSqlLiteral(true, 'postgresql'), 'TRUE');
    // 反斜杠必须先于单引号处理，否则 MySQL 下会被二次解释成转义
    const evil = "\\'; DROP TABLE t; --";
    assert.strictEqual(sqlText.toSqlLiteral(evil, 'mysql'), "'\\\\''; DROP TABLE t; --'");
    assert.strictEqual(sqlText.toSqlLiteral(evil, 'postgresql'), "'\\''; DROP TABLE t; --'");
  });

  // ---------------------------------------------------------------- 备份

  console.log('\n=== 9. 备份：字面量保真 ===');
  const backupCore = require(path.join(outDir, 'core', 'backup.js'));
  const backupChunkCore = require(path.join(outDir, 'drivers', 'backupCore.js'));
  const externalTool = require(path.join(outDir, 'platform', 'externalTool.js'));
  const definitions = require(path.join(outDir, 'drivers', 'definitions.js'));

  check('MySQL 字面量：NULL / 布尔 / 数字 / 大整数', () => {
    assert.strictEqual(sqlText.toBackupLiteral(null, 'mysql'), 'NULL');
    assert.strictEqual(sqlText.toBackupLiteral(undefined, 'mysql'), 'NULL');
    assert.strictEqual(sqlText.toBackupLiteral(true, 'mysql'), '1');
    assert.strictEqual(sqlText.toBackupLiteral(false, 'mysql'), '0');
    assert.strictEqual(sqlText.toBackupLiteral(42, 'mysql'), '42');
    // 超出 Number 精度的大整数必须原样输出，不能被科学计数法改写
    assert.strictEqual(sqlText.toBackupLiteral(9007199254740993n, 'mysql'), '9007199254740993');
  });

  check('PG 字面量：布尔用 TRUE / FALSE', () => {
    assert.strictEqual(sqlText.toBackupLiteral(true, 'postgresql'), 'TRUE');
    assert.strictEqual(sqlText.toBackupLiteral(false, 'postgresql'), 'FALSE');
  });

  check('字面量转义遵循方言（含注入防护）', () => {
    const evil = "\\'; DROP TABLE t; --";
    assert.strictEqual(sqlText.toBackupLiteral(evil, 'mysql'), "'\\\\''; DROP TABLE t; --'");
    assert.strictEqual(sqlText.toBackupLiteral(evil, 'postgresql'), "'\\''; DROP TABLE t; --'");
  });

  check('二进制按十六进制写入，不被 toString 毁掉', () => {
    const buffer = Buffer.from([0x48, 0x69]);
    assert.strictEqual(sqlText.toBackupLiteral(buffer, 'mysql'), "X'4869'");
    assert.strictEqual(sqlText.toBackupLiteral(buffer, 'postgresql'), "'\\x4869'::bytea");
  });

  check('日期渲染为本地时刻，保留毫秒', () => {
    const date = new Date(2026, 8, 18, 14, 50, 3, 123);
    assert.strictEqual(sqlText.toBackupLiteral(date, 'mysql'), "'2026-09-18 14:50:03.123'");
  });

  check('PG 数组用数组字面量，含逗号的元素不被拆列', () => {
    assert.strictEqual(sqlText.toBackupLiteral([1, 2], 'postgresql'), '\'{"1","2"}\'');
    assert.strictEqual(sqlText.pgArrayLiteral(['a,b', 'c"d']), '{"a,b","c\\"d"}');
    assert.strictEqual(sqlText.pgArrayLiteral([null]), '{NULL}');
    // 嵌套数组外层不能再加引号，否则 PG 会解析成一维
    assert.strictEqual(sqlText.pgArrayLiteral([[1, 2], [3, 4]]), '{{"1","2"},{"3","4"}}');
  });

  check('对象按 JSON 文本写入', () => {
    assert.strictEqual(sqlText.toBackupLiteral({ a: 1 }, 'mysql'), '\'{"a":1}\'');
    assert.strictEqual(sqlText.toBackupLiteral([1, 2], 'mysql'), "'[1,2]'");
  });

  console.log('\n=== 10. 备份：方式元数据 ===');
  check('内置驱动的备份方式声明自洽', () => {
    for (const definition of definitions.BUILTIN_DEFINITIONS) {
      assert.deepStrictEqual(
        definitions.validateBackupMetadata(definition),
        [],
        `${definition.id} 的备份元数据有问题`,
      );
      assert.ok(definition.capabilities.backup, `${definition.id} 未声明支持备份`);
      const ids = definition.backupModes.map((mode) => mode.id);
      for (const id of ['sql', 'schema', 'data', 'native']) {
        assert.ok(ids.includes(id), `${definition.id} 缺少备份方式 ${id}`);
      }
    }
  });

  check('validate 拦住「声明支持备份却没实现 backupChunks」', () => {
    const problems = registry.validate({
      id: 'half',
      displayName: '半成品',
      defaultPort: 1,
      capabilities: {
        columns: true,
        schemas: false,
        ddl: true,
        multiStatement: true,
        editable: true,
        manageDatabase: true,
        manageUser: true,
        backup: true,
      },
      listColumns: () => [],
      showCreateTable: () => undefined,
      updateCell: () => undefined,
    });
    assert.ok(problems.some((p) => p.includes('backupChunks')), problems.join(' | '));
  });

  check('表节点入口不出现整库专用的备份方式', () => {
    const modes = definitions.MYSQL_DEFINITION.backupModes;
    const ids = (entry) => backupCore.filterBackupModesForScope(modes, entry).map((mode) => mode.id);
    assert.deepStrictEqual(ids('tables'), ['sql', 'schema', 'data']);
    assert.deepStrictEqual(ids('database'), ['sql', 'schema', 'data', 'native']);
    // schema 是库的下一级，原生工具的「整库」语义套不上
    assert.deepStrictEqual(ids('schema'), ['sql', 'schema', 'data']);
  });

  console.log('\n=== 11. 备份：范围收集 ===');
  check('多选时按命名空间去重', () => {
    const result = backupCore.collectBackupTargets([
      { kind: 'table', profileId: 'p1', database: 'shop', table: 'orders', tableKind: 'table' },
      { kind: 'table', profileId: 'p1', database: 'shop', table: 'orders', tableKind: 'table' },
      { kind: 'table', profileId: 'p1', database: 'shop', table: 'v1', tableKind: 'view' },
    ]);
    assert.strictEqual(result.problem, undefined);
    assert.strictEqual(result.profileId, 'p1');
    assert.deepStrictEqual(result.targets.map((t) => t.table), ['orders', 'v1']);
    assert.strictEqual(result.targets[1].kind, 'view');
  });

  check('不同 schema 下的同名表不会被误去重', () => {
    const result = backupCore.collectBackupTargets([
      { kind: 'table', profileId: 'p1', schema: 'a', table: 't' },
      { kind: 'table', profileId: 'p1', schema: 'b', table: 't' },
    ]);
    assert.strictEqual(result.targets.length, 2);
  });

  check('跨连接多选被拒绝', () => {
    const result = backupCore.collectBackupTargets([
      { kind: 'table', profileId: 'p1', database: 'd', table: 't' },
      { kind: 'table', profileId: 'p2', database: 'd', table: 'u' },
    ]);
    assert.strictEqual(result.targets.length, 0);
    assert.ok(result.problem.includes('不同连接'), result.problem);
  });

  check('未选中表 / 只选了列节点都给出明确提示', () => {
    assert.ok(backupCore.collectBackupTargets([]).problem.includes('没有选中'));
    assert.ok(
      backupCore.collectBackupTargets([{ kind: 'column', profileId: 'p1', table: 't' }]).problem.includes(
        '没有选中',
      ),
    );
  });

  check('listTables 的结果可转成备份目标', () => {
    const targets = backupCore.toBackupTargets(
      { database: 'shop' },
      [
        { name: 'orders', schema: 'shop', kind: 'table' },
        { name: 'v1', schema: 'shop', kind: 'view' },
      ],
    );
    assert.deepStrictEqual(targets[0], { database: 'shop', schema: 'shop', table: 'orders', kind: 'table' });
    assert.strictEqual(targets[1].kind, 'view');
  });

  console.log('\n=== 12. 备份：文件名与文件头 ===');
  check('文件名过滤非法字符并附时间戳', () => {
    const name = backupCore.buildBackupFileName({
      base: 'a/b:c*d?e"f<g>h|i',
      mode: { extension: 'sql' },
      now: new Date(2026, 8, 18, 14, 50, 3),
    });
    assert.strictEqual(name, 'a_b_c_d_e_f_g_h_i-20260918-145003.sql');
  });

  check('不会拼出隐藏文件，空名有兜底', () => {
    assert.strictEqual(backupCore.sanitizeFileName('...hidden'), 'hidden');
    assert.strictEqual(backupCore.sanitizeFileName('   '), 'backup');
  });

  check('文件头写清范围、方式、生成器与注意事项', () => {
    const header = backupCore.buildBackupHeader({
      connectionName: '本地',
      driverName: 'MySQL / MariaDB',
      scope: '数据库 shop',
      modeLabel: '完整 SQL（结构 + 数据）',
      tableCount: 3,
      viewCount: 1,
      generator: 'DBViewer 内置导出（逐表 SELECT）',
      notes: ['不含 DROP 语句'],
      now: new Date(2026, 8, 18, 14, 50, 3),
    });
    for (const keyword of [
      '数据库 shop',
      '完整 SQL',
      '2026-09-18 14:50:03',
      '3 张表 / 1 个视图',
      '不含 DROP 语句',
    ]) {
      assert.ok(header.includes(keyword), `文件头缺少「${keyword}」`);
    }
    assert.ok(header.startsWith('--'), '文件头必须是注释，直接执行才不会报错');
  });

  console.log('\n=== 13. 备份：原生工具参数 ===');
  check('参数模板逐个取值，不与其他参数粘连', () => {
    const args = externalTool.expandNativeArgs(
      ['--host=${host}', '--port=${port}', '--dbname=${database}', '--tables=${tables}'],
      { host: '10.0.0.1', port: 3306, user: 'root', database: 'shop', tables: [] },
    );
    assert.deepStrictEqual(args, ['--host=10.0.0.1', '--port=3306', '--dbname=shop', '--tables=']);
  });

  check('单独成项的 ${tables} 展开为多个独立参数', () => {
    const args = externalTool.expandNativeArgs(['${database}', '${tables}'], {
      host: 'h',
      port: 1,
      user: 'u',
      database: 'shop',
      tables: ['a', 'b'],
    });
    assert.deepStrictEqual(args, ['shop', 'a', 'b']);
  });

  await checkAsync('参数含空字节时拒绝启动进程', async () => {
    await assert.rejects(
      externalTool.runExternalTool({ command: 'dbviewer-no-such-tool', args: ['a\u0000b'], timeoutMs: 1000 }),
      /空字节/,
    );
  });

  await checkAsync('命令不存在时提示可操作的原因', async () => {
    await assert.rejects(
      externalTool.runExternalTool({
        command: 'dbviewer-definitely-missing-tool',
        args: [],
        timeoutMs: 5000,
      }),
      /未找到命令/,
    );
  });

  console.log('\n=== 14. 备份：分块状态机 ===');
  /**
   * 造一个内存方言：表结构与数据都由测试给出，全程不碰数据库。
   * 这样状态机的分支（多表切换、分页、只导结构 / 只导数据、单表失败）都能被压到。
   */
  function fakeDialect(spec, counters) {
    const reads = [];
    return {
      reads,
      dialect: {
        generator: '测试',
        notes: [],
        prologue: 'SET NAMES utf8mb4;',
        qualify: (target) => `\`${target.database}\`.\`${target.table}\``,
        quoteIdent: (name) => `\`${name}\``,
        literal: (value) => sqlText.toBackupLiteral(value, 'mysql'),
        open: async () => {
          counters.opened += 1;
        },
        close: async () => {
          counters.closed += 1;
        },
        tableMeta: async (target) => spec[target.table].meta,
        createSql: async (target) => spec[target.table].ddl,
        readRows: async (params) => {
          const entry = spec[params.target.table];
          if (entry.failRead) {
            throw new Error(entry.failRead);
          }
          reads.push({ table: params.target.table, offset: params.offset, afterKey: params.afterKey });
          const rows = entry.rows;
          if (params.keyColumn) {
            const start =
              params.afterKey === undefined
                ? 0
                : rows.findIndex((row) => String(row[params.keyColumn]) === String(params.afterKey)) + 1;
            return rows.slice(start, start + params.limit);
          }
          return rows.slice(params.offset, params.offset + params.limit);
        },
      },
    };
  }

  const TABLES = [
    { database: 'shop', table: 'users', kind: 'table' },
    { database: 'shop', table: 'orders', kind: 'table' },
  ];
  const SQL_MODE = { id: 'sql', label: '完整', extension: 'sql', includesSchema: true, includesData: true };

  await checkAsync('分块导出：结构 + 数据齐全，游标最终收敛', async () => {
    const counters = { opened: 0, closed: 0 };
    const fake = fakeDialect(
      {
        users: {
          meta: { columns: ['id', 'name'], keyColumn: 'id' },
          ddl: 'CREATE TABLE `users` (`id` int);',
          rows: [{ id: 1, name: 'a' }, { id: 2, name: "b'c" }, { id: 3, name: null }],
        },
        orders: {
          meta: { columns: ['id'], keyColumn: 'id' },
          ddl: 'CREATE TABLE `orders` (`id` int);',
          rows: [{ id: 10 }],
        },
      },
      counters,
    );

    let cursor;
    let text = '';
    let rounds = 0;
    do {
      const chunk = await backupChunkCore.runBackupChunks(fake.dialect, SQL_MODE, {
        modeId: 'sql',
        tables: TABLES,
        cursor,
        chunkRows: 2,
        timeoutMs: 1000,
      });
      text += chunk.text;
      cursor = chunk.nextCursor ?? undefined;
      rounds += 1;
      assert.ok(rounds < 20, '游标没有推进，可能死循环');
    } while (cursor);

    assert.ok(text.includes('SET NAMES utf8mb4;'), '缺少序言');
    assert.ok(text.includes('CREATE TABLE `users`'));
    assert.ok(text.includes('CREATE TABLE `orders`'));
    assert.ok(text.includes('INSERT INTO `shop`.`users` (`id`, `name`) VALUES'));
    assert.ok(text.includes("(2, 'b''c')"), text);
    assert.ok(text.includes('(3, NULL)'));
    assert.ok(text.includes('INSERT INTO `shop`.`orders` (`id`) VALUES'));
    assert.strictEqual(counters.opened, 1, '备份连接应只开一次');
    assert.strictEqual(counters.closed, 1, '结束时应释放备份连接');
  });

  await checkAsync('keyset 分页：后续块带上上一行主键，而不是 OFFSET', async () => {
    const counters = { opened: 0, closed: 0 };
    const fake = fakeDialect(
      {
        users: {
          meta: { columns: ['id'], keyColumn: 'id' },
          ddl: 'CREATE TABLE `users` (`id` int);',
          rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
        },
      },
      counters,
    );
    const tables = [{ database: 'shop', table: 'users', kind: 'table' }];
    let cursor;
    do {
      const chunk = await backupChunkCore.runBackupChunks(fake.dialect, SQL_MODE, {
        modeId: 'sql',
        tables,
        cursor,
        chunkRows: 2,
        timeoutMs: 1000,
      });
      cursor = chunk.nextCursor ?? undefined;
    } while (cursor);

    assert.strictEqual(fake.reads.length, 2, `读取次数应为 2，实际 ${fake.reads.length}`);
    assert.strictEqual(fake.reads[0].afterKey, undefined);
    assert.strictEqual(String(fake.reads[1].afterKey), '2', '第二块应从上一次的最后一行之后继续');
    assert.deepStrictEqual(fake.reads.map((r) => r.offset), [0, 0], '有主键时不应退回 OFFSET');
  });

  await checkAsync('无单列主键时退回 OFFSET 分页', async () => {
    const counters = { opened: 0, closed: 0 };
    const fake = fakeDialect(
      {
        log: {
          meta: { columns: ['msg'] },
          ddl: 'CREATE TABLE `log` (`msg` text);',
          rows: [{ msg: 'a' }, { msg: 'b' }, { msg: 'c' }],
        },
      },
      counters,
    );
    let cursor;
    do {
      const chunk = await backupChunkCore.runBackupChunks(fake.dialect, SQL_MODE, {
        modeId: 'sql',
        tables: [{ database: 'shop', table: 'log', kind: 'table' }],
        cursor,
        chunkRows: 2,
        timeoutMs: 1000,
      });
      cursor = chunk.nextCursor ?? undefined;
    } while (cursor);
    assert.deepStrictEqual(fake.reads.map((r) => r.offset), [0, 2]);
  });

  await checkAsync('仅结构模式不读数据，仅数据模式不出建表语句', async () => {
    const counters = { opened: 0, closed: 0 };
    const spec = {
      users: {
        meta: { columns: ['id'], keyColumn: 'id' },
        ddl: 'CREATE TABLE `users` (`id` int);',
        rows: [{ id: 1 }],
      },
    };
    const tables = [{ database: 'shop', table: 'users', kind: 'table' }];

    const schemaOnly = fakeDialect(spec, counters);
    let chunk = await backupChunkCore.runBackupChunks(
      schemaOnly.dialect,
      { id: 'schema', label: '仅结构', extension: 'sql', includesSchema: true, includesData: false },
      { modeId: 'schema', tables, cursor: undefined, chunkRows: 10, timeoutMs: 1000 },
    );
    assert.strictEqual(chunk.nextCursor, null);
    assert.ok(chunk.text.includes('CREATE TABLE'));
    assert.ok(!chunk.text.includes('INSERT INTO'), '仅结构模式不应产生 INSERT');
    assert.strictEqual(schemaOnly.reads.length, 0);

    const dataOnly = fakeDialect(spec, counters);
    chunk = await backupChunkCore.runBackupChunks(
      dataOnly.dialect,
      { id: 'data', label: '仅数据', extension: 'sql', includesSchema: false, includesData: true },
      { modeId: 'data', tables, cursor: undefined, chunkRows: 10, timeoutMs: 1000 },
    );
    assert.ok(!chunk.text.includes('CREATE TABLE'), '仅数据模式不应出建表语句');
    assert.ok(chunk.text.includes('INSERT INTO'));
  });

  await checkAsync('视图只导定义，不导数据', async () => {
    const counters = { opened: 0, closed: 0 };
    const fake = fakeDialect(
      {
        v1: {
          meta: { columns: ['id'], keyColumn: undefined },
          ddl: 'CREATE VIEW `v1` AS SELECT 1;',
          rows: [{ id: 1 }],
        },
      },
      counters,
    );
    const chunk = await backupChunkCore.runBackupChunks(fake.dialect, SQL_MODE, {
      modeId: 'sql',
      tables: [{ database: 'shop', table: 'v1', kind: 'view' }],
      cursor: undefined,
      chunkRows: 10,
      timeoutMs: 1000,
    });
    assert.ok(chunk.text.includes('CREATE VIEW'), '视图定义应写入');
    assert.ok(!chunk.text.includes('INSERT INTO'), '视图不应产生 INSERT');
    assert.strictEqual(fake.reads.length, 0);
  });

  await checkAsync('单张表失败只跳过它，其余照常导出', async () => {
    const counters = { opened: 0, closed: 0 };
    const fake = fakeDialect(
      {
        users: {
          meta: { columns: ['id'], keyColumn: 'id' },
          ddl: 'CREATE TABLE `users` (`id` int);',
          rows: [],
          failRead: 'SELECT command denied to user',
        },
        orders: {
          meta: { columns: ['id'], keyColumn: 'id' },
          ddl: 'CREATE TABLE `orders` (`id` int);',
          rows: [{ id: 10 }],
        },
      },
      counters,
    );
    let cursor;
    let text = '';
    const skipped = [];
    do {
      const chunk = await backupChunkCore.runBackupChunks(fake.dialect, SQL_MODE, {
        modeId: 'sql',
        tables: TABLES,
        cursor,
        chunkRows: 5,
        timeoutMs: 1000,
      });
      text += chunk.text;
      skipped.push(...(chunk.skipped ?? []));
      cursor = chunk.nextCursor ?? undefined;
    } while (cursor);

    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(skipped[0].name, 'shop.users');
    assert.ok(skipped[0].reason.includes('denied'));
    assert.ok(text.includes('INSERT INTO `shop`.`orders`'), '另一张表应继续导出');
  });

  console.log('\n=== 15. 备份：编排与取消 ===');
  await checkAsync('分块写入 sink，进度与统计累计正确', async () => {
    const sink = new backupCore.MemorySink();
    const progress = [];
    const total = { tables: 2, rows: 0, bytes: 0, skipped: [], cancelled: false };
    const source = {
      calls: 0,
      async backupChunks(request) {
        this.calls += 1;
        const done = this.calls >= 2;
        return {
          text: `-- chunk ${this.calls}\n`,
          nextCursor: done ? null : 'cursor-1',
          progress: { rows: this.calls * 10, doneTables: this.calls, totalTables: 2 },
        };
      },
    };
    const result = await backupCore.runBackup({
      source,
      modeId: 'sql',
      tables: TABLES,
      sink,
      timeoutMs: 1000,
      onProgress: (info) => progress.push(info),
    });
    assert.strictEqual(result.bytes, `-- chunk 1\n-- chunk 2\n`.length);
    assert.strictEqual(result.rows, 20);
    assert.strictEqual(progress.length, 2);
    assert.strictEqual(sink.isClosed, true);
    assert.strictEqual(sink.isAborted, false);
    assert.strictEqual(sink.text, `-- chunk 1\n-- chunk 2\n`);
    assert.deepStrictEqual(total.skipped, []);
  });

  await checkAsync('取消时走 abort 而不是 close，避免留下半成品', async () => {
    const sink = new backupCore.MemorySink();
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const source = {
      async backupChunks() {
        // 模拟用户在第一块之后按了取消
        token.isCancellationRequested = true;
        return { text: '-- partial\n', nextCursor: 'more', progress: { rows: 1, doneTables: 1, totalTables: 2 } };
      },
    };
    const result = await backupCore.runBackup({
      source,
      modeId: 'sql',
      tables: TABLES,
      sink,
      timeoutMs: 1000,
      token,
    });
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(sink.isAborted, true);
    assert.strictEqual(sink.text, '', '中止后不应留下任何内容');
  });

  await checkAsync('驱动抛错时中止并向上抛出', async () => {
    const sink = new backupCore.MemorySink();
    const source = {
      async backupChunks() {
        throw new Error('连接被服务端中断');
      },
    };
    await assert.rejects(
      backupCore.runBackup({ source, modeId: 'sql', tables: TABLES, sink, timeoutMs: 1000 }),
      /服务端中断/,
    );
    // runBackup 自身不吞异常，清理由命令层负责；这里只要求错误原样抛出
    assert.strictEqual(sink.isClosed, false);
  });

  // ---------------------------------------------------------------- 表数据预览

  console.log('\n=== 16. 表数据预览：多选目标收集 ===');
  const tableTargets = require(path.join(outDir, 'core', 'tableTargets.js'));

  check('多选保序且同表去重', () => {
    const collected = tableTargets.collectTableDataTargets([
      { kind: 'table', profileId: 'p1', database: 'app', table: 'users' },
      { kind: 'table', profileId: 'p1', database: 'app', table: 'orders' },
      { kind: 'table', profileId: 'p1', database: 'app', table: 'users' },
    ]);
    assert.strictEqual(collected.problem, undefined);
    assert.deepStrictEqual(collected.targets.map((t) => t.table), ['users', 'orders']);
    assert.strictEqual(collected.targets[0].kind, 'table');
  });

  check('同名表来自不同库 / schema / 连接时各自保留', () => {
    const collected = tableTargets.collectTableDataTargets([
      { kind: 'table', profileId: 'p1', database: 'app', table: 'users' },
      { kind: 'table', profileId: 'p1', database: 'shop', table: 'users' },
      { kind: 'table', profileId: 'p1', schema: 'public', table: 'users' },
      { kind: 'table', profileId: 'p2', database: 'app', table: 'users' },
    ]);
    assert.strictEqual(collected.targets.length, 4, '命名空间或连接不同就不该被去重');
  });

  check('视图节点同样可开窗，并保真 kind', () => {
    const collected = tableTargets.collectTableDataTargets([
      { kind: 'table', profileId: 'p1', schema: 'public', table: 'v1', tableKind: 'view' },
    ]);
    assert.strictEqual(collected.targets[0].kind, 'view');
  });

  check('非表节点与缺 profileId 的节点被忽略，全无效时给出提示', () => {
    const mixed = tableTargets.collectTableDataTargets([
      { kind: 'column', profileId: 'p1', table: 'users' },
      { kind: 'database', profileId: 'p1', database: 'app' },
      { kind: 'table', database: 'app', table: 'users' },
      { kind: 'table', profileId: 'p1', database: 'app', table: 'orders' },
    ]);
    assert.deepStrictEqual(mixed.targets.map((t) => t.table), ['orders']);
    assert.ok(
      tableTargets.collectTableDataTargets([{ kind: 'column', profileId: 'p1', table: 't' }]).problem.includes(
        '没有选中',
      ),
    );
  });

  check('窗口标题 = 库名.表名，schema 优先且不留前导点', () => {
    assert.strictEqual(tableTargets.tableDataPanelTitle({ database: 'app', table: 'users' }), 'app.users');
    assert.strictEqual(tableTargets.tableDataPanelTitle({ schema: 'public', table: 'users' }), 'public.users');
    assert.strictEqual(
      tableTargets.tableDataPanelTitle({ database: 'app', schema: 'public', table: 'users' }),
      'public.users',
    );
    assert.strictEqual(tableTargets.tableDataPanelTitle({ table: 'users' }), 'users');
  });

  check('复用键含连接与命名空间', () => {
    const key = (target) => tableTargets.tableDataPanelKey(target);
    assert.strictEqual(
      key({ profileId: 'p1', database: 'app', table: 'users' }),
      key({ profileId: 'p1', database: 'app', table: 'users' }),
    );
    assert.notStrictEqual(
      key({ profileId: 'p1', database: 'app', table: 'users' }),
      key({ profileId: 'p2', database: 'app', table: 'users' }),
    );
    assert.notStrictEqual(
      key({ profileId: 'p1', schema: 'a', table: 't' }),
      key({ profileId: 'p1', schema: 'b', table: 't' }),
    );
  });

  console.log('\n=== 17. 结构变更：差异计算与校验 ===');
  const objectEditor = require(path.join(outDir, 'core', 'objectEditor.js'));

  /** 造一列；测试里只关心被显式覆盖的字段。 */
  const col = (over) =>
    Object.assign(
      { name: 'c', dataType: 'int', nullable: true, defaultValue: null, comment: '', isPrimaryKey: false, autoIncrement: false },
      over || {},
    );
  const sameAll = (a, b) =>
    a.dataType === b.dataType &&
    a.nullable === b.nullable &&
    objectEditor.normalizeDefaultText(a.defaultValue) === objectEditor.normalizeDefaultText(b.defaultValue) &&
    (a.comment || '') === (b.comment || '');

  check('类型文本归一：忽略大小写与括号空白', () => {
    assert.strictEqual(
      objectEditor.normalizeTypeText('  INT ( 11 ) '),
      objectEditor.normalizeTypeText('int(11)'),
    );
    assert.strictEqual(objectEditor.normalizeTypeText('DECIMAL( 10 , 2 )'), 'decimal(10,2)');
  });

  check('默认值归一：空串与「无默认值」不能混为一谈', () => {
    assert.strictEqual(objectEditor.normalizeDefaultText(null), '');
    assert.strictEqual(objectEditor.normalizeDefaultText(undefined), '');
    assert.strictEqual(objectEditor.normalizeDefaultText("'abc'"), 'abc');
    // MariaDB 带引号、MySQL 不带引号，归一后必须相等，否则每次保存都会白生成 ALTER
    assert.strictEqual(objectEditor.normalizeDefaultText("'abc'"), objectEditor.normalizeDefaultText('abc'));
    assert.strictEqual(objectEditor.normalizeDefaultText("''"), "''");
    assert.notStrictEqual(objectEditor.normalizeDefaultText("''"), objectEditor.normalizeDefaultText(null));
  });

  check('列差异：认列靠 originalName，改名不算删旧增新', () => {
    const diff = objectEditor.diffTableColumns(
      [col({ name: 'a' }), col({ name: 'b' })],
      [col({ name: 'a2', originalName: 'a' }), col({ name: 'b', originalName: 'b' })],
      sameAll,
    );
    assert.strictEqual(diff.steps[0].renamed, true);
    assert.strictEqual(diff.steps[0].modified, false, '仅改名不该判成定义变更');
    assert.deepStrictEqual(diff.dropped, [], '改名被误判为删列');
  });

  check('列差异：类型 / 可空 / 默认值 / 注释变化都算 modified', () => {
    const origin = [col({ name: 'a', dataType: 'int', nullable: false, defaultValue: '1', comment: '旧' })];
    const diff = objectEditor.diffTableColumns(
      origin,
      [col({ name: 'a', originalName: 'a', dataType: 'bigint', nullable: true, defaultValue: '2', comment: '新' })],
      sameAll,
    );
    assert.strictEqual(diff.steps[0].modified, true);
  });

  check('列差异：列序变化只在既有列之间判定，纯新增不算重排', () => {
    const origin = [col({ name: 'a' }), col({ name: 'b' })];
    const reordered = objectEditor.diffTableColumns(
      origin,
      [col({ name: 'b', originalName: 'b' }), col({ name: 'a', originalName: 'a' })],
      sameAll,
      true,
    );
    assert.strictEqual(reordered.orderChanged, true);
    assert.strictEqual(reordered.steps[0].reposition, true);
    assert.strictEqual(reordered.steps[0].after, undefined, '首列没有前驱');

    const appended = objectEditor.diffTableColumns(origin, [col({ name: 'a', originalName: 'a' }), col({ name: 'b', originalName: 'b' }), col({ name: 'c' })], sameAll, true);
    assert.strictEqual(appended.orderChanged, false, '纯新增被误判成整表重排');
    assert.strictEqual(appended.steps[2].reposition, true, '新增列必须落到目标位置');
    assert.strictEqual(appended.steps[2].after, 'b');
  });

  check('列差异：不支持调序时不产生位置子句', () => {
    const diff = objectEditor.diffTableColumns(
      [col({ name: 'a' }), col({ name: 'b' })],
      [col({ name: 'b', originalName: 'b' }), col({ name: 'a', originalName: 'a' })],
      sameAll,
      false,
    );
    assert.strictEqual(diff.orderChanged, true, '仍要能提示用户「顺序改动被忽略」');
    assert.strictEqual(diff.steps[0].reposition, false);
  });

  check('列差异：未带回 originalName 的列一律按新增处理', () => {
    const diff = objectEditor.diffTableColumns([col({ name: 'a' })], [col({ name: 'a' })], sameAll);
    assert.strictEqual(diff.steps[0].origin, undefined);
    assert.strictEqual(diff.dropped.length, 1);
  });

  check('变更摘要覆盖新增 / 改名 / 修改 / 删除 / 调序', () => {
    const diff = objectEditor.diffTableColumns(
      [col({ name: 'a' }), col({ name: 'gone' }), col({ name: 'm', dataType: 'int' })],
      [col({ name: 'r', originalName: 'a' }), col({ name: 'm', originalName: 'm', dataType: 'bigint' }), col({ name: 'n' })],
      sameAll,
      true,
    );
    const lines = objectEditor.summarizeColumnsDiff(diff);
    assert.ok(lines.some((l) => l.includes('重命名列 a → r')), lines.join('|'));
    assert.ok(lines.some((l) => l.includes('修改列 m')), lines.join('|'));
    assert.ok(lines.some((l) => l.includes('新增列 n')), lines.join('|'));
    assert.ok(lines.some((l) => l.includes('删除列 gone')), lines.join('|'));
  });

  check('主键差异：重命名列上的主键不算换主键', () => {
    const same = objectEditor.diffPrimaryKey(
      [col({ name: 'id', isPrimaryKey: true })],
      [col({ name: 'uid', originalName: 'id', isPrimaryKey: true })],
    );
    assert.strictEqual(same.changed, false);
    assert.deepStrictEqual(same.target, ['uid']);
  });

  check('主键差异：增删列都能识别', () => {
    const added = objectEditor.diffPrimaryKey(
      [col({ name: 'a' })],
      [col({ name: 'a', isPrimaryKey: true })],
    );
    assert.strictEqual(added.changed, true);
    assert.deepStrictEqual(added.added, ['a']);

    const removed = objectEditor.diffPrimaryKey(
      [col({ name: 'a', isPrimaryKey: true }), col({ name: 'b', isPrimaryKey: true })],
      [col({ name: 'a', originalName: 'a', isPrimaryKey: true }), col({ name: 'b', originalName: 'b' })],
    );
    assert.strictEqual(removed.changed, true);
    assert.deepStrictEqual(removed.removed, ['b']);
  });

  check('属性差异：只比较可编辑且被提交的键', () => {
    const current = [
      { key: 'name', label: '表名', value: 'users', kind: 'text' },
      { key: 'engine', label: '存储引擎', value: 'InnoDB', kind: 'text' },
      { key: 'collation', label: '排序规则', value: 'utf8mb4_general_ci', kind: 'text' },
      { key: 'ro', label: '只读项', value: 'x', kind: 'text', editable: false },
    ];
    const changes = objectEditor.diffProperties(current, { engine: 'MyISAM', name: 'users', ro: 'y' });
    assert.deepStrictEqual(changes.map((c) => c.key), ['engine']);
    assert.strictEqual(objectEditor.propertyChangeValue(changes, 'engine'), 'MyISAM');
    // 未提交的键不能被当成「改成空」
    assert.strictEqual(objectEditor.propertyChangeValue(changes, 'collation'), undefined);
  });

  check('列定义校验：空表 / 空列名 / 重名（不分大小写）/ 空类型', () => {
    assert.ok(objectEditor.validateColumnDefinitions([]).includes('至少'));
    assert.ok(objectEditor.validateColumnDefinitions([col({ name: '  ' })]).includes('列名'));
    assert.ok(objectEditor.validateColumnDefinitions([col({ name: 'A' }), col({ name: 'a' })]).includes('重复'));
    assert.ok(objectEditor.validateColumnDefinitions([col({ name: 'a', dataType: '' })]).includes('数据类型'));
    assert.strictEqual(objectEditor.validateColumnDefinitions([col({ name: 'a' })]), undefined);
  });

  check('对象名校验：空 / 超 63 字符 / 控制字符', () => {
    assert.ok(objectEditor.validateObjectName('', '表名').includes('不能为空'));
    assert.ok(objectEditor.validateObjectName('a'.repeat(64), '表名').includes('过长'));
    assert.strictEqual(objectEditor.validateObjectName('a'.repeat(63), '表名'), undefined);
    assert.ok(objectEditor.validateObjectName('a\u0000b', '表名').includes('控制字符'));
  });

  check('空计划判定', () => {
    assert.strictEqual(objectEditor.planIsEmpty({ statements: [] }), true);
    assert.strictEqual(objectEditor.planIsEmpty(undefined), true);
    assert.strictEqual(objectEditor.planIsEmpty({ statements: ['SELECT 1'] }), false);
  });

  console.log('\n=== 18. 结构变更：MySQL 语句生成 ===');
  const mysqlStructure = require(path.join(outDir, 'drivers', 'mysqlStructure.js'));
  const mysqlCtx = { defaultCollationOf: async (charset) => (charset === 'utf8mb4' ? 'utf8mb4_0900_ai_ci' : undefined) };
  const mysqlTable = (columns, properties) => ({
    target: { database: 'app', table: 'users' },
    columns,
    properties: properties || [
      { key: 'name', label: '表名', value: 'users', kind: 'text' },
      { key: 'engine', label: '存储引擎', value: 'InnoDB', kind: 'text', options: ['InnoDB', 'MyISAM'] },
      { key: 'charset', label: '字符集', value: 'utf8mb4', kind: 'select' },
      { key: 'collation', label: '排序规则', value: 'utf8mb4_general_ci', kind: 'select' },
      { key: 'comment', label: '表注释', value: '', kind: 'text' },
    ],
    limitations: [],
    allowReorder: true,
    allowAutoIncrement: true,
  });

  await checkAsync('MySQL：新增列带 FIRST / AFTER，并保留注释与自增', async () => {
    const plan = await mysqlStructure.buildMysqlTablePlan(
      mysqlTable([col({ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, autoIncrement: true })]),
      {
        target: { database: 'app', table: 'users' },
        properties: {},
        columns: [
          col({ name: 'id', originalName: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, autoIncrement: true }),
          col({ name: 'email', dataType: 'varchar(120)', nullable: false, defaultValue: null, comment: "邮箱" }),
        ],
      },
      mysqlCtx,
    );
    assert.strictEqual(plan.statements.length, 1);
    assert.ok(plan.statements[0].startsWith('ALTER TABLE `app`.`users`'), plan.statements[0]);
    assert.ok(plan.statements[0].includes('ADD COLUMN `email` varchar(120) NOT NULL COMMENT '), plan.statements[0]);
    assert.ok(plan.statements[0].includes('AFTER `id`'), '新增列必须落到目标位置');
    // 完全没动的列不该出现在语句里
    assert.ok(!plan.statements[0].includes('MODIFY COLUMN `id`'), plan.statements[0]);
  });

  await checkAsync('MySQL：默认值按类型补引号，空串与表达式各走各的', async () => {
    const render = (column) => mysqlStructure.renderMysqlColumn(column);
    assert.ok(render(col({ name: 'n', dataType: 'varchar(10)' })).endsWith('`n` varchar(10)'));
    assert.ok(render(col({ name: 'n', dataType: 'varchar(10)', defaultValue: 'abc' })).includes("DEFAULT 'abc'"));
    assert.ok(render(col({ name: 'n', dataType: 'varchar(10)', defaultValue: '' })).includes("DEFAULT ''"));
    assert.ok(render(col({ name: 'n', dataType: 'int', defaultValue: '0' })).includes('DEFAULT 0'));
    assert.ok(render(col({ name: 'n', dataType: 'timestamp', defaultValue: 'CURRENT_TIMESTAMP(3)' })).includes('DEFAULT CURRENT_TIMESTAMP(3)'));
    assert.ok(render(col({ name: 'n', dataType: 'datetime', defaultValue: 'now()' })).includes('DEFAULT (now())'), 'MySQL 8 的表达式默认值需要括号');
    assert.ok(render(col({ name: 'n', dataType: 'int', defaultValue: "b'0'" })).includes("DEFAULT b'0'"));
    // 可空列省略 NULL 关键字
    assert.ok(!render(col({ name: 'n', dataType: 'int', nullable: true })).includes('NULL'));
  });

  await checkAsync('MySQL：ON UPDATE 子句必须原样保留（改写别的属性时丢掉它 = 静默改表行为）', async () => {
    const render = (column) => mysqlStructure.renderMysqlColumn(column);
    const onUpdate = render(
      col({ name: 'updated_at', dataType: 'timestamp', nullable: false, defaultValue: 'CURRENT_TIMESTAMP', extraClauses: 'ON UPDATE CURRENT_TIMESTAMP' }),
    );
    assert.ok(onUpdate.includes('DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'), onUpdate);

    const current = mysqlTable([
      col({ name: 'id', nullable: false, isPrimaryKey: true }),
      col({ name: 'updated_at', dataType: 'timestamp', nullable: false, defaultValue: 'CURRENT_TIMESTAMP', extraClauses: 'ON UPDATE CURRENT_TIMESTAMP' }),
    ]);

    // 界面只改了注释：ON UPDATE 既不能出现在语句里（说明被判成变化），也不能被丢掉
    const untouched = await mysqlStructure.buildMysqlTablePlan(
      current,
      {
        target: { database: 'app', table: 'users' },
        properties: {},
        columns: [
          col({ name: 'id', originalName: 'id', nullable: false, isPrimaryKey: true }),
          col({ name: 'updated_at', originalName: 'updated_at', dataType: 'timestamp', nullable: false, defaultValue: 'CURRENT_TIMESTAMP', extraClauses: 'ON UPDATE CURRENT_TIMESTAMP' }),
        ],
      },
      mysqlCtx,
    );
    assert.deepStrictEqual(untouched.statements, [], untouched.statements.join('\n'));

    // 客户端没回传 extraClauses（老版本界面 / 第三方调用）：按 originalName 从现状继承
    const inherited = mysqlStructure.inheritMysqlExtraClauses(current, {
      target: { database: 'app', table: 'users' },
      properties: {},
      columns: [
        col({ name: 'id', originalName: 'id', nullable: false, isPrimaryKey: true }),
        col({ name: 'updated_at', originalName: 'updated_at', dataType: 'timestamp', nullable: false, defaultValue: 'CURRENT_TIMESTAMP', comment: '改个注释' }),
      ],
    });
    assert.strictEqual(inherited.columns[1].extraClauses, 'ON UPDATE CURRENT_TIMESTAMP');
    const plan = await mysqlStructure.buildMysqlTablePlan(current, inherited, mysqlCtx);
    assert.ok(plan.statements[0].includes('ON UPDATE CURRENT_TIMESTAMP'), plan.statements[0]);
    assert.ok(plan.statements[0].includes('COMMENT'), plan.statements[0]);
  });

  await checkAsync('MySQL：TEXT / JSON 的默认值只能写成表达式形式（真库实测：裸写会被服务端拒绝）', async () => {
    const render = (column) => mysqlStructure.renderMysqlColumn(column);
    assert.ok(render(col({ name: 'n', dataType: 'text', defaultValue: 'hello' })).includes("DEFAULT ('hello')"));
    assert.ok(render(col({ name: 'n', dataType: 'longtext', defaultValue: '' })).includes("DEFAULT ('')"));
    assert.ok(render(col({ name: 'n', dataType: 'json', defaultValue: '{}' })).includes("DEFAULT ('{}')"));
    assert.ok(render(col({ name: 'n', dataType: 'blob', defaultValue: '' })).includes("DEFAULT ('')"));
    // varchar 的空串默认值保持裸引号写法，别被上面的规则带偏
    assert.ok(render(col({ name: 'n', dataType: 'varchar(10)', defaultValue: '' })).includes("DEFAULT ''"));
    assert.ok(!render(col({ name: 'n', dataType: 'varchar(10)', defaultValue: '' })).includes("DEFAULT ('')"));
  });

  await checkAsync('MySQL：读回的表达式默认值要反转义后再写回（`_utf8mb4\\\'x\\\'` → `DEFAULT (_utf8mb4\'x\')`）', async () => {
    const render = (column) => mysqlStructure.renderMysqlColumn(column);
    const readBack = "_utf8mb4\\'hello\\'";
    const sql = render(col({ name: 'n', dataType: 'text', defaultValue: readBack }));
    assert.ok(sql.includes("DEFAULT (_utf8mb4'hello')"), sql);
    assert.ok(!sql.includes('\\'), '反斜杠转义必须被解掉，否则服务端报语法错误：' + sql);
    // 反斜杠本身也要能正确还原（\\' 是「转义反斜杠 + 引号」，不能多吃一层）
    const slash = render(col({ name: 'n', dataType: 'text', defaultValue: "_utf8mb4\\'a\\\\b\\'" }));
    assert.ok(slash.includes("DEFAULT (_utf8mb4'a\\b')"), slash);
    // 已带括号的表达式不重复补括号
    assert.ok(render(col({ name: 'n', dataType: 'int', defaultValue: '(1 + 2)' })).includes('DEFAULT (1 + 2)'));
    // 数字类型上手打的表达式：MySQL 8 不接受裸表达式，必须补括号
    assert.ok(render(col({ name: 'n', dataType: 'int', defaultValue: '3 * 7' })).includes('DEFAULT (3 * 7)'));
    assert.ok(render(col({ name: 'n', dataType: 'int', defaultValue: '-1' })).includes('DEFAULT -1'));
  });

  await checkAsync('MySQL：删主键子句必须排在删列之前', async () => {
    const plan = await mysqlStructure.buildMysqlTablePlan(
      mysqlTable([col({ name: 'id', nullable: false, isPrimaryKey: true }), col({ name: 'keep', dataType: 'int' })]),
      { target: { database: 'app', table: 'users' }, properties: {}, columns: [col({ name: 'keep', originalName: 'keep', dataType: 'int' })] },
      mysqlCtx,
    );
    const sql = plan.statements[0];
    assert.ok(sql.includes('DROP PRIMARY KEY'), sql);
    assert.ok(sql.includes('DROP COLUMN `id`'), sql);
    assert.ok(sql.indexOf('DROP PRIMARY KEY') < sql.indexOf('DROP COLUMN `id`'), '主键删除必须排在删列之前，否则删列会连带丢掉主键');
    assert.ok(!sql.includes('ADD PRIMARY KEY'), '无主键目标时不该补主键');
    assert.ok(plan.warnings.some((w) => w.includes('数据')), '删列必须给出丢数据提示');
  });

  await checkAsync('MySQL：主键新增排在列变更之后（列先存在）', async () => {
    const plan = await mysqlStructure.buildMysqlTablePlan(
      mysqlTable([col({ name: 'code', dataType: 'varchar(10)', nullable: false })]),
      {
        target: { database: 'app', table: 'users' },
        properties: {},
        columns: [col({ name: 'code', originalName: 'code', dataType: 'varchar(10)', nullable: false, isPrimaryKey: true })],
      },
      mysqlCtx,
    );
    const sql = plan.statements[0];
    assert.ok(sql.includes('ADD PRIMARY KEY (`code`)'), sql);
    assert.ok(!sql.includes('DROP PRIMARY KEY'), '原本没有主键就不该删');
  });

  await checkAsync('MySQL：改名走 CHANGE COLUMN，并保持同一列只出现一次', async () => {
    const plan = await mysqlStructure.buildMysqlTablePlan(
      mysqlTable([col({ name: 'a', dataType: 'int', nullable: false })]),
      {
        target: { database: 'app', table: 'users' },
        properties: {},
        columns: [col({ name: 'b', originalName: 'a', dataType: 'bigint', nullable: false, defaultValue: '3' })],
      },
      mysqlCtx,
    );
    const sql = plan.statements[0];
    assert.ok(sql.includes('CHANGE COLUMN `a` `b` bigint NOT NULL DEFAULT 3'), sql);
    assert.ok(!sql.includes('MODIFY COLUMN `b`'), '同一列不能既 CHANGE 又 MODIFY');
  });

  await checkAsync('MySQL：只改字符集时自动补该字符集的默认排序规则', async () => {
    const structure = mysqlTable([col({ name: 'a' })]);
    structure.properties = structure.properties.map((property) =>
      property.key === 'charset'
        ? Object.assign({}, property, { value: 'latin1' })
        : property.key === 'collation'
          ? Object.assign({}, property, { value: 'latin1_swedish_ci' })
          : property,
    );
    const plan = await mysqlStructure.buildMysqlTablePlan(
      structure,
      {
        target: { database: 'app', table: 'users' },
        columns: [col({ name: 'a', originalName: 'a' })],
        properties: { charset: 'utf8mb4', collation: 'latin1_swedish_ci', engine: 'InnoDB', name: 'users', comment: '' },
      },
      { defaultCollationOf: async () => 'utf8mb4_unicode_ci' },
    );
    assert.ok(plan.statements[0].includes('DEFAULT CHARACTER SET = utf8mb4'), plan.statements[0]);
    assert.ok(plan.statements[0].includes('COLLATE = utf8mb4_unicode_ci'), plan.statements[0]);
    // 用户明确选了排序规则时不该被默认值覆盖
    const explicit = await mysqlStructure.buildMysqlTablePlan(
      structure,
      {
        target: { database: 'app', table: 'users' },
        columns: [col({ name: 'a', originalName: 'a' })],
        properties: { charset: 'utf8mb4', collation: 'utf8mb4_bin', engine: 'InnoDB', name: 'users', comment: '' },
      },
      { defaultCollationOf: async () => 'utf8mb4_unicode_ci' },
    );
    assert.ok(explicit.statements[0].includes('COLLATE = utf8mb4_bin'), explicit.statements[0]);
    assert.ok(!explicit.statements[0].includes('utf8mb4_unicode_ci'), explicit.statements[0]);
  });

  await checkAsync('MySQL：表改名是最后一条语句（前面的子句按旧名寻址）', async () => {
    const plan = await mysqlStructure.buildMysqlTablePlan(
      mysqlTable([col({ name: 'a' })]),
      {
        target: { database: 'app', table: 'users' },
        columns: [col({ name: 'a', originalName: 'a' })],
        properties: { name: 'members' },
      },
      mysqlCtx,
    );
    assert.strictEqual(plan.statements.length, 1);
    assert.strictEqual(plan.statements[0], 'RENAME TABLE `app`.`users` TO `app`.`members`;');
  });

  await checkAsync('MySQL：非法列定义与非法表名在生成阶段就被拦下', async () => {
    const bad = { target: { database: 'app', table: 'users' }, properties: {}, columns: [col({ name: 'a' }), col({ name: 'A' })] };
    await assert.rejects(() => mysqlStructure.buildMysqlTablePlan(mysqlTable([col({ name: 'a' })]), bad, mysqlCtx), /重复/);
    await assert.rejects(
      () =>
        mysqlStructure.buildMysqlTablePlan(
          mysqlTable([col({ name: 'a' })]),
          { target: { database: 'app', table: 'users' }, columns: [col({ name: 'a', originalName: 'a' })], properties: { name: 'x'.repeat(64) } },
          mysqlCtx,
        ),
      /过长/,
    );
  });

  await checkAsync('MySQL：AUTO_INCREMENT 无主键时给出提示；库属性用 ALTER DATABASE', async () => {
    const plan = await mysqlStructure.buildMysqlTablePlan(
      mysqlTable([col({ name: 'a' })]),
      {
        target: { database: 'app', table: 'users' },
        columns: [col({ name: 'a', originalName: 'a' }), col({ name: 'seq', dataType: 'int', autoIncrement: true })],
        properties: {},
      },
      mysqlCtx,
    );
    assert.ok(plan.warnings.some((w) => w.includes('AUTO_INCREMENT')), JSON.stringify(plan.warnings));

    const dbPlan = await mysqlStructure.buildMysqlDatabasePlan(
      {
        target: { kind: 'database', name: 'app' },
        label: '数据库',
        properties: [
          { key: 'name', label: '数据库名', value: 'app', kind: 'text', editable: false },
          { key: 'charset', label: '默认字符集', value: 'utf8mb4', kind: 'select' },
        ],
        limitations: [],
      },
      { target: { kind: 'database', name: 'app' }, properties: { charset: 'utf8mb4', name: 'app' } },
      mysqlCtx,
    );
    assert.deepStrictEqual(dbPlan.statements, [], '没改就不该有语句');
    const changed = await mysqlStructure.buildMysqlDatabasePlan(
      {
        target: { kind: 'database', name: 'app' },
        label: '数据库',
        properties: [{ key: 'charset', label: '默认字符集', value: 'latin1', kind: 'select' }],
        limitations: [],
      },
      { target: { kind: 'database', name: 'app' }, properties: { charset: 'utf8mb4' } },
      mysqlCtx,
    );
    // ALTER DATABASE 不接受 DEFAULT 关键字（那是 ALTER TABLE 的语法），
    // 也不接受逗号分隔的多个选项（真库实测：`CHARACTER SET = a, COLLATE = b` 直接语法错误）
    assert.ok(changed.statements[0].startsWith('ALTER DATABASE `app`'), changed.statements[0]);
    assert.ok(changed.statements[0].includes('CHARACTER SET = utf8mb4'), changed.statements[0]);
    assert.ok(!changed.statements[0].includes('DEFAULT'), changed.statements[0]);
    assert.ok(!changed.statements[0].includes(','), changed.statements[0]);
  });

  await checkAsync('MySQL：库属性同时提交字符集与排序规则时合成一条、空格相连', async () => {
    const both = await mysqlStructure.buildMysqlDatabasePlan(
      {
        target: { kind: 'database', name: 'app' },
        properties: [
          { key: 'name', label: '数据库名', value: 'app', kind: 'text', editable: false },
          { key: 'charset', label: '字符集', value: 'utf8mb4', kind: 'select' },
          { key: 'collation', label: '排序规则', value: 'utf8mb4_general_ci', kind: 'select' },
        ],
        limitations: [],
      },
      { target: { kind: 'database', name: 'app' }, properties: { charset: 'latin1', collation: 'latin1_general_ci' } },
      mysqlCtx,
    );
    assert.strictEqual(both.statements.length, 1, JSON.stringify(both.statements));
    assert.ok(
      both.statements[0].includes('CHARACTER SET = latin1 COLLATE = latin1_general_ci'),
      both.statements[0],
    );
    assert.ok(!both.statements[0].includes(','), both.statements[0]);
  });

  console.log('\n=== 19. 结构变更：PostgreSQL 语句生成 ===');
  const pgStructure = require(path.join(outDir, 'drivers', 'pgStructure.js'));
  const pgCtx = { primaryKeyConstraint: async () => 'users_pkey' };
  const pgTable = (columns, properties) => ({
    target: { database: 'app', schema: 'public', table: 'users' },
    columns,
    properties: properties || [
      { key: 'name', label: '表名', value: 'users', kind: 'text' },
      { key: 'owner', label: '所有者', value: 'postgres', kind: 'select', options: ['postgres', 'app'] },
      { key: 'comment', label: '表注释', value: '', kind: 'text' },
    ],
    limitations: [],
    allowReorder: false,
    allowAutoIncrement: false,
  });

  check('PG：类型别名归一，别把没改的类型判成有变化', () => {
    assert.strictEqual(pgStructure.normalizePgType('character varying(255)'), pgStructure.normalizePgType('varchar(255)'));
    assert.strictEqual(pgStructure.normalizePgType('timestamp without time zone'), 'timestamp');
    assert.strictEqual(pgStructure.normalizePgType('int8'), 'bigint');
    assert.strictEqual(pgStructure.normalizePgType('double precision'), 'double precision');
  });

  await checkAsync('PG：改类型带 USING 转换，未改动则不生成语句', async () => {
    const untouched = await pgStructure.buildPgTablePlan(
      pgTable([col({ name: 'a', dataType: 'character varying(255)' })]),
      { target: { database: 'app', schema: 'public', table: 'users' }, properties: {}, columns: [col({ name: 'a', originalName: 'a', dataType: 'varchar(255)' })] },
      pgCtx,
    );
    assert.deepStrictEqual(untouched.statements, [], '别名不同但类型相同，不该产生 ALTER');

    const changed = await pgStructure.buildPgTablePlan(
      pgTable([col({ name: 'a', dataType: 'integer' })]),
      { target: { database: 'app', schema: 'public', table: 'users' }, properties: {}, columns: [col({ name: 'a', originalName: 'a', dataType: 'bigint' })] },
      pgCtx,
    );
    assert.strictEqual(changed.statements[0], 'ALTER TABLE "public"."users" ALTER COLUMN "a" TYPE bigint USING "a"::bigint;');
  });

  await checkAsync('PG：可空 / 默认值 / 注释各自成句，清空用 DROP DEFAULT 与 IS NULL', async () => {
    const plan = await pgStructure.buildPgTablePlan(
      pgTable([
        col({ name: 'a', dataType: 'text', nullable: true, defaultValue: 'now()', comment: '旧注释' }),
      ]),
      {
        target: { database: 'app', schema: 'public', table: 'users' },
        properties: {},
        columns: [col({ name: 'a', originalName: 'a', dataType: 'text', nullable: false, defaultValue: null, comment: '' })],
      },
      pgCtx,
    );
    assert.deepStrictEqual(plan.statements, [
      'ALTER TABLE "public"."users" ALTER COLUMN "a" SET NOT NULL;',
      'ALTER TABLE "public"."users" ALTER COLUMN "a" DROP DEFAULT;',
      'COMMENT ON COLUMN "public"."users"."a" IS NULL;',
    ]);
  });

  await checkAsync('PG：新增列可空时不写 NOT NULL，注释单独下发', async () => {
    const plan = await pgStructure.buildPgTablePlan(
      pgTable([col({ name: 'id', dataType: 'integer', nullable: false })]),
      {
        target: { database: 'app', schema: 'public', table: 'users' },
        properties: {},
        columns: [
          col({ name: 'id', originalName: 'id', dataType: 'integer', nullable: false }),
          col({ name: 'note', dataType: 'text', comment: '备注' }),
        ],
      },
      pgCtx,
    );
    assert.strictEqual(plan.statements[0], 'ALTER TABLE "public"."users" ADD COLUMN "note" text;');
    assert.strictEqual(plan.statements[1], `COMMENT ON COLUMN "public"."users"."note" IS '备注';`);
  });

  await checkAsync('PG：新增 NOT NULL 无默认值的列会被预警（服务端会直接拒绝）', async () => {
    const plan = await pgStructure.buildPgTablePlan(
      pgTable([col({ name: 'id', dataType: 'integer', nullable: false })]),
      {
        target: { database: 'app', schema: 'public', table: 'users' },
        properties: {},
        columns: [
          col({ name: 'id', originalName: 'id', dataType: 'integer', nullable: false }),
          col({ name: 'code', dataType: 'text', nullable: false }),
        ],
      },
      pgCtx,
    );
    assert.ok(plan.warnings.some((w) => w.includes('NOT NULL')), JSON.stringify(plan.warnings));

    // 给了默认值就不该再唠叨
    const ok = await pgStructure.buildPgTablePlan(
      pgTable([col({ name: 'id', dataType: 'integer', nullable: false })]),
      {
        target: { database: 'app', schema: 'public', table: 'users' },
        properties: {},
        columns: [
          col({ name: 'id', originalName: 'id', dataType: 'integer', nullable: false }),
          col({ name: 'code', dataType: 'text', nullable: false, defaultValue: "'x'" }),
        ],
      },
      pgCtx,
    );
    assert.ok(!(ok.warnings || []).some((w) => w.includes('NOT NULL')), JSON.stringify(ok.warnings));
  });

  await checkAsync('PG：删主键约束排在删列之前，新增主键排在最后', async () => {
    const plan = await pgStructure.buildPgTablePlan(
      pgTable([col({ name: 'id', dataType: 'integer', nullable: false, isPrimaryKey: true }), col({ name: 'code', dataType: 'text' })]),
      {
        target: { database: 'app', schema: 'public', table: 'users' },
        properties: {},
        columns: [col({ name: 'code', originalName: 'code', dataType: 'text', isPrimaryKey: true })],
      },
      pgCtx,
    );
    const dropConstraint = plan.statements.findIndex((s) => s.includes('DROP CONSTRAINT "users_pkey"'));
    const dropColumn = plan.statements.findIndex((s) => s.includes('DROP COLUMN "id"'));
    const addPk = plan.statements.findIndex((s) => s.includes('ADD PRIMARY KEY ("code")'));
    assert.ok(dropConstraint >= 0 && dropColumn >= 0 && addPk >= 0, plan.statements.join('|'));
    assert.ok(dropConstraint < dropColumn, '主键约束必须先删，否则删列会连带丢掉约束');
    assert.ok(addPk > dropColumn, '新主键必须等列就位后再建');
    assert.ok(plan.statements[addPk].startsWith('ALTER TABLE "public"."users" ADD PRIMARY KEY'));
  });

  await checkAsync('PG：列改名与表改名都是独立语句，且表改名在最后', async () => {
    const plan = await pgStructure.buildPgTablePlan(
      pgTable([col({ name: 'a', dataType: 'integer' })]),
      {
        target: { database: 'app', schema: 'public', table: 'users' },
        columns: [col({ name: 'b', originalName: 'a', dataType: 'integer' })],
        properties: { name: 'members', owner: 'postgres', comment: '' },
      },
      pgCtx,
    );
    assert.strictEqual(plan.statements[0], 'ALTER TABLE "public"."users" RENAME COLUMN "a" TO "b";');
    assert.strictEqual(plan.statements[plan.statements.length - 1], 'ALTER TABLE "public"."users" RENAME TO "members";');
  });

  await checkAsync('PG：不支持调序 / 既有列转自增时给出提示而不是静默', async () => {
    const plan = await pgStructure.buildPgTablePlan(
      pgTable([col({ name: 'a', dataType: 'integer' }), col({ name: 'b', dataType: 'integer' })]),
      {
        target: { database: 'app', schema: 'public', table: 'users' },
        properties: {},
        columns: [
          col({ name: 'b', originalName: 'b', dataType: 'integer', autoIncrement: true }),
          col({ name: 'a', originalName: 'a', dataType: 'integer' }),
        ],
      },
      pgCtx,
    );
    assert.ok(plan.warnings.some((w) => w.includes('列顺序')), JSON.stringify(plan.warnings));
    assert.ok(plan.warnings.some((w) => w.includes('自增')), JSON.stringify(plan.warnings));
  });

  await checkAsync('PG：库 / schema 属性变更，清空注释用 IS NULL，改名在最后', async () => {
    const schemaPlan = pgStructure.buildPgDatabasePlan(
      {
        target: { kind: 'schema', name: 'public', database: 'app' },
        label: 'Schema',
        properties: [
          { key: 'name', label: 'Schema 名', value: 'public', kind: 'text' },
          { key: 'owner', label: '所有者', value: 'postgres', kind: 'select' },
          { key: 'comment', label: '注释', value: '旧', kind: 'text' },
        ],
        limitations: [],
      },
      {
        target: { kind: 'schema', name: 'public', database: 'app' },
        properties: { name: 'app', owner: 'app', comment: '' },
      },
    );
    assert.ok(schemaPlan.statements.includes('ALTER SCHEMA "public" OWNER TO "app";'), schemaPlan.statements.join('|'));
    assert.ok(schemaPlan.statements.includes('COMMENT ON SCHEMA "public" IS NULL;'), schemaPlan.statements.join('|'));
    assert.strictEqual(schemaPlan.statements[schemaPlan.statements.length - 1], 'ALTER SCHEMA "public" RENAME TO "app";');

    const dbPlan = pgStructure.buildPgDatabasePlan(
      {
        target: { kind: 'database', name: 'app' },
        label: '数据库',
        properties: [{ key: 'comment', label: '注释', value: '', kind: 'text' }],
        limitations: [],
      },
      { target: { kind: 'database', name: 'app' }, properties: { comment: '生产库' } },
    );
    assert.deepStrictEqual(dbPlan.statements, ["COMMENT ON DATABASE \"app\" IS '生产库';"]);
  });

  check('PG：驱动声明支持结构编辑，界面据此决定是否给出入口', () => {
    const pgDefinition = definitions.BUILTIN_DEFINITIONS.find((d) => d.id === 'postgresql');
    assert.strictEqual(pgDefinition.capabilities.editTableStructure, true);
    assert.strictEqual(pgDefinition.capabilities.editDatabaseProperties, true);
    const mysqlDefinition = definitions.BUILTIN_DEFINITIONS.find((d) => d.id === 'mysql');
    assert.strictEqual(mysqlDefinition.capabilities.editTableStructure, true);
    assert.strictEqual(mysqlDefinition.capabilities.editDatabaseProperties, true);
  });

  console.log(`\n=========================================`);
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    console.log('\n失败明细：');
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exitCode = 1;
  } else {
    console.log('全部通过。');
  }
})();

/**
 * 从 ZIP 缓冲区里取出指定条目的内容（仅支持本项目的 deflate / store 两种方式）。
 * 用来自证手写的 XLSX 生成器产出的是真 ZIP 而不是自说自话。
 */
function readZipEntry(buffer, name) {
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const entryName = buffer.slice(offset + 30, offset + 30 + nameLength).toString('ascii');
    const dataStart = offset + 30 + nameLength + extraLength;
    const data = buffer.slice(dataStart, dataStart + compressedSize);
    if (entryName === name) {
      return method === 8 ? zlib.inflateRawSync(data) : data;
    }
    offset = dataStart + compressedSize;
  }
  return undefined;
}
