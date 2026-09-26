/**
 * 纪律测试（A7）：把「已验证 / 已核对」这类声明变成每次 `npm test` 都会跑的机器检查。
 *
 * 起因：T2 交付里有两处「声称已核对但产物不符」——
 *   ① `evidence/t2/manifest.json` 的一条记录是生成 manifest 时的旧值（manifest 在最后一次写
 *      run-summary **之前**生成）；
 *   ② `evidence/t1r/run-summary.json` 里同时留着新的 `latencyFailures` 对象和旧的标量
 *      `latency.*.failures`，同一文件自相矛盾。
 * 两处都不是功能缺陷，但都属于「报账不实」。这个文件让同类问题不可能再靠肉眼漏过去：
 * 任何人再让 manifest 与磁盘脱钩，或者再留下自相矛盾的字段，测试直接红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/t1r/env.js';
import { verifyManifest } from '../src/t1r/evidence.js';

function findManifests(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...findManifests(full));
    else if (name === 'manifest.json') out.push(full);
  }
  return out;
}

const manifests = findManifests(path.join(REPO_ROOT, 'evidence'));

test('evidence/ 下每个 manifest 都与磁盘逐条一致（字节数 + sha256）', () => {
  assert.ok(manifests.length >= 2, `至少应有 t1r 与 t2 两份 manifest，实际找到 ${manifests.length} 份`);
  for (const m of manifests) {
    const rel = path.relative(REPO_ROOT, m);
    const { total, mismatches } = verifyManifest(m);
    assert.ok(total > 0, `${rel} 不该是空清单`);
    assert.deepEqual(
      mismatches,
      [],
      `${rel} 有 ${mismatches.length}/${total} 条与磁盘不符：${mismatches.map((x) => `${x.path}（${x.reason}）`).join('; ')}`,
    );
  }
});

test('manifest 自己记录了核对结果，且记录与复核一致', () => {
  for (const m of manifests) {
    const rel = path.relative(REPO_ROOT, m);
    const doc = JSON.parse(readFileSync(m, 'utf8')) as { verifiedAgainstDisk?: { total: number; mismatches: unknown[] } };
    if (doc.verifiedAgainstDisk === undefined) continue; // t1r 清单由 manifest:refresh 生成，不带该字段
    assert.equal(doc.verifiedAgainstDisk.mismatches.length, 0, `${rel} 记录的核对结果里带不符项`);
    assert.equal(doc.verifiedAgainstDisk.total, verifyManifest(m).total, `${rel} 记录的条数与实际不符`);
  }
});

test('run-summary 不得同时留下新旧两种 failures 口径（F2 回归）', () => {
  const targets = [
    path.join(REPO_ROOT, 'evidence', 't1r', 'run-summary.json'),
    path.join(REPO_ROOT, 'evidence', 't2', 'run-summary.json'),
  ].filter(existsSync);
  assert.ok(targets.length > 0, '至少要有一份 run-summary');
  for (const t of targets) {
    const rel = path.relative(REPO_ROOT, t);
    const doc = JSON.parse(readFileSync(t, 'utf8')) as Record<string, unknown>;
    const newShape = doc.latencyFailures as Record<string, unknown> | undefined;
    if (newShape === undefined) continue;
    const latency = doc.latency as Record<string, { failures?: unknown }> | undefined;
    for (const leg of ['realtime', 'review']) {
      const projected = latency?.[leg]?.failures;
      if (projected === undefined) continue;
      assert.deepEqual(
        projected,
        newShape[leg],
        `${rel} 的 latency.${leg}.failures 与 latencyFailures.${leg} 不一致——同一文件两种口径，复核者会撞矛盾`,
      );
    }
  }
});

test('标定轮次结构完整：每行带 round 字段，条数 = 18 × 轮数（R3 回归）', () => {
  const calDir = path.join(REPO_ROOT, 'evidence', 't2', 'calibration');
  const runsPath = path.join(calDir, 'runs.jsonl');
  assert.ok(existsSync(runsPath), 'calibration/runs.jsonl 必须存在');
  const rows = readFileSync(runsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { round?: number; variant?: string });
  assert.ok(rows.length > 0);
  for (const [i, r] of rows.entries()) {
    assert.equal(typeof r.round, 'number', `runs.jsonl 第 ${i + 1} 行缺 round 字段——「当前文件是哪一轮」不该靠 git 推断`);
  }
  const rounds = [...new Set(rows.map((r) => r.round!))].sort((a, b) => a - b);
  assert.ok(rounds.length >= 1, '至少一轮');
  assert.equal(rows.length, 18 * rounds.length, `合并视图应恰好是 18 × ${rounds.length} = ${18 * rounds.length} 行，实际 ${rows.length}`);
  // 每轮目录自己也要在，且与合并视图里的同轮行逐行一致
  for (const n of rounds) {
    const perRound = path.join(calDir, `round-${n}`, 'runs.jsonl');
    assert.ok(existsSync(perRound), `round-${n}/runs.jsonl 必须入库（第 1 轮曾经只剩下在 git 里）`);
    const part = readFileSync(perRound, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { round?: number });
    assert.equal(part.length, 18, `round-${n} 应有 18 行`);
    for (const r of part) assert.equal(r.round, n, `round-${n} 里有行的 round 不是 ${n}`);
    const mergedSlice = rows.filter((r) => r.round === n);
    assert.deepEqual(mergedSlice, part, `round-${n} 与合并视图里的同轮行必须逐行一致`);
  }
});

test('产物里不得出现本机绝对路径（验收记录声称过「无绝对路径」）', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith('.wav') || name.endsWith('.pcm')) continue;
      const text = readFileSync(full, 'utf8');
      // 工具解析路径（/opt/homebrew、/usr/bin 等 PATH 快照）是 T0 特意保留的信息，不算违规。
      if (/\/Users\/[A-Za-z0-9._-]+\//.test(text)) offenders.push(path.relative(REPO_ROOT, full));
    }
  };
  walk(path.join(REPO_ROOT, 'evidence'));
  walk(path.join(REPO_ROOT, 'docs'));
  for (const f of ['README.md', 'AGENTS.md']) {
    if (existsSync(path.join(REPO_ROOT, f)) && /\/Users\/[A-Za-z0-9._-]+\//.test(readFileSync(path.join(REPO_ROOT, f), 'utf8'))) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `这些产物里出现了本机绝对路径：${offenders.join(', ')}`);
});

test('产物里不得出现凭证值或 sk-* 模式', () => {
  const key = process.env.DASHSCOPE_API_KEY;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith('.wav') || name.endsWith('.pcm')) continue;
      const text = readFileSync(full, 'utf8');
      if (/sk-[A-Za-z0-9._-]{12,}/.test(text)) offenders.push(path.relative(REPO_ROOT, full));
      else if (key !== undefined && key.length >= 8 && text.includes(key)) offenders.push(path.relative(REPO_ROOT, full));
    }
  };
  walk(path.join(REPO_ROOT, 'evidence'));
  walk(path.join(REPO_ROOT, 'docs'));
  assert.deepEqual(offenders, [], `这些产物里出现了疑似凭证：${offenders.join(', ')}`);
});
