/**
 * 文档与代码的一致性（机器检查，防止「代码改了、说明没改」）：
 * - `docs/web-server.md` 必须覆盖 `src/web/server.ts` 里出现的每个 HTTP 路由前缀；
 * - `README.md` 的可用命令必须与 `package.json` 的 scripts 对得上（web:* 部分）；
 * - 验收记录/服务说明里的「已知限制」必须点到实时模型覆盖与真人麦克风未验证这两件事。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/web/paths.js';

const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

test('docs/web-server.md 覆盖 server.ts 里的每个 /api 路由', () => {
  const server = read('src/web/server.ts');
  const doc = read('docs/web-server.md');
  const apiLiterals = new Set<string>();
  for (const m of server.matchAll(/['"`](\/api\/[A-Za-z0-9_/:.-]*)['"`]/g)) apiLiterals.add(m[1]!);
  for (const m of server.matchAll(/\/\^\\\/(api[A-Za-z0-9_/\\()[\]^$.*+?|{}-]*)/g)) {
    // 正则里抽出来的前缀：截到第一个捕获组为止，去掉转义与尾部斜杠
    const prefix = m[1]!.replace(/\\/g, '').split('(')[0]!.replace(/\/$/, '');
    apiLiterals.add(`/${prefix}`);
  }
  assert.ok(apiLiterals.size >= 5, `没抽到路由，检查正则：${[...apiLiterals].join(',')}`);
  const missing = [...apiLiterals].filter((p) => {
    const normalized = p.replace(/\/$/, '');
    return !doc.includes(normalized);
  });
  assert.deepEqual(missing, [], `docs/web-server.md 缺少路由说明：${missing.join(', ')}`);
});

test('README 的 web:* 命令与 package.json 一致', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const readme = read('README.md');
  for (const name of Object.keys(pkg.scripts).filter((s) => s.startsWith('web:'))) {
    assert.ok(readme.includes(`npm run ${name}`), `README 里缺少命令 npm run ${name}`);
  }
});

test('服务说明与验收记录必须如实标注未验证项', () => {
  const doc = read('docs/web-server.md');
  assert.match(doc, /真人麦克风/, '必须写明真人麦克风未验证');
  assert.match(doc, /AI_INTERVIEWER_REALTIME_MODEL/, '必须写明实时模型覆盖开关');
  assert.match(doc, /不是产品界面/, '必须写明 /harness 不是产品界面');
  assert.equal(doc.includes('/Users/apple'), false, 'docs 不得出现本机绝对路径');
  const readme = read('README.md');
  assert.equal(readme.includes('/Users/apple'), false, 'README 不得出现本机绝对路径');
});
