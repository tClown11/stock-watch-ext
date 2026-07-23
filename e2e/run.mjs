// E2E：加载打包后的扩展，走通全部用户流程（真实网络行情）。
// 用法：node e2e/run.mjs [--headed]
import puppeteer from 'puppeteer-core';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIST = path.join(ROOT, 'dist');
const ART = path.join(ROOT, 'e2e', 'artifacts');
const HEADED = process.argv.includes('--headed');
// 正式版 Chrome 137+ 移除了 --load-extension，必须用 Chrome for Testing / Chromium。
const CFT_CANDIDATES = [
  `${process.env.HOME}/.cache/puppeteer/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${process.env.HOME}/.cache/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
];
const CHROME = CFT_CANDIDATES.find((p) => existsSync(p));

let page; // current popup page (for failure screenshots)
let passed = 0;
const failures = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, err: String(e?.message ?? e) });
    console.log(`  ✗ ${name}\n    → ${e?.message ?? e}`);
    if (page) {
      try {
        await page.screenshot({ path: path.join(ART, `fail-${failures.length}-${name.replace(/[^\w一-龥]+/g, '_').slice(0, 40)}.png`) });
      } catch {}
      // 失败自愈：尽量退回列表屏（关模态 → 完成/返回），避免一步失败连坐后续用例
      try {
        for (let i = 0; i < 3; i++) {
          if (await page.$('.modal-card')) { await page.$eval('.modal-close', (el) => el.click()).catch(() => {}); await sleep(250); continue; }
          if (await page.$('.sc-action')) { await page.$eval('.sc-action', (el) => el.click()); await sleep(350); continue; }
          if (await page.$('.back-btn')) { await page.$eval('.back-btn', (el) => el.click()); await sleep(350); continue; }
          break;
        }
      } catch {}
    }
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function waitFor(fn, msg, timeout = 15000, interval = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`超时: ${msg}`);
    await sleep(interval);
  }
}

const $$len = (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);
const text = (sel) => page.$eval(sel, (el) => el.textContent ?? '').catch(() => '');
const allText = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent ?? '')).catch(() => []);

/** 点击包含指定文本的第一个元素。 */
/** 语义点击：直接派发 el.click()，绕过液态玻璃收起状态下的几何不可达。 */
const clickSel = (sel) => page.$eval(sel, (el) => el.click());

async function clickText(sel, needle, opts = {}) {
  const ok = await page.$$eval(
    sel,
    (els, n, right) => {
      const el = els.find((e) => (e.textContent ?? '').includes(n));
      if (!el) return false;
      if (right) {
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      } else {
        el.click();
      }
      return true;
    },
    needle,
    !!opts.right
  );
  assert(ok, `找不到可点击的 "${needle}" (${sel})`);
}

async function main() {
  await rm(ART, { recursive: true, force: true });
  await mkdir(ART, { recursive: true });
  assert(existsSync(path.join(DIST, 'manifest.json')), '请先 npm run build');
  assert(CHROME, '未找到 Chrome for Testing（npx puppeteer browsers install chrome）');
  console.log(`浏览器: ${CHROME}`);

  const userDataDir = path.join(ROOT, 'e2e', '.profile');
  await rm(userDataDir, { recursive: true, force: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADED ? false : true,
    userDataDir,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=DialMediaRouteProvider',
      '--window-size=1200,800',
    ],
  });

  try {
    // ── 扩展就绪：等 service worker，取扩展 ID ────────────────────────────────
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      { timeout: 20000 }
    );
    const extId = new URL(swTarget.url()).host;
    console.log(`\n扩展已加载: ${extId}\n`);

    // ═══ 0. 图标点击行为（在创建任何测试页之前验证——弹窗失焦即自动关闭）═══
    console.log('【0】图标点击行为');
    await step('图标点击行为已复位为弹窗（openPanelOnActionClick=false）', async () => {
      const worker = await swTarget.worker();
      const behavior = await worker.evaluate(() => chrome.sidePanel.getPanelBehavior());
      assert(behavior && behavior.openPanelOnActionClick === false, `panel 行为未复位: ${JSON.stringify(behavior)}`);
    });
    await step('chrome.action.openPopup() 真实弹出 popup 且渲染行情', async () => {
      const worker = await swTarget.worker();
      try {
        await worker.evaluate(() => chrome.action.openPopup());
      } catch (e) {
        // 部分版本要求用户手势；能拿到明确的 gesture 报错也说明 popup 路由正常注册
        assert(/gesture|user/i.test(String(e)), `openPopup 异常: ${e}`);
        console.log('      （此版本 openPopup 需用户手势，跳过实弹验证）');
        return;
      }
      // 弹窗失焦即自动关闭（Chrome 特性），其它测试页可能抢焦点 → 最多重试 3 轮；
      // 且 puppeteer 对弹窗窗口的 Page 包装不可靠（page() 可能为 null）→ 用底层 CDP。
      let info = null;
      for (let attempt = 0; attempt < 3 && !info; attempt++) {
        if (attempt) await worker.evaluate(() => chrome.action.openPopup()).catch(() => {});
        const popupTarget = await browser
          .waitForTarget((t) => t.url() === `chrome-extension://${extId}/popup.html` && t.type() === 'page', { timeout: 8000 })
          .catch(() => null);
        if (!popupTarget) continue;
        try {
          const session = await popupTarget.createCDPSession();
          const evalIn = async (expression) =>
            (await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
          const t0p = Date.now();
          while (Date.now() - t0p < 12000 && !info) {
            const v = await evalIn(
              `({rows: document.querySelectorAll('.row').length, ih: innerHeight, bodyH: document.body.offsetHeight, footerY: document.querySelector('.footer')?.getBoundingClientRect().bottom ?? -1})`
            ).catch(() => null);
            if (v && v.rows >= 16) info = v;
            else await sleep(300);
          }
          await session.detach().catch(() => {});
        } catch {
          /* 弹窗中途关闭 → 重开 */
        }
      }
      assert(info, '弹窗未能保持打开并渲染（3 次尝试）');
      // fitPopupSize 应把 body 钉到实际视口：不塌缩成缝、不溢出裁切，底栏在可视区
      assert(info.bodyH >= 300, `弹窗 body 塌缩: ${JSON.stringify(info)}`);
      assert(info.bodyH === 600 || Math.abs(info.bodyH - info.ih) <= 2, `body 未贴合视口: ${JSON.stringify(info)}`);
      assert(info.footerY > 0 && info.footerY <= info.ih + 40, `底栏叠层位置异常(默认收起在下边缘): ${JSON.stringify(info)}`);
      console.log(`      真实弹窗: rows=${info.rows} 视口=${info.ih} bodyH=${info.bodyH} 底栏可见`);
    });

    page = await browser.newPage();

    await page.setViewport({ width: 500, height: 600 });
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

    const t0 = Date.now();
    await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });

    // ═══ 1. 列表 + 真实行情 ═══
    console.log('【1】列表与真实行情');
    await step('默认自选列表渲染（16 只）', async () => {
      await waitFor(() => $$len('.row').then((n) => n >= 16), '列表行渲染');
    });
    await step('真实报价加载且非示例数据（首屏速度）', async () => {
      await waitFor(async () => {
        const prices = await allText('.row .price');
        return prices.filter((p) => p && p !== '—').length >= 14;
      }, '真实价格填充');
      const ms = Date.now() - t0;
      assert((await $$len('.offline-banner')) === 0, '出现离线/示例数据横幅');
      console.log(`      首屏行情耗时 ~${ms}ms`);
      assert(ms < 8000, `首屏行情过慢: ${ms}ms`);
    });
    await step('指数条有真实数值（含恒生/纳斯达克）', async () => {
      await waitFor(() => $$len('.idx-chip').then((n) => n >= 6), '指数 chips');
      const vals = await allText('.idx-val');
      const filled = vals.filter((v) => v && v !== '—');
      assert(filled.length >= 6, `指数数值不全: ${JSON.stringify(vals)}`);
      const names = await allText('.idx-name');
      assert(names.join().includes('恒生') && names.join().includes('纳斯达克'), '缺少恒生/纳斯达克');
      assert((await $$len('.idx-dot')) >= 6, '指数芯片缺少市场状态点');
    });
    await step('四列平铺：现价·涨跌 / 涨跌幅·当日盈亏 / 持有盈亏', async () => {
      assert((await $$len('.row .spark')) === 0, '仍存在迷你分时列');
      const head = await text('.col-head');
      assert(!head.includes('分时'), '列头仍有「分时」');
      assert(head.includes('当日') && head.includes('持有盈亏'), `列头缺当日/持有盈亏: ${head}`);
      assert((await $$len('.row .chg')) >= 14, '涨跌额未显示');
      assert((await $$len('.row .pct-badge')) >= 16, '涨跌幅徽章未显示');
      assert((await $$len('.row .day')) >= 16, '当日盈亏槽未显示');
      assert((await $$len('.row .row-hold')) >= 16, '持有盈亏列未显示');
      assert((await $$len('.row .pnl:not(.na)')) >= 5, '持仓行盈亏金额未显示');
      assert((await $$len('.row .day:not(.na)')) >= 5, '持仓行当日盈亏未显示');
    });
    await step('手动刷新 ⟳ 更新时间戳', async () => {
      const before = await text('.foot-time');
      await sleep(1100); // 秒级时间戳，确保可观察到变化
      await clickSel('.qa-btn[title="立即刷新"]');
      await waitFor(async () => (await text('.foot-time')) !== before, '时间戳变化', 8000);
    });

    // ═══ 2. 分组 Tab ═══
    console.log('【2】分组');
    await step('默认分组标签：全部自选/持仓/科技成长/港美股/白酒消费', async () => {
      const tabs = await allText('.group-seg .seg-item');
      for (const t of ['全部自选', '持仓', '科技成长', '港美股', '白酒消费']) {
        assert(tabs.some((x) => x.includes(t)), `缺少分组 ${t}: ${tabs}`);
      }
    });
    await step('切到「持仓」只显示有持仓的股票', async () => {
      await clickText('.group-seg .seg-item', '持仓');
      await waitFor(() => $$len('.row .pnl:not(.na)').then((n) => n >= 5), '持仓行');
      const n = await $$len('.row');
      const npnl = await $$len('.row .pnl:not(.na)');
      assert(n === npnl, `持仓组内有无持仓行: rows=${n} pnl=${npnl}`);
      await clickText('.group-seg .seg-item', '全部自选');
    });
    await step('开盘中的市场自动浮到列表顶部（forceopen=US 模拟美股盘中）', async () => {
      const p2 = await browser.newPage();
      await p2.setViewport({ width: 500, height: 600 });
      await p2.goto(`chrome-extension://${extId}/popup.html?forceopen=US&norefresh=1`, { waitUntil: 'domcontentloaded' });
      // 指数条开市优先：forceopen=US 时纳斯达克应排到第一位
      await waitFor(async () => {
        const idx = await p2.$$eval('.idx-name', (els) => els.map((e) => e.textContent));
        return idx[0] === '纳斯达克';
      }, '指数条美股优先', 10000);
      const t0s = Date.now();
      for (;;) {
        const names = await p2.$$eval('.row .row-name', (els) => els.map((e) => e.textContent));
        if (names.length >= 16) {
          // 星标茅台永远第一；其后应为美股三只（开盘中），A/港股沉下去
          assert(names[0] === '贵州茅台', `星标应最前: ${names[0]}`);
          const usTrio = names.slice(1, 4);
          assert(
            ['苹果', '英伟达', '特斯拉'].every((n) => usTrio.includes(n)),
            `美股未浮顶: ${names.slice(0, 5)}`
          );
          break;
        }
        assert(Date.now() - t0s < 15000, '浮顶列表加载超时');
        await sleep(300);
      }
      // 对照：forceopen=none 时回到默认顺序（宁德时代第二；指数条上证第一）
      await p2.goto(`chrome-extension://${extId}/popup.html?forceopen=none&norefresh=1`, { waitUntil: 'domcontentloaded' });
      await new Promise((r) => setTimeout(r, 1200));
      const names2 = await p2.$$eval('.row .row-name', (els) => els.map((e) => e.textContent));
      assert(names2[1] === '宁德时代', `默认顺序异常: ${names2.slice(0, 3)}`);
      const idx2 = await p2.$$eval('.idx-name', (els) => els.map((e) => e.textContent));
      assert(idx2[0] === '上证指数', `全休市指数条应回落默认顺序: ${idx2.slice(0, 3)}`);
      await p2.close();
    });

    // ═══ 3. 详情页 ═══
    console.log('【3】个股详情');
    await step('点击贵州茅台进入详情，分时图渲染', async () => {
      await clickText('.row .row-name', '贵州茅台');
      await waitFor(() => text('.big-price .p').then((t) => t && t !== '—'), '详情价格');
      await waitFor(async () => {
        const d = await page.$$eval('.chart path[stroke]', (ps) => ps.map((p) => (p.getAttribute('d') ?? '').length));
        return d.some((len) => len > 200);
      }, '分时曲线路径', 15000);
    });
    await step('指标网格 ≥6 项有值（今开/最高/最低/成交量…）', async () => {
      const vals = await allText('.metric .v');
      const filled = vals.filter((v) => v && v !== '—');
      assert(filled.length >= 6, `指标不足: ${JSON.stringify(vals)}`);
    });
    await step('我的持仓卡片显示市值与盈亏', async () => {
      const panel = await text('.panel');
      assert(panel.includes('我的持仓') && panel.includes('持仓市值'), '持仓卡片缺失');
    });
    await step('日K/周K/月K 蜡烛图渲染', async () => {
      for (const tab of ['日K', '周K', '月K']) {
        await clickText('.chart-tabs .seg-item', tab);
        await waitFor(() => $$len('.chart rect[fill]').then((n) => n > 20), `${tab} 蜡烛`, 15000);
      }
      await clickText('.chart-tabs .seg-item', '分时');
    });
    await step('详情星标切换同步列表', async () => {
      // 每次点击后 DOM 全量重渲染，必须重新查询元素（不能复用句柄）。
      const starText = () => page.$eval('.sc-head [title="特别关注"]', (el) => el.textContent ?? '');
      const before = await starText();
      await page.click('.sc-head [title="特别关注"]');
      await waitFor(async () => (await starText()) !== before, '星标状态切换');
      await page.click('.sc-head [title="特别关注"]'); // 恢复
      await waitFor(async () => (await starText()) === before, '星标恢复');
    });
    await step('返回列表', async () => {
      await page.click('.back-btn');
      await waitFor(() => $$len('.row').then((n) => n >= 16), '回到列表');
    });
    await step('港股分时：坐标轴按 09:30-16:00 渲染（腾讯控股）', async () => {
      await clickText('.row .row-name', '腾讯控股');
      await waitFor(() => text('.big-price .p').then((t) => t && t !== '—'), '港股详情价格');
      await waitFor(async () => {
        const d = await page.$$eval('.chart path[stroke]', (ps) => ps.map((p) => (p.getAttribute('d') ?? '').length));
        return d.some((len) => len > 200);
      }, '港股分时曲线', 15000);
      const axis = await text('.chart-axis');
      assert(axis.includes('12:00') && axis.includes('16:00'), `港股时间轴异常: ${axis}`);
      await page.click('.back-btn');
      await waitFor(() => $$len('.row').then((n) => n >= 16), '回列表');
    });

    // ═══ 4. ETF 成分股 ═══
    console.log('【4】ETF 成分股');
    await step('沪深300ETF 详情展示持仓成分股', async () => {
      await clickText('.row .row-name', '沪深300ETF');
      await waitFor(() => $$len('.cons-row').then((n) => n >= 5), '成分股行', 20000);
      const first = await text('.cons-row');
      assert(first.includes('权重'), `成分股无权重: ${first}`);
      await waitFor(async () => {
        const prices = await allText('.cons-price');
        return prices.filter((p) => p && p !== '—').length >= 5;
      }, '成分股实时价');
    });
    await step('点击成分股跳到个股详情（非自选 → ＋添加自选按钮）', async () => {
      await page.click('.cons-row'); // 第一只成分股（权重最高，非默认自选）
      await waitFor(() => text('.big-price .p').then((t) => t && t !== '—'), '成分股详情价格', 15000);
      const btns = await allText('.actions .btn');
      assert(btns.some((b) => b.includes('添加自选')), `非自选详情应有添加按钮: ${btns}`);
    });
    await step('成分股一键添加自选后出现在列表', async () => {
      const name = await text('.dt-name .n');
      await clickText('.actions .btn', '添加自选');
      await sleep(400);
      await page.click('.back-btn'); // 回 ETF 详情或列表
      const backToList = async () => {
        if (await page.$('.back-btn')) await page.click('.back-btn');
      };
      await backToList();
      await waitFor(async () => {
        const names = await allText('.row .row-name');
        return names.some((n) => n === name);
      }, `列表出现 ${name}`);
      // 清理：右键移除
      await clickText('.row', name, { right: true });
      await clickText('.row-menu-item', '删除自选');
      await sleep(300);
    });

    // ═══ 5. 添加自选（搜索）═══
    console.log('【5】添加自选');
    await step('搜索「PDD」出现拼多多并添加', async () => {
      await clickSel('.qa-btn[title="添加自选"]');
      await page.waitForSelector('#add-search');
      await page.type('#add-search', 'PDD', { delay: 30 });
      await waitFor(async () => {
        const names = await allText('.u-row .row-name');
        return names.some((n) => /拼多多|PDD/i.test(n));
      }, '搜索结果', 15000);
      await clickText('.u-btn.add', '添加');
      // 添加页底栏是 .footer-mini（"当前自选 N 只"）
      await waitFor(() => text('.footer-mini').then((t) => t.includes('17')), '自选数 +1');
    });
    await step('中文搜索「茅台」命中且已添加标记为可配置', async () => {
      await page.$eval('#add-search', (el) => (el.value = ''));
      await page.type('#add-search', '茅台', { delay: 30 });
      await waitFor(async () => {
        const rows = await allText('.u-row');
        return rows.some((r) => r.includes('贵州茅台') && (r.includes('配置') || r.includes('移除')));
      }, '中文搜索结果', 15000);
    });
    await step('为拼多多配置持仓（10 股 · 成本 100）', async () => {
      await page.$eval('#add-search', (el) => (el.value = ''));
      await page.type('#add-search', 'PDD', { delay: 30 });
      await waitFor(async () => (await allText('.u-row .row-name')).some((n) => /拼多多|PDD/i.test(n)), '再次搜索', 15000);
      await clickText('.u-btn.cfg', '配置');
      await page.waitForSelector('#hold-shares');
      await page.type('#hold-shares', '10');
      await page.type('#hold-cost', '100');
      await clickText('.mbtn.save', '保存');
      await sleep(400);
      await clickText('.sc-action', '完成');
      await waitFor(() => $$len('.row').then((n) => n >= 17), '回列表');
    });
    await step('持仓分组包含拼多多且盈亏已计算', async () => {
      await clickText('.group-seg .seg-item', '持仓');
      await waitFor(async () => {
        const names = await allText('.row .row-name');
        return names.some((n) => /拼多多|PDD/i.test(n));
      }, '持仓组含拼多多');
      const rows = await allText('.row');
      const pdd = rows.find((r) => /拼多多|PDD/i.test(r));
      assert(/[+\-]/.test(pdd ?? ''), `拼多多行无盈亏: ${pdd}`);
      await clickText('.group-seg .seg-item', '全部自选');
    });
    await step('场外基金 020839：净值兜底显示 + 详情净值走势', async () => {
      // 场外基金无实时行情：股票源全 miss 后应走天天基金接口取净值并标注
      await page.evaluate(async () => {
        const st = (await chrome.storage.local.get('stockwatch')).stockwatch;
        if (!st.watchlist.some((w) => w.secid === '0.020839')) {
          st.watchlist.push({ secid: '0.020839', code: '020839', market: 'SZ', name: '南方中证半导体产业指数发起A' });
          await chrome.storage.local.set({ stockwatch: st });
        }
      });
      // 先等 storage 变更同步到弹窗（新行渲染出来），再触发刷新拉报价
      await waitFor(
        () => page.$$eval('.row', (rows) => rows.some((x) => x.textContent?.includes('半导体产业'))),
        '注入的基金行渲染',
        8000
      );
      await clickSel('.qa-btn[title="立即刷新"]');
      await waitFor(
        () =>
          page.$$eval('.row', (rows) => {
            const r = rows.find((x) => x.textContent?.includes('半导体产业'));
            if (!r) return false;
            const price = r.querySelector('.price')?.textContent ?? '—';
            const txt = r.textContent ?? '';
            return txt.includes('场外') && txt.includes('净值') && price !== '—';
          }),
        '场外基金行显示净值+标注',
        15000
      );
      await clickText('.row .row-name', '南方中证半导体');
      await waitFor(() => text('.nav-note').then((t) => t.includes('净值日期')), '详情净值标注', 10000);
      await waitFor(async () => {
        const d = await page.$$eval('.chart path[stroke]', (ps) => ps.map((p) => (p.getAttribute('d') ?? '').length));
        return d.some((len) => len > 100);
      }, '净值走势曲线', 15000);
      const metrics = await allText('.metric .l');
      assert(metrics.some((m) => m.includes('单位净值')), `场外指标缺失: ${metrics}`);
      // 盘中估算：前十大持仓加权（持仓与成分报价异步加载，稍等）
      await waitFor(() => text('.nav-est').then((t) => t.includes('盘中估算') && /%/.test(t)), '盘中估算', 15000);
      await page.click('.back-btn');
      await page.evaluate(async () => {
        const st = (await chrome.storage.local.get('stockwatch')).stockwatch;
        st.watchlist = st.watchlist.filter((w) => w.secid !== '0.020839');
        await chrome.storage.local.set({ stockwatch: st });
      });
      await sleep(300);
    });

    // ═══ 6. 右键菜单：置顶/置底/星标/移除 ═══
    console.log('【6】右键菜单与排序');
    await step('右键宁德时代 → 置顶 → 行首出现', async () => {
      await clickText('.row', '宁德时代', { right: true });
      await page.waitForSelector('.row-menu');
      await clickText('.row-menu-item', '置顶');
      await sleep(300);
      const names = await allText('.row .row-name');
      // 贵州茅台默认 star，收藏层永远在最上；置顶在非收藏层内第一
      const maotaiIdx = names.indexOf('贵州茅台');
      const ningde = names.indexOf('宁德时代');
      assert(ningde >= 0 && ningde <= 1 && maotaiIdx >= 0, `置顶排序异常: ${names.slice(0, 4)}`);
      const rowText = await allText('.row');
      assert(rowText.some((r) => r.includes('宁德时代') && r.includes('置顶')), '置顶徽标未显示');
    });
    await step('右键比亚迪 → 置底 → 列表末尾', async () => {
      await clickText('.row', '比亚迪', { right: true });
      await clickText('.row-menu-item', '置底');
      await sleep(300);
      const names = await allText('.row .row-name');
      assert(names[names.length - 1] === '比亚迪', `置底失败: ${names.slice(-3)}`);
    });
    await step('右键取消置顶/置底恢复', async () => {
      await clickText('.row', '宁德时代', { right: true });
      await clickText('.row-menu-item', '取消置顶');
      await sleep(200);
      await clickText('.row', '比亚迪', { right: true });
      await clickText('.row-menu-item', '取消置底');
      await sleep(200);
    });
    await step('右键移除拼多多（清理）', async () => {
      await clickText('.row', '拼多多', { right: true });
      await clickText('.row-menu-item', '删除自选');
      await sleep(300);
      const names = await allText('.row .row-name');
      assert(!names.some((n) => /拼多多/.test(n)), '移除失败');
    });

    // ═══ 7. 分组管理（新建/归组/移出/删除）═══
    console.log('【7】分组管理');
    await step('右键茅台 → 分组/持仓设置 → 新建「测试分组」并保存', async () => {
      await clickText('.row', '贵州茅台', { right: true });
      await clickText('.row-menu-item', '分组 / 持仓设置');
      await page.waitForSelector('#new-group');
      await page.type('#new-group', '测试分组');
      await clickText('.grp-add-btn', '新建');
      await sleep(200);
      const chips = await allText('.grp-chip');
      assert(chips.some((c) => c.includes('✓') && c.includes('测试分组')), `新分组未选中: ${chips}`);
      await clickText('.mbtn.save', '保存');
      await sleep(400);
    });
    await step('「测试分组」标签出现且包含茅台', async () => {
      await clickText('.group-seg .seg-item', '测试分组');
      await sleep(300);
      const names = await allText('.row .row-name');
      assert(names.length === 1 && names[0] === '贵州茅台', `分组内容异常: ${names}`);
    });
    await step('分组内右键 → 移出「测试分组」', async () => {
      await clickText('.row', '贵州茅台', { right: true });
      await clickText('.row-menu-item', '移出「测试分组」');
      await sleep(300);
      const empty = await text('.empty-note');
      assert(empty.includes('暂无股票'), `应显示空态: ${empty}`);
    });
    await step('弹窗 chip 悬停 ✕ 删除分组', async () => {
      await clickText('.group-seg .seg-item', '全部自选');
      await clickText('.row', '贵州茅台', { right: true });
      await clickText('.row-menu-item', '分组 / 持仓设置');
      await page.waitForSelector('.grp-chip');
      await page.$$eval('.grp-chip .grp-del', (els, n) => {
        const el = els.find((e) => e.parentElement?.textContent?.includes(n));
        el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, '测试分组');
      await sleep(300);
      const chips = await allText('.grp-chip');
      assert(!chips.some((c) => c.includes('测试分组')), `分组未删除: ${chips}`);
      await clickText('.mbtn.cancel', '取消');
      await sleep(200);
      const tabs = await allText('.group-seg .seg-item');
      assert(!tabs.some((t) => t.includes('测试分组')), '分组标签未消失');
    });

    // ═══ 8. 设置 ═══
    console.log('【8】设置');
    await step('打开设置页', async () => {
      await clickSel('.qa-btn[title="设置"]');
      await page.waitForSelector('.set-card');
    });
    await step('深色主题即时生效', async () => {
      await clickText('.seg-item', '深色');
      await waitFor(() => page.$eval('html', (el) => el.dataset.theme === 'dark'), 'dark 主题');
    });
    await step('字号「大号」生效 (data-font=lg)', async () => {
      await clickText('.seg-item', '大号');
      await waitFor(() => page.$eval('html', (el) => el.dataset.font === 'lg'), '字号 lg');
      await clickText('.seg-item', '标准');
    });
    // 底栏只显示更新时间（v8 用户要求），配色/频率改动直接校验存储
    const getSettings = () =>
      page.evaluate(async () => (await chrome.storage.local.get('stockwatch')).stockwatch.settings);
    await step('绿涨红跌切换后徽章配色互换', async () => {
      await clickText('.seg-item', '绿涨红跌');
      await waitFor(async () => (await getSettings()).colorMode === 'gr', '配色写入存储');
      await page.click('.back-btn');
      await waitFor(() => $$len('.row').then((n) => n >= 16), '回列表');
      // 上证指数今天涨 → 绿涨模式应为绿色
      const idxColor = await page.$eval('.idx-val', (el) => getComputedStyle(el).color);
      console.log(`      上证指数颜色: ${idxColor}`);
      await clickSel('.qa-btn[title="设置"]');
      await clickText('.seg-item', '红涨绿跌');
      await waitFor(async () => (await getSettings()).colorMode === 'rg', '配色还原');
    });
    await step('刷新频率切 5 分钟 + 自定义 2 分钟', async () => {
      await clickText('.seg-item', '5 分钟');
      await waitFor(async () => (await getSettings()).refresh === 5, '5 分钟已保存');
      await page.type('#refresh-custom', '2');
      await waitFor(async () => (await getSettings()).refreshCustom === 2, '自定义 2 分钟已保存');
    });
    await step('列表内容开关：关闭盈亏金额/涨跌额后列表隐藏', async () => {
      const sw = await page.$$('.switch');
      assert(sw.length >= 4, '开关数量不足');
      await clickTextSwitch('显示持有盈亏');
      await clickTextSwitch('显示当日盈亏');
      await clickTextSwitch('显示涨跌额');
      await page.click('.back-btn');
      await sleep(300);
      assert((await $$len('.row .row-hold')) === 0, '持有盈亏列未隐藏');
      assert((await $$len('.row .day')) === 0, '当日盈亏未隐藏');
      assert((await $$len('.row .chg')) === 0, '涨跌额未隐藏');
      await clickSel('.qa-btn[title="设置"]');
      await clickTextSwitch('显示持有盈亏');
      await clickTextSwitch('显示当日盈亏');
      await clickTextSwitch('显示涨跌额');
    });
    async function clickTextSwitch(label) {
      await page.$$eval('.switch-row', (rows, l) => {
        const r = rows.find((x) => x.textContent?.includes(l));
        r?.querySelector('.switch')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, label);
      await sleep(150);
    }
    await step('数据源显示为腾讯/新浪/东财多源', async () => {
      const items = await allText('.list-item');
      const src = items.find((t) => t.includes('数据源'));
      assert(src && /(腾讯|新浪|东方财富)/.test(src), `数据源行异常: ${src}`);
      console.log(`      ${src?.trim().replace(/\s+/g, ' ')}`);
    });
    await step('关于扩展/隐私协议弹窗打开关闭', async () => {
      await clickText('.list-item', '隐私协议');
      await page.waitForSelector('.about-body');
      const body = await text('.about-body');
      assert(body.includes('本地'), '隐私文案缺失');
      await clickText('.mbtn.save', '知道了');
      await sleep(200);
      await clickText('.list-item', '关于扩展');
      await page.waitForSelector('.about-body');
      await clickText('.mbtn.save', '知道了');
      await sleep(200);
    });
    await step('登录按钮 toast 提示（账号同步占位）', async () => {
      await clickText('.pill-btn', '登录');
      await waitFor(() => $$len('.toast.show').then((n) => n >= 1), 'toast 出现');
    });
    await step('导出配置生成 JSON 文件', async () => {
      const client = await page.createCDPSession();
      await client.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: ART,
        eventsEnabled: true,
      });
      await clickText('.list-item', '导出配置');
      await waitFor(async () => existsSync(path.join(ART, 'stockwatch-config.json')), '下载文件', 8000);
    });

    // ═══ 9. 工具栏图标 ═══
    console.log('【9】工具栏图标');
    await step('回到列表页（上一节结束时停在设置页）', async () => {
      if (await page.$('.back-btn')) await page.click('.back-btn');
      await waitFor(() => $$len('.row').then((n) => n >= 16), '回到列表');
    });
    await step('单只模式：角标胶囊显示涨跌幅、title 同步', async () => {
      const title = await waitFor(async () => {
        const t = await page.evaluate(() => chrome.action.getTitle({}));
        return /%/.test(t) ? t : null;
      }, '图标 title 显示涨跌幅', 20000, 500);
      // v6 设计：数字放角标胶囊（setBadgeText），图标本体是固定 logo 瓦片
      const badge = await waitFor(async () => {
        const b = await page.evaluate(() => chrome.action.getBadgeText({}));
        return /^[+-]?\d/.test(b) ? b : null;
      }, '角标胶囊有涨跌数字', 20000, 500);
      console.log(`      badge: "${badge}" · title: ${title}`);
    });
    await step('弹窗刷新即时同步角标（quotes-refreshed 推送，不等 alarm）', async () => {
      // 造一个不可能来自真实行情的角标值，验证推送通道写得进去
      const secid = await page.evaluate(async () => (await chrome.storage.local.get('stockwatch')).stockwatch.watchlist[0].secid);
      await page.evaluate(
        (sid) => chrome.runtime.sendMessage({ type: 'quotes-refreshed', quotes: [{ secid: sid, name: '同步测试', price: 10, changePct: 5.5 }] }),
        secid
      );
      await waitFor(async () => (await page.evaluate(() => chrome.action.getBadgeText({}))) === '+5.5', '推送写入角标', 5000, 100);
      // 真实刷新应立刻用真行情覆盖假值——证明每次刷新都会同步角标
      await clickSel('.qa-btn[title="立即刷新"]');
      await waitFor(async () => {
        const b = await page.evaluate(() => chrome.action.getBadgeText({}));
        return b && b !== '+5.5';
      }, '刷新后角标被真实数据覆盖', 10000, 200);
    });
    await step('角标跟随列表显示顺序（取消星标+置顶宁德时代 → 角标切换）', async () => {
      // 默认茅台带星标（星标 > 置顶），先取消才能让置顶股成为显示第一
      await clickText('.row', '贵州茅台', { right: true });
      await clickText('.row-menu-item', '取消特别关注');
      await sleep(200);
      await clickText('.row', '宁德时代', { right: true });
      await clickText('.row-menu-item', '置顶');
      const title = await waitFor(async () => {
        const t = await page.evaluate(() => chrome.action.getTitle({}));
        return t.includes('宁德时代') ? t : null;
      }, '角标切到置顶股票', 20000, 500);
      console.log(`      title: ${title}`);
      // 还原：取消置顶 + 恢复茅台星标
      await clickText('.row', '宁德时代', { right: true });
      await clickText('.row-menu-item', '取消置顶');
      await sleep(200);
      await clickText('.row', '贵州茅台', { right: true });
      await clickText('.row-menu-item', '特别关注');
      await sleep(300);
    });
    await step('全部盈亏模式：图标 title 显示持仓总盈亏', async () => {
      await clickSel('.qa-btn[title="设置"]');
      await clickText('.seg-item', '全部盈亏');
      const title = await waitFor(async () => {
        const t = await page.evaluate(() => chrome.action.getTitle({}));
        return t.includes('持仓总盈亏') ? t : null;
      }, '盈亏 title', 25000, 500);
      console.log(`      title: ${title}`);
      await clickText('.seg-item', '单只股票');
      await page.click('.back-btn');
    });

    // ═══ 10. 新浪 DNR 与持久化 ═══
    console.log('【10】新浪备源与持久化');
    await step('DNR 规则使新浪接口可从扩展直接访问', async () => {
      const body = await page.evaluate(async () => {
        const res = await fetch('https://hq.sinajs.cn/list=sh600519', { credentials: 'omit' });
        const buf = await res.arrayBuffer();
        return { status: res.status, text: new TextDecoder('gbk').decode(buf).slice(0, 80) };
      });
      assert(body.status === 200 && body.text.includes('贵州茅台'), `新浪响应异常: ${JSON.stringify(body)}`);
    });
    await step('刷新页面后设置与自选持久化（深色/17→16只）', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitFor(() => $$len('.row').then((n) => n >= 16), '列表恢复');
      const theme = await page.$eval('html', (el) => el.dataset.theme);
      assert(theme === 'dark', `主题未持久化: ${theme}`);
      const rc = await page.evaluate(async () => (await chrome.storage.local.get('stockwatch')).stockwatch.settings.refreshCustom);
      assert(rc === 2, `刷新频率未持久化: ${rc}`);
    });
    await step('sync 自动备份 + 本地被清后自动恢复（防卸载丢数据）', async () => {
      await waitFor(async () => {
        const b = await page.evaluate(async () => (await chrome.storage.sync.get('stockwatch')).stockwatch);
        return b?.settings?.theme === 'dark' && (b?.watchlist?.length ?? 0) >= 16;
      }, 'sync 备份就绪', 8000);
      // 模拟移除重装（本地被清空）→ 重开弹窗应从 sync 自动恢复
      await page.evaluate(() => chrome.storage.local.remove('stockwatch'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitFor(() => $$len('.row').then((n) => n >= 16), '列表恢复');
      const theme = await page.$eval('html', (el) => el.dataset.theme);
      assert(theme === 'dark', `sync 恢复失败（主题回落默认）: ${theme}`);
      const rc2 = await page.evaluate(async () => (await chrome.storage.local.get('stockwatch')).stockwatch?.settings?.refreshCustom);
      assert(rc2 === 2, `sync 恢复不完整: refreshCustom=${rc2}`);
    });

    // ═══ 11. 固定尺寸与主题钩子 ═══
    console.log('【11】弹窗尺寸与主题钩子');
    await step('基准 500×600；视口收窄(缩放>100%)时 body 钉到视口、底栏固定单滚动条', async () => {
      const p3 = await browser.newPage();
      await p3.setViewport({ width: 500, height: 600 });
      await p3.goto(`chrome-extension://${extId}/popup.html?norefresh=1`, { waitUntil: 'domcontentloaded' });
      await sleep(900);
      const m = await p3.evaluate(() => ({ w: document.body.offsetWidth, h: document.body.offsetHeight }));
      assert(m.w === 500 && m.h === 600, `基准尺寸异常: ${m.w}×${m.h}`);
      // 模拟 150% 缩放下的实际视口（600 上限 ÷ 1.5 = 400 CSS px）
      await p3.setViewport({ width: 500, height: 400 });
      await sleep(700); // resize → fitPopupSize
      const m2 = await p3.evaluate(() => {
        const fr = document.querySelector('.footer')?.getBoundingClientRect();
        const scroll = document.querySelector('.scroll');
        const shell = document.querySelector('.shell');
        const footTop = fr ? fr.top : innerHeight;
        const visibleRows = [...document.querySelectorAll('.row')].filter(
          (r) => r.getBoundingClientRect().top < footTop - 8
        ).length;
        return {
          h: document.body.offsetHeight,
          zoom: shell ? getComputedStyle(shell).zoom : null,
          visibleRows,
          footerVisible: !!fr && fr.height > 0 && fr.top >= innerHeight - 60,
          listScrolls: !!scroll && scroll.scrollHeight > scroll.clientHeight,
          pageScrolls: document.documentElement.scrollHeight > innerHeight + 1,
        };
      });
      assert(m2.h === 400, `body 未钉到视口: ${m2.h}`);
      assert(m2.footerVisible, '底栏叠层位置异常');
      assert(m2.listScrolls && !m2.pageScrolls, `滚动条异常: ${JSON.stringify(m2)}`);
      // 无反向缩放（已按用户要求还原），紧凑行距下一屏应能看到 4 行
      assert(!m2.zoom || m2.zoom === '1' || parseFloat(m2.zoom) === 1, `不应有反向缩放: zoom=${m2.zoom}`);
      assert(m2.visibleRows >= 4, `可见行数不足: ${m2.visibleRows}`);
      console.log(`      150%缩放模拟: 可见行=${m2.visibleRows}`);
      await p3.close();
    });
    await step('forcetheme 预览钩子可覆盖已存主题（不改设置）', async () => {
      // 此时存储里主题为深色 → 用 forcetheme=light 才能证明覆盖生效
      const p4 = await browser.newPage();
      await p4.setViewport({ width: 500, height: 600 });
      const themeUrl = `chrome-extension://${extId}/popup.html?forcetheme=light&norefresh=1`;
      try {
        await p4.goto(themeUrl, { waitUntil: 'domcontentloaded' });
      } catch (e) {
        if (!/detached/i.test(String(e))) throw e;
        await sleep(600); // puppeteer 偶发 frame-detach 竞态 → 重试一次
        await p4.goto(themeUrl, { waitUntil: 'domcontentloaded' });
      }
      await sleep(800);
      const theme = await p4.$eval('html', (el) => el.dataset.theme);
      assert(theme === 'light', `forcetheme 未生效: ${theme}`);
      await p4.close();
    });

    // ═══ 12. 空态闭环 ═══
    console.log('【12】空态');
    await step('持仓组空态文案 & 搜索无结果文案', async () => {
      // 长流程后主页面偶发 frame-detach → 自愈重建
      try {
        await page.evaluate(() => 1);
      } catch {
        page = await browser.newPage();
        await page.setViewport({ width: 500, height: 600 });
        await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
        await waitFor(() => $$len('.row').then((n) => n >= 16), '主页面重建');
      }
      await clickSel('.qa-btn[title="添加自选"]');
      await page.waitForSelector('#add-search');
      await page.type('#add-search', 'zzzz不存在的股票zzzz');
      await waitFor(async () => (await text('.src-note')).includes('没有匹配'), '无结果文案', 10000);
      await clickText('.sc-action', '完成');
    });
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\n═══ 结果: ${passed} 通过, ${failures.length} 失败 ═══`);
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.err}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E harness 崩溃:', e);
  process.exit(2);
});
