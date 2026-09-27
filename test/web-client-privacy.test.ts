/**
 * 隐私开关策略的回归测试（P0-2）。
 *
 * 被打回的真实路径：用户在隐私页关掉「保存历史」，回到首页开关仍显示开启，
 * 新建会话照样把 saveHistory/saveAudio 显式传成 true —— 用户的选择被静默覆盖。
 * 这里钉住三条：关历史必关录音、建会话请求体只由当前设置算出来、草稿会话过期判定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSaveAudio, sessionCreateBody, sessionToggles, togglePatch, togglesEqual } from '../web-client/src/lib/privacy.js';

test('P0-2：关掉历史时录音必然为关（服务端同一不变量）', () => {
  assert.equal(effectiveSaveAudio(false, true), false);
  assert.equal(effectiveSaveAudio(false, false), false);
  assert.equal(effectiveSaveAudio(true, true), true);
  assert.equal(effectiveSaveAudio(true, false), false);
});

test('P0-2：关闭历史的补丁必须同时把录音关掉', () => {
  assert.deepEqual(togglePatch({ saveHistory: true, saveAudio: true }, 'saveHistory', false), { saveHistory: false, saveAudio: false });
  assert.deepEqual(togglePatch({ saveHistory: false, saveAudio: false }, 'saveHistory', true), { saveHistory: true });
});

test('P0-2：开录音只在历史开着时生效，否则补丁自身就把录音压回 false', () => {
  assert.deepEqual(togglePatch({ saveHistory: false, saveAudio: false }, 'saveAudio', true), { saveAudio: false });
  assert.deepEqual(togglePatch({ saveHistory: true, saveAudio: false }, 'saveAudio', true), { saveAudio: true });
});

test('P0-2：建会话请求体只能由当前设置算出，不会带上矛盾的开关组合', () => {
  assert.deepEqual(sessionCreateBody({ saveHistory: false, saveAudio: true }), { synthetic: false, saveHistory: false, saveAudio: false });
  assert.deepEqual(sessionCreateBody({ saveHistory: true, saveAudio: false }), { synthetic: false, saveHistory: true, saveAudio: false });
  assert.deepEqual(sessionToggles({ saveHistory: true, saveAudio: true }), { saveHistory: true, saveAudio: true });
});

test('P0-2：草稿会话的开关一致才算可复用（不一致必须重建）', () => {
  assert.equal(togglesEqual({ saveHistory: true, saveAudio: true }, { saveHistory: true, saveAudio: true }), true);
  assert.equal(togglesEqual({ saveHistory: false, saveAudio: false }, { saveHistory: true, saveAudio: true }), false);
  assert.equal(togglesEqual({ saveHistory: true, saveAudio: false }, { saveHistory: true, saveAudio: true }), false);
});
