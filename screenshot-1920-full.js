// 截 1920 完整长图（fullPage）
const puppeteer = require('puppeteer-core');
(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--disable-gpu', '--hide-scrollbars', '--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto('http://localhost:3010/', { waitUntil: 'load' });
  // 等真实数据
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    await new Promise(r => setTimeout(r, 1500));
    const src = await page.evaluate(() => document.getElementById('srcText').textContent);
    if (src.includes('LIVE')) break;
  }
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: 'C:/Users/sty_d/WorkBuddy/2026-08-12-19-13-25/dashboard-desktop-1920-full.png', fullPage: true });
  console.log('done');
  await browser.close();
})();
