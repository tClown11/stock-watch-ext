# 盯盘助手 · Chrome MV3 实时行情盯盘插件

按「股票盯盘助手 handoff 设计稿」一比一落地的 Chrome 扩展：自选行情、个股详情（分时/K线/持仓盈亏/ETF成分股）、批量添加、自定义分组、**特别关注 / 右键置顶置底 / 移除**、涨跌配色/主题/字号/角标/刷新间隔等设置。行情走**腾讯 → 新浪 → 东方财富**多源自动切换，实测首屏 ~350ms。

## 功能

- **列表**：四列平铺 `名称·代码 | 现价·涨跌 | 涨跌幅·当日盈亏 | 持有盈亏(金额+收益率)`，无迷你分时列（少 N 个请求/轮）；**开盘中市场的股票自动浮到顶部**（如美股夜盘时段美股靠前），全部休市时回到默认顺序。
- **分组 Tab**：全部自选 / 持仓 / 自定义分组（多对多归组；弹窗内新建、chip 悬停 ✕ 删除）。
- **特别关注（收藏）**：★ 星标；列表 / 右键菜单 / 详情页三处状态实时同步；收藏永远排最上。
- **置顶 / 置底**：右键切换，二者互斥；行内显示「置顶」「置底」角标；排序 `收藏 → (置顶→普通→置底)`，同档保持原序。
- **右键菜单**：置顶 / 置底 / 特别关注 / 分组·持仓设置 / 删除自选（自定义分组内变为「移出该分组」）。
- **个股详情**：大字价格卡、分时（VWAP 均价线 + 昨收虚线 + 悬浮十字光标气泡）、日/周/月 K 蜡烛图（前复权）、12 项指标网格、我的持仓卡（市值/盈亏）。
- **ETF 详情**：自动拉取**持仓成分股**（权重排序 + 实时涨跌，点击跳个股详情；非自选个股详情页提供「＋ 添加自选」/ 星标即收藏闭环）。
- **添加自选**：代码 / 名称 / 拼音搜索（同花顺 → 腾讯 smartbox → 东财三级），市场筛选 chips，行内 添加/移除/配置。
- **设置**：主题（浅色/深色/跟随系统）、涨跌颜色（红涨绿跌/绿涨红跌）、字号（标准/大号）、列表内容开关（盈亏金额/涨跌额）、图标角标（关闭/单只/全部盈亏）、刷新频率（3/5/10 分钟 + 自定义）、节假日休市自动暂停刷新、导入/导出配置、隐私协议与源码说明弹窗。
- **工具栏图标**：涨跌数字**直接画满图标本体**（大号白字 + 涨跌色块，方向由颜色表达，hover 显示完整信息），替代看不清的小角标；popup 关闭后由 service worker 按周期刷新，支持到价通知。
- **入口**：点工具栏图标弹出 500×600 弹窗（Chrome 弹窗上限 800×600，600 高占满；浏览器缩放>100% 时 JS 把 body 钉到实际视口——底栏固定可见、仅列表一个滚动条、任何缩放不裁切。已显式复位旧版遗留的「点击打开侧边栏」行为）。

## 数据源（2026-07 实测）

| 用途 | 主源 | 备源 | 说明 |
|---|---|---|---|
| 批量报价（沪深/港/美/ETF/指数） | 腾讯 `qt.gtimg.cn` | 新浪 `hq.sinajs.cn` → 东财 `push2` | 腾讯 16 标的 ~0.18s、请求极宽松；逐源只补缺失标的再合并 |
| 分时 | 腾讯 `web.ifzq.gtimg.cn/appstock/app/minute/query` | 东财 `trends2` | 美股盘前腾讯为空 → 自动用东财（返回上一交易日） |
| 日/周/月 K | 腾讯 `web.ifzq.gtimg.cn/appstock/app/fqkline/get`（qfq） | 东财 `kline` | 美股代码后缀（AAPL.OQ）从报价响应自动学习 |
| 搜索 | 同花顺 `news.10jqka.com.cn` | 腾讯 `smartbox` → 东财 `searchapi`(经SW) | 代码/名称/拼音 |
| ETF 成分股 | 东财 `fundmobapi…FundMNInverstPosition` | — | 季度数据，会话内缓存 |

- **为什么换主源**：东财 `push2` 对连续请求限流激进（实测数次后直接拒连），是旧版“加载慢”的根源；腾讯公开行情接口无此问题且覆盖全市场（含恒生 `hkHSI`、纳斯达克 `usIXIC`）。
- **新浪 Referer**：`hq.sinajs.cn` 必须带 `Referer`（fetch 禁止头），用 `declarativeNetRequest` 静态规则（[dnr_rules.json](dnr_rules.json)）在网络层改写，E2E 已验证 200。
- **mock 仅离线兜底**：所有真实源都失败才降级示例数据，底栏和设置页会明确标注。
- 腾讯报价字段索引（三市场核心一致）：`3现价 4昨收 5今开 31涨跌 32涨幅 33高 34低 36量 37额 39PE 43振幅 45总市值(亿)`；A股另有 `38换手 46PB 67/68 52周高低`，港美 `48/49 52周高低`。

## 技术栈

- **TypeScript + Manifest V3**，`esbuild` 打包，零运行时框架（popup 用 60 行 `h()` 构建 DOM）。
- **数据层**：`DataSource` 接口 + 各源适配器（`src/data/{tencent,sina,eastmoney,ths,mock}.ts`），`src/data/router.ts` 做多源缺口补齐 / 超时(4s) / 按市场调度。
- **service worker** 负责关闭 popup 后的角标刷新与到价提醒；popup 打开时按设置间隔自刷新（休市 + 开启节假日开关时自动暂停，手动 ⟳ 不受限）。

```
src/
  data/      types.ts  router.ts  tencent.ts  sina.ts  eastmoney.ts  ths.ts  etf.ts  mock.ts  secid.ts
  core/      settings.ts  storage.ts  format.ts  compute.ts  chart.ts
  popup/     popup.html  popup.css  popup.ts  h.ts
  background/service-worker.ts
e2e/         run.mjs（48 项全流程断言）  shots.mjs（界面截图）
```

## 开发 / 构建 / 测试

```bash
npm install
npm run build      # 原地增量构建 dist/（不删目录，避免 Chrome 中已加载的扩展失效）
npm run dev        # esbuild watch
npm run typecheck  # tsc --noEmit
npm run e2e        # 真实加载扩展跑 48 项端到端断言（需 Chrome for Testing，见下）
npm run shots      # 输出关键界面截图到 e2e/shots/
npm run release    # --clean 构建 + 校验产物 + 打 Chrome Web Store 上传包（release/*.zip）
```

> E2E 用 puppeteer-core 驱动 **Chrome for Testing**（正式版 Chrome 137+ 已移除 `--load-extension`）。没有缓存时先执行 `npx @puppeteer/browsers install chrome@stable`。

最近一次全量 E2E：**48 通过 / 0 失败**，覆盖：真实行情首屏(~340ms)、指数条、分组切换、详情三图表、指标、持仓卡、ETF 成分股跳转与添加闭环、中英文搜索、添加/配置持仓、右键置顶置底星标移除、分组新建/移出/删除、主题/字号/配色/开关/刷新频率、数据源标注、关于弹窗、toast、导出配置落盘、开盘浮顶排序(forceopen 钩子)、图标数字两种模式、新浪 DNR、持久化、chrome.action.openPopup 真实弹窗(尺寸/底栏钉定)、缩放视口钉定(400px模拟)、forcetheme 预览钩子、站点权限一键授权横幅、空态文案。

## 打包发布

`npm run release` 会干净构建、校验 manifest 引用完整性，产出 `release/stock-watch-ext-v<版本>.zip`：

1. [Chrome Web Store 开发者控制台](https://chrome.google.com/webstore/devconsole)（一次性 $5）→ 新建应用 → 上传 zip
2. 隐私声明：不收集用户数据；host 权限用途「拉取公开行情数据」；用到 `declarativeNetRequest`（新浪 Referer）
3. 提交审核，通常 1-3 天；团队内直接分发 zip / dist 目录加载即可

## 在 Chrome 里加载

1. `npm run build`
2. 打开 `chrome://extensions`，右上角开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `dist/` 目录
4. 点工具栏图标即可弹窗盯盘（若从旧版本升级，先在 chrome://extensions 里「重新加载」一次扩展）

## MV3 已知约束

- `chrome.alarms` 最小周期约 30s：**popup 关闭后**的角标/提醒为分钟级；popup 打开时由页面定时器驱动。
- 工具栏图标由 service worker 用 `OffscreenCanvas` 运行时绘制，无需 PNG 资源。

## 尚未做

- 账号同步登录（按钮为占位，toast 提示；数据全部本地）。
- 到价提醒录入还是 `prompt` 简易版。
- K 线成交量副图；K 线悬浮已有气泡但无十字光标（分时有）。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。

> 本扩展仅聚合展示公开行情数据，不构成任何投资建议；所有自选/持仓数据均保存在浏览器本地，不上传服务器。
