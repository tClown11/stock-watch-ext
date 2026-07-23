// 打包发布：混淆构建 → 校验产物 → 生成两种分发包：
//   ① 盯盘助手-vX-安装包.zip —— 发给他人（解压 → 开发者模式 → 加载已解压）
//   ② stock-watch-ext-vX.zip —— Chrome Web Store 上传用
// 用法：npm run release   （产物在 release/ 下）
// 不再生成 .crx：新版 Chrome（Win/macOS）安装非商店 .crx 后会强制停用，无法使用。
// 注意：zip 不能直接在 chrome://extensions 加载——本地调试请「加载已解压的扩展程序」选 dist/。
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync, cpSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIST = path.join(ROOT, 'dist');
const OUT_DIR = path.join(ROOT, 'release');

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });

// 1) 干净构建 + 压缩混淆（发布产物不含可读源码；本地调试用 npm run build 不混淆）
run('node build.mjs --clean --minify');

// 2) 产物完整性校验（漏拷一个静态文件就会在这里拦下）
const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
const required = [
  'manifest.json',
  'popup.html',
  'popup.css',
  'popup.js',
  'service-worker.js',
  'dnr_rules.json',
];
for (const f of required) {
  if (!existsSync(path.join(DIST, f))) {
    console.error(`✗ dist 缺少 ${f}`);
    process.exit(1);
  }
}
// manifest 引用的文件必须真实存在
const refs = [
  manifest.action?.default_popup,
  manifest.background?.service_worker,
  ...(manifest.declarative_net_request?.rule_resources ?? []).map((r) => r.path),
].filter(Boolean);
for (const f of refs) {
  if (!existsSync(path.join(DIST, f))) {
    console.error(`✗ manifest 引用了不存在的文件: ${f}`);
    process.exit(1);
  }
}

// 3) 商店 zip（根目录必须直接是 manifest.json；CWS 不接受带 key 的 manifest → 剔除）
const version = manifest.version;
const zipPath = path.join(OUT_DIR, `stock-watch-ext-v${version}.zip`);
mkdirSync(OUT_DIR, { recursive: true });
rmSync(zipPath, { force: true });
const storeStage = path.join(OUT_DIR, '.store-stage');
rmSync(storeStage, { recursive: true, force: true });
cpSync(DIST, storeStage, { recursive: true });
const storeManifest = JSON.parse(readFileSync(path.join(storeStage, 'manifest.json'), 'utf8'));
delete storeManifest.key;
writeFileSync(path.join(storeStage, 'manifest.json'), JSON.stringify(storeManifest, null, 2));
run(`cd ${JSON.stringify(storeStage)} && zip -r -X -q ${JSON.stringify(zipPath)} . -x '.*' -x '__MACOSX*'`);
rmSync(storeStage, { recursive: true, force: true });
const kb = (statSync(zipPath).size / 1024).toFixed(1);

// manifest.key 固定的扩展 ID（与 release-key.pem 对应）：加载路径/机器变化 ID 不变
const extId = manifest.key
  ? [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)]
      .map((b) => ((b >> 4) & 0xf).toString(16) + (b & 0xf).toString(16))
      .join('')
      .replace(/[0-9a-f]/g, (c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)))
  : '(未固定)';

// 4) 分享安装包：扩展文件夹 + 安装说明.txt（发给他人安装的推荐产物）
//    新版 Chrome（Win/macOS）已禁止安装非商店 .crx（CRX_REQUIRED_PROOF_MISSING），
//    所以对外分发走「解压 → 开发者模式 → 加载已解压」，说明书随包附带。
const EXT_DIR_NAME = '盯盘助手-插件';
const INSTALL_GUIDE = `﻿「盯盘助手」安装说明（Chrome / Edge 通用，约 1 分钟）
====================================================

1. 解压本压缩包，得到「${EXT_DIR_NAME}」文件夹。
   把它放到一个固定、不会误删的位置（如 文档/浏览器插件/）。
   ⚠ 安装后请勿移动或删除该文件夹，否则扩展会失效。

2. 打开 Chrome，地址栏输入 chrome://extensions 并回车。
   （Edge 浏览器则输入 edge://extensions，后续步骤相同）

3. 打开页面右上角的「开发者模式」开关。

4. 点击左上角「加载已解压的扩展程序」，选择第 1 步的「${EXT_DIR_NAME}」文件夹。

5. 点击浏览器工具栏的拼图图标 🧩，找到「盯盘助手」，点旁边的图钉 📌 固定到工具栏。
   完成！点击图标即可使用。

常见问题
--------
▸ 启动 Chrome 时弹出「请停用以开发者模式运行的扩展程序」？
  这是非商店安装的例行提示，点「×」关闭即可，不影响使用。
▸ 如何更新版本？
  收到新压缩包后：解压并覆盖原「${EXT_DIR_NAME}」文件夹的内容，
  再到 chrome://extensions 点「盯盘助手」卡片上的刷新按钮 ⟳ 即完成。
  自选/持仓/设置保存在浏览器内部（不在这个文件夹里），覆盖文件不会丢。
▸ 数据会丢吗？
  只有「移除扩展」会清空浏览器内的数据。扩展会自动把配置备份到
  Chrome 账号同步空间（浏览器已登录并开启同步时）：卸载重装、换电脑
  后首次打开会自动恢复。保险起见也可在 设置 → 导出配置 存一份文件。
▸ 如何卸载？
  chrome://extensions 中点「移除」，再删除文件夹即可。
`;
const shareStage = path.join(OUT_DIR, '.stage');
rmSync(shareStage, { recursive: true, force: true });
cpSync(DIST, path.join(shareStage, EXT_DIR_NAME), { recursive: true });
writeFileSync(path.join(shareStage, '安装说明.txt'), INSTALL_GUIDE);
const shareZip = path.join(OUT_DIR, `盯盘助手-v${version}-安装包.zip`);
rmSync(shareZip, { force: true });
run(`cd ${JSON.stringify(shareStage)} && zip -r -X -q ${JSON.stringify(shareZip)} . -x '.*'`);
rmSync(shareStage, { recursive: true, force: true });
const shareKb = (statSync(shareZip).size / 1024).toFixed(1);

console.log(`\n✓ ${path.relative(ROOT, shareZip)}（${shareKb} KB ← 发给别人装这个）`);
console.log(`✓ ${path.relative(ROOT, zipPath)}（${kb} KB, 商店上传用, manifest v${version}, 已剔除 key）`);
console.log(`✓ 扩展 ID 已固定: ${extId}（由 release-key.pem 派生，任何路径/机器加载均一致）`);
console.log(`
产物均为压缩混淆后的构建结果，不含 src/ 源码。分发方式：
  ▸ 给别人安装   发「盯盘助手-v${version}-安装包.zip」→ 对方解压后按包内《安装说明.txt》操作
                （解压 → chrome://extensions → 开发者模式 → 加载已解压）
  ▸ 本地调试     npm run build（不混淆）→ chrome://extensions →「加载已解压」选 dist/
  ▸ 商店发布     https://chrome.google.com/webstore/devconsole 上传 stock-watch-ext-v${version}.zip
                （一次性 $5；可设「不公开」仅凭链接安装，才是真正的一键安装体验）
  ▸ 不出 .crx    新版 Chrome（Win/macOS）安装非商店 .crx 后会强制停用，此路不通`);
