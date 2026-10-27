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

// 顶栏积分：页面顶部、靠右的纯数字元素
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
    cands.sort((a, b) => a.left - b.left);
    return cands.length ? cands[0].t : null;
  });
  return val === null ? null : parseInt(val, 10);
}

// 积分页大数字
async function readPagePoints(page) {
  const body = await page.locator('body').innerText();
  const m = body.match(/我的积分\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// 解析“每日签到”弹窗
function parseSignDialog(text) {
  const streak = text.match(/(\d+)\s*连续签到天数/);
  const today = text.match(/今日已签\s*\+?\s*(\d+)/);
  return {
    streak: streak ? parseInt(streak[1], 10) : null,
    todayGain: today ? parseInt(today[1], 10) : null,
    signed: !!today,
  };
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

    // 3. 记录积分（注意：站点进站会自动签到，这里可能已包含今日签到积分）
    let before = await readHeaderPoints(page);
    console.log('进站后积分(顶栏):', before);

    // 4. 进入积分页
    await page.goto(`${BASE}/dashboard/points`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(2000);
    await dismissPopups(page);
    if (before === null) before = await readPagePoints(page);

    // 5. 点击“签到”，打开“每日签到”弹窗
    const signBtn = page.getByRole('button', { name: '签到', exact: true }).first();
    await signBtn.waitFor({ state: 'visible' });
    await signBtn.click();
    await page.getByText('每日签到').first().waitFor({ state: 'visible' });
    await sleep(1500);

    const dialog = page
      .locator('[role="dialog"], [class*="modal"], [class*="dialog"]')
      .filter({ hasText: '每日签到' })
      .last();

    let info = parseSignDialog(await page.locator('body').innerText());

    // 如果弹窗里还没有“今日已签”，尝试在弹窗内点一下签到按钮
    if (!info.signed) {
      const claim = dialog.locator('button').filter({ hasText: /签到/ }).filter({ hasNotText: /自动签到|已签/ }).first();
      if (await claim.isVisible().catch(() => false)) {
        await claim.click().catch(() => {});
        await sleep(2000);
        info = parseSignDialog(await page.locator('body').innerText());
      }
    }
    console.log('弹窗信息:', info);

    // 弹窗截图（带详细说明）
    const dialogShot = await page.screenshot();

    // 6. 关闭弹窗 → 等 2 秒 → 刷新 → 读积分
    await page.getByRole('button', { name: '关闭', exact: true }).first().click().catch(() => {});
    await sleep(2000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(2000);
    await dismissPopups(page);
    let after = await readPagePoints(page);
    if (after === null) after = await readHeaderPoints(page);

    const diff = before !== null && after !== null ? after - before : null;

    const msg =
      `✅ Doulor Cloud 签到完成\n` +
      `连续签到天数：${info.streak ?? '未知'} 天\n` +
      `今日已签：+${info.todayGain ?? '未知'} 积分${info.signed ? '' : '（弹窗未显示今日已签）'}\n` +
      `当前积分：${after ?? '未知'}\n` +
      `进站时积分：${before ?? '未知'}，刷新后积分：${after ?? '未知'}，期间变化：${diff ?? '未知'}`;
    console.log(msg);
    await tgPhoto(dialogShot, msg);
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
