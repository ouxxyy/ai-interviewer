"""Generate the English static entry and role guides from the public copy."""
from html import escape
import json

GUIDES = {
    'ai-pm': (
        'AI product manager',
        'How did you decide that a model was a better fit for the workflow than a simpler rule?',
        'Describe the task, the previous workflow, and the errors that mattered to the people doing the work.',
        'Which examples did you keep out of training? How did you weigh quality, latency and cost when deciding to launch?',
        'If unit cost fell after changing models, separate the change in input length, output length, traffic mix and price before claiming the model caused the saving.'),
    'b2b-pm': (
        'B2B product manager',
        'Tell me about a customer request that you chose to solve differently.',
        'Start with who used the workflow, what kept going wrong and which constraint prevented a straightforward fix.',
        'Which stakeholders disagreed? What did you personally change, and what showed that the revised process worked?',
        'If a customer asked for another approval step, explain how you checked whether the real problem was missing information or unclear authority.'),
    'growth-pm': (
        'Growth product manager',
        'Walk me through a growth experiment whose outcome surprised you.',
        'Define the eligible audience, the denominator of your primary metric and the period you measured.',
        'What did the control group experience? Which guardrail would have made you stop the experiment?',
        'If sign-ups rose but activation fell, compare cohorts at the same age and look for a change in traffic sources before drawing a conclusion.'),
    'backend-dev': (
        'Backend engineer',
        'Describe a production incident you helped diagnose and resolve.',
        'Explain the user-visible symptom, your own responsibility and the evidence you used to narrow the cause.',
        'Which competing explanation did you rule out? How did you verify the fix under realistic load?',
        'If latency improved after a cache change, specify the percentile, time window and hit rate. Distinguish mitigation from the permanent fix.'),
    'data-analyst': (
        'Data analyst',
        'Tell me about a time two dashboards disagreed on an important business metric.',
        'Define the numerator, denominator, timezone and reporting window before comparing the numbers.',
        'How did you locate the first divergent record? Who agreed on the final definition and how was it checked?',
        'If two teams counted active customers differently, walk through one anonymized example and show which rule included or excluded it.'),
}


def write_english_pages(web, domain, analytics):
    content = json.loads((web / 'src/public-content.en.json').read_text())
    role_links = '<ul>' + ''.join(f'<li><a href="{r["path"]}">{escape(r["title"])}</a></li>' for r in content['roles']) + '</ul>'
    nav = '<header class="brand-header"><a class="brand-mark" href="/en/"><span>8</span><strong>Ouba Interview Coach</strong></a><nav aria-label="Main navigation"><a href="/en/roles/">Role guides</a></nav></header>'
    def document(path, title, description, body, *, app=False, schema=None):
        zh = path[3:] or '/'
        structured = '' if schema is None else '<script type="application/ld+json">' + json.dumps(schema, ensure_ascii=False) + '</script>'
        header = nav if app else nav.replace('</nav>', f' · <a href="{zh}?lang=zh" lang="zh">中文</a></nav>')
        entry = '<script type="module" src="/src/main.tsx"></script>' if app else ''
        style = '' if app else '<link rel="stylesheet" href="/en/roles/guides.css">'
        return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(title)}</title><meta name="description" content="{escape(description, quote=True)}">
<link rel="canonical" href="{domain}{path}"><link rel="alternate" hreflang="en" href="{domain}{path}"><link rel="alternate" hreflang="zh" href="{domain}{zh}">
<meta property="og:title" content="{escape(title, quote=True)}"><meta property="og:description" content="{escape(description, quote=True)}"><meta property="og:url" content="{domain}{path}">
{style}{structured}{analytics}</head><body><div id="root">{header}<main class="public-resources">{body}</main></div>{entry}</body></html>
'''
    app_dir = web / 'en'
    app_dir.mkdir(exist_ok=True)
    faq = ''.join(f'<details><summary>{escape(f["q"])}</summary><p>{escape(f["a"])}</p></details>' for f in content['faqs'])
    home = f'<h1>{escape(content["headline"])}</h1><p>{escape(content["summary"])}</p><noscript><p>Enable JavaScript to start a voice interview. You can read the role guides below without it.</p></noscript><h2>Practice by role</h2>{role_links}<h2>Common questions</h2>{faq}'
    schema = {'@context': 'https://schema.org', '@type': 'SoftwareApplication', 'name': 'Ouba Interview Coach', 'url': domain+'/en/', 'applicationCategory': 'EducationalApplication', 'operatingSystem': 'Web', 'inLanguage': ['en','zh'], 'description': content['description']}
    (app_dir/'index.html').write_text(document('/en/', content['title'], content['description'], home, app=True, schema=schema))
    guides = web/'public/en/roles'
    guides.mkdir(parents=True, exist_ok=True)
    index = '<h1>Interview practice by role</h1><p>Choose a role for a practice question, a follow-up, and a way to check your answer.</p>' + role_links
    (guides/'index.html').write_text(document('/en/roles/', 'Interview practice by role | Ouba Interview Coach', 'Practice questions for five roles in product, engineering, and analytics.', index))
    for slug, (role, question, starting, followup, example) in GUIDES.items():
        body = f'<h1>{escape(role)} interview practice</h1><h2>Practice question</h2><p>{escape(question)}</p><p>{escape(starting)}</p><h2>Follow-up</h2><p>{escape(followup)}</p><h2>Check your answer</h2><p>{escape(example)}</p><p><a href="/en/">Start a voice interview</a> · <a href="/en/roles/">All role guides</a></p>'
        (guides/(slug+'.html')).write_text(document('/en/roles/'+slug+'.html', role+' interview practice | Ouba Interview Coach', question, body))
    return [(domain+'/en/', content['title']), (domain+'/en/roles/', 'Role guides')] + [(domain+r['path'],r['title']) for r in content['roles']]
