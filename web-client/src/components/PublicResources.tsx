import content from '../public-content.json';

/** Public information remains visible after React takes over the initial HTML. */
export function PublicResources() {
  return <section className="public-resources" aria-labelledby="public-resources-title">
    <h2 id="public-resources-title">岗位面试练习与使用说明</h2>
    <p>{content.summary}</p>
    <div className="quotable-summary"><strong>练习内容：</strong>{content.quotable_summary} 最近更新：{content.updated_at}。</div>
    <nav aria-label="岗位面试练习库"><ul>{content.roles.map(role => <li key={role.path}><a href={role.path}>{role.title}</a></li>)}</ul><a href="/roles/">查看全部岗位练习 →</a></nav>
    <h2>常见问题</h2>
    {content.faqs.map(faq => <details key={faq.q}><summary>{faq.q}</summary><p>{faq.a}</p></details>)}
    <p>作者：<a href="https://albertou.redboook.cn/" target="_blank" rel="noopener noreferrer">欧八同学</a>，9 年产品经验，曾任职网易、搜狐、MINISO。<a href="https://github.com/ouxxyy/ai-interviewer" target="_blank" rel="noopener noreferrer">查看开源代码与本地运行说明</a>。</p>
  </section>;
}
