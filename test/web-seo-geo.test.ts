import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/web/cli.js';
import { Logger } from '../src/web/log.js';
import { REPO_ROOT } from '../src/web/paths.js';

async function boot(staticDir: string) {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0,'127.0.0.1',resolve));
  const port = (probe.address() as {port:number}).port;
  await new Promise<void>(resolve => probe.close(()=>resolve()));
  const root=mkdtempSync(path.join(tmpdir(),'ouba-seo-test-'));
  const app=await startServer({port, dataDir:root, staticDir, publicMode:true, publicOrigin:`http://127.0.0.1:${port}`, credentialFile:path.join(root,'.env'), credentialEnv:{}, logger:new Logger(()=>{},'error')});
  return {app,close:async()=>{await app.close();rmSync(root,{recursive:true,force:true});}};
}

test('SEO/GEO: every sitemap URL serves its real content with correct GET/HEAD types', async()=>{
  const {app,close}=await boot(path.join(REPO_ROOT,'dist/web-client'));
  try {
    const paths: Array<[string,RegExp,RegExp]>=[['/robots.txt',/^text\/plain/,/User-agent: \*/],['/sitemap.xml',/^application\/xml/,/<urlset/],['/llms.txt',/^text\/plain/,/模型调用费用/],['/llms-full.txt',/^text\/plain/,/AI 产品经理/],['/roles/',/^text\/html/,/岗位/],['/roles/ai-pm.html',/^text\/html/,/教学示例/],['/roles/styles.css',/^text\/css/,/box-sizing/]];
    for(const [route,type,content] of paths){
      const get=await fetch(app.url+route);assert.equal(get.status,200,route);assert.match(get.headers.get('content-type')??'',type);const raw=await get.text();assert.match(raw,content);
      const head=await fetch(app.url+route,{method:'HEAD'});assert.equal(head.status,200,route);assert.equal(await head.text(),'');assert.equal(head.headers.get('content-type'),get.headers.get('content-type'));assert.equal(Number(head.headers.get('content-length')),Buffer.byteLength(raw));
    }
    const xml=await (await fetch(app.url+'/sitemap.xml')).text();
    const urls=[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m=>m[1]!);assert.equal(urls.length,14);assert.equal(new Set(urls).size,14);
    for(const url of urls){const response=await fetch(app.url+new URL(url).pathname);assert.equal(response.status,200,url);const body=await response.text();assert.match(body,/<h1[\s>]/);assert.ok(body.includes(url),`canonical URL absent: ${url}`);}
  }finally{await close();}
});

test('SEO/GEO: initial HTML exposes truthful FAQ and costs without JavaScript',async()=>{
  const {app,close}=await boot(path.join(REPO_ROOT,'dist/web-client'));
  try {
    const response=await fetch(app.url+'/');const body=await response.text();
    const schema=JSON.parse(body.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]!);
    assert.ok(schema['@graph'].some((v:any)=>v['@type']==='SoftwareApplication'));
    const faq=schema['@graph'].find((v:any)=>v['@type']==='FAQPage');assert.equal(faq.mainEntity.length,4);
    for(const q of faq.mainEntity){assert.ok(body.includes('<summary>'+q.name+'</summary>'));assert.ok(body.includes('<p>'+q.acceptedAnswer.text+'</p>'));}
    assert.match(body,/材料与回答会发送给配置的百炼模型/);assert.match(body,/模型调用费用由用户承担/);assert.match(body,/\/roles\/ai-pm.html/);
    assert.equal((body.match(/data-website-id=/g)??[]).length,1,'analytics loaded once');
  }finally{await close();}
});

test('SEO/GEO: private routes stay noindex and missing/unsafe resources never fall back to the homepage',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'ouba-static-scope-'));const pub=path.join(root,'public');mkdirSync(pub);
  writeFileSync(path.join(pub,'index.html'),'<html><h1>Public app</h1></html>');writeFileSync(path.join(root,'outside.txt'),'outside sentinel');writeFileSync(path.join(pub,'.env'),'private sentinel');symlinkSync(path.join(root,'outside.txt'),path.join(pub,'escape.txt'));
  const {app,close}=await boot(pub);
  try {
    for(const route of ['/roles/missing','/missing.xml','/.env','/escape.txt','/missing-page']){const res=await fetch(app.url+route);assert.equal(res.status,404,route);assert.doesNotMatch(await res.text(),/sentinel|Public app/);}
    for(const route of ['/session/test','/report/test','/history','/settings']){const res=await fetch(app.url+route,{method:'HEAD'});assert.equal(res.status,200);assert.match(res.headers.get('x-robots-tag')??'',/noindex/);assert.equal(await res.text(),'');}
    const api=await fetch(app.url+'/api/settings');assert.equal(api.status,401);assert.match(api.headers.get('x-robots-tag')??'',/noindex/);
  }finally{await close();rmSync(root,{recursive:true,force:true});}
});

test('browser preference and English deep links serve the correct index before JavaScript runs', async () => {
  const { app, close } = await boot(path.join(REPO_ROOT, 'dist/web-client'));
  try {
    for (const [route, preference, expected] of [
      ['/', 'fr, en-US;q=0.9, zh;q=0.5', 'en'],
      ['/', 'zh-Hant, en;q=0.8', 'zh-CN'],
      ['/en/', 'zh-CN', 'en'],
      ['/en/history', 'zh-CN', 'en'],
    ]) {
      const response = await fetch(app.url+route, { headers: { 'Accept-Language': preference! } });
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes('<html lang="'+expected+'">'));
      if (route === '/') assert.equal(response.headers.get('vary'), 'Accept-Language');
      if (route === '/en/history') assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/);
    }
  } finally { await close(); }
});
