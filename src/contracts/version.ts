/** 契约版本：五个对象共用的契约版本号，随 T2 冻结升版。 */
export const CONTRACT_VERSION = '0.1.0';

export const CONTRACT_NAMES = [
  'candidate-materials',
  'question-plan',
  'turn',
  'feedback',
  'session-report',
] as const;

export type ContractName = (typeof CONTRACT_NAMES)[number];

/** 规则版本：三入口共用的训练规则文本版本（提示词与标尺随其升版）。 */
export const RULE_VERSION = 'rules@0.1.0-t1s';
