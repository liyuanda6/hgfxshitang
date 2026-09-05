'use strict';

/**
 * 班级就餐统计系统 —— 后端服务
 * 纯 Node.js 实现，零第三方依赖，数据持久化到本地 JSON 文件。
 *
 * 启动： node server.js
 * 访问： http://服务器IP:3000
 * 环境变量： PORT(默认3000)  HOST(默认0.0.0.0)  DATA_DIR(默认 ./data)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 纯 Node 实现的《学生餐费核对表》多工作表 xlsx 生成器（零依赖）
const xlsxExport = require('./lib/xlsx-export');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const BAK_FILE = path.join(DATA_DIR, 'data.json.bak');

// 全校班级清单（来源于工作安排表，含尚无数据的班；导出时统一生成每个班一个工作表）
let SCHOOL_CLASSES = null;
try {
  const sc = JSON.parse(fs.readFileSync(path.join(ROOT, 'school-classes.json'), 'utf8'));
  if (sc && Array.isArray(sc.classes)) SCHOOL_CLASSES = sc;
} catch (e) {
  SCHOOL_CLASSES = null;
}

/* ============================ 常量 ============================ */

const MEAL_STANDARDS = [
  { key: 'BL', label: '早餐+中餐' },
  { key: 'B', label: '仅早餐' },
  { key: 'L', label: '仅中餐' }
];
const STANDARD_KEYS = MEAL_STANDARDS.map((s) => s.key);
const DEFAULT_STANDARD = 'BL';

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

const MAX_BODY = 20 * 1024 * 1024; // 20MB

/* ============================ 工具函数 ============================ */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function money(n) {
  const v = Number(n);
  if (!isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

function hashPassword(password, salt) {
  return crypto
    .createHash('sha256')
    .update(String(salt) + '::' + String(password))
    .digest('hex');
}

function nowMonth() {
  const d = new Date();
  const m = d.getMonth() + 1;
  return d.getFullYear() + '-' + String(m).padStart(2, '0');
}

function isValidMonth(m) {
  return typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
}

/** 18 位身份证号校验（含第 18 位校验位与出生日期合法性） */
function validateIdCard(raw) {
  const id = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) {
    return { ok: false, msg: '身份证号必须为 18 位（前 17 位为数字，最后一位为数字或 X）' };
  }
  const y = Number(id.slice(6, 10));
  const mo = Number(id.slice(10, 12));
  const d = Number(id.slice(12, 14));
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    return { ok: false, msg: '身份证号中的出生日期无效' };
  }
  if (dt.getTime() > Date.now()) {
    return { ok: false, msg: '身份证号中的出生日期晚于今天' };
  }
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += ID_WEIGHTS[i] * Number(id.charAt(i));
  if (ID_CHECK[sum % 11] !== id.charAt(17)) {
    return { ok: false, msg: '身份证号校验位错误（请检查是否输入有误）' };
  }
  return { ok: true, value: id };
}

/* ============================ 数据层 ============================ */

/** 首次部署时，从 school-classes.json 自动生成全校班级（27 个） */
function buildSeedClasses() {
  if (!SCHOOL_CLASSES || !Array.isArray(SCHOOL_CLASSES.classes)) return [];
  return SCHOOL_CLASSES.classes.map((c) => ({
    id: newId('c'),
    name: c.name,
    grade: c.grade,
    cls: c.cls,
    createdAt: Date.now()
  }));
}

function defaultState() {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    version: 1,
    settings: {
      breakfastPrice: 6,
      lunchPrice: 11,
      salt: salt,
      passwordHash: hashPassword('admin', salt)
    },
    // 首次部署即自动创建全校班级（来源于工作安排表 school-classes.json）
    // 若已有 data.json，则沿用其中的班级，不会重复创建
    classes: buildSeedClasses(),
    students: [],
    // days:   { "classId|2026-09": 18 }
    days: {},
    // records:{ "2026-09": { studentId: { standard, remark, deduction } } }
    records: {}
  };
}

function migrate(s) {
  const d = defaultState();
  s = s && typeof s === 'object' ? s : {};
  const out = {
    version: 1,
    settings: Object.assign({}, d.settings, s.settings || {}),
    classes: Array.isArray(s.classes) ? s.classes : [],
    students: Array.isArray(s.students) ? s.students : [],
    days: s.days && typeof s.days === 'object' ? s.days : {},
    records: s.records && typeof s.records === 'object' ? s.records : {}
  };
  if (!out.settings.salt) out.settings.salt = d.settings.salt;
  if (!out.settings.passwordHash) {
    out.settings.passwordHash = hashPassword('admin', out.settings.salt);
  }
  out.settings.breakfastPrice = money(out.settings.breakfastPrice);
  out.settings.lunchPrice = money(out.settings.lunchPrice);
  // 清理脏数据
  out.classes = out.classes.filter((c) => c && c.id && c.name);
  const classIds = new Set(out.classes.map((c) => c.id));
  out.students = out.students.filter((st) => st && st.id && classIds.has(st.classId));
  for (const month of Object.keys(out.records)) {
    if (!isValidMonth(month)) { delete out.records[month]; continue; }
    for (const sid of Object.keys(out.records[month])) {
      const r = out.records[month][sid] || {};
      out.records[month][sid] = {
        standard: STANDARD_KEYS.indexOf(r.standard) >= 0 ? r.standard : DEFAULT_STANDARD,
        remark: typeof r.remark === 'string' ? r.remark : '',
        deduction: money(r.deduction)
      };
    }
  }
  return out;
}

function loadState() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(DATA_FILE)) {
    const s = defaultState();
    saveState(s);
    console.log('[初始化] 已创建数据文件：' + DATA_FILE);
    return s;
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return migrate(JSON.parse(raw));
  } catch (err) {
    console.error('[严重] 数据文件损坏：' + err.message);
    try {
      fs.copyFileSync(DATA_FILE, path.join(DATA_DIR, 'corrupted-' + Date.now() + '.json'));
      fs.copyFileSync(DATA_FILE, BAK_FILE);
    } catch (e) { /* ignore */ }
    console.error('[严重] 已将损坏文件另存，并回退到上一次备份。');
    if (fs.existsSync(BAK_FILE)) {
      try { return migrate(JSON.parse(fs.readFileSync(BAK_FILE, 'utf8'))); } catch (e) { /* ignore */ }
    }
    return defaultState();
  }
}

let saveTimer = null;
function saveState(s) {
  ensureDir(DATA_DIR);
  try {
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BAK_FILE);
  } catch (e) { /* 首次写入时无原文件，忽略 */ }
  const tmp = DATA_FILE + '.tmp';
  const json = JSON.stringify(s, null, 2);
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

/** 合并短时间内的多次写入，避免频繁落盘 */
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { saveState(state); } catch (e) { console.error('[错误] 保存失败：' + e.message); }
  }, 120);
}

let state = loadState();

/* ============================ 业务计算 ============================ */

function getPriceSettings() {
  return {
    breakfastPrice: money(state.settings.breakfastPrice),
    lunchPrice: money(state.settings.lunchPrice)
  };
}

function dailyFeeOf(standard) {
  const p = getPriceSettings();
  if (standard === 'B') return money(p.breakfastPrice);
  if (standard === 'L') return money(p.lunchPrice);
  return money(p.breakfastPrice + p.lunchPrice); // BL 默认
}

function standardLabel(key) {
  const f = MEAL_STANDARDS.find((s) => s.key === key);
  return f ? f.label : MEAL_STANDARDS[0].label;
}

function daysKey(classId, month) {
  return classId + '|' + month;
}

function getDays(classId, month) {
  const v = state.days[daysKey(classId, month)];
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0;
}

function getRecord(month, studentId) {
  const m = state.records[month];
  const r = m && m[studentId];
  if (!r) return { standard: DEFAULT_STANDARD, remark: '', deduction: 0 };
  return {
    standard: STANDARD_KEYS.indexOf(r.standard) >= 0 ? r.standard : DEFAULT_STANDARD,
    remark: r.remark || '',
    deduction: money(r.deduction)
  };
}

function setRecord(month, studentId, patch) {
  if (!state.records[month]) state.records[month] = {};
  const cur = getRecord(month, studentId);
  state.records[month][studentId] = {
    standard: patch.standard !== undefined ? patch.standard : cur.standard,
    remark: patch.remark !== undefined ? String(patch.remark) : cur.remark,
    deduction: patch.deduction !== undefined ? money(patch.deduction) : cur.deduction
  };
}

/** 单个学生的完整费用行 */
function buildRow(student, month) {
  const rec = getRecord(month, student.id);
  const days = getDays(student.classId, month);
  const daily = dailyFeeOf(rec.standard);
  const total = money(days * daily);
  const real = money(Math.max(total - rec.deduction, 0));
  return {
    studentId: student.id,
    name: student.name,
    idCard: student.idCard,
    classId: student.classId,
    days: days,
    standard: rec.standard,
    standardLabel: standardLabel(rec.standard),
    dailyFee: daily,
    remark: rec.remark,
    deduction: rec.deduction,
    total: total,
    real: real
  };
}

/* ============================ 餐费核对表 xlsx 导出 ============================ */

function cn2intCN(s) {
  s = String(s).trim();
  const CN = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  if (CN[s]) return CN[s];
  if (s.indexOf('十') === 0) return 10 + (CN[s[1]] || 0);
  if (s.indexOf('十') > 0) {
    const parts = s.split('十');
    return (CN[parts[0]] || 1) * 10 + (CN[parts[1]] || 0);
  }
  return parseInt(s, 10) || 0;
}

function parseClassName(name) {
  // 支持「一年级1班」「三年级5班」等（年级中文、班号阿拉伯数字）形式
  const m = /^([一二三四五六七八九十]+)年级(\d+)班$/.exec(name || '');
  if (!m) return null;
  return [cn2intCN(m[1]), parseInt(m[2], 10)];
}

/**
 * 生成《附小学生餐费核对表》多工作表 xlsx。
 * scope=all  -> 全校所有班（每班一工作表，含空模板）
 * scope=class -> 仅指定 classId 的班（单工作表）
 */
function buildMealWorkbook(month, scope, classId) {
  const school = (SCHOOL_CLASSES && SCHOOL_CLASSES.school) || '黄冈中学附属小学';
  const parts = String(month).split('-');
  const year = parts[0];
  const mnum = parseInt(parts[1], 10) || 1;
  const monthLabel = year + '年' + mnum + '月';
  const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

  let targets;
  if (scope === 'class') {
    const cls = state.classes.find((c) => c.id === classId);
    if (!cls) throw new ApiError(400, '班级不存在');
    const k = parseClassName(cls.name) || [1, 1];
    targets = [{ grade: k[0], cls: k[1], name: cls.name }];
  } else if (SCHOOL_CLASSES) {
    targets = SCHOOL_CLASSES.classes.map((c) => ({ grade: c.grade, cls: c.cls, name: c.name }));
  } else {
    targets = state.classes
      .map((c) => { const k = parseClassName(c.name); return k ? { grade: k[0], cls: k[1], name: c.name } : null; })
      .filter(Boolean);
  }

  // 系统班级按 (grade,cls) 索引，便于取真实就餐数据
  const byKey = {};
  for (const c of state.classes) {
    const k = parseClassName(c.name);
    if (k) byKey[k[0] + '-' + k[1]] = c;
  }

  targets.sort((a, b) => (a.grade - b.grade) || (a.cls - b.cls));

  const sheets = targets.map((t) => {
    const g = CN_NUM[t.grade] || String(t.grade);
    const headerTitle = monthLabel + school + ' ' + g + ' 年级  ' + t.cls + '  班学生餐费核对表';
    const rows = [];
    const sysCls = byKey[t.grade + '-' + t.cls];
    if (sysCls) {
      const slist = state.students
        .filter((s) => s.classId === sysCls.id)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      slist.forEach((st, i) => {
        const r = buildRow(st, month);
        rows.push({
          seq: i + 1,
          name: r.name,
          type: r.standardLabel,
          dailyFee: r.dailyFee,
          days: r.days,
          total: r.real,
          remark: r.remark
        });
      });
    }
    return { title: t.name, headerTitle: headerTitle, hasData: rows.length > 0, rows: rows };
  });

  return xlsxExport.renderMealWorkbook(sheets);
}

function listMonths() {
  const set = new Set();
  set.add(nowMonth());
  Object.keys(state.days).forEach((k) => {
    const m = k.split('|')[1];
    if (isValidMonth(m)) set.add(m);
  });
  Object.keys(state.records).forEach((m) => {
    if (isValidMonth(m)) set.add(m);
  });
  return Array.from(set).sort().reverse();
}

/* ============================ HTTP 工具 ============================ */

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, code, text, headers) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code, Object.assign({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }, headers || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new ApiError(400, '请求数据格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function requirePassword(body) {
  const pwd = body && body.password;
  if (typeof pwd !== 'string' || pwd === '') {
    throw new ApiError(401, '请输入管理密码');
  }
  const hash = hashPassword(pwd, state.settings.salt);
  if (hash !== state.settings.passwordHash) {
    throw new ApiError(403, '管理密码错误，操作已拒绝');
  }
}

function requireString(v, name, maxLen) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new ApiError(400, name + '不能为空');
  if (maxLen && s.length > maxLen) throw new ApiError(400, name + '长度不能超过 ' + maxLen + ' 个字符');
  return s;
}

function findClass(id) {
  const c = state.classes.find((x) => x.id === id);
  if (!c) throw new ApiError(404, '班级不存在');
  return c;
}

function findStudent(id) {
  const s = state.students.find((x) => x.id === id);
  if (!s) throw new ApiError(404, '学生不存在');
  return s;
}

/* ============================ API ============================ */

const api = {};

/** 全量状态（前端按月份自行过滤） */
api['GET /api/state'] = function () {
  return {
    ok: true,
    settings: getPriceSettings(),
    standards: MEAL_STANDARDS,
    defaultStandard: DEFAULT_STANDARD,
    classes: state.classes,
    students: state.students,
    days: state.days,
    records: state.records,
    months: listMonths(),
    currentMonth: nowMonth()
  };
};

/* ---------- 班级 ---------- */

api['POST /api/classes/add'] = function (body) {
  const name = requireString(body.name, '班级名称', 60);
  if (state.classes.some((c) => c.name === name)) {
    throw new ApiError(400, '已存在同名班级「' + name + '」');
  }
  const cls = { id: newId('c'), name: name, createdAt: Date.now() };
  state.classes.push(cls);
  scheduleSave();
  return { ok: true, cls: cls };
};

api['POST /api/classes/rename'] = function (body) {
  const cls = findClass(body.id);
  const name = requireString(body.name, '班级名称', 60);
  if (state.classes.some((c) => c.name === name && c.id !== cls.id)) {
    throw new ApiError(400, '已存在同名班级「' + name + '」');
  }
  cls.name = name;
  scheduleSave();
  return { ok: true, cls: cls };
};

api['POST /api/classes/delete'] = function (body) {
  requirePassword(body);
  const cls = findClass(body.id);
  const removedStudents = state.students.filter((s) => s.classId === cls.id).map((s) => s.id);
  const removedSet = new Set(removedStudents);
  state.students = state.students.filter((s) => s.classId !== cls.id);
  state.classes = state.classes.filter((c) => c.id !== cls.id);
  Object.keys(state.days).forEach((k) => {
    if (k.split('|')[0] === cls.id) delete state.days[k];
  });
  Object.keys(state.records).forEach((m) => {
    Object.keys(state.records[m]).forEach((sid) => {
      if (removedSet.has(sid)) delete state.records[m][sid];
    });
    if (Object.keys(state.records[m]).length === 0) delete state.records[m];
  });
  scheduleSave();
  return { ok: true, removedStudents: removedStudents.length };
};

/** 批量 / 单班设置应就餐天数（需密码） */
api['POST /api/days/set'] = function (body) {
  requirePassword(body);
  const month = body.month;
  if (!isValidMonth(month)) throw new ApiError(400, '月份格式不正确（应为 YYYY-MM）');
  const days = Number(body.days);
  if (!isFinite(days) || days < 0 || days > 31 || Math.floor(days) !== days) {
    throw new ApiError(400, '应就餐天数必须为 0 ~ 31 之间的整数');
  }
  const ids = Array.isArray(body.classIds) ? body.classIds : [];
  if (!ids.length) throw new ApiError(400, '请至少选择一个班级');
  const affected = [];
  ids.forEach((id) => {
    const cls = state.classes.find((c) => c.id === id);
    if (!cls) return;
    state.days[daysKey(id, month)] = days;
    affected.push(cls.name);
  });
  if (!affected.length) throw new ApiError(400, '所选班级均不存在');
  scheduleSave();
  return { ok: true, month: month, days: days, affected: affected };
};

/* ---------- 学生 ---------- */

api['POST /api/students/add'] = function (body) {
  const name = requireString(body.name, '姓名', 30);
  findClass(body.classId);
  const idCheck = validateIdCard(body.idCard);
  if (!idCheck.ok) throw new ApiError(400, '【' + name + '】' + idCheck.msg);
  if (state.students.some((s) => s.idCard === idCheck.value)) {
    throw new ApiError(400, '身份证号「' + idCheck.value + '」已存在，不能重复添加');
  }
  const st = {
    id: newId('s'),
    name: name,
    idCard: idCheck.value,
    classId: body.classId,
    createdAt: Date.now()
  };
  state.students.push(st);
  scheduleSave();
  return { ok: true, student: st };
};

api['POST /api/students/update'] = function (body) {
  const st = findStudent(body.id);
  const name = requireString(body.name, '姓名', 30);
  findClass(body.classId);
  const idCheck = validateIdCard(body.idCard);
  if (!idCheck.ok) throw new ApiError(400, '【' + name + '】' + idCheck.msg);
  if (state.students.some((s) => s.idCard === idCheck.value && s.id !== st.id)) {
    throw new ApiError(400, '身份证号「' + idCheck.value + '」已被其他学生使用');
  }
  st.name = name;
  st.idCard = idCheck.value;
  st.classId = body.classId;
  scheduleSave();
  return { ok: true, student: st };
};

api['POST /api/students/delete'] = function (body) {
  const st = findStudent(body.id);
  state.students = state.students.filter((s) => s.id !== st.id);
  Object.keys(state.records).forEach((m) => {
    delete state.records[m][st.id];
    if (Object.keys(state.records[m]).length === 0) delete state.records[m];
  });
  scheduleSave();
  return { ok: true };
};

/** 批量导入：每行「姓名，身份证号」，分隔符支持 逗号 / 中文逗号 / 顿号 / 分号 / 空格 / 制表符 */
api['POST /api/students/import'] = function (body) {
  findClass(body.classId);
  const text = String(body.text == null ? '' : body.text);
  const lines = text.split(/\r\n|\r|\n/);
  const existing = new Set(state.students.map((s) => s.idCard));
  const added = [];
  const errors = [];
  let duplicate = 0;
  let blank = 0;

  lines.forEach((line, idx) => {
    const raw = line.trim();
    if (!raw) { blank++; return; }
    const parts = raw.split(/[,，、;；\t\s]+/).filter((x) => x !== '');
    if (parts.length < 2) {
      errors.push({ line: idx + 1, text: raw, msg: '缺少身份证号，格式应为「姓名，身份证号」' });
      return;
    }
    const name = parts[0].trim();
    const idRaw = parts[parts.length - 1].trim();
    const chk = validateIdCard(idRaw);
    if (!chk.ok) {
      errors.push({ line: idx + 1, text: raw, msg: chk.msg });
      return;
    }
    if (existing.has(chk.value)) {
      duplicate++;
      return;
    }
    existing.add(chk.value);
    const st = {
      id: newId('s'),
      name: name,
      idCard: chk.value,
      classId: body.classId,
      createdAt: Date.now()
    };
    state.students.push(st);
    added.push(st);
  });

  if (added.length) scheduleSave();
  return {
    ok: true,
    added: added.length,
    duplicate: duplicate,
    blank: blank,
    errors: errors,
    students: added
  };
};

/* ---------- 就餐登记 ---------- */

/** 行内编辑保存：field ∈ standard | remark | deduction */
api['POST /api/records/cell'] = function (body) {
  const month = body.month;
  if (!isValidMonth(month)) throw new ApiError(400, '月份格式不正确（应为 YYYY-MM）');
  const st = findStudent(body.studentId);
  const field = body.field;
  if (field === 'standard') {
    const key = String(body.value || '');
    if (STANDARD_KEYS.indexOf(key) < 0) throw new ApiError(400, '用餐标准不合法');
    setRecord(month, st.id, { standard: key });
  } else if (field === 'remark') {
    setRecord(month, st.id, { remark: String(body.value == null ? '' : body.value).slice(0, 200) });
  } else if (field === 'deduction') {
    const v = body.value === '' || body.value == null ? 0 : Number(body.value);
    if (!isFinite(v) || v < 0) throw new ApiError(400, '应扣除费用必须是不小于 0 的数字');
    setRecord(month, st.id, { deduction: money(v) });
  } else {
    throw new ApiError(400, '字段不合法');
  }
  scheduleSave();
  return { ok: true, row: buildRow(st, month) };
};

/** 清空某个月份的全部登记数据（班级、学生、应就餐天数保留） */
api['POST /api/records/clearMonth'] = function (body) {
  requirePassword(body);
  const month = body.month;
  if (!isValidMonth(month)) throw new ApiError(400, '月份格式不正确（应为 YYYY-MM）');
  delete state.records[month];
  scheduleSave();
  return { ok: true, month: month };
};

/* ---------- 设置 ---------- */

api['POST /api/settings/prices'] = function (body) {
  requirePassword(body);
  const b = Number(body.breakfastPrice);
  const l = Number(body.lunchPrice);
  if (!isFinite(b) || b < 0 || b > 10000) throw new ApiError(400, '早餐价格不合法');
  if (!isFinite(l) || l < 0 || l > 10000) throw new ApiError(400, '午餐价格不合法');
  state.settings.breakfastPrice = money(b);
  state.settings.lunchPrice = money(l);
  scheduleSave();
  return { ok: true, settings: getPriceSettings() };
};

api['POST /api/settings/password'] = function (body) {
  const oldPwd = String(body.oldPassword == null ? '' : body.oldPassword);
  if (hashPassword(oldPwd, state.settings.salt) !== state.settings.passwordHash) {
    throw new ApiError(403, '当前密码错误');
  }
  const np = String(body.newPassword == null ? '' : body.newPassword);
  if (np.length < 6) throw new ApiError(400, '新密码至少需要 6 位');
  state.settings.passwordHash = hashPassword(np, state.settings.salt);
  scheduleSave();
  return { ok: true };
};

api['POST /api/verify'] = function (body) {
  requirePassword(body);
  return { ok: true };
};

/* ============================ 导出 CSV ============================ */

function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && isFinite(v)) return String(v);
  return '"' + String(v).replace(/"/g, '""') + '"';
}

function toCsv(rows) {
  // UTF-8 BOM，保证 Excel 打开中文不乱码；CRLF 换行
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function fill(n, width) {
  const s = String(n);
  return s.length >= width ? s : new Array(width - s.length + 1).join('0') + s;
}

function buildExportRows(month, classId) {
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
    const r = buildRow(st, month);
    const cls = state.classes.find((c) => c.id === st.classId);
    rows.push([
      cls ? cls.name : '',
      r.name,
      r.idCard,
      r.standardLabel,
      r.dailyFee,
      r.days,
      r.total,
      r.remark,
      r.deduction,
      r.real
    ]);
    sumTotal += r.total;
    sumDeduct += r.deduction;
    sumReal += r.real;
  });

  rows.push([
    '合计',
    '共 ' + students.length + ' 名学生',
    '', '', '', '',
    money(sumTotal),
    '',
    money(sumDeduct),
    money(sumReal)
  ]);
  return rows;
}

function handleExport(req, res, query) {
  const qMonth = query.get('month');
  const scope = query.get('scope') === 'class' ? 'class' : 'all';
  const month = isValidMonth(qMonth) ? qMonth : nowMonth();
  let classId = query.get('classId') || '';
  let prefix = month + '-全校就餐费用明细';
  if (scope === 'class') {
    const cls = state.classes.find((c) => c.id === classId);
    if (!cls) return sendText(res, 400, '班级不存在');
    prefix = month + '-' + cls.name + '-就餐费用明细';
  } else {
    classId = '';
  }
  const csv = toCsv(buildExportRows(month, classId));
  const filename = prefix + '.csv';
  const encoded = encodeURIComponent(filename);
  const d = new Date();
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Length': Buffer.byteLength(csv, 'utf8'),
    'Content-Disposition': "attachment; filename*=UTF-8''" + encoded,
    'Cache-Control': 'no-store',
    'X-Export-Time': d.getFullYear() + '-' + fill(d.getMonth() + 1, 2) + '-' + fill(d.getDate(), 2)
  });
  res.end(csv);
  return true;
}

/* ============================ 静态文件 ============================ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, '禁止访问');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // 单页应用：未命中的路径回退到 index.html
      if (!path.extname(filePath)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, b2) => {
          if (e2) return sendText(res, 404, '页面不存在');
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': b2.length });
          res.end(b2);
        });
      }
      return sendText(res, 404, '资源不存在：' + rel);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

/* ============================ 服务器 ============================ */

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = u.pathname;

  // 访问日志：仅记录 API 请求（静态资源量大且无必要）
  const reqStart = Date.now();
  res.on('finish', () => {
    if (pathname.indexOf('/api/') === 0) {
      console.log(
        new Date().toISOString() +
        ' ' + req.method +
        ' ' + pathname +
        ' -> ' + res.statusCode +
        ' (' + (Date.now() - reqStart) + 'ms)'
      );
    }
  });

  if (pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  if (pathname.indexOf('/api/') === 0) {
    if (pathname === '/api/export') {
      Promise.resolve()
        .then(() => handleExport(req, res, u.searchParams))
        .catch((err) => sendJson(res, err.status || 500, { ok: false, message: err.message }));
      return;
    }
    if (pathname === '/api/export/xlsx') {
      Promise.resolve()
        .then(() => {
          const qMonth = u.searchParams.get('month');
          const scope = u.searchParams.get('scope') === 'class' ? 'class' : 'all';
          const month = isValidMonth(qMonth) ? qMonth : nowMonth();
          const classId = u.searchParams.get('classId') || '';
          const buf = buildMealWorkbook(month, scope, classId);
          const filename = month + ' 附小学生餐费核对表.xlsx';
          const encoded = encodeURIComponent(filename);
          res.writeHead(200, {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Length': buf.length,
            'Content-Disposition': "attachment; filename*=UTF-8''" + encoded,
            'Cache-Control': 'no-store'
          });
          res.end(buf);
        })
        .catch((err) => sendText(res, err.status || 500, err.message || '生成失败'));
      return;
    }
    const key = req.method + ' ' + pathname;
    readBody(req)
      .then((body) => {
        const handler = api[key];
        if (!handler) {
          return sendJson(res, 404, { ok: false, message: '接口不存在：' + key });
        }
        const result = handler(body || {}, u.searchParams);
        // 保证修改类操作返回前已落盘
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
          saveState(state);
        }
        sendJson(res, 200, result);
      })
      .catch((err) => {
        const status = err instanceof ApiError ? err.status : 500;
        if (status >= 500) console.error('[错误]', key, err);
        sendJson(res, status, { ok: false, message: err.message || '服务器内部错误' });
      });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, '不支持的请求方法');
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  班级就餐统计系统已启动');
  console.log('  ------------------------------------------');
  console.log('  监听地址：  http://' + HOST + ':' + PORT);
  if (HOST === '127.0.0.1' || HOST === 'localhost') {
    console.log('  访问方式：  仅本机（建议前置 Nginx 反代后对外）');
  } else {
    console.log('  访问方式：  已监听 0.0.0.0（请确认云安全组已放行 ' + PORT + ' 端口）');
  }
  console.log('  数据文件：  ' + DATA_FILE);
  console.log('  自动备份：  ' + BAK_FILE);
  console.log('  当前月份：  ' + nowMonth());
  console.log('  班级数量：  ' + state.classes.length);
  console.log('  ------------------------------------------');
  console.log('  上线后请到「系统设置」页修改默认管理密码 admin');
  console.log('');
});

/** 优雅关闭：落地数据后再退出，避免 systemd 停服(SIGTERM)丢数据 */
function gracefulShutdown(signal) {
  try {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveState(state);
  } catch (e) { /* ignore */ }
  console.log('\n[' + signal + '] 数据已保存，服务关闭。');
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('[未处理的 Promise 拒绝]', reason);
});
