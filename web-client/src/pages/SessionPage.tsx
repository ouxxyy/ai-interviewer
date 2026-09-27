import { ArrowCounterClockwise, ArrowRight, HandPalm, Microphone, Pause, Play, SpeakerHigh, Stop, Waveform } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ENTRY_HINTS } from '../../../src/rules/entry-hints';
import { ApiError, api } from '../api';
import { RealtimeAudio } from '../audio';
import { BrandHeader } from '../components/BrandHeader';
import { ErrorState } from '../components/ErrorState';
import { verifiedQuote } from '../lib/report';
import type { AppErrorBody, MaterialsDraft, Snapshot } from '../types';

interface SessionPageProps {
  sid: string;
  setup?: MaterialsDraft;
  preview?: Snapshot;
  onSetupConsumed(): void;
  onNavigate(path: string): void;
}

export function SessionPage({ sid, setup, preview, onSetupConsumed, onNavigate }: SessionPageProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(preview ?? null);
  const [transcript, setTranscript] = useState(preview ? '我负责把每周的用户反馈拆成三类，先与产研确认优先级。' : '');
  const [finalTranscript, setFinalTranscript] = useState(false);
  const [audioStatus, setAudioStatus] = useState<'connecting' | 'idle' | 'listening' | 'playing' | 'paused' | 'closed'>(preview ? 'listening' : 'connecting');
  const [recording, setRecording] = useState(preview !== undefined);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(setup !== undefined);
  const [error, setError] = useState<AppErrorBody | null>(null);
  const [notice, setNotice] = useState('');
  const audioRef = useRef<RealtimeAudio | null>(null);
  const setupRef = useRef(setup);

  useEffect(() => {
    if (preview !== undefined) return;
    let active = true;
    const runtime = new RealtimeAudio({
      onSnapshot: (next) => {
        if (!active) return;
        setSnapshot(next);
        setBusy(false);
        if (next.lastError !== null) setError(next.lastError);
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
        if (nextError.halt === true) setRecording(false);
      },
      onStatus: (status) => active && setAudioStatus(status),
    });
    audioRef.current = runtime;
    void (async () => {
      try {
        const detail = await api.detail(sid);
        if (!active) return;
        setSnapshot(detail);
        if (!detail.live && detail.report !== null) {
          onNavigate(`/report/${encodeURIComponent(sid)}`);
          return;
        }
        await runtime.connect(sid);
        if (!active) return;
        if (setupRef.current !== undefined) {
          const response = await api.action(sid, 'materials', setupRef.current);
          if (!active) return;
          setSnapshot(response.snapshot);
          setupRef.current = undefined;
          onSetupConsumed();
        }
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof ApiError ? caught.body : { code: 'E_OFFLINE', message: '网络连接中断', hint: '检查本地服务后重新连接' });
      } finally {
        if (active) setBusy(false);
      }
    })();
    return () => {
      active = false;
      void runtime.close();
      audioRef.current = null;
    };
  }, [onNavigate, onSetupConsumed, preview, sid]);

  const questionCount = snapshot?.plan?.questions.length ?? 0;
  const questionIndex = snapshot?.machine.questionIndex ?? 0;
  const currentQuestionId = snapshot?.currentQuestion?.id;
  const latestInterviewerTurn = useMemo(() => {
    if (snapshot === null || currentQuestionId === undefined) return null;
    return [...snapshot.turns].reverse().find((turn) => turn.questionId === currentQuestionId && turn.speaker === 'interviewer') ?? null;
  }, [currentQuestionId, snapshot]);
  const questionText = latestInterviewerTurn?.rawTranscript || snapshot?.currentQuestion?.text || '正在准备这道题';
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

  const startAnswer = async () => {
    setError(null);
    setNotice('');
    await audioRef.current?.startAnswer();
    setRecording(audioRef.current?.isCapturing === true);
  };

  const commitAnswer = async () => {
    setBusy(true);
    setError(null);
    setFinalTranscript(false);
    await audioRef.current?.commitAnswer();
    setRecording(false);
  };

  const action = async (name: string) => {
    if (preview !== undefined) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.action(sid, name);
      setSnapshot(response.snapshot);
      if (response.snapshot.state === 'ended') onNavigate(`/report/${encodeURIComponent(sid)}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.body : { code: 'E_OFFLINE', message: '网络连接中断' });
    } finally {
      setBusy(false);
    }
  };

  const handleErrorAction = (next: string) => {
    if (next === 'repeat') audioRef.current?.repeatQuestion();
    if (next === 'permission' || next === 'retry') void startAnswer();
    if (next === 'end') void action('end');
    if (next === 'reconnect') void audioRef.current?.reconnect(sid);
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
            <span className={`listen-dot${audioStatus === 'listening' ? ' is-live' : ''}`}><Waveform size={16} weight="bold" aria-hidden="true" />{audioStatus === 'playing' ? '小八正在说' : audioStatus === 'paused' ? '已暂停' : '小八在听'}</span>
          </div>
          <ol className="question-progress" aria-label="面试进度">
            {Array.from({ length: Math.max(questionCount, 3) }, (_, index) => (
              <li key={index} className={index < questionIndex ? 'is-done' : index === questionIndex ? 'is-current' : ''}>
                <span>{index < questionIndex ? '已完成' : index === questionIndex ? '当前' : '待回答'}</span>
                第 {index + 1} 题
              </li>
            ))}
          </ol>
          <p className="save-status">历史 {snapshot?.toggles.saveHistory ? '开' : '关'} <span /> 录音 {snapshot?.toggles.saveAudio ? '开' : '关'}</p>
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
              <button type="button" onClick={() => audioRef.current?.repeatQuestion()} disabled={busy}><SpeakerHigh size={18} weight="bold" aria-hidden="true" />重听本题</button>
              <button type="button" onClick={() => { if (paused) audioRef.current?.resume(); else audioRef.current?.pause(); setPaused(!paused); }} disabled={busy}>
                {paused ? <Play size={18} weight="fill" aria-hidden="true" /> : <Pause size={18} weight="fill" aria-hidden="true" />}{paused ? '恢复' : '暂停'}
              </button>
              <button type="button" onClick={() => { const count = audioRef.current?.interrupt() ?? 0; setNotice(`已打断，清空 ${count} 段本地待播音频`); }} disabled={busy}><HandPalm size={18} weight="bold" aria-hidden="true" />打断</button>
            </div>
            <div className="control-primary">
              {atRewrite ? (
                <>
                  <button className="button button--paper" type="button" onClick={() => void action('rewrite/start')} disabled={busy}><ArrowCounterClockwise size={18} weight="bold" aria-hidden="true" />重答一次</button>
                  <button className="button button--primary" type="button" onClick={() => void action('next')} disabled={busy}>下一题<ArrowRight size={18} weight="bold" aria-hidden="true" /></button>
                </>
              ) : waitingReview ? (
                <button className="button button--primary" type="button" disabled><span className="button-pulse" />正在核对你的原话</button>
              ) : recording ? (
                <button className="button button--primary" type="button" onClick={() => void commitAnswer()}><Stop size={18} weight="fill" aria-hidden="true" />说完了</button>
              ) : (
                <button className="button button--primary" type="button" onClick={() => void startAnswer()} disabled={state !== 'answer' && state !== 'followup'}><Microphone size={19} weight="fill" aria-hidden="true" />开始作答</button>
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
