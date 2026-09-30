// 对象属性 / 表结构编辑器前端：纯原生 JS，无外部依赖。
// 职责边界：只负责渲染模型、收集输入、把「目标状态」回传扩展侧。
// 差异计算与 DDL 生成全在扩展侧（驱动层），这里不认识任何数据库方言。
(function () {
  const vscode = acquireVsCodeApi();
  const model = JSON.parse(document.getElementById('bootstrap').textContent);

  const state = {
    model,
    busy: false,
    /** 属性键 → 表单控件，收集时按它取值。 */
    propertyControls: new Map(),
  };

  const el = {
    title: document.getElementById('objectTitle'),
    objectLabel: document.getElementById('objectLabel'),
    objectSource: document.getElementById('objectSource'),
    readOnlyBanner: document.getElementById('readOnlyBanner'),
    limitsCard: document.getElementById('limitsCard'),
    limits: document.getElementById('limits'),
    properties: document.getElementById('properties'),
    columnsCard: document.getElementById('columnsCard'),
    columns: document.getElementById('columns'),
    columnsHint: document.getElementById('columnsHint'),
    autoIncHead: document.getElementById('autoIncHead'),
    dataTypes: document.getElementById('dataTypes'),
    addColumn: document.getElementById('addColumn'),
    changes: document.getElementById('changes'),
    sqlPreview: document.getElementById('sqlPreview'),
    warnings: document.getElementById('warnings'),
    ddlCard: document.getElementById('ddlCard'),
    ddl: document.getElementById('ddl'),
    resultBox: document.getElementById('resultBox'),
    footHint: document.getElementById('footHint'),
    reset: document.getElementById('reset'),
    preview: document.getElementById('preview'),
    apply: document.getElementById('apply'),
  };

  const isTable = model.mode === 'table';

  // ------------------------------------------------------------ 事件绑定

  el.preview.addEventListener('click', () => submit('preview'));
  el.apply.addEventListener('click', () => submit('apply'));
  el.reset.addEventListener('click', () => {
    clearResult();
    vscode.postMessage({ type: 'reload' });
  });
  if (el.addColumn) {
    el.addColumn.addEventListener('click', () => {
      appendColumnRow(newColumn(), true);
      clearResult();
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      vscode.postMessage({ type: 'cancel' });
    } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submit('preview');
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data || {};
    switch (message.type) {
      case 'model':
        renderAll(message.model);
        break;
      case 'plan':
        renderPlan(message.plan);
        setBusy(false);
        break;
      case 'applied':
        renderApplied(message.result);
        break;
      case 'notice':
        showResult(message.message || '已取消', 'busy');
        break;
      case 'error':
        showResult(message.message || '操作失败', 'error');
        break;
      case 'busy':
        setBusy(!!message.busy);
        break;
      default:
        break;
    }
  });

  // ------------------------------------------------------------ 渲染

  renderAll(state.model);

  function renderAll(next) {
    if (!next) {
      return;
    }
    state.model = next;
    el.title.textContent = next.title;
    el.objectLabel.textContent = next.objectLabel;
    el.objectSource.textContent = next.connectionLabel;
    el.readOnlyBanner.hidden = !next.readOnly;

    renderLimitations(next.limitations || []);
    renderProperties(next.properties || []);
    renderDataTypes(next.dataTypes || []);
    renderColumns(next.columns || []);
    renderDdl(next.ddl);

    el.columnsCard.hidden = next.mode !== 'table';
    // PostgreSQL 的既有列不能转自增，整列直接不出现，比给一个点了没用的开关好
    el.autoIncHead.hidden = !next.allowAutoIncrement;
    if (el.columnsHint) {
      el.columnsHint.textContent = next.allowReorder
        ? '改完点「生成 SQL」先看语句；「应用变更」会逐条落库。默认值按 SQL 表达式处理，文本会自动加引号。'
        : '本数据库不支持调整列顺序，顺序改动会被忽略。默认值按 SQL 表达式处理。';
    }

    clearPreview();
    setBusy(false);
  }

  function renderLimitations(limits) {
    el.limits.textContent = '';
    el.limitsCard.hidden = limits.length === 0;
    for (const text of limits) {
      const item = document.createElement('li');
      item.textContent = text;
      el.limits.appendChild(item);
    }
  }

  function renderProperties(properties) {
    el.properties.textContent = '';
    state.propertyControls.clear();

    for (const property of properties) {
      const field = document.createElement('label');
      field.className = 'field';

      const caption = document.createElement('span');
      caption.textContent = property.label;
      if (property.editable === false) {
        const lock = document.createElement('em');
        lock.className = 'lock';
        lock.textContent = ' 只读';
        caption.appendChild(lock);
      }
      field.appendChild(caption);

      const disabled = property.editable === false || state.model.readOnly;
      let control;
      if (property.kind === 'select') {
        control = document.createElement('select');
        const options = [...(property.options || [])];
        // 当前值可能不在候选里（例如权限受限看不到全部选项），补进去以免静默改值
        if (property.value && !options.includes(property.value)) {
          options.unshift(property.value);
        }
        if (!property.value) {
          options.unshift('');
        }
        for (const option of options) {
          const node = document.createElement('option');
          node.value = option;
          node.textContent = option || '（默认）';
          control.appendChild(node);
        }
        control.value = property.value || '';
      } else if (property.kind === 'switch') {
        control = document.createElement('input');
        control.type = 'checkbox';
        control.checked = !!property.value && property.value !== '0' && property.value !== 'false';
      } else if (property.kind === 'textarea') {
        control = document.createElement('textarea');
        control.rows = 2;
        control.value = property.value || '';
      } else {
        control = document.createElement('input');
        control.type = property.kind === 'number' ? 'number' : 'text';
        control.value = property.value || '';
      }

      control.disabled = disabled;
      // 记下「属性本身只读」，busy 结束后按它还原禁用状态
      control.dataset.locked = property.editable === false ? '1' : '0';
      if (property.placeholder) {
        control.placeholder = property.placeholder;
      }
      control.dataset.key = property.key;
      field.appendChild(control);

      if (property.hint) {
        const hint = document.createElement('small');
        hint.className = 'hint';
        hint.textContent = property.hint;
        field.appendChild(hint);
      }

      state.propertyControls.set(property.key, control);
      el.properties.appendChild(field);
    }
  }

  function renderDataTypes(types) {
    el.dataTypes.textContent = '';
    for (const type of types) {
      const option = document.createElement('option');
      option.value = type;
      el.dataTypes.appendChild(option);
    }
  }

  function renderColumns(columns) {
    el.columns.textContent = '';
    for (const column of columns) {
      appendColumnRow(column, false);
    }
  }

  function renderDdl(ddl) {
    if (!el.ddlCard) {
      return;
    }
    el.ddlCard.hidden = !ddl;
    el.ddl.textContent = ddl || '';
  }

  function clearPreview() {
    el.sqlPreview.textContent = '（点「生成 SQL」预览将要下发的语句）';
    el.changes.textContent = '';
    el.warnings.hidden = true;
    el.warnings.textContent = '';
  }

  function renderPlan(plan) {
    el.changes.textContent = (plan.changes || []).join('；');
    el.sqlPreview.textContent = plan.statements && plan.statements.length
      ? plan.statements.join('\n')
      : '（没有检测到任何变更）';
    const warnings = plan.warnings || [];
    el.warnings.hidden = warnings.length === 0;
    el.warnings.textContent = '';
    for (const text of warnings) {
      const item = document.createElement('li');
      item.textContent = text;
      el.warnings.appendChild(item);
    }
  }

  function renderApplied(result) {
    const summary = (result.changes || []).join('；') || '结构未变化';
    showResult(`已应用 ${result.executed} 条语句：${summary}`, 'ok');
    el.sqlPreview.textContent = (result.statements || []).join('\n') || '（无语句）';
  }

  function showResult(text, level) {
    el.resultBox.hidden = false;
    el.resultBox.className = 'result-box' + (level ? ' ' + level : '');
    el.resultBox.textContent = text;
    if (level === 'error') {
      el.resultBox.scrollIntoView({ block: 'nearest' });
    }
  }

  function clearResult() {
    el.resultBox.hidden = true;
    el.resultBox.textContent = '';
  }

  function setBusy(busy) {
    state.busy = busy;
    const readOnly = !!state.model.readOnly;
    el.preview.disabled = busy;
    el.apply.disabled = busy || readOnly;
    el.reset.disabled = busy;
    if (el.addColumn) {
      el.addColumn.disabled = busy || readOnly;
    }
    for (const control of state.propertyControls.values()) {
      control.disabled = busy || readOnly || control.dataset.locked === '1';
    }
    for (const row of el.columns.querySelectorAll('tr')) {
      for (const control of row.querySelectorAll('input, button')) {
        control.disabled = busy || readOnly;
      }
    }
    el.footHint.textContent = busy ? '正在处理…' : '改完先「生成 SQL」核对，再「应用变更」。';
  }

  // ------------------------------------------------------------ 列定义表格

  function newColumn() {
    return {
      name: '',
      dataType: '',
      nullable: true,
      defaultValue: null,
      comment: '',
      isPrimaryKey: false,
      autoIncrement: false,
    };
  }

  function appendColumnRow(column, focus) {
    const row = document.createElement('tr');
    // 原始列名是「这一行原本是哪一列」的唯一凭据：扩展侧靠它区分改名与「删旧增新」
    row.dataset.originalName = column.originalName || '';

    row.appendChild(cell('order', () => {
      const span = document.createElement('span');
      span.className = 'row-index';
      span.textContent = '';
      return span;
    }));

    const nameInput = textInput(column.name || '', '列名');
    nameInput.className = 'col-name-input';
    row.appendChild(wrap(nameInput, 'name'));
    row.appendChild(wrap(typeInput(column.dataType || ''), 'type'));
    row.appendChild(flagCell(checkbox(column.nullable !== false), 'nullable'));
    row.appendChild(defaultCell(column));
    row.appendChild(flagCell(checkbox(!!column.isPrimaryKey), 'primaryKey'));
    row.appendChild(flagCell(checkbox(!!column.autoIncrement), 'autoIncrement'));
    row.appendChild(wrap(textInput(column.comment || '', '注释'), 'comment'));
    row.appendChild(actionsCell(row));

    el.columns.appendChild(row);
    reindex();
    if (focus) {
      nameInput.focus();
    }
    return row;
  }

  function cell(className, build) {
    const td = document.createElement('td');
    td.className = className;
    td.appendChild(build());
    return td;
  }

  function wrap(control, role) {
    const td = document.createElement('td');
    td.appendChild(control);
    control.dataset.role = role;
    return td;
  }

  /**
   * 默认值单元格，顺带承载「额外子句」。
   *
   * MySQL 的 `ON UPDATE CURRENT_TIMESTAMP` 不属于类型 / 默认值 / 可空中的任何一项，
   * 但改写这一列时又必须原样写回，因此用一个隐藏域带回，并在旁边显式展示出来——
   * 用户至少要知道它存在，否则「我只是改了注释」会变成静默改表行为。
   */
  function defaultCell(column) {
    const value = column.defaultValue === null || column.defaultValue === undefined ? '' : String(column.defaultValue);
    const td = wrap(textInput(value, '默认值'), 'default');

    const extra = typeof column.extraClauses === 'string' ? column.extraClauses.trim() : '';
    const carrier = document.createElement('input');
    carrier.type = 'hidden';
    carrier.dataset.role = 'extra';
    carrier.value = extra;
    td.appendChild(carrier);
    if (extra) {
      const badge = document.createElement('small');
      badge.className = 'hint extra-clause';
      badge.textContent = extra;
      badge.title = '该子句会原样保留，暂不支持在界面上修改或移除';
      td.appendChild(badge);
    }
    return td;
  }

  function flagCell(control, role) {
    const td = document.createElement('td');
    td.className = 'col-flag';
    control.dataset.role = role;
    if (state.model.allowAutoIncrement === false && role === 'autoIncrement') {
      // 该数据库不支持改自增：不渲染开关，改用隐藏域原样带回读到的值，
      // 否则每次保存都会因为「自增被取消」而多出一条无意义的提示
      const carrier = document.createElement('input');
      carrier.type = 'hidden';
      carrier.dataset.role = role;
      carrier.dataset.fixed = '1';
      carrier.value = control.checked ? '1' : '0';
      td.appendChild(carrier);
      return td;
    }
    td.appendChild(control);
    return td;
  }

  function actionsCell(row) {
    const td = document.createElement('td');
    td.className = 'col-actions';

    if (state.model.allowReorder !== false) {
      const up = iconButton('↑', '上移', () => {
        const previous = row.previousElementSibling;
        if (previous) {
          el.columns.insertBefore(row, previous);
          reindex();
          clearPreview();
        }
      });
      const down = iconButton('↓', '下移', () => {
        const next = row.nextElementSibling;
        if (next) {
          el.columns.insertBefore(next, row);
          reindex();
          clearPreview();
        }
      });
      td.appendChild(up);
      td.appendChild(down);
    }

    td.appendChild(
      iconButton('✕', '删除该列', () => {
        row.remove();
        reindex();
        clearPreview();
      }),
    );
    return td;
  }

  function iconButton(text, title, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = text;
    button.title = title;
    button.addEventListener('click', handler);
    return button;
  }

  function textInput(value, placeholder) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder || '';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('input', clearResult);
    return input;
  }

  function typeInput(value) {
    const input = textInput(value, '如 varchar(255)');
    input.setAttribute('list', 'dataTypes');
    return input;
  }

  function checkbox(checked) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.addEventListener('change', clearResult);
    return input;
  }

  function reindex() {
    const rows = el.columns.querySelectorAll('tr');
    rows.forEach((row, index) => {
      const span = row.querySelector('.row-index');
      if (span) {
        span.textContent = String(index + 1);
      }
    });
  }

  // ------------------------------------------------------------ 收集与提交

  function collect() {
    const properties = {};
    for (const [key, control] of state.propertyControls) {
      properties[key] = control.type === 'checkbox' ? (control.checked ? '1' : '0') : control.value;
    }

    if (!isTable) {
      return { properties };
    }

    const columns = [];
    for (const row of el.columns.querySelectorAll('tr')) {
      const autoIncrement = readFlag(row, 'autoIncrement');
      columns.push({
        // 新增列没有 originalName，扩展侧据此判定「这是新列」
        originalName: row.dataset.originalName || undefined,
        name: readValue(row, 'name').trim(),
        dataType: readValue(row, 'type').trim(),
        nullable: readFlag(row, 'nullable'),
        defaultValue: readValue(row, 'default').trim() || null,
        isPrimaryKey: readFlag(row, 'primaryKey'),
        autoIncrement,
        comment: readValue(row, 'comment').trim(),
        // 驱动读回来的额外子句（MySQL 的 ON UPDATE）原样带回：丢了就是静默改表行为
        extraClauses: readValue(row, 'extra') || undefined,
      });
    }
    return { properties, columns };
  }

  function readValue(row, role) {
    const control = row.querySelector(`[data-role="${role}"]`);
    return control ? control.value : '';
  }

  function readFlag(row, role) {
    const control = row.querySelector(`[data-role="${role}"]`);
    if (!control) {
      return false;
    }
    // 隐藏域没有 checked，只能读 value（见 flagCell 的自增兜底）
    return control.dataset.fixed === '1' ? control.value === '1' : !!control.checked;
  }

  /** 前端只拦「一眼可见」的错，真正的校验在扩展侧（同一份规则不能有两处实现）。 */
  function localProblem(change) {
    if (!isTable) {
      return null;
    }
    if (!change.columns.length) {
      return '表至少要保留一列';
    }
    const seen = new Set();
    for (const column of change.columns) {
      if (!column.name) {
        return '每一列都要有列名';
      }
      const key = column.name.toLowerCase();
      if (seen.has(key)) {
        return `列名重复：${column.name}`;
      }
      seen.add(key);
      if (!column.dataType) {
        return `列 ${column.name} 缺少数据类型`;
      }
    }
    return null;
  }

  function submit(action) {
    if (state.busy || state.model.readOnly) {
      return;
    }
    const change = collect();
    const problem = localProblem(change);
    if (problem) {
      showResult(problem, 'error');
      return;
    }
    clearResult();
    setBusy(true);
    vscode.postMessage({ type: action, change });
  }

  vscode.postMessage({ type: 'ready' });
})();
