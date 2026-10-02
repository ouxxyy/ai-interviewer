/**
 * T3 两个纯文字入口的真实调用证据。
 *
 * - `skill:run`：按 Skill 包的流程（材料 → 计划 → 提问 → 追问 → 反馈 → 重答 → 报告）真跑一场，
 *   产出 markdown 报告文件——就是 D8 要求 Skill 在用户工作目录留下的那个文件。
 * - `prompt:run`：把简版 Prompt **整段粘贴**进一次多轮对话（应用辅助文本试验），
 *   走完材料确认、介绍与至少一经历题的两环节闭环，再提前结束生成四项报告。
 *
 * 两者都不产生音频、不声称语音能力；规则正文都来自 `rules@0.3.0` 单源。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DashscopeTextClient } from '../clients/dashscope.js';
import { runReview } from '../review/reviewer.js';
import { hasFeedbackSource } from '../review/feedback-source.js';
import { validateQuestionPlan } from '../contracts/question-plan.js';
import { SessionMachine, type SessionEvent } from '../state/machine.js';
import { validateContract } from '../contracts/validate.js';
import { locateQuote } from '../contracts/quote-locator.js';
import { questionPlanPrompt, followupDecisionPrompt, reviewPrompt, reportPrompt, PROMPT_VERSION } from '../prompts/prompts.js';
import { RULES_VERSION, rulesDigest } from '../rules/rules.js';
import { CONTRACT_VERSION } from '../contracts/version.js';
import type { Feedback, InterviewContext, QuestionKind, QuestionPlan, SessionReport, Stage } from '../contracts/types.js';
import { REPO_ROOT, assertNoSecret } from '../t1r/env.js';
import { EvidenceWriter } from '../t1r/evidence.js';
import { DashscopeReviewChannel, loadCases, type CallRecord } from '../t1r/chain-a.js';
import { extractJson } from '../t1r/json.js';
import { simplePromptMarkdown, versionStamp } from './content.js';
import { validatePromptFeedback, validatePromptReport, type PromptQuoteCheck } from './prompt-validation.js';


export interface TurnLog {
  turn: number;
  step: string;
  /** 该步实际发给模型的提示词（用于复核「规则是不是从单源来的」）。 */
  promptChars: number;
  latencyMs: number;
  tokens: number;
  note?: string;
}

/** 单题闭环的一次真实评审：模型原始输出 → 流水线 → 独立复核引用。 */
async function reviewAnswer(
  client: DashscopeTextClient,
  evidence: EvidenceWriter,
  args: { tag: string; questionId: string; context: InterviewContext; questionText: string; answerText: string; turnIds: string[]; isRewrite?: boolean; firstAnswerText?: string },
): Promise<{ feedback: Feedback; kind: string; attempts: number; calls: CallRecord[]; quoteCheck: { total: number; located: number; failures: string[] }; emittedVersion: string | null }> {
  const prompt = reviewPrompt({
    questionText: args.questionText,
    questionId: args.questionId,
    context: args.context,
    answerText: args.answerText,
    turnIds: args.turnIds,
    textVersion: 'raw',
    isRewrite: args.isRewrite ?? false,
    ...(args.firstAnswerText === undefined ? {} : { firstAnswerText: args.firstAnswerText }),
  });
  const channel = new DashscopeReviewChannel(client, prompt, {
    jsonMode: true,
    enableThinking: false,
    rawSink: (attempt, raw) => evidence.writeText(`skill/raw/${args.tag}.attempt${attempt}.txt`, raw, false),
  });
  const outcome = await runReview({ channel, basisText: args.answerText, turnIds: args.turnIds, textVersion: 'raw', questionId: args.questionId, maxRetries: 2 });
  const fb = outcome.feedback as Feedback;
  const failures: string[] = [];
  let total = 0;
  let located = 0;
  for (const [dim, d] of Object.entries(fb.dimensions)) {
    if (d.level === '无法判断') {
      if (d.quote !== null) failures.push(`${dim}: 无法判断但带引用`);
      continue;
    }
    if (!d.quote) {
      failures.push(`${dim}: 缺少引用`);
      continue;
    }
    total++;
    const loc = locateQuote(args.answerText, d.quote.text);
    if (!loc.located) failures.push(`${dim}: ${loc.reason}`);
    else if (loc.start !== d.quote.start || loc.end !== d.quote.end) failures.push(`${dim}: 区间不符`);
    else located++;
  }
  return {
    feedback: fb,
    kind: outcome.kind,
    attempts: outcome.attempts,
    calls: channel.calls,
    quoteCheck: { total, located, failures },
    emittedVersion: channel.emittedContractVersions[0] ?? null,
  };
}

export interface SkillRunResult {
  caseId: string;
  material: { jd: string; experience: string; stage: string; targetRole: string };
  plan: QuestionPlan;
  planCalls: CallRecord[];
  questions: Array<{
    questionId: string;
    kind: QuestionKind;
    questionText: string;
    firstAnswer: string;
    followup: { need: boolean; question: string | null; reason: string; gap: string } | null;
    followupAnswer: string | null;
    followups: Array<{ question: string; answer: string; reason: string; gap: string }>;
    feedback: Feedback;
    feedbackKind: string;
    attempts: number;
    quoteCheck: { total: number; located: number; failures: string[] };
    rewrite: { answer: string; feedback: Feedback; feedbackKind: string; quoteCheck: { total: number; located: number; failures: string[] }; delta: { added: string[]; corrected: string[]; stillMissing: string[] } } | null;
  }>;
  report: { markdown: string; path: string; raw: SessionReport; source: 'model_priority_practice' | 'derived_from_validated_feedback' | 'fixed_zero_completion' };
  endedEarly: boolean;
  turns: TurnLog[];
  versions: { contract: string; rules: string; prompts: string; rulesDigest: string };
}

function parseJsonOrThrow(raw: string, what: string): unknown {
  const parsed = extractJson(raw);
  if (!parsed.ok) throw new Error(`${what} 输出无法解析为 JSON：${parsed.error}`);
  return parsed.value;
}

/** 把一次真实训练渲染成 D8 要求的 markdown 报告。 */
function renderReport(args: {
  material: SkillRunResult['material'];
  caseId: string;
  questions: SkillRunResult['questions'];
  reportJson: Record<string, unknown>;
  endedEarly: boolean;
  completed: number;
}): string {
  const { material, questions, reportJson, endedEarly, completed } = args;
  const lines: string[] = [];
  lines.push(`# 面试训练报告（${new Date().toISOString().slice(0, 16).replace('T', ' ')}）`);
  lines.push('');
  lines.push(`> 版本戳：${versionStamp()}`);
  lines.push(`> 材料来源：合成案例 \`${args.caseId}\`（synthetic，非真实用户数据）｜ 入口：Skill（纯文字，无录音能力）`);
  lines.push('');
  lines.push('## 一、材料确认记录');
  lines.push('');
  lines.push(`- 目标岗位：${material.targetRole}`);
  lines.push(`- 求职阶段：${material.stage}`);
  lines.push(`- JD（节选）：${material.jd.slice(0, 80)}…`);
  lines.push(`- 经历（节选）：${material.experience.slice(0, 80)}…`);
  lines.push('');
  lines.push('## 二、逐题反馈（介绍单列；经历题汇总只取 experience）');
  lines.push('');
  for (const q of questions) {
    lines.push(`### ${q.questionId}（${q.kind === 'introduction' ? '自我介绍' : '经历题'}）　${q.questionText}`);
    lines.push('');
    lines.push(`**作答**：${q.firstAnswer}`);
    lines.push('');
    for (const [index, followup] of q.followups.entries()) {
      lines.push(`**追问 ${index + 1}**：${followup.question}　理由：${followup.reason}`);
      lines.push(`**追问作答**：${followup.answer}`);
      lines.push('');
    }
    if (!q.followups.length && q.followup) lines.push(`**追问**：未发出，${q.followup.reason}`);
    lines.push(`**初答反馈状态**：${q.feedbackKind === 'ok' ? '正式通过' : '暂无法评价，不计正式完成'}`);
    lines.push('');
    lines.push('| 维度 | 档位 | 引用（连续逐字原话） | 区间 | 判断依据 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const [dim, d] of Object.entries(q.feedback.dimensions)) {
      const quote = d.quote ? `「${d.quote.text}」` : '—';
      const range = d.quote ? `[${d.quote.start}, ${d.quote.end})` : '—';
      lines.push(`| ${dim} | ${d.level} | ${quote} | ${range} | ${d.reason} |`);
    }
    lines.push('');
    lines.push(`- 事实缺口：${q.feedback.factGaps.length > 0 ? q.feedback.factGaps.join('；') : '无'}`);
    lines.push(`- 最值得改的一点：${q.feedback.topImprovement}`);
    lines.push(`- 下一轮应补充：${q.feedback.nextFacts.join('；')}`);
    lines.push(`- 引用自检：${q.quoteCheck.located}/${q.quoteCheck.total} 可定位${q.quoteCheck.failures.length > 0 ? `（异常：${q.quoteCheck.failures.join('; ')}）` : ''}`);
    lines.push('');
    if (q.rewrite) {
      lines.push('**重答对比**');
      lines.push('');
      lines.push(`- 重答：${q.rewrite.answer}`);
      lines.push(`- 新增：${q.rewrite.delta.added.join('；') || '无'}`);
      lines.push(`- 纠正：${q.rewrite.delta.corrected.join('；') || '无'}`);
      lines.push(`- 仍缺失：${q.rewrite.delta.stillMissing.join('；') || '无'}`);
      lines.push(`- 最终重答反馈状态：${q.rewrite.feedbackKind === 'ok' ? '正式通过' : '暂无法评价，不计正式完成'}`);
      lines.push('');
      if (q.rewrite.feedbackKind === 'ok') {
        lines.push('| 重答维度 | 档位 | 最终版引用 | 区间 | 判断依据 |');
        lines.push('| --- | --- | --- | --- | --- |');
        for (const [dim, d] of Object.entries(q.rewrite.feedback.dimensions)) lines.push(`| ${dim} | ${d.level} | ${d.quote ? `「${d.quote.text}」` : '—'} | ${d.quote ? `[${d.quote.start}, ${d.quote.end})` : '—'} | ${d.reason} |`);
        lines.push('');
      }
    } else {
      lines.push('**重答对比**：未重答');
      lines.push('');
    }
  }
  lines.push('## 三、全场优先练习点');
  lines.push('');
  const priority = (reportJson.priorityPractice as string[] | undefined) ?? [];
  for (const p of priority) lines.push(`- ${p}`);
  lines.push('');
  lines.push('## 四、完成情况');
  lines.push('');
  const introduction = (reportJson.perQuestion as SessionReport['perQuestion']).find((q) => q.kind === 'introduction');
  const experienceCompleted = (reportJson.perQuestion as SessionReport['perQuestion']).filter((q) => q.kind === 'experience' && q.status === 'reviewed').length;
  lines.push(`- 介绍状态：${introduction?.status ?? 'not_reached'}`);
  lines.push(`- 经历题 ${experienceCompleted}/3`);
  lines.push(`- 完成 ${completed} 项 / 未完成 ${4 - completed} 项${endedEarly ? '（用户提前结束）' : ''}`);
  if (completed === 0) lines.push('- 本次未完成任何题目，无有效反馈');
  lines.push('');
  lines.push('## 五、能力边界');
  lines.push('');
  lines.push('- 本报告来自**纯文字** Skill 入口：没有录音、没有实时语音、不能回放音频。');
  lines.push('- 不打分、不预测录用结果；所有档位只对本次练习回答而言。');
  return `${lines.join('\n')}\n`;
}

export async function runSkillFlow(client: DashscopeTextClient, evidence: EvidenceWriter, opts: { caseId?: string; endEarly?: boolean } = {}): Promise<SkillRunResult> {
  const c = loadCases().find((x) => x.id === (opts.caseId ?? 'C13'));
  if (!c) throw new Error(`找不到案例 ${opts.caseId ?? 'C13'}`);
  if (c.stage !== '应届' && c.stage !== '社招') throw new Error('案例阶段无效');
  const turns: TurnLog[] = [];
  const material = { jd: c.materials.jd, experience: c.materials.experience, stage: c.stage, targetRole: c.targetRole };
  const machine = new SessionMachine();
  const fire = (event: SessionEvent, reviewValid?: boolean) => {
    const out = machine.fire(event, reviewValid === undefined ? {} : { reviewValid });
    if (!out.accepted) throw new Error(`文字入口状态机拒绝 ${event}：${out.error}`);
  };
  const log = (step: string, prompt: string, calls: CallRecord[], note?: string) => turns.push({ turn: turns.length + 1, step, promptChars: prompt.length, latencyMs: calls.reduce((a, x) => a + x.latencyMs, 0), tokens: calls.reduce((a, x) => a + x.totalTokens, 0), ...(note === undefined ? {} : { note }) });
  const planPrompt = questionPlanPrompt(material);
  const planChannel = new DashscopeReviewChannel(client, planPrompt, { jsonMode: true, enableThinking: false, rawSink: (a, raw) => evidence.writeText(`skill/raw/plan.attempt${a}.txt`, raw, false) });
  let plan: QuestionPlan | null = null;
  let remediation: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await planChannel.call(attempt, remediation);
    const parsed = extractJson(raw);
    const result = parsed.ok ? validateQuestionPlan(parsed.value, material) : { ok: false, errors: [parsed.error] };
    if (result.ok) { plan = parsed.ok ? parsed.value as QuestionPlan : null; break; }
    remediation = result.errors.join('；');
  }
  if (!plan) throw new Error(`QuestionPlan 计划或来源无效：${remediation}`);
  log('问题计划', planPrompt, planChannel.calls);
  fire('MATERIALS_CONFIRMED');
  const questions: SkillRunResult['questions'] = [];
  const active = opts.endEarly === true ? plan.questions.slice(0, 2) : plan.questions;
  let nextTurn = 0;
  for (const q of active) {
    fire('QUESTION_SENT');
    fire('ANSWER_START');
    const context: InterviewContext = { kind: q.kind, jd: material.jd, stage: material.stage as Stage, targetRole: material.targetRole, intent: q.intent };
    // 明确的合成作答：复用既有样例事实，不添加未核实数字或材料之外的成就。
    const firstAnswer = q.kind === 'introduction' ? `我希望应聘${material.targetRole}。我用一段相关经历说明自己的动作和收获：${c.firstAnswer}` : c.firstAnswer;
    const answerTurnId = `t${++nextTurn}`;
    let basis = firstAnswer;
    let lastFollowup: SkillRunResult['questions'][number]['followup'] = null;
    const followupAnswers: string[] = [];
    const followups: SkillRunResult['questions'][number]['followups'] = [];
    for (let count = 0; count < 2; count++) {
      const fuPrompt = followupDecisionPrompt({ questionText: q.text, answerText: basis, followupCount: count, remainingFollowups: 2 - count, context });
      const channel = new DashscopeReviewChannel(client, fuPrompt, { jsonMode: true, enableThinking: false, rawSink: (a, raw) => evidence.writeText(`skill/raw/${q.id}-followup${count + 1}.attempt${a}.txt`, raw, false) });
      const fu: NonNullable<SkillRunResult['questions'][number]['followup']> = parseJsonOrThrow(await channel.call(1, null), 'FollowupDecision') as NonNullable<SkillRunResult['questions'][number]['followup']>;
      if (typeof fu.need !== 'boolean' || typeof fu.reason !== 'string' || typeof fu.gap !== 'string' || (fu.need ? typeof fu.question !== 'string' || fu.question.trim().length === 0 || fu.question.length > 40 : fu.question !== null)) throw new Error('追问候选未通过轻量契约');
      lastFollowup = fu;
      log(`追问判定 ${q.id}.${count + 1}`, fuPrompt, channel.calls);
      if (!fu.need) { fire('NO_FOLLOWUP'); break; }
      fire('FOLLOWUP_NEEDED');
      const answer = '这个事实我暂时没有更多可核对的信息，不能补造数字或个人动作。';
      followupAnswers.push(answer);
      followups.push({ question: fu.question!, answer, reason: fu.reason, gap: fu.gap });
      basis += `\n${answer}`;
      fire('FOLLOWUP_DONE');
    }
    // 同一合成回答文本作为一个确认轮次；追问追加到该轮的冻结文本，引用不会跨虚构轮次。
    fire('ANSWER_DONE');
    const reviewArgs = { tag: `${q.id}-first`, questionId: q.id, context, questionText: q.text, answerText: basis, turnIds: [answerTurnId] };
    const rev = await reviewAnswer(client, evidence, reviewArgs);
    fire('REVIEW_DONE', rev.kind === 'ok');
    log(`五维反馈 ${q.id}`, reviewPrompt({ ...reviewArgs, textVersion: 'raw', isRewrite: false }), rev.calls, rev.kind);
    let rewrite: SkillRunResult['questions'][number]['rewrite'] = null;
    if (q.kind === 'introduction') {
      fire('REWRITE_START');
      const addition = '以上是我能说明的相关经历；没有在这段回答里交代的事实，仍需要进一步核实。';
      const answer = `${basis}\n${addition}`;
      fire('REWRITE_DONE');
      const rewriteArgs = { tag: `${q.id}-rewrite`, questionId: q.id, context, questionText: q.text, answerText: answer, turnIds: [`t${++nextTurn}`], isRewrite: true, firstAnswerText: basis };
      const rw = await reviewAnswer(client, evidence, rewriteArgs);
      fire('REVIEW_DONE', rw.kind === 'ok');
      rewrite = { answer, feedback: rw.feedback, feedbackKind: rw.kind, quoteCheck: rw.quoteCheck, delta: { added: [addition], corrected: [], stillMissing: rw.feedback.factGaps } };
      log(`重答对比评审 ${q.id}`, reviewPrompt({ ...rewriteArgs, textVersion: 'raw' }), rw.calls, rw.kind);
    }
    questions.push({ questionId: q.id, kind: q.kind, questionText: q.text, firstAnswer, followup: lastFollowup, followups, followupAnswer: followupAnswers.length ? followupAnswers.join('\n') : null, feedback: rev.feedback, feedbackKind: rev.kind, attempts: rev.attempts, quoteCheck: rev.quoteCheck, rewrite });
    if (opts.endEarly === true && questions.length === active.length) fire('END_SESSION');
    else fire('SKIP_REWRITE');
  }
  const perQuestion: SessionReport['perQuestion'] = plan.questions.map((q) => {
    const result = questions.find((x) => x.questionId === q.id);
    const final = result?.rewrite ? { feedback: result.rewrite.feedback, kind: result.rewrite.feedbackKind } : result ? { feedback: result.feedback, kind: result.feedbackKind } : null;
    const feedback = final?.kind === 'ok' ? final.feedback : null;
    return { questionId: q.id, kind: q.kind, status: feedback ? 'reviewed' : result ? 'skipped' : 'not_reached', feedback, rewriteDelta: feedback ? result?.rewrite?.delta ?? null : null };
  });
  const completed = perQuestion.filter((q) => q.status === 'reviewed').length;
  if (completed !== machine.snapshot().completed) throw new Error('文字入口报告与状态机完成数不一致');
  const endedEarly = opts.endEarly === true || completed < 4;
  const reviewed = perQuestion.filter((q) => q.feedback !== null);
  const summaryText = JSON.stringify(reviewed);
  const sourceFeedbacks = reviewed.map((q) => q.feedback!);
  let priorityPractice = ['本次未完成任何题目，无有效反馈'];
  let source: SkillRunResult['report']['source'] = 'fixed_zero_completion';
  if (completed > 0) {
    const rpPrompt = reportPrompt({ completedQuestions: completed, endedEarly, perQuestionSummary: summaryText, totalQuestions: 4 });
    const channel = new DashscopeReviewChannel(client, rpPrompt, { jsonMode: true, enableThinking: false, rawSink: (a, raw) => evidence.writeText(`skill/raw/report.attempt${a}.txt`, raw, false) });
    let candidates: unknown;
    try { candidates = (parseJsonOrThrow(await channel.call(1, null), 'SessionReport') as { priorityPractice?: unknown }).priorityPractice; } catch { candidates = null; }
    log('全场报告', rpPrompt, channel.calls);
    const picked = Array.isArray(candidates) ? candidates.filter((s): s is string => typeof s === 'string' && s.trim().length >= 4 && hasFeedbackSource(s.trim(), sourceFeedbacks)).map((s) => s.trim()).slice(0, 2) : [];
    if (picked.length) { priorityPractice = picked; source = 'model_priority_practice'; }
    else { priorityPractice = [...new Set(reviewed.flatMap((q) => [q.feedback!.topImprovement, ...q.feedback!.factGaps]).filter((s) => s.length >= 4))].slice(0, 2); source = 'derived_from_validated_feedback'; }
    if (!priorityPractice.length) throw new Error('已评审反馈无法派生优先练习点');
  }
  const report: SessionReport = { contractVersion: CONTRACT_VERSION, sessionStatus: endedEarly ? 'ended_early' : 'completed', completedQuestions: completed, totalQuestions: 4, perQuestion, priorityPractice, versions: { ruleVersion: RULES_VERSION, realtimeModel: null, textModel: client.model } };
  const validation = validateContract('session-report', report);
  if (!validation.ok) throw new Error(`文字入口报告未通过契约：${validation.errors.join('；')}`);
  fire('REPORT_GENERATED');
  const markdown = renderReport({ material, caseId: c.id, questions, reportJson: report as unknown as Record<string, unknown>, endedEarly, completed });
  mkdirSync(evidence.dataDir, { recursive: true });
  const reportPath = path.join(evidence.dataDir, '面试训练报告-sample.md');
  assertNoSecret(markdown);
  writeFileSync(reportPath, markdown);
  return { caseId: c.id, material, plan, planCalls: planChannel.calls, questions, report: { markdown, path: path.relative(REPO_ROOT, reportPath), raw: report, source }, endedEarly, turns, versions: { contract: CONTRACT_VERSION, rules: RULES_VERSION, prompts: PROMPT_VERSION, rulesDigest: rulesDigest() } };
}

// ---------------- 简版 Prompt：应用辅助文本试验，不替代普通聊天或原生宿主验收 ----------------

export interface PromptTurn {
  role: 'user' | 'assistant';
  content: string;
  latencyMs?: number;
  tokens?: number;
}

export interface PromptRunResult {
  host: string;
  verificationMode: 'application_assisted';
  transcript: PromptTurn[];
  /** 应用辅助闭环：内容与身份严格校验，只允许应用权威重定位引用坐标。 */
  closedLoop: { askedMaterials: boolean; askedQuestion: boolean; gaveFeedback: boolean; feedbackHasAllFiveDims: boolean; quotedVerbatim: boolean; introductionReviewed: boolean; experienceReviewed: boolean; reportValid: boolean };
  /** 不修坐标时的原始输出判定，不能用应用闭环替代普通聊天宿主通过。 */
  rawClosedLoop: PromptRunResult['closedLoop'];
  questions?: Array<{ questionId: string; kind: QuestionKind; asked: boolean; feedbackValid: boolean; rawFeedbackValid: boolean; feedback: Feedback | null; validationErrors: string[]; rawValidationErrors: string[]; answerText: string; rawFeedback: string }>;
  quoteChecks: PromptQuoteCheck[];
  report: { raw: string; valid: boolean; validationErrors: string[] };
  versions: { rules: string; contract: string; prompts: string };
}

export function promptRunPassed(result: Pick<PromptRunResult, 'closedLoop'>): boolean {
  return ['askedMaterials', 'askedQuestion', 'gaveFeedback', 'feedbackHasAllFiveDims', 'quotedVerbatim', 'introductionReviewed', 'experienceReviewed', 'reportValid'].every((key) => result.closedLoop[key as keyof PromptRunResult['closedLoop']] === true);
}

export async function runPromptFlow(client: DashscopeTextClient, evidence: EvidenceWriter, opts: { caseId?: string } = {}): Promise<PromptRunResult> {
  const c = loadCases().find((x) => x.id === (opts.caseId ?? 'C13'));
  if (!c) throw new Error(`找不到案例 ${opts.caseId ?? 'C13'}`);
  if (c.stage !== '应届' && c.stage !== '社招') throw new Error('案例阶段无效');
  const pasted = simplePromptMarkdown();
  const transcript: PromptTurn[] = [];
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  const persistPartial = () => evidence.writeJson('prompt/transcript.json', { host: 'dashscope-chat-completions（应用辅助，多轮 messages）', verificationMode: 'application_assisted', phase: 'in_progress', caseId: c.id, pastedChars: pasted.length, versions: { rules: RULES_VERSION, contract: CONTRACT_VERSION, prompts: PROMPT_VERSION }, transcript });
  const ask = async (userText: string): Promise<string> => {
    messages.push({ role: 'user', content: userText });
    transcript.push({ role: 'user', content: userText });
    persistPartial();
    let res: Awaited<ReturnType<DashscopeTextClient['completeChat']>>;
    try { res = await client.completeChat(messages, { temperature: 0.2, maxTokens: 4096, enableThinking: false }); }
    catch (error) {
      evidence.writeJson('prompt/failure.json', { code: 'model_request_failed', completedCalls: transcript.filter((t) => t.role === 'assistant').length, note: '提供方请求中断；保留之前对话和本次待请求文本，不填充伪反馈。' });
      throw error;
    }
    messages.push({ role: 'assistant', content: res.text });
    transcript.push({ role: 'assistant', content: res.text, latencyMs: res.latencyMs ?? 0, tokens: res.usage?.totalTokens ?? 0 });
    persistPartial();
    return res.text;
  };
  const opening = await ask(pasted);
  const askedMaterials = /JD/.test(opening) && /经历/.test(opening);
  await ask(`目标岗位：${c.targetRole}\n求职阶段：${c.stage}\nJD：${c.materials.jd}\n个人经历：${c.materials.experience}`);
  let raw = await ask('确认，材料没问题。请一次输出冻结四项计划 JSON：contractVersion、questions（id、kind、text、sourceExcerpt、intent、topics）、askedTopics；q1 introduction，q2–q4 experience，不根据介绍修改后三题。只输出 JSON。');
  let plan: QuestionPlan | null = null;
  let planErrors: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const parsed = extractJson(raw);
    const v = parsed.ok ? validateQuestionPlan(parsed.value, c.materials) : { ok: false, errors: [parsed.error] };
    if (v.ok) { plan = parsed.ok ? parsed.value as QuestionPlan : null; break; }
    planErrors = [...v.errors].filter((s): s is string => typeof s === 'string');
    if (attempt < 2) raw = await ask(`计划未通过契约或来源校验，请只修正计划并输出完整 JSON：${v.errors.join('；')}`);
  }
  if (!plan) {
    evidence.writeJson('prompt/failure.json', { code: 'plan_invalid', errors: planErrors, attempts: 3 });
    throw new Error('简版 Prompt 未生成可校验的四项计划，停止作答');
  }
  const quoteChecks: PromptRunResult['quoteChecks'] = [];
  const questionResults: NonNullable<PromptRunResult['questions']> = [];
  const validFeedbacks: Feedback[] = [];
  for (const [i, q] of plan.questions.slice(0, 2).entries()) {
    const context: InterviewContext = { kind: q.kind, jd: c.materials.jd, stage: c.stage, targetRole: c.targetRole, intent: q.intent };
    // 语境仅用来判断岗位与题型，不得变成回答证据；当前环节原话单独列出。
    const asked = await ask(`${i ? '跳过上一题重答，进入下一题。' : ''}请按已冻结计划原文提问 ${q.id}：${q.text}\n【判断语境】${JSON.stringify(context)}\n岗位和意图仅作语境；本题已确认回答为唯一事实证据。`);
    const questionAsked = asked.includes(q.text);
    const answer = q.kind === 'introduction' ? `我用相关经历说明自己：${c.firstAnswer}\n我的应聘方向是${c.targetRole}。` : c.firstAnswer;
    const turnId = `t${i + 1}`;
    const feedbackRaw = await ask(`【本题已确认回答】\n${answer}\n【回答结束】\n我回答完毕，本环节选择零追问。请按简版 Prompt 的五维 JSON 契约反馈，questionId=${q.id}，reviewBasis.turnIds=["${turnId}"]，textVersion=raw；引用只能来自上方本题回答，不引用材料或上一题。`);
    const checked = validatePromptFeedback(feedbackRaw, { questionId: q.id, turnId, answerText: answer });
    if (checked.feedback) validFeedbacks.push(checked.feedback);
    quoteChecks.push(...checked.quoteChecks);
    questionResults.push({ questionId: q.id, kind: q.kind, asked: questionAsked, feedbackValid: checked.valid, rawFeedbackValid: checked.rawValid, feedback: checked.feedback, validationErrors: checked.errors, rawValidationErrors: checked.rawErrors, answerText: answer, rawFeedback: feedbackRaw });
  }
  const summary = plan.questions.map((q) => ({ questionId: q.id, kind: q.kind, status: validFeedbacks.some((f) => f.questionId === q.id) ? 'reviewed' : questionResults.some((r) => r.questionId === q.id) ? 'skipped' : 'not_reached', feedback: validFeedbacks.find((f) => f.questionId === q.id) ?? null, rewriteDelta: null }));
  const reportRaw = await ask(`结束训练。请只输出本场 SessionReport JSON；contractVersion=${CONTRACT_VERSION}，sessionStatus=ended_early，completedQuestions=${validFeedbacks.length}，totalQuestions=4，perQuestion 必须按以下四项原样回填，未进入的 not_reached 不得改为 skipped。priorityPractice ${validFeedbacks.length ? '只来自其中反馈（共享至少四字连续片段）' : '固定为 ["本次未完成任何题目，无有效反馈"]'}。versions 含 ruleVersion=${RULES_VERSION}、realtimeModel=null、textModel=${client.model}。不得添加 summaryNote/versionStamp；版本说明只能在 JSON 外，当前仅输出 JSON。\n${JSON.stringify(summary)}`);
  const reportCheck = validatePromptReport(reportRaw, { perQuestion: summary as SessionReport['perQuestion'], textModel: client.model });
  const reportValid = reportCheck.valid;
  const askedQuestion = questionResults.every((r) => r.asked);
  const feedbackHasAllFiveDims = questionResults.length === 2 && questionResults.every((r) => r.feedbackValid);
  const quotedVerbatim = feedbackHasAllFiveDims && quoteChecks.length > 0 && quoteChecks.every((q) => q.located);
  const closedLoop = { askedMaterials, askedQuestion, gaveFeedback: validFeedbacks.length === 2, feedbackHasAllFiveDims, quotedVerbatim, introductionReviewed: questionResults.some((r) => r.kind === 'introduction' && r.feedbackValid), experienceReviewed: questionResults.some((r) => r.kind === 'experience' && r.feedbackValid), reportValid };
  const rawFeedbackValid = questionResults.length === 2 && questionResults.every((r) => r.rawFeedbackValid);
  const rawClosedLoop = { ...closedLoop, gaveFeedback: rawFeedbackValid, feedbackHasAllFiveDims: rawFeedbackValid, quotedVerbatim: rawFeedbackValid && quoteChecks.length > 0 && quoteChecks.every((q) => q.modelMetadataValid), introductionReviewed: questionResults.some((r) => r.kind === 'introduction' && r.rawFeedbackValid), experienceReviewed: questionResults.some((r) => r.kind === 'experience' && r.rawFeedbackValid) };
  const report = { raw: reportRaw, valid: reportValid, validationErrors: reportCheck.errors };
  evidence.writeJson('prompt/transcript.json', { host: 'dashscope-chat-completions（应用辅助，多轮 messages）', verificationMode: 'application_assisted', caseId: c.id, pastedChars: pasted.length, plan, questions: questionResults, closedLoop, rawClosedLoop, quoteChecks, reportRaw, report, transcript });
  return { host: 'dashscope-chat-completions', verificationMode: 'application_assisted', transcript, closedLoop, rawClosedLoop, quoteChecks, questions: questionResults, report, versions: { rules: RULES_VERSION, contract: CONTRACT_VERSION, prompts: PROMPT_VERSION } };
}
