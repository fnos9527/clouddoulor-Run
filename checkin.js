const { chromium } = require('playwright');

const BASE = 'https://cloud.doulor.cn';
const USER = process.env.DOULOR_USER;
const PASS = process.env.DOULOR_PASS;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tgText(text) {
  if (!TG_TOKEN || !TG_CHAT) return console.log('未配置 TG，跳过通知:\n' + text);
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text }),
  }).catch((e) => console.log('TG 发送失败', e.message));
}

async function tgPhoto(buf, caption) {
  if (!TG_TOKEN || !TG_CHAT) return;
  const fd = new FormData();
  fd.append('chat_id', TG_CHAT);
  fd.append('caption', caption);
  fd.append('photo', new Blob([buf], { type: 'image/png' }), 'shot.png');
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
    method: 'POST',
    body: fd,
  }).catch((e) => console.log('TG 图片发送失败', e.message));
}

// 循环点击“我知道了”，直到连续几次都没有弹窗
async function dismissPopups(page) {
  let misses = 0;
  let clicked = 0;
  while (misses < 3 && clicked < 20) {
    const btn = page.getByRole('button', { name: /我知道了/ }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      clicked++;
      misses = 0;
      console.log(`点击“我知道了”第 ${clicked} 次`);
      await sleep(1000);
    } else {
      misses++;
      await sleep(1500);
    }
  }
  return clicked;
}

// 读取右上角（顶栏）的积分数字：在页面顶部、靠右的纯数字元素
async function readHeaderPoints(page) {
  const val = await page.evaluate(() => {
    const cands = [];
    for (const el of document.querySelectorAll('a, button, div, span')) {
      if (el.children.length > 2) continue;
      const t = (el.innerText || '').trim();
      if (!/^\d{1,9}$/.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.top >= 0 && r.top < 140 && r.left > window.innerWidth * 0.5 && r.width > 0) {
        cands.push({ t, left: r.left });
      }
    }
    cands.sort((a, b) => a.left - b.left); // 积分在铃铛/消息图标左侧，取最左的
    return cands.length ? cands[0].t : null;
  });
  return val === null ? null : parseInt(val, 10);
}

// 积分页面大数字
async function readPagePoints(page) {
  const body = await page.locator('body').innerText();
  const m = body.match(/我的积分\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

(async () => {
  if (!USER || !PASS) {
    await tgText('❌ Doulor 签到失败：未配置 DOULOR_USER / DOULOR_PASS');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1600, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    // 1. 登录
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="text"], input[type="email"], input:not([type])').first().fill(USER);
    await page.locator('input[type="password"]').first().fill(PASS);
    await page.getByRole('button', { name: '登录', exact: true }).last().click();
    await page.waitForURL(/\/dashboard/, { timeout: 45000 });
    console.log('登录成功:', page.url());

    // 2. 处理弹窗（分多次弹出）
    await sleep(2000);
    await dismissPopups(page);

    // 3. 记录签到前积分
    let before = await readHeaderPoints(page);
    console.log('签到前积分(顶栏):', before);

    // 4. 点击积分进入积分页
    await page.goto(`${BASE}/dashboard/points`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    // 优先模拟真实点击顶栏积分；若失败则上面的直达链接已兜底
    await sleep(2000);
    await dismissPopups(page);
    if (before === null) before = await readPagePoints(page);

    // 5. 点击签到
    const signBtn = page.getByRole('button', { name: '签到', exact: true }).first();
    await signBtn.waitFor({ state: 'visible' });
    const disabled = await signBtn.isDisabled().catch(() => false);
    if (!disabled) {
      await signBtn.click();
      console.log('已点击签到');
    } else {
      console.log('签到按钮不可用，可能今天已签到');
    }

    // 6. 等 2 秒 → 刷新 → 读积分
    await sleep(2000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2000);
    await dismissPopups(page);
    let after = await readPagePoints(page);
    if (after === null) after = await readHeaderPoints(page);

    const gained = before !== null && after !== null ? after - before : null;
    const shot = await page.screenshot();

    const msg =
      `✅ Doulor Cloud 签到完成\n` +
      `签到前积分：${before ?? '未知'}\n` +
      `签到后积分：${after ?? '未知'}\n` +
      `本次增加：${gained ?? '未知'}` +
      (disabled ? '\n（签到按钮不可用，可能今天已签到）' : '');
    console.log(msg);
    await tgPhoto(shot, msg);
  } catch (e) {
    console.error(e);
    const shot = await page.screenshot().catch(() => null);
    const msg = `❌ Doulor Cloud 签到失败：${e.message.split('\n')[0]}`;
    if (shot) await tgPhoto(shot, msg);
    else await tgText(msg);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
