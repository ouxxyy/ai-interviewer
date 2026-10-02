# 安装与验证（ai-interviewer Skill）

> 版本戳：`rules@0.3.0 ｜ contract@0.3.0 ｜ prompts@0.3.2 ｜ rulesDigest=705810975eedae29edbc9bb6006e5d0c43588c4e87abb69a4c79dcae4334a7a8`
> 本入口是**纯文字**训练：没有录音、没有实时语音、不能听也不能说。

## 安装

Skill 就是一个目录。选一种装法：

**A. 项目内（推荐，不动全局配置）**

```bash
mkdir -p <你的项目>/.claude/skills <你的项目>/.codex/skills
cp -R skills/ai-interviewer <你的项目>/.claude/skills/     # Claude Code
cp -R skills/ai-interviewer <你的项目>/.codex/skills/      # Codex
```

**B. 全局（所有项目可用）**

```bash
cp -R skills/ai-interviewer ~/.claude/skills/              # Claude Code
cp -R skills/ai-interviewer ~/.codex/skills/               # Codex
```

## 验证装上了

对宿主说：

> 请使用 ai-interviewer 技能开始一场中文经历面试训练。先告诉我你的能力边界和你遵循的规则版本号。

期望回答里同时出现：**「没有录音／没有实时语音」**与 **`rules@0.3.0`**。
两项缺一，就说明 Skill 没被加载（或加载到了别的版本）。

## 卸载

```bash
rm -rf <你的项目>/.claude/skills/ai-interviewer   # 或 ~/.claude/skills/ai-interviewer
rm -rf <你的项目>/.codex/skills/ai-interviewer    # 或 ~/.codex/skills/ai-interviewer
```

## 实测状态

当前 rules@0.3.0 的 Codex、Claude Code 宿主实测均为**未验证**。旧版 `rules@0.2.0` 的 Codex 边界自报证据仍保留在 `evidence/t3/hosts/codex-raw.txt`，仅证明旧版，不代表四环节 0.3 已通过；Claude Code 的历史配额阻塞同样不代表当前状态。
新版宿主原始输出与判定写入 `evidence/t3/v0.3.0/prompts-v0.3.2/hosts/`；每次模型运行独占其下 `runs/<runId>/`。真实调用需要另行授权费用。

## 边界

- 规则正文来自 `references/rules.md`，它与仓库规则源 `src/rules/rules.ts` **同源生成**；
  改规则要改源并重跑生成器，别直接编辑本目录里的 `rules.md`。
- Skill 不产生录音、不产生音频文件，也不声称有回放能力。
