// 【2026-08-31 新增】验证远程合闸/分闸 UI（不真实下发控制命令）
//   检查: 1) live 模式下 6 个控制按钮可用(未禁用)
//         2) 点击按钮弹出确认框且内容正确 → 取消关闭
//   用法: node ctrl-test-ui.js [输出截图路径]
const puppeteer = require('puppeteer-core');

(async () => {
  const CHROME = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
  const out = process.argv[2] || 'C:/Users/sty_d/WorkBuddy/2026-08-12-19-13-25/ctrl-ui-test.png';

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--disable-gpu', '--hide-scrollbars', '--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1900 });
  page.on('console', m => { if (m.type() === 'error') console.log('[page:error]', m.text()); });

  await page.goto('http://localhost:3010', { waitUntil: 'load' });

  // 等待真实数据 LIVE
  const t0 = Date.now();
  let live = false;
  while (Date.now() - t0 < 25000) {
    await new Promise(r => setTimeout(r, 1500));
    const src = await page.evaluate(() => document.getElementById('srcText').textContent);
    if (src.includes('LIVE')) { live = true; break; }
  }
  console.log('dataSource live:', live);

  // 1) 按钮可用性
  const btns = await page.evaluate(() => {
    const r = {};
    for (let g = 1; g <= 3; g++) {
      for (const a of ['on', 'off']) {
        const el = document.getElementById(`ctrlBtn-${g}-${a}`);
        r[`${g}-${a}`] = { disabled: el.disabled, text: el.textContent };
      }
    }
    return r;
  });
  console.log('BUTTONS:', JSON.stringify(btns, null, 2));

  // 2) 点击 1号回路 分闸 → 确认框出现 → 取消
  await page.evaluate(() => sendControl(1, 'off'));
  await new Promise(r => setTimeout(r, 400));
  const modal = await page.evaluate(() => ({
    visible: document.getElementById('ctrlMask').style.display,
    body: document.getElementById('ctrlModalBody').textContent.replace(/\s+/g, ' ').trim(),
    okText: document.getElementById('ctrlModalOk').textContent,
    okClass: document.getElementById('ctrlModalOk').className,
  }));
  console.log('MODAL:', JSON.stringify(modal, null, 2));

  // 弹窗展示状态截图
  await page.screenshot({ path: out });
  console.log('SCREENSHOT_SAVED:', out);

  // 取消关闭
  await page.evaluate(() => closeCtrlModal());
  const hidden = await page.evaluate(() => document.getElementById('ctrlMask').style.display);
  console.log('modal hidden after cancel:', hidden === 'none');

  await browser.close();
})();
