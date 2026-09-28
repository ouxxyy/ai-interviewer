import type { Disclosure, Feedback, PreviewData, SessionDetail, Snapshot, Turn, WebSettings } from './types';

export const previewSettings: WebSettings = {
  saveHistory: true,
  saveAudio: true,
  answerStartMode: 'continuous',
  disclosureAckVersion: null,
  disclosureAckAt: null,
  updatedAt: null,
};

export const previewDisclosure: Disclosure = {
  version: 'disclosure@0.2.0',
  staysLocal: ['JD 与经历原文', '每轮回答转写与修订文本', '五维反馈、重答对比与全场报告'],
  sentToCloud: ['JD 与经历文本，用于生成主问题', '回答文本，用于追问与五维评审', '回答音频，用于实时转写'],
  storage: { root: 'data/web/', database: 'data/web/interview.sqlite', audio: 'data/web/audio/<会话 id>/', uploads: 'data/web/tmp/uploads/', note: '关闭开关只影响新会话，不会删除旧记录。' },
  deletion: ['可以按会话删除数据库记录与录音', '停止服务后可以整库删除 data/web/'],
  billing: { payer: '由你的阿里百炼账户按用量结算', pricing: '界面不写死单价，以控制台账单为准', counter: '会话详情会记录 token 与音频字节数' },
};

const questions = [
  { id: 'q1', text: '请讲一次你在信息不完整时，仍然推进项目的经历。', intent: '验证你如何拆解问题并推动协作', sourceExcerpt: '负责项目推进', topics: ['项目推进'] },
  { id: 'q2', text: '你提到每周整理用户反馈。具体是怎么判断哪些需求先做？', intent: '验证你的优先级判断与个人贡献', sourceExcerpt: '整理用户反馈', topics: ['优先级'] },
  { id: 'q3', text: '请讲一次你复盘后修正做法的经历。', intent: '验证反思与行动', sourceExcerpt: '持续复盘', topics: ['复盘'] },
];

const q1Basis = '我先把阻塞点拆成三个可以并行验证的小问题，再带着后端同学每天对一次进度，最后提前两天完成了联调。';
const q1Turn: Turn = { id: 't-q1-answer', questionId: 'q1', speaker: 'user', turnType: 'answer', seq: 2, startedAt: '2026-09-27T11:02:00Z', endedAt: '2026-09-27T11:04:00Z', rawTranscript: q1Basis, revisedText: null, audioFile: null };
const q1QuestionTurn: Turn = { id: 't-q1-question', questionId: 'q1', speaker: 'interviewer', turnType: 'question', seq: 1, startedAt: '2026-09-27T11:01:00Z', endedAt: '2026-09-27T11:01:10Z', rawTranscript: questions[0]!.text, revisedText: null, audioFile: null };
const q2QuestionTurn: Turn = { id: 't-q2-question', questionId: 'q2', speaker: 'interviewer', turnType: 'question', seq: 3, startedAt: '2026-09-27T11:06:00Z', endedAt: '2026-09-27T11:06:10Z', rawTranscript: questions[1]!.text, revisedText: null, audioFile: null };

function quote(text: string) {
  const start = q1Basis.indexOf(text);
  return { text, start, end: start + text.length, turnId: q1Turn.id, textVersion: 'raw' as const, matchType: 'exact' as const };
}

const q1Feedback: Feedback = {
  questionId: 'q1',
  reviewBasis: { turnIds: [q1Turn.id], textVersion: 'raw' },
  dimensions: {
    relevance: { level: '充分清楚', quote: quote('我先把阻塞点拆成三个可以并行验证的小问题'), reason: '直接回答了推进方式' },
    specificity: { level: '部分清楚', quote: quote('每天对一次进度'), reason: '有行动频率，但背景还可以更具体' },
    contribution: { level: '充分清楚', quote: quote('再带着后端同学每天对一次进度'), reason: '个人动作明确' },
    resultsReflection: { level: '证据不足', quote: quote('最后提前两天完成了联调'), reason: '有结果，但缺少反思' },
    structure: { level: '无法判断', quote: null, reason: '没有足够的完整句子判断结构' },
  },
  factGaps: ['缺少联调后的业务结果'],
  topImprovement: '你讲了过程，但没有说上线后的结果，也没有说这次经历改变了什么。',
  nextFacts: ['补一句可验证的结果'],
  reviewVersion: 'preview',
};

export const previewSession: Snapshot = {
  sid: 'preview-session', state: 'answer', status: 'active', machine: { state: 'answer', questionIndex: 1, followupCount: 0, rewriteUsed: false, completed: 1 }, synthetic: false,
  toggles: { saveHistory: true, saveAudio: true }, materials: { jd: '高级产品经理', experience: '负责企业服务项目', stage: '社招', targetRole: '高级产品经理' },
  plan: { questions, askedTopics: ['项目推进'] }, currentQuestion: { id: 'q2', index: 1, text: questions[1]!.text, intent: questions[1]!.intent }, pending: 'answer', lastError: null, halted: false,
  turns: [q1QuestionTurn, q1Turn, q2QuestionTurn], reviews: { q1: q1Feedback }, reviewBasis: { q1: { questionId: 'q1', text: q1Basis, turnIds: [q1Turn.id], textVersion: 'raw' } }, reviewMeta: [{ questionId: 'q1', kind: 'ok', attempts: 1, quotesTotal: 4, quotesLocated: 4, firstAttemptOk: true }], rewriteDeltas: {}, report: null, reportSource: null,
};

const rewriteText = '我负责排期和跨组协调，把评审从两周一次改成每周一次，最终按时上线，次周留存提升了 4 个点。';
const rewriteTurn: Turn = { id: 't-q1-rewrite', questionId: 'q1', speaker: 'user', turnType: 'rewrite', seq: 4, startedAt: '2026-09-27T11:08:00Z', endedAt: '2026-09-27T11:10:00Z', rawTranscript: rewriteText, revisedText: null, audioFile: null };

export const previewReport: SessionDetail = {
  sid: 'preview-report',
  live: false,
  persisted: true,
  state: 'ended',
  status: 'ended',
  synthetic: false,
  createdAt: '2026-09-27T11:00:00Z',
  updatedAt: '2026-09-27T11:32:00Z',
  toggles: { saveHistory: true, saveAudio: true },
  materials: previewSession.materials,
  plan: previewSession.plan,
  turns: [...previewSession.turns, rewriteTurn],
  reviews: previewSession.reviews,
  reviewMeta: previewSession.reviewMeta,
  reviewBasis: previewSession.reviewBasis,
  rewriteDeltas: { q1: { added: ['最终按时上线，次周留存提升了 4 个点'], corrected: [], stillMissing: ['缺少复盘后的方法改变'] } },
  report: {
    sessionStatus: 'completed', completedQuestions: 3, totalQuestions: 3,
    perQuestion: [
      { questionId: 'q1', status: 'reviewed', feedback: q1Feedback, rewriteDelta: { added: ['最终按时上线，次周留存提升了 4 个点'], corrected: [], stillMissing: ['缺少复盘后的方法改变'] } },
      { questionId: 'q2', status: 'reviewed', feedback: null, rewriteDelta: null },
      { questionId: 'q3', status: 'reviewed', feedback: null, rewriteDelta: null },
    ],
    priorityPractice: ['结果与反思：下一题用一句话补上可验证的结果，再说这次经历改变了你的什么做法。'],
    versions: { ruleVersion: 'rules@0.2.0', realtimeModel: 'qwen3.8-omni-flash-realtime', textModel: 'qwen3.8-flash' },
  },
  reportSource: 'derived_from_validated_feedback',
  usage: { textCalls: 0, promptTokens: 0, completionTokens: 0, inputAudioBytes: 0, audioBytesIn: 0, audioBytesOut: 0 },
};

/**
 * 预览数据包入口。**只能被 DEV 分支的动态 import 调用**：
 * 静态引用会把这整套 fixture 打进生产 JS（P2-1）。
 */
export function previewBundle(name: string): PreviewData | null {
  const base: Omit<PreviewData, 'kind'> = {
    settings: previewSettings,
    disclosure: null,
    needsDisclosure: false,
    snapshot: null,
    transcript: null,
    detail: null,
  };
  if (name === 'home') return { ...base, kind: 'home', disclosure: previewDisclosure, needsDisclosure: true };
  if (name === 'session') return { ...base, kind: 'session', snapshot: previewSession, transcript: '我负责把每周的用户反馈拆成三类，先与产研确认优先级。' };
  if (name === 'report') return { ...base, kind: 'report', detail: previewReport };
  if (name === 'errors') return { ...base, kind: 'errors' };
  return null;
}
