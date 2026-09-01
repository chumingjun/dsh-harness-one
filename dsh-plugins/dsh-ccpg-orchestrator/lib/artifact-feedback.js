// 产物评论与修订（issue #97 轻通道）：微图构造与修订提取的纯函数。
// 服务端路由 lib/index.js 消费；单测 test/artifact-feedback.test.mjs 直接跑这里。

const REVISION_AGENT_NODE_ID = 'revision_agent';
const MAX_INLINE_BODY = 2000;
const MAX_REVISION_CONTENT = 120 * 1024; // 修订正文入库上限，防超大文件撑爆 document_json 行

export function revisionAgentNodeId() {
  return REVISION_AGENT_NODE_ID;
}

function clampText(value, max, label) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（${label}过长已截断）`;
}

// 评论列表 → 有序去重的用户意见文本；单条超长截断
export function formatCommentBodies(comments = []) {
  const seen = new Set();
  const lines = [];
  for (const comment of comments || []) {
    const body = String(comment?.body || '').trim();
    if (!body || seen.has(body)) continue;
    seen.add(body);
    lines.push(clampText(body, MAX_INLINE_BODY, '评论'));
  }
  return lines;
}

// 单 agent 微图：原稿已由路由复制进该节点输出目录，prompt 只携带评论清单（与文档长度解耦）
export function buildRevisionGraph({ comments = [], originalName, fileName, sourceFileName, instruction } = {}) {
  const lines = formatCommentBodies(comments);
  const inputName = sourceFileName || fileName;
  const commentBlock = lines.length
    ? lines.map((body, index) => `${index + 1}. ${body}`).join('\n')
    : '（无具体评论，按通用润化要求处理）';
  const prompt = [
    '你是一名文稿修订编辑。用户在工作流产物文稿上写下了评论/修改建议，你的任务：以原稿为唯一事实来源，按评论逐条落实修改，产出完整修订稿。',
    '- 原稿只读，绝不改动；修订稿必须写入你自己的输出目录。',
    '- 未被评论涉及的内容保持原样，不做自由发挥；格式约定（Markdown 层级、代码块语言标注等）与原稿一致。',
    `- 修订稿文件名固定为 ${fileName}，与原稿同名便于对照（不同目录不会覆盖）。`,
    `- 原稿副本文件名为 ${inputName}，只读读取，不要覆盖、删除或把它当作修订稿交付。`,
    '- 最终回复只需简述改了什么（每条评论一行），不要复述全文。',
  ].join('\n');
  const inputTemplate = [
    `原稿：${originalName}（副本 ${inputName} 已放入你的输出目录，用 read 工具读取全文）`,
    instruction ? `补充要求：${clampText(instruction, MAX_INLINE_BODY, '补充要求')}` : '',
    '',
    '用户评论/修改建议：',
    commentBlock,
  ].filter((line) => line !== '').join('\n');
  return {
    nodes: [{
      id: REVISION_AGENT_NODE_ID,
      type: 'agent',
      position: { x: 0, y: 0 },
      data: {
        label: '按评论修订',
        prompt,
        inputTemplate,
        inputFiles: [inputName],
        skills: [],
      },
    }],
    edges: [],
  };
}

// 从改写 run 的产物快照中选修订稿：优先同名 md/doc 类文本，否则第一个文本产物
function pickRevisionArtifact(artifacts = [], fileName) {
  const textual = (artifact) => /\.(md|markdown|txt)$/i.test(artifact?.name || '');
  return artifacts.find((artifact) => artifact?.nodeId === REVISION_AGENT_NODE_ID && artifact?.name === fileName)
    || artifacts.find((artifact) => artifact?.nodeId === REVISION_AGENT_NODE_ID && textual(artifact))
    || artifacts.find((artifact) => artifact?.nodeId === REVISION_AGENT_NODE_ID) || null;
}

// run 落盘后提取修订记录入版本链；读文件由调用方注入（保持纯函数可测）
export function extractRevision({ run, fileName, readFile }) {
  if (!run || run.status !== 'success') return null;
  const artifact = pickRevisionArtifact(run.artifactIndex || [], fileName);
  if (!artifact?.snapshot) return null;
  let content = null;
  try {
    content = clampText(readFile(artifact), MAX_REVISION_CONTENT, '修订正文');
  } catch {
    content = null; // 快照读失败：记录元数据，正文留空，前端提示下载兜底
  }
  return {
    nodeId: REVISION_AGENT_NODE_ID,
    revisionRunId: run.runId,
    name: artifact.name,
    summary: String(run.outputs?.[REVISION_AGENT_NODE_ID] || '').slice(0, 500) || null,
    fileName: artifact.name,
    content,
  };
}
