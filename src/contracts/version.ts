/**
 * 契约与规则版本。
 *
 * 版本语义（T2 定稿）：
 * - `contract@0.2.0`：五对象 Schema 与 TS 类型的**定稿版**（T2 冻结 D1–D11 后升版）。
 *   与 0.1.0 **结构完全相同**——差异只有版本号字符串本身，由 `validate.ts` 在加载时逐 schema
 *   断言，并在单测里固定。
 * - `contract@0.1.0`：T1 期证据（`evidence/t1r/**`、`src/review/fixtures.ts` 的历史样例）
 *   记录的就是这一版；Schema 原样留档在 `src/contracts/schemas/v0.1.0/`，校验器**同时注册两个版本**，
 *   历史证据不会因为升版变成不可校验。
 * - `rules@0.2.0`：三入口共用的训练规则文本版本（`src/rules/rules.ts` 是唯一源）。
 * - `prompts@0.2.0`：中文提示词版本。
 */
export const CONTRACT_VERSION = '0.2.0';

/** 当前版本在前；校验器为列表内每个版本各编译一份校验函数。 */
export const SUPPORTED_CONTRACT_VERSIONS = ['0.2.0', '0.1.0'] as const;

export type ContractVersion = (typeof SUPPORTED_CONTRACT_VERSIONS)[number];

export const CONTRACT_NAMES = [
  'candidate-materials',
  'question-plan',
  'turn',
  'feedback',
  'session-report',
] as const;

export type ContractName = (typeof CONTRACT_NAMES)[number];

/** 规则版本：三入口共用的训练规则文本版本（提示词与标尺随其升版）。 */
export { RULES_VERSION as RULE_VERSION, RULES_VERSION } from '../rules/rules.js';
