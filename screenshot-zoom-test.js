// 【2026-08-31 新增】大屏 zoom 适配验证：按视口宽测试 zoom 值与横向溢出
// 用法: node screenshot-zoom-test.js <宽度> <高度> <输出png>
const puppeteer = require('puppeteer-core');

(async () => {
  const CHROME = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
  const W = parseInt(process.argv[2] || '1920', 10);
  const H = parseInt(process.argv[3] || '1080', 10);
  const out = process.argv[4] || 'C:/Users/sty_d/WorkBuddy/2026-08-12-19-13-25/zoom-test.png';
  const waitSec = parseInt(process.argv[5] || '12', 10);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--disable-gpu', '--hide-scrollbars', '--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  page.on('console', m => { if (m.type() === 'error') console.log('[page:error]', m.text()); });

  await page.goto('http://localhost:3010/', { waitUntil: 'load' });

  // 等待真实数据上屏
  const t0 = Date.now();
  while (Date.now() - t0 < waitSec * 1000) {
    await new Promise(r => setTimeout(r, 1500));
    const src = await page.evaluate(() => document.getElementById('srcText').textContent);
    if (src.includes('LIVE')) break;
  }
  await new Promise(r => setTimeout(r, 2000));

  const info = await page.evaluate(() => {
    const d = document.querySelector('.dashboard');
    return {
      innerWidth: window.innerWidth,
      zoom: d ? d.style.zoom : 'n/a',
      maxWidth: d ? d.style.maxWidth : 'n/a',
      scrollW: document.documentElement.scrollWidth,
      bodyW: document.body.scrollWidth,
      hasHScroll: document.documentElement.scrollWidth > window.innerWidth,
      // 抽样几个字号（effective 为 zoom 后实际渲染尺寸）
      h1: document.querySelector('.header h1').offsetHeight,
      valP: document.getElementById('valP-1').offsetHeight,
      src: document.getElementById('srcText').textContent,
    };
  });
  console.log(`[${W}x${H}]`, JSON.stringify(info, null, 2));

  await page.screenshot({ path: out, fullPage: false });
  console.log('SCREENSHOT_SAVED:', out);
  await browser.close();
})();
