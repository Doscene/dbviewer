// 对象属性 / 表结构编辑器前端：纯原生 JS，无外部依赖。
// 职责边界：只负责渲染模型、收集输入、把「目标状态」回传扩展侧。
// 差异计算、类型文本拼装与 DDL 生成全在扩展侧（core/columnSpecs.ts + 驱动层），
// 这里不认识任何数据库方言 —— 连 varchar(255) 这个字符串都不是在这里拼的。
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
    addColumn: document.getElementById('addColumn'),
    sqlCard: document.getElementById('sqlCard'),
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

  /** 参数输入框的占位文案；按扩展侧给的参数形态取。 */
  const ARG_PLACEHOLDER = {
    length: '长度',
    precision: '精度,小数位',
    seconds: '秒精度 0-6',
  };

  const DEFAULT_HINT = {
    none: '不设默认值（可空列即为 NULL）',
    constant: '只填值，扩展侧会按列类型加引号',
    expression: '直接写 SQL 片段，如 CURRENT_TIMESTAMP',
  };

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
    renderColumns(next.columns || []);
    renderDdl(next.ddl);

    el.columnsCard.hidden = next.mode !== 'table';
    // PostgreSQL 的既有列不能转自增，整列直接不出现，比给一个点了没用的开关好
    el.autoIncHead.hidden = !next.allowAutoIncrement;
    if (el.columnsHint) {
      el.columnsHint.textContent = next.allowReorder
        ? '类型用下拉与参数框填写；无法用控件表达的类型会退回「原始文本」。默认值请选语义：常量只填值，表达式直接写 SQL 片段。'
        : '本数据库不支持调整列顺序，顺序改动会被忽略。类型无法用控件表达时会退回「原始文本」。';
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
    if (el.sqlCard) {
      el.sqlCard.open = false;
    }
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
    if (el.sqlCard) {
      el.sqlCard.open = true;
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
      for (const control of row.querySelectorAll('input, button, select')) {
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
      // 新列没有「原文」可回传，直接进结构化模式并视为已修改
      typeEditor: { mode: 'structured', raw: '', base: '', args: '', argsKind: 'none', unsigned: false },
      defaultEditor: { kind: 'none', value: '' },
      onUpdate: { supported: false, enabled: false },
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
    row.appendChild(typeCell(column));
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
   * 数据类型单元格。
   *
   * 结构化模式 = 类型下拉 + 参数框（+ unsigned + 值列表）；解析不出来的类型走原始文本。
   * 单元格自己记着 `data-touched`：只有被改过时才回传 typeSpec，没动过的列一律原样回传
   * 读回来的类型文本（`int(10) unsigned zerofill` 这类写法因此不会在保存时被改写）。
   */
  function typeCell(column) {
    const td = document.createElement('td');
    td.className = 'col-type';

    const wrapper = document.createElement('div');
    wrapper.className = 'cell-line';
    wrapper.dataset.role = 'typeCell';
    wrapper.dataset.mode = column.typeEditor && column.typeEditor.mode === 'raw' ? 'raw' : 'structured';
    // 已有列：没被改过就原样回传读回来的类型文本；新列：本来就是「待填写」
    wrapper.dataset.touched = column.originalName ? '0' : '1';
    td.appendChild(wrapper);

    const options = typeOptionList(column);
    const base = (column.typeEditor && column.typeEditor.base) || '';
    const current = options.find((option) => option.base === base) || options[0];

    const baseSelect = document.createElement('select');
    baseSelect.dataset.role = 'typeBase';
    for (const option of options) {
      const node = document.createElement('option');
      node.value = option.base;
      node.textContent = option.base || '（选择类型）';
      node.dataset.argsKind = option.argsKind;
      node.dataset.unsigned = option.unsigned ? '1' : '0';
      baseSelect.appendChild(node);
    }
    baseSelect.value = current ? current.base : '';
    wrapper.appendChild(baseSelect);

    const argsInput = document.createElement('input');
    argsInput.type = 'text';
    argsInput.className = 'arg-input';
    argsInput.dataset.role = 'typeArgs';
    argsInput.value = (column.typeEditor && column.typeEditor.args) || '';
    argsInput.autocomplete = 'off';
    argsInput.spellcheck = false;
    wrapper.appendChild(argsInput);

    const unsignedWrap = document.createElement('label');
    unsignedWrap.className = 'switch-label';
    unsignedWrap.dataset.role = 'typeUnsignedWrap';
    const unsigned = checkbox(!!(column.typeEditor && column.typeEditor.unsigned));
    unsigned.dataset.role = 'typeUnsigned';
    unsignedWrap.appendChild(unsigned);
    unsignedWrap.appendChild(document.createTextNode('unsigned'));
    wrapper.appendChild(unsignedWrap);

    const valuesButton = ghostButton('值 (0)…', '编辑 enum / set 的取值', () => {
      wrapper.dataset.enumOpen = wrapper.dataset.enumOpen === '1' ? '0' : '1';
      refreshTypeCell(td);
      clearResult();
    });
    valuesButton.dataset.role = 'typeValues';
    wrapper.appendChild(valuesButton);

    const rawToggle = ghostButton('原始', '改成直接填写类型文本', () => {
      wrapper.dataset.mode = 'raw';
      wrapper.dataset.touched = '1';
      refreshTypeCell(td);
      clearResult();
    });
    rawToggle.dataset.role = 'typeRawToggle';
    wrapper.appendChild(rawToggle);

    const rawInput = document.createElement('input');
    rawInput.type = 'text';
    rawInput.className = 'type-raw-input';
    rawInput.dataset.role = 'typeRaw';
    rawInput.value = (column.typeEditor && column.typeEditor.raw) || '';
    rawInput.placeholder = '如 varchar(255)';
    rawInput.autocomplete = 'off';
    rawInput.spellcheck = false;
    wrapper.appendChild(rawInput);

    const enumCarrier = document.createElement('input');
    enumCarrier.type = 'hidden';
    enumCarrier.dataset.role = 'typeEnumValues';
    enumCarrier.value = JSON.stringify((column.typeEditor && column.typeEditor.enumValues) || []);
    wrapper.appendChild(enumCarrier);

    const suffixCarrier = document.createElement('input');
    suffixCarrier.type = 'hidden';
    suffixCarrier.dataset.role = 'typeSuffix';
    suffixCarrier.value = (column.typeEditor && column.typeEditor.suffix) || '';
    wrapper.appendChild(suffixCarrier);

    // 读回来的类型原文：类型控件没被改过时由扩展侧原样使用
    const originalCarrier = document.createElement('input');
    originalCarrier.type = 'hidden';
    originalCarrier.dataset.role = 'typeOriginal';
    originalCarrier.value = (column.typeEditor && column.typeEditor.raw) || column.dataType || '';
    td.appendChild(originalCarrier);

    const note = document.createElement('small');
    note.className = 'hint';
    note.dataset.role = 'typeNote';
    note.dataset.text =
      (column.typeEditor && column.typeEditor.note) || '这个类型无法用控件表达，已退回文本填写。';
    note.hidden = true;
    td.appendChild(note);

    td.appendChild(enumEditor(td, column));
    bindTypeEvents(td);
    refreshTypeCell(td);
    return td;
  }

  function enumEditor(td, column) {
    const box = document.createElement('div');
    box.className = 'enum-editor';
    box.dataset.role = 'enumEditor';
    box.hidden = true;

    const rows = document.createElement('div');
    rows.dataset.role = 'enumRows';
    box.appendChild(rows);

    const add = ghostButton('添加取值', '追加一个枚举值', () => {
      appendEnumRow(rows, '', td);
      syncEnumValues(td);
      clearResult();
    });
    add.dataset.role = 'enumAdd';
    box.appendChild(add);

    for (const value of (column.typeEditor && column.typeEditor.enumValues) || []) {
      appendEnumRow(rows, value, td);
    }
    if (!rows.childElementCount) {
      appendEnumRow(rows, '', td);
    }
    syncEnumValues(td);
    return box;
  }

  function appendEnumRow(rows, value, td) {
    const line = document.createElement('div');
    line.className = 'enum-row';
    line.dataset.role = 'enumRow';

    const input = textInput(value, '取值');
    input.dataset.role = 'enumValue';
    // 边打字边同步隐藏域：收集时只读隐藏域，漏一次就等于丢一个取值
    input.addEventListener('input', () => syncEnumValues(td || rows.closest('td')));
    line.appendChild(input);

    const remove = ghostButton('✕', '删除该取值', () => {
      line.remove();
      syncEnumValues(td || rows.closest('td'));
      clearResult();
    });
    remove.dataset.role = 'enumRemove';
    line.appendChild(remove);

    rows.appendChild(line);
    return line;
  }

  /** 取值列表写回隐藏域（JSON：取值里可能带换行，用换行拼接会失真）。 */
  function syncEnumValues(td) {
    if (!td) {
      return;
    }
    const values = [];
    for (const line of td.querySelectorAll('[data-role="enumRow"]')) {
      values.push(line.querySelector('[data-role="enumValue"]').value);
    }
    cellNode(td, 'typeEnumValues').value = JSON.stringify(values);
    cellNode(td, 'typeValues').textContent = `值 (${values.length})…`;
    markTouched(td);
  }

  function bindTypeEvents(td) {
    const wrapper = cellNode(td, 'typeCell');
    const baseSelect = cellNode(td, 'typeBase');
    const argsInput = cellNode(td, 'typeArgs');
    const rawInput = cellNode(td, 'typeRaw');
    const unsigned = cellNode(td, 'typeUnsigned');

    baseSelect.addEventListener('change', () => {
      // 换了基础类型，原来那个类型特有的尾部修饰（with time zone）与取值列表都不再适用
      cellNode(td, 'typeSuffix').value = '';
      const option = currentTypeOption(td);
      if (option && option.argsKind !== 'values') {
        cellNode(td, 'typeEnumValues').value = '[]';
      }
      markTouched(td);
      refreshTypeCell(td);
      clearResult();
    });
    for (const control of [argsInput, rawInput, unsigned]) {
      control.addEventListener('input', () => {
        wrapper.dataset.touched = '1';
        clearResult();
      });
      control.addEventListener('change', () => {
        wrapper.dataset.touched = '1';
        clearResult();
      });
    }
  }

  /** 按当前模式与类型刷新参数框、unsigned、取值入口的可见性。 */
  function refreshTypeCell(td) {
    const wrapper = cellNode(td, 'typeCell');
    const raw = wrapper.dataset.mode === 'raw';
    const option = currentTypeOption(td);
    const argsKind = option ? option.argsKind : 'none';

    cellNode(td, 'typeBase').hidden = raw;
    const argsInput = cellNode(td, 'typeArgs');
    argsInput.hidden = raw || !ARG_PLACEHOLDER[argsKind];
    argsInput.placeholder = ARG_PLACEHOLDER[argsKind] || '';
    cellNode(td, 'typeUnsignedWrap').hidden = raw || !supportsUnsigned(td, option);
    cellNode(td, 'typeValues').hidden = raw || argsKind !== 'values';
    cellNode(td, 'typeRawToggle').hidden = raw;
    cellNode(td, 'typeRaw').hidden = !raw;
    cellNode(td, 'enumEditor').hidden = raw || argsKind !== 'values' || wrapper.dataset.enumOpen !== '1';

    const note = cellNode(td, 'typeNote');
    note.hidden = !raw;
    if (raw) {
      note.textContent = note.dataset.text || '';
    }
  }

  /** 当前下拉选中的选项。 */
  function currentTypeOption(td) {
    const select = cellNode(td, 'typeBase');
    const selected = select.options[select.selectedIndex];
    if (!selected) {
      return undefined;
    }
    return {
      base: selected.value,
      argsKind: selected.dataset.argsKind || 'none',
      unsigned: selected.dataset.unsigned === '1',
    };
  }

  /** unsigned 只在数值类型上有意义；当前列已经是 unsigned 时也要保留勾选框。 */
  function supportsUnsigned(td, option) {
    return !!(option && option.unsigned) || !!cellNode(td, 'typeUnsigned').checked;
  }

  /** 类型下拉的候选：模型给的选项 + 当前列自己的基础类型（不在候选里时补进去）。 */
  function typeOptionList(column) {
    const options = (state.model.typeOptions || []).map((option) => ({ ...option }));
    const editor = column.typeEditor || {};
    const base = editor.base;
    if (base && !options.some((option) => option.base === base)) {
      options.unshift({ base, argsKind: editor.argsKind || 'none', unsigned: !!editor.unsigned });
    }
    if (!base) {
      options.unshift({ base: '', argsKind: 'none', unsigned: false });
    }
    return options;
  }

  function cellNode(td, role) {
    return td.querySelector(`[data-role="${role}"]`);
  }

  function markTouched(td) {
    const wrapper = cellNode(td, 'typeCell');
    if (wrapper) {
      wrapper.dataset.touched = '1';
    }
  }

  /**
   * 默认值单元格。
   *
   * 三选一（无 / 常量 / 表达式）+ 值输入；MySQL 的时间列额外给「自动更新为当前时间」开关。
   * 与类型单元格同一套规矩：没动过就原样回传读回来的默认值，`extraClauses` 也原样带走。
   */
  function defaultCell(column) {
    const td = document.createElement('td');
    td.className = 'col-default';

    const editor = column.defaultEditor || { kind: 'none', value: '' };
    const wrapper = document.createElement('div');
    wrapper.className = 'cell-line';
    wrapper.dataset.role = 'defaultCell';
    wrapper.dataset.touched = '0';
    td.appendChild(wrapper);

    const kind = document.createElement('select');
    kind.dataset.role = 'defaultKind';
    for (const [value, text] of [['none', '无默认值'], ['constant', '常量'], ['expression', '表达式']]) {
      const node = document.createElement('option');
      node.value = value;
      node.textContent = text;
      kind.appendChild(node);
    }
    kind.value = editor.kind || 'none';
    wrapper.appendChild(kind);

    const value = textInput(editor.kind === 'none' ? '' : editor.value || '', DEFAULT_HINT[editor.kind || 'none']);
    value.dataset.role = 'defaultValue';
    wrapper.appendChild(value);

    // 读回来的默认值原文：未触碰时原样回传；`data-empty` 区分「没有默认值」与「空串」
    const original = document.createElement('input');
    original.type = 'hidden';
    original.dataset.role = 'defaultOriginal';
    original.dataset.empty = column.defaultValue === null || column.defaultValue === undefined ? '1' : '0';
    original.value = column.defaultValue === null || column.defaultValue === undefined ? '' : String(column.defaultValue);
    td.appendChild(original);

    const onUpdate = column.onUpdate || { supported: false, enabled: false };
    if (onUpdate.supported) {
      const label = document.createElement('label');
      label.className = 'switch-label';
      label.dataset.role = 'onUpdateWrap';
      // 记下初始状态：只有翻转时才回传开关，没动过就原样保留 extraClauses
      label.dataset.enabled = onUpdate.enabled ? '1' : '0';
      const box = checkbox(!!onUpdate.enabled);
      box.dataset.role = 'onUpdate';
      box.addEventListener('click', () => clearResult());
      label.appendChild(box);
      label.appendChild(document.createTextNode('自动更新为当前时间'));
      td.appendChild(label);
    }

    // 无法用开关表达的额外子句（MySQL 的 ON UPDATE 之外的形态）原样带回并标注
    const extra = column.extraClauses || '';
    const carrier = document.createElement('input');
    carrier.type = 'hidden';
    carrier.dataset.role = 'extra';
    carrier.value = extra;
    td.appendChild(carrier);
    if (extra && !(column.onUpdate && column.onUpdate.supported)) {
      const badge = document.createElement('small');
      badge.className = 'hint extra-clause';
      badge.textContent = extra;
      badge.title = '该子句会原样保留，暂不支持在界面上修改或移除';
      td.appendChild(badge);
    }

    kind.addEventListener('change', () => {
      wrapper.dataset.touched = '1';
      value.placeholder = DEFAULT_HINT[kind.value] || '';
      if (kind.value === 'none') {
        value.value = '';
      }
      clearResult();
    });
    value.addEventListener('input', () => {
      wrapper.dataset.touched = '1';
      clearResult();
    });
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

  function ghostButton(text, title, handler) {
    return iconButton(text, title, handler);
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
      const typeCellEl = row.querySelector('[data-role="typeCell"]');
      const mode = typeCellEl.dataset.mode;
      const touchedType = typeCellEl.dataset.touched === '1';
      let typeSpec;
      if (mode === 'raw') {
        typeSpec = { mode: 'raw', text: readValue(row, 'typeRaw') };
      } else if (touchedType) {
        typeSpec = {
          mode: 'structured',
          base: readValue(row, 'typeBase'),
          args: readValue(row, 'typeArgs'),
          unsigned: readFlag(row, 'typeUnsigned'),
          enumValues: parseEnumCarrier(readValue(row, 'typeEnumValues')),
          suffix: readValue(row, 'typeSuffix'),
        };
      }

      const defaultCellEl = row.querySelector('[data-role="defaultCell"]');
      const touchedDefault = defaultCellEl.dataset.touched === '1';
      const defaultSpec = touchedDefault
        ? { kind: readValue(row, 'defaultKind') || 'none', value: readValue(row, 'defaultValue') }
        : undefined;

      const onUpdateWrap = row.querySelector('[data-role="onUpdateWrap"]');
      let onUpdateTimestamp;
      if (onUpdateWrap) {
        const next = readFlag(row, 'onUpdate') ? '1' : '0';
        if (next !== onUpdateWrap.dataset.enabled) {
          onUpdateTimestamp = next === '1';
        }
      }

      const original = row.querySelector('[data-role="defaultOriginal"]');
      const column = {
        // 新增列没有 originalName，扩展侧据此判定「这是新列」
        originalName: row.dataset.originalName || undefined,
        name: readValue(row, 'name').trim(),
        // 读回来的类型文本：只有类型控件没被改过时才会被用到
        dataType: readValue(row, 'typeOriginal'),
        nullable: readFlag(row, 'nullable'),
        // 「没有默认值」与「默认值为空串」不能合并成同一个值
        defaultValue: original.dataset.empty === '1' ? null : original.value,
        isPrimaryKey: readFlag(row, 'primaryKey'),
        autoIncrement: readFlag(row, 'autoIncrement'),
        comment: readValue(row, 'comment').trim(),
        // 驱动读回来的额外子句原样带回：丢了（且开关不支持它时）就是静默改表行为
        extraClauses: readValue(row, 'extra') || undefined,
      };
      if (typeSpec) {
        column.typeSpec = typeSpec;
      }
      if (defaultSpec) {
        column.defaultSpec = defaultSpec;
      }
      if (onUpdateTimestamp !== undefined) {
        column.onUpdateTimestamp = onUpdateTimestamp;
      }
      columns.push(column);
    }
    return { properties, columns };
  }

  function parseEnumCarrier(text) {
    try {
      const values = JSON.parse(text || '[]');
      return Array.isArray(values) ? values : [];
    } catch (err) {
      return [];
    }
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
      // 结构化模式下类型可能还没从下拉里选（新列），这里先拦一道
      const typed = column.typeSpec
        ? column.typeSpec.mode === 'raw'
          ? !!column.typeSpec.text.trim()
          : !!column.typeSpec.base
        : !!column.dataType.trim();
      if (!typed) {
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
