/**
 * SQL Shell 前端：只做输入与渲染。
 *
 * 数据与执行权都在扩展侧——这里既不拼 SQL 也不做业务判断，
 * 收到的每一条消息都只是「某个条目现在长什么样」。
 *
 * 所有来自数据库的值一律走 textContent 写入，绝不拼 innerHTML：
 * 表里存的内容是不可信输入，拼字符串等于给自己开一个 XSS 口子。
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const bootstrap = JSON.parse(document.getElementById('bootstrap').textContent || '{}');

  /** 与扩展侧保持一致，双保险：即使扩展侧放宽了限制，前端也不会被拖垮。 */
  const MAX_RENDER_ROWS = 200;
  const HISTORY_LIMIT = 200;

  const output = document.getElementById('output');
  const welcome = document.getElementById('welcome');
  const input = document.getElementById('input');
  const clearBtn = document.getElementById('clearBtn');
  const helpBtn = document.getElementById('helpBtn');
  const connName = document.getElementById('connName');
  const connTarget = document.getElementById('connTarget');
  const envInfo = document.getElementById('envInfo');
  const toast = document.getElementById('toast');

  let host = bootstrap.host || {};
  const nodes = new Map();

  // 历史与草稿存进 webview state：面板被隐藏后重建，↑ 仍能翻到上次的命令
  const saved = vscode.getState() || {};
  const history = Array.isArray(saved.history) ? saved.history.slice(-HISTORY_LIMIT) : [];
  let historyIndex = history.length;
  let draft = '';

  // ---------------------------------------------------------------- 工具

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function persist() {
    vscode.setState({ history: history.slice(-HISTORY_LIMIT) });
  }

  function nearBottom() {
    return output.scrollHeight - output.scrollTop - output.clientHeight < 80;
  }

  let toastTimer;
  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1500);
  }

  function adjustInputHeight() {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }

  // ---------------------------------------------------------------- 顶部信息

  /** 帮助文案由扩展侧下发；这里的兜底只在 bootstrap 缺字段时才会用上。 */
  function metaHelpText() {
    return host.metaHelp || '输入 \\? 查看可用命令。';
  }

  function renderHost() {
    connName.textContent = host.connectionName || '未命名连接';
    const sub = [host.driverName, host.target].filter(Boolean).join(' · ');
    connTarget.textContent = sub;
    connTarget.title = sub;
    envInfo.textContent = host.environment || '';
    envInfo.title = host.environment || '';
    renderWelcome();
  }

  function renderWelcome() {
    const lines = [
      `已连接到 ${host.connectionName || '数据库'}${host.database ? `（${host.database}）` : ''}。`,
      '输入 SQL 后按 Enter 执行，输入 \\? 查看可用命令。',
    ];
    // 输出区为空时顺便把命令摊开，省得用户先敲一次 \? 才知道有什么
    if (!nodes.size) {
      lines.push('', metaHelpText());
    }
    welcome.textContent = lines.join('\n');
    welcome.hidden = nodes.size > 0;
  }

  // ---------------------------------------------------------------- 渲染

  function resetOutput() {
    nodes.clear();
    for (const node of Array.from(output.querySelectorAll('.entry'))) {
      node.remove();
    }
    renderWelcome();
  }

  function upsertEntry(entry) {
    const pinned = nearBottom();
    let node = nodes.get(entry.id);
    if (!node) {
      node = document.createElement('div');
      node.className = 'entry';
      node.dataset.id = String(entry.id);

      const cmd = el('div', 'cmd');
      cmd.appendChild(el('span', 'prompt', 'sql>'));
      cmd.appendChild(el('pre', null, entry.sql || ''));

      node.appendChild(cmd);
      node.appendChild(el('div', 'entry-body'));
      nodes.set(entry.id, node);
      output.appendChild(node);
      welcome.hidden = true;
    }

    node.dataset.status = entry.status;
    const body = node.querySelector('.entry-body');
    body.replaceChildren(renderBody(entry));
    if (pinned) {
      output.scrollTop = output.scrollHeight;
    }
  }

  function renderBody(entry) {
    const frag = document.createDocumentFragment();

    if (entry.status === 'running') {
      frag.appendChild(el('div', 'pending', '执行中…'));
      return frag;
    }

    if (entry.status === 'notice' || entry.status === 'error') {
      frag.appendChild(el('div', entry.status === 'error' ? 'msg error' : 'msg', entry.message || ''));
      if (Array.isArray(entry.hints) && entry.hints.length) {
        frag.appendChild(el('div', 'hints', entry.hints.map((h) => `· ${h}`).join('\n')));
      }
      return frag;
    }

    const sets = Array.isArray(entry.sets) ? entry.sets : [];
    sets.forEach((set, index) => frag.appendChild(renderSet(set, index, sets.length)));

    const parts = [];
    const rows = sets.reduce((sum, set) => sum + (Array.isArray(set.rows) ? set.rows.length : 0), 0);
    if (rows) {
      parts.push(`${rows} 行`);
    }
    if (typeof entry.durationMs === 'number') {
      parts.push(`${entry.durationMs} ms`);
    }
    if (parts.length) {
      frag.appendChild(el('div', 'stats-line', parts.join(' · ')));
    }
    return frag;
  }

  function renderSet(set, index, total) {
    const wrap = el('div', 'set');
    const head = el('div', 'set-head');
    head.appendChild(el('span', 'set-name', `${total > 1 ? `#${index + 1} ` : ''}${set.statement || 'RESULT'}`));
    if (set.sql) {
      const sql = el('span', 'set-sql', set.sql);
      sql.title = set.sql;
      head.appendChild(sql);
    }
    wrap.appendChild(head);

    const fields = Array.isArray(set.fields) ? set.fields : [];
    const rows = Array.isArray(set.rows) ? set.rows : [];

    if (fields.length) {
      if (rows.length) {
        wrap.appendChild(renderTable(fields, rows));
      } else {
        wrap.appendChild(el('div', 'affected', '没有匹配的行'));
      }
      // rowCount 是数据库返回的总数，rows 是实际取回的（受 LIMIT 与前端上限限制）
      if (typeof set.rowCount === 'number' && set.rowCount > rows.length) {
        wrap.appendChild(
          el(
            'div',
            'stats-line truncated',
            `共 ${set.rowCount} 行，此处显示前 ${rows.length} 行；完整结果请用「新建查询」。`,
          ),
        );
      }
    } else if (typeof set.affectedRows === 'number') {
      wrap.appendChild(el('div', 'affected', `影响 ${set.affectedRows} 行`));
    } else {
      wrap.appendChild(el('div', 'affected', '语句已执行'));
    }

    for (const notice of Array.isArray(set.notices) ? set.notices : []) {
      wrap.appendChild(el('div', 'notice-line', notice));
    }
    return wrap;
  }

  function renderTable(fields, rows) {
    const wrap = el('div', 'table-wrap');
    const table = document.createElement('table');

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.appendChild(el('th', 'rowno', '#'));
    for (const field of fields) {
      headRow.appendChild(el('th', null, String(field)));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.slice(0, MAX_RENDER_ROWS).forEach((row, index) => {
      const tr = document.createElement('tr');
      tr.appendChild(el('td', 'rowno', String(index + 1)));
      fields.forEach((field, ci) => {
        const value = Array.isArray(row) ? row[ci] : row == null ? null : row[field];
        if (value === null || value === undefined) {
          tr.appendChild(el('td', 'null', 'NULL'));
          return;
        }
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        const td = el('td', 'cell', text);
        td.title = text;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  // ---------------------------------------------------------------- 交互

  function submit() {
    const sql = input.value.trim();
    if (!sql) {
      input.focus();
      return;
    }
    if (history[history.length - 1] !== sql) {
      history.push(sql);
      if (history.length > HISTORY_LIMIT) {
        history.shift();
      }
    }
    historyIndex = history.length;
    draft = '';
    persist();
    input.value = '';
    input.style.height = 'auto';
    input.focus();
    vscode.postMessage({ type: 'submit', sql });
  }

  function navigate(delta) {
    if (!history.length) {
      return;
    }
    if (historyIndex === history.length) {
      draft = input.value;
    }
    const next = Math.min(Math.max(historyIndex + delta, 0), history.length);
    if (next === historyIndex) {
      return;
    }
    historyIndex = next;
    input.value = historyIndex === history.length ? draft : history[historyIndex];
    input.setSelectionRange(input.value.length, input.value.length);
    adjustInputHeight();
  }

  function onCaretFirstLine() {
    return input.value.slice(0, input.selectionStart).indexOf('\n') === -1;
  }

  function onCaretLastLine() {
    return input.value.slice(input.selectionStart).indexOf('\n') === -1;
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      // 终端习惯：Enter 直接执行；要写多行用 Shift+Enter
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === 'ArrowUp' && onCaretFirstLine()) {
      event.preventDefault();
      navigate(-1);
      return;
    }
    if (event.key === 'ArrowDown' && onCaretLastLine()) {
      event.preventDefault();
      navigate(1);
    }
  });

  input.addEventListener('input', adjustInputHeight);

  clearBtn.addEventListener('click', () => {
    resetOutput();
    vscode.postMessage({ type: 'clear' });
    input.focus();
  });
  helpBtn.addEventListener('click', () => {
    const sql = '\\?';
    vscode.postMessage({ type: 'submit', sql });
    input.focus();
  });

  // 点单元格复制：把值取出来比手工拖选快得多
  output.addEventListener('click', (event) => {
    const cell = event.target.closest('td.cell');
    if (!cell) {
      return;
    }
    vscode.postMessage({ type: 'copy', text: cell.textContent });
    const text = cell.textContent;
    showToast(`已复制：${text.length > 40 ? `${text.slice(0, 40)}…` : text}`);
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'hydrate':
        host = message.host || host;
        renderHost();
        resetOutput();
        for (const entry of message.entries || []) {
          upsertEntry(entry);
        }
        output.scrollTop = output.scrollHeight;
        break;
      case 'host':
        host = message.host || host;
        renderHost();
        break;
      case 'entry':
        upsertEntry(message.entry);
        break;
      case 'cleared':
        resetOutput();
        break;
      default:
        break;
    }
  });

  renderHost();
  vscode.postMessage({ type: 'ready' });
  input.focus();
})();
