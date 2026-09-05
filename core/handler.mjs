// 班级就餐统计系统 —— Cloudflare Pages Function 处理器（D1 持久层）。
// 由 functions/api/[[path]].js 重新导出 onRequest 后由 CF 运行。
// 本文件不依赖任何第三方包；Buffer 仅出现在 xlsx 导出（lib/xlsx-export.js，需 nodejs_compat）。

import { renderMealWorkbook } from '../lib/xlsx-export.js';
import {
  MEAL_STANDARDS, STANDARD_KEYS, DEFAULT_STANDARD, money, standardLabel,
  dailyFeeOf, daysKey, getDays, getRecord, buildRow, validateIdCard,
  parseClassName, buildMealSheets, listMonths, currentMonth, isValidMonth
} from './fees.mjs';
import { hashPassword, newSalt, newId } from './password.mjs';
import { SCHOOL_CLASSES, SCHOOL } from './classes.mjs';

const MAX_BODY = 20 * 1024 * 1024;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ============================ HTTP 工具 ============================ */

function jsonResponse(obj, status = 200) {
  const body = JSON.stringify(obj);
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function requireString(v, name, maxLen) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new ApiError(400, name + '不能为空');
  if (maxLen && s.length > maxLen) throw new ApiError(400, name + '长度不能超过 ' + maxLen + ' 个字符');
  return s;
}

function findClass(state, id) {
  const c = state.classes.find((x) => x.id === id);
  if (!c) throw new ApiError(404, '班级不存在');
  return c;
}

function findStudent(state, id) {
  const s = state.students.find((x) => x.id === id);
  if (!s) throw new ApiError(404, '学生不存在');
  return s;
}

async function requirePassword(body, state) {
  const pwd = body && body.password;
  if (typeof pwd !== 'string' || pwd === '') throw new ApiError(401, '请输入管理密码');
  const hash = await hashPassword(pwd, state.settings.salt);
  if (hash !== state.settings.passwordHash) throw new ApiError(403, '管理密码错误，操作已拒绝');
}

/* ============================ D1 读写 ============================ */

async function loadMeta(env) {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key=?').bind('settings').first();
  if (row && row.value) {
    try { return JSON.parse(row.value); } catch (e) { /* ignore */ }
  }
  return null;
}

async function seedMeta(env) {
  const salt = newSalt();
  const settings = {
    breakfastPrice: 6,
    lunchPrice: 11,
    salt: salt,
    passwordHash: await hashPassword('admin', salt)
  };
  await env.DB.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)')
    .bind('settings', JSON.stringify(settings)).run();
  return settings;
}

async function seedClasses(env) {
  const stmt = env.DB.prepare('INSERT OR REPLACE INTO classes (id,name,grade,cls,created_at) VALUES (?,?,?,?,?)');
  const now = Date.now();
  const rows = (SCHOOL_CLASSES.classes || []).map((c) =>
    stmt.bind(newId('c'), c.name, c.grade, c.cls, now));
  if (rows.length) await env.DB.batch(rows);
}

/** 从 D1 装配出与 server.js 同构的 state 对象，并首启自动播种 27 班 + 默认设置 */
async function loadState(env) {
  let settings = await loadMeta(env);
  if (!settings) settings = await seedMeta(env);

  const classes = await env.DB.prepare('SELECT id,name,grade,cls,created_at FROM classes ORDER BY grade, cls').all();
  const students = await env.DB.prepare('SELECT id,class_id,name,id_card,created_at FROM students').all();
  const daysRows = await env.DB.prepare('SELECT class_id,month,days FROM days').all();
  const recRows = await env.DB.prepare('SELECT student_id,month,standard,remark,deduction FROM records').all();

  const classList = (classes.results || []).map((c) => ({
    id: c.id, name: c.name, grade: c.grade, cls: c.cls, createdAt: c.created_at
  }));
  const studentList = (students.results || []).map((s) => ({
    id: s.id, classId: s.class_id, name: s.name, idCard: s.id_card, createdAt: s.created_at
  }));
  const days = {};
  (daysRows.results || []).forEach((d) => { days[daysKey(d.class_id, d.month)] = d.days; });
  const records = {};
  (recRows.results || []).forEach((r) => {
    if (!records[r.month]) records[r.month] = {};
    records[r.month][r.student_id] = { standard: r.standard, remark: r.remark || '', deduction: money(r.deduction) };
  });

  // 首次部署自动建全校班级
  if (classList.length === 0) {
    await seedClasses(env);
    const c2 = await env.DB.prepare('SELECT id,name,grade,cls,created_at FROM classes ORDER BY grade, cls').all();
    classList.length = 0;
    (c2.results || []).forEach((c) => classList.push({ id: c.id, name: c.name, grade: c.grade, cls: c.cls, createdAt: c.created_at }));
  }

  return { settings, classes: classList, students: studentList, days, records };
}

async function upsertClass(env, cls) {
  await env.DB.prepare('INSERT OR REPLACE INTO classes (id,name,grade,cls,created_at) VALUES (?,?,?,?,?)')
    .bind(cls.id, cls.name, cls.grade == null ? null : cls.grade, cls.cls == null ? null : cls.cls, cls.createdAt || Date.now()).run();
}

async function deleteClassCascade(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM records WHERE student_id IN (SELECT id FROM students WHERE class_id=?)').bind(id),
    env.DB.prepare('DELETE FROM students WHERE class_id=?').bind(id),
    env.DB.prepare('DELETE FROM days WHERE class_id=?').bind(id),
    env.DB.prepare('DELETE FROM classes WHERE id=?').bind(id)
  ]);
}

async function upsertStudent(env, st) {
  await env.DB.prepare('INSERT OR REPLACE INTO students (id,class_id,name,id_card,created_at) VALUES (?,?,?,?,?)')
    .bind(st.id, st.classId, st.name, st.idCard, st.createdAt || Date.now()).run();
}

async function deleteStudentCascade(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM records WHERE student_id=?').bind(id),
    env.DB.prepare('DELETE FROM students WHERE id=?').bind(id)
  ]);
}

async function upsertDay(env, classId, month, days) {
  await env.DB.prepare('INSERT OR REPLACE INTO days (class_id,month,days) VALUES (?,?,?)')
    .bind(classId, month, days).run();
}

async function upsertRecord(env, studentId, month, rec) {
  await env.DB.prepare('INSERT OR REPLACE INTO records (student_id,month,standard,remark,deduction) VALUES (?,?,?,?,?)')
    .bind(studentId, month, rec.standard, rec.remark, rec.deduction).run();
}

async function deleteMonth(env, month) {
  await env.DB.prepare('DELETE FROM records WHERE month=?').bind(month).run();
}

async function saveSettings(env, settings) {
  await env.DB.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)')
    .bind('settings', JSON.stringify(settings)).run();
}

/* ============================ 业务处理 ============================ */

async function hClassesAdd(body, env, state) {
  const name = requireString(body.name, '班级名称', 60);
  if (state.classes.some((c) => c.name === name)) throw new ApiError(400, '已存在同名班级「' + name + '」');
  const cls = { id: newId('c'), name: name, createdAt: Date.now() };
  await upsertClass(env, cls);
  state.classes.push(cls);
  return { ok: true, cls: cls };
}

async function hClassesRename(body, env, state) {
  const cls = findClass(state, body.id);
  const name = requireString(body.name, '班级名称', 60);
  if (state.classes.some((c) => c.name === name && c.id !== cls.id)) throw new ApiError(400, '已存在同名班级「' + name + '」');
  cls.name = name;
  await upsertClass(env, cls);
  return { ok: true, cls: cls };
}

async function hClassesDelete(body, env, state) {
  await requirePassword(body, state);
  const cls = findClass(state, body.id);
  const removedStudents = state.students.filter((s) => s.classId === cls.id).length;
  await deleteClassCascade(env, cls.id);
  state.classes = state.classes.filter((c) => c.id !== cls.id);
  state.students = state.students.filter((s) => s.classId !== cls.id);
  Object.keys(state.days).forEach((k) => { if (k.split('|')[0] === cls.id) delete state.days[k]; });
  Object.keys(state.records).forEach((m) => {
    Object.keys(state.records[m]).forEach((sid) => { if (!state.students.some((s) => s.id === sid)) delete state.records[m][sid]; });
    if (Object.keys(state.records[m]).length === 0) delete state.records[m];
  });
  return { ok: true, removedStudents: removedStudents };
}

async function hDaysSet(body, env, state) {
  await requirePassword(body, state);
  const month = body.month;
  if (!isValidMonth(month)) throw new ApiError(400, '月份格式不正确（应为 YYYY-MM）');
  const days = Number(body.days);
  if (!isFinite(days) || days < 0 || days > 31 || Math.floor(days) !== days) throw new ApiError(400, '应就餐天数必须为 0 ~ 31 之间的整数');
  const ids = Array.isArray(body.classIds) ? body.classIds : [];
  if (!ids.length) throw new ApiError(400, '请至少选择一个班级');
  const affected = [];
  for (const id of ids) {
    const cls = state.classes.find((c) => c.id === id);
    if (!cls) continue;
    await upsertDay(env, id, month, days);
    state.days[daysKey(id, month)] = days;
    affected.push(cls.name);
  }
  if (!affected.length) throw new ApiError(400, '所选班级均不存在');
  return { ok: true, month: month, days: days, affected: affected };
}

async function hStudentsAdd(body, env, state) {
  const name = requireString(body.name, '姓名', 30);
  findClass(state, body.classId);
  const chk = validateIdCard(body.idCard);
  if (!chk.ok) throw new ApiError(400, '【' + name + '】' + chk.msg);
  if (state.students.some((s) => s.idCard === chk.value)) throw new ApiError(400, '身份证号「' + chk.value + '」已存在，不能重复添加');
  const st = { id: newId('s'), name: name, idCard: chk.value, classId: body.classId, createdAt: Date.now() };
  await upsertStudent(env, st);
  state.students.push(st);
  return { ok: true, student: st };
}

async function hStudentsUpdate(body, env, state) {
  const st = findStudent(state, body.id);
  const name = requireString(body.name, '姓名', 30);
  findClass(state, body.classId);
  const chk = validateIdCard(body.idCard);
  if (!chk.ok) throw new ApiError(400, '【' + name + '】' + chk.msg);
  if (state.students.some((s) => s.idCard === chk.value && s.id !== st.id)) throw new ApiError(400, '身份证号「' + chk.value + '」已被其他学生使用');
  st.name = name; st.idCard = chk.value; st.classId = body.classId;
  await upsertStudent(env, st);
  return { ok: true, student: st };
}

async function hStudentsDelete(body, env, state) {
  const st = findStudent(state, body.id);
  await deleteStudentCascade(env, st.id);
  state.students = state.students.filter((s) => s.id !== st.id);
  Object.keys(state.records).forEach((m) => {
    delete state.records[m][st.id];
    if (Object.keys(state.records[m]).length === 0) delete state.records[m];
  });
  return { ok: true };
}

async function hStudentsImport(body, env, state) {
  findClass(state, body.classId);
  const text = String(body.text == null ? '' : body.text);
  const lines = text.split(/\r\n|\r|\n/);
  const existing = new Set(state.students.map((s) => s.idCard));
  const added = [];
  const errors = [];
  let duplicate = 0;
  let blank = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx].trim();
    if (!raw) { blank++; continue; }
    const parts = raw.split(/[,，、;；\t\s]+/).filter((x) => x !== '');
    if (parts.length < 2) {
      errors.push({ line: idx + 1, text: raw, msg: '缺少身份证号，格式应为「姓名，身份证号」' });
      continue;
    }
    const name = parts[0].trim();
    const idRaw = parts[parts.length - 1].trim();
    const chk = validateIdCard(idRaw);
    if (!chk.ok) { errors.push({ line: idx + 1, text: raw, msg: chk.msg }); continue; }
    if (existing.has(chk.value)) { duplicate++; continue; }
    existing.add(chk.value);
    const st = { id: newId('s'), name: name, idCard: chk.value, classId: body.classId, createdAt: Date.now() };
    await upsertStudent(env, st);
    state.students.push(st);
    added.push(st);
  }

  return { ok: true, added: added.length, duplicate: duplicate, blank: blank, errors: errors, students: added };
}

async function hRecordsCell(body, env, state) {
  const month = body.month;
  if (!isValidMonth(month)) throw new ApiError(400, '月份格式不正确（应为 YYYY-MM）');
  const st = findStudent(state, body.studentId);
  const field = body.field;
  const cur = getRecord(state, month, st.id);
  let next;
  if (field === 'standard') {
    const key = String(body.value || '');
    if (STANDARD_KEYS.indexOf(key) < 0) throw new ApiError(400, '用餐标准不合法');
    next = { standard: key, remark: cur.remark, deduction: cur.deduction };
  } else if (field === 'remark') {
    next = { standard: cur.standard, remark: String(body.value == null ? '' : body.value).slice(0, 200), deduction: cur.deduction };
  } else if (field === 'deduction') {
    const v = body.value === '' || body.value == null ? 0 : Number(body.value);
    if (!isFinite(v) || v < 0) throw new ApiError(400, '应扣除费用必须是不小于 0 的数字');
    next = { standard: cur.standard, remark: cur.remark, deduction: money(v) };
  } else {
    throw new ApiError(400, '字段不合法');
  }
  await upsertRecord(env, st.id, month, next);
  if (!state.records[month]) state.records[month] = {};
  state.records[month][st.id] = next;
  return { ok: true, row: buildRow(st, month, state) };
}

async function hRecordsClearMonth(body, env, state) {
  await requirePassword(body, state);
  const month = body.month;
  if (!isValidMonth(month)) throw new ApiError(400, '月份格式不正确（应为 YYYY-MM）');
  await deleteMonth(env, month);
  delete state.records[month];
  return { ok: true, month: month };
}

async function hSettingsPrices(body, env, state) {
  await requirePassword(body, state);
  const b = Number(body.breakfastPrice);
  const l = Number(body.lunchPrice);
  if (!isFinite(b) || b < 0 || b > 10000) throw new ApiError(400, '早餐价格不合法');
  if (!isFinite(l) || l < 0 || l > 10000) throw new ApiError(400, '午餐价格不合法');
  const settings = Object.assign({}, state.settings, { breakfastPrice: money(b), lunchPrice: money(l) });
  await saveSettings(env, settings);
  state.settings = settings;
  return { ok: true, settings: { breakfastPrice: money(b), lunchPrice: money(l) } };
}

async function hSettingsPassword(body, env, state) {
  const oldPwd = String(body.oldPassword == null ? '' : body.oldPassword);
  if ((await hashPassword(oldPwd, state.settings.salt)) !== state.settings.passwordHash) throw new ApiError(403, '当前密码错误');
  const np = String(body.newPassword == null ? '' : body.newPassword);
  if (np.length < 6) throw new ApiError(400, '新密码至少需要 6 位');
  const settings = Object.assign({}, state.settings, { passwordHash: await hashPassword(np, state.settings.salt) });
  await saveSettings(env, settings);
  state.settings = settings;
  return { ok: true };
}

async function hVerify(body, env, state) {
  await requirePassword(body, state);
  return { ok: true };
}

const HANDLERS = {
  'POST /api/classes/add': hClassesAdd,
  'POST /api/classes/rename': hClassesRename,
  'POST /api/classes/delete': hClassesDelete,
  'POST /api/days/set': hDaysSet,
  'POST /api/students/add': hStudentsAdd,
  'POST /api/students/update': hStudentsUpdate,
  'POST /api/students/delete': hStudentsDelete,
  'POST /api/students/import': hStudentsImport,
  'POST /api/records/cell': hRecordsCell,
  'POST /api/records/clearMonth': hRecordsClearMonth,
  'POST /api/settings/prices': hSettingsPrices,
  'POST /api/settings/password': hSettingsPassword,
  'POST /api/verify': hVerify
};

/* ============================ 导出 ============================ */

function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && isFinite(v)) return String(v);
  return '"' + String(v).replace(/"/g, '""') + '"';
}

function toCsv(rows) {
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function buildExportRows(month, classId, state) {
  const students = state.students
    .filter((s) => (classId ? s.classId === classId : true))
    .slice()
    .sort((a, b) => {
      const ca = state.classes.find((c) => c.id === a.classId);
      const cb = state.classes.find((c) => c.id === b.classId);
      const na = ca ? ca.name : '';
      const nb = cb ? cb.name : '';
      if (na !== nb) return na.localeCompare(nb, 'zh-CN');
      return a.name.localeCompare(b.name, 'zh-CN');
    });

  const head = ['班级', '姓名', '身份证号', '用餐标准', '每日餐费', '本月应就餐天数', '总费用', '备注', '应扣除费用', '当月真实费用'];
  const rows = [head];
  let sumTotal = 0, sumDeduct = 0, sumReal = 0;

  students.forEach((st) => {
    const r = buildRow(st, month, state);
    const cls = state.classes.find((c) => c.id === st.classId);
    rows.push([
      cls ? cls.name : '', r.name, r.idCard, r.standardLabel, r.dailyFee, r.days,
      r.total, r.remark, r.deduction, r.real
    ]);
    sumTotal += r.total; sumDeduct += r.deduction; sumReal += r.real;
  });

  rows.push([
    '合计', '共 ' + students.length + ' 名学生', '', '', '', '',
    money(sumTotal), '', money(sumDeduct), money(sumReal)
  ]);
  return rows;
}

async function handleXlsx(request, env) {
  const url = new URL(request.url);
  const qMonth = url.searchParams.get('month');
  const scope = url.searchParams.get('scope') === 'class' ? 'class' : 'all';
  const month = isValidMonth(qMonth) ? qMonth : currentMonth();
  const classId = url.searchParams.get('classId') || '';
  const state = await loadState(env);
  if (scope === 'class') {
    const cls = state.classes.find((c) => c.id === classId);
    if (!cls) return new Response('班级不存在', { status: 400 });
  }
  const sheets = buildMealSheets(month, scope, classId, state, SCHOOL_CLASSES);
  if (!sheets) return new Response('班级不存在', { status: 400 });
  const buf = renderMealWorkbook(sheets);
  const filename = month + ' 附小学生餐费核对表.xlsx';
  const encoded = encodeURIComponent(filename);
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encoded,
      'Cache-Control': 'no-store'
    }
  });
}

async function handleCsv(request, env) {
  const url = new URL(request.url);
  const qMonth = url.searchParams.get('month');
  const scope = url.searchParams.get('scope') === 'class' ? 'class' : 'all';
  const month = isValidMonth(qMonth) ? qMonth : currentMonth();
  let classId = url.searchParams.get('classId') || '';
  const state = await loadState(env);
  let prefix = month + '-全校就餐费用明细';
  if (scope === 'class') {
    const cls = state.classes.find((c) => c.id === classId);
    if (!cls) return new Response('班级不存在', { status: 400 });
    prefix = month + '-' + cls.name + '-就餐费用明细';
  } else {
    classId = '';
  }
  const csv = toCsv(buildExportRows(month, classId, state));
  const filename = prefix + '.csv';
  const encoded = encodeURIComponent(filename);
  return new Response('\uFEFF' + csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encoded,
      'Cache-Control': 'no-store'
    }
  });
}

/* ============================ 入口 ============================ */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;

  // 二进制导出（GET）
  if (pathname === '/api/export/xlsx') return handleXlsx(request, env);
  if (pathname === '/api/export') return handleCsv(request, env);

  if (pathname.indexOf('/api/') !== 0) return jsonResponse({ ok: false, message: 'Not found' }, 404);

  const state = await loadState(env);

  if (method === 'GET') {
    if (pathname === '/api/state') {
      return jsonResponse({
        ok: true,
        settings: { breakfastPrice: money(state.settings.breakfastPrice), lunchPrice: money(state.settings.lunchPrice) },
        standards: MEAL_STANDARDS,
        defaultStandard: DEFAULT_STANDARD,
        classes: state.classes,
        students: state.students,
        days: state.days,
        records: state.records,
        months: listMonths(state),
        currentMonth: currentMonth()
      });
    }
    return jsonResponse({ ok: false, message: '接口不存在：' + method + ' ' + pathname }, 404);
  }

  if (method !== 'POST') return jsonResponse({ ok: false, message: '不支持的请求方法' }, 405);

  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  if (!body || typeof body !== 'object') body = {};

  const key = method + ' ' + pathname;
  const handler = HANDLERS[key];
  if (!handler) return jsonResponse({ ok: false, message: '接口不存在：' + key }, 404);
  try {
    const result = await handler(body, env, state, url);
    return jsonResponse(result || { ok: true });
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    if (status >= 500) console.error('[error]', key, err);
    return jsonResponse({ ok: false, message: err.message || '服务器内部错误' }, status);
  }
}
