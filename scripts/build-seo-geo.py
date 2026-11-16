#!/usr/bin/env python3
"""Generate public discovery files and initial HTML from current curated sources.
Role pages are authored in web-client/public/roles; never overwrite runtime code.
"""
from pathlib import Path
from html.parser import HTMLParser
from html import escape
import json,re
ROOT=Path(__file__).resolve().parents[1];WEB=ROOT/'web-client';PUBLIC=WEB/'public'
DOMAIN='https://interview.redboook.cn';AUTHOR='https://albertou.redboook.cn/';DATE='2026-11-16'
AI_BOTS=('OAI-SearchBot','ChatGPT-User','PerplexityBot','Claude-SearchBot','ClaudeBot','Google-Extended','Bingbot','Applebot-Extended')
class Text(HTMLParser):
 def __init__(self):super().__init__();self.skip=0;self.parts=[]
 def handle_starttag(self,tag,attrs):
  if tag in ('script','style'):self.skip+=1
 def handle_endtag(self,tag):
  if tag in ('script','style'):self.skip-=1
 def handle_data(self,data):
  if not self.skip and data.strip():self.parts.append(data.strip())
def build():
 content=json.loads((WEB/'src/public-content.json').read_text())
 faqs=content['faqs'];roles=content['roles']
 schema={'@context':'https://schema.org','@graph':[{'@type':'SoftwareApplication','@id':DOMAIN+'/#app','name':'欧八面试陪练','url':DOMAIN+'/','applicationCategory':'EducationalApplication','operatingSystem':'Web','dateModified':DATE,'license':'https://opensource.org/license/mit','offers':{'@type':'Offer','price':'0','priceCurrency':'CNY','description':'平台工具不收取使用费；用户自备百炼 API Key，模型调用费用由用户承担。'},'description':content['summary'],'author':{'@type':'Person','name':'欧八同学','url':AUTHOR}},{'@type':'FAQPage','@id':DOMAIN+'/#faq','mainEntity':[{'@type':'Question','name':f['q'],'acceptedAnswer':{'@type':'Answer','text':f['a']}} for f in faqs]}]}
 links='<ul>'+''.join('<li><a href="'+r['path']+'">'+escape(r['title'])+'</a></li>' for r in roles)+'</ul><a href="/roles/">查看全部岗位练习 →</a>'
 faq_html=''.join('<details><summary>'+escape(f['q'])+'</summary><p>'+escape(f['a'])+'</p></details>' for f in faqs)
 quotable_html=f'<div class="quotable-summary"><strong>练习内容：</strong>{escape(content["quotable_summary"])} 最近更新：{DATE}。</div>'
 initial=f'''<header class="brand-header"><a class="brand-mark" href="/"><span>8</span><strong>欧八面试陪练</strong></a><nav aria-label="公开导航"><a href="/roles/">岗位面试练习库</a> · <a href="{AUTHOR}">欧八同学咨询</a></nav></header>
+<main class="public-resources"><h1>{escape(content['headline'])}</h1><p>{escape(content['summary'])}</p>{quotable_html}<p>首次使用请先配置自己的百炼 API Key。平台工具不收取使用费，模型调用费用由用户承担。</p><noscript><p>在线训练需要启用 JavaScript；下方岗位练习与使用说明可直接阅读。</p></noscript><h2>岗位面试练习与使用说明</h2>{links}<h2>常见问题</h2>{faq_html}<p>作者：<a href="{AUTHOR}">欧八同学</a>，9 年产品经验，曾任职网易、搜狐、MINISO。<a href="https://github.com/ouxxyy/ai-interviewer">查看开源代码与本地运行说明</a>。</p></main>'''.replace('\n+','\n')
 index=f'''<!doctype html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#eef4f6">
<title>{escape(content['title'])}</title>
<meta name="description" content="{escape(content['description'], quote=True)}">
<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large"><link rel="canonical" href="{DOMAIN}/">
<meta property="og:type" content="website"><meta property="og:url" content="{DOMAIN}/"><meta property="og:title" content="{escape(content['title'], quote=True)}"><meta property="og:description" content="先配置自己的百炼 API Key，再结合岗位与真实经历练习自我介绍、追问和复盘。">
<script type="application/ld+json">{json.dumps(schema,ensure_ascii=False,separators=(',',':'))}</script>
<script defer src="/ouba-analytics.js?v=2" data-proxy="same-origin" data-website-id="4897cfc4-d00f-47b5-b150-07db3748db54" data-domain="interview.redboook.cn" data-title="欧八面试陪练"></script>
</head><body><div id="root">{initial}</div><script type="module" src="/src/main.tsx"></script></body></html>
'''
 (WEB/'index.html').write_text(index)
 pages=sorted((PUBLIC/'roles').glob('*.html'));assert len(pages)==6
 entries=[(DOMAIN+'/','欧八面试陪练')];texts=[]
 for p in pages:
  body=p.read_text();title=re.search(r'<title>(.*?)</title>',body,re.S)[1];canonical=re.search(r'<link rel="canonical" href="([^"]+)"',body)
  url=canonical[1] if canonical else DOMAIN+'/roles/'+p.name
  assert url.startswith(DOMAIN+'/roles/') and body.count('<h1')==1
  assert 'index-B50kyzIk.css' not in body
  for raw in re.findall(r'<script type="application/ld\+json">(.*?)</script>',body,re.S):json.loads(raw)
  entries.append((url,title));t=Text();t.feed(body);texts.append('## '+title+'\n来源：'+url+'\n\n'+'\n'.join(t.parts))
 ai_rules=''.join(f'User-agent: {bot}\nAllow: /\nDisallow: /api/\nDisallow: /harness\nDisallow: /realtime\n\n' for bot in AI_BOTS)
 (PUBLIC/'robots.txt').write_text(f'{ai_rules}User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /harness\nDisallow: /realtime\n\nSitemap: {DOMAIN}/sitemap.xml\n')
 (PUBLIC/'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+''.join(f'<url><loc>{escape(url)}</loc><lastmod>{DATE}</lastmod></url>\n' for url,_ in entries)+'</urlset>\n')
 llms='# 欧八面试陪练\n\n'+content['summary']+f'\n\n> 30 秒核心结论：1 场自我介绍 + 3 道经历深挖题；5 维 3 档原话引用点评；覆盖 5 个高频岗位题库（6 个公开落地页）；平台使用费 ¥0（MIT 开源，需自备阿里云百炼 Key，模型调用费用由用户承担）；最近更新：{DATE}。\n\n'+''.join('## '+f['q']+'\n'+f['a']+'\n\n' for f in faqs)+'作者：欧八同学，'+AUTHOR+'\n开源代码：https://github.com/ouxxyy/ai-interviewer\n\n## 公开页面\n'+'\n'.join(f'- [{title}]({url})' for url,title in entries)+'\n'
 (PUBLIC/'llms.txt').write_text(llms);(PUBLIC/'llms-full.txt').write_text(llms+'\n---\n\n'+'\n\n'.join(texts))
 print(f'Generated initial HTML, truthful FAQ, discovery files and {len(entries)} sitemap URLs; preserved runtime onboarding.')
if __name__=='__main__':build()
