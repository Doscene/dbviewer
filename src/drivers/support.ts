/**
 * 驱动共用的脚本执行器。
 *
 * 多语句执行采用「自拆分 + 顺序执行」而非驱动原生的多语句能力，原因：
 * 1. 结果集归属明确——每条语句产出独立的 ResultSet，界面展示与导出都更清晰；
 * 2. 错误定位精确——可以明确报出是第几条语句失败，而不是一句笼统的语法错误；
 * 3. 规避驱动差异——各家对多语句结果的包装格式不统一（嵌套数组 / 扁平数组 / OkPacket），
 *    自行拆分后驱动只需专注「执行单条语句 + 返回单组结果」。
 */

import { ExecuteOptions, QueryResult, ResultSet } from '../core/types';
import { isDestructiveStatement, splitStatements, statementKind } from '../core/sqlText';

/** 单条语句的执行回调，由具体驱动提供。 */
export type StatementRunner = (sql: string, limit: number, timeoutMs: number) => Promise<ResultSet>;

/** 是否包含 DELIMITER 指令：这类脚本（MySQL 存储过程）不能被拆分。 */
function hasDelimiterDirective(sql: string): boolean {
  return /^\s*delimiter\b/im.test(sql);
}

/**
 * 执行一段可能包含多条语句的 SQL。
 *
 * @param sql 原始 SQL 文本
 * @param options 行数上限与超时
 * @param runner 单语句执行器
 */
export async function executeScript(sql: string, options: ExecuteOptions, runner: StatementRunner): Promise<QueryResult> {
  const started = Date.now();
  const limit = options.limit ?? 0;
  const text = sql.trim();
  if (!text) {
    throw new Error('SQL 为空，未执行任何语句');
  }

  const statements = hasDelimiterDirective(text) ? [text] : splitStatements(text);
  if (statements.length === 0) {
    throw new Error('SQL 为空，未执行任何语句');
  }

  const sets: ResultSet[] = [];
  let truncated = false;

  for (const statement of statements) {
    const result = await runner(statement, limit, options.timeoutMs);
    // 驱动在内部统一截断，这里只做标记汇总，保证 QueryResult.truncated 语义正确
    if (limit > 0 && result.rows.length >= limit && /^(select|with|show|explain|values)$/i.test(result.statement)) {
      truncated = true;
    }
    sets.push(result);
  }

  return {
    sets,
    durationMs: Date.now() - started,
    sql: text,
    truncated,
  };
}

/** 由驱动调用，构造标准 ResultSet。 */
export function buildResultSet(params: {
  sql: string;
  fields: string[];
  rows: Record<string, unknown>[];
  affectedRows?: number;
  notices?: string[];
  /** 语句类型覆盖：PG 等驱动能拿到服务端返回的 command，比文本推断更准确。 */
  statement?: string;
  /** 实际下发的 SQL：可能与原始语句不同（例如自动追加了 LIMIT），默认取原始语句。 */
  executedSql?: string;
}): ResultSet {
  const statement = (params.statement || statementKind(params.sql)).toUpperCase();
  const isQuery = params.rows.length > 0 || /^(SELECT|WITH|SHOW|EXPLAIN|VALUES|DESCRIBE|DESC|TABLE|FETCH)$/.test(statement);
  return {
    statement,
    // 保留完整语句：结果面板要把它原样展示给用户，便于核对到底执行了什么
    sql: params.executedSql ?? params.sql,
    fields: params.fields,
    rows: params.rows,
    rowCount: isQuery ? params.rows.length : params.affectedRows ?? 0,
    affectedRows: params.affectedRows,
    notices: params.notices,
  };
}

/** 写操作提示：用于 UI 层二次确认。 */
export function requiresConfirmation(sql: string): boolean {
  return isDestructiveStatement(sql);
}
