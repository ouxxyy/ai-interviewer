/** 免费的正式网页验收：真实 Chrome/麦克风 API + 本地模型替身，不读取项目凭证。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer } from '../dist/src/web/cli.js';
import { Logger } from '../dist/src/web/log.js';
import { RealtimeBridge } from '../dist/src/web/realtime-bridge.js';
import { DEMO_MATERIALS } from '../dist/src/web/materials.js';
import { MockRealtimeClient, ScriptedTextClient } from '../dist/test/helpers/web-mocks.js';
import { validateContract } from '../dist/src/contracts/validate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewRecovery = process.argv.includes('--review-recovery');
const output = path.join(root, 'evidence', 'upgrade-v0.3', reviewRecovery ? 'review-recovery' : 'plan-source-fix', 'browser-smoke');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const runtimeErrors = [];
const browserLogs = [];
let browserVersion = '';

function check(name, condition, detail = '') {
  checks.push({ name, pass: Boolean(condition), detail });
  assert.ok(condition, name + ': ' + detail);
}
async function waitFor(fn, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(120);
  }
  throw new Error('等待超时：' + label);
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** 真正的本地HTTP/WS反代保留响应CSP与地址空间，不通过CDP伪造文档响应。 */
async function cspProxy(targetUrl) {
  const target = new URL(targetUrl);
  const sockets = new Set();
  const headersFor = request => ({ ...request.headers, host: target.host, ...(request.headers.origin ? { origin: target.origin } : {}) });
  const server = createServer((request, response) => {
    const upstream = httpRequest(new URL(request.url, target), { method: request.method, headers: headersFor(request) }, incoming => {
      response.writeHead(incoming.statusCode, { ...incoming.headers, 'Content-Security-Policy': csp });
      incoming.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    const upstream = createConnection({ host: target.hostname, port: Number(target.port) });
    sockets.add(upstream);
    upstream.on('close', () => { sockets.delete(upstream); socket.destroy(); });
    socket.on('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    upstream.on('connect', () => {
      const headers = Object.entries(headersFor(request)).map(([key, value]) => key + ': ' + (Array.isArray(value) ? value.join(', ') : value)).join('\r\n');
      upstream.write('GET ' + request.url + ' HTTP/1.1\r\n' + headers + '\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + server.address().port, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

class Cdp {
  id = 0;
  pending = new Map();
  constructor(ws) {
    this.ws = ws;
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        runtimeErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      } else if (message.method === 'Log.entryAdded') {
        browserLogs.push({ source: message.params.entry.source, level: message.params.entry.level, text: message.params.entry.text });
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
      this.pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async click(label) {
    await waitFor(() => this.eval(`Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)`), '按钮 ' + label);
    await this.eval(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled).click()`);
  }
  async screenshot(name, full = false) {
    const metrics = await this.send('Page.getLayoutMetrics');
    const size = metrics.cssContentSize ?? metrics.contentSize;
    const image = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(full ? { clip: { x: 0, y: 0, width: size.width, height: Math.min(size.height, 7000), scale: 1 } } : {}) });
    writeFileSync(path.join(output, name), Buffer.from(image.data, 'base64'));
  }
  close() { this.ws.close(); }
}

async function main() {
  mkdirSync(output, { recursive: true });
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'ai-introduction-smoke-'));
  const transcripts = [
    '我希望应聘内容运营岗位，最相关的经历是毕业季征稿活动。我负责主题调研、院系渠道沟通和冷启动范文，收到一百四十三篇投稿。这让我积累了理解读者需求和协调内容渠道的经验。',
    '我是一名应届生，希望做内容运营。我在毕业季征稿里先收集同学偏好，再选择主题、协调五个院系渠道并写冷启动范文，最终收到一百四十三篇投稿。我的优势是能把读者需求转为内容动作，并说明自己的责任和结果边界。',
    '在征稿活动里，我个人负责问卷设计、主题选择和范文撰写。我先收集两百份偏好，再联系五个院系的宣传委员，逐个确认渠道安排，活动最终收到一百四十三篇投稿。团队其他同学负责审核，不属于我的个人贡献。',
    '我个人的动作是设计问卷、谈院系渠道并写两篇范文，审核由其他同学承担。我根据反馈改了主题和提醒方式，最后收到一百四十三篇投稿。下一次会先固定统计口径，以便说明这些动作分别产生什么影响。',
    '渠道扩散的困难是宣传委员只发一次通知。我先了解他们的顾虑，再为各院系给选题建议和提醒模板。我选择增加二次触达而不是购买流量，参与院系后来增加，但不能把全部增长归因给我。',
    '我用有效投稿数与参与院系数观察结果，先统一投稿标准和统计时点。复盘时发现前期标准变化导致返工，后来整理活动 SOP。流程减少返工的趋势可观察，具体节省多少时间目前还没有数字。',
  ];
  const text = new ScriptedTextClient({ reportPriority: null, planSourceIds: true });
  if (reviewRecovery) {
    const complete = text.complete.bind(text);
    text.complete = async req => {
      const response = await complete(req);
      if (!req.prompt.includes('你是独立文本评审器')) return response;
      const feedback = JSON.parse(response.text);
      if (text.counts.review <= 2) delete feedback.nextFacts;
      // 第三次起仅缺坐标，内容仍是模型替身所给原话，须由应用重定位后通过。
      else for (const d of Object.values(feedback.dimensions)) if (d.quote) {
        delete d.quote.start; delete d.quote.end; delete d.quote.matchType;
      }
      return { ...response, text: JSON.stringify(feedback) };
    };
  }
  const quiet = new Logger(() => {}, 'error');
  let app, proxy, chrome, cdp;
  let report = null, analytics = [], failure = null, failureDetails = null;
  try {
    app = await startServer({ port: await freePort(), dataDir: path.join(temporary, 'data'), publicMode: false, logger: quiet, textClient: text,
      credentialFile: path.join(temporary, '.env'), credentialEnv: { DASHSCOPE_API_KEY: 'offline-fixture-not-a-real-key' },
      createBridge: () => new RealtimeBridge({ credential: 'offline-fixture-not-a-real-key', logger: quiet, createClient: () => new MockRealtimeClient({ transcripts, audioChunks: 2, chunkDelayMs: 5 }) }),
    });
    async function api(method, route, body) {
      const response = await fetch(app.url + route, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      const value = await response.json();
      if (!response.ok) throw new Error('API ' + route + ' ' + JSON.stringify(value));
      return value;
    }
    await api('PATCH', '/api/settings', { disclosureAck: true, answerStartMode: 'manual', saveAudio: false });
    proxy = await cspProxy(app.url);
    const cdpPort = await freePort();
    chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + path.join(temporary, 'chrome'), '--no-first-run', '--no-default-browser-check', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
    await waitFor(async () => { try { const version = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/version')).json(); browserVersion = version.Browser; return Boolean(browserVersion); } catch { return false; } }, 'Chrome');
    const targets = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json();
    const ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__localAnalytics=[]; window.oubaAnalytics={track:(name,data)=>window.__localAnalytics.push({name,data})};" });
    await cdp.send('Page.navigate', { url: proxy.url });
    await waitFor(() => cdp.eval("Boolean(document.getElementById('job-description'))"), '正式首页');
    check('首页展示自我介绍与三经历题', await cdp.eval("document.body.innerText.includes('自我介绍')"));
    const materials = { jd: DEMO_MATERIALS.jd, experience: DEMO_MATERIALS.experience, targetRole: DEMO_MATERIALS.targetRole };
    await cdp.eval(`(() => { const values=${JSON.stringify(materials)}; for (const [id,value] of [['target-role',values.targetRole],['job-description',values.jd],['experience',values.experience]]) { const element=document.getElementById(id); const proto=element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(element,value); element.dispatchEvent(new Event('input',{bubbles:true})); } document.querySelector('input[name="stage"][value="应届"]').click(); })()`);
    await cdp.click('开始这一场');
    await waitFor(() => cdp.eval("location.pathname.startsWith('/session/') && document.body.innerText.includes('自我介绍')"), '介绍页面');
    const sid = await cdp.eval("decodeURIComponent(location.pathname.split('/').at(-1))");
    const snapshot = async () => (await api('GET', '/api/sessions/' + sid + '/snapshot')).snapshot;
    await waitFor(async () => { const current = await snapshot(); return current.plan?.questions.length === 4 && current.state === 'answer'; }, '四环节计划与介绍提问完成');
    const plan = (await snapshot()).plan;
    check('计划固定四环节且题型正确', plan.questions.length === 4 && plan.questions[0].kind === 'introduction' && plan.questions.slice(1).every(item => item.kind === 'experience'));
    check('来源编号出题只调用一次且全部回填原文', text.counts.plan === 1 && validateContract('question-plan', plan).ok && plan.questions.every(q => !('sourceId' in q) && (materials.jd.includes(q.sourceExcerpt) || materials.experience.includes(q.sourceExcerpt))));
    await cdp.screenshot('introduction.png');
    async function answer(id) {
      const bytesBefore = (await snapshot()).usage.inputAudioBytes;
      await cdp.click('开始作答');
      await waitFor(async () => (await snapshot()).usage.inputAudioBytes > bytesBefore, '本轮麦克风PCM上行');
      await delay(300);
      if (id === 'q1' && !checks.some(item => item.name === '暂停恢复不会显示无采集的说完了')) {
        await cdp.click('暂停');
        await cdp.click('恢复');
        check('暂停恢复不会显示无采集的说完了', await cdp.eval("!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='说完了')"));
        const resumedBefore = (await snapshot()).usage.inputAudioBytes;
        await cdp.click('开始作答');
        await waitFor(async () => (await snapshot()).usage.inputAudioBytes > resumedBefore, '显式恢复麦克风采集');
      }
      await cdp.click('说完了');
      await waitFor(async () => { const current = await snapshot(); return current.state === 'rewrite' && Boolean(current.reviews[id]); }, id + ' 点评');
      check(id + ' 点评引文过契约', validateContract('feedback', (await snapshot()).reviews[id]).ok);
    }
    await answer('q1');
    if (reviewRecovery) {
      const failed = await snapshot();
      await waitFor(() => cdp.eval("document.body.innerText.includes('点评格式未通过检查')"), '字段失败说明');
      check('降级明确显示失败且不显示占位建议或点评就绪', await cdp.eval("!document.body.innerText.includes('无新增事实要求') && !document.body.innerText.includes('点评已就绪') && document.body.innerText.includes('无需重新录音')"));
      check('两次失败保存具体字段诊断且未计完成', failed.machine.completed === 0 && failed.reviewMeta.at(-1).attemptLog.length === 2 && failed.reviewMeta.at(-1).attemptLog.every(a => a.issues.some(i => i.path === '/nextFacts' && i.rule === 'required')));
      await cdp.screenshot('review-failed.png');
      const beforeTurns = JSON.stringify(failed.turns);
      const beforeAudio = failed.usage.inputAudioBytes;
      await cdp.click('重新评审');
      await waitFor(async () => { const s = await snapshot(); return s.state === 'rewrite' && s.reviewMeta.at(-1)?.kind === 'ok'; }, '原回答重试成功');
      const recovered = await snapshot();
      check('重新评审不重录、不加轮次、不消耗重答', JSON.stringify(recovered.turns) === beforeTurns && recovered.usage.inputAudioBytes === beforeAudio && !recovered.machine.rewriteUsed);
      check('坐标漏填经应用回填一次成功且完成数只加一', recovered.machine.completed === 1 && text.counts.review === 3 && recovered.reviewMeta.at(-1).attempts === 1 && validateContract('feedback', recovered.reviews.q1).ok);
      await waitFor(() => cdp.eval("document.body.innerText.includes('即时点评') && !document.querySelector('[aria-label=\"评审未完成\"]')"), '恢复正常点评');
      await cdp.screenshot('review-recovered.png');
    }
    check('点评后尚未下一环节也计为完成', (await snapshot()).machine.completed === 1);
    await cdp.click('重答一次');
    await answer('q1');
    check('介绍重答不重复计数', (await snapshot()).machine.completed === 1);
    await cdp.click('进入经历题');
    await answer('q2');
    await cdp.click('重答一次');
    await answer('q2');
    for (const id of ['q3', 'q4']) {
      await cdp.click('下一题');
      await answer(id);
    }
    check('最后点评后完成四环节', (await snapshot()).machine.completed === 4);
    await cdp.click('查看报告');
    await waitFor(() => cdp.eval("location.pathname.startsWith('/report/') && document.body.innerText.includes('自我介绍')"), '正式报告');
    const detail = await api('GET', '/api/sessions/' + sid);
    report = detail.report;
    if (reviewRecovery) check('恢复成功后报告不再标记部分题降级', await cdp.eval("!document.body.innerText.includes('部分题为降级评审')"));
    check('报告通过当前契约且四环节完成', validateContract('session-report', report).ok && report.sessionStatus === 'completed' && report.completedQuestions === 4);
    check('报告介绍与经历计数分开', await cdp.eval("Array.from(document.body.innerText).filter(c=>c.trim()!=='').join('').includes('经历题3/3')"));
    check('介绍和经历两份重答都保留', report.perQuestion.filter(item => item.rewriteDelta !== null).length === 2 && await cdp.eval("document.querySelectorAll('.compare-grid').length === 2"));
    await cdp.screenshot('report.png', true);
    analytics = await cdp.eval('window.__localAnalytics');
    check('四个业务事件各发送一次', ['practice_requested', 'practice_started', 'practice_ended', 'practice_completed'].every(name => analytics.filter(event => event.name === name).length === 1), JSON.stringify(analytics));
    check('新统计为版本2、四环节口径且无业务正文', analytics.every(event => event.data?.schema_version === 2 && Object.keys(event.data ?? {}).every(key => ['schema_version','completed_questions','total_questions'].includes(key))) && analytics.find(event => event.name === 'practice_completed')?.data.total_questions === 4, JSON.stringify(analytics));
    // 独立短场次：介绍尚未作答时提前结束，不能伪报全场完成。
    const early = await api('POST', '/api/sessions', { synthetic: false });
    await api('POST', '/api/sessions/' + early.sid + '/materials', { ...materials, stage: '应届' });
    await cdp.send('Page.navigate', { url: proxy.url + '/session/' + early.sid });
    await waitFor(() => cdp.eval("Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='结束本场' && !b.disabled)"), '正常介绍提前结束按钮');
    await cdp.click('结束本场');
    await waitFor(() => cdp.eval("location.pathname.startsWith('/report/') && document.body.innerText.includes('未完成')"), '提前结束报告');
    const earlyReport = (await api('GET', '/api/sessions/' + early.sid)).report;
    check('介绍阶段提前结束保留合法零完成报告', validateContract('session-report', earlyReport).ok && earlyReport.completedQuestions === 0 && earlyReport.sessionStatus === 'ended_early');
    const earlyEvents = await cdp.eval('window.__localAnalytics');
    check('提前结束只计结束、不会计全部完成', earlyEvents.filter(event => event.name === 'practice_ended').length === 1 && !earlyEvents.some(event => event.name === 'practice_completed'), JSON.stringify(earlyEvents));
    await cdp.screenshot('ended-early.png');
    await cdp.send('Page.navigate', { url: proxy.url + '/report/' + sid });
    await waitFor(() => cdp.eval("document.body.innerText.includes('本场复盘')"), '旧报告重新打开');
    check('直接重新打开旧报告不补报转化', (await cdp.eval('window.__localAnalytics')).length === 0);
    check('正式页面没有运行时异常', runtimeErrors.length === 0, runtimeErrors.join('\n'));
    console.log('PASS: ' + checks.length + ' browser checks; real Chrome + mock models; paidCalls=0');
  } catch (error) {
    failure = error.message;
    if (cdp) failureDetails = await cdp.eval('({path:location.pathname,text:document.body.innerText})').catch(() => null);
    if (cdp) await cdp.screenshot('failure.png').catch(() => {});
    throw error;
  } finally {
    writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ ranAt: new Date().toISOString(), browserVersion, scope: '正式生产构建网页；真实Chrome与fake音频设备；模型/ASR均为本地替身；真实本地HTTP/WS反代施加原生产CSP，浏览器安全检查保持开启；事件只收集在本地内存，未发往统计服务。', testDataNote: '材料和转写均为合成案例；临时场次仅为测试本地事件观察器而使用非演示标记，测试结束删除隔离临时数据，不代表真实用户或线上转化。', paidCalls: 0, realMicrophoneVerified: false, realModelVerified: false, pass: failure === null && checks.length > 0 && checks.every(check => check.pass), failure, failureDetails, modelRequests: text.counts, checks, analytics, runtimeErrors, browserLogs, report }, null, 2) + '\n');
    cdp?.close();
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise(resolve => chrome.once('exit', resolve));
      chrome.kill();
      await Promise.race([exited, delay(3000)]);
      if (chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill('SIGKILL');
        await Promise.race([exited, delay(1000)]);
      }
    }
    await app?.close();
    await proxy?.close();
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
