import { chromium } from "playwright";

const { DOULOR_USER, DOULOR_PASS, TG_BOT_TOKEN, TG_CHAT_ID } = process.env;
const BASE = "https://cloud.doulor.cn";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tg(text, photoPath) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log("[TG 未配置]", text);
    return;
  }
  try {
    if (photoPath) {
      const fs = await import("node:fs");
      const form = new FormData();
      form.append("chat_id", TG_CHAT_ID);
      form.append("caption", text);
      form.append("photo", new Blob([fs.readFileSync(photoPath)]), "error.png");
      await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
    } else {
      await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text }),
      });
    }
  } catch (e) {
    console.error("TG 发送失败:", e.message);
  }
}

// 读取右上角积分:取页面右上区域里“纯数字”的元素,最靠左的那个
// (右边的 60 是消息角标,位置在积分右侧)
async function readHeaderPoints(page) {
  return page.evaluate(() => {
    const W = window.innerWidth;
    const cands = [];
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim().replace(/,/g, "");
      if (!/^\d+$/.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.top > 90 || r.left < W * 0.5) continue;
      cands.push({ v: Number(t), x: r.left });
    }
    cands.sort((a, b) => a.x - b.x);
    return cands.length ? cands[0].v : null;
  });
}

// 备用:积分页“我的积分”卡片里的大数字
async function readCardPoints(page) {
  return page.evaluate(() => {
    const label = [...document.querySelectorAll("body *")].find(
      (e) => !e.children.length && (e.textContent || "").trim() === "我的积分"
    );
    if (!label) return null;
    let box = label.parentElement;
    for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
      const m = (box.innerText || "").match(/(\d[\d,]*)\s*(?:≈|\n)/);
      if (m) return Number(m[1].replace(/,/g, ""));
    }
    return null;
  });
}

async function readPoints(page) {
  const a = await readHeaderPoints(page);
  return a ?? (await readCardPoints(page));
}

// 反复关闭“我知道了”弹窗:每出现一个点一次,连续 3 秒没有新弹窗才算结束
async function dismissPopups(page) {
  let closed = 0;
  let quietSince = Date.now();
  while (Date.now() - quietSince < 3000) {
    const btn = page.getByRole("button", { name: /我知道了/ }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      closed++;
      console.log(`已关闭弹窗 #${closed}`);
      await sleep(800); // 等下一个弹窗弹出
      quietSince = Date.now();
    } else {
      await sleep(300);
    }
  }
  return closed;
}

async function main() {
  if (!DOULOR_USER || !DOULOR_PASS) throw new Error("缺少 DOULOR_USER / DOULOR_PASS");

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ locale: "zh-CN", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);

  try {
    // 1. 登录
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.fill("#identifier", DOULOR_USER);
    await page.fill("#password", DOULOR_PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/dashboard/, { timeout: 30000 });
    console.log("登录成功:", page.url());

    // 2. 关闭所有弹窗
    await dismissPopups(page);

    // 3. 记录签到前积分
    let before = null;
    for (let i = 0; i < 10 && before === null; i++) {
      before = await readHeaderPoints(page);
      if (before === null) await sleep(500);
    }
    if (before === null) throw new Error("读取不到右上角积分");
    console.log("签到前积分:", before);

    // 4. 点击积分进入积分页(点不动就直接跳转)
    try {
      await page.getByText(String(before), { exact: true }).first().click({ timeout: 5000 });
      await page.waitForURL(/\/dashboard\/points/, { timeout: 8000 });
    } catch {
      await page.goto(`${BASE}/dashboard/points`, { waitUntil: "networkidle" });
    }
    await dismissPopups(page);

    // 5. 点击签到
    const signBtn = page.getByRole("button", { name: /^\s*签到\s*$/ }).first();
    let signed = false;
    if (await signBtn.isVisible().catch(() => false)) {
      await signBtn.click();
      signed = true;
      console.log("已点击签到");
    } else {
      console.log("未找到“签到”按钮,可能今天已签到");
    }
    await dismissPopups(page);

    // 6. 等 2 秒,刷新,读取签到后积分
    await sleep(2000);
    await page.reload({ waitUntil: "networkidle" });
    await dismissPopups(page);
    let after = null;
    for (let i = 0; i < 10 && after === null; i++) {
      after = await readPoints(page);
      if (after === null) await sleep(500);
    }
    if (after === null) throw new Error("刷新后读取不到积分");
    console.log("签到后积分:", after);

    const diff = after - before;
    let status;
    if (!signed) status = "⚠️ 没找到签到按钮(可能今天已签到)";
    else if (diff > 0) status = "✅ 签到成功";
    else status = "⚠️ 已点击签到,但积分没有增加(可能今天已签到过)";

    await tg(
      `Doulor Cloud 签到\n${status}\n签到前积分:${before}\n签到后积分:${after}\n本次增加:${diff}`
    );
  } catch (e) {
    console.error(e);
    await page.screenshot({ path: "error.png", fullPage: true }).catch(() => {});
    await tg(`❌ Doulor Cloud 签到失败\n${e.message}`, "error.png");
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
