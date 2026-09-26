/** 独立运行的契约校验 CLI：node dist/src/contracts/validate-cli.js <file.json> <contract-name> */
import { readFileSync } from 'node:fs';
import { validateContract } from './validate.js';
import { CONTRACT_NAMES, CONTRACT_VERSION } from './version.js';

const [file, name] = process.argv.slice(2);
if (!file || !name) {
  console.error(`用法: node dist/src/contracts/validate-cli.js <file.json> <${CONTRACT_NAMES.join('|')}>`);
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

const result = validateContract(name as (typeof CONTRACT_NAMES)[number], data);
if (result.ok) {
  console.log(`PASS ${name} ${file} (contract@${CONTRACT_VERSION})`);
  process.exit(0);
} else {
  console.error(`FAIL ${name} ${file}`);
  for (const err of result.errors) console.error(`  - ${err}`);
  process.exit(1);
}
