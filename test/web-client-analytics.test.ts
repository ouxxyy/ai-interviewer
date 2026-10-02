import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPracticeObserver, trackEvent } from '../web-client/src/lib/analytics.js';
import type { Snapshot } from '../web-client/src/types.js';

function snapshot(options: { state?: Snapshot['state']; legacy?: boolean; complete?: boolean; synthetic?: boolean } = {}): Snapshot {
  const state = options.state ?? 'answer';
  const count = options.legacy ? 3 : 4;
  const questions = Array.from({ length: count }, (_, index) => ({ id: `q${index + 1}`, text: '', intent: '', sourceExcerpt: '', topics: [], ...(!options.legacy ? { kind: index === 0 ? 'introduction' : 'experience' } : {}) }));
  return {
    sid: 'private-session-id', state, status: state === 'ended' ? 'ended' : state === 'report' ? 'report' : 'active',
    machine: { state, questionIndex: 0, followupCount: 0, rewriteUsed: false, completed: 0 }, synthetic: options.synthetic ?? false,
    toggles: { saveHistory: true, saveAudio: true }, materials: { jd: 'secret-JD', experience: 'secret-answer', stage: '社招', targetRole: 'secret-role' },
    plan: { questions, askedTopics: [] } as Snapshot['plan'], currentQuestion: null, pending: '', lastError: null, halted: false,
    turns: [], reviews: {}, reviewBasis: {}, reviewMeta: [], rewriteDeltas: {}, reportSource: null,
    report: state === 'ended' || state === 'report' ? {
      sessionStatus: options.complete ? 'completed' : 'ended_early', completedQuestions: options.complete ? count : 1, totalQuestions: count,
      perQuestion: questions.map((question, index) => ({ questionId: question.id, ...('kind' in question ? { kind: question.kind } : {}), status: options.complete || index === 0 ? 'reviewed' : 'not_reached', feedback: options.complete || index === 0 ? { questionId: question.id } : null, rewriteDelta: null })) as never,
      priorityPractice: ['secret-feedback'], versions: { ruleVersion: '', realtimeModel: null, textModel: null },
    } : null,
  };
}

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test('匿名埋点v2：answer与question均触发开始，重复快照/刷新不重复计，完整四项才报完成', () => {
  for (const state of ['answer', 'question'] as const) {
    const events: Array<{ name: string; data: unknown }> = [];
    const store = storage();
    const emit = (name: string, data: unknown) => events.push({ name, data });
    const observe = createPracticeObserver(emit, store);
    observe(snapshot({ state }));
    observe(snapshot({ state }));
    const refreshed = createPracticeObserver(emit, store);
    refreshed(snapshot({ state }));
    refreshed(snapshot({ state: 'ended', complete: true }));
    refreshed(snapshot({ state: 'ended', complete: true }));
    assert.deepEqual(events, [
      { name: 'practice_started', data: { schema_version: 2, total_questions: 4 } },
      { name: 'practice_ended', data: { schema_version: 2, completed_questions: 4, total_questions: 4 } },
      { name: 'practice_completed', data: { schema_version: 2, completed_questions: 4, total_questions: 4 } },
    ]);
    const encoded = JSON.stringify(events);
    assert.equal(/secret|private-session-id/.test(encoded), false);
  }
});

test('匿名埋点：旧三题保留schema1，提前结束只报ended，历史报告/synthetic不补报', () => {
  const events: Array<[string, unknown]> = [];
  const observe = createPracticeObserver((name, data) => events.push([name, data]));
  observe(snapshot({ state: 'ended', complete: true }));
  observe(snapshot({ state: 'report', complete: true }));
  observe(snapshot({ state: 'ended', complete: true }));
  assert.deepEqual(events, [], '没有在此页面观察到活跃会话，旧报告不能补报');
  observe(snapshot({ synthetic: true }));
  observe(snapshot({ state: 'ended', complete: true, synthetic: true }));
  assert.deepEqual(events, []);
  observe(snapshot({ legacy: true }));
  observe(snapshot({ state: 'ended', legacy: true }));
  assert.deepEqual(events, [
    ['practice_started', { schema_version: 1, total_questions: 3 }],
    ['practice_ended', { schema_version: 1, completed_questions: 1, total_questions: 3 }],
  ]);
});

test('匿名埋点：无有效计划/未评审四项/异常计数不报成功，存储与统计失败不影响调用', () => {
  const events: string[] = [];
  const observe = createPracticeObserver((name) => { events.push(name); throw new Error('统计失败'); }, { getItem: () => { throw new Error('禁用存储'); }, setItem: () => { throw new Error('存储满'); } });
  assert.doesNotThrow(() => observe({ ...snapshot(), plan: null }));
  assert.equal(events.includes('practice_started'), false);
  const ended = snapshot({ state: 'ended', complete: true });
  ended.report!.perQuestion[3]!.feedback = null;
  assert.doesNotThrow(() => observe(ended));
  assert.equal(events.includes('practice_completed'), false);
});

test('业务层白名单：固定四事件与允许数字，任意业务正文/ID/非法数字均过滤', () => {
  const events: Array<[string, unknown]> = [];
  (globalThis as unknown as Record<string, unknown>).window = { oubaAnalytics: { track: (name: string, data: unknown) => events.push([name, data]) } };
  trackEvent('practice_requested', { schema_version: 2, total_questions: 4, jd: 'secret-JD', sid: 'private-session-id', answer: 'secret-answer', completed_questions: Number.NaN, token: 123, arbitrary: 7 } as never);
  trackEvent('unknown_event' as never, { total_questions: 4 });
  assert.deepEqual(events, [['practice_requested', { schema_version: 2, total_questions: 4 }]]);
});

test('请求事件：同场/刷新去重，synthetic不报告，只有匿名schema版本', () => {
  const events: Array<[string, unknown]> = [];
  const store = storage();
  const emit = (name: string, data: unknown) => events.push([name, data]);
  const observe = createPracticeObserver(emit, store);
  observe.requested('private-id', true);
  observe.requested('private-id');
  observe.requested('private-id');
  createPracticeObserver(emit, store).requested('private-id');
  assert.deepEqual(events, [['practice_requested', { schema_version: 2 }]]);
});

test('统计Promise拒绝也不形成业务异常；全四项未反馈不得报告completed', async () => {
  const events: string[] = [];
  const observe = createPracticeObserver((name) => { events.push(name); return Promise.reject(new Error('异步统计失败')); });
  observe(snapshot());
  const ended = snapshot({ state: 'ended', complete: true });
  ended.report!.perQuestion[3]!.feedback = null;
  assert.doesNotThrow(() => observe(ended));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['practice_started', 'practice_ended']);
});

test('公共统计脚本实际执行：同源代理、匿名URL/referrer/title以及事件过滤', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const scripts: Array<{ src?: string; dataset: Record<string, string> }> = [];
  const sent: Array<[string, unknown]> = [];
  const context = {
    location: { hostname: 'interview.redboook.cn', origin: 'https://interview.redboook.cn', search: '' },
    document: {
      currentScript: { dataset: { websiteId: '4897cfc4-d00f-47b5-b150-07db3748db54', domain: 'interview.redboook.cn', proxy: 'same-origin', title: '欧八面试陪练' } },
      createElement: () => ({ dataset: {} as Record<string, string> }),
      head: { appendChild: (script: { src?: string; dataset: Record<string, string> }) => scripts.push(script) },
    },
    window: {
      umami: { track: (name: string, data: unknown) => sent.push([name, data]) },
      oubaAnalytics: undefined as undefined | { track(name: string, data: unknown): void },
      oubaBeforeSend: undefined as undefined | ((type: string, data: Record<string, unknown>) => unknown),
    },
    URL, URLSearchParams, Date,
  };
  runInNewContext(readFileSync('web-client/public/ouba-analytics.js', 'utf8'), context);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0]?.src, 'https://interview.redboook.cn/ouba-tracker.js');
  assert.equal(scripts[0]?.dataset.hostUrl, 'https://interview.redboook.cn/ouba-metrics');
  assert.equal(scripts[0]?.dataset.websiteId, '4897cfc4-d00f-47b5-b150-07db3748db54');
  context.window.oubaAnalytics?.track('private_unknown_event', { jd: 'secret' });
  assert.equal(sent.length, 0);
  const clean = context.window.oubaBeforeSend?.('event', {
    name: 'practice_completed', title: 'secret-title', url: '/report/private-session-id?jd=secret#secret', referrer: 'https://example.com/private?token=secret',
    data: { schema_version: 2, completed_questions: 4, total_questions: 4, answer: 'secret', session_id: 'private' },
  }) as Record<string, unknown>;
  assert.equal(clean.url, '/report/:id');
  assert.equal(clean.referrer, 'https://example.com');
  assert.equal(clean.title, '欧八面试陪练');
  assert.equal(JSON.stringify(clean).includes('secret'), false);
  assert.equal(JSON.stringify(clean.data), JSON.stringify({ schema_version: 2, completed_questions: 4, total_questions: 4 }));
});
