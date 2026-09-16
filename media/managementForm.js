// 管理表单前端逻辑：纯原生 JS，无外部依赖。
// 职责边界：收集输入、即时校验、调用扩展侧执行，不直接操作任何配置存储。
(function () {
  const vscode = acquireVsCodeApi();
  const bootstrap = JSON.parse(document.getElementById('bootstrap').textContent);

  const state = {
    busy: false,
    grants: [],
  };

  const el = {
    createDatabase: document.getElementById('createDatabase'),
    createUser: document.getElementById('createUser'),
    dbName: document.getElementById('dbName'),
    charset: document.getElementById('charset'),
    charsetLabel: document.getElementById('charsetLabel'),
    charsetHint: document.getElementById('charsetHint'),
    collation: document.getElementById('collation'),
    collationRow: document.getElementById('collationRow'),
    username: document.getElementById('username'),
    password: document.getElementById('password'),
    host: document.getElementById('host'),
    hostRow: document.getElementById('hostRow'),
    grants: document.getElementById('grants'),
    addGrant: document.getElementById('addGrant'),
    resultBox: document.getElementById('resultBox'),
    save: document.getElementById('save'),
    cancel: document.getElementById('cancel'),
  };

  const isDb = bootstrap.mode === 'createDatabase';
  const isPg = bootstrap.driverId === 'postgresql';

  // ------------------------------------------------------------ 初始化

  if (isDb) {
    el.charsetLabel.textContent = isPg ? '编码' : '字符集';
    el.charsetHint.textContent = isPg ? '留空使用 UTF8' : '留空使用 utf8mb4';
    el.collationRow.hidden = isPg;
    el.charset.placeholder = isPg ? 'UTF8' : 'utf8mb4';
  } else {
    el.hostRow.hidden = isPg;
    if (isPg) {
      el.host.value = '';
    }
    addGrantRow();
  }

  // ------------------------------------------------------------ 事件绑定

  el.save.addEventListener('click', submit);
  el.cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  el.addGrant.addEventListener('click', () => addGrantRow());

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA') {
      event.preventDefault();
      submit();
    } else if (event.key === 'Escape') {
      vscode.postMessage({ type: 'cancel' });
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    switch (message.type) {
      case 'saving':
        setBusy(true);
        showResult('正在执行…', 'busy');
        break;
      case 'saved':
        setBusy(false);
        break;
      case 'error':
        setBusy(false);
        showResult(message.message || '操作失败', 'error');
        break;
      default:
        break;
    }
  });

  // ------------------------------------------------------------ 授权条目

  function addGrantRow() {
    const index = state.grants.length;
    const row = document.createElement('div');
    row.className = 'grant-row';
    row.dataset.index = String(index);

    const targetLabel = isPg ? 'Schema' : '数据库';
    const targetPlaceholder = isPg ? 'public' : 'mydb';

    row.innerHTML = `
      <label class="field">
        <span>${targetLabel} <em>*</em></span>
        <input type="text" class="grant-target" list="targetOptions" autocomplete="off" spellcheck="false" placeholder="${targetPlaceholder}" />
      </label>
      <label class="field">
        <span>表（可选）</span>
        <input type="text" class="grant-table" autocomplete="off" spellcheck="false" placeholder="留空表示全部表" />
      </label>
      <label class="field">
        <span>权限 <em>*</em></span>
        <input type="text" class="grant-privileges" autocomplete="off" spellcheck="false" placeholder="ALL PRIVILEGES" value="ALL PRIVILEGES" />
      </label>
      <button type="button" class="secondary remove" title="删除此行">删除</button>
    `;

    row.querySelector('.remove').addEventListener('click', () => {
      row.remove();
      reindexGrants();
    });

    el.grants.appendChild(row);
    state.grants.push(row);
  }

  function reindexGrants() {
    state.grants = Array.from(el.grants.querySelectorAll('.grant-row'));
    state.grants.forEach((row, i) => (row.dataset.index = String(i)));
  }

  // ------------------------------------------------------------ 收集与提交

  function collect() {
    if (isDb) {
      return {
        dbName: el.dbName.value.trim(),
        charset: el.charset.value.trim(),
        collation: el.collation.value.trim(),
        username: '',
        password: '',
        host: '',
        grants: [],
      };
    }

    const grants = [];
    for (const row of el.grants.querySelectorAll('.grant-row')) {
      const target = row.querySelector('.grant-target').value.trim();
      const table = row.querySelector('.grant-table').value.trim();
      const privileges = row.querySelector('.grant-privileges').value.trim();
      if (target && privileges) {
        grants.push({ target, table, privileges });
      }
    }

    return {
      dbName: '',
      charset: '',
      collation: '',
      username: el.username.value.trim(),
      password: el.password.value,
      host: isPg ? '' : el.host.value.trim(),
      grants,
    };
  }

  function validateLocally(values) {
    if (isDb) {
      if (!values.dbName) {
        el.dbName.classList.add('invalid');
        return '数据库名不能为空';
      }
      return null;
    }
    if (!values.username) {
      el.username.classList.add('invalid');
      return '用户名不能为空';
    }
    if (!values.password) {
      el.password.classList.add('invalid');
      return '密码不能为空';
    }
    return null;
  }

  function submit() {
    if (state.busy) {
      return;
    }
    clearInvalid();
    const values = collect();
    const error = validateLocally(values);
    if (error) {
      showResult(error, 'error');
      return;
    }
    setBusy(true);
    vscode.postMessage({ type: 'submit', values });
  }

  function clearInvalid() {
    for (const input of document.querySelectorAll('input.invalid')) {
      input.classList.remove('invalid');
    }
  }

  function showResult(text, level) {
    el.resultBox.hidden = false;
    el.resultBox.className = 'result-box' + (level ? ' ' + level : '');
    el.resultBox.textContent = text;
  }

  function setBusy(busy) {
    state.busy = busy;
    el.save.disabled = busy;
    el.cancel.disabled = busy;
    el.addGrant.disabled = busy;
  }
})();
