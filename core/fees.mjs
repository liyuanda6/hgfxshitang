// 纯计算核心（无 IO、无 Buffer 依赖），供 Pages Function 与本地 server 共用。
// 逻辑与 server.js 完全对应，保证云端/本地算出的费用数字一致。

export const MEAL_STANDARDS = [
  { key: 'BL', label: '早餐+中餐' },
  { key: 'B', label: '仅早餐' },
  { key: 'L', label: '仅中餐' }
];
export const STANDARD_KEYS = MEAL_STANDARDS.map((s) => s.key);
export const DEFAULT_STANDARD = 'BL';

export function money(n) {
  const v = Number(n);
  if (!isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

export function standardLabel(key) {
  const f = MEAL_STANDARDS.find((s) => s.key === key);
  return f ? f.label : MEAL_STANDARDS[0].label;
}

export function dailyFeeOf(standard, prices) {
  const p = prices || { breakfastPrice: 6, lunchPrice: 11 };
  if (standard === 'B') return money(p.breakfastPrice);
  if (standard === 'L') return money(p.lunchPrice);
  return money(p.breakfastPrice + p.lunchPrice); // BL 默认
}

export function daysKey(classId, month) {
  return classId + '|' + month;
}

export function getDays(state, classId, month) {
  const v = state.days ? state.days[daysKey(classId, month)] : undefined;
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0;
}

export function getRecord(state, month, studentId) {
  const m = state.records ? state.records[month] : null;
  const r = m && m[studentId];
  if (!r) return { standard: DEFAULT_STANDARD, remark: '', deduction: 0 };
  return {
    standard: STANDARD_KEYS.indexOf(r.standard) >= 0 ? r.standard : DEFAULT_STANDARD,
    remark: r.remark || '',
    deduction: money(r.deduction)
  };
}

/** 单个学生的完整费用行（与 server.js buildRow 一致） */
export function buildRow(student, month, state) {
  const rec = getRecord(state, month, student.id);
  const days = getDays(state, student.classId, month);
  const daily = dailyFeeOf(rec.standard, state.settings);
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

export function isValidMonth(m) {
  return typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
}

/** 当前月份（按 Asia/Shanghai，避免云端 UTC 跨月偏差） */
export function currentMonth() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit'
  });
  return fmt.format(new Date()).slice(0, 7); // 'YYYY-MM-DD' -> 'YYYY-MM'
}

export function listMonths(state) {
  const set = new Set();
  set.add(currentMonth());
  Object.keys(state.days || {}).forEach((k) => {
    const m = k.split('|')[1];
    if (isValidMonth(m)) set.add(m);
  });
  Object.keys(state.records || {}).forEach((m) => {
    if (isValidMonth(m)) set.add(m);
  });
  return Array.from(set).sort().reverse();
}

/* ----------------------- 身份证校验（与 server.js 一致） ----------------------- */

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

export function validateIdCard(raw) {
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

/* ----------------------- 班级名解析（中文数字） ----------------------- */

export function cn2intCN(s) {
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

export function parseClassName(name) {
  // 支持「一年级1班」「三年级5班」等（年级中文、班号阿拉伯数字）形式
  const m = /^([一二三四五六七八九十]+)年级(\d+)班$/.exec(name || '');
  if (!m) return null;
  return [cn2intCN(m[1]), parseInt(m[2], 10)];
}

/* ----------------------- 餐费核对表 sheets（纯数据，不含 Buffer） ----------------------- */

/**
 * 生成《附小学生餐费核对表》的工作表数据数组（供 lib/xlsx-export.renderMealWorkbook 消费）。
 * scope=all  -> 全校所有班（每班一工作表，含空模板）
 * scope=class -> 仅指定 classId 的班（单工作表）
 */
export function buildMealSheets(month, scope, classId, state, schoolClasses) {
  const school = (schoolClasses && schoolClasses.school) || '黄冈中学附属小学';
  const parts = String(month).split('-');
  const year = parts[0];
  const mnum = parseInt(parts[1], 10) || 1;
  const monthLabel = year + '年' + mnum + '月';
  const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

  let targets;
  if (scope === 'class') {
    const cls = state.classes.find((c) => c.id === classId);
    if (!cls) return null; // 调用方处理 404
    const k = parseClassName(cls.name) || [1, 1];
    targets = [{ grade: k[0], cls: k[1], name: cls.name }];
  } else if (schoolClasses && Array.isArray(schoolClasses.classes)) {
    targets = schoolClasses.classes.map((c) => ({ grade: c.grade, cls: c.cls, name: c.name }));
  } else {
    targets = state.classes
      .map((c) => { const k = parseClassName(c.name); return k ? { grade: k[0], cls: k[1], name: c.name } : null; })
      .filter(Boolean);
  }

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
        const r = buildRow(st, month, state);
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

  return sheets;
}
