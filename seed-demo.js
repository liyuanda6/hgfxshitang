/* 生成演示数据：node seed-demo.js（需先启动 node server.js）；演示数据可一键删除 */
'use strict';
const BASE = 'http://127.0.0.1:3000';
const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const C = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
const mk = (p) => { let s = 0; for (let i = 0; i < 17; i++) s += W[i] * Number(p[i]); return p + C[s % 11]; };
const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const get = async (p) => (await fetch(BASE + p)).json();

(async () => {
  const st = await get('/api/state');
  const m = st.currentMonth;
  if (st.classes.length) { console.log('已存在数据，跳过。如需重置请先删除 data/data.json 并重启服务。'); return; }

  const c1 = (await post('/api/classes/add', { name: '一年级一班' })).cls.id;
  const c2 = (await post('/api/classes/add', { name: '一年级二班' })).cls.id;

  await post('/api/students/import', {
    classId: c1,
    text: ['张明，' + mk('11010120180301001'), '李静，' + mk('11010120180302002'),
           '王小雨，' + mk('11010120180303003'), '赵天成，' + mk('11010120180304004')].join('\n')
  });
  await post('/api/students/import', {
    classId: c2,
    text: ['刘思远，' + mk('11010120180305005'), '陈欣怡，' + mk('11010120180306006')].join('\n')
  });

  await post('/api/days/set', { month: m, classIds: [c1, c2], days: 18, password: 'admin' });

  const s = await get('/api/state');
  const idOf = (n) => s.students.find((x) => x.name === n).id;
  const cell = (n, field, value) => post('/api/records/cell', { month: m, studentId: idOf(n), field: field, value: value });

  await cell('李静', 'standard', 'B');
  await cell('王小雨', 'standard', 'L');
  await cell('王小雨', 'deduction', 33);
  await cell('王小雨', 'remark', '病假 3 天，全天未在校就餐');
  await cell('赵天成', 'remark', '外出参加比赛一周');
  await cell('赵天成', 'deduction', 119);
  await cell('陈欣怡', 'standard', 'L');

  const f = await get('/api/state');
  console.log('演示数据已就绪：' + f.classes.length + ' 个班级，' + f.students.length + ' 名学生，' + m + ' 应就餐 18 天');
  console.log('提示：班级管理页删除这两个班级即可清空全部演示数据（默认密码 admin）。');
})().catch((e) => { console.error('失败：', e.message || e); process.exit(1); });
