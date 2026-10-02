/** 验收输入与工作目录预检；不加载凭证、不执行模型或浏览器。 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const ANSWER_TEXTS = [
  '我是一名应届毕业生，希望申请内容运营岗位。我最相关的经历是毕业季征稿活动，负责主题策划、院系渠道沟通和冷启动内容。我先通过问卷了解同学偏好，再联系宣传委员扩散，活动最终收到一百四十三篇投稿。这个经历让我积累了把用户需求转成内容活动、协调渠道并复盘结果的经验，也希望在这个岗位继续练习这些能力。',
  '我在毕业季征稿活动里负责整体策划和落地。前期我用问卷收集了两百份同学偏好，把主题定成毕业故事，然后联系了五个院系的宣传委员帮我扩散，自己写了两篇范文做冷启动。活动两周收到一百四十三篇投稿，比上一期增长大概八成。',
  '这件事里我个人的贡献主要是渠道设计和冷启动内容。渠道上我谈下了五个院系的宣传委员，设计了二次触达的提醒机制；内容上我写了两篇范文，把投稿门槛降下来。最后投稿里大概三成来自我直接推动的院系。',
  '我遇到的困难是第一次活动只有三个院系投稿集中，其他院系几乎没人参加。我复盘发现宣传委员只在群里发了一次通知，所以第二次我改成先给每个院系单独做选题建议，再请他们在班级群二次触达，参与院系增加到七个。',
  '复盘时我最大的反思是前期没有定义清楚什么算一次有效投稿，导致统计口径改过两次。后来我把投稿标准、统计时点和负责人写进了活动 SOP，下一次活动就没有再返工。',
  '如果重答一次，我会先说明活动目标是把投稿量从八十篇提到一百五十篇，再讲我个人的三个动作：问卷调研定主题、谈下五个院系渠道、写范文做冷启动，最后给出投稿一百四十三篇、增长约八成、参与院系从三个增加到七个的结果。',
  '我还想补充一点，活动结束后我把选题库和范文模板整理成了可复用的文档，下一届的同学可以直接用，这部分沉淀目前还没有量化到结果里。',
];

export interface EvidenceWorkspace {
  dataDir: string;
  harnessDir: string;
  audioWork: string;
}

/** 只计算本版本、本次运行的新路径，不创建或删除目录。 */
export function evidenceWorkspace(repoRoot: string, version: string, runId: string): EvidenceWorkspace {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error('非法验收版本或运行标识');
  }
  const dataDir = path.join(repoRoot, 'data', 'web-evidence', `v${version}`, runId);
  const harnessDir = path.join(repoRoot, 'data', 'web-evidence-harness', `v${version}`, runId);
  return { dataDir, harnessDir, audioWork: path.join(harnessDir, 'answer-audio') };
}

/** 仅创建本轮目录；保留旧版本及前次运行，已有目标拒绝覆盖。 */
export function prepareEvidenceWorkspace(workspace: EvidenceWorkspace): void {
  const roots = [workspace.dataDir, workspace.harnessDir];
  for (const dir of roots) {
    if (existsSync(dir)) throw new Error(`验收工作目录已存在，拒绝覆盖：${dir}`);
  }
  for (const dir of roots) {
    mkdirSync(path.dirname(dir), { recursive: true });
    // 不使用recursive创建叶目录，竞态时也以EEXIST拒绝覆盖。
    mkdirSync(dir);
  }
  mkdirSync(workspace.audioWork);
}

/** 每段声明文本对应一份独立有效PCM；预检失败不进入后续模型调用。 */
export function assertAnswerAudioPool(texts: readonly string[], pcmFiles: readonly string[]): void {
  if (texts.length === 0 || pcmFiles.length !== texts.length) {
    throw new Error(`作答音频池数量不符：texts=${texts.length}, pcm=${pcmFiles.length}`);
  }
  if (new Set(pcmFiles.map((file) => path.resolve(file))).size !== texts.length) {
    throw new Error('作答音频池存在重复PCM文件');
  }
  for (const [i, file] of pcmFiles.entries()) {
    if (!texts[i]?.trim()) throw new Error(`作答音频池第${i + 1}段文本为空`);
    if (!existsSync(file)) throw new Error(`作答音频池缺少PCM文件：${file}`);
    const stat = statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size % 2 !== 0) {
      throw new Error(`作答音频池PCM16无效：${file}`);
    }
  }
}
