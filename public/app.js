/* ============================================================
 * 班级就餐统计系统 · 前端逻辑
 * ============================================================ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------- 全局状态 ---------- */
let S = {
  settings: { breakfastPrice: 6, lunchPrice: 11 },
  standards: [
    { key: 'BL', label: '早餐+中餐' },
    { key: 'B', label: '仅早餐' },
    { key: 'L', label: '仅中餐' }
  ],
  defaultStandard: 'BL',
  classes: [],
  students: [],
  days: {},
  records: {},
  months: [],
  currentMonth: ''
};
let MONTH = '';
let currentPage = 'register';
let currentClassId = '';
let filterClassId = '';
let searchText = '';

const PAGES = {
  register: { title: '就餐登记', desc: '按班级、按月登记学生用餐标准与备注，费用自动计算', month: true },
  classes: { title: '班级管理', desc: '维护班级信息，设置各班级本月应就餐天数', month: true },
  students: { title: '学生管理', desc: '新增、编辑、删除学生，支持批量导入（姓名 + 身份证号）', month: false },
  report: { title: '统计报表', desc: '全校汇总与各班明细，支持按月切换与导出', month: true },
  settings: { title: '系统设置', desc: '餐费标准、管理密码与数据备份', month: false }
};

/* ---------- 工具 ---------- */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n) => '¥' + r2(n).toFixed(2);
const spanVal = (v, cls) => '<span class="cell-val' + (cls ? ' ' + cls : '') + '">' + v + '</span>';
const fmtN = (n) => r2(n).toFixed(2);
const escapeHtml = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function mkErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function api(path, body) {
  const opt = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'GET' };
  let res;
  try {
    res = await fetch(path, opt);
  } catch (e) {
    throw mkErr(0, '无法连接服务器，请确认服务已启动');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { throw mkErr(res.status, '服务器返回异常'); }
  if (!res.ok || data.ok === false) throw mkErr(res.status, data.message || '请求失败');
  return data;
}

/* ---------- 业务计算（与后端规则保持一致） ---------- */
function dailyFee(std) {
  const b = r2(S.settings.breakfastPrice);
  const l = r2(S.settings.lunchPrice);
  if (std === 'B') return r2(b);
  if (std === 'L') return r2(l);
  return r2(b + l);
}
function stdLabel(key) {
  const f = S.standards.find((s) => s.key === key);
  return f ? f.label : S.standards[0].label;
}
function daysOf(classId, month) {
  const v = S.days[classId + '|' + month];
  return typeof v === 'number' && v > 0 ? v : 0;
}
function recOf(studentId, month) {
  const m = S.records[month];
  const r = m && m[studentId];
  return {
    standard: r && r.standard ? r.standard : S.defaultStandard,
    remark: r && r.remark ? r.remark : '',
    deduction: r ? r2(r.deduction) : 0
  };
}
function rowOf(st, month) {
  const rec = recOf(st.id, month);
  const days = daysOf(st.classId, month);
  const daily = dailyFee(rec.standard);
  const total = r2(days * daily);
  return {
    student: st,
    standard: rec.standard,
    remark: rec.remark,
    deduction: rec.deduction,
    days: days,
    dailyFee: daily,
    total: total,
    real: r2(Math.max(total - rec.deduction, 0))
  };
}
function classStudents(classId) {
  return S.students
    .filter((s) => s.classId === classId)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}
function allMonths() {
  const set = new Set();
  set.add(S.currentMonth || MONTH);
  Object.keys(S.days).forEach((k) => set.add(k.split('|')[1]));
  Object.keys(S.records).forEach((m) => set.add(m));
  return Array.from(set).filter(Boolean).sort().reverse();
}

/* ---------- Toast ---------- */
function toast(msg, type) {
  const root = $('#toastRoot');
  const t = document.createElement('div');
  t.className = 'toast ' + (type || '');
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 260);
  }, type === 'err' ? 4200 : 2600);
}

/* ---------- 弹窗 ---------- */
const modalRoot = $('#modalRoot');

function openModal(opts) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const modal = document.createElement('div');
    modal.className = 'modal' + (opts.wide ? ' wide' : '');
    modal.innerHTML =
      '<div class="modal-head">' + (opts.icon || '') + escapeHtml(opts.title) + '</div>' +
      '<div class="modal-body"></div>' +
      '<div class="modal-foot">' +
      '<button class="btn" data-act="cancel">' + escapeHtml(opts.cancelText || '取消') + '</button>' +
      '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-act="ok">' +
      escapeHtml(opts.okText || '确定') + '</button>' +
      '</div>';
    const body = modal.querySelector('.modal-body');
    body.innerHTML = opts.body || '';
    const errBox = document.createElement('div');
    errBox.className = 'pwd-error';
    body.appendChild(errBox);

    mask.appendChild(modal);
    modalRoot.appendChild(mask);

    let closed = false;
    function close(val) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      mask.remove();
      resolve(val);
    }
    function onKey(e) {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') doOk();
    }
    function markError(msg) {
      errBox.textContent = msg || '';
      const inp = body.querySelector('input,select,textarea');
      if (inp) inp.focus();
    }
    async function doOk() {
      const btn = modal.querySelector('[data-act=ok]');
      btn.disabled = true;
      btn.textContent = '处理中…';
      try {
        const r = opts.onOk ? await opts.onOk(body, markError) : true;
        if (r === false) {
          btn.disabled = false;
          btn.textContent = opts.okText || '确定';
          return;
        }
        close(r === undefined ? true : r);
      } catch (e) {
        markError(e.message || String(e));
        btn.disabled = false;
        btn.textContent = opts.okText || '确定';
      }
    }
    modal.querySelector('[data-act=ok]').addEventListener('click', doOk);
    modal.querySelector('[data-act=cancel]').addEventListener('click', () => close(false));
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(false); });
    document.addEventListener('keydown', onKey);
    setTimeout(() => {
      const first = body.querySelector('input:not([type=hidden]),select,textarea');
      if (first) first.focus();
    }, 30);
  });
}

function confirmDialog(title, message, okText) {
  return openModal({
    title: title,
    icon: '⚠️ ',
    danger: true,
    okText: okText || '确认删除',
    body: '<div>' + message + '</div>',
    onOk: async () => true
  });
}

/**
 * 需要管理密码的操作：弹窗收集业务字段 + 密码，密码错误时在原弹窗内提示并可重试。
 * @param {object} cfg {title, icon, bodyHtml, okText, danger, read(bodyEl), submit(data)}
 */
async function protectedAction(cfg) {
  const bodyHtml =
    (cfg.bodyHtml || '') +
    '<div class="card-sub" style="padding:12px 0 0">🔒 该操作需要验证管理密码</div>' +
    '<input type="password" class="pwd-input" placeholder="请输入管理密码" autocomplete="current-password">';
  const r = await openModal({
    title: cfg.title,
    icon: cfg.icon || '🔒 ',
    danger: !!cfg.danger,
    okText: cfg.okText || '验证并确认',
    body: bodyHtml,
    onOk: async (bodyEl, markError) => {
      const pwd = bodyEl.querySelector('input[type=password]').value;
      if (!pwd) { markError('请输入管理密码'); return false; }
      const data = cfg.read ? cfg.read(bodyEl, markError) : {};
      if (data === false) return false;
      try {
        const res = await cfg.submit(Object.assign({ password: pwd }, data));
        return res === undefined ? true : res;
      } catch (e) {
        if (e.status === 401 || e.status === 403) { markError(e.message || '管理密码错误，操作已拒绝'); return false; }
        markError(e.message || '操作失败，请重试');
        return false;
      }
    }
  });
  return !!r;
}

/* ============================================================
 * 页面渲染
 * ============================================================ */

function switchPage(page) {
  currentPage = page;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((s) => s.classList.toggle('active', s.id === 'page-' + page));
  const cfg = PAGES[page];
  $('#pageTitle').textContent = cfg.title;
  $('#pageDesc').textContent = cfg.desc;
  $('#monthBox').classList.toggle('is-hidden', !cfg.month);
  window.scrollTo({ top: 0, behavior: 'auto' });
  renderPage(page);
}

function renderPage(page) {
  if (page === 'register') renderRegister();
  else if (page === 'classes') renderClasses();
  else if (page === 'students') renderStudents();
  else if (page === 'report') renderReport();
  else if (page === 'settings') renderSettings();
}

function renderAll() {
  fillClassSelects();
  renderMonthChips();
  renderPage(currentPage);
}

/* ---------- 月份 ---------- */
function renderMonthChips() {
  const box = $('#monthChips');
  const months = allMonths().slice(0, 6);
  box.innerHTML = months
    .map((m) => '<button class="chip' + (m === MONTH ? ' active' : '') + '" data-m="' + m + '">' + m + '</button>')
    .join('');
  box.querySelectorAll('.chip').forEach((c) => {
    c.addEventListener('click', () => {
      MONTH = c.dataset.m;
      $('#monthInput').value = MONTH;
      renderMonthChips();
      renderPage(currentPage);
    });
  });
  const tip = $('#classMonthTip');
  if (tip) {
    tip.innerHTML = '当前设置的月份为 <b>' + MONTH + '</b>，天数按「班级 + 月份」分别保存，历史月份可随时切换回看。';
  }
}

/* ---------- 班级下拉 ---------- */
function fillClassSelects() {
  const opts = S.classes.map((c) => '<option value="' + c.id + '">' + escapeHtml(c.name) + '</option>').join('');
  const empty = '<option value="">（请先创建班级）</option>';

  const reg = $('#regClass');
  if (!S.classes.length) {
    reg.innerHTML = empty;
    currentClassId = '';
  } else {
    reg.innerHTML = opts;
    if (!S.classes.some((c) => c.id === currentClassId)) currentClassId = S.classes[0].id;
    reg.value = currentClassId;
  }

  $('#stClass').innerHTML = S.classes.length ? opts : empty;
  $('#impClass').innerHTML = S.classes.length ? opts : empty;

  const fc = $('#filterClass');
  if (!S.classes.some((c) => c.id === filterClassId)) filterClassId = '';
  fc.innerHTML = '<option value="">全部班级</option>' + opts;
  fc.value = filterClassId;
}

/* ============================ 就餐登记 ============================ */

function renderRegister() {
  const body = $('#regBody');
  const foot = $('#regFoot');
  const emptyBox = $('#regEmpty');
  const table = $('#regTable');
  const meta = $('#regMeta');
  const cls = S.classes.find((c) => c.id === currentClassId);

  if (!cls) {
    table.style.display = 'none';
    emptyBox.hidden = false;
    emptyBox.textContent = '还没有班级，请先到「班级管理」创建班级。';
    meta.textContent = '';
    foot.innerHTML = '';
    return;
  }

  const days = daysOf(cls.id, MONTH);
  meta.innerHTML =
    '本月应就餐天数：<b>' + days + ' 天</b>' +
    (days === 0 ? ' <span class="danger-text">（未设置，请到班级管理设置）</span>' : '') +
    '　·　早餐 ¥' + fmtN(S.settings.breakfastPrice) + ' / 午餐 ¥' + fmtN(S.settings.lunchPrice) +
    ' / 全天 ¥' + fmtN(r2(S.settings.breakfastPrice + S.settings.lunchPrice));

  const list = classStudents(cls.id);
  if (!list.length) {
    table.style.display = 'none';
    emptyBox.hidden = false;
    emptyBox.innerHTML = '班级「' + escapeHtml(cls.name) + '」还没有学生，请到「学生管理」添加或导入。';
    foot.innerHTML = '';
    return;
  }

  table.style.display = '';
  emptyBox.hidden = true;

  body.innerHTML = list.map((st, i) => {
    const r = rowOf(st, MONTH);
    return (
      '<tr data-sid="' + st.id + '">' +
      '<td class="c-idx">' + (i + 1) + '</td>' +
      '<td class="c-name" data-label="姓名">' + escapeHtml(st.name) + '</td>' +
      '<td class="c-id" data-label="身份证号">' + escapeHtml(st.idCard) + '</td>' +
      '<td class="c-days days-cell' + (r.days === 0 ? ' days-unset' : '') + '" data-label="应就餐天数">' + spanVal(r.days + ' 天') + '</td>' +
      '<td class="c-std" data-label="用餐标准"><select class="row-select" data-f="standard">' +
      S.standards.map((s) => '<option value="' + s.key + '"' + (s.key === r.standard ? ' selected' : '') + '>' + s.label + '</option>').join('') +
      '</select></td>' +
      '<td class="c-fee num js-daily" data-label="每日餐费"><span class="cell-val fee-val">' + fmt(r.dailyFee) + '</span></td>' +
      '<td class="c-remark" data-label="备注"><input class="row-input remark" data-f="remark" maxlength="200" value="' + escapeHtml(r.remark) + '" placeholder="如：请假 / 病假 / 外出"></td>' +
      '<td class="c-deduct" data-label="应扣除费用"><input class="row-input deduct" data-f="deduction" type="number" min="0" step="0.01" value="' + (r.deduction || 0) + '"></td>' +
      '<td class="c-total num js-total" data-label="总费用">' + spanVal(fmt(r.total)) + '</td>' +
      '<td class="c-real js-real' + (r.real <= 0 ? ' real-zero' : ' main-fee') + '" data-label="当月真实费用">' + spanVal(fmt(r.real)) + '</td>' +
      '</tr>'
    );
  }).join('');

  bindRowEditors(body);
  updateRegisterFoot();
}

function bindRowEditors(body) {
  body.querySelectorAll('[data-f]').forEach((el) => {
    const tr = el.closest('tr');
    el.addEventListener('change', () => saveCell(tr, el));
    el.addEventListener('blur', () => {
      if (el.dataset.last !== el.value) saveCell(tr, el);
    });
    el.addEventListener('focus', () => { el.dataset.last = el.value; });
    if (el.tagName === 'INPUT') {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
    }
  });
}

async function saveCell(tr, el) {
  const sid = tr.dataset.sid;
  const field = el.dataset.f;
  let value = el.value;
  if (field === 'deduction') {
    if (el.value === '') value = 0;
    else {
      const n = Number(el.value);
      if (!isFinite(n) || n < 0) {
        toast('应扣除费用必须是不小于 0 的数字', 'err');
        el.value = recOf(sid, MONTH).deduction;
        return;
      }
      value = n;
    }
  }
  el.dataset.last = el.value;
  el.classList.add('saving');
  try {
    const res = await api('/api/records/cell', { month: MONTH, studentId: sid, field: field, value: value });
    const st = S.students.find((s) => s.id === sid);
    if (st) {
      if (!S.records[MONTH]) S.records[MONTH] = {};
      S.records[MONTH][sid] = {
        standard: res.row.standard,
        remark: res.row.remark,
        deduction: res.row.deduction
      };
      paintRow(tr, st);
      updateRegisterFoot();
    }
  } catch (e) {
    toast('保存失败：' + e.message, 'err');
  } finally {
    el.classList.remove('saving');
  }
}

function paintRow(tr, st) {
  const r = rowOf(st, MONTH);
  tr.querySelector('.js-daily .cell-val').textContent = fmt(r.dailyFee);
  tr.querySelector('.js-total .cell-val').textContent = fmt(r.total);
  const realTd = tr.querySelector('.js-real');
  realTd.querySelector('.cell-val').textContent = fmt(r.real);
  realTd.className = 'c-real js-real ' + (r.real <= 0 ? 'real-zero' : 'main-fee');
  const daysTd = tr.querySelector('.days-cell');
  daysTd.querySelector('.cell-val').textContent = r.days + ' 天';
  daysTd.className = 'c-days days-cell' + (r.days === 0 ? ' days-unset' : '');
}

function updateRegisterFoot() {
  const cls = S.classes.find((c) => c.id === currentClassId);
  if (!cls) { $('#regFoot').innerHTML = ''; return; }
  const list = classStudents(cls.id);
  let t = 0, d = 0, rl = 0;
  list.forEach((st) => { const r = rowOf(st, MONTH); t += r.total; d += r.deduction; rl += r.real; });
  $('#regFoot').innerHTML =
    '<tr class="foot-total"><td colspan="8" data-label="合计">共 ' + list.length + ' 人</td>' +
    '<td class="c-total num" data-label="总费用合计">' + spanVal(fmt(t)) + '</td>' +
    '<td class="c-real num" data-label="当月真实费用合计">' + spanVal(fmt(rl)) + '</td></tr>' +
    '<tr class="foot-sub"><td colspan="8" data-label="说明">其中：应扣除费用合计</td>' +
    '<td class="num deduct-sum" data-label="应扣除合计">' + spanVal(fmt(d)) + '</td><td></td></tr>';
}

/* ============================ 班级管理 ============================ */

function renderClasses() {
  const body = $('#classBody');
  const emptyBox = $('#classEmpty');
  emptyBox.hidden = S.classes.length > 0;

  body.innerHTML = S.classes.map((c, i) => {
    const days = daysOf(c.id, MONTH);
    const cnt = S.students.filter((s) => s.classId === c.id).length;
    return (
      '<tr data-cid="' + c.id + '">' +
      '<td class="c-idx">' + (i + 1) + '</td>' +
      '<td class="c-name" data-label="班级">' + escapeHtml(c.name) + '</td>' +
      '<td class="c-days days-cell' + (days === 0 ? ' days-unset' : '') + '" data-label="应就餐天数">' + spanVal(days === 0 ? '未设置' : days + ' 天') + '</td>' +
      '<td class="c-num num" data-label="学生人数">' + spanVal(cnt + ' 人') + '</td>' +
      '<td class="c-act" data-label="操作">' +
      '<button class="btn-link" data-act="days">设置天数</button>' +
      '<button class="btn-link" data-act="rename">重命名</button>' +
      '<button class="btn-link danger" data-act="del">删除</button>' +
      '</td></tr>'
    );
  }).join('');

  body.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cid = btn.closest('tr').dataset.cid;
      if (btn.dataset.act === 'days') onSetDays(cid);
      if (btn.dataset.act === 'rename') onRenameClass(cid);
      if (btn.dataset.act === 'del') onDeleteClass(cid);
    });
  });
}

async function onAddClass() {
  const input = $('#newClassName');
  const name = input.value.trim();
  if (!name) { toast('请输入班级名称', 'warn'); input.focus(); return; }
  try {
    const res = await api('/api/classes/add', { name: name });
    S.classes.push(res.cls);
    input.value = '';
    currentClassId = res.cls.id;
    await refresh();
    toast('班级「' + res.cls.name + '」已创建', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function onRenameClass(cid) {
  const cls = S.classes.find((c) => c.id === cid);
  if (!cls) return;
  const r = await openModal({
    title: '重命名班级',
    body: '<div>请输入新的班级名称：</div><input class="pwd-input" id="__rn" value="' + escapeHtml(cls.name) + '" maxlength="60">',
    onOk: async (bodyEl, markError) => {
      const name = bodyEl.querySelector('#__rn').value.trim();
      if (!name) { markError('班级名称不能为空'); return false; }
      try {
        await api('/api/classes/rename', { id: cid, name: name });
        return true;
      } catch (e) { markError(e.message); return false; }
    }
  });
  if (r) { await refresh(); toast('班级名称已更新', 'ok'); }
}

function onSetDays(cid) {
  const cls = S.classes.find((c) => c.id === cid);
  if (!cls) return;
  openBatchDays([cid], true);
}

async function openBatchDays(presetIds, single) {
  const cur = presetIds && presetIds.length === 1 ? daysOf(presetIds[0], MONTH) : daysOf(S.classes[0] && S.classes[0].id, MONTH);
  const listHtml = S.classes.map((c) => {
    const checked = !presetIds || presetIds.indexOf(c.id) >= 0;
    const d = daysOf(c.id, MONTH);
    return '<label class="class-pick"><input type="checkbox" value="' + c.id + '"' + (checked ? ' checked' : '') + '>' +
      '<span>' + escapeHtml(c.name) + '</span>' +
      '<span class="cp-meta">当前 ' + (d === 0 ? '未设置' : d + ' 天') + ' · ' +
      S.students.filter((s) => s.classId === c.id).length + ' 人</span></label>';
  }).join('');

  const bodyHtml =
    '<div>将 <b>' + MONTH + '</b> 的应就餐天数设置为：</div>' +
    '<input class="pwd-input" id="__days" type="number" min="0" max="31" step="1" value="' + (cur || '') + '" placeholder="输入天数，如 18" style="max-width:200px">' +
    '<div class="card-sub" style="padding:8px 0 0">选择要应用的班级（默认全选，可取消勾选）：</div>' +
    '<div class="class-pick-list">' + listHtml + '</div>' +
    '<div class="pick-bar"><button type="button" id="__all">全选</button><button type="button" id="__none">全不选</button><button type="button" id="__invert">反选</button></div>';

  const ok = await protectedAction({
    title: (single ? '设置' : '批量设置') + '本月应就餐天数',
    icon: '🗓 ',
    bodyHtml: bodyHtml,
    okText: '应用',
    read: (bodyEl, markError) => {
      const days = Number(bodyEl.querySelector('#__days').value);
      if (!isFinite(days) || days < 0 || days > 31 || Math.floor(days) !== days) {
        markError('应就餐天数必须为 0 ~ 31 之间的整数');
        return false;
      }
      const ids = Array.from(bodyEl.querySelectorAll('.class-pick input:checked')).map((i) => i.value);
      if (!ids.length) { markError('请至少勾选一个班级'); return false; }
      return { month: MONTH, classIds: ids, days: days };
    },
    submit: (data) => api('/api/days/set', data)
  });
  if (ok) { await refresh(); toast('应就餐天数已更新', 'ok'); }
}

async function onDeleteClass(cid) {
  const cls = S.classes.find((c) => c.id === cid);
  if (!cls) return;
  const cnt = S.students.filter((s) => s.classId === cid).length;
  const ok = await confirmDialog(
    '删除班级',
    '<p>确定要删除班级 <b>' + escapeHtml(cls.name) + '</b> 吗？</p>' +
    '<p style="color:#dc2626"><b>该班级下的 ' + cnt + ' 名学生及其全部就餐记录将一并被删除，且无法恢复！</b></p>' +
    '<p style="color:#5b6577">建议先到「系统设置」下载数据备份。</p>'
  );
  if (!ok) return;
  const done = await protectedAction({
    title: '删除班级 · 二次确认',
    icon: '⚠️ ',
    danger: true,
    okText: '确认删除',
    bodyHtml: '<div style="color:#dc2626">最后一步：请输入管理密码以确认删除班级 <b>' + escapeHtml(cls.name) + '</b>。</div>',
    submit: (data) => api('/api/classes/delete', { id: cid, password: data.password })
  });
  if (done) {
    if (currentClassId === cid) currentClassId = '';
    await refresh();
    toast('班级「' + cls.name + '」及其数据已删除', 'ok');
  }
}

/* ============================ 学生管理 ============================ */

function renderStudents() {
  const body = $('#stuBody');
  const emptyBox = $('#stuEmpty');
  let list = S.students.slice();
  if (filterClassId) list = list.filter((s) => s.classId === filterClassId);
  if (searchText) {
    const q = searchText.toLowerCase();
    list = list.filter((s) => s.name.toLowerCase().indexOf(q) >= 0 || s.idCard.toLowerCase().indexOf(q) >= 0);
  }
  list.sort((a, b) => {
    const ca = (S.classes.find((c) => c.id === a.classId) || {}).name || '';
    const cb = (S.classes.find((c) => c.id === b.classId) || {}).name || '';
    if (ca !== cb) return ca.localeCompare(cb, 'zh-CN');
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  $('#stuCount').textContent = '共 ' + list.length + ' 名学生' + (list.length !== S.students.length ? '（全校 ' + S.students.length + ' 人）' : '');
  emptyBox.hidden = list.length > 0;
  if (!S.students.length) emptyBox.textContent = '暂无学生，请先创建班级后添加或导入学生。';
  else if (!list.length) emptyBox.textContent = '没有符合筛选条件的学生。';

  body.innerHTML = list.map((st, i) => {
    const cls = S.classes.find((c) => c.id === st.classId);
    return (
      '<tr data-sid="' + st.id + '">' +
      '<td class="c-idx">' + (i + 1) + '</td>' +
      '<td class="c-name" data-label="姓名">' + escapeHtml(st.name) + '</td>' +
      '<td class="c-id" data-label="身份证号">' + spanVal(escapeHtml(st.idCard)) + '</td>' +
      '<td data-label="班级">' + spanVal(escapeHtml(cls ? cls.name : '（班级已删除）')) + '</td>' +
      '<td class="c-act" data-label="操作"><button class="btn-link" data-act="edit">编辑</button>' +
      '<button class="btn-link danger" data-act="del">删除</button></td>' +
      '</tr>'
    );
  }).join('');

  body.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sid = btn.closest('tr').dataset.sid;
      if (btn.dataset.act === 'edit') onEditStudent(sid);
      if (btn.dataset.act === 'del') onDeleteStudent(sid);
    });
  });
}

async function onAddStudent() {
  const name = $('#stName').value.trim();
  const idCard = $('#stIdCard').value.trim();
  const classId = $('#stClass').value;
  if (!classId) { toast('请先创建班级', 'warn'); return; }
  if (!name) { toast('请输入学生姓名', 'warn'); $('#stName').focus(); return; }
  if (!idCard) { toast('请输入身份证号', 'warn'); $('#stIdCard').focus(); return; }
  try {
    const res = await api('/api/students/add', { name: name, idCard: idCard, classId: classId });
    S.students.push(res.student);
    $('#stName').value = '';
    $('#stIdCard').value = '';
    await refresh();
    $('#stName').focus();
    toast('学生「' + res.student.name + '」已添加', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function onEditStudent(sid) {
  const st = S.students.find((s) => s.id === sid);
  if (!st) return;
  const opts = S.classes.map((c) => '<option value="' + c.id + '"' + (c.id === st.classId ? ' selected' : '') + '>' + escapeHtml(c.name) + '</option>').join('');
  const r = await openModal({
    title: '编辑学生',
    body:
      '<div class="field"><span>姓名</span><input class="pwd-input" id="__n" value="' + escapeHtml(st.name) + '" maxlength="30"></div>' +
      '<div class="field" style="margin-top:10px"><span>身份证号</span><input class="pwd-input" id="__i" value="' + escapeHtml(st.idCard) + '" maxlength="18"></div>' +
      '<div class="field" style="margin-top:10px"><span>所属班级</span><select class="pwd-input" id="__c">' + opts + '</select></div>',
    onOk: async (bodyEl, markError) => {
      try {
        await api('/api/students/update', {
          id: sid,
          name: bodyEl.querySelector('#__n').value.trim(),
          idCard: bodyEl.querySelector('#__i').value.trim(),
          classId: bodyEl.querySelector('#__c').value
        });
        return true;
      } catch (e) { markError(e.message); return false; }
    }
  });
  if (r) { await refresh(); toast('学生信息已更新', 'ok'); }
}

async function onDeleteStudent(sid) {
  const st = S.students.find((s) => s.id === sid);
  if (!st) return;
  const ok = await confirmDialog('删除学生', '<p>确定要删除学生 <b>' + escapeHtml(st.name) + '</b>（' + escapeHtml(st.idCard) + '）吗？</p><p style="color:#dc2626">该生的就餐记录将一并删除。</p>');
  if (!ok) return;
  try {
    await api('/api/students/delete', { id: sid });
    await refresh();
    toast('学生「' + st.name + '」已删除', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------- 导入 ---------- */
function readFileText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const buf = fr.result;
      try { return resolve(new TextDecoder('utf-8', { fatal: true }).decode(buf)); } catch (e) { /* 非 UTF-8 */ }
      try { return resolve(new TextDecoder('gbk').decode(buf)); } catch (e) { /* 不支持 GBK */ }
      resolve(new TextDecoder('utf-8').decode(buf));
    };
    fr.onerror = () => reject(new Error('文件读取失败'));
    fr.readAsArrayBuffer(file);
  });
}

async function onImport() {
  const classId = $('#impClass').value;
  const text = $('#impText').value;
  if (!classId) { toast('请先选择要导入到的班级', 'warn'); return; }
  if (!text.trim()) { toast('请粘贴或选择包含学生数据的文本 / 文件', 'warn'); return; }
  try {
    const res = await api('/api/students/import', { classId: classId, text: text });
    await refresh();
    renderImportResult(res);
    $('#impText').value = '';
    $('#fileName').textContent = '未选择文件';
    $('#fileInput').value = '';
  } catch (e) {
    toast(e.message, 'err');
  }
}

function renderImportResult(res) {
  const box = $('#importResult');
  box.hidden = false;
  let cls = 'ir-ok';
  if (res.errors && res.errors.length) cls = 'ir-warn';
  if (!res.added && (!res.duplicate || res.errors.length)) cls = 'ir-err';
  let html = '<div class="ir-title">导入完成：成功 ' + res.added + ' 人，跳过重复 ' + res.duplicate + ' 人，无效 ' + res.errors.length + ' 行（空行 ' + res.blank + ' 行）</div>';
  if (res.errors && res.errors.length) {
    html += '<div>以下行未导入，请检查后重新粘贴：</div><div class="err-list">' +
      res.errors.slice(0, 50).map((e) => '第 ' + e.line + ' 行「' + escapeHtml(e.text) + '」—— ' + escapeHtml(e.msg)).join('<br>') +
      (res.errors.length > 50 ? '<br>… 其余 ' + (res.errors.length - 50) + ' 行省略' : '') + '</div>';
  } else {
    html += '<div>全部数据校验通过，默认用餐标准为「早餐+中餐」。</div>';
  }
  box.className = 'import-result ' + cls;
  box.innerHTML = html;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ============================ 统计报表 ============================ */

function reportData() {
  const rows = S.classes.map((c) => {
    const list = classStudents(c.id);
    let total = 0, deduct = 0, real = 0;
    const cnt = { BL: 0, B: 0, L: 0 };
    list.forEach((st) => {
      const r = rowOf(st, MONTH);
      cnt[r.standard] = (cnt[r.standard] || 0) + 1;
      total += r.total; deduct += r.deduction; real += r.real;
    });
    return {
      cls: c, students: list.length, days: daysOf(c.id, MONTH),
      cnt: cnt, total: r2(total), deduct: r2(deduct), real: r2(real)
    };
  });
  const sum = rows.reduce((a, r) => ({
    students: a.students + r.students,
    total: r2(a.total + r.total),
    deduct: r2(a.deduct + r.deduct),
    real: r2(a.real + r.real),
    cnt: {
      BL: a.cnt.BL + r.cnt.BL,
      B: a.cnt.B + r.cnt.B,
      L: a.cnt.L + r.cnt.L
    }
  }), { students: 0, total: 0, deduct: 0, real: 0, cnt: { BL: 0, B: 0, L: 0 } });
  return { rows: rows, sum: sum };
}

function renderReport() {
  const { rows, sum } = reportData();
  $('#sumClasses').textContent = S.classes.length;
  $('#sumStudents').textContent = sum.students;
  $('#sumTotal').textContent = fmt(sum.total);
  $('#sumDeduct').textContent = fmt(sum.deduct);
  $('#sumReal').textContent = fmt(sum.real);

  $('#stdGrid').innerHTML = S.standards.map((s) =>
    '<div class="std-box"><div class="std-name"><span>' + s.label + '</span><b>¥' + fmtN(dailyFee(s.key)) + ' / 天</b></div>' +
    '<div class="std-count">' + (sum.cnt[s.key] || 0) + ' <span style="font-size:13px;color:#8a94a6;font-weight:500">人</span></div></div>'
  ).join('') +
    '<div class="std-box"><div class="std-name"><span>本月已设置天数</span><b>班级数</b></div>' +
    '<div class="std-count">' + rows.filter((r) => r.days > 0).length + ' <span style="font-size:13px;color:#8a94a6;font-weight:500">/ ' + rows.length + '</span></div></div>';

  const body = $('#repBody');
  body.innerHTML = rows.map((r, i) =>
    '<tr><td class="c-idx">' + (i + 1) + '</td>' +
    '<td class="c-name" data-label="班级">' + escapeHtml(r.cls.name) + '</td>' +
    '<td class="c-days days-cell' + (r.days === 0 ? ' days-unset' : '') + '" data-label="应就餐天数">' + spanVal(r.days === 0 ? '未设置' : r.days + ' 天') + '</td>' +
    '<td class="c-num num" data-label="学生人数">' + spanVal(r.students + ' 人') + '</td>' +
    '<td class="c-num num" data-label="早餐+中餐">' + spanVal((r.cnt.BL || 0) + ' 人') + '</td>' +
    '<td class="c-num num" data-label="仅早餐">' + spanVal((r.cnt.B || 0) + ' 人') + '</td>' +
    '<td class="c-num num" data-label="仅中餐">' + spanVal((r.cnt.L || 0) + ' 人') + '</td>' +
    '<td class="c-total num" data-label="总费用">' + spanVal(fmt(r.total)) + '</td>' +
    '<td class="c-deduct num deduct-sum" data-label="应扣除">' + spanVal(fmt(r.deduct)) + '</td>' +
    '<td class="c-real main-fee num" data-label="当月真实费用">' + spanVal(fmt(r.real)) + '</td></tr>'
  ).join('');

  $('#repFoot').innerHTML =
    '<tr class="foot-total"><td colspan="7" data-label="合计">全校合计</td>' +
    '<td class="c-total num" data-label="总费用">' + spanVal(fmt(sum.total)) + '</td>' +
    '<td class="c-deduct num deduct-sum" data-label="应扣除">' + spanVal(fmt(sum.deduct)) + '</td>' +
    '<td class="c-real num" data-label="当月真实费用">' + spanVal(fmt(sum.real)) + '</td></tr>';

  $('#repEmpty').hidden = rows.length > 0;
}

/* ============================ 系统设置 ============================ */

function renderSettings() {
  $('#priceBreakfast').value = r2(S.settings.breakfastPrice);
  $('#priceLunch').value = r2(S.settings.lunchPrice);
  $('#priceAll').value = fmtN(r2(S.settings.breakfastPrice + S.settings.lunchPrice));
}

async function onSavePrice() {
  const b = Number($('#priceBreakfast').value);
  const l = Number($('#priceLunch').value);
  if (!isFinite(b) || b < 0) { toast('早餐价格不合法', 'warn'); return; }
  if (!isFinite(l) || l < 0) { toast('午餐价格不合法', 'warn'); return; }
  const ok = await protectedAction({
    title: '修改餐费标准',
    icon: '💰 ',
    bodyHtml:
      '<div>早餐价：<b>¥' + fmtN(b) + '</b>　午餐价：<b>¥' + fmtN(l) + '</b>　全天：<b>¥' + fmtN(r2(b + l)) + '</b></div>' +
      '<div class="card-sub" style="padding:8px 0 0">保存后全校所有学生的每日餐费、总费用与真实费用将立即重新计算。</div>',
    okText: '保存',
    submit: (data) => api('/api/settings/prices', { breakfastPrice: b, lunchPrice: l, password: data.password })
  });
  if (ok) { await refresh(); toast('餐费标准已更新，费用已重算', 'ok'); }
}

async function onSavePwd() {
  const oldP = $('#pwdOld').value;
  const n1 = $('#pwdNew').value;
  const n2 = $('#pwdNew2').value;
  if (!oldP) { toast('请输入当前密码', 'warn'); return; }
  if (n1.length < 6) { toast('新密码至少需要 6 位', 'warn'); return; }
  if (n1 !== n2) { toast('两次输入的新密码不一致', 'warn'); return; }
  try {
    await api('/api/settings/password', { oldPassword: oldP, newPassword: n1 });
    $('#pwdOld').value = ''; $('#pwdNew').value = ''; $('#pwdNew2').value = '';
    toast('管理密码已修改，请牢记新密码', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function onBackup() {
  try {
    const data = await api('/api/state');
    const text = JSON.stringify(data, null, 2);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '就餐统计备份-' + MONTH + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('备份文件已下载', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function onClearMonth() {
  const ok = await protectedAction({
    title: '清空当前月份登记数据',
    icon: '🧹 ',
    danger: true,
    okText: '确认清空',
    bodyHtml:
      '<div style="color:#dc2626"><b>将清空 ' + MONTH + ' 月所有学生的用餐标准、备注与应扣除费用。</b></div>' +
      '<div class="card-sub" style="padding:8px 0 0">班级、学生名单与应就餐天数<b>不会</b>被清除。此操作不可恢复。</div>',
    submit: (data) => api('/api/records/clearMonth', { month: MONTH, password: data.password })
  });
  if (ok) { await refresh(); toast(MONTH + ' 的登记数据已清空', 'ok'); }
}

/* ============================ 数据加载 ============================ */

async function refresh() {
  const data = await api('/api/state');
  S = data;
  $('#footPort').textContent = location.port || (location.protocol === 'https:' ? '443' : '80');
  renderAll();
}

/* ============================ 事件绑定 ============================ */

function bindEvents() {
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (btn) switchPage(btn.dataset.page);
  });

  $('#monthInput').addEventListener('change', () => {
    const v = $('#monthInput').value;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) { toast('月份格式应为 YYYY-MM', 'warn'); $('#monthInput').value = MONTH; return; }
    MONTH = v;
    renderMonthChips();
    renderPage(currentPage);
  });

  $('#regClass').addEventListener('change', () => { currentClassId = $('#regClass').value; renderRegister(); });
  $('#btnReload').addEventListener('click', async () => { await refresh(); toast('数据已刷新', 'ok'); });

  $('#btnExportClass').addEventListener('click', () => {
    if (!currentClassId) { toast('请先选择班级', 'warn'); return; }
    window.location.href = '/api/export/xlsx?month=' + encodeURIComponent(MONTH) + '&scope=class&classId=' + encodeURIComponent(currentClassId);
    toast('已开始导出本班餐费核对表（xlsx）', 'ok');
  });

  $('#btnExportAll').addEventListener('click', () => {
    window.location.href = '/api/export/xlsx?month=' + encodeURIComponent(MONTH) + '&scope=all';
    toast('已开始导出全校餐费核对表（xlsx）', 'ok');
  });

  /* 班级管理 */
  $('#btnAddClass').addEventListener('click', onAddClass);
  $('#newClassName').addEventListener('keydown', (e) => { if (e.key === 'Enter') onAddClass(); });
  $('#btnBatchDays').addEventListener('click', () => {
    if (!S.classes.length) { toast('请先创建班级', 'warn'); return; }
    openBatchDays(null, false);
  });

  /* 学生管理 */
  $('#btnAddStudent').addEventListener('click', onAddStudent);
  ['#stName', '#stIdCard'].forEach((s) => {
    $(s).addEventListener('keydown', (e) => { if (e.key === 'Enter') onAddStudent(); });
  });
  $('#btnPickFile').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async () => {
    const f = $('#fileInput').files[0];
    if (!f) return;
    try {
      const text = await readFileText(f);
      $('#impText').value = text;
      $('#fileName').textContent = '已选择：' + f.name;
      toast('文件已读取，请确认内容后点击「开始导入」', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  $('#btnClearImport').addEventListener('click', () => {
    $('#impText').value = '';
    $('#fileName').textContent = '未选择文件';
    $('#fileInput').value = '';
    $('#importResult').hidden = true;
  });
  $('#btnImport').addEventListener('click', onImport);
  $('#filterClass').addEventListener('change', () => { filterClassId = $('#filterClass').value; renderStudents(); });
  $('#searchInput').addEventListener('input', () => { searchText = $('#searchInput').value.trim(); renderStudents(); });

  /* 系统设置 */
  $('#btnSavePrice').addEventListener('click', onSavePrice);
  $('#btnSavePwd').addEventListener('click', onSavePwd);
  $('#btnBackup').addEventListener('click', onBackup);
  $('#btnClearMonth').addEventListener('click', onClearMonth);
  $('#priceBreakfast').addEventListener('input', () => {
    $('#priceAll').value = fmtN(r2(Number($('#priceBreakfast').value || 0) + Number($('#priceLunch').value || 0)));
  });
  $('#priceLunch').addEventListener('input', () => {
    $('#priceAll').value = fmtN(r2(Number($('#priceBreakfast').value || 0) + Number($('#priceLunch').value || 0)));
  });
}

/* ============================ 启动 ============================ */

(async function init() {
  try {
    const data = await api('/api/state');
    S = data;
    MONTH = data.currentMonth;
    $('#monthInput').value = MONTH;
    $('#footPort').textContent = location.port || (location.protocol === 'https:' ? '443' : '80');
    bindEvents();
    renderAll();
  } catch (e) {
    document.querySelector('.content').innerHTML =
      '<div class="card"><div class="empty">加载失败：' + escapeHtml(e.message) + '<br>请确认后端服务已启动（node server.js）。</div></div>';
  }
})();
