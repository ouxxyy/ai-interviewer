/** mock 评审通道：fixture 脚本化模型输出，用于单测校验/重试/降级路径（不涉及真实模型）。 */
import type { ReviewChannel } from './reviewer.js';
import type { TextVersion } from '../contracts/types.js';

/** 从基准文本取 5 段真实子串作为引用（保证可定位）。 */
function pickQuotes(basisText: string): string[] {
  const quotes: string[] = [];
  const usable = basisText.replace(/\s+/g, '');
  for (let i = 0; i < 5; i++) {
    const start = Math.min(i * 3, Math.max(0, usable.length - 2));
    quotes.push(usable.slice(start, start + 2));
  }
  return quotes;
}

export function buildValidReviewJson(basisText: string, questionId: string, turnIds: string[], textVersion: TextVersion): string {
  const q = pickQuotes(basisText);
  const dim = (i: number, level: string) =>
    level === '无法判断'
      ? `{"level":"无法判断","quote":null,"reason":"回答中未见可判断该维度的信息"}`
      : `{"level":"${level}","quote":{"text":${JSON.stringify(q[i])},"start":0,"end":2,"turnId":"${turnIds[0]}","textVersion":"${textVersion}","matchType":"exact"},"reason":"基于所引原话的判断依据"}`;
  return JSON.stringify({
    contractVersion: '0.1.0',
    questionId,
    reviewBasis: { turnIds, textVersion },
    dimensions: {
      relevance: JSON.parse(dim(0, '部分清楚')),
      specificity: JSON.parse(dim(1, '证据不足')),
      contribution: JSON.parse(dim(2, '充分清楚')),
      resultsReflection: JSON.parse(dim(3, '无法判断')),
      structure: JSON.parse(dim(4, '部分清楚')),
    },
    factGaps: ['个人在项目中的具体分工未说明'],
    topImprovement: '补充你个人负责的具体动作与可核对的结果',
    nextFacts: ['你在项目中的具体分工', '结果与你个人动作的对应关系'],
    reviewVersion: 'prompts@0.1.0-t1r',
  });
}

/** 恒定有效通道。 */
export function validChannel(basisText: string, questionId: string, turnIds: string[], textVersion: TextVersion): ReviewChannel {
  return { call: () => buildValidReviewJson(basisText, questionId, turnIds, textVersion) };
}

/** 第 1 次输出非法 JSON，第 2 次起有效。 */
export function invalidJsonOnceChannel(basisText: string, questionId: string, turnIds: string[], textVersion: TextVersion): ReviewChannel {
  let called = false;
  return {
    call: () => {
      if (!called) {
        called = true;
        return '这不是JSON，模型偶尔会这样开头。{contractVersion...';
      }
      return buildValidReviewJson(basisText, questionId, turnIds, textVersion);
    },
  };
}

/** 恒定 Schema 不合规（多余字段 + 非法枚举）。 */
export function schemaInvalidChannel(): ReviewChannel {
  return {
    call: () =>
      JSON.stringify({
        contractVersion: '0.1.0',
        questionId: 'q1',
        reviewBasis: { turnIds: ['t1'], textVersion: 'raw' },
        dimensions: {},
        score: 88,
        extraField: true,
      }),
  };
}

/** 第 1 次引用不存在于基准文本，第 2 次起有效。 */
export function quoteMissingOnceChannel(basisText: string, questionId: string, turnIds: string[], textVersion: TextVersion): ReviewChannel {
  let called = false;
  return {
    call: () => {
      const valid = JSON.parse(buildValidReviewJson(basisText, questionId, turnIds, textVersion)) as {
        dimensions: Record<string, { quote: { text: string } | null }>;
      };
      if (!called) {
        called = true;
        valid.dimensions.relevance!.quote = { text: '这句话从未出现在用户回答中', start: 0, end: 2, turnId: turnIds[0]!, textVersion, matchType: 'exact' } as never;
      }
      return JSON.stringify(valid);
    },
  };
}

/** 恒定引用被改写一个字（永远无法定位）→ 触发降级。 */
export function quoteAlteredChannel(basisText: string, questionId: string, turnIds: string[], textVersion: TextVersion): ReviewChannel {
  return {
    call: () => {
      const valid = JSON.parse(buildValidReviewJson(basisText, questionId, turnIds, textVersion)) as {
        dimensions: Record<string, { quote: { text: string } | null }>;
      };
      const orig = valid.dimensions.contribution!.quote!.text;
      valid.dimensions.contribution!.quote!.text = orig.slice(0, -1) + '魯';
      return JSON.stringify(valid);
    },
  };
}
