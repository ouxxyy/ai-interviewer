export type Stage = '应届' | '社招';
export type SessionState = 'materials_review' | 'question' | 'answer' | 'followup' | 'review' | 'rewrite' | 'report' | 'ended';
export type DimensionLevel = '证据不足' | '部分清楚' | '充分清楚' | '无法判断';
export type DimensionKey = 'relevance' | 'specificity' | 'contribution' | 'resultsReflection' | 'structure';
export type ErrorCode =
  | 'E_EMPTY_TRANSCRIPT'
  | 'E_MIC_DENIED'
  | 'E_OFFLINE'
  | 'E_MODEL_TIMEOUT'
  | 'E_PARSE_FAILED'
  | 'E_QUOTA'
  | 'E_DISCLOSURE_REQUIRED'
  | 'E_UPLINK_PAUSED'
  | 'E_NOT_FOUND'
  | 'E_STATE'
  | 'E_VALIDATION'
  | string;

export interface AppErrorBody {
  code: ErrorCode;
  message: string;
  hint?: string;
  detail?: string;
  halt?: boolean;
}

export interface WebSettings {
  saveHistory: boolean;
  saveAudio: boolean;
  disclosureAckVersion: string | null;
  disclosureAckAt: string | null;
  updatedAt: string | null;
}

export interface Disclosure {
  version: string;
  staysLocal: readonly string[];
  sentToCloud: readonly string[];
  storage: { root: string; database: string; audio: string; uploads: string; note: string };
  deletion: readonly string[];
  billing: { payer: string; pricing: string; counter: string };
}

export interface PlannedQuestion {
  id: string;
  text: string;
  intent: string;
  sourceExcerpt: string;
  topics: string[];
}

export interface Turn {
  id: string;
  questionId: string;
  speaker: 'user' | 'interviewer';
  turnType: 'question' | 'answer' | 'followup' | 'rewrite';
  seq: number;
  startedAt: string;
  endedAt: string;
  rawTranscript: string;
  revisedText: string | null;
  audioFile: string | null;
  audio?: { user: boolean; interviewer: boolean };
}

export interface QuoteRef {
  text: string;
  start: number;
  end: number;
  turnId: string;
  textVersion: 'raw' | 'revised';
  matchType: 'exact' | 'normalized';
}

export interface DimensionFeedback {
  level: DimensionLevel;
  quote: QuoteRef | null;
  reason: string;
}

export interface Feedback {
  questionId: string;
  reviewBasis: { turnIds: string[]; textVersion: 'raw' | 'revised' };
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
  sessionStatus: 'completed' | 'ended_early';
  completedQuestions: number;
  totalQuestions: number;
  perQuestion: Array<{
    questionId: string;
    status: 'reviewed' | 'skipped' | 'not_reached';
    feedback: Feedback | null;
    rewriteDelta: RewriteDelta | null;
  }>;
  priorityPractice: string[];
  versions: { ruleVersion: string; realtimeModel: string | null; textModel: string | null };
}

export interface ReviewBasisDetail {
  questionId: string;
  text: string;
  turnIds: string[];
  textVersion: 'raw' | 'revised';
}

export interface ReviewMeta {
  questionId: string;
  kind: 'ok' | 'degraded';
  attempts: number;
  cause?: string;
  quotesTotal: number;
  quotesLocated: number;
  firstAttemptOk: boolean;
}

export interface Snapshot {
  sid: string;
  state: SessionState;
  status: 'active' | 'report' | 'ended';
  machine: { state: SessionState; questionIndex: number; followupCount: number; rewriteUsed: boolean; completed: number };
  synthetic: boolean;
  toggles: { saveHistory: boolean; saveAudio: boolean };
  materials: { jd: string; experience: string; stage: Stage; targetRole: string } | null;
  plan: { questions: PlannedQuestion[]; askedTopics: string[] } | null;
  currentQuestion: { id: string; index: number; text: string; intent: string } | null;
  pending: string;
  lastError: AppErrorBody | null;
  halted: boolean;
  turns: Turn[];
  reviews: Record<string, Feedback>;
  reviewBasis: Record<string, ReviewBasisDetail>;
  reviewMeta: ReviewMeta[];
  rewriteDeltas: Record<string, RewriteDelta>;
  report: SessionReport | null;
  reportSource: 'model_priority_practice' | 'derived_from_validated_feedback' | 'fixed_zero_completion' | null;
}

export interface SessionDetail extends Snapshot {
  live: boolean;
  persisted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionListItem {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'report' | 'ended';
  state: SessionState;
  synthetic: boolean;
  completedQuestions: number;
  turns: number;
  hasReport: boolean;
  audioFiles: number;
}

export interface MaterialsDraft {
  jd: string;
  experience: string;
  stage: Stage;
  targetRole: string;
}
