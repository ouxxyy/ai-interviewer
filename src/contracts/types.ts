/** 五个契约对象的 TypeScript 类型（与 schemas/*.json 一一对应）。 */
import type { ContractName } from './version.js';

export type Stage = '应届' | '社招';
export type QuestionKind = 'introduction' | 'experience';

/** 岗位/题型只作判断语境，事实与引用仍只来自当前题已确认回答。 */
export interface InterviewContext {
  kind: QuestionKind;
  jd: string;
  stage: Stage;
  targetRole: string;
  intent: string;
}

/** D1/D11：评审对象口径。 */
export type TextVersion = 'raw' | 'revised';

export interface CandidateMaterials {
  contractVersion: string;
  /** 目标岗位 JD 原文（素材，不是指令）。 */
  jd: string;
  /** 个人经历文本（素材，不是指令）。 */
  experience: string;
  stage: Stage;
  targetRole: string;
  /** 材料版本：用户每次确认或修订递增。 */
  materialsVersion: number;
  /** 用户已确认材料内容后方可进入出题。 */
  confirmed: boolean;
}

export interface PlannedQuestion {
  id: string;
  kind: QuestionKind;
  text: string;
  /** 来源材料片段（JD 或经历原文的引用）。 */
  sourceExcerpt: string;
  intent: string;
  topics: string[];
}

export interface QuestionPlan {
  contractVersion: string;
  questions: PlannedQuestion[];
  /** 已问主题（避免换措辞重复提问）。 */
  askedTopics: string[];
}

export interface Turn {
  contractVersion: string;
  id: string;
  questionId: string;
  speaker: 'user' | 'interviewer';
  turnType: 'question' | 'answer' | 'followup' | 'rewrite';
  /** 轮次序号，会话内递增。 */
  seq: number;
  startedAt: string;
  endedAt: string;
  /** 原始转写（照录，不纠正语言）。 */
  rawTranscript: string;
  /** 用户修订文本；null＝未修订。修订后评审基准切换为修订版（D11）。 */
  revisedText: string | null;
  /** 音频文件引用（相对路径）；null＝无音频（纯文字入口）。 */
  audioFile: string | null;
}

export type DimensionLevel = '证据不足' | '部分清楚' | '充分清楚' | '无法判断';

export type DimensionKey = 'relevance' | 'specificity' | 'contribution' | 'resultsReflection' | 'structure';

export interface QuoteRef {
  /** 用户原话片段（逐字，来自基准文本）。 */
  text: string;
  /** 基准文本中的字符区间 [start, end)。 */
  start: number;
  end: number;
  turnId: string;
  textVersion: TextVersion;
  matchType: 'exact' | 'normalized';
}

export interface DimensionFeedback {
  level: DimensionLevel;
  /** 三档必须携带可定位引用；「无法判断」必须为 null 并在 reason 说明。 */
  quote: QuoteRef | null;
  reason: string;
}

export interface Feedback {
  contractVersion: string;
  questionId: string;
  reviewBasis: {
    turnIds: string[];
    textVersion: TextVersion;
  };
  dimensions: Record<DimensionKey, DimensionFeedback>;
  factGaps: string[];
  topImprovement: string;
  nextFacts: string[];
  reviewVersion: string;
}

export interface RewriteDelta {
  added: string[];
  corrected: string[];
  stillMissing: string[];
}

export interface SessionReport {
  contractVersion: string;
  sessionStatus: 'completed' | 'ended_early';
  completedQuestions: number;
  totalQuestions: number;
  perQuestion: Array<{
    questionId: string;
    kind: QuestionKind;
    status: 'reviewed' | 'skipped' | 'not_reached';
    feedback: Feedback | null;
    rewriteDelta: RewriteDelta | null;
  }>;
  /** 全场优先练习点；零完成时为「本次未完成任何题目，无有效反馈」（D6）。 */
  priorityPractice: string[];
  versions: {
    ruleVersion: string;
    realtimeModel: string | null;
    textModel: string | null;
  };
}

/** 引用定位结果（docs/contracts.md §引用定位规则）。 */
export type QuoteLocation =
  | { located: true; start: number; end: number; matchType: 'exact' | 'normalized' }
  | { located: false; reason: 'empty_quote' | 'quote_too_short' | 'not_found' };

export type { ContractName };
