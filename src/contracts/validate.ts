/** 契约校验器：加载五个 JSON Schema 并编译，可被单测与 CLI 共用。 */
import { Ajv } from 'ajv';
import candidateMaterialsSchema from './schemas/candidate-materials.schema.json' with { type: 'json' };
import questionPlanSchema from './schemas/question-plan.schema.json' with { type: 'json' };
import turnSchema from './schemas/turn.schema.json' with { type: 'json' };
import feedbackSchema from './schemas/feedback.schema.json' with { type: 'json' };
import sessionReportSchema from './schemas/session-report.schema.json' with { type: 'json' };
import { CONTRACT_NAMES, type ContractName } from './version.js';

const ajv = new Ajv({ allErrors: true, strict: true });
for (const schema of [candidateMaterialsSchema, questionPlanSchema, turnSchema, feedbackSchema, sessionReportSchema]) {
  ajv.addSchema(schema as object);
}

interface CompiledValidator {
  (data: unknown): boolean;
  errors?: Array<{ instancePath?: string; message?: string }>;
}

const compiled = new Map<ContractName, CompiledValidator>();
for (const name of CONTRACT_NAMES) {
  compiled.set(name, ajv.compile({ $ref: `urn:ai-interviewer:${name}@0.1.0` }) as unknown as CompiledValidator);
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** 校验一个契约对象；错误信息为「路径: 消息」列表。 */
export function validateContract(name: ContractName, data: unknown): ValidationResult {
  const fn = compiled.get(name);
  if (!fn) throw new Error(`未知契约: ${name}`);
  const ok = fn(data);
  const errors = (fn.errors ?? []).map((e) => `${e.instancePath || '(root)'}: ${e.message ?? '校验失败'}`);
  return { ok, errors };
}

export { CONTRACT_VERSION } from './version.js';
