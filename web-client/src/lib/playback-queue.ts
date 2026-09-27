/**
 * 下行播放队列（P2-2）。
 *
 * 三条不变量：
 * 1. **暂停不能丢音频尾巴**：暂停只挂起播放上下文，不 stop 当前 buffer；
 *    恢复后当前 buffer 从原位置继续，队列顺序不变。
 * 2. **打断必须清空待播**：当前 buffer 立刻停，队列清空，并报告清掉了几段。
 * 3. 顺序播放：上一段 ended 才播下一段，队列空时回到 idle。
 *
 * 与 Web Audio 解耦（`PlaybackSink` 注入），因此可以在 Node 里直接回归。
 */

export interface PlaybackSink<B> {
  /** 开始播放一段，并在结束时回调 `onEnded`；返回停止函数。 */
  play(buffer: B, onEnded: () => void): () => void;
  /** 挂起输出（保留当前位置）。 */
  suspend(): void;
  /** 恢复输出。 */
  resume(): void;
}

export type QueueStatus = 'playing' | 'idle';

export class PlaybackQueue<B> {
  private queue: B[] = [];
  private stopCurrent: (() => void) | null = null;
  private paused = false;
  private playing = false;
  private token = 0;

  constructor(
    private readonly sink: PlaybackSink<B>,
    private readonly onStatus: (status: QueueStatus) => void,
  ) {}

  get pending(): number {
    return this.queue.length;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  enqueue(buffer: B): void {
    this.queue.push(buffer);
    if (!this.paused && !this.playing) this.playNext();
  }

  /** 挂起：当前 buffer 仍在「播放中」，只是输出被挂起，不会丢尾巴。 */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.sink.suspend();
  }

  /** 恢复：继续当前 buffer；若当前已结束就接着播队列。 */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.sink.resume();
    if (!this.playing) this.playNext();
  }

  /** 打断：停当前 + 清空待播，返回被清掉的待播段数（不含正在播的那一段）。 */
  clear(): number {
    const cleared = this.queue.length;
    this.queue = [];
    this.token += 1;
    const stop = this.stopCurrent;
    this.stopCurrent = null;
    this.playing = false;
    if (stop !== null) stop();
    this.onStatus('idle');
    return cleared;
  }

  private playNext(): void {
    if (this.paused || this.playing) return;
    const buffer = this.queue.shift();
    if (buffer === undefined) {
      this.playing = false;
      this.onStatus('idle');
      return;
    }
    this.playing = true;
    this.token += 1;
    const token = this.token;
    this.onStatus('playing');
    this.stopCurrent = this.sink.play(buffer, () => {
      if (token !== this.token) return;
      this.stopCurrent = null;
      this.playing = false;
      this.playNext();
    });
  }
}
