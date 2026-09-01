// 【2026-08-31】验证离线显示优化：>60s 未收到数据 → 徽章离线
const puppeteer = require('puppeteer-core');

(async () => {
  const CHROME = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--disable-gpu', '--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto('http://localhost:3010/', { waitUntil: 'load' });

  // 1. 等真实数据上屏
  const t0 = Date.now();
  let live = false;
  while (Date.now() - t0 < 20000) {
    await new Promise(r => setTimeout(r, 1500));
    const src = await page.evaluate(() => document.getElementById('srcText').textContent);
    if (src.includes('LIVE')) { live = true; break; }
  }
  const before = await page.evaluate(() => ({
    src: document.getElementById('srcText').textContent,
    online1: document.getElementById('online-1').textContent.trim(),
    fresh1: document.getElementById('fresh-1').textContent,
    online1Class: document.getElementById('online-1').className,
  }));
  console.log('阶段1 正常状态:', JSON.stringify(before, null, 2));
  if (!live) { console.log('FAIL: 未连上真实数据'); await browser.close(); process.exit(1); }

  // 2. 模拟 90 秒未收到数据
  await page.evaluate(() => {
    const ago90 = Date.now() - 90 * 1000;
    GROUPS.forEach(g => { if (liveGroups[g.id]) liveGroups[g.id].updatedAt = ago90; });
    lastLiveAt = ago90;
    freshHeartbeat();
  });
  await new Promise(r => setTimeout(r, 500));
  const after = await page.evaluate(() => ({
    src: document.getElementById('srcText').textContent,
    srcBadgeClass: document.getElementById('srcBadge').className,
    online1: document.getElementById('online-1').textContent.trim(),
    online1Class: document.getElementById('online-1').className,
    fresh1: document.getElementById('fresh-1').textContent,
    fresh1Class: document.getElementById('fresh-1').className,
    ia1: document.getElementById('valI-1').textContent,   // 数据应保留最后真实值
    v1: document.getElementById('valV-1').textContent,
  }));
  console.log('阶段2 模拟90s无数据:', JSON.stringify(after, null, 2));

  // 断言
  const ok =
    after.src.includes('数据中断') &&
    after.srcBadgeClass.includes('off') &&
    after.online1 === '离线' && after.online1Class.includes('off') &&
    after.fresh1Class.includes('lost');
  console.log(ok ? '✅ 全部断言通过' : '❌ 存在失败项');
  await page.screenshot({ path: 'C:/Users/sty_d/WorkBuddy/2026-08-12-19-13-25/dashboard-offline-test.png' });
  await browser.close();
})();
