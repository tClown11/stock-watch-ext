// 关键界面截图（视觉验收）：列表 / 详情分时 / 日K / ETF成分 / 添加 / 设置 / 深色。
import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'e2e', 'shots');
const CFT = [
  `${process.env.HOME}/.cache/puppeteer/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CFT,
  headless: true,
  userDataDir: path.join(ROOT, 'e2e', '.profile-shots'),
  args: [`--disable-extensions-except=${ROOT}/dist`, `--load-extension=${ROOT}/dist`, '--no-first-run'],
});
await mkdir(OUT, { recursive: true });
const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
const id = new URL(sw.url()).host;
const page = await browser.newPage();
await page.setViewport({ width: 500, height: 600, deviceScaleFactor: 2 });
await page.goto(`chrome-extension://${id}/popup.html?norefresh=1`, { waitUntil: 'domcontentloaded' });

const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });
const clickText = (sel, needle) =>
  page.$$eval(sel, (els, n) => { const el = els.find((e) => (e.textContent ?? '').includes(n)); el?.click(); return !!el; }, needle);

await page.waitForFunction(() => [...document.querySelectorAll('.row .price')].filter((e) => e.textContent !== '—').length >= 14, { timeout: 15000 });
await sleep(600);
await shot('01-list');

await clickText('.row .row-name', '贵州茅台');
await page.waitForFunction(() => [...document.querySelectorAll('.chart path[stroke]')].some((p) => (p.getAttribute('d') ?? '').length > 200), { timeout: 15000 });
await sleep(400);
await shot('02-detail-time');

await clickText('.chart-tabs .seg-item', '日K');
await page.waitForFunction(() => document.querySelectorAll('.chart rect[fill]').length > 20, { timeout: 15000 });
await sleep(300);
await shot('03-detail-kline');
await page.click('.back-btn');

await clickText('.row .row-name', '沪深300ETF');
await page.waitForFunction(() => document.querySelectorAll('.cons-row').length >= 5, { timeout: 20000 });
await sleep(800);
await page.$eval('.screen.scroll-y', (el) => (el.scrollTop = el.scrollHeight));
await sleep(200);
await shot('04-etf-constituents');
await page.click('.back-btn');

await page.click('.qa-btn[title="添加自选"]');
await page.type('#add-search', '茅台', { delay: 20 });
await sleep(1500);
await shot('05-add-search');
await clickText('.sc-action', '完成');

await page.click('.qa-btn[title="设置"]');
await sleep(300);
await shot('06-settings');

await clickText('.seg-item', '深色');
await sleep(400);
await page.click('.back-btn');
await sleep(300);
await shot('07-dark-list');

await clickText('.row .row-name', '贵州茅台');
await page.waitForFunction(() => [...document.querySelectorAll('.chart path[stroke]')].some((p) => (p.getAttribute('d') ?? '').length > 200), { timeout: 15000 });
await sleep(400);
await shot('08-dark-detail');

// 自选设置弹窗（分组 chip + 持仓输入）
await clickText('.actions .btn', '分组 / 持仓设置');
await sleep(400);
await shot('09-hold-modal');

await browser.close();
console.log('shots ->', OUT);
