/**
 * 使用告知（冻结文案，版本 `disclosure@0.2.0`）。
 *
 * 必须说清四件事（PM §5 / MYW-85）：哪些内容留本机、哪些发给云模型、保存位置与删除方式、费用怎么结算。
 * 这里写成**结构化字段**而不是一段散文：接口返回它，前端直接渲染；
 * 改文案要升 `DISCLOSURE_VERSION`，用户需重新确认（`SettingsStore.needsDisclosure()`）。
 */

export const DISCLOSURE_VERSION = 'disclosure@0.2.0';

export const DISCLOSURE = {
  version: DISCLOSURE_VERSION,
  /** 留在本机（不上传）。 */
  staysLocal: [
    '你粘贴或上传的 JD 与经历原文（只在本地服务与浏览器之间传输）',
    '每轮回答的原始转写与你的修订文本',
    '五维反馈、重答对比与全场报告',
    '用户轨与面试官轨的录音文件（仅当「保存录音」开启）',
    'SQLite 历史库与本机日志',
  ],
  /** 发送给云模型（阿里百炼）的内容。 */
  sentToCloud: [
    'JD 与经历文本 → 用于生成 3 道主问题（文本模型）',
    '每轮回答的确认文本 → 用于追问判定与五维评审（文本模型）',
    '面试官要朗读的问题文本 → 实时语音模型据此合成语音（实时模型）',
    '你的回答音频 → 实时语音模型做转写（实时模型）',
    '配置时密钥只经浏览器到 127.0.0.1 本地服务的一次同源请求，随后仅保存在项目根 .env；不会写入浏览器存储、日志、报告或录屏',
  ],
  /** 保存位置（相对仓库根，便于你自己去看／删）。 */
  storage: {
    root: 'data/web/',
    database: 'data/web/interview.sqlite',
    audio: 'data/web/audio/<会话 id>/turn-<轮次>-user.wav 与 turn-<轮次>-interviewer.wav',
    uploads: 'data/web/tmp/uploads/（解析 PDF／DOCX 时的临时文件，解析结束即删）',
    note: '关闭「保存历史」后不再产生新的会话记录与录音；关闭「保存录音」后只保留文本记录。旧记录不会因为关开关被删除。',
  },
  /** 删除方式。 */
  deletion: [
    '按会话删除：调用 DELETE /api/sessions/<id>，同时移除数据库记录、录音文件与该会话的临时文件，并返回删除前后对照',
    '整库清除：停止服务后直接删除 data/web/ 目录（先确认没有要保留的记录）',
    '关掉开关只影响之后的保存，不会暗中删除旧记录',
  ],
  /** 费用结算。 */
  billing: {
    payer: '由你在阿里百炼账户按实际用量结算，本项目不代收、不代付',
    pricing: '官方单价未核定（D7：本机网络环境访问不到阿里云定价页），因此界面不写死金额；请以百炼控制台账单为准',
    counter: '每场会话在本地记录文本 token 与音频字节数，可在会话详情里核对用量',
  },
} as const;

export type Disclosure = typeof DISCLOSURE;

/** Public hosting has a separate consent version; local consent stays unchanged. */
export const PUBLIC_DISCLOSURE = {
  ...DISCLOSURE,
  version: 'disclosure@public-1',
  staysLocal: [
    '开启保存后，材料、转写、反馈、报告与可选录音保存在本站服务器，按访客隔离；并非只留在你的电脑。',
    '浏览器保存 HttpOnly 访客 Cookie，它是访问历史与配置的唯一凭证；请勿共享浏览器个人资料。',
    '清除 Cookie、换浏览器或无痕窗口会成为新访客，无法恢复旧记录。服务器管理员有管理数据的能力。',
  ],
  sentToCloud: [
    ...DISCLOSURE.sentToCloud.slice(0, 4),
    'API Key 经本站同源 HTTPS 提交，在服务器加密保存；不回显、不写浏览器存储或日志。本站以你的 Key 调用百炼。',
  ],
  storage: {
    root: '本站服务器的访客独立目录', database: '每位访客独立的 SQLite 历史库',
    audio: '每位访客独立的录音目录', uploads: '上传解析临时文件（解析完即删）', note: DISCLOSURE.storage.note,
  },
  deletion: [
    '在历史记录页面删除单场训练，同时删除其文本记录与录音。',
    '清除浏览器 Cookie 不会删除服务器数据；请先删除历史，再清理 Cookie。',
    '如需停用 Key，请在百炼控制台撤销；备份中的历史数据按站点备份保留期清理。',
  ],
};
