import { ArrowCounterClockwise, ArrowRight, HandPalm, Microphone, Pause, Play, SpeakerHigh, Stop, Waveform } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ENTRY_HINTS } from '../../../src/rules/entry-hints';
import { ApiError, api } from '../api';
import { RealtimeAudio } from '../audio';
import { BrandHeader } from '../components/BrandHeader';
import { ErrorState } from '../components/ErrorState';
import { verifiedQuote } from '../lib/report';
import { defaultRetry, isSnapshot, observedFromDetail, questionProgress, recoveryNotice, recoveryStep, type FailedOp, type ObservedSession, type RecoveryStep } from '../lib/session-view';
import type { AppErrorBody, MaterialsDraft, SessionDetail, Snapshot } from '../types';

interface SessionPageProps {
  sid: string;
  setup?: MaterialsDraft;
  preview?: Snapshot;
  onSetupConsumed(): void;
  onNavigate(path: string): void;
}

type AudioStatus = 'connecting' | 'idle' | 'listening' | 'playing' | 'paused' | 'closed' | 'offline';

function toErrorBody(caught: unknown, fallback: AppErrorBody): AppErrorBody {
  return caught instanceof ApiError ? caught.body : fallback;
}

export function SessionPage({ sid, setup, preview, onSetupConsumed, onNavigate }: SessionPageProps) {
  /**
   * `detail` 与 `snapshot` 是**两种不同的东西**（P0-1）：
   * 详情接口没有 `machine`，只有 WS `state`／动作响应里的 `{snapshot}` 才是 live 快照。
   * 之前把详情当快照塞进去，真实路径一进页面就崩在 `machine.questionIndex`。
   */
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(preview ?? null);
  const [transcript, setTranscript] = useState(preview ? '我负责把每周的用户反馈拆成三类，先与产研确认优先级。' : '');
  const [finalTranscript, setFinalTranscript] = useState(false);
  const [audioStatus, setAudioStatus] = useState<AudioStatus>(preview ? 'listening' : 'connecting');
  const [offline, setOffline] = useState(false);
  const [recording, setRecording] = useState(preview !== undefined);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(preview === undefined);
  const [error, setError] = useState<AppErrorBody | null>(null);
  const [notice, setNotice] = useState('');
  const audioRef = useRef<RealtimeAudio | null>(null);
  const setupRef = useRef(setup);
  /** 失败的那一步：恢复时按它 + 服务端真实状态决定该重发什么（P1-2）。 */
  const failedOpRef = useRef<FailedOp | null>(null);
  const errorRef = useRef<AppErrorBody | null>(null);
  const snapshotRef = useRef<Snapshot | null>(preview ?? null);

  useEffect(() => { errorRef.current = error; }, [error]);
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);

  const applySnapshot = useCallback((next: Snapshot): boolean => {
    if (!isSnapshot(next)) return false;
    snapshotRef.current = next;
    setSnapshot(next);
    setBusy(false);
    if (next.lastError !== null) setError(next.lastError);
    return true;
  }, []);

  useEffect(() => {
    if (preview !== undefined) return;
    let active = true;
    const runtime = new RealtimeAudio({
      onSnapshot: (next) => {
        if (!active) return;
        // 收到服务端权威快照即视为连接已恢复，解除离线禁用。
        setOffline(false);
        setError((current) => (current !== null && current.code === 'E_OFFLINE' ? null : current));
        if (!applySnapshot(next)) return;
        if (next.state === 'rewrite') setRecording(false);
        if (next.state === 'ended' && next.report !== null) onNavigate(`/report/${encodeURIComponent(sid)}`);
      },
      onTranscript: (text, final) => {
        if (!active) return;
        setTranscript(text);
        setFinalTranscript(final);
      },
      onError: (nextError) => {
        if (!active) return;
        setError(nextError);
        setBusy(false);
        if (nextError.code === 'E_OFFLINE') setOffline(true);
        if (nextError.halt === true) setRecording(false);
      },
      onStatus: (status) => {
        if (!active) return;
        setAudioStatus(status);
        if (status === 'offline') setOffline(true);
      },
    });
    audioRef.current = runtime;
    void (async () => {
      try {
        const loaded = await api.detail(sid);
        if (!active) return;
        setDetail(loaded);
        if (!loaded.live) {
          // 历史会话没有跑着的状态机：有报告就去报告页，没有就明说不能继续作答。
          if (loaded.report !== null) {
            onNavigate(`/report/${encodeURIComponent(sid)}`);
            return;
          }
          setError({ code: 'E_CONFLICT', message: '这场练习已经是历史记录', hint: '历史记录不能继续作答；可以新建一场继续练，或在历史里删除它' });
          setBusy(false);
          return;
        }
        await runtime.connect(sid);
        if (!active) return;
        if (setupRef.current !== undefined) {
          const draft = setupRef.current;
          failedOpRef.current = { kind: 'materials', draft };
          const response = await api.action(sid, 'materials', draft);
          if (!active) return;
          failedOpRef.current = null;
          applySnapshot(response.snapshot);
          setupRef.current = undefined;
          onSetupConsumed();
        }
      } catch (caught) {
        if (!active) return;
        setError(toErrorBody(caught, { code: 'E_OFFLINE', message: '网络连接中断', hint: '检查本地服务后重新连接' }));
        setBusy(false);
      }
    })();
    return () => {
      active = false;
      failedOpRef.current = null;
      void runtime.close();
      audioRef.current = null;
    };
  }, [applySnapshot, onNavigate, onSetupConsumed, preview, sid]);

  const questionCount = snapshot?.plan?.questions.length ?? 0;
  const questionIndex = snapshot?.machine.questionIndex ?? 0;
  const currentQuestionId = snapshot?.currentQuestion?.id;
  const latestInterviewerTurn = useMemo(() => {
    if (snapshot === null || currentQuestionId === undefined) return null;
    return [...snapshot.turns].reverse().find((turn) => turn.questionId === currentQuestionId && turn.speaker === 'interviewer') ?? null;
  }, [currentQuestionId, snapshot]);
  const questionText = latestInterviewerTurn?.rawTranscript || snapshot?.currentQuestion?.text || '正在准备这道题';
  const progress = useMemo(() => questionProgress(snapshot?.plan ?? null, questionIndex), [snapshot?.plan, questionIndex]);
  const feedback = currentQuestionId === undefined ? undefined : snapshot?.reviews[currentQuestionId];
  const basis = currentQuestionId === undefined ? undefined : snapshot?.reviewBasis[currentQuestionId];
  const quotes = useMemo(() => {
    if (feedback === undefined) return [];
    const seen = new Set<string>();
    return Object.values(feedback.dimensions)
      .map((dimension) => verifiedQuote(basis, dimension.quote))
      .filter((quote): quote is NonNullable<typeof quote> => quote !== null)
      .filter((quote) => !seen.has(quote.text) && seen.add(quote.text));
  }, [basis, feedback]);
  const state = snapshot?.state;
  const waitingReview = state === 'review' || busy;
  const atRewrite = state === 'rewrite';
  const toggles = snapshot?.toggles ?? detail?.toggles ?? null;
  const locked = busy || offline;

  const startAnswer = useCallback(async () => {
    failedOpRef.current = { kind: 'answer_start' };
    setError(null);
    setNotice('');
    const sent = await audioRef.current?.startAnswer();
    setRecording(audioRef.current?.isCapturing === true);
    if (sent !== false) failedOpRef.current = null;
  }, []);

  const commitAnswer = useCallback(async () => {
    failedOpRef.current = { kind: 'answer_commit' };
    setBusy(true);
    setError(null);
    setFinalTranscript(false);
    const sent = await audioRef.current?.commitAnswer();
    setRecording(false);
    if (sent !== false) failedOpRef.current = null;
  }, []);

  const action = useCallback(async (name: string, body?: unknown) => {
    if (preview !== undefined) return;
    failedOpRef.current = { kind: 'http', name, ...(body === undefined ? {} : { body }) };
    setBusy(true);
    setError(null);
    try {
      const response = await api.action(sid, name, body);
      failedOpRef.current = null;
      applySnapshot(response.snapshot);
      if (response.snapshot.state === 'ended') onNavigate(`/report/${encodeURIComponent(sid)}`);
    } catch (caught) {
      setError(toErrorBody(caught, { code: 'E_OFFLINE', message: '网络连接中断' }));
    } finally {
      setBusy(false);
    }
  }, [applySnapshot, onNavigate, preview, sid]);

  /**
   * 恢复：先和服务端对账，再按失败阶段选动作；对不上就明确说不能重试，
   * 绝不发一个注定被状态机拒绝的请求（P1-2）。
   *
   * `allowDefaultStart` 只由用户显式点「再试一次」打开——重连本身不是「重试上一次操作」，
   * 不允许借重连自动开麦。
   */
  const runRecovery = useCallback(async (allowDefaultStart: boolean) => {
    const op = failedOpRef.current;
    let observed: ObservedSession | null = snapshotRef.current === null
      ? null
      : { state: snapshotRef.current.state, planReady: snapshotRef.current.plan !== null };
    if (op !== null && (op.kind === 'materials' || op.kind === 'answer_commit')) {
      const fresh = await api.detail(sid).catch(() => null);
      if (fresh !== null) observed = observedFromDetail(fresh);
    }
    let step: RecoveryStep;
    if (errorRef.current?.halt === true || errorRef.current?.code === 'E_QUOTA') step = { type: 'none', reason: 'halted' };
    else if (op === null) step = allowDefaultStart ? defaultRetry(observed) : { type: 'none', reason: 'no_context' };
    else step = recoveryStep(op, observed, errorRef.current);

    if (step.type === 'refresh') {
      setNotice('还没拿到服务端的真实状态，等连接恢复后再试一次。');
      return;
    }
    if (step.type === 'none') {
      // 重连只是恢复链路，不冒充「重试」，所以不额外提示。
      if (allowDefaultStart) setNotice(recoveryNotice(step));
      return;
    }
    setNotice('');
    if (step.type === 'http') return action(step.name, step.body);
    if (step.type === 'resend_commit') return commitAnswer();
    if (step.type === 'start_answer') return startAnswer();
  }, [action, commitAnswer, sid, startAnswer]);

  const handleErrorAction = (next: string) => {
    if (next === 'repeat') { setNotice(''); audioRef.current?.repeatQuestion(); }
    if (next === 'permission') void startAnswer();
    if (next === 'retry') void runRecovery(true);
    if (next === 'end') void action('end');
    if (next === 'reconnect') {
      void (async () => {
        await audioRef.current?.reconnect(sid).catch(() => undefined);
        await runRecovery(false);
      })();
    }
    if (next === 'settings') onNavigate('/privacy');
    if (next === 'home') onNavigate('/');
  };

  return (
    <div className="page page--session">
      <a className="skip-link" href="#session-main">跳到主要内容</a>
      <BrandHeader onNavigate={onNavigate} compact />
      <main id="session-main" className="session-main">
        <aside className="session-rail">
          <div className="question-count"><strong>{String(questionIndex + 1).padStart(2, '0')}</strong><span>/ {String(Math.max(questionCount, 1)).padStart(2, '0')}</span></div>
          <div className="toy-stage toy-stage--session">
            <img src="/characters/char-listening.png" width="1024" height="956" alt="小八正在倾听" />
            <i aria-hidden="true" />
            <span className={`listen-dot${audioStatus === 'listening' ? ' is-live' : ''}`}><Waveform size={16} weight="bold" aria-hidden="true" />{audioStatus === 'playing' ? '小八正在说' : audioStatus === 'paused' ? '已暂停' : offline || audioStatus === 'closed' ? '连接已断开' : '小八在听'}</span>
          </div>
          <ol className="question-progress" aria-label="面试进度">
            {progress === null ? (
              <li className="is-loading"><span>正在准备</span>题目加载中…</li>
            ) : progress.map((item) => (
              <li key={item.key} className={item.done ? 'is-done' : item.current ? 'is-current' : ''}>
                <span>{item.done ? '已完成' : item.current ? '当前' : '待回答'}</span>
                {item.label}
              </li>
            ))}
          </ol>
          <p className="save-status">历史 {toggles?.saveHistory ? '开' : '关'} <span /> 录音 {toggles?.saveAudio ? '开' : '关'}</p>
        </aside>

        <section className="interview-stage" aria-busy={waitingReview}>
          <div className="question-bubble">
            <span className="speaker-label">小八问</span>
            <h1>{questionText}</h1>
            <p>{snapshot?.currentQuestion?.intent ?? '用具体事实回答，不用追求完美。'}</p>
          </div>

          <div className={`answer-bubble${recording ? ' is-recording' : ''}`}>
            <span className="speaker-label speaker-label--answer">你的回答</span>
            {transcript === '' ? (
              <p className="transcript-empty">{recording ? '开始说吧，转写会出现在这里。' : '点击“开始作答”后，再开始说。'}</p>
            ) : (
              <p className="transcript-text">{transcript}<span className={finalTranscript ? 'transcript-final' : 'transcript-caret'} aria-label={finalTranscript ? '已确认转写' : '正在转写'} /></p>
            )}
          </div>

          {error !== null ? <ErrorState error={error} onAction={handleErrorAction} /> : null}

          <section className="evidence-strip" aria-labelledby="evidence-title">
            <div>
              <h2 id="evidence-title">评审用到的你的原话</h2>
              <p>这里只展示已被评审引用的片段，不是全部实时转写。</p>
            </div>
            <div className="evidence-list">
              {quotes.length > 0 ? quotes.map((quote) => <q key={`${quote.turnId}-${quote.start}`}>{quote.text}</q>) : (
                <p className="evidence-empty">这道题暂时没有可引用的原话。你可以继续作答，或在点评后重答一次。</p>
              )}
            </div>
          </section>

          <div className="session-controls">
            <div className="control-secondary">
              <button type="button" onClick={() => audioRef.current?.repeatQuestion()} disabled={locked}><SpeakerHigh size={18} weight="bold" aria-hidden="true" />重听本题</button>
              <button type="button" onClick={() => { if (paused) audioRef.current?.resume(); else audioRef.current?.pause(); setPaused(!paused); }} disabled={locked}>
                {paused ? <Play size={18} weight="fill" aria-hidden="true" /> : <Pause size={18} weight="fill" aria-hidden="true" />}{paused ? '恢复' : '暂停'}
              </button>
              <button type="button" onClick={() => { const count = audioRef.current?.interrupt() ?? 0; setNotice(`已打断，清空 ${count} 段本地待播音频`); }} disabled={locked}><HandPalm size={18} weight="bold" aria-hidden="true" />打断</button>
            </div>
            <div className="control-primary">
              {atRewrite ? (
                <>
                  <button className="button button--paper" type="button" onClick={() => void action('rewrite/start')} disabled={locked}><ArrowCounterClockwise size={18} weight="bold" aria-hidden="true" />重答一次</button>
                  <button className="button button--primary" type="button" onClick={() => void action('next')} disabled={locked}>下一题<ArrowRight size={18} weight="bold" aria-hidden="true" /></button>
                </>
              ) : waitingReview ? (
                <button className="button button--primary" type="button" disabled><span className="button-pulse" />正在核对你的原话</button>
              ) : recording ? (
                <button className="button button--primary" type="button" onClick={() => void commitAnswer()} disabled={offline}><Stop size={18} weight="fill" aria-hidden="true" />说完了</button>
              ) : (
                <button className="button button--primary" type="button" onClick={() => void startAnswer()} disabled={offline || (state !== 'answer' && state !== 'followup')}><Microphone size={19} weight="fill" aria-hidden="true" />开始作答</button>
              )}
            </div>
          </div>
          {notice ? <p className="session-notice" role="status">{notice}</p> : null}
          <details className="structure-hint"><summary>如何讲清楚表达结构</summary><p>{ENTRY_HINTS.structureQuoteProcedure}</p></details>
        </section>
      </main>
    </div>
  );
}
