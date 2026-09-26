/**
 * 独立运行的契约校验 CLI：
 *   node dist/src/contracts/validate-cli.js <file.json> <contract-name> [contract-version]
 *
 * 第三个参数省略时按**数据自报的 contractVersion** 校验（无法识别则回落当前版本）——
 * 这样 T1 期证据（0.1.0）与 T2 期对象（0.2.0）用同一条命令都能校验。
 */
import { readFileSync } from 'node:fs';
import { validateContract, validateContractAt, validateContractAuto } from './validate.js';
import { CONTRACT_NAMES, CONTRACT_VERSION, SUPPORTED_CONTRACT_VERSIONS, type ContractVersion } from './version.js';

const [file, name, versionArg] = process.argv.slice(2);
if (!file || !name) {
  console.error(`用法: node dist/src/contracts/validate-cli.js <file.json> <${CONTRACT_NAMES.join('|')}> [${SUPPORTED_CONTRACT_VERSIONS.join('|')}]`);
  process.exit(2);
}
if (versionArg && !(SUPPORTED_CONTRACT_VERSIONS as readonly string[]).includes(versionArg)) {
  console.error(`不支持的契约版本: ${versionArg}（可选: ${SUPPORTED_CONTRACT_VERSIONS.join(', ')}）`);
  process.exit(2);
}
if (!CONTRACT_NAMES.includes(name as (typeof CONTRACT_NAMES)[number])) {
  console.error(`未知契约名: ${name}（可选: ${CONTRACT_NAMES.join(', ')}）`);
  process.exit(2);
}

let data: unknown;
try {
  data = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`JSON 解析失败: ${file}: ${(e as Error).message}`);
  process.exit(2);
}

const contractName = name as (typeof CONTRACT_NAMES)[number];
const result = versionArg
  ? { ...validateContractAt(contractName, versionArg as ContractVersion, data), claimedVersion: versionArg, usedVersion: versionArg as ContractVersion, rejected: undefined }
  : validateContractAuto(contractName, data);
void CONTRACT_VERSION;
if (result.rejected === 'unrecognized_contract_version') {
  console.error(`REJECT ${name} ${file}：contractVersion 无法识别（自报 ${JSON.stringify(result.claimedVersion)}，支持 ${SUPPORTED_CONTRACT_VERSIONS.join('/')}）`);
  process.exit(1);
}
if (result.ok) {
  console.log(`PASS ${name} ${file} (contract@${result.usedVersion}${result.claimedVersion !== result.usedVersion ? `, 显式指定` : ''})`);
  process.exit(0);
} else {
  console.error(`FAIL ${name} ${file} (contract@${result.usedVersion})`);
  for (const err of result.errors) console.error(`  - ${err}`);
  process.exit(1);
}
