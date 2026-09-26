/**
 * 契约校验器：加载五个 JSON Schema 并编译，可被单测与 CLI 共用。
 *
 * T2 起**同时注册两个契约版本**：现行 `0.2.0` 与 T1 期证据记录过的 `0.1.0`
 * （原样留档在 `schemas/v0.1.0/`）。这样升版不会让历史证据变成不可校验——
 * 「证据可复核」优先于「只留一份 schema」的整洁。
 */
import { Ajv } from 'ajv';
import candidateMaterialsSchema from './schemas/candidate-materials.schema.json' with { type: 'json' };
import questionPlanSchema from './schemas/question-plan.schema.json' with { type: 'json' };
import turnSchema from './schemas/turn.schema.json' with { type: 'json' };
import feedbackSchema from './schemas/feedback.schema.json' with { type: 'json' };
import sessionReportSchema from './schemas/session-report.schema.json' with { type: 'json' };
import candidateMaterialsLegacy from './schemas/v0.1.0/candidate-materials.schema.json' with { type: 'json' };
import questionPlanLegacy from './schemas/v0.1.0/question-plan.schema.json' with { type: 'json' };
import turnLegacy from './schemas/v0.1.0/turn.schema.json' with { type: 'json' };
import feedbackLegacy from './schemas/v0.1.0/feedback.schema.json' with { type: 'json' };
import sessionReportLegacy from './schemas/v0.1.0/session-report.schema.json' with { type: 'json' };
import { CONTRACT_NAMES, CONTRACT_VERSION, SUPPORTED_CONTRACT_VERSIONS, type ContractName, type ContractVersion } from './version.js';

type SchemaMap = Record<ContractName, object>;

const SCHEMAS_BY_VERSION: Record<ContractVersion, SchemaMap> = {
  '0.2.0': {
    'candidate-materials': candidateMaterialsSchema as object,
    'question-plan': questionPlanSchema as object,
    turn: turnSchema as object,
    feedback: feedbackSchema as object,
    'session-report': sessionReportSchema as object,
  },
  '0.1.0': {
    'candidate-materials': candidateMaterialsLegacy as object,
    'question-plan': questionPlanLegacy as object,
    turn: turnLegacy as object,
    feedback: feedbackLegacy as object,
    'session-report': sessionReportLegacy as object,
  },
};

/** 归一化后比较两份 schema：只允许版本号字符串不同。返回差异描述（无差异返回 null）。 */
function structuralDiff(a: unknown, b: unknown): string | null {
  const VERSIONS = ['0.2.0', '0.1.0'];
  const norm = (v: unknown): unknown => {
    if (typeof v === 'string') {
      // 同时归一 `@0.2.0` 这种带前缀的 $ref/$id，和 `"0.2.0"` 这种裸版本号（contractVersion.enum）。
      let out = v;
      for (const ver of VERSIONS) out = out.split(`@${ver}`).join('@V').split(ver).join('V');
      return out;
    }
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, norm(val)]));
    }
    return v;
  };
  const na = JSON.stringify(norm(a));
  const nb = JSON.stringify(norm(b));
  return na === nb ? null : `${na.slice(0, 200)} ≠ ${nb.slice(0, 200)}`;
}

/**
 * 加载时自检：0.1.0 与 0.2.0 必须**只差版本号**。
 * 这一条把「升版没有偷偷改结构」变成机器可验证的事实，而不是口头声明。
 */
export function assertLegacyMatchesCurrent(): void {
  for (const name of CONTRACT_NAMES) {
    const diff = structuralDiff(SCHEMAS_BY_VERSION[CONTRACT_VERSION][name], SCHEMAS_BY_VERSION['0.1.0'][name]);
    if (diff !== null) throw new Error(`契约 ${name}：0.2.0 与 0.1.0 结构不一致（应只差版本号）：${diff}`);
  }
}
assertLegacyMatchesCurrent();

const ajv = new Ajv({ allErrors: true, strict: true });
for (const version of SUPPORTED_CONTRACT_VERSIONS) {
  for (const name of CONTRACT_NAMES) ajv.addSchema(SCHEMAS_BY_VERSION[version][name]);
}

interface CompiledValidator {
  (data: unknown): boolean;
  errors?: Array<{ instancePath?: string; message?: string }>;
}

const compiled = new Map<string, CompiledValidator>();
for (const version of SUPPORTED_CONTRACT_VERSIONS) {
  for (const name of CONTRACT_NAMES) {
    compiled.set(`${version}|${name}`, ajv.compile({ $ref: `urn:ai-interviewer:${name}@${version}` }) as unknown as CompiledValidator);
  }
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function run(name: ContractName, version: ContractVersion, data: unknown): ValidationResult {
  const fn = compiled.get(`${version}|${name}`);
  if (!fn) throw new Error(`未知契约: ${name}@${version}`);
  const ok = fn(data);
  const errors = (fn.errors ?? []).map((e) => `${e.instancePath || '(root)'}: ${e.message ?? '校验失败'}`);
  return { ok, errors };
}

/** 按**当前**契约版本校验（写入新对象时用这个）。 */
export function validateContract(name: ContractName, data: unknown): ValidationResult {
  return run(name, CONTRACT_VERSION, data);
}

/** 按**指定**版本校验（复核历史证据时用这个）。 */
export function validateContractAt(name: ContractName, version: ContractVersion, data: unknown): ValidationResult {
  return run(name, version, data);
}

export interface AutoValidationResult extends ValidationResult {
  /** 数据自报的 contractVersion（原样回传，未做任何归一化；缺失/非字符串为 null）。 */
  claimedVersion: string | null;
  /** 实际用来校验的版本；被拒绝时为 null。 */
  usedVersion: ContractVersion | null;
  /** 非空表示**没有**执行校验，直接拒绝。 */
  rejected?: 'unrecognized_contract_version';
}

/**
 * 按数据自报的 `contractVersion` 校验（复核历史证据用）。
 *
 * **fail-closed**（F6）：自报版本认不出来就**拒绝**，不静默回落到当前版本。
 * 回落看似无害——今天两个版本只差版本号——但哪天某个版本放松了约束（加枚举值、去 required），
 * 回落就意味着「被篡改过版本号的数据会在最松的那版下通过」。认不出就明确拒绝，
 * 并把 claimed / used 都摆出来，调用方分得清「声明了 0.2.0」和「声明了一串垃圾」。
 */
export function validateContractAuto(name: ContractName, data: unknown): AutoValidationResult {
  const raw = (data as { contractVersion?: unknown } | null)?.contractVersion;
  const claimedVersion = typeof raw === 'string' ? raw : null;
  if (claimedVersion === null || !(SUPPORTED_CONTRACT_VERSIONS as readonly string[]).includes(claimedVersion)) {
    return { ok: false, errors: [], claimedVersion, usedVersion: null, rejected: 'unrecognized_contract_version' };
  }
  const usedVersion = claimedVersion as ContractVersion;
  return { ...run(name, usedVersion, data), claimedVersion, usedVersion };
}

export { CONTRACT_VERSION, SUPPORTED_CONTRACT_VERSIONS } from './version.js';
export type { ContractVersion } from './version.js';
