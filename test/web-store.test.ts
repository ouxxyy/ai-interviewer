/**
 * 数据层测试（离线，无模型调用）：迁移、两开关、重启后可读、显式删除前后对照、分页。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { InterviewDb, MIGRATIONS } from '../src/web/db.js';
import { Store } from '../src/web/store.js';
import { webPaths, REPO_ROOT } from '../src/web/paths.js';
import { SessionMachine } from '../src/state/machine.js';
import type { Turn } from '../src/contracts/types.js';

function tmpRoot(label: string): string {
  const dir = path.join(REPO_ROOT, 'data', `web-test-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function turn(id: string, questionId: string, speaker: 'user' | 'interviewer', seq: number, text: string, turnType: Turn['turnType'] = 'answer'): Turn {
  return {
    contractVersion: '0.2.0',
    id,
    questionId,
    speaker,
    turnType,
    seq,
    startedAt: '2026-09-27T00:00:00.000Z',
    endedAt: '2026-09-27T00:00:01.000Z',
    rawTranscript: text,
    revisedText: null,
    audioFile: null,
  };
}

const PCM = Buffer.alloc(3200, 7);

test('迁移：可重复执行，第二次不重复应用', () => {
  const root = tmpRoot('migrate');
  const db = new InterviewDb(path.join(root, 'x.sqlite'));
  const first = db.migrate();
  assert.deepEqual(first.applied, [1]);
  assert.equal(first.version, 1);
  const second = db.migrate();
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.alreadyApplied, [1]);
  assert.equal(second.version, MIGRATIONS.length);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('保存历史＝开：会话/轮次/反馈入库，重启后仍可读，音频落盘', () => {
  const root = tmpRoot('history-on');
  const dbFile = path.join(root, 'x.sqlite');
  {
    const db = new InterviewDb(dbFile);
    db.migrate();
    const store = new Store(db, webPaths(root));
    const s = store.createSession({ id: 's1', ruleVersion: 'rules@0.2.0', realtimeModel: 'm', textModel: 't', synthetic: false, saveHistory: true, saveAudio: true });
    assert.equal(s.persisted, true);
    store.addTurn('s1', turn('t1', 'q1', 'user', 1, '我的回答原文'), { track: 'user', pcm: PCM, sampleRate: 16000 });
    store.saveFeedback('s1', 'q1', 'feedback', { hello: 'world' });
    db.close();
  }
  const db2 = new InterviewDb(dbFile);
  db2.migrate();
  const store2 = new Store(db2, webPaths(root));
  const session = store2.getSession('s1');
  assert.equal(session?.saveHistory, true);
  const turns = store2.listTurns('s1');
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.rawTranscript, '我的回答原文');
  assert.match(turns[0]!.audioFile ?? '', /^audio\/s1\/turn-t1-user\.wav$/);
  assert.deepEqual(store2.getFeedback('s1', 'q1', 'feedback'), { hello: 'world' });
  const audio = store2.readAudio('s1', 't1', 'user');
  assert.equal(audio.ok, true);
  assert.equal(audio.ok && audio.source, 'file');
  assert.ok(existsSync(path.join(root, turns[0]!.audioFile!)), '音频文件应真实存在');
  const listed = store2.listSessions({ limit: 10, offset: 0 });
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0]!.audioFiles, 1);
  db2.close();
  rmSync(root, { recursive: true, force: true });
});

test('保存历史＝关：不产生任何持久记录，也不产生音频文件', () => {
  const root = tmpRoot('history-off');
  const db = new InterviewDb(path.join(root, 'x.sqlite'));
  db.migrate();
  const store = new Store(db, webPaths(root));
  const s = store.createSession({ id: 's-off', ruleVersion: 'rules@0.2.0', realtimeModel: 'm', textModel: 't', synthetic: true, saveHistory: false, saveAudio: true });
  assert.equal(s.persisted, false);
  const t = store.addTurn('s-off', turn('t1', 'q1', 'user', 1, '临时回答'), { track: 'user', pcm: PCM, sampleRate: 16000 });
  assert.equal(t.audioFile, null, '关历史时不该写音频文件引用');
  store.saveFeedback('s-off', 'q1', 'feedback', { x: 1 });
  // 库里一条都没有
  assert.equal(store.listSessions().total, 0);
  assert.equal(store.getSession('s-off')?.persisted, false);
  assert.equal(store.listAudioFiles('s-off').length, 0);
  assert.equal(existsSync(path.join(root, 'audio', 's-off')), false);
  // 本场仍可回放（内存），标注 source=memory
  const audio = store.readAudio('s-off', 't1', 'user');
  assert.equal(audio.ok, true);
  assert.equal(audio.ok && audio.source, 'memory');
  // 重启后（新进程视角）什么都不剩
  db.close();
  const db2 = new InterviewDb(path.join(root, 'x.sqlite'));
  db2.migrate();
  const store2 = new Store(db2, webPaths(root));
  assert.equal(store2.getSession('s-off'), null);
  assert.equal(store2.listSessions().total, 0);
  db2.close();
  rmSync(root, { recursive: true, force: true });
});

test('保存录音＝关（历史开）：文本记录在，磁盘无音频，audio_file 为 null 但保留字节数与摘要作为用量证据', () => {
  const root = tmpRoot('audio-off');
  const db = new InterviewDb(path.join(root, 'x.sqlite'));
  db.migrate();
  const store = new Store(db, webPaths(root));
  store.createSession({ id: 's-noaudio', ruleVersion: 'rules@0.2.0', realtimeModel: 'm', textModel: 't', synthetic: true, saveHistory: true, saveAudio: false });
  store.addTurn('s-noaudio', turn('t1', 'q1', 'user', 1, '回答'), { track: 'user', pcm: PCM, sampleRate: 16000 });
  assert.equal(store.listAudioFiles('s-noaudio').length, 0);
  assert.equal(existsSync(path.join(root, 'audio', 's-noaudio')), false);
  const row = db.raw.prepare('SELECT audio_file, audio_bytes, audio_sha256 FROM turns WHERE session_id = ? AND id = ?').get('s-noaudio', 't1') as {
    audio_file: string | null;
    audio_bytes: number | null;
    audio_sha256: string | null;
  };
  assert.equal(row.audio_file, null);
  assert.equal(Number(row.audio_bytes), PCM.length);
  assert.match(String(row.audio_sha256), /^[0-9a-f]{64}$/);
  // 磁盘没有，但本场内存可回放
  const audio = store.readAudio('s-noaudio', 't1', 'user');
  assert.equal(audio.ok && audio.source, 'memory', '关录音后本场仍应在内存里可回放');
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('显式删除：数据库记录 + 音频文件 + 临时文件全部清掉，并给出删除前后对照', () => {
  const root = tmpRoot('delete');
  const db = new InterviewDb(path.join(root, 'x.sqlite'));
  db.migrate();
  const paths = webPaths(root);
  const store = new Store(db, paths);
  store.createSession({ id: 's-del', ruleVersion: 'rules@0.2.0', realtimeModel: 'm', textModel: 't', synthetic: false, saveHistory: true, saveAudio: true });
  store.addTurn('s-del', turn('t1', 'q1', 'user', 1, '回答一'), { track: 'user', pcm: PCM, sampleRate: 16000 });
  store.addTurn('s-del', turn('t2', 'q1', 'interviewer', 2, '问题', 'question'), { track: 'interviewer', pcm: PCM, sampleRate: 24000 });
  store.saveFeedback('s-del', 'q1', 'feedback', { a: 1 });
  // 造一个属于该会话的临时文件（模拟解析上传时的残留）
  mkdirSync(paths.uploadTmpDir, { recursive: true });
  writeFileSync(path.join(paths.uploadTmpDir, 's-del-123-resume.pdf'), 'x');
  // 另一个会话的文件不能被误删
  store.createSession({ id: 's-keep', ruleVersion: 'rules@0.2.0', realtimeModel: 'm', textModel: 't', synthetic: false, saveHistory: true, saveAudio: true });
  store.addTurn('s-keep', turn('t1', 'q1', 'user', 1, '别的会话'), { track: 'user', pcm: PCM, sampleRate: 16000 });
  writeFileSync(path.join(paths.uploadTmpDir, 's-keep-999-resume.pdf'), 'y');

  const report = store.deleteSession('s-del');
  assert.equal(report.before.rows.sessions, 1);
  assert.equal(report.before.rows.turns, 2);
  assert.equal(report.before.rows.feedbacks, 1);
  assert.equal(report.before.audioFiles.length, 2);
  assert.equal(report.before.tmpFiles.length, 1);
  assert.equal(report.after.rows.sessions, 0);
  assert.equal(report.after.rows.turns, 0);
  assert.equal(report.after.rows.feedbacks, 0);
  assert.equal(report.after.audioFiles.length, 0);
  assert.equal(report.after.tmpFiles.length, 0);
  assert.equal(report.verified, true);
  assert.equal(report.removed.audioFiles.length, 2);
  assert.equal(report.removed.tmpFiles.length, 1);
  assert.equal(existsSync(path.join(root, 'audio', 's-del')), false);
  assert.equal(existsSync(path.join(paths.uploadTmpDir, 's-del-123-resume.pdf')), false);
  // 别的会话不受影响
  assert.equal(store.getSession('s-keep') !== null, true);
  assert.equal(store.listAudioFiles('s-keep').length, 1);
  assert.equal(existsSync(path.join(paths.uploadTmpDir, 's-keep-999-resume.pdf')), true);
  // 级联删除后库内无孤儿行
  assert.equal(Number((db.raw.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?').get('s-del') as { n: number }).n), 0);
  assert.equal(Number((db.raw.prepare('SELECT COUNT(*) AS n FROM feedbacks WHERE session_id = ?').get('s-del') as { n: number }).n), 0);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('会话列表分页与演示隔离统计', () => {
  const root = tmpRoot('page');
  const db = new InterviewDb(path.join(root, 'x.sqlite'));
  db.migrate();
  const store = new Store(db, webPaths(root));
  for (let i = 0; i < 5; i++) {
    store.createSession({ id: `s-${i}`, ruleVersion: 'rules@0.2.0', realtimeModel: 'm', textModel: 't', synthetic: i % 2 === 0, saveHistory: true, saveAudio: true });
  }
  const page1 = store.listSessions({ limit: 2, offset: 0 });
  assert.equal(page1.total, 5);
  assert.equal(page1.items.length, 2);
  const page3 = store.listSessions({ limit: 2, offset: 4 });
  assert.equal(page3.items.length, 1);
  const realOnly = store.listSessions({ limit: 10, offset: 0, includeSynthetic: false });
  assert.equal(realOnly.total, 2);
  const stats = store.stats();
  assert.equal(stats.real, 2);
  assert.equal(stats.synthetic, 3);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('状态机快照能原样存取（断线恢复口径）', () => {
  const m = new SessionMachine();
  m.fire('MATERIALS_CONFIRMED');
  m.fire('QUESTION_SENT');
  m.fire('ANSWER_START');
  const snap = m.snapshot();
  const restored = SessionMachine.restore(snap);
  assert.deepEqual(restored.snapshot(), snap);
  assert.throws(() => SessionMachine.restore({ ...snap, followupCount: 9 }), /followupCount/);
});

test('数据层不把音频内容写进数据库（只有路径、字节数、摘要）', () => {
  const root = tmpRoot('nopcm');
  const db = new InterviewDb(path.join(root, 'x.sqlite'));
  db.migrate();
  const store = new Store(db, webPaths(root));
  store.createSession({ id: 's1', ruleVersion: 'rules@0.2.0', realtimeModel: 'm', textModel: 't', synthetic: true, saveHistory: true, saveAudio: true });
  const secretPcm = Buffer.from('这是音频内容不该进库');
  store.addTurn('s1', turn('t1', 'q1', 'user', 1, '文本'), { track: 'user', pcm: secretPcm, sampleRate: 16000 });
  const rows = db.raw.prepare('SELECT * FROM turns').all() as Array<Record<string, unknown>>;
  const dump = JSON.stringify(rows);
  assert.equal(dump.includes('这是音频内容不该进库'), false);
  assert.match(dump, /audio\/s1\/turn-t1-user\.wav/);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('数据目录里不出现本机绝对路径（入库字段都是相对路径）', () => {
  const root = tmpRoot('relpath');
  const db = new InterviewDb(path.join(root, 'x.sqlite'));
  db.migrate();
  const store = new Store(db, webPaths(root));
  store.createSession({ id: 's1', ruleVersion: 'rules@0.2.0', realtimeModel: 'm', textModel: 't', synthetic: true, saveHistory: true, saveAudio: true });
  store.addTurn('s1', turn('t1', 'q1', 'user', 1, '文本'), { track: 'user', pcm: PCM, sampleRate: 16000 });
  const files = readdirSync(path.join(root, 'audio', 's1'));
  assert.deepEqual(files, ['turn-t1-user.wav']);
  const turnRow = store.listTurns('s1')[0]!;
  assert.equal(path.isAbsolute(turnRow.audioFile!), false);
  db.close();
  rmSync(root, { recursive: true, force: true });
});
