// 【2026-08-31 修改】新增：等待真实 MQTT 数据上屏后再截图
//   原因：headless --virtual-time-budget 会冻结真实网络，WebSocket 消息未投递时
//         页面会降级模拟数据，导致截图显示假电流。改用 puppeteer 真实等待。
const puppeteer = require('puppeteer-core');

(async () => {
  const CHROME = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
  const out = process.argv[2] || 'C:/Users/sty_d/WorkBuddy/2026-08-12-19-13-25/dashboard-fix.png';
  const waitSec = parseInt(process.argv[3] || '18', 10);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--disable-gpu', '--hide-scrollbars', '--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1900 });

  // 捕获页面 console 与数据源徽章状态
  page.on('console', m => { if (m.type() === 'error') console.log('[page:error]', m.text()); });

  await page.goto('file:///C:/Users/sty_d/WorkBuddy/2026-08-12-19-13-25/power-dashboard.html', { waitUntil: 'load' });

  // 轮询等待真实数据徽章出现（最多 waitSec 秒）
  const t0 = Date.now();
  let src = 'connecting', live = false;
  while (Date.now() - t0 < waitSec * 1000) {
    await new Promise(r => setTimeout(r, 1500));
    src = await page.evaluate(() => {
      const el = document.getElementById('srcText');
      return el ? el.textContent : 'n/a';
    });
    const ia1 = await page.evaluate(() => {
      const el = document.getElementById('valI-1');
      return el ? el.textContent : 'n/a';
    });
    console.log(`[${Math.round((Date.now()-t0)/1000)}s] src="${src}" 1号电流=${ia1}`);
    if (src.includes('LIVE')) { live = true; break; }
  }

  await new Promise(r => setTimeout(r, 2000)); // 再等一轮数据刷新
  const snapshot = await page.evaluate(() => {
    const gid = id => { const el = document.getElementById(id); return el ? el.textContent : 'n/a'; };
    return {
      src: gid('srcText'),
      ia1: gid('valI-1'), ia2: gid('valI-2'), ia3: gid('valI-3'),
      p1: gid('valP-1'), p2: gid('valP-2'), p3: gid('valP-3'),
      v1: gid('valV-1'),
      totalP: gid('totalPower'), totalI: gid('totalCurrent'),
      fresh1: gid('fresh-1'),
    };
  });
  console.log('FINAL:', JSON.stringify(snapshot, null, 2));

  await page.screenshot({ path: out });
  console.log('SCREENSHOT_SAVED:', out);
  await browser.close();
})();
