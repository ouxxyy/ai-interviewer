import { ArrowCounterClockwise, ClockCounterClockwise, Paperclip, Trash } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api';
import { BrandHeader } from '../components/BrandHeader';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorState } from '../components/ErrorState';
import { highlightAdded, questionAnswer, representativeDimension, verifiedQuote } from '../lib/report';
import type { AppErrorBody, DimensionKey, Feedback, SessionDetail } from '../types';

const DIMENSIONS: Array<{ key: DimensionKey; label: string }> = [
  { key: 'relevance', label: '切题' },
  { key: 'specificity', label: '事例具体性' },
  { key: 'contribution', label: '个人贡献' },
  { key: 'resultsReflection', label: '结果与反思' },
  { key: 'structure', label: '表达结构' },
];

const LEVEL_RANK = { '证据不足': 0, '部分清楚': 1, '充分清楚': 2, '无法判断': 99 } as const;

interface ReportPageProps {
  sid: string;
  preview?: SessionDetail;
  onNavigate(path: string): void;
}

export function ReportPage({ sid, preview, onNavigate }: ReportPageProps) {
  const [detail, setDetail] = useState<SessionDetail | null>(preview ?? null);
  const [error, setError] = useState<AppErrorBody | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  useEffect(() => {
    if (preview !== undefined) return;
    let active = true;
    void api.detail(sid)
      .then((result) => active && setDetail(result))
      .catch((caught) => active && setError(caught instanceof ApiError ? caught.body : { code: 'E_OFFLINE', message: '网络连接中断' }));
    return () => { active = false; };
  }, [preview, sid]);

  const report = detail?.report;
  const feedbacks = useMemo(() => detail?.report?.perQuestion.map((item) => item.feedback).filter((item): item is Feedback => item !== null) ?? [], [detail]);
  const dimensions = useMemo(() => DIMENSIONS.map((item) => ({ ...item, feedback: representativeDimension(feedbacks, item.key) })), [feedbacks]);
  const worstKey = useMemo(() => [...dimensions].filter((item) => item.feedback.level !== '无法判断').sort((a, b) => LEVEL_RANK[a.feedback.level] - LEVEL_RANK[b.feedback.level])[0]?.key, [dimensions]);
  const quotes = useMemo(() => {
    const currentReport = detail?.report;
    if (detail === null || currentReport == null) return [];
    const seen = new Set<string>();
    return currentReport.perQuestion.flatMap((question, questionIndex) => {
      if (question.feedback === null) return [];
      const basis = detail.reviewBasis[question.questionId];
      return Object.values(question.feedback.dimensions).flatMap((dimension) => {
        const quote = verifiedQuote(basis, dimension.quote);
        if (quote === null || seen.has(`${question.questionId}:${quote.text}`)) return [];
        seen.add(`${question.questionId}:${quote.text}`);
        const turn = detail.turns.find((candidate) => candidate.id === quote.turnId);
        return [{ quote, questionIndex, turnType: turn?.turnType ?? 'answer' }];
      });
    });
  }, [detail]);
  const comparison = useMemo(() => {
    if (detail === null) return null;
    const questionId = Object.keys(detail.rewriteDeltas).find((id) => questionAnswer(detail.turns, id, 'rewrite') !== '');
    if (questionId === undefined) return null;
    const initial = questionAnswer(detail.turns, questionId, 'initial');
    const rewrite = questionAnswer(detail.turns, questionId, 'rewrite');
    const index = detail.plan?.questions.findIndex((question) => question.id === questionId) ?? -1;
    return { questionId, initial, rewrite, index: index + 1, delta: detail.rewriteDeltas[questionId] };
  }, [detail]);

  if (error !== null) {
    return <div className="page"><BrandHeader onNavigate={onNavigate} /><main className="standalone-state"><ErrorState error={error} onAction={(action) => action === 'home' ? onNavigate('/') : location.reload()} /></main></div>;
  }
  if (detail === null || report == null) {
    return <div className="page"><BrandHeader onNavigate={onNavigate} /><main className="report-loading" aria-live="polite"><span className="skeleton-line skeleton-line--title" /><span className="skeleton-panel" /></main></div>;
  }

  const created = new Date(detail.createdAt);
  const updated = new Date(detail.updatedAt);
  const dateLabel = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(created);
  const minutes = Math.max(1, Math.round((updated.getTime() - created.getTime()) / 60_000));
  const durationLabel = new Intl.NumberFormat('zh-CN').format(minutes);
  const rewriteCount = Object.keys(detail.rewriteDeltas).length;
  const topImprovement = report.priorityPractice[0] ?? feedbacks[0]?.topImprovement ?? '继续用更具体的事实补强回答。';
  const sourceLabel = detail.reportSource === 'model_priority_practice' ? '模型报告' : detail.reportSource === 'derived_from_validated_feedback' ? '由已校验逐题反馈派生' : '零完成题固定说明';
  const hasDegraded = detail.reviewMeta.some((item) => item.kind === 'degraded');

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      const result = await api.deleteSession(sid);
      if (!result.verified) throw new Error('删除结果未验证');
      onNavigate('/history');
    } catch (caught) {
      setShowDelete(false);
      setError(caught instanceof ApiError ? caught.body : { code: 'E_INTERNAL', message: '删除未完成', hint: '本场记录仍然保留，可以再试一次' });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page page--report">
      <a className="skip-link" href="#report-main">跳到主要内容</a>
      <BrandHeader onNavigate={onNavigate} compact />
      <main id="report-main" className="report-main">
        <header className="report-heading">
          <div>
            <h1>本场复盘 <span>{dateLabel}</span></h1>
            <p>{report.completedQuestions} / {report.totalQuestions} 题 <i /> {durationLabel} 分钟 <i /> 重答 {rewriteCount} 次</p>
            <small>{sourceLabel}{hasDegraded ? '，部分题为降级评审' : ''}</small>
          </div>
          <div className="report-character">
            <div className="say-card">这一场，你已经把自己的做法讲得更清楚了。</div>
            <img src="/characters/char-cheer.png" width="1024" height="956" alt="小八为你加油" />
          </div>
        </header>

        <section className="dimension-grid" aria-labelledby="dimension-title">
          <h2 id="dimension-title" className="sr-only">五维反馈</h2>
          {dimensions.map((dimension) => (
            <article key={dimension.key} className={`dimension-card${dimension.feedback.level === '无法判断' ? ' dimension-card--unknown' : ''}${dimension.key === worstKey ? ' dimension-card--worst' : ''}`}>
              {dimension.key === worstKey ? <span className="worst-sticker">最值得改</span> : null}
              <h3>{dimension.label}</h3>
              <strong>{dimension.feedback.level}</strong>
              {dimension.feedback.level === '无法判断' ? <p>没有足够原话，不并入三档</p> : <LevelDots level={dimension.feedback.level} />}
            </article>
          ))}
        </section>

        <section className="priority-card">
          <span>!</span>
          <div><h2>最值得改的一处</h2><p>{topImprovement}</p></div>
        </section>

        <section className="report-section" aria-labelledby="report-quotes-title">
          <div className="section-heading"><h2 id="report-quotes-title">评审用到的你的原话</h2><p>锚点来自服务端的评审基准文本</p></div>
          {quotes.length > 0 ? (
            <div className="quote-grid">
              {quotes.map(({ quote, questionIndex, turnType }) => (
                <blockquote key={`${quote.turnId}-${quote.start}`}>
                  <Paperclip size={20} weight="bold" aria-hidden="true" />
                  <div><p>「{quote.text}」</p><cite>第 {questionIndex + 1} 题 <i /> {turnType === 'rewrite' ? '重答原话' : '初答原话'}</cite></div>
                </blockquote>
              ))}
            </div>
          ) : <p className="report-empty">本场评审没有引用可定位的原话。逐题反馈仍会保留，但这里不会补造证据。</p>}
        </section>

        <section className="report-section" aria-labelledby="compare-title">
          <div className="section-heading"><h2 id="compare-title">初答 vs 重答</h2><p>新增片段只按已验证子串高亮</p></div>
          {comparison === null ? <p className="report-empty">本场没有完成重答，暂时没有对照内容。</p> : (
            <div className="compare-grid">
              <article><span>初答 <i /> 第 {comparison.index} 题</span><p>{comparison.initial}</p></article>
              <article className="compare-rewrite"><span>重答 <i /> 第 {comparison.index} 题</span><p>{highlightAdded(comparison.rewrite, comparison.delta).map((part, index) => part.marked ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</p></article>
            </div>
          )}
        </section>

        <div className="report-actions">
          <button className="button button--primary" type="button" onClick={() => onNavigate('/')}><ArrowCounterClockwise size={18} weight="bold" aria-hidden="true" />再练一场</button>
          <button className="button button--paper" type="button" onClick={() => onNavigate('/history')}><ClockCounterClockwise size={18} weight="bold" aria-hidden="true" />查看历史练习</button>
          <button className="button button--text-danger" type="button" onClick={() => setShowDelete(true)}><Trash size={17} weight="bold" aria-hidden="true" />删除本场记录</button>
        </div>
      </main>
      {showDelete ? <ConfirmDialog title="删除这场练习？" confirmLabel="确认删除" dangerous busy={deleting} onCancel={() => setShowDelete(false)} onConfirm={() => void confirmDelete()}><p>会一并删除数据库记录、录音和该会话的临时文件。这个操作无法撤销。</p></ConfirmDialog> : null}
    </div>
  );
}

function LevelDots({ level }: { level: '证据不足' | '部分清楚' | '充分清楚' }) {
  const count = level === '证据不足' ? 1 : level === '部分清楚' ? 2 : 3;
  return <div className="level-dots" aria-label={`${level}，三档中第 ${count} 档`}>{[0, 1, 2].map((index) => <i key={index} className={index < count ? 'is-filled' : ''} />)}</div>;
}
