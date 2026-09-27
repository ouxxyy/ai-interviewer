/**
 * 网页入口服务的命令行入口。
 *
 *   node dist/src/web/cli.js serve [--port 8918] [--data-dir data/web]
 *   node dist/src/web/cli.js migrate [--data-dir ...]
 *   node dist/src/web/cli.js info
 *
 * 凭证：显式从项目根 `.env` 读取（不依赖 shell 是否加载 zshrc），只判断存在性，不打印值。
 * 启动打印的三件事（PM §5）：数据落在哪、什么内容会发给云模型、怎么停与怎么删。
 */
import path from 'node:path';
import process from 'node:process';
import { credentialStatus, loadDotEnv, requireCredential } from '../t1r/env.js';
import { InterviewDb } from './db.js';
import { DISCLOSURE, DISCLOSURE_VERSION } from './disclosure.js';
import { AppError } from './errors.js';
import { Logger } from './log.js';
import { SessionManager } from './manager.js';
import { SERVER_DEFAULTS, dataRoot, realtimeModelOverride, webPaths, webStaticRoot } from './paths.js';
import { createServer } from './server.js';
import { SettingsStore } from './settings.js';
import { Store } from './store.js';
import { DashscopeTextClient } from '../clients/dashscope.js';
import type { TextLlmClient } from '../clients/types.js';
import type { RealtimeBridge } from './realtime-bridge.js';

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.set(key, next);
      i++;
    } else out.set(key, 'true');
  }
  return out;
}

export interface ServeOptions {
  port?: number;
  dataDir?: string;
  staticDir?: string;
  logger?: Logger;
  /** 测试用：注入自定义文本客户端与实时桥工厂。 */
  textClient?: TextLlmClient;
  createBridge?: (sid: string) => RealtimeBridge;
}

export async function startServer(opts: ServeOptions = {}): Promise<{
  url: string;
  manager: SessionManager;
  store: Store;
  settings: SettingsStore;
  logger: Logger;
  db: InterviewDb;
  close(): Promise<void>;
}> {
  const logger = opts.logger ?? new Logger();
  const paths = webPaths(opts.dataDir ?? dataRoot());
  const db = new InterviewDb(paths.dbFile);
  const migration = db.migrate();
  logger.info('db.ready', { file: paths.dbFile, version: migration.version, applied: migration.applied });
  const store = new Store(db, paths);
  const settings = new SettingsStore(db);
  const credential = process.env.DASHSCOPE_API_KEY ?? '';
  // 默认走百炼（D10：只有默认配置承诺评审质量）；自定义 OpenAI 兼容端点属高级设置。
  const textClient =
    opts.textClient ??
    new DashscopeTextClient({
      ...(process.env.DASHSCOPE_BASE_URL === undefined ? {} : { baseUrl: process.env.DASHSCOPE_BASE_URL }),
      ...(process.env.AI_INTERVIEWER_TEXT_MODEL === undefined ? {} : { model: process.env.AI_INTERVIEWER_TEXT_MODEL }),
    });
  const realtimeModel = realtimeModelOverride();
  const manager = new SessionManager({
    store,
    logger,
    credential,
    textClient,
    paths,
    ...(realtimeModel === undefined ? {} : { realtimeModel }),
    ...(opts.createBridge === undefined ? {} : { createBridge: opts.createBridge }),
  });
  const port = opts.port ?? Number(process.env.AI_INTERVIEWER_PORT ?? SERVER_DEFAULTS.port);
  const running = createServer({ manager, store, settings, logger, paths, staticDir: opts.staticDir ?? webStaticRoot(), port, host: SERVER_DEFAULTS.host });
  await new Promise<void>((resolve, reject) => {
    running.server.once('error', reject);
    running.server.listen(port, SERVER_DEFAULTS.host, () => resolve());
  });
  return {
    url: running.url,
    manager,
    store,
    settings,
    logger,
    db,
    close: async () => {
      manager.closeAll();
      await running.close();
      db.close();
    },
  };
}

function printStartupBanner(url: string, paths: ReturnType<typeof webPaths>, settings: SettingsStore): void {
  const current = settings.get();
  const credential = credentialStatus();
  const lines = [
    `AI 面试官本地服务已启动：${url}`,
    `只监听回环地址（127.0.0.1），同网段其它设备访问不到。`,
    ``,
    `【数据放在哪】${path.relative(process.cwd(), paths.root)}/`,
    `  · 历史库：${path.relative(process.cwd(), paths.dbFile)}`,
    `  · 录音：${path.relative(process.cwd(), paths.audioDir)}/<会话 id>/turn-<轮次>-user.wav｜-interviewer.wav`,
    `  · 上传解析 PDF／DOCX 的临时文件：${path.relative(process.cwd(), paths.uploadTmpDir)}/（解析完即删）`,
    ``,
    `【哪些内容发给云模型】`,
    ...DISCLOSURE.sentToCloud.map((s) => `  · ${s}`),
    ``,
    `【开关】保存历史＝${current.saveHistory ? '开' : '关'}；保存录音＝${current.saveAudio ? '开' : '关'}（两个独立开关，改设置接口：PATCH /api/settings）`,
    `【告知版本】${DISCLOSURE_VERSION}（已确认：${current.disclosureAckVersion ?? '否'}）`,
    `【凭证】${credential.key} 存在＝${credential.present ? '是' : '否'}（值不打印，也不进浏览器与日志）`,
    ``,
    `【怎么停】Ctrl+C（或 kill 本进程）`,
    `【怎么删】按会话：DELETE /api/sessions/<id>（返回删除前后对照）；整库：停服后删掉上面那个数据目录`,
    `【验收用最小客户端】${url}/harness（不是产品界面：方案 C 已选定，正式前端尚未构建）`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'serve';
  const flags = parseArgs(argv.slice(1));
  const env = loadDotEnv();
  const logger = new Logger();

  if (cmd === 'info') {
    const paths = webPaths(flags.get('data-dir') ?? dataRoot());
    const db = new InterviewDb(paths.dbFile);
    const migration = db.migrate();
    process.stdout.write(
      JSON.stringify(
        {
          dataRoot: paths.root,
          dbFile: paths.dbFile,
          migration: { version: migration.version, applied: migration.applied },
          envFile: { path: env.path, present: env.filePresent, injectedKeys: env.injectedKeys.map((k) => k.split('(')[0]), emptyKeys: env.emptyKeys },
          credential: credentialStatus(),
          settings: new SettingsStore(db).get(),
        },
        null,
        2,
      ) + '\n',
    );
    db.close();
    return;
  }

  if (cmd !== 'serve') {
    process.stdout.write(`用法：node dist/src/web/cli.js serve|migrate|info [--port 8918] [--data-dir data/web]\n`);
    process.exitCode = 2;
    return;
  }

  const portFlag = flags.get('port');
  const port = portFlag === undefined ? Number(process.env.AI_INTERVIEWER_PORT ?? SERVER_DEFAULTS.port) : Number(portFlag);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError('E_VALIDATION', `端口不合法：${String(portFlag)}`);
  // 凭证缺失不阻塞启动（可以先把界面与本地数据层跑起来），但实时语音会明确报缺凭证。
  if (credentialStatus().present) requireCredential();
  const started = await startServer({ port, ...(flags.get('data-dir') === undefined ? {} : { dataDir: flags.get('data-dir')! }), logger });
  printStartupBanner(started.url, webPaths(flags.get('data-dir') ?? dataRoot()), started.settings);
  const shutdown = async (): Promise<void> => {
    logger.info('server.shutdown', {});
    await started.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

const isMain = process.argv[1] !== undefined && /cli\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`[fatal] ${(e as Error).message}\n`);
    process.exit(1);
  });
}
