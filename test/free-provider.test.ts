import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { OpenAiTextClient, openAiConfig, readOpenAiJson, OPENAI_DEFAULTS, type OpenAiConfig } from '../src/clients/openai-compatible.js';
import { OpenAiAudioClient } from '../src/clients/openai-audio.js';
import { FreeBudget } from '../src/web/free-budget.js';
import { startServer } from '../src/web/cli.js';
import { Logger } from '../src/web/log.js';
import { ScriptedTextClient, MockRealtimeClient } from './helpers/web-mocks.js';
import { RealtimeBridge } from '../src/web/realtime-bridge.js';
import { DEMO_MATERIALS } from '../src/web/materials.js';

const key = 'test-only-openai-credential-00000000';
const config: OpenAiConfig = { ...OPENAI_DEFAULTS, apiKey: key };

test('free config requires an explicit switch and rejects unsafe base URLs', () => {
  assert.equal(openAiConfig({ OPENAI_API_KEY: key }), null);
  assert.equal(openAiConfig({ AI_INTERVIEWER_FREE_ENABLED: 'on' }), null);
  assert.equal(openAiConfig({ AI_INTERVIEWER_FREE_ENABLED: 'on', OPENAI_API_KEY: key })?.baseUrl, 'https://api.openai.com/v1');
  for (const baseUrl of ['http://example.test/v1', 'https://user:pass@example.test/v1', 'https://example.test/v1?key=x']) {
    assert.throws(() => openAiConfig({ AI_INTERVIEWER_FREE_ENABLED: 'on', OPENAI_API_KEY: key, OPENAI_BASE_URL: baseUrl }));
  }
});

test('OpenAI text excludes Bailian-only options, caps output and never exposes upstream errors', async t => {
  const requests: any[] = [];
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({url, ...init, body: JSON.parse(String(init.body))});
    return new Response(fail ? JSON.stringify({error:{message:`Authorization: Bearer ${key}`}}) : JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}), {status:fail?401:200});
  });
  const client = new OpenAiTextClient(config);
  assert.equal((await client.complete({prompt:'Return JSON',jsonMode:true,enableThinking:false,maxTokens:99999})).text,'{"ok":true}');
  assert.equal(requests[0].body.enable_thinking,undefined);
  assert.equal(requests[0].body.max_tokens,8192);
  assert.equal(requests[0].redirect,'error');
  assert.equal(requests[0].headers.Authorization,`Bearer ${key}`);
  fail = true;
  await assert.rejects(client.complete({prompt:'test'}), e => e instanceof Error && !e.message.includes(key) && e.message.includes('401'));
});

test('response bounds reject oversized bodies even with missing or false length headers and redact invalid JSON', async t => {
  for (const headers of [new Headers(), new Headers({'content-length':'1'})]) {
    await assert.rejects(readOpenAiJson(new Response('x'.repeat(65),{headers}),64), /大小上限/);
  }
  await assert.rejects(readOpenAiJson(new Response(key),1024), e => e instanceof Error && !e.message.includes(key));
  t.mock.method(globalThis,'fetch',async(url:string)=>new Response(JSON.stringify(url.endsWith('/audio/transcriptions') ? {text:'x'.repeat(20001)} : {choices:[{message:{content:'x'.repeat(64001)}}]})));
  await assert.rejects(new OpenAiTextClient(config).complete({prompt:'test'}),/未返回有效文本/);
  const voice=new OpenAiAudioClient(config);await voice.open('bounded-transcription');voice.appendAudio(Buffer.alloc(6400));
  const pending=voice.waitForUserTranscript();voice.commitAudio();await assert.rejects(pending,/内容无效/);voice.close();
});

test('audio adapter sends real PCM speech bytes and WAV transcription through official routes', async t => {
  const requests: Array<{url:string;body:any}> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({url,body:init.body});
    if(url.endsWith('/audio/speech')) return new Response(new Uint8Array([1,0,2,0,3,0,4,0]));
    return new Response(JSON.stringify({text:'我负责需求访谈。'}));
  });
  const client = new OpenAiAudioClient(config); await client.open('test');
  const audio: Buffer[] = []; const transcripts: string[] = [];
  client.onInterviewerAudio(chunk=>audio.push(chunk));client.onTranscript(text=>transcripts.push(text));
  const response = client.waitForResponse();client.injectText('请介绍自己。');
  const spoken=await response;
  assert.equal(spoken.status,'completed');assert.equal(spoken.transcript,'');
  assert.equal(Buffer.concat(audio).length,8);assert.equal(spoken.audio.length,8);
  const body=JSON.parse(requests[0]!.body);assert.equal(body.response_format,'pcm');assert.equal(body.voice,'coral');
  const input=Buffer.alloc(6400);client.appendAudio(input);
  const transcript=client.waitForUserTranscript();client.commitAudio();
  assert.equal((await transcript).transcript,'我负责需求访谈。');assert.deepEqual(transcripts,['我负责需求访谈。']);
  const form=requests[1]!.body as FormData;const wav=Buffer.from(await (form.get('file') as Blob).arrayBuffer());
  assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),16000);assert.equal(wav.length,input.length+44);
  assert.equal(requests[1]!.url,'https://api.openai.com/v1/audio/transcriptions');
  assert.throws(()=>client.appendAudio(Buffer.alloc(16_000*2*300+2)),/5 分钟/);client.close();
});

test('audio cancellation aborts pending upstream work and emits no late audio', async t => {
  let aborted=false; let started:()=>void=()=>{};
  const ready=new Promise<void>(r=>started=r);
  t.mock.method(globalThis,'fetch',async (_url:string,init:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
    init.signal!.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));});started();
  }));
  const client=new OpenAiAudioClient(config);await client.open('test');let audio=0;client.onInterviewerAudio(()=>audio++);
  const response=client.waitForResponse();client.injectText('测试');await ready;client.cancelResponse();
  assert.equal((await response).status,'cancelled');assert.equal(aborted,true);assert.equal(audio,0);client.close();
});

test('free call budget enforces concurrency, per-session and persistent global limits',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'free-budget-'));const file=path.join(root,'usage.sqlite');
  let budget=new FreeBudget(file,2,1);
  try{
    const guard=budget.sessionGuard(1);const release=guard();
    assert.throws(()=>budget.sessionGuard()(),/较多用户/);release();release();
    assert.throws(()=>guard(),/本场/);budget.sessionGuard()()();
    budget.close();budget=new FreeBudget(file,2,1);assert.throws(()=>budget.sessionGuard()(),/今日免费额度/);
  }finally{budget.close();rmSync(root,{recursive:true,force:true});}
});

async function port():Promise<number>{const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return p;}

test('public free onboarding, Bailian precedence, provider snapshot, quotas and credential isolation',async t=>{
  const root=mkdtempSync(path.join(tmpdir(),'free-public-'));const p=await port();const origin=`http://127.0.0.1:${p}`;
  const originalFetch = globalThis.fetch;
  const upstream: Array<{url:string;authorization:string}> = [];
  const scripted = new ScriptedTextClient();
  let bailianFailure = false;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.openai.com/') || url.startsWith('https://dashscope.aliyuncs.com/')) {
      const headers = new Headers(init?.headers);
      upstream.push({url,authorization:headers.get('authorization')??''});
      if (bailianFailure && url.includes('dashscope')) return new Response('invalid credential', {status:401});
      const req = JSON.parse(String(init?.body));
      const answer = await scripted.complete({prompt:req.messages[0].content});
      return new Response(JSON.stringify({choices:[{message:{content:answer.text}}]}));
    }
    return originalFetch(input, init);
  });
  const logs:string[]=[];const opts={port:p,dataDir:root,publicMode:true,publicOrigin:origin,credentialEnv:{AI_INTERVIEWER_FREE_ENABLED:'on',OPENAI_API_KEY:key},logger:new Logger(l=>logs.push(l)),createBridge:()=>new RealtimeBridge({credential:'test-only',createClient:()=>new MockRealtimeClient()})};
  let app=await startServer(opts);
  const call=async(cookie:string,route:string,method='GET',body?:unknown,headers:Record<string,string>={})=>{
    const res=await fetch(origin+route,{method,headers:{Cookie:cookie,Origin:origin,Connection:'close','Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await res.text();assert.ok(!text.includes(key));return {status:res.status,body:JSON.parse(text),cookie:res.headers.get('set-cookie')?.split(';')[0]??''};
  };
  try{
    const a=await call('','/api/bootstrap');assert.equal(a.body.mode.keyConfigured,true);
    const b=await call('','/api/bootstrap');const cookie=a.cookie;
    const conf=(await call(cookie,'/api/model-config')).body;
    assert.equal(conf.provider,'free-openai');assert.equal(conf.userConfigured,false);assert.equal(conf.textModel,OPENAI_DEFAULTS.textModel);
    assert.equal((await call(cookie,'/api/sessions','POST',{})).status,428);
    const session=await call(cookie,'/api/sessions','POST',{synthetic:true,disclosureAck:true,saveHistory:false});assert.equal(session.status,201);
    const ownKey='sk-' + 'test-only-bailian-credential';
    const updated=await call(cookie,'/api/model-config','PATCH',{apiKey:ownKey},{'X-Config-Token':conf.configToken});
    assert.equal(updated.body.provider,'bailian');assert.equal(updated.body.userConfigured,true);assert.equal(updated.body.freeAvailable,true);
    assert.ok(!JSON.stringify(updated.body).includes(ownKey));
    const oldPlan=await call(cookie,`/api/sessions/${session.body.sid}/materials`,'POST',DEMO_MATERIALS);
    assert.equal(oldPlan.status,200);assert.equal(upstream.at(-1)?.authorization,`Bearer ${key}`);
    assert.match(upstream.at(-1)!.url,/api.openai.com/);
    const own=await call(cookie,'/api/sessions','POST',{synthetic:true,disclosureAck:true,saveHistory:false});
    assert.equal((await call(cookie,`/api/sessions/${own.body.sid}/materials`,'POST',DEMO_MATERIALS)).status,200);
    assert.equal(upstream.at(-1)?.authorization,`Bearer ${ownKey}`);assert.match(upstream.at(-1)!.url,/dashscope/);
    const failed=await call(cookie,'/api/sessions','POST',{synthetic:true,disclosureAck:true,saveHistory:false});
    bailianFailure=true;const at=upstream.length;
    assert.equal((await call(cookie,`/api/sessions/${failed.body.sid}/materials`,'POST',DEMO_MATERIALS)).status,502);
    assert.ok(upstream.slice(at).every(r=>r.url.includes('dashscope')),'invalid own key must not silently spend shared key');
    bailianFailure=false;
    assert.equal((await call(b.cookie,'/api/model-config')).body.provider,'free-openai');
    for(let n=0;n<3;n++) assert.equal((await call(b.cookie,'/api/sessions','POST',{synthetic:true,disclosureAck:true,saveHistory:false})).status,201);
    assert.equal((await call(b.cookie,'/api/sessions','POST',{synthetic:true,disclosureAck:true})).status,429);
    assert.equal((await call(cookie,'/api/sessions','POST',{synthetic:true,disclosureAck:true})).status,201);
    assert.equal((await call(b.cookie,`/api/sessions/${session.body.sid}`)).status,404);
    await app.close();app=await startServer(opts);
    assert.equal((await call(cookie,'/api/model-config')).body.provider,'bailian');
    assert.equal((await call(b.cookie,'/api/sessions','POST',{synthetic:true,disclosureAck:true})).status,429);
    assert.ok(!logs.join('').includes(key)&&!logs.join('').includes(ownKey));
    assert.ok(!readFileSync(path.join(root,'public/visitors.sqlite')).includes(Buffer.from(key)));
  }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});

test('English speech and transcription use the same session language', async t => {
  const question = 'Which decision did you own?';
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/audio/speech')) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.input, question);
      assert.match(body.instructions, /English/);
      return new Response(new Uint8Array([1, 0]));
    }
    assert.equal((init.body as FormData).get('language'), 'en');
    return Response.json({ text: 'I decided to test the new workflow.' });
  });
  const client = new OpenAiAudioClient(config, undefined, 'en');
  await client.open('english-speech');
  try {
    const spoken = client.waitForResponse();
    client.injectText(question);
    assert.equal((await spoken).audio.length, 2);
    client.appendAudio(Buffer.alloc(6400));
    const transcript = client.waitForUserTranscript();
    client.commitAudio();
    assert.match((await transcript).transcript, /workflow/);
  } finally {
    client.close();
  }
});
