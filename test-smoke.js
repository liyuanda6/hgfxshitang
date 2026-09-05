/* 验收自测脚本：node test-smoke.js（需先启动 node server.js） */
'use strict';
const BASE = 'http://127.0.0.1:3000';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
async function call(path, body) {
  const opt = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'GET' };
  const res = await fetch(BASE + path, opt);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, data: json };
}
async function callText(path) {
  const res = await fetch(BASE + path);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf: buf, text: buf.toString('utf8') };
}
const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const C = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
function makeId(p17) {
  let s = 0;
  for (let i = 0; i < 17; i++) s += W[i] * Number(p17[i]);
  return p17 + C[s % 11];
}

(async function main() {
  console.log('\n=== 班级就餐统计系统 · 验收自测 ===\n');

  /* 清理已有数据，保证测试可重复 */
  const state = await call('/api/state');
  if (state.status === 200 && state.data.classes) {
    for (const c of state.data.classes) {
      await call('/api/classes/delete', { id: c.id, password: 'admin' });
    }
  }

  /* ---------- 1. 基础 ---------- */
  console.log('[1] 服务与初始状态');
  let r = await call('/api/state');
  ok('接口可访问', r.status === 200 && r.data.ok === true);
  const month = r.data.currentMonth;
  ok('返回当前月份 ' + month, /^\d{4}-\d{2}$/.test(month));
  ok('默认早餐价 6 / 午餐价 11', r.data.settings.breakfastPrice === 6 && r.data.settings.lunchPrice === 11);

  /* ---------- 2. 班级 ---------- */
  console.log('\n[2] 班级管理');
  r = await call('/api/classes/add', { name: '一年级一班' });
  const c1 = r.data.cls && r.data.cls.id;
  ok('新增班级「一年级一班」', r.status === 200 && !!c1);
  r = await call('/api/classes/add', { name: '一年级二班' });
  const c2 = r.data.cls && r.data.cls.id;
  ok('新增班级「一年级二班」', !!c2);
  r = await call('/api/classes/add', { name: '一年级一班' });
  ok('同名班级被拒绝', r.status === 400, r.data.message);

  /* ---------- 3. 学生导入 ---------- */
  console.log('\n[3] 学生导入（格式解析 / 身份证校验 / 去重）');
  const ids = [
    makeId('11010120150101001'), makeId('11010120150102002'), makeId('11010120150103003'),
    makeId('11010120150104004'), makeId('11010120150105005'), makeId('11010120150106006')
  ];
  const good = makeId('11010120150107007');
  const badId = good.slice(0, 17) + (good[17] === '1' ? '2' : '1'); // 校验位故意写错
  const text = [
    '张三，' + ids[0],
    '李四 ' + ids[1],
    '王五\t' + ids[2],
    '赵六，' + ids[3],
    '张三，' + ids[0],                    // 重复
    '钱七，' + badId,                     // 校验位错误
    '无效行',                              // 缺字段
    '  '                                   // 空行
  ].join('\n');
  r = await call('/api/students/import', { classId: c1, text: text });
  ok('成功导入 4 人', r.data.added === 4, JSON.stringify({ a: r.data.added }));
  ok('重复身份证被去重（1 条）', r.data.duplicate === 1, String(r.data.duplicate));
  ok('校验位错误的行被拦截', r.data.errors.some((e) => /校验位/.test(e.msg)));
  ok('缺字段的行被拦截', r.data.errors.some((e) => /缺少身份证号/.test(e.msg)));
  ok('身份证统一大写', r.data.students.every((s) => s.idCard === s.idCard.toUpperCase()));
  const s1 = r.data.students[0].id, s2 = r.data.students[1].id, s3 = r.data.students[2].id, s4 = r.data.students[3].id;

  r = await call('/api/students/import', { classId: c2, text: '孙八，' + ids[4] + '\n周九，' + ids[5] });
  ok('二班导入 2 人', r.data.added === 2);
  const s5 = r.data.students[0].id;

  r = await call('/api/students/add', { name: '单人新增', idCard: makeId('11010120150108008'), classId: c1 });
  ok('单个新增学生成功', r.status === 200);
  r = await call('/api/students/add', { name: '重复身份证', idCard: ids[0], classId: c1 });
  ok('重复身份证拒绝新增', r.status === 400, r.data.message);

  /* ---------- 4. 应就餐天数（需密码） ---------- */
  console.log('\n[4] 批量设置应就餐天数（密码验证）');
  r = await call('/api/days/set', { month: month, classIds: [c1, c2], days: 18, password: 'wrong' });
  ok('错误密码被拒绝（403）', r.status === 403, r.status + ' ' + r.data.message);
  r = await call('/api/state');
  ok('错误密码未写入天数', (r.data.days[c1 + '|' + month] || 0) === 0);

  r = await call('/api/days/set', { month: month, classIds: [c1, c2], days: 18, password: 'admin' });
  ok('正确密码批量设置成功', r.status === 200 && r.data.affected.length === 2);
  r = await call('/api/state');
  ok('两个班级天数均为 18', r.data.days[c1 + '|' + month] === 18 && r.data.days[c2 + '|' + month] === 18);

  r = await call('/api/days/set', { month: month, classIds: [c1], days: 20, password: 'admin' });
  ok('单班单独设置成功（20 天）', r.status === 200 && r.data.days === 20);
  r = await call('/api/days/set', { month: month, classIds: [c1], days: 99, password: 'admin' });
  ok('非法天数（99）被拒绝', r.status === 400, r.data.message);

  /* ---------- 5. 费用计算 ---------- */
  console.log('\n[5] 费用计算规则（18 天示例）');
  await call('/api/days/set', { month: month, classIds: [c1], days: 18, password: 'admin' });
  const fee = async (sid) => (await call('/api/records/cell', { month: month, studentId: sid, field: 'standard', value: 'BL' })).data.row;
  let row = await fee(s1);
  ok('早餐+中餐：每日 17 元、总费用 306 元', row.dailyFee === 17 && row.total === 306, JSON.stringify(row));
  row = (await call('/api/records/cell', { month: month, studentId: s1, field: 'standard', value: 'B' })).data.row;
  ok('切换「仅早餐」：每日 6 元、总费用 108 元', row.dailyFee === 6 && row.total === 108, JSON.stringify(row));
  row = (await call('/api/records/cell', { month: month, studentId: s1, field: 'standard', value: 'L' })).data.row;
  ok('切换「仅中餐」：每日 11 元、总费用 198 元', row.dailyFee === 11 && row.total === 198, JSON.stringify(row));

  row = (await call('/api/records/cell', { month: month, studentId: s2, field: 'deduction', value: 58 })).data.row;
  ok('总费用 306 − 扣除 58 = 真实费用 248', row.total === 306 && row.real === 248, JSON.stringify(row));
  row = (await call('/api/records/cell', { month: month, studentId: s2, field: 'deduction', value: 999 })).data.row;
  ok('扣除超过总费用时真实费用为 0（不为负）', row.real === 0, JSON.stringify(row));
  row = (await call('/api/records/cell', { month: month, studentId: s2, field: 'deduction', value: -5 })).data;
  ok('负数扣除被拒绝', row.ok === false);

  row = (await call('/api/records/cell', { month: month, studentId: s3, field: 'remark', value: '病假一周，全天未就餐' })).data.row;
  ok('备注可保存', row.remark === '病假一周，全天未就餐');

  /* ---------- 6. 改价后实时重算 ---------- */
  console.log('\n[6] 修改餐价（需密码，改后实时重算）');
  r = await call('/api/settings/prices', { breakfastPrice: 7, lunchPrice: 12, password: 'wrong' });
  ok('错误密码拒绝改价', r.status === 403);
  r = await call('/api/settings/prices', { breakfastPrice: 7, lunchPrice: 12, password: 'admin' });
  ok('正确密码改价成功', r.status === 200);
  row = (await call('/api/records/cell', { month: month, studentId: s1, field: 'standard', value: 'BL' })).data.row;
  ok('改价后 18 天 早餐+中餐 = 19×18 = 342', row.dailyFee === 19 && row.total === 342, JSON.stringify(row));
  await call('/api/settings/prices', { breakfastPrice: 6, lunchPrice: 11, password: 'admin' });
  row = (await call('/api/records/cell', { month: month, studentId: s1, field: 'standard', value: 'BL' })).data.row;
  ok('恢复默认价后重算为 306', row.total === 306);

  /* ---------- 7. 月份切换 ---------- */
  console.log('\n[7] 月份切换与历史回看');
  const prev = (() => {
    const [y, m] = month.split('-').map(Number);
    return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
  })();
  r = await call('/api/state');
  ok('新月份无记录（从零开始）', !r.data.records[prev]);
  r = await call('/api/days/set', { month: prev, classIds: [c1], days: 22, password: 'admin' });
  ok('历史月份可单独设置天数 22', r.status === 200);
  r = await call('/api/state');
  ok('历史月份天数与当月互不影响',
    r.data.days[c1 + '|' + prev] === 22 && r.data.days[c1 + '|' + month] === 18);
  row = (await call('/api/records/cell', { month: prev, studentId: s1, field: 'deduction', value: 100 })).data.row;
  ok('历史月份按 22 天计算总费用 374', row.total === 374 && row.real === 274, JSON.stringify(row));
  ok('月份格式校验', (await call('/api/days/set', { month: '2026-13', classIds: [c1], days: 5, password: 'admin' })).status === 400);

  /* ---------- 8. CSV 导出 ---------- */
  console.log('\n[8] CSV 导出');
  let t = await callText('/api/export?month=' + month + '&scope=class&classId=' + c1);
  ok('单班导出成功', t.status === 200);
  ok('CSV 带 UTF-8 BOM（Excel 中文不乱码）',
    t.buf[0] === 0xEF && t.buf[1] === 0xBB && t.buf[2] === 0xBF);
  let lines = t.text.replace(/^\uFEFF/, '').split('\r\n');
  ok('表头字段齐全（10 个字段，顺序正确）',
    lines[0] === '"班级","姓名","身份证号","用餐标准","每日餐费","本月应就餐天数","总费用","备注","应扣除费用","当月真实费用"', lines[0]);
  ok('含合计行', /^"合计"/.test(lines[lines.length - 1]), lines[lines.length - 1]);
  ok('单班导出仅含本班（5 学生 + 表头 + 合计 = 7 行）', lines.length === 7, String(lines.length));
  ok('单班导出不含其他班级', !lines.some((l) => l.indexOf('一年级二班') >= 0));
  ok('身份证号以文本形式保存（Excel 不变科学计数）',
    lines.some((l) => l.indexOf('"' + ids[0] + '"') >= 0), lines[1]);
  ok('合计行数值为累加结果',
    (function () {
      const last = lines[lines.length - 1].split(',');
      return last[6] === '1530' && last[8] === '999' && last[9] === '1224';
    })(), lines[lines.length - 1]);

  t = await callText('/api/export?month=' + month + '&scope=all');
  lines = t.text.replace(/^\uFEFF/, '').split('\r\n');
  ok('全校导出含两个班级', lines.some((l) => l.indexOf('一年级一班') === 1) && lines.some((l) => l.indexOf('一年级二班') === 1));
  ok('全校导出含合计行', /^"合计"/.test(lines[lines.length - 1]));
  ok('全校导出行数正确（7 学生 + 表头 + 合计）', lines.length === 9, String(lines.length));

  /* ---------- 9. 密码修改 ---------- */
  console.log('\n[9] 修改管理密码');
  r = await call('/api/settings/password', { oldPassword: 'wrong', newPassword: 'newpass123' });
  ok('旧密码错误被拒绝', r.status === 403);
  r = await call('/api/settings/password', { oldPassword: 'admin', newPassword: '123' });
  ok('新密码不足 6 位被拒绝', r.status === 400);
  r = await call('/api/settings/password', { oldPassword: 'admin', newPassword: 'newpass123' });
  ok('修改密码成功', r.status === 200);
  r = await call('/api/days/set', { month: month, classIds: [c1], days: 18, password: 'admin' });
  ok('旧密码立即失效', r.status === 403);
  r = await call('/api/days/set', { month: month, classIds: [c1], days: 18, password: 'newpass123' });
  ok('新密码立即生效', r.status === 200);
  r = await call('/api/settings/password', { oldPassword: 'newpass123', newPassword: 'admin123' });
  ok('再次修改密码成功', r.status === 200);
  const PWD = 'admin123';

  /* ---------- 10. 删除级联 ---------- */
  console.log('\n[10] 删除班级（级联 + 密码）');
  r = await call('/api/classes/delete', { id: c2, password: 'wrong' });
  ok('错误密码拒绝删除班级', r.status === 403);
  r = await call('/api/classes/delete', { id: c2, password: PWD });
  ok('删除班级成功', r.status === 200 && r.data.removedStudents === 2, JSON.stringify(r.data));
  r = await call('/api/state');
  ok('该班学生被级联删除', r.data.students.every((s) => s.classId !== c2));
  ok('该班天数记录被清理', !r.data.days[c2 + '|' + month]);
  ok('该班就餐记录被清理', Object.values(r.data.records).every((m) => !m[s5]));

  /* ---------- 11. 持久化 ---------- */
  console.log('\n[11] 数据持久化');
  const fs = require('fs');
  const p = require('path').join(__dirname, 'data', 'data.json');
  ok('数据文件已生成', fs.existsSync(p));
  const disk = JSON.parse(fs.readFileSync(p, 'utf8'));
  ok('磁盘中保存了班级数据', disk.classes.length === 1 && disk.classes[0].name === '一年级一班');
  ok('磁盘中保存了学生数据', disk.students.length === 5, String(disk.students.length));
  ok('密码以哈希存储（无明文）', !fs.readFileSync(p, 'utf8').includes('"password": "admin"') && !!disk.settings.passwordHash && !disk.settings.password);

  console.log('\n========================================');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
