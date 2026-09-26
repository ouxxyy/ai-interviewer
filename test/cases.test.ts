import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/contracts/validate.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const data = JSON.parse(readFileSync(path.join(REPO_ROOT, 'cases', 'cases.json'), 'utf8')) as {
  version: string;
  cases: Array<{
    id: string;
    synthetic: boolean;
    stage: string;
    track: string;
    targetRole: string;
    flawType: string;
    materials: { jd: string; experience: string };
    questionText: string;
    firstAnswer: string;
    expectedDims: Record<string, string>;
    expectedGaps: string[];
    expectedBehavior: string | null;
    evaluatorNote?: string;
  }>;
};

const LEVELS = ['证据不足', '部分清楚', '充分清楚', '无法判断'];
const DIMS = ['relevance', 'specificity', 'contribution', 'resultsReflection', 'structure'];
const REQUIRED_FLAWS = ['空泛长答', '跑题', '术语堆砌', '缺数字可信结果', '团队冒充个人贡献', 'JD简历冲突', '转录错误', '要求编造经历', '简历提示注入', '常规良好'];

test('案例库：共 24 例且全部标注合成', () => {
  assert.equal(data.cases.length, 24);
  assert.ok(data.cases.every((c) => c.synthetic === true), '所有案例必须 synthetic=true');
  assert.match(data.version, /^cases@/);
});

test('覆盖矩阵：应届/社招 × 产品运营/研发数据 每象限恰 6 例', () => {
  const quadrants = new Map<string, number>();
  for (const c of data.cases) {
    const key = `${c.stage}|${c.track}`;
    quadrants.set(key, (quadrants.get(key) ?? 0) + 1);
  }
  for (const stage of ['应届', '社招']) {
    for (const track of ['产品运营', '研发数据']) {
      assert.equal(quadrants.get(`${stage}|${track}`), 6, `${stage}×${track} 应为 6 例，实际 ${quadrants.get(`${stage}|${track}`)}`);
    }
  }
});

test('缺陷类型覆盖：全部必测类型出现，注入类 ≥3', () => {
  const counts = new Map<string, number>();
  for (const c of data.cases) counts.set(c.flawType, (counts.get(c.flawType) ?? 0) + 1);
  for (const flaw of REQUIRED_FLAWS) {
    assert.ok((counts.get(flaw) ?? 0) >= 1, `缺陷类型 ${flaw} 至少 1 例`);
  }
  const injection = (counts.get('简历提示注入') ?? 0) + (counts.get('JD注入') ?? 0);
  assert.ok(injection >= 3, `注入类案例应 ≥3，实际 ${injection}`);
});

test('注入类案例必须带预期行为，非注入类为 null（规则说明放 evaluatorNote）', () => {
  for (const c of data.cases) {
    if (c.flawType.includes('注入')) {
      assert.ok(c.expectedBehavior && c.expectedBehavior.length >= 20, `${c.id} 注入案例必须有预期行为`);
    } else if (c.flawType === '要求编造经历') {
      assert.ok(c.expectedBehavior, `${c.id} 编造类案例必须有预期行为`);
    } else {
      assert.equal(c.expectedBehavior, null, `${c.id} 非注入类 expectedBehavior 应为 null`);
    }
  }
});

test('预期标注完整：五维齐全、档位合法、缺口为空时只允许常规良好类', () => {
  for (const c of data.cases) {
    assert.deepEqual(Object.keys(c.expectedDims).sort(), [...DIMS].sort(), `${c.id} 五维齐全`);
    for (const [dim, level] of Object.entries(c.expectedDims)) {
      assert.ok(LEVELS.includes(level), `${c.id}.${dim} 非法档位 ${level}`);
    }
    if (c.expectedGaps.length === 0) {
      assert.equal(c.flawType, '常规良好', `${c.id} 只有常规良好类可以无事实缺口标注`);
    }
    assert.ok(c.questionText.length >= 8, `${c.id} 问题文本过短`);
    assert.ok(c.firstAnswer.length >= 60, `${c.id} 首轮回答应 substantive（≥60 字）`);
  }
});

test('案例材料通过 CandidateMaterials 契约校验（confirmed 口径）', () => {
  for (const c of data.cases) {
    const obj = {
      contractVersion: '0.2.0',
      jd: c.materials.jd,
      experience: c.materials.experience,
      stage: c.stage,
      targetRole: c.targetRole,
      materialsVersion: 1,
      confirmed: true,
    };
    const r = validateContract('candidate-materials', obj);
    assert.equal(r.ok, true, `${c.id} 材料应通过契约：${JSON.stringify(r.errors)}`);
  }
});

test('转录错误案例：evaluatorNote 须声明“逐字定位转写原文”', () => {
  for (const c of data.cases.filter((x) => x.flawType === '转录错误')) {
    assert.ok(c.evaluatorNote?.includes('逐字') && c.evaluatorNote?.includes('转写'), `${c.id} 转录错误案例须声明逐字定位规则`);
  }
});
