import { ArrowRight, CalendarBlank, Microphone, Plus, Trash } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { BrandHeader } from '../components/BrandHeader';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorState } from '../components/ErrorState';
import { historyProgress } from '../lib/report';
import type { AppErrorBody, SessionListItem } from '../types';

export function HistoryPage({ onNavigate }: { onNavigate(path: string): void }) {
  const [items, setItems] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState<AppErrorBody | null>(null);
  const [target, setTarget] = useState<SessionListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = () => {
    setError(null);
    void api.listSessions(50, 0)
      .then((result) => setItems(result.items))
      .catch((caught) => setError(caught instanceof ApiError ? caught.body : { code: 'E_OFFLINE', message: '网络连接中断' }));
  };

  useEffect(load, []);

  const remove = async () => {
    if (target === null) return;
    setDeleting(true);
    try {
      const result = await api.deleteSession(target.id);
      if (!result.verified) throw new Error('删除未校验');
      setItems((current) => current?.filter((item) => item.id !== target.id) ?? []);
      setTarget(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.body : { code: 'E_INTERNAL', message: '删除未完成', hint: '记录仍保留，可以再试一次' });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page page--history">
      <BrandHeader onNavigate={onNavigate} />
      <main className="history-main">
        <header className="list-heading"><div><h1>历史练习</h1><p>只展示真实会话，演示会话不会混在这里。</p></div><button className="button button--primary" type="button" onClick={() => onNavigate('/')}><Plus size={18} weight="bold" aria-hidden="true" />开始新的一场</button></header>
        {error !== null ? <ErrorState error={error} onAction={(action) => action === 'home' ? onNavigate('/') : load()} /> : null}
        {items === null ? <div className="history-skeleton"><span /><span /><span /></div> : items.length === 0 ? (
          <section className="empty-history">
            <img src="/characters/char-thinking.png" width="1024" height="956" alt="小八等你开始第一场" />
            <div><h2>还没有练习记录</h2><p>从一段你最想讲清楚的经历开始。</p><button className="button button--primary" type="button" onClick={() => onNavigate('/')}>开始第一场</button></div>
          </section>
        ) : (
          <section className="history-list" aria-label="练习记录">
            {items.map((item) => {
              const progress = historyProgress(item);
              const date = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(item.createdAt));
              return (
                <article key={item.id}>
                  <div className="history-date"><CalendarBlank size={22} weight="bold" aria-hidden="true" /><div><h2>{date}</h2><p>{item.hasReport ? '已生成报告' : '未生成报告'} <i /> 自我介绍：{progress.introductionLabel}</p></div></div>
                  <dl><div><dt>经历题完成</dt><dd>{progress.completedExperienceQuestions}{progress.totalExperienceQuestions !== undefined ? ` / ${progress.totalExperienceQuestions}` : ''}</dd></div><div><dt>对话轮次</dt><dd>{item.turns}</dd></div><div><dt><Microphone size={15} weight="bold" aria-hidden="true" />录音文件</dt><dd>{item.audioFiles}</dd></div></dl>
                  <div className="history-actions">
                    {item.hasReport ? <button className="button button--paper" type="button" onClick={() => onNavigate(`/report/${encodeURIComponent(item.id)}`)}>查看报告<ArrowRight size={16} weight="bold" aria-hidden="true" /></button> : null}
                    <button className="icon-button icon-button--danger" type="button" onClick={() => setTarget(item)} aria-label={`删除 ${date} 的练习`}><Trash size={18} weight="bold" /></button>
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </main>
      {target !== null ? <ConfirmDialog title="删除这场练习？" confirmLabel="确认删除" dangerous busy={deleting} onCancel={() => setTarget(null)} onConfirm={() => void remove()}><p>本场的文本、报告、录音和临时文件都会被删除。</p></ConfirmDialog> : null}
    </div>
  );
}
