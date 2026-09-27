import { BrandHeader } from '../components/BrandHeader';
import { ErrorState } from '../components/ErrorState';
import type { AppErrorBody } from '../types';

/** 画廊用的演示数据。只属于开发预览入口，不进生产包（见 test/web-client-bundle.test.ts）。 */
const ERROR_PREVIEWS: AppErrorBody[] = [
  { code: 'E_EMPTY_TRANSCRIPT', message: '这一轮没有识别到说话内容' },
  { code: 'E_MIC_DENIED', message: '麦克风权限被拒绝' },
  { code: 'E_OFFLINE', message: '网络不可达' },
  { code: 'E_MODEL_TIMEOUT', message: '模型调用超时' },
  { code: 'E_PARSE_FAILED', message: '文件解析失败' },
  { code: 'E_QUOTA', message: '上游额度不足', halt: true },
];

export function ErrorGalleryPage({ onNavigate }: { onNavigate(path: string): void }) {
  return (
    <div className="page page--errors">
      <BrandHeader onNavigate={onNavigate} compact />
      <main className="error-gallery-main">
        <header><h1>出错时，告诉用户下一步</h1><p>界面只匹配稳定的 error.code，正文优先展示服务端 hint。halt:true 不提供重试。</p></header>
        <div className="error-gallery-grid">
          <section><h2>可以继续的状态</h2>{ERROR_PREVIEWS.slice(0, 5).map((error) => <ErrorState key={error.code} error={error} compact />)}</section>
          <section className="halt-column"><h2>必须停止重试</h2><ErrorState error={ERROR_PREVIEWS[5]!} /></section>
        </div>
      </main>
    </div>
  );
}
