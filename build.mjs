import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
// 默认原地覆盖构建：不删 dist/，否则 Chrome 里已加载的 unpacked 扩展会因文件
// 瞬间消失而被标记失效（必须手动重载）。发布走 `--clean`（release.mjs 使用）。
const clean = process.argv.includes('--clean');
// `--minify`（release.mjs 使用）：压缩混淆 JS/CSS——变量名压成单字母、删注释、
// 压成单行。分发产物不可读，TypeScript 源码只存在于本机 src/。
const minify = process.argv.includes('--minify');
const outdir = 'dist';

if (clean) await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// Static files copied verbatim into the loadable extension root.
// popup.css 在 minify 模式下走 esbuild 压缩而非原样拷贝。
const statics = [
  ['manifest.json', 'manifest.json'],
  ['dnr_rules.json', 'dnr_rules.json'],
  ['src/popup/popup.html', 'popup.html'],
  ...(minify ? [] : [['src/popup/popup.css', 'popup.css']]),
];
async function copyStatics() {
  await Promise.all(statics.map(([from, to]) => cp(from, `${outdir}/${to}`)));
}
await copyStatics();
if (minify) {
  await esbuild.build({
    entryPoints: ['src/popup/popup.css'],
    outfile: `${outdir}/popup.css`,
    minify: true,
    logLevel: 'silent',
  });
}

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  minify,
};

const entries = {
  'popup.js': 'src/popup/popup.ts',
  'service-worker.js': 'src/background/service-worker.ts',
};

const contexts = await Promise.all(
  Object.entries(entries).map(([out, entry]) =>
    esbuild.context({ ...common, entryPoints: [entry], outfile: `${outdir}/${out}` })
  )
);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  // Re-copy statics on any change (cheap; esbuild watch only tracks JS deps).
  const chokidarLike = statics.map(([from]) => from);
  console.log('[build] watching', entries, 'and', chokidarLike);
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  console.log('[build] done ->', outdir);
}
