// 结果面板前端逻辑：纯原生 JS，无外部依赖。
//
// 与扩展侧的职责边界：
// - 本文件只负责渲染与收集交互，不持有"权威数据"；
// - 排序只改动显示顺序（order 排列数组），不改动 rows 本身——
//   这样回传的行下标始终等于扩展侧原始行下标，单元格更新才不会改错行；
// - 单元格改动先攒在 pending 里，点「应用修改」才提交，
//   避免"手滑碰一下就把线上数据改掉"。
(function () {
  const vscode = acquireVsCodeApi();

  const state = {
    sets: [],
    active: 0,
    page: 0,
    pageSize: 100,
    durationMs: 0,
    connectionName: '',
    target: '',
    truncated: false,
    /** 是否有可编辑目标（主键齐备且驱动支持）。 */
    editable: false,
    /** 面板里的 SQL 是否可以改完直接执行。 */
    canExecute: false,
    /** 顶层执行的 SQL 原文；单个结果集没有自己的 sql 时用它兜底。 */
    rawSql: '',
    sqlOpen: true,
    /** 用户是否手动改过 SQL 编辑框——改过之后重绘不得覆盖。 */
    sqlDirty: false,
    /** 正在执行中，用于禁用重复提交。 */
    running: false,
    lastSortField: undefined,
    lastSortAsc: true,
    /** 最近一次编辑生成的 UPDATE，展示在 SQL 区下方。 */
    lastEditSql: '',
    /** 需要持续显示的错误（普通 notice 会在重绘时被清掉）。 */
    lastError: '',
    /** 待提交的单元格修改，key = `setIndex|rowIndex|fieldIndex`。 */
    pending: {},
    /** 批量提交进行中。 */
    applying: false,
  };

  const el = {
    target: document.getElementById('target'),
    stats: document.getElementById('stats'),
    tabs: document.getElementById('tabs'),
    content: document.getElementById('content'),
    notices: document.getElementById('notices'),
    pageSize: document.getElementById('pageSize'),
    pageInfo: document.getElementById('pageinfo'),
    prev: document.getElementById('prev'),
    next: document.getElementById('next'),
    copy: document.getElementById('copyTsv'),
    exportCsv: document.getElementById('exportCsv'),
    exportJson: document.getElementById('exportJson'),
    exportJsonl: document.getElementById('exportJsonl'),
    exportXlsx: document.getElementById('exportXlsx'),
    editGroup: document.getElementById('editGroup'),
    editSep: document.getElementById('editSep'),
    applyEdits: document.getElementById('applyEdits'),
    discardEdits: document.getElementById('discardEdits'),
    sqlBox: document.getElementById('sqlBox'),
    sqlToggle: document.getElementById('sqlToggle'),
    sqlEditor: document.getElementById('sqlEditor'),
    sqlStats: document.getElementById('sqlStats'),
    sqlCopy: document.getElementById('sqlCopy'),
    sqlRun: document.getElementById('sqlRun'),
    sqlReset: document.getElementById('sqlReset'),
    sqlHint: document.getElementById('sqlHint'),
    editLog: document.getElementById('editLog'),
  };

  el.pageSize.addEventListener('change', () => {
    state.pageSize = Number(el.pageSize.value) || 0;
    state.page = 0;
    render();
  });
  el.prev.addEventListener('click', () => {
    if (state.page > 0) {
      state.page -= 1;
      render();
    }
  });
  el.next.addEventListener('click', () => {
    if (state.page < maxPage()) {
      state.page += 1;
      render();
    }
  });
  el.copy.addEventListener('click', copyCurrentPage);

  for (const [node, format] of [
    [el.exportCsv, 'csv'],
    [el.exportJson, 'json'],
    [el.exportJsonl, 'jsonl'],
    [el.exportXlsx, 'xlsx'],
  ]) {
    node.addEventListener('click', () =>
      vscode.postMessage({ type: 'export', format: format, setIndex: state.active }),
    );
  }

  el.applyEdits.addEventListener('click', submitPendingEdits);
  el.discardEdits.addEventListener('click', () => {
    state.pending = {};
    render();
    toast('已放弃未提交的修改');
  });

  el.sqlToggle.addEventListener('click', () => {
    state.sqlOpen = !state.sqlOpen;
    renderSql();
  });
  el.sqlCopy.addEventListener('click', () => {
    const sql = el.sqlEditor.value;
    if (!sql) {
      return;
    }
    vscode.postMessage({ type: 'copy', text: sql });
    toast('已复制 SQL');
  });
  el.sqlRun.addEventListener('click', executeFromEditor);
  el.sqlReset.addEventListener('click', () => {
    syncSqlEditor();
    toast('已还原为最近一次执行的 SQL');
  });
  // 编辑框里直接 Ctrl/Cmd + Enter 执行，和 SQL 文档的快捷键习惯保持一致
  el.sqlEditor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      executeFromEditor();
    }
  });
  el.sqlEditor.addEventListener('input', () => {
    state.sqlDirty = true;
    updateSqlControls();
  });

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    switch (message.type) {
      case 'result':
        state.sets = (message.sets || []).map((set) => ({
          statement: set.statement,
          sql: set.sql || '',
          fields: set.fields || [],
          rows: set.rows || [],
          affectedRows: set.affectedRows,
          notices: set.notices || [],
          // 显示顺序与原始下标的映射：排序只动这里
          order: (set.rows || []).map((_, index) => index),
        }));
        state.active = 0;
        state.page = 0;
        state.durationMs = message.durationMs || 0;
        state.connectionName = message.connectionName || '';
        state.target = message.target || '';
        state.truncated = !!message.truncated;
        state.editable = !!message.editable;
        state.canExecute = !!message.canExecute;
        state.rawSql = message.sql || '';
        state.lastError = '';
        state.lastEditSql = message.lastEditSql || '';
        state.lastSortField = undefined;
        state.pending = {};
        state.applying = false;
        state.running = false;
        syncSqlEditor();
        render();
        break;
      case 'error':
        state.sets = [];
        state.rawSql = message.sql || '';
        state.lastError = message.message || '执行失败';
        state.lastEditSql = '';
        state.pending = {};
        state.running = false;
        el.content.innerHTML = '';
        el.tabs.innerHTML = '';
        el.target.textContent = state.connectionName || '查询结果';
        el.stats.textContent = '';
        syncSqlEditor();
        renderSql();
        renderEditControls();
        showNotice(state.lastError, 'error');
        break;
      case 'running':
        state.running = true;
        updateSqlControls();
        showNotice('正在执行…', 'info', true);
        break;
      case 'clear':
        state.sets = [];
        state.rawSql = '';
        state.lastError = '';
        state.lastEditSql = '';
        state.pending = {};
        state.running = false;
        el.content.innerHTML = '<div class="placeholder">执行查询后，结果将显示在此处。</div>';
        el.tabs.innerHTML = '';
        el.stats.textContent = '';
        el.target.textContent = '查询结果';
        syncSqlEditor();
        renderSql();
        renderEditControls();
        clearNotices();
        break;
      case 'cellUpdated':
        applyCellUpdated(message);
        break;
      case 'cellsUpdated':
        applyCellsUpdated(message);
        break;
      case 'cellEditFailed':
        state.lastError = `更新失败：${message.reason || '未知错误'}`;
        render();
        showNotice(state.lastError, 'error');
        toast('更新失败');
        break;
      case 'executeFailed':
        state.running = false;
        state.lastError = `执行失败：${message.reason || '未知错误'}`;
        render();
        showNotice(state.lastError, 'error');
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });

  function currentSet() {
    return state.sets[state.active];
  }

  function currentSql() {
    const set = currentSet();
    return (set && set.sql) || state.rawSql || '';
  }

  function rowCount() {
    const set = currentSet();
    return set ? set.rows.length : 0;
  }

  function maxPage() {
    if (!state.pageSize) {
      return 0;
    }
    return Math.max(0, Math.ceil(rowCount() / state.pageSize) - 1);
  }

  function isResultSet(set) {
    return set && (set.fields.length > 0 || set.rows.length > 0);
  }

  function render() {
    // 重绘会把待复制的那个单元格节点换掉，挂起的定时器必须一并撤销
    cancelPendingCopy();
    renderHeader();
    renderTabs();
    renderSql();
    renderEditControls();
    renderContent();
    renderPager();
  }

  function renderHeader() {
    el.target.textContent = state.target || state.connectionName || '查询结果';
    const parts = [];
    if (state.sets.length > 1) {
      parts.push(`${state.sets.length} 条语句`);
    }
    parts.push(`${state.durationMs} ms`);
    const set = currentSet();
    if (set) {
      if (isResultSet(set)) {
        parts.push(`${set.rows.length} 行`);
      } else if (typeof set.affectedRows === 'number') {
        parts.push(`影响 ${set.affectedRows} 行`);
      }
    }
    if (state.editable) {
      parts.push('可编辑：双击单元格改值，再点「应用修改」写回数据库');
    }
    if (state.truncated) {
      parts.push('已截断');
    }
    el.stats.textContent = parts.join(' · ');
  }

  function renderTabs() {
    el.tabs.innerHTML = '';
    if (state.sets.length <= 1) {
      return;
    }
    state.sets.forEach((set, index) => {
      const tab = document.createElement('div');
      tab.className = 'tab' + (index === state.active ? ' active' : '');
      const count = isResultSet(set) ? `${set.rows.length} 行` : `影响 ${set.affectedRows ?? 0} 行`;
      tab.textContent = `${index + 1}. ${set.statement || 'SQL'} (${count})`;
      tab.addEventListener('click', () => {
        state.active = index;
        state.page = 0;
        // 回传当前激活下标，扩展侧导出时才能定位到正确的结果集
        vscode.postMessage({ type: 'activeSet', index: index });
        // 每个结果集有自己的 SQL，没手动改过就跟着切
        if (!state.sqlDirty) {
          syncSqlEditor();
        }
        render();
      });
      el.tabs.appendChild(tab);
    });
  }

  function renderSql() {
    el.sqlBox.classList.toggle('collapsed', !state.sqlOpen);
    el.sqlToggle.textContent = (state.sqlOpen ? '▾ ' : '▸ ') + '执行的 SQL';
    const set = currentSet();
    el.sqlStats.textContent = set && set.statement ? set.statement : '';
    updateSqlControls();

    if (state.lastEditSql) {
      el.editLog.hidden = false;
      el.editLog.textContent = `已应用变更：\n${state.lastEditSql}`;
    } else {
      el.editLog.hidden = true;
      el.editLog.textContent = '';
    }
  }

  /** 把当前结果集的 SQL 灌进编辑框并复位"已改"标记。 */
  function syncSqlEditor() {
    el.sqlEditor.value = currentSql();
    state.sqlDirty = false;
    updateSqlControls();
  }

  function updateSqlControls() {
    const hasSql = el.sqlEditor.value.trim().length > 0;
    el.sqlEditor.readOnly = !state.canExecute;
    el.sqlEditor.classList.toggle('readonly', !state.canExecute);
    el.sqlRun.hidden = !state.canExecute;
    el.sqlReset.hidden = !state.canExecute;
    el.sqlHint.hidden = !state.canExecute;
    el.sqlRun.disabled = !hasSql || state.running;
    el.sqlRun.textContent = state.running ? '执行中…' : '▶ 执行';
    el.sqlReset.disabled = !state.sqlDirty;
    el.sqlCopy.disabled = !hasSql;
  }

  function executeFromEditor() {
    if (!state.canExecute || state.running) {
      return;
    }
    const sql = el.sqlEditor.value.trim();
    if (!sql) {
      toast('SQL 为空');
      return;
    }
    vscode.postMessage({ type: 'execute', sql: sql });
  }

  // ------------------------------------------------------------ 待提交修改

  function pendingKeyOf(setIndex, rowIndex, fieldIndex) {
    return `${setIndex}|${rowIndex}|${fieldIndex}`;
  }

  function pendingCount() {
    return Object.keys(state.pending).length;
  }

  function pendingList() {
    return Object.keys(state.pending).map((key) => state.pending[key]);
  }

  /** 找出某个单元格的待提交项键名，扩展侧回传的是列名而不是下标。 */
  function findPendingKey(setIndex, rowIndex, column) {
    for (const key of Object.keys(state.pending)) {
      const item = state.pending[key];
      if (item.setIndex === setIndex && item.rowIndex === rowIndex && item.column === column) {
        return key;
      }
    }
    return undefined;
  }

  function renderEditControls() {
    const count = pendingCount();
    el.editGroup.hidden = !state.editable;
    el.editSep.hidden = !state.editable;
    el.applyEdits.disabled = count === 0 || state.applying;
    el.discardEdits.disabled = count === 0 || state.applying;
    el.applyEdits.textContent = state.applying
      ? '提交中…'
      : count
        ? `应用修改 (${count})`
        : '应用修改';
  }

  function submitPendingEdits() {
    const edits = pendingList();
    if (!edits.length || state.applying) {
      return;
    }
    state.applying = true;
    renderEditControls();
    vscode.postMessage({
      type: 'applyEdits',
      edits: edits.map((edit) => ({
        setIndex: edit.setIndex,
        rowIndex: edit.rowIndex,
        column: edit.column,
        value: edit.value,
        isNull: edit.isNull,
      })),
    });
  }

  function renderContent() {
    el.content.innerHTML = '';
    clearNotices();

    const set = currentSet();
    if (!set) {
      el.content.innerHTML = '<div class="placeholder">无结果集。</div>';
      return;
    }

    if (set.notices && set.notices.length) {
      for (const notice of set.notices) {
        showNotice(notice, /ERROR/i.test(notice) ? 'error' : 'warn');
      }
    }

    // 编辑失败的信息要跨重绘存活，普通 notice 会被 clearNotices 抹掉
    if (state.lastError) {
      showNotice(state.lastError, 'error');
    }

    if (!isResultSet(set)) {
      const div = document.createElement('div');
      div.className = 'affected';
      div.textContent = `语句执行成功，影响行数：${set.affectedRows ?? 0}`;
      el.content.appendChild(div);
      return;
    }

    const start = state.pageSize ? state.page * state.pageSize : 0;
    const end = state.pageSize ? Math.min(start + state.pageSize, set.rows.length) : set.rows.length;

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.textContent = '#';
    corner.style.cursor = 'default';
    headRow.appendChild(corner);

    set.fields.forEach((field, fieldIndex) => {
      const th = document.createElement('th');
      th.textContent = field;
      th.title = `${field}（点击排序）`;
      th.addEventListener('click', () => sortBy(fieldIndex));
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let i = start; i < end; i++) {
      // seq 是原始行下标，编辑时回传它，扩展侧据此取主键值
      const seq = set.order[i];
      const row = set.rows[seq];
      const tr = document.createElement('tr');

      const rowno = document.createElement('td');
      rowno.className = 'rowno';
      rowno.textContent = String(i + 1);
      if (seq !== i) {
        rowno.title = `原始行号 ${seq + 1}`;
      }
      tr.appendChild(rowno);

      for (let c = 0; c < set.fields.length; c++) {
        const td = document.createElement('td');
        const pending = state.pending[pendingKeyOf(state.active, seq, c)];
        // 待提交值优先展示：用户看到的必须是自己刚输入的内容
        const value = pending ? (pending.isNull ? null : pending.value) : row[c];
        paintCell(td, value);
        td.dataset.value = value === null || value === undefined ? '' : displayText(value);
        if (pending) {
          td.classList.add('pending');
        }
        if (value !== null && value !== undefined) {
          bindCellClick(td);
        }
        if (state.editable) {
          td.classList.add('editable');
          td.title = `${set.fields[c]}：双击编辑，单击复制`;
          td.addEventListener('dblclick', () => {
            cancelPendingCopy();
            beginEdit(td, seq, c);
          });
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    el.content.appendChild(table);

    if (set.rows.length === 0) {
      const div = document.createElement('div');
      div.className = 'placeholder';
      div.textContent = '查询成功，但返回 0 行。';
      el.content.appendChild(div);
    }
  }

  function paintCell(td, value) {
    if (value === null || value === undefined) {
      td.className = 'null';
      td.textContent = 'NULL';
      return;
    }
    const text = displayText(value);
    td.className = 'cell';
    td.textContent = text;
  }

  function displayText(value) {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  function renderPager() {
    const set = currentSet();
    const hasRows = set && isResultSet(set) && set.rows.length > 0;
    el.prev.disabled = !hasRows || state.page <= 0;
    el.next.disabled = !hasRows || state.page >= maxPage();
    el.copy.disabled = !hasRows;
    el.exportCsv.disabled = !hasRows;
    el.exportJson.disabled = !hasRows;
    el.exportJsonl.disabled = !hasRows;
    el.exportXlsx.disabled = !hasRows;
    el.pageInfo.textContent =
      hasRows && state.pageSize ? `第 ${state.page + 1} / ${maxPage() + 1} 页` : `${rowCount()} 行`;
  }

  // ------------------------------------------------------------ 单元格编辑

  /**
   * 单击复制，双击编辑——两者共用 click 事件，必须做去抖：
   * 双击会先派发两次 click，不去抖的话用户每次进入编辑都会被复制两次、弹两次提示。
   * 代价是单击复制延迟一个双击间隔，这个取舍值得。
   */
  let pendingCopy;

  function bindCellClick(td) {
    td.addEventListener('click', () => {
      if (pendingCopy) {
        return;
      }
      pendingCopy = setTimeout(() => {
        pendingCopy = undefined;
        vscode.postMessage({ type: 'copy', text: td.dataset.value });
        toast('已复制单元格');
      }, 220);
    });
  }

  function cancelPendingCopy() {
    clearTimeout(pendingCopy);
    pendingCopy = undefined;
  }

  /**
   * 就地编辑。
   *
   * 改完先记进 pending，由用户点「应用修改」统一落库。空值语义刻意做成
   * 「跟随库中值」：本来是 NULL 且没输入 → 仍是 NULL；本来有值 → 清空写入空串。
   */
  function beginEdit(td, seq, fieldIndex) {
    const set = currentSet();
    if (!set || td.classList.contains('editing')) {
      return;
    }
    const key = pendingKeyOf(state.active, seq, fieldIndex);
    const existing = state.pending[key];
    const committed = set.rows[seq][fieldIndex];
    const initial = existing
      ? existing.value
      : committed === null || committed === undefined
        ? ''
        : displayText(committed);

    td.classList.add('editing');
    td.textContent = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-editor';
    input.spellcheck = false;
    input.value = initial;
    td.appendChild(input);
    input.focus();
    input.select();

    let settled = false;
    const finish = (commit) => {
      if (settled) {
        return;
      }
      settled = true;
      const next = input.value;
      if (!commit) {
        render();
        return;
      }

      const committedText =
        committed === null || committed === undefined ? '' : displayText(committed);
      if (next === committedText) {
        // 改回库中现有值（或原样确认）→ 不产生待提交项
        delete state.pending[key];
        render();
        return;
      }

      const isNull = next === '' && (committed === null || committed === undefined);
      state.pending[key] = {
        setIndex: state.active,
        rowIndex: seq,
        fieldIndex: fieldIndex,
        column: set.fields[fieldIndex],
        value: next,
        isNull: isNull,
      };
      render();
      toast(`已记录修改，共 ${pendingCount()} 项待提交`);
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  /** 扩展侧逐条提交后的汇总回传。 */
  function applyCellsUpdated(message) {
    const results = message.results || [];
    let ok = 0;
    let failed = 0;
    let lastReason = '';

    for (const result of results) {
      const key = findPendingKey(result.setIndex, result.rowIndex, result.column);
      if (result.error) {
        failed += 1;
        lastReason = result.error;
        continue;
      }
      const set = state.sets[result.setIndex];
      if (set) {
        const fieldIndex = set.fields.indexOf(result.column);
        const row = set.rows[result.rowIndex];
        if (row && fieldIndex >= 0) {
          row[fieldIndex] = result.value;
        }
      }
      if (key !== undefined) {
        delete state.pending[key];
      }
      if (result.sql) {
        state.lastEditSql = result.sql;
      }
      ok += 1;
    }

    state.applying = false;
    state.lastError = failed ? `有 ${failed} 项未提交：${lastReason}` : '';
    render();
    if (failed) {
      showNotice(state.lastError, 'error');
      toast(`已提交 ${ok} 项，${failed} 项失败`);
    } else if (ok) {
      toast(`已提交 ${ok} 项修改`);
    }
  }

  /** 兼容旧前端的单格即时提交回传。 */
  function applyCellUpdated(message) {
    const set = state.sets[message.setIndex];
    if (!set) {
      return;
    }
    const fieldIndex = set.fields.indexOf(message.column);
    const row = set.rows[message.rowIndex];
    if (!row || fieldIndex < 0) {
      render();
      return;
    }
    row[fieldIndex] = message.value;
    const key = findPendingKey(message.setIndex, message.rowIndex, message.column);
    if (key !== undefined) {
      delete state.pending[key];
    }
    state.lastEditSql = message.sql || '';
    state.lastError = '';
    render();
    const affected = typeof message.affectedRows === 'number' ? message.affectedRows : undefined;
    toast(affected === 0 ? '没有匹配的行被更新' : `已更新${affected ? ` ${affected} 行` : ''}`);
  }

  // ------------------------------------------------------------ 排序

  function sortBy(fieldIndex) {
    const set = currentSet();
    if (!set || !set.rows.length) {
      return;
    }
    const asc = !(state.lastSortField === fieldIndex && state.lastSortAsc);
    const sorted = set.order
      .slice()
      .sort((a, b) => compare(set.rows[a][fieldIndex], set.rows[b][fieldIndex]));
    if (!asc) {
      sorted.reverse();
    }
    // 二次点击切换为降序
    set.order = sorted;
    state.lastSortField = fieldIndex;
    state.lastSortAsc = asc;
    state.page = 0;
    render();
  }

  function compare(a, b) {
    if (a === b) return 0;
    if (a === null || a === undefined) return 1;
    if (b === null || b === undefined) return -1;
    const na = Number(a);
    const nb = Number(b);
    if (!isNaN(na) && !isNaN(nb)) {
      return na - nb;
    }
    return String(a).localeCompare(String(b), 'zh-CN');
  }

  function copyCurrentPage() {
    const set = currentSet();
    if (!set) {
      return;
    }
    const start = state.pageSize ? state.page * state.pageSize : 0;
    const end = state.pageSize ? Math.min(start + state.pageSize, set.rows.length) : set.rows.length;
    const lines = [set.fields.join('\t')];
    for (let i = start; i < end; i++) {
      const seq = set.order[i];
      lines.push(
        set.rows[seq]
          .map((value, c) => {
            const pending = state.pending[pendingKeyOf(state.active, seq, c)];
            const effective = pending ? (pending.isNull ? null : pending.value) : value;
            return effective === null || effective === undefined ? '' : displayText(effective);
          })
          .join('\t'),
      );
    }
    vscode.postMessage({ type: 'copy', text: lines.join('\n') });
    toast('已复制当前页（TSV，可直接粘贴到表格）');
  }

  // ------------------------------------------------------------ 提示

  function showNotice(text, level, replace) {
    if (replace) {
      clearNotices();
    }
    const div = document.createElement('div');
    div.className = 'notice ' + (level || 'info');
    div.textContent = text;
    el.notices.appendChild(div);
  }

  function clearNotices() {
    el.notices.innerHTML = '';
  }

  let toastTimer;
  function toast(text) {
    let node = document.querySelector('.toast');
    if (!node) {
      node = document.createElement('div');
      node.className = 'toast';
      document.body.appendChild(node);
    }
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 1600);
  }
})();
