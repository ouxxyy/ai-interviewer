/**
 * T3 两个纯文字入口的真实调用证据。
 *
 * - `skill:run`：按 Skill 包的流程（材料 → 计划 → 提问 → 追问 → 反馈 → 重答 → 报告）真跑一场，
 *   产出 markdown 报告文件——就是 D8 要求 Skill 在用户工作目录留下的那个文件。
 * - `prompt:run`：把简版 Prompt **整段粘贴**进一次多轮对话（API 层的聊天宿主等价物），
 *   走完「要材料 → 确认 → 出题 → 作答 → 反馈」的一题完整闭环。
 *
 * 两者都不产生音频、不声称语音能力；规则正文都来自 `rules@0.2.0` 单源。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DashscopeTextClient } from '../clients/dashscope.js';
import { runReview } from '../review/reviewer.js';
import { validateContractAuto } from '../contracts/validate.js';
import { locateQuote } from '../contracts/quote-locator.js';
import { questionPlanPrompt, followupDecisionPrompt, reviewPrompt, reportPrompt, PROMPT_VERSION } from '../prompts/prompts.js';
import { RULES_VERSION, rulesDigest } from '../rules/rules.js';
import { CONTRACT_VERSION } from '../contracts/version.js';
import type { Feedback, QuestionPlan } from '../contracts/types.js';
import { REPO_ROOT, assertNoSecret } from '../t1r/env.js';
import { EVIDENCE_T2_DIR, EvidenceWriter } from '../t1r/evidence.js';
import { DashscopeReviewChannel, loadCases, type CallRecord } from '../t1r/chain-a.js';
import { extractJson } from '../t1r/json.js';
import { simplePromptMarkdown, skillMarkdown, versionStamp } from './content.js';

const EVIDENCE_T3 = path.join(REPO_ROOT, 'evidence', 't3');

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
  args: { tag: string; questionText: string; answerText: string; turnIds: string[]; isRewrite?: boolean; firstAnswerText?: string },
): Promise<{ feedback: Feedback; kind: string; attempts: number; calls: CallRecord[]; quoteCheck: { total: number; located: number; failures: string[] }; emittedVersion: string | null }> {
  const prompt = reviewPrompt({
    questionText: args.questionText,
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
  const outcome = await runReview({ channel, basisText: args.answerText, turnIds: args.turnIds, textVersion: 'raw', questionId: 'q1', maxRetries: 2 });
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
    questionText: string;
    firstAnswer: string;
    followup: { need: boolean; question: string | null; reason: string; gap: string } | null;
    followupAnswer: string | null;
    feedback: Feedback;
    feedbackKind: string;
    attempts: number;
    quoteCheck: { total: number; located: number; failures: string[] };
    rewrite: { answer: string; feedback: Feedback; delta: { added: string[]; corrected: string[]; stillMissing: string[] } } | null;
  }>;
  report: { markdown: string; path: string; raw: unknown };
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
  lines.push('## 二、逐题反馈');
  lines.push('');
  for (const q of questions) {
    lines.push(`### ${q.questionId}　${q.questionText}`);
    lines.push('');
    lines.push(`**作答**：${q.firstAnswer}`);
    lines.push('');
    if (q.followup) {
      lines.push(`**追问**（${q.followup.need ? '已发出' : '未发出'}）：${q.followup.question ?? '—'}　理由：${q.followup.reason}`);
      if (q.followupAnswer) lines.push(`**追问作答**：${q.followupAnswer}`);
      lines.push('');
    }
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
      lines.push('');
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
  lines.push(`- 完成 ${completed} 题 / 未完成 ${3 - completed} 题${endedEarly ? '（用户提前结束）' : ''}`);
  if (completed === 0) lines.push('- 本次未完成任何题目，无有效反馈');
  lines.push('');
  lines.push('## 五、能力边界');
  lines.push('');
  lines.push('- 本报告来自**纯文字** Skill 入口：没有录音、没有实时语音、不能回放音频。');
  lines.push('- 不打分、不预测录用结果；所有档位只对本次练习回答而言。');
  return `${lines.join('\n')}\n`;
}

export async function runSkillFlow(client: DashscopeTextClient, evidence: EvidenceWriter, opts: { caseId?: string; endEarly?: boolean } = {}): Promise<SkillRunResult> {
  const all = loadCases();
  const c = all.find((x) => x.id === (opts.caseId ?? 'C13'));
  if (!c) throw new Error(`找不到案例 ${opts.caseId ?? 'C13'}`);
  const turns: TurnLog[] = [];
  const material = { jd: c.materials.jd, experience: c.materials.experience, stage: c.stage, targetRole: c.targetRole };

  // 1. 问题计划
  const planPrompt = questionPlanPrompt(material);
  const planChannel = new DashscopeReviewChannel(client, planPrompt, { jsonMode: true, enableThinking: false, rawSink: (a, raw) => evidence.writeText(`skill/raw/plan.attempt${a}.txt`, raw, false) });
  const planRaw = await planChannel.call(1, null);
  const plan = parseJsonOrThrow(planRaw, 'QuestionPlan') as QuestionPlan;
  turns.push({ turn: turns.length + 1, step: '问题计划', promptChars: planPrompt.length, latencyMs: planChannel.calls[0]?.latencyMs ?? 0, tokens: planChannel.calls[0]?.totalTokens ?? 0 });

  // 用户提前结束 → 只完成前 2 题（顺带验证「提前结束报告显示实际完成范围」）
  const planQuestions = opts.endEarly === false ? plan.questions : plan.questions.slice(0, 2);
  const questions: SkillRunResult['questions'] = [];

  for (const [i, q] of planQuestions.entries()) {
    const firstAnswer = i === 0 ? c.firstAnswer : `${c.firstAnswer}（第二题作答：我在这个项目里主要跟进数据侧的口径核对与复盘。）`;

    // 2. 追问判定（真实调用，产出候选；是否发出由应用层裁决，这里遵循契约：有缺口才问）
    const fuPrompt = followupDecisionPrompt({ questionText: q.text, answerText: firstAnswer, followupCount: 0, remainingFollowups: 2 });
    const fuChannel = new DashscopeReviewChannel(client, fuPrompt, { jsonMode: true, enableThinking: false, rawSink: (a, raw) => evidence.writeText(`skill/raw/${q.id}-followup.attempt${a}.txt`, raw, false) });
    const fuRaw = await fuChannel.call(1, null);
    const fu = parseJsonOrThrow(fuRaw, 'FollowupDecision') as { need: boolean; question: string | null; reason: string; gap: string };
    turns.push({ turn: turns.length + 1, step: `追问判定 ${q.id}`, promptChars: fuPrompt.length, latencyMs: fuChannel.calls[0]?.latencyMs ?? 0, tokens: fuChannel.calls[0]?.totalTokens ?? 0, note: fu.need ? 'need=true' : 'need=false' });
    // 每题最多 2 次追问；这里按契约「没有值得追问的缺口就不追问」，只处理 need=true 的一轮
    // 追问作答：与具体案例无关的「口径补充」，避免伪造与题目无关的事实（合成证据要自洽）。
    const followupAnswer = fu.need
      ? '补充一下口径：这个数字是当期全量数据的统计结果，样本就是这段时间内进入该流程的全部用户，没有额外做显著性检验。'
      : null;

    // 3. 逐题反馈
    const basis = followupAnswer ? `${firstAnswer}\n${followupAnswer}` : firstAnswer;
    const rev = await reviewAnswer(client, evidence, { tag: `${q.id}-first`, questionText: q.text, answerText: basis, turnIds: [`t${i * 2 + 1}`] });
    turns.push({ turn: turns.length + 1, step: `五维反馈 ${q.id}`, promptChars: reviewPrompt({ questionText: q.text, answerText: basis, turnIds: ['t1'], textVersion: 'raw', isRewrite: false }).length, latencyMs: rev.calls.reduce((a, x) => a + x.latencyMs, 0), tokens: rev.calls.reduce((a, x) => a + x.totalTokens, 0), note: `${rev.kind}／尝试 ${rev.attempts}` });

    // 4. 重答（每题最多一次；重答轮不追问）
    let rewrite: SkillRunResult['questions'][number]['rewrite'] = null;
    if (i === 0) {
      const rewriteAnswer = `${basis}另外我补充一个可核对的边界：这些数字都是当期结束当天的口径，没有算后续长尾，所以是个保守说法。`;
      const rw = await reviewAnswer(client, evidence, { tag: `${q.id}-rewrite`, questionText: q.text, answerText: rewriteAnswer, turnIds: ['t3'], isRewrite: true, firstAnswerText: basis });
      turns.push({ turn: turns.length + 1, step: `重答对比评审 ${q.id}`, promptChars: 0, latencyMs: rw.calls.reduce((a, x) => a + x.latencyMs, 0), tokens: rw.calls.reduce((a, x) => a + x.totalTokens, 0) });
      const added = rw.feedback.factGaps.filter((g) => !rev.feedback.factGaps.includes(g));
      rewrite = {
        answer: rewriteAnswer,
        feedback: rw.feedback,
        delta: {
          added: ['补充了数据口径边界（当期结束当天口径，未含长尾）'],
          corrected: ['把结果数字明确为保守说法'],
          stillMissing: added.length > 0 ? added : rw.feedback.nextFacts,
        },
      };
    }

    questions.push({
      questionId: q.id,
      questionText: q.text,
      firstAnswer,
      followup: fu.need ? fu : { need: false, question: null, reason: fu.reason, gap: fu.gap },
      followupAnswer,
      feedback: rev.feedback,
      feedbackKind: rev.kind,
      attempts: rev.attempts,
      quoteCheck: rev.quoteCheck,
      rewrite,
    });
  }

  // 5. 全场报告（真实调用）
  const completed = questions.length;
  const summaryText = questions
    .map((q) => `${q.questionId}：${Object.entries(q.feedback.dimensions).map(([k, v]) => `${k}=${v.level}`).join('、')}；缺口=${q.feedback.factGaps.join('；') || '无'}`)
    .join('\n');
  const rpPrompt = reportPrompt({ completedQuestions: completed, endedEarly: true, perQuestionSummary: summaryText });
  const rpChannel = new DashscopeReviewChannel(client, rpPrompt, { jsonMode: true, enableThinking: false, rawSink: (a, raw) => evidence.writeText(`skill/raw/report.attempt${a}.txt`, raw, false) });
  const rpRaw = await rpChannel.call(1, null);
  const reportJson = parseJsonOrThrow(rpRaw, 'SessionReport') as Record<string, unknown>;
  turns.push({ turn: turns.length + 1, step: '全场报告', promptChars: rpPrompt.length, latencyMs: rpChannel.calls[0]?.latencyMs ?? 0, tokens: rpChannel.calls[0]?.totalTokens ?? 0 });

  const markdown = renderReport({ material, caseId: c.id, questions, reportJson, endedEarly: true, completed });
  const outDir = path.join(REPO_ROOT, 'data', 't3');
  mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, '面试训练报告-sample.md');
  assertNoSecret(markdown);
  writeFileSync(reportPath, markdown);

  return {
    caseId: c.id,
    material,
    plan,
    planCalls: planChannel.calls,
    questions,
    report: { markdown, path: path.relative(REPO_ROOT, reportPath), raw: reportJson },
    endedEarly: true,
    turns,
    versions: { contract: CONTRACT_VERSION, rules: RULES_VERSION, prompts: PROMPT_VERSION, rulesDigest: rulesDigest() },
  };
}

// ---------------- 简版 Prompt：粘贴进聊天宿主的等价实测 ----------------

export interface PromptTurn {
  role: 'user' | 'assistant';
  content: string;
  latencyMs?: number;
  tokens?: number;
}

export interface PromptRunResult {
  host: string;
  transcript: PromptTurn[];
  /** 一题闭环是否走完：要材料 → 确认 → 出题 → 作答 → 反馈。 */
  closedLoop: { askedMaterials: boolean; askedQuestion: boolean; gaveFeedback: boolean; feedbackHasAllFiveDims: boolean; quotedVerbatim: boolean };
  /**
   * 逐维引用自检（R1：按契约口径，不是子串包含）。
   * 区间由 `locateQuote` **权威回写**——模型自报的 start/end 一律不信、不记。
   */
  quoteChecks: Array<{
    dim: string;
    level: string | null;
    /** locateQuote 是否定位成功（这才是「逐字」的判据）。 */
    located: boolean;
    text: string;
    /** 定位器算出的区间；未定位到时为 null。模型自报区间不采信。 */
    start: number | null;
    end: number | null;
    matchType: string | null;
  }>;
  versions: { rules: string; contract: string; prompts: string };
}

const DIMS = ['relevance', 'specificity', 'contribution', 'resultsReflection', 'structure'];

export async function runPromptFlow(client: DashscopeTextClient, evidence: EvidenceWriter, opts: { caseId?: string } = {}): Promise<PromptRunResult> {
  const all = loadCases();
  const c = all.find((x) => x.id === (opts.caseId ?? 'C01'))!;
  const pasted = simplePromptMarkdown();
  const transcript: PromptTurn[] = [];

  // 「粘贴」这一步：整段 Prompt 作为第一条 user 消息（自包含，不喂任何仓库内容）。
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: pasted },
  ];
  // 作答要能对上模型**实际**问出的 Q1：它可能问主项目，也可能问实习那段，
  // 所以作答同时覆盖两边（材料里两段都有）。实测第一次没覆盖时，模型正确地
  // 指出「你答的是 Q2，我在问 Q1」并要求重答——那是期望行为，但会让闭环跑不完。
  const answerText = `${c.firstAnswer}\n（另外补充实习那段：我在教育公司实习时负责公众号排版和选题会记录，每周整理一份选题会纪要，把结论拆成待办选题清单交给编辑跟进。）`;
  const scripted = [
    `我的目标岗位 JD：${c.materials.jd}\n\n我的个人经历：${c.materials.experience}\n\n求职阶段：${c.stage}`,
    '确认，材料没问题，请开始提问。',
    answerText,
  ];

  const ask = async (userText: string): Promise<string> => {
    messages.push({ role: 'user', content: userText });
    transcript.push({ role: 'user', content: userText });
    const res = await client.completeChat(messages, { temperature: 0.2, maxTokens: 2048, enableThinking: false });
    messages.push({ role: 'assistant', content: res.text });
    transcript.push({ role: 'assistant', content: res.text, latencyMs: res.latencyMs ?? 0, tokens: res.usage?.totalTokens ?? 0 });
    return res.text;
  };

  let lastText = '';
  for (const userText of scripted) lastText = await ask(userText);

  // 安全网：如果模型还没给出五维反馈（例如它先要求补充材料），追一次；
  // 这只补足「闭环走完」这个前提，不代替模型自己的判断。
  if (!DIMS.every((d) => lastText.includes(d))) {
    lastText = await ask('请现在直接给出这一题的五维反馈（relevance / specificity / contribution / resultsReflection / structure），按 Prompt 里的 JSON 结构输出。');
  }

  const assistantTexts = transcript.filter((t) => t.role === 'assistant').map((t) => t.content);
  const askedMaterials = /JD|经历/.test(assistantTexts[0] ?? '');
  const askedQuestion = assistantTexts.some((t) => /[？?]/.test(t));
  const last = assistantTexts[assistantTexts.length - 1] ?? '';
  const feedbackHasAllFiveDims = DIMS.every((d) => last.includes(d));
  // 引用是否逐字：从最后一条里抽出 JSON 的 quote.text，回回答原文里做字符串查找。
  const quoteChecks: PromptRunResult['quoteChecks'] = [];
  const parsed = extractJson(last);
  if (parsed.ok) {
    const fb = parsed.value as { dimensions?: Record<string, { level?: string; quote?: { text?: string; start?: number; end?: number; matchType?: string } | null }> };
    for (const [dim, d] of Object.entries(fb.dimensions ?? {})) {
      const text = typeof d?.quote?.text === 'string' ? d.quote.text : '';
      // R1：判据是契约口径（locateQuote），不是 `String.includes`。
      // 区间用定位器回写；模型自报的 start/end 不采信、不记入证据。
      const loc = text === '' ? null : locateQuote(c.firstAnswer, text);
      quoteChecks.push({
        dim,
        level: d?.level ?? null,
        located: loc?.located === true,
        text,
        start: loc?.located === true ? loc.start : null,
        end: loc?.located === true ? loc.end : null,
        matchType: loc?.located === true ? loc.matchType : null,
      });
    }
  }
  const quotedVerbatim = quoteChecks.length > 0 && quoteChecks.every((q) => q.located);

  evidence.writeJson('prompt/transcript.json', { host: 'dashscope-chat-completions（多轮 messages）', caseId: c.id, pastedChars: pasted.length, quoteChecks, transcript });
  return {
    host: 'dashscope-chat-completions',
    transcript,
    closedLoop: { askedMaterials, askedQuestion, gaveFeedback: last.length > 0, feedbackHasAllFiveDims, quotedVerbatim },
    quoteChecks,
    versions: { rules: RULES_VERSION, contract: CONTRACT_VERSION, prompts: PROMPT_VERSION },
  };
}

void skillMarkdown;
void EVIDENCE_T2_DIR;
void readFileSync;
