import { trackEvent } from '../lib/analytics';
import { FileArrowUp, HardDrives, LockKey, Paperclip, ShieldCheck, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { BrandHeader } from '../components/BrandHeader';
import { ErrorState } from '../components/ErrorState';
import { effectiveSaveAudio, sessionCreateBody, sessionToggles, togglesEqual, type Toggles } from '../lib/privacy';
import type { AppErrorBody, MaterialsDraft, Stage, WebSettings } from '../types';

interface HomePageProps {
  settings: WebSettings;
  onNavigate(path: string): void;
  onSessionReady(sid: string, materials: MaterialsDraft): void;
}

type UploadTarget = 'jd' | 'experience';
type Attachment = { name: string; text: string; chars: number; kind: string; note?: string };

export function HomePage({ settings, onNavigate, onSessionReady }: HomePageProps) {
  const [jd, setJd] = useState('');
  const [experience, setExperience] = useState('');
  const [targetRole, setTargetRole] = useState('');
  const [stage, setStage] = useState<Stage | ''>('');
  const [toggleState, setToggleState] = useState<Toggles>(() => sessionToggles(settings));
  const [draftSid, setDraftSid] = useState<string | null>(null);
  const [draftToggles, setDraftToggles] = useState<Toggles | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<UploadTarget | null>(null);
  const [attachments, setAttachments] = useState<Record<UploadTarget, Attachment | null>>({ jd: null, experience: null });
  const [error, setError] = useState<AppErrorBody | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const jdRef = useRef<HTMLTextAreaElement>(null);
  const experienceRef = useRef<HTMLTextAreaElement>(null);
  const uploadTarget = useRef<UploadTarget>('experience');

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (jd !== '' || experience !== '' || attachments.jd !== null || attachments.experience !== null) event.preventDefault();
    };
    addEventListener('beforeunload', guard);
    return () => removeEventListener('beforeunload', guard);
  }, [attachments.experience, attachments.jd, experience, jd]);

  /**
   * 草稿会话（上传先建的那一个）一旦开关对不上，就必须删掉重建。
   * 静默复用旧快照＝让用户以为「关掉了保存」，实际仍按旧开关落库（P0-2）。
   */
  const changeToggle = (key: keyof Toggles, value: boolean) => {
    const next: Toggles = key === 'saveHistory'
      ? { saveHistory: value, saveAudio: value ? toggleState.saveAudio : false }
      : { saveHistory: toggleState.saveHistory, saveAudio: effectiveSaveAudio(toggleState.saveHistory, value) };
    setToggleState(next);
    const stale = draftSid !== null && draftToggles !== null && !togglesEqual(draftToggles, next);
    if (stale) {
      const doomed = draftSid;
      setDraftSid(null);
      setDraftToggles(null);
      void api.deleteSession(doomed).catch(() => undefined);
    }
  };

  const ensureSession = async (): Promise<string> => {
    if (draftSid !== null && draftToggles !== null && togglesEqual(draftToggles, toggleState)) return draftSid;
    const body = sessionCreateBody({ saveHistory: toggleState.saveHistory, saveAudio: toggleState.saveAudio });
    const created = await api.createSession(body);
    setDraftSid(created.sid);
    setDraftToggles({ saveHistory: body.saveHistory, saveAudio: body.saveAudio });
    return created.sid;
  };

  const handleUpload = async (file: File | undefined) => {
    if (file === undefined) return;
    const target = uploadTarget.current;
    setUploading(target);
    setError(null);
    try {
      const sid = await ensureSession();
      const parsed = await api.uploadMaterial(sid, file);
      setAttachments((current) => ({ ...current, [target]: { name: file.name, text: parsed.text, chars: parsed.parsed.chars, kind: parsed.parsed.kind, ...(parsed.parsed.note === undefined ? {} : { note: parsed.parsed.note }) } }));
      if (target === 'jd') setJd('');
      else setExperience('');
      setFieldErrors((current) => ({ ...current, [target]: '' }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.body : { code: 'E_PARSE_FAILED', message: '文件没有读出来', hint: '改为粘贴文本' });
    } finally {
      setUploading(null);
    }
  };

  const start = async () => {
    const effectiveJd = attachments.jd?.text ?? jd;
    const effectiveExperience = attachments.experience?.text ?? experience;
    const nextErrors: Record<string, string> = {};
    if (stage === '') nextErrors.stage = '请选择应届或社招';
    if (effectiveJd.trim().length < 10) nextErrors.jd = '请填写至少 10 个字的岗位 JD，或上传附件';
    if (effectiveExperience.trim().length < 30) nextErrors.experience = '请填写至少 30 个字的个人经历，或上传附件';
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || stage === '') {
      requestAnimationFrame(() => {
        if (nextErrors.stage !== undefined) document.querySelector<HTMLInputElement>('input[name="stage"]')?.focus();
        else if (nextErrors.jd !== undefined) jdRef.current?.focus();
        else if (nextErrors.experience !== undefined) experienceRef.current?.focus();
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sid = await ensureSession();
      trackEvent('practice_requested');
      onSessionReady(sid, { jd: effectiveJd.trim(), experience: effectiveExperience.trim(), stage, targetRole: targetRole.trim() });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.body : { code: 'E_OFFLINE', message: '暂时无法创建会话', hint: '检查本地服务后再试' });
      setBusy(false);
    }
  };

  return (
    <div className="page page--home">
      <a className="skip-link" href="#home-main">跳到主要内容</a>
      <BrandHeader onNavigate={onNavigate} />
      <main id="home-main" className="home-main">
        <section className="home-character" aria-label="小八陪你练面试">
          <div className="toy-stage toy-stage--hero">
            <span className="toy-number">OUBA <b>08</b></span>
            <img src="/characters/char-hero.png" width="1024" height="956" alt="小八，欧八面试陪练的潮玩角色" />
            <span className="toy-sticker">今天从哪段经历开始？</span>
            <i aria-hidden="true" />
          </div>
        </section>
        <section className="home-content">
          <div className="home-copy">
            <h1>别背标准答案。<br /><mark>把自己的经历讲清楚。</mark></h1>
            <p>给我岗位 JD 和你的真实经历，小八会用 3 道主题陪你追问、重答和复盘。</p>
          </div>
          <div className="materials-sheet">
            <div className="materials-grid">
              <Field label="目标岗位" htmlFor="target-role" optional>
                <input id="target-role" name="target-role" autoComplete="off" value={targetRole} onChange={(event) => setTargetRole(event.target.value)} placeholder="例如：企业服务高级产品经理…" />
              </Field>
              <fieldset className="stage-picker" aria-describedby={fieldErrors.stage ? 'stage-error' : undefined}>
                <legend>你目前的求职阶段 <span aria-hidden="true">*</span></legend>
                <div>
                  {(['应届', '社招'] as Stage[]).map((value) => (
                    <label key={value} className={stage === value ? 'is-selected' : ''}>
                      <input type="radio" name="stage" value={value} checked={stage === value} onChange={() => setStage(value)} />
                      {value}
                    </label>
                  ))}
                </div>
                {fieldErrors.stage ? <p id="stage-error" className="field-error">{fieldErrors.stage}</p> : null}
              </fieldset>
            </div>
            <Field label="岗位 JD" htmlFor="job-description" error={fieldErrors.jd} action={
              <UploadButton target="jd" busy={uploading === 'jd'} attached={attachments.jd !== null} setTarget={(target) => { uploadTarget.current = target; }} onFile={handleUpload} />
            }>
              {attachments.jd ? <AttachmentChip attachment={attachments.jd} onRemove={() => setAttachments((current) => ({ ...current, jd: null }))} /> : null}
              <textarea ref={jdRef} id="job-description" name="job-description" autoComplete="off" value={jd} onChange={(event) => { setJd(event.target.value); if (attachments.jd !== null) setAttachments((current) => ({ ...current, jd: null })); }} placeholder={attachments.jd ? '已使用上方附件；直接输入会改为使用这里的文字' : '粘贴职位描述，至少 10 个字…'} rows={3} />
            </Field>
            <Field label="你的经历" htmlFor="experience" error={fieldErrors.experience} action={
              <UploadButton target="experience" busy={uploading === 'experience'} attached={attachments.experience !== null} setTarget={(target) => { uploadTarget.current = target; }} onFile={handleUpload} />
            }>
              {attachments.experience ? <AttachmentChip attachment={attachments.experience} onRemove={() => setAttachments((current) => ({ ...current, experience: null }))} /> : null}
              <textarea ref={experienceRef} id="experience" name="experience" autoComplete="off" value={experience} onChange={(event) => { setExperience(event.target.value); if (attachments.experience !== null) setAttachments((current) => ({ ...current, experience: null })); }} placeholder={attachments.experience ? '已使用上方附件；直接输入会改为使用这里的文字' : '粘贴简历或一段想重点练习的经历，至少 30 个字…'} rows={4} />
            </Field>
            {error !== null ? <ErrorState error={error} compact onAction={(action) => {
              if (action === 'paste') (uploadTarget.current === 'jd' ? jdRef.current : experienceRef.current)?.focus();
              if (action === 'retry') void start();
            }} /> : null}
            <div className="save-options" aria-label="本场保存设置">
              <label><input type="checkbox" checked={toggleState.saveHistory} onChange={(event) => changeToggle('saveHistory', event.target.checked)} />保存历史</label>
              <label><input type="checkbox" checked={toggleState.saveAudio} disabled={!toggleState.saveHistory} onChange={(event) => changeToggle('saveAudio', event.target.checked)} />保存录音</label>
              <small>只影响新建的这一场</small>
            </div>
            <button className="button button--primary start-button" type="button" onClick={() => void start()} disabled={busy || uploading !== null}>
              {busy ? '正在准备问题…' : '开始这一场'}
            </button>
            <p className="start-consent">开始即表示你已阅读<a href="/privacy" onClick={(event) => { event.preventDefault(); onNavigate('/privacy'); }}>隐私说明</a>；材料会发送给你配置的百炼模型。</p>
          </div>
        </section>
      </main>
      <footer className="privacy-pills" aria-label="隐私承诺">
        <PrivacyPill icon={HardDrives} text="材料与报告按隐私设置保存" />
        <PrivacyPill icon={ShieldCheck} text="密钥不进浏览器存储" />
        <PrivacyPill icon={LockKey} text="你可随时删除本场记录" />
      </footer>
    </div>
  );
}

function Field({ label, htmlFor, optional = false, error, action, children }: { label: string; htmlFor: string; optional?: boolean; error?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="field-block">
      <div className="field-heading"><label htmlFor={htmlFor}>{label}{optional ? <small>选填</small> : <span aria-hidden="true">*</span>}</label>{action}</div>
      {children}
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}

function UploadButton({ target, busy, attached, setTarget, onFile }: { target: UploadTarget; busy: boolean; attached: boolean; setTarget(target: UploadTarget): void; onFile(file: File | undefined): void }) {
  return (
    <label className="upload-button">
      <FileArrowUp size={16} weight="bold" aria-hidden="true" />
      {busy ? '正在读取' : attached ? '替换附件' : '上传 TXT / PDF / DOCX'}
      <input type="file" accept=".txt,.md,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onClick={() => setTarget(target)} onChange={(event) => { onFile(event.target.files?.[0]); event.currentTarget.value = ''; }} />
    </label>
  );
}

function AttachmentChip({ attachment, onRemove }: { attachment: Attachment; onRemove(): void }) {
  return (
    <div className="attachment-chip" role="status">
      <Paperclip size={17} weight="bold" aria-hidden="true" />
      <span><strong>{attachment.name}</strong><small>已读取 {attachment.chars.toLocaleString('zh-CN')} 字，不在输入框展开</small></span>
      <button type="button" onClick={onRemove} aria-label={`移除附件 ${attachment.name}`}><X size={16} weight="bold" aria-hidden="true" /></button>
    </div>
  );
}

function PrivacyPill({ icon: Icon, text }: { icon: typeof HardDrives; text: string }) {
  return <div><span><Icon size={20} weight="bold" aria-hidden="true" /></span><p>{text}</p></div>;
}
