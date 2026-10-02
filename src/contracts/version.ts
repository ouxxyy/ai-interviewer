/** 现行四环节契约 0.3.0；0.1/0.2 原样留档，用于历史证据。 */
export const CONTRACT_VERSION = '0.3.0';

/** 当前版本在前；校验器为列表内每个版本各编译一份校验函数。 */
export const SUPPORTED_CONTRACT_VERSIONS = ['0.3.0', '0.2.0', '0.1.0'] as const;

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
