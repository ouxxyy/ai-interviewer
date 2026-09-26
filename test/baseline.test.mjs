import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// T0 基线静态断言：参考源码审计与环境基线记录存在且指向固定 commit。
const PINNED = {
  liftoff: '550e4bf74eab1b329dcb64830ed6172063f34d27',
  gptinterviewer: '048419cf9b124e566c0423cbfbe9efa14e6fbe36',
};

test('项目说明与审计文档存在', () => {
  for (const f of ['README.md', 'AGENTS.md', 'docs/reference-audit.md', 'docs/environment-baseline.md']) {
    assert.ok(existsSync(join(ROOT, f)), `${f} 缺失`);
  }
});

test('参考审计记录了两个固定 commit', () => {
  const audit = readFileSync(join(ROOT, 'docs/reference-audit.md'), 'utf8');
  assert.ok(audit.includes(PINNED.liftoff), '审计缺少 liftoff 固定 commit');
  assert.ok(audit.includes(PINNED.gptinterviewer), '审计缺少 GPTInterviewer 固定 commit');
});

test('gitignore 排除密钥文件与第三方参考源码', () => {
  const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  assert.ok(/^\.env$/m.test(gi), '.gitignore 未排除 .env');
  assert.ok(/^reference\/$/m.test(gi), '.gitignore 未排除 reference/');
});

test('参考仓库在本地按固定 commit 检出（存在且 HEAD 正确）', () => {
  for (const [name, sha] of Object.entries(PINNED)) {
    const dir = join(ROOT, 'reference', name === 'liftoff' ? 'liftoff' : 'GPTInterviewer');
    assert.ok(existsSync(join(dir, '.git')), `${name} 未检出`);
    const head = execSync(`git -C "${dir}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
    assert.equal(head, sha, `${name} HEAD 与固定 commit 不符`);
  }
});

test('环境基线记录含凭证缺失的如实标注', () => {
  const env = readFileSync(join(ROOT, 'docs/environment-baseline.md'), 'utf8');
  assert.ok(env.includes('FAIL'), '环境基线未标注任何失败项（当前已知凭证缺失，应如实记录）');
});
