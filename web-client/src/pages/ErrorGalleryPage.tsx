import { BrandHeader } from '../components/BrandHeader';
import { ERROR_PREVIEWS, ErrorState } from '../components/ErrorState';

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
