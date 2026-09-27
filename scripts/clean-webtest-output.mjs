import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webtestDir = path.join(root, 'dist', 'webtest');
const legacyTestDir = path.join(root, 'dist', 'test');

// webtest 现在有独立输出根；同时精确清理旧配置曾写进主测试目录的同名生成物。
rmSync(webtestDir, { recursive: true, force: true });
if (existsSync(legacyTestDir)) {
  for (const name of readdirSync(legacyTestDir)) {
    if (/^web-client-.*\.test\.js(?:\.map)?$/.test(name)) {
      rmSync(path.join(legacyTestDir, name), { force: true });
    }
  }
}
