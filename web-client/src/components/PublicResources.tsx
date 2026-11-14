import content from '../public-content.json';

/** Public information remains visible after React takes over the initial HTML. */
export function PublicResources() {
  return <section className="public-resources" aria-labelledby="public-resources-title">
    <h2 id="public-resources-title">岗位面试练习与使用说明</h2>
    <p>{content.summary}</p>
    <div className="quotable-summary">
      <strong>⚡ 30 秒核心结论（TL;DR）：</strong>
      <strong>1 场自我介绍 + 3 道经历深挖题</strong> · <strong>5 维 3 档原话引用点评</strong> · 覆盖 <strong>5 个高频岗位题库（6 个公开落地页）</strong> · 商业 1v1 模拟面试 <strong>¥500+/小时</strong> vs 本工具平台使用费 <strong>¥0（MIT 开源自托管，仅需自备阿里云百炼 Key）</strong> · 最近更新：<strong>2026-11-14</strong>。
    </div>
    <nav aria-label="岗位面试练习库"><ul>{content.roles.map(role => <li key={role.path}><a href={role.path}>{role.title}</a></li>)}</ul><a href="/roles/">查看全部岗位练习 →</a></nav>
    <h2>常见问题</h2>
    {content.faqs.map(faq => <details key={faq.q}><summary>{faq.q}</summary><p>{faq.a}</p></details>)}
    <p>作者：<a href="https://albertou.redboook.cn/" target="_blank" rel="noopener noreferrer">欧八同学</a>，9 年产品经验，曾任职网易、搜狐、MINISO。<a href="https://github.com/ouxxyy/ai-interviewer" target="_blank" rel="noopener noreferrer">查看开源代码与本地运行说明</a>。</p>
  </section>;
}
