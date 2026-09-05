// 本地端到端自测：用 node:sqlite 模拟 Cloudflare D1 的接口，驱动真实 onRequest 处理器。
// 无需 wrangler / 账号 / 网络。运行：node test-d1.mjs

import { DatabaseSync } from 'node:sqlite';
import { onRequest } from './core/handler.mjs';
import { buildMealSheets, buildRow } from './core/fees.mjs';

/* ---------- D1 接口 mock（与 Cloudflare D1 行为一致） ---------- */

const SCHEMA = `
CREATE TABLE classes (id TEXT PRIMARY KEY, name TEXT NOT NULL, grade INTEGER, cls INTEGER, created_at INTEGER);
CREATE TABLE students (id TEXT PRIMARY KEY, class_id TEXT NOT NULL, name TEXT NOT NULL, id_card TEXT, created_at INTEGER);
CREATE TABLE days (class_id TEXT NOT NULL, month TEXT NOT NULL, days INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (class_id, month));
CREATE TABLE records (student_id TEXT NOT NULL, month TEXT NOT NULL, standard TEXT, remark TEXT, deduction REAL DEFAULT 0, PRIMARY KEY (student_id, month));
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

class MockStmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...p) { return new MockStmt(this.db, this.sql, p); }
  all() { return { results: this.db.prepare(this.sql).all(...this.params), success: true }; }
  first() { const r = this.db.prepare(this.sql).get(...this.params); return r || null; }
  run() { this.db.prepare(this.sql).run(...this.params); return { success: true }; }
}
class MockD1 {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(SCHEMA); }
  prepare(sql) { return new MockStmt(this.db, sql); }
  batch(stmts) { for (const s of stmts) s.run(); return { success: true }; }
  exec(sql) { this.db.exec(sql); return { success: true }; }
}

/* ---------- 测试工具 ---------- */

function makeReq(method, pathname, body) {
  return { method, url: 'http://localhost' + pathname, headers: {}, json: async () => body || {} };
}
async function call(env, method, pathname, body) {
  const res = await onRequest({ request: makeReq(method, pathname, body), env: { DB: env } });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json();
  else if (ct.includes('openxmlformats')) { const ab = await res.arrayBuffer(); data = { _buf: Buffer.from(ab), _status: res.status }; }
  else data = { _text: await res.text(), _status: res.status };
  return { status: res.status, data };
}

function assert(cond, msg) { if (!cond) { console.error('  ✗ ' + msg); process.exitCode = 1; } else console.log('  ✓ ' + msg); }

function makeValidId(prefix17) {
  const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const C = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0; for (let i = 0; i < 17; i++) sum += W[i] * Number(prefix17[i]);
  return prefix17 + C[sum % 11];
}

/* ---------- 1) 纯费用数学（与 server.js 数字一致） ---------- */

function testFeeMath() {
  console.log('\n[1] 费用计算核心（合成数据，预期 一年级1班=766 / 一年级2班=504）');
  const month = '2026-09';
  const c1 = 'c1', c2 = 'c2';
  const state = {
    settings: { breakfastPrice: 6, lunchPrice: 11 },
    classes: [{ id: c1, name: '一年级1班' }, { id: c2, name: '一年级2班' }],
    days: { [c1 + '|' + month]: 18, [c2 + '|' + month]: 18 },
    records: {},
    students: []
  };
  const add = (cls, name, id, standard, deduction, daysOverride) => {
    const sid = 's_' + id;
    state.students.push({ id: sid, classId: cls, name, idCard: makeValidId(id) });
    state.records[month] = state.records[month] || {};
    state.records[month][sid] = { standard, remark: deduction ? '扣' + deduction : '', deduction: deduction || 0 };
    if (daysOverride) state.days[cls + '|' + month] = daysOverride;
    return sid;
  };
  add(c1, '张明', '11010119900307051', 'BL', 0);
  add(c1, '李静', '11010119900307052', 'B', 0);
  add(c1, '王小雨', '11010119900307053', 'L', 33);      // 11*18 - 33 = 165
  add(c1, '赵天成', '11010119900307054', 'BL', 119);    // 17*18 - 119 = 187
  add(c2, '刘思远', '11010119900307055', 'BL', 0);       // 306
  add(c2, '陈欣怡', '11010119900307056', 'BL', 108);     // 306 - 108 = 198

  const schoolClasses = {
    school: '黄冈中学附属小学',
    classes: [{ grade: 1, cls: 1, name: '一年级1班' }, { grade: 1, cls: 2, name: '一年级2班' }]
  };
  const sheets = buildMealSheets(month, 'all', '', state, schoolClasses);
  const s1 = sheets.find((s) => s.title === '一年级1班');
  const s2 = sheets.find((s) => s.title === '一年级2班');
  console.log('   调试 s1.rows:', s1.rows.map((r) => r.name + '=' + r.total));
  const sum1 = s1.rows.reduce((a, b) => a + b.total, 0);
  const sum2 = s2.rows.reduce((a, b) => a + b.total, 0);
  assert(Math.round(sum1 * 100) / 100 === 766, '一年级1班合计 = 766  (实得 ' + sum1 + ')');
  assert(Math.round(sum2 * 100) / 100 === 504, '一年级2班合计 = 504  (实得 ' + sum2 + ')');
  // 单列行内校验
  const 王 = s1.rows.find((r) => r.name === '王小雨');
  assert(Math.round(王.total * 100) / 100 === 165, '王小雨(仅中餐15天-扣33) = 165');
}

/* ---------- 2) D1 集成：首启播种 / 密码 / 增删 / 导出 ---------- */

async function testD1() {
  console.log('\n[2] D1 集成（node:sqlite 模拟）');
  const env = new MockD1();

  // 首次访问自动播种 27 班 + 默认密码
  let r = await call(env, 'GET', '/api/state');
  assert(r.status === 200 && r.data.classes.length === 27, '首启自动播种 27 个班 (实得 ' + (r.data ? r.data.classes.length : '?') + ')');
  assert(r.data.classes[0].name === '一年级1班' && r.data.classes[26].name === '六年级3班', '班级顺序/命名正确');
  assert(r.data.currentMonth === '2026-09', 'currentMonth = 2026-09 (Asia/Shanghai)');

  // 密码校验
  r = await call(env, 'POST', '/api/verify', { password: 'admin' });
  assert(r.status === 200 && r.data.ok, '默认密码 admin 校验通过');
  r = await call(env, 'POST', '/api/verify', { password: 'wrong' });
  assert(r.status === 403, '错误密码被拒绝 (403)');

  // 找一个真实班（一年级1班）并加学生
  const c1 = r.data ? null : null;
  const state1 = await call(env, 'GET', '/api/state');
  const cls1 = state1.data.classes.find((c) => c.name === '一年级1班');
  const sid = makeValidId('11010119900307051');
  r = await call(env, 'POST', '/api/students/add', { classId: cls1.id, name: '张明', idCard: sid });
  assert(r.status === 200 && r.data.ok, '新增学生成功');

  // 设置应就餐天数（需密码）
  const month = state1.data.currentMonth;
  r = await call(env, 'POST', '/api/days/set', { month, days: 18, classIds: [cls1.id], password: 'admin' });
  assert(r.status === 200 && r.data.days === 18, '设置应就餐天数=18 成功');

  // 编辑单元格：standard=BL，再 deduction=100
  const st1 = (await call(env, 'GET', '/api/state')).data.students.find((s) => s.name === '张明');
  r = await call(env, 'POST', '/api/records/cell', { month, studentId: st1.id, field: 'standard', value: 'BL' });
  assert(r.status === 200 && Math.round(r.data.row.total * 100) / 100 === 306, '张明 早餐+中餐 18天 = 306');
  r = await call(env, 'POST', '/api/records/cell', { month, studentId: st1.id, field: 'deduction', value: 100 });
  assert(r.status === 200 && Math.round(r.data.row.real * 100) / 100 === 206, '张明 扣除100 → 真实费用 206');

  // 改密码后再校验
  r = await call(env, 'POST', '/api/settings/password', { oldPassword: 'admin', newPassword: 'newpass123' });
  assert(r.status === 200, '修改密码成功');
  r = await call(env, 'POST', '/api/verify', { password: 'admin' });
  assert(r.status === 403, '旧密码 admin 已失效');
  r = await call(env, 'POST', '/api/verify', { password: 'newpass123' });
  assert(r.status === 200, '新密码 newpass123 生效');

  // xlsx 导出（全校）返回合法 zip
  r = await call(env, 'GET', '/api/export/xlsx?month=' + month + '&scope=all');
  assert(r.status === 200 && r.data._buf && r.data._buf.slice(0, 2).toString() === 'PK', 'xlsx 导出返回合法 OOXML(zip, PK) 大小=' + (r.data._buf ? r.data._buf.length : 0));

  // csv 导出
  r = await call(env, 'GET', '/api/export?month=' + month + '&scope=all');
  assert(r.status === 200 && (r.data._text || '').includes('张明'), 'csv 导出包含学生数据');

  // 重新加载（新 env 等价“新一次请求”读回持久化数据）
  const env2 = new MockD1();
  // 注意：MockD1 是内存库，env2 不共享 env 数据；这里改为在同 env 再读一次确认持久化
  r = await call(env, 'GET', '/api/state');
  assert(r.data.students.length === 1 && r.data.students[0].name === '张明', '数据已持久化（学生仍在）');
  assert(r.data.days[cls1.id + '|' + month] === 18, '天数已持久化');
}

/* ---------- 运行 ---------- */

testFeeMath();
await testD1();
console.log('\n自测完成。' + (process.exitCode ? ' ❌ 存在失败用例' : ' ✅ 全部通过'));
