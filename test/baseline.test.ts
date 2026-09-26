import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PINNED = {
  liftoff: '550e4bf74eab1b329dcb64830ed6172063f34d27',
  gptinterviewer: '048419cf9b124e566c0423cbfbe9efa14e6fbe36',
};

test('项目说明与审计文档存在', () => {
  for (const f of ['README.md', 'AGENTS.md', 'docs/reference-audit.md', 'docs/environment-baseline.md', 'docs/contracts.md', '.env.example']) {
    assert.ok(existsSync(path.join(REPO_ROOT, f)), `${f} 缺失`);
  }
});

test('参考审计记录了两个固定 commit', () => {
  const audit = readFileSync(path.join(REPO_ROOT, 'docs/reference-audit.md'), 'utf8');
  assert.ok(audit.includes(PINNED.liftoff), '审计缺少 liftoff 固定 commit');
  assert.ok(audit.includes(PINNED.gptinterviewer), '审计缺少 GPTInterviewer 固定 commit');
});

test('gitignore 排除密钥文件与第三方参考源码', () => {
  const gi = readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  assert.ok(/^\.env$/m.test(gi), '.gitignore 未排除 .env');
  assert.ok(/^reference\/$/m.test(gi), '.gitignore 未排除 reference/');
  assert.ok(/^data\/$/m.test(gi), '.gitignore 未排除 data/');
});

test('参考仓库在本地按固定 commit 检出（存在且 HEAD 正确）', () => {
  for (const [name, sha] of Object.entries(PINNED)) {
    const dir = path.join(REPO_ROOT, 'reference', name === 'liftoff' ? 'liftoff' : 'GPTInterviewer');
    assert.ok(existsSync(path.join(dir, '.git')), `${name} 未检出`);
    const head = execSync(`git -C "${dir}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
    assert.equal(head, sha, `${name} HEAD 与固定 commit 不符`);
  }
});

test('环境基线记录含凭证缺失的如实标注与 PATH 快照说明（reviewer 修复项）', () => {
  const env = readFileSync(path.join(REPO_ROOT, 'docs/environment-baseline.md'), 'utf8');
  assert.ok(env.includes('FAIL'), '环境基线未标注任何失败项（当前已知凭证缺失，应如实记录）');
  assert.ok(env.includes('PATH'), '基线文档头部须注明 PATH 快照语义');
  assert.ok(/@ \//.test(env), '工具链版本须带解析路径（如 node: v26 @ /opt/homebrew/bin/node）');
});

test('.env.example 提供凭证注入点且不含真实密钥', () => {
  const env = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
  assert.ok(/^DASHSCOPE_API_KEY=$/m.test(env), 'DASHSCOPE_API_KEY 注入点必须留空');
  assert.ok(!/(API_KEY|TOKEN|SECRET)=\S+/.test(env), '示例文件不得包含任何非空密钥值');
  assert.ok(env.includes('NO_PROXY'), '须包含国内端点代理例外说明（PM §4 T0 节）');
});
