// 连接表单前端逻辑：纯原生 JS，无外部依赖。
// 职责边界：收集输入、即时校验、调用扩展侧能力（别名解析 / 测试连接 / 保存），
// 不直接操作任何配置存储。
(function () {
  const vscode = acquireVsCodeApi();

  const bootstrap = JSON.parse(document.getElementById('bootstrap').textContent);
  const state = {
    passwordTouched: false,
    /** 保存与测试期间锁定按钮，避免重复提交。 */
    busy: false,
    /** 用户是否手动改过端口；改过则切换驱动时不覆盖，避免抹掉用户输入。 */
    portTouched: false,
  };

  const el = {
    envLine: document.getElementById('envLine'),
    name: document.getElementById('name'),
    driver: document.getElementById('driver'),
    driverIcon: document.getElementById('driverIcon'),
    driverDesc: document.getElementById('driverDesc'),
    host: document.getElementById('host'),
    hostFeedback: document.getElementById('hostFeedback'),
    port: document.getElementById('port'),
    aliasBar: document.getElementById('aliasBar'),
    user: document.getElementById('user'),
    password: document.getElementById('password'),
    passwordHint: document.getElementById('passwordHint'),
    togglePassword: document.getElementById('togglePassword'),
    database: document.getElementById('database'),
    databaseHint: document.getElementById('databaseHint'),
    databaseOptions: document.getElementById('databaseOptions'),
    group: document.getElementById('group'),
    extraFields: document.getElementById('extraFields'),
    ssl: document.getElementById('ssl'),
    readOnly: document.getElementById('readOnly'),
    resultBox: document.getElementById('resultBox'),
    test: document.getElementById('test'),
    cancel: document.getElementById('cancel'),
    save: document.getElementById('save'),
    saveAndConnect: document.getElementById('saveAndConnect'),
  };

  // ------------------------------------------------------------ 初始化

  const initial = bootstrap.initial || {};

  el.envLine.textContent = bootstrap.contextInfo.environment;
  renderAliases();
  renderDrivers();

  el.name.value = initial.name || '';
  el.host.value = initial.host || '127.0.0.1';
  el.port.value = String(initial.port || currentDriver().defaultPort);
  el.user.value = initial.user || defaultUser();
  el.database.value = initial.database || '';
  el.group.value = initial.group || '';
  el.ssl.checked = !!initial.ssl;
  el.readOnly.checked = !!initial.readOnly;

  el.passwordHint.textContent = bootstrap.passwordSaved
    ? '已保存密码；留空表示不修改'
    : '可留空，连接时再输入会失败';

  renderExtraFields(initial.options || {});
  refreshDriverMeta();
  requestHostResolution();

  // ------------------------------------------------------------ 事件绑定

  el.driver.addEventListener('change', () => {
    // 端口只在用户没手动改过时才跟随驱动默认值
    if (!state.portTouched || !el.port.value) {
      el.port.value = String(currentDriver().defaultPort);
    }
    if (!isUserEdited(el.user)) {
      el.user.value = defaultUser();
    }
    renderExtraFields({});
    refreshDriverMeta();
  });

  el.host.addEventListener('input', debounce(requestHostResolution, 220));
  el.host.addEventListener('blur', requestHostResolution);

  el.port.addEventListener('input', () => {
    state.portTouched = true;
  });

  el.password.addEventListener('input', () => {
    state.passwordTouched = true;
  });

  el.togglePassword.addEventListener('click', () => {
    const show = el.password.type === 'password';
    el.password.type = show ? 'text' : 'password';
    el.togglePassword.textContent = show ? '隐藏' : '显示';
  });

  el.test.addEventListener('click', runTest);
  el.save.addEventListener('click', () => submit(false));
  el.saveAndConnect.addEventListener('click', () => submit(true));
  el.cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  // 回车提交，Esc 取消——表单的基本礼节
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA') {
      event.preventDefault();
      submit(event.ctrlKey || event.metaKey);
    } else if (event.key === 'Escape') {
      vscode.postMessage({ type: 'cancel' });
    }
  });

  ["name", "host", "port", "user"].forEach((key) => {
    el[key].addEventListener("input", () => el[key].classList.remove("invalid"));
  });

  // ------------------------------------------------------------ 扩展消息

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    switch (message.type) {
      case 'hostResolved':
        showHostFeedback(message);
        break;
      case 'testing':
        setBusy(true);
        showResult('正在连接…', 'busy');
        break;
      case 'testResult':
        setBusy(false);
        handleTestResult(message);
        break;
      case 'saved':
        setBusy(false);
        break;
      case 'error':
        setBusy(false);
        showResult(message.message || '操作失败', 'error');
        focusFirstInvalid(message.message);
        break;
      default:
        break;
    }
  });

  // ------------------------------------------------------------ 渲染

  function currentDriver() {
    return bootstrap.drivers.find((d) => d.id === el.driver.value) || bootstrap.drivers[0];
  }

  function renderDrivers() {
    el.driver.innerHTML = '';
    for (const driver of bootstrap.drivers) {
      const option = document.createElement('option');
      option.value = driver.id;
      option.textContent = driver.displayName;
      option.title = driver.description || driver.id;
      el.driver.appendChild(option);
    }
    if (initial.driver) {
      el.driver.value = initial.driver;
    }
  }

  function refreshDriverMeta() {
    const driver = currentDriver();
    el.driverDesc.textContent = driver.description || '';
    el.host.placeholder = driver.sampleHost || '127.0.0.1';
    // 图标随驱动切换，缺失时隐藏而不是留一个破图占位
    if (driver.iconUri) {
      el.driverIcon.src = driver.iconUri;
      el.driverIcon.hidden = false;
    } else {
      el.driverIcon.removeAttribute('src');
      el.driverIcon.hidden = true;
    }
  }

  function renderAliases() {
    el.aliasBar.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'alias-label';
    label.textContent = '可用别名：';
    el.aliasBar.appendChild(label);

    for (const item of bootstrap.contextInfo.aliases) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'alias-chip';
      chip.title = item.note;
      chip.innerHTML = `${item.alias} <small>→ ${item.resolved}</small>`;
      chip.addEventListener('click', () => {
        el.host.value = item.alias;
        el.host.classList.remove('invalid');
        requestHostResolution();
      });
      el.aliasBar.appendChild(chip);
    }

    // 环境提示（如「数据库在 Windows 上请填 __windows_host__」）
    if (bootstrap.contextInfo.tips.length) {
      const tip = document.createElement('small');
      tip.className = 'hint';
      tip.style.marginLeft = '4px';
      tip.textContent = bootstrap.contextInfo.tips.join('；');
      el.aliasBar.appendChild(tip);
    }
  }

  /** 按驱动声明渲染私有字段，值在切换驱动时重置。 */
  function renderExtraFields(values) {
    el.extraFields.innerHTML = '';
    const fields = (bootstrap.extraFields && bootstrap.extraFields[el.driver.value]) || [];
    if (fields.length === 0) {
      const empty = document.createElement('small');
      empty.className = 'hint';
      empty.textContent = '该驱动暂无额外参数。';
      el.extraFields.appendChild(empty);
      return;
    }
    for (const field of fields) {
      const wrap = document.createElement('label');
      wrap.className = 'field';
      const label = document.createElement('span');
      label.textContent = field.label;
      const input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.dataset.optionKey = field.key;
      input.placeholder = field.placeholder || '';
      input.value = values[field.key] || '';
      wrap.appendChild(label);
      wrap.appendChild(input);
      if (field.hint) {
        const hint = document.createElement('small');
        hint.className = 'hint';
        hint.textContent = field.hint;
        wrap.appendChild(hint);
      }
      el.extraFields.appendChild(wrap);
    }
  }

  function defaultUser() {
    return currentDriver().id === 'postgresql' ? 'postgres' : 'root';
  }

  function isUserEdited(input) {
    return input.value && input.value !== 'root' && input.value !== 'postgres';
  }

  // ------------------------------------------------------------ 主机解析

  function requestHostResolution() {
    vscode.postMessage({ type: 'resolveHost', host: el.host.value });
  }

  function showHostFeedback(message) {
    const input = message.input === undefined ? '' : String(message.input);
    // 输入框内容已变化时丢弃过期响应，避免快速输入时提示闪回
    if (input !== el.host.value) {
      return;
    }
    if (!input.trim()) {
      el.hostFeedback.textContent = '';
      el.hostFeedback.className = 'hint';
      return;
    }
    if (message.warning) {
      el.hostFeedback.textContent = message.warning;
      el.hostFeedback.className = 'hint warn';
      return;
    }
    if (message.note) {
      el.hostFeedback.textContent = message.note;
      el.hostFeedback.className = 'hint ok';
      return;
    }
    el.hostFeedback.textContent = message.resolved ? `将连接 ${message.resolved}` : '';
    el.hostFeedback.className = 'hint';
  }

  // ------------------------------------------------------------ 收集与提交

  function collect() {
    const options = {};
    for (const input of el.extraFields.querySelectorAll('input[data-option-key]')) {
      const value = input.value.trim();
      if (value) {
        options[input.dataset.optionKey] = value;
      }
    }
    return {
      name: el.name.value.trim(),
      driver: el.driver.value,
      host: el.host.value.trim(),
      port: Number(el.port.value),
      user: el.user.value.trim(),
      password: el.password.value,
      database: el.database.value.trim(),
      group: el.group.value.trim(),
      ssl: el.ssl.checked,
      readOnly: el.readOnly.checked,
      options: options,
    };
  }

  /** 本地先校验一遍，把问题落到具体字段上而不是只弹一条总错误。 */
  function validateLocally(values) {
    const problems = [];
    if (!values.name) {
      problems.push(['name', '连接名称不能为空']);
    }
    if (!values.host) {
      problems.push(['host', '主机不能为空']);
    }
    if (!Number.isInteger(values.port) || values.port <= 0 || values.port > 65535) {
      problems.push(['port', '端口需为 1-65535 的整数']);
    }
    if (!values.user) {
      problems.push(['user', '用户名不能为空']);
    }
    return problems;
  }

  function submit(connectNow) {
    if (state.busy) {
      return;
    }
    const values = collect();
    const problems = validateLocally(values);
    if (problems.length) {
      problems.forEach(([key, message]) => {
        el[key].classList.add('invalid');
        el[key].title = message;
      });
      showResult(problems[0][1], 'error');
      el[problems[0][0]].focus();
      return;
    }
    setBusy(true);
    vscode.postMessage({
      type: 'submit',
      values: values,
      passwordTouched: state.passwordTouched,
      connectNow: connectNow,
    });
  }

  function runTest() {
    if (state.busy) {
      return;
    }
    const values = collect();
    const problems = validateLocally(values);
    if (problems.length) {
      showResult(problems[0][1], 'error');
      el[problems[0][0]].focus();
      return;
    }
    vscode.postMessage({ type: 'test', values: values });
  }

  function handleTestResult(result) {
    if (result.ok) {
      const lines = [`连接成功（${result.host}）`];
      if (result.hostNote) {
        lines.push(result.hostNote);
      }
      if (result.databases && result.databases.length) {
        lines.push(`发现 ${result.databases.length} 个数据库，已更新候选列表`);
        fillDatabases(result.databases);
      }
      showResult(lines.join('\n'), 'ok');
    } else {
      const lines = [result.message];
      if (result.host && result.host !== el.host.value) {
        lines.push(`实际连接地址：${result.host}`);
      }
      showResult(lines.join('\n'), 'error');
    }
    if (result.warning) {
      el.hostFeedback.textContent = result.warning;
      el.hostFeedback.className = 'hint warn';
    }
  }

  function fillDatabases(databases) {
    el.databaseOptions.innerHTML = '';
    for (const name of databases) {
      const option = document.createElement('option');
      option.value = name;
      el.databaseOptions.appendChild(option);
    }
    el.databaseHint.textContent = '点击输入框可从候选中选择，或手工输入';
  }

  // ------------------------------------------------------------ 工具

  function showResult(text, level) {
    el.resultBox.hidden = false;
    el.resultBox.className = 'result-box' + (level ? ' ' + level : '');
    el.resultBox.textContent = text;
  }

  function setBusy(busy) {
    state.busy = busy;
    el.test.disabled = busy;
    el.save.disabled = busy;
    el.saveAndConnect.disabled = busy;
  }

  function focusFirstInvalid(message) {
    const map = [
      ['连接名称', el.name],
      ['主机', el.host],
      ['端口', el.port],
      ['用户名', el.user],
    ];
    for (const [keyword, input] of map) {
      if (message && message.includes(keyword)) {
        input.classList.add('invalid');
        input.focus();
        return;
      }
    }
  }

  function debounce(fn, wait) {
    let timer;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, wait);
    };
  }
})();
