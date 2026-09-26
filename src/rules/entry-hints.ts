/**
 * 入口级操作提示（R6）—— **不是规则正文**。
 *
 * 它不进 `src/rules/rules.ts`，因此**不在 `rulesDigest()` 的覆盖范围内**。
 * 定位：它是「怎么把规则落成一次具体操作」的提示，可以改变**操作法**（甚至影响某一维的档位输出），
 * 所以绝不能悄悄躺在各个入口里当第二把尺子。
 *
 * 纪律：
 * - 两个纯文字入口（Skill / 简版 Prompt）都渲染本常量，逐字相同；
 * - **网页入口将来必须引用同一常量**，否则 A8 会被第三把尺子静默击穿；
 * - 它当前只有 1 次成功、无对照（`docs/t3-acceptance.md` §5），所以**只是提示，不是判据**；
 *   要不要升格为规则正文，走预登记的控制实验（`evidence/t3/structure-experiment/preregistration.md`）。
 *
 * 放在 `src/rules/` 下（而不是 `src/t3/content.ts`）是为了让 `src/prompts/` 也能引用它而**不产生循环依赖**：
 * 控制实验需要渲染「散文 / 机械」两版提示词做配对比较。
 */
export const ENTRY_HINTS = {
  structureQuoteProcedure:
    '把这一维的回答先按句号／问号／感叹号切成句子，挑出其中**完整的一句**原样整句复制过来；' +
    '如果整段回答没有任何完整句子能体现顺序，就判「无法判断」并在 reason 里说明。',
  structureHintLabel: '【入口级操作提示｜不属于规则正文，不在 rulesDigest 覆盖范围内】',
} as const;

/** 入口里渲染出来的提示块（两个入口必须逐字相同）。 */
export function structureHintBlock(indent = ''): string {
  const lines = [`${ENTRY_HINTS.structureHintLabel}`, `structure（表达结构）维度：${ENTRY_HINTS.structureQuoteProcedure}`];
  return lines.map((l) => `${indent}${l}`).join('\n');
}
