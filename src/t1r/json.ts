/** 模型原始输出 → JSON。真实通道的鲁棒性入口：即使要求了 JSON 模式，也要能处理围栏与前后缀。 */
export interface ParseAttempt {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * 三级解析：直接 parse → 去 markdown 围栏 → 截取首个 `{` 到末个 `}`。
 * 全部失败时返回错误信息（截断，且绝不含凭证）。
 */
export function extractJson(raw: string): ParseAttempt {
  const attempts: Array<[string, string]> = [
    ['direct', raw.trim()],
    ['fenced', raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()],
    ['braces', (() => {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      return start >= 0 && end > start ? raw.slice(start, end + 1) : raw.trim();
    })()],
  ];
  let lastError = '空输出';
  for (const [label, text] of attempts) {
    if (text === '') continue;
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      lastError = `${label}: ${(e as Error).message.slice(0, 120)}`;
    }
  }
  return { ok: false, error: lastError };
}
