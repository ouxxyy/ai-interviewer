/** T1-R 音频工具：WAV 封装、PCM 分片、真实语音合成（macOS `say` + ffmpeg）、摘要与时长。 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './env.js';

/** 把裸 PCM（s16le、单声道）封装为 WAV。 */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function pcmDurationSeconds(pcm: Buffer, sampleRate: number): number {
  return Number((pcm.length / 2 / sampleRate).toFixed(3));
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 峰值归一化幅度（0–1），用于判断「这段音频不是静音」。 */
export function peakAmplitude(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return Number((peak / 32768).toFixed(4));
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeAudio(
  dir: string,
  name: string,
  pcm: Buffer,
  sampleRate: number,
): { path: string; wavPath: string; pcmPath: string; bytes: number; durationSeconds: number; sha256: string; peak: number } {
  ensureDir(dir);
  const wav = pcmToWav(pcm, sampleRate);
  const wavPath = path.join(dir, `${name}.wav`);
  const pcmPath = path.join(dir, `${name}.pcm`);
  writeFileSync(wavPath, wav);
  writeFileSync(pcmPath, pcm);
  return {
    path: path.relative(REPO_ROOT, wavPath),
    wavPath,
    pcmPath,
    bytes: pcm.length,
    durationSeconds: pcmDurationSeconds(pcm, sampleRate),
    sha256: sha256(pcm),
    peak: peakAmplitude(pcm),
  };
}

export interface SpeechCheck {
  available: boolean;
  reason?: string;
}

/** 本机是否具备真实语音合成能力（macOS `say` + ffmpeg）。 */
export function speechToolingAvailable(): SpeechCheck {
  if (process.platform !== 'darwin') return { available: false, reason: '非 macOS，`say` 不可用' };
  if (!existsSync('/usr/bin/say')) return { available: false, reason: '/usr/bin/say 不存在' };
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    return { available: false, reason: 'ffmpeg 不可用' };
  }
  return { available: true };
}

/**
 * 用 macOS 内置语音合成生成一段中文口语音频，转成 16kHz 单声道 s16le PCM。
 *
 * 边界声明（写入验收记录）：合成的是**回答音频内容**，不是真人对着麦克风说话。
 * 服务端 ASR、模型、事件链路全部真实；真人麦克风采集属 T3 页面链路。
 */
export function synthesizeAnswerPcm(text: string, outPcmPath: string, voice = 'Tingting'): Buffer {
  const aiff = `${outPcmPath}.aiff`;
  ensureDir(path.dirname(outPcmPath));
  execFileSync('/usr/bin/say', ['-v', voice, '-o', aiff, text], { stdio: ['ignore', 'ignore', 'pipe'] });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-ar', '16000', '-ac', '1', '-f', 's16le', outPcmPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  return readFileSync(outPcmPath);
}

/** 按固定分片切 PCM（默认 100ms @16k）。 */
export function chunkPcm(pcm: Buffer, chunkBytes = 3200): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pcm.length; off += chunkBytes) out.push(pcm.subarray(off, Math.min(off + chunkBytes, pcm.length)));
  return out;
}
