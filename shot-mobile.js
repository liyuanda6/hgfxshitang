// 移动端截图验证脚本
// 使用已安装的 Playwright 截图所有 5 个页面（390x900 移动端视口）
const { chromium } = require('playwright');

const path = require('path');
const SHOTS = path.resolve(__dirname, '.shots');
const fs = require('fs');
console.log('screenshots →', SHOTS);
console.log('exists:', fs.existsSync(SHOTS));

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage();

  const pages = [
    { url: 'http://localhost:3000',          page: 'register', file: 'mobile-register.png',  title: '就餐登记' },
    { page: 'classes',  file: 'mobile-classes.png',   title: '班级管理' },
    { page: 'students', file: 'mobile-students.png',  title: '学生管理' },
    { page: 'report',   file: 'mobile-report.png',    title: '统计报表' },
    { page: 'settings', file: 'mobile-settings.png',  title: '系统设置' }
  ];

  // 仅首次导航一次
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  for (const p of pages) {
    // 通过点击 nav 按钮切换页面（hash 不会触发 nav 逻辑，这里直接模拟点击）
    await page.click(`.nav-item[data-page="${p.page}"]`);
    await page.waitForTimeout(500);  // 等表格渲染
    const out = path.join(SHOTS, p.file);
    await page.screenshot({ path: out, fullPage: true });
    const stat = fs.statSync(out);
    console.log(`✓ ${p.title.padEnd(8)} → ${out} (${stat.size} bytes)`);
  }

  await browser.close();
  console.log('\n全部 5 个页面截图完毕');
})().catch((e) => { console.error('截图失败：', e.message); process.exit(1); });
