/**
 * 生产包反向检查（P2-1）。
 *
 * 被打回的现象：开发预览入口虽然在生产构建里被折叠成 `null`，但静态 import 仍把
 * 预览 fixture、错误画廊和整套演示数据打进了生产 JS 与 source map。
 * 这条断言是反向的：**生产产物里必须找不到预览数据、预览模块与画廊页**。
 * 依赖 `npm test` 先跑 `npm run build`（vite build 会重建 dist/web-client）。
 *
 * 注意区分两类标记：
 * - 数据类（fixture 文本、演示 sid）：JS 和 source map 里都不得出现；
 * - 标识符类（`previewBundle` 等）：只要求生产 JS 里没有——App.tsx 自己的 DEV 分支源码
 *   文本会出现在 source map 的 sourcesContent 里，那是「一个被消除的分支」的痕迹，不是数据泄漏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const DIST = path.join(REPO_ROOT, 'dist', 'web-client');
const ASSETS = path.join(DIST, 'assets');

/** fixture 独有的数据：出现在产物里就说明预览数据被打进了生产包。 */
const FIXTURE_DATA = [
  'preview-session',
  'preview-report',
  'preview-settings',
  '我先把阻塞点拆成三个可以并行验证的小问题',
  '欧八AI面试',
  '出错时，告诉用户下一步',
  'disclosure@0.1.0',
  '我负责把每周的用户反馈拆成三类，先与产研确认优先级。',
];

/** 预览入口的标识符与动态 import：生产 JS 里必须一个都不剩。 */
const PREVIEW_IDENTIFIERS = ['previewBundle', 'previewDisclosure', 'ERROR_PREVIEWS', "import('./preview')", "import('./pages/ErrorGalleryPage')"];

function assetFiles(extension: string): string[] {
  assert.ok(existsSync(ASSETS), `生产产物不存在：${ASSETS}（npm test 会先跑 npm run build）`);
  return readdirSync(ASSETS).filter((name) => name.endsWith(extension)).map((name) => path.join(ASSETS, name));
}

function staticFiles(root = DIST): string[] {
  assert.ok(existsSync(root), `生产产物不存在：${root}（npm test 会先跑 npm run build）`);
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? staticFiles(file) : statSync(file).isFile() ? [file] : [];
  });
}

test('P2-1：生产 JS 里没有预览入口、画廊与 fixture 数据', () => {
  const files = assetFiles('.js');
  assert.ok(files.length > 0, '至少应该有一个生产 JS 产物');
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const marker of [...FIXTURE_DATA, ...PREVIEW_IDENTIFIERS]) {
      assert.equal(content.includes(marker), false, `${path.basename(file)} 里不该出现预览标记「${marker}」`);
    }
  }
});

test('P2-1：开发预览入口只在 DEV 分支，生产包不产出预览 chunk', () => {
  const files = assetFiles('.js');
  assert.equal(files.length, 1, `生产构建应只有一个入口 chunk，实际：${files.map((f) => path.basename(f)).join(', ')}`);
  assert.equal(files.some((file) => path.basename(file).includes('preview')), false, '不该有预览 chunk');
});

test('P2-1：source map 里没有预览模块与画廊页，fixture 无从还原', () => {
  const files = assetFiles('.js.map');
  assert.ok(files.length > 0, '生产构建应当产出 source map（构建配置 sourcemap: true）');
  for (const file of files) {
    const map = JSON.parse(readFileSync(file, 'utf8')) as { sources?: string[]; sourcesContent?: string[] };
    const sources = map.sources ?? [];
    assert.equal(sources.some((source) => /preview|ErrorGalleryPage/.test(source)), false, `${path.basename(file)} 的 sources 里不该有预览模块：${sources.filter((s) => /preview|ErrorGalleryPage/.test(s)).join(', ')}`);
    const contents = (map.sourcesContent ?? []).join('\n');
    for (const marker of FIXTURE_DATA) {
      assert.equal(contents.includes(marker), false, `${path.basename(file)} 的 sourcesContent 里不该出现「${marker}」`);
    }
  }
});

test('P2-1：生产产物仍然带小八角色资源与入口 HTML（删预览不能删功能）', () => {
  const index = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  assert.ok(index.includes('欧八面试陪练'));
  assert.ok(existsSync(path.join(DIST, 'characters', 'char-hero.png')));
  assert.ok(existsSync(path.join(DIST, 'characters', 'char-listening.png')));
});

test('P2-1：递归扫描整个生产静态根，不含 webtest 模块与任何预览文案', () => {
  const files = staticFiles();
  assert.equal(files.some((file) => path.relative(DIST, file).split(path.sep).includes('src')), false, '生产静态根不该出现 webtest 编译出的 src/');
  for (const file of files) {
    const content = readFileSync(file);
    for (const marker of FIXTURE_DATA) {
      assert.equal(content.includes(Buffer.from(marker)), false, `${path.relative(DIST, file)} 里不该出现预览标记「${marker}」`);
    }
  }
});
