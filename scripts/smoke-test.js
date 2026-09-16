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
