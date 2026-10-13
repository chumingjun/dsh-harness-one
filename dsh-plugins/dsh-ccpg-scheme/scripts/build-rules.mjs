import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bundleChapterResources } from './bundle-chapter-resources.mjs';
import { MATERIAL_READING_RULE } from '../lib/material-reading.js';

const text = (value) => value == null ? '' : String(value).trim();
const yes = (value) => ['是', 'yes', 'true', 'required'].includes(text(value).toLowerCase());
const no = (value) => ['否', 'no', 'false', 'optional'].includes(text(value).toLowerCase());
const slug = (value) => text(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'unnamed';
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const runtimeAgents = `# CCPG Scheme Runtime Rules

This installed rule pack is compiled from an authorized business snapshot and
is a candidate until each knowledge reference and CCPG CLI mapping is verified.
Read \`.ccpg-scheme/index.json\` before processing a chapter and use the same DSH
native session for the serial chapter run.

- Follow chapter \`order\` and declared \`dependencies\`; do not silently skip,
  reorder, or invent missing inputs.
- Finish and submit the current chapter before reading later chapters' knowledge
  or drafting their outputs. A failed submission does not advance the chapter.
- Treat blocker entries in \`.ccpg-scheme/manifest.json\` as hard stops for affected chapters.
- Keep source materials, notes, body, attachments, evidence, confirmations, and
  runtime state separate. Never treat a filename or summary as source content.
- When the user supplies a Feishu spreadsheet as the actual scheme material
  list, use \`feishu_collect_materials\` to save all linked originals and the
  inventory inside this workspace without per-file confirmation. Reuse verified
  local downloads, resume pending exports with the same tool, then parse and bind
  the originals. Links supplied only as examples must not be read or downloaded.
- Use CCPG CLI through the standard \`ccpg-cli\` command only after project,
  permission, fields, period, metric scope, and capability evidence are verified.
  Otherwise request the user's material or explicit clarification.
${MATERIAL_READING_RULE}
- Draft in this same conversation; do not delegate a whole chapter just to reread
  its materials. Reuse verified readings and source-backed notes. Save each completed section
  with native file tools to \`materials/notes/<chapter-id>-draft.md\`; preserve unfinished
  sections across interruptions. Review all declared outputs, exact facts, evidence and
  gaps before \`chapter_submit\`. Prefer \`bodyPath\` to submit the saved Markdown once.
- 正文面向业务读者，开头直接进入章节内容；不要暴露材料编码、文件名、源表行号、
  Skill 名、工具调用、内部路径或“依据如下”等内部执行说明。来源关系只保存在
  evidence、contextRefs 和方案索引中。
- A knowledge inventory or law-name list is an index, not the authoritative text.
  Resolve only the sources required for the current chapter through available native
  search/browser tools or current-user Feishu CLI. For laws, use issuing authorities
  and verify jurisdiction, effective dates and applicable clauses. Save readable originals
  or faithful Markdown under \`materials/input/knowledge\`, retaining source URL,
  retrieval date and version; parse/register them before preparation and reuse verified
  downloads. Do not claim a list, search snippet or model memory is the original.
  If tools, permission or authoritative text are unavailable, preserve the gap and
  request the missing source; never invent a retrieval or citation.
- Submit only complete, evidence-backed artifacts through the scheme tools.
  Human confirmation is separate from model generation.
- Parse and register relevant source materials before chapter preparation. Evidence
  sources must be a registered material or artifact ID returned by scheme tools,
  never a file path, title, or prose citation.
- \`chapter_prepare\` automatically binds declared bundled knowledge originals.
  If it reports document review, complete that original once and prepare again;
  do not request it from the user or register a bundled summary as the original.
- Use \`chapter_prepare.outputs\` for attachments: exact \`outputId\`, readable
  \`name\` including an extension, and exactly one \`content\`, \`contentPath\`,
  \`filePath\` or \`base64\`. A saved UTF-8 attachment under \`materials/notes\`
  uses \`contentPath\`; image and binary originals use workspace-relative \`filePath\`.
  Preserve real image attachments and insert required body images at the declared
  position using standard inline Markdown \`![description](<local-file-path>)\`.
  Do not replace originals with prose or HTML/reference-style image tags.
  A rejected submission preserves its draft; correct parameters rather than
  regenerate its content.
- If a native scheme tool reports an internal failure, use only documented
  recovery once when appropriate. If the same error repeats, stop the current
  chapter and report it. Do not inspect plugin source, call private HTTP
  endpoints, or use shell/file tools to bypass scheme tools.
- Treat these user phrases as product commands and execute the needed internal
  tools yourself: "start the scheme" initializes when needed then prepares the
  first ready chapter; "continue" recovers and prepares the next ready chapter;
  "I added materials" copies current DSH conversation attachments into
  \`materials/input\` with the native file capability, then parses and binds
  available inputs. The directory is internal and is never named to the user.
  Never ask the user to name \`project_create\`, \`chapter_prepare\`, skill files,
  or \`chapter_submit\`. Ask only one plain-language question when a required
  material is still missing, and explain a blocked chapter by its business gap.
- When the user asks "整理这次测试的问题" or requests a problem report, call
  \`scheme_validation_report\` and return the saved local report as a clickable file.
- Use \`ccpg_project_find\` and \`ccpg_project_fetch\` for current-user CCPG project
  candidates and master-data snapshots. They preserve provenance but remain
  unverified: do not bind them as completed inputs or infer fields, periods and
  metric scope. Request user materials when the required scope cannot be verified.
  Do not reparse materials or start another quality-scoring model.
- Save concise chapter-specific feedback with \`scheme_feedback\`: user feedback
  uses \`source: user\`; an unverified model finding uses \`source: model\`.
  Keep expected and actual behavior separate without copying source materials,
  credentials or full conversation. Reports stay local and never approve content,
  change chapter progress or automatically modify rules.
`;
const rowNumber = (value) => {
  const match = String(value ?? '').match(/\d+/);
  return match ? Number(match[0]) : null;
};

function parseCsv(source) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { cell += '"'; index += 1; }
        else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (char !== '\r') cell += char;
  }
  if (quoted) throw new Error('unterminated CSV quote');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function readAnnotatedCsv(payload) {
  const source = text(payload?.annotated_csv);
  if (!source) return null;
  const lines = source.split('\n').map((line) => line.replace(/^\[row=\d+\]\s?/, ''));
  const matrix = parseCsv(lines.join('\n'));
  const columns = (matrix.shift() || []).map((value) => text(value));
  const rows = matrix.filter((values) => values.some((value) => text(value))).map((values) =>
    Object.fromEntries(columns.map((column, index) => [column, values[index] ?? null])));
  return { columns, rows, payload };
}

function readSheet(dir, logicalName) {
  const legacyPath = path.join(dir, logicalName);
  const sourceName = {
    'input-output.json': '00-main.json',
    'outputs.json': '01-output.json',
    'inputs.json': '02-input.json',
    'dependencies.json': '03-dependencies.json',
    'unified.json': '04-unified.json',
    'collection.json': '05-collection.json',
  }[logicalName];
  let candidate = fs.existsSync(legacyPath) ? legacyPath : path.join(dir, sourceName || logicalName);
  let payload;
  if (fs.existsSync(candidate)) payload = JSON.parse(fs.readFileSync(candidate, 'utf8'));
  else {
    const workbookPath = path.join(dir, 'table.json');
    if (!fs.existsSync(workbookPath)) return null;
    candidate = workbookPath;
    const workbook = JSON.parse(fs.readFileSync(workbookPath, 'utf8'));
    const names = {
      'input-output.json': '项目质量计划输入输出材料清单',
      'outputs.json': '01_输出产物主数据',
      'inputs.json': '02_输入材料主数据',
      'dependencies.json': '03_章节依赖关系明细',
      'unified.json': '04_最终统一依赖表',
      'collection.json': '05_项目需收集资料',
    };
    const sheet = (workbook.sheets ?? []).find((item) => item.name === names[logicalName]);
    if (!sheet) return null;
    payload = { ...sheet, revision: workbook.revision, sheets: [sheet] };
  }
  if (Array.isArray(payload.sheets)) {
    const sheet = payload.sheets[0];
    if (!sheet) return null;
    const columns = sheet.columns ?? [];
    const rows = (sheet.data ?? []).map((values) =>
      Object.fromEntries(columns.map((column, index) => [column, values[index] ?? null])));
    return { file: path.basename(candidate), payload, columns, rows };
  }
  const parsed = readAnnotatedCsv(payload);
  return parsed ? { file: path.basename(candidate), ...parsed } : null;
}

function snapshotRevision(dir) {
  const revisions = new Set();
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  for (const name of files) {
    let payload;
    try { payload = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    const revision = payload.revision ?? payload.data?.revision;
    if (revision != null && Number.isInteger(Number(revision))) revisions.add(Number(revision));
  }
  if (revisions.size > 1) throw new Error(`snapshot revision mismatch: ${[...revisions].sort((a, b) => a - b).join(', ')}`);
  return [...revisions][0] ?? null;
}

function readMergeMetadata(dir) {
  const candidates = ['merges.json', '01-project-quality-input-output-structure.json', 'structure.json'];
  for (const name of candidates) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (payload?.data?.merged_cells || payload?.merged_cells) return payload;
    } catch {}
  }
  return null;
}

function applyMerges(sheet, mergePayload) {
  const rows = sheet?.rows ?? [];
  const merges = mergePayload?.data?.merged_cells ?? mergePayload?.merged_cells ?? [];
  const columnIndex = (letters) => [...letters].reduce((number, char) => number * 26 + char.charCodeAt(0) - 64, 0) - 1;
  for (const merge of merges) {
    const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(merge.range ?? '');
    if (!match) continue;
    const [c1, r1, c2, r2] = [columnIndex(match[1]), Number(match[2]) - 2, columnIndex(match[3]), Number(match[4]) - 2];
    const value = rows[r1]?.[sheet.columns[c1]];
    if (!value) continue;
    for (let row = r1; row <= r2; row += 1) for (let column = c1; column <= c2; column += 1) {
      const name = sheet.columns[column];
      if (rows[row] && !text(rows[row][name])) rows[row][name] = value;
    }
  }
  return sheet;
}

function indexBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const value = text(row[key]);
    if (value) map.set(value, row);
  }
  return map;
}

function parseRequired(value) {
  if (yes(value)) return true;
  if (no(value)) return false;
  return 'unknown';
}

function splitRefs(value) {
  return text(value).split(/[；;\n]/).map((item) => item.trim()).filter(Boolean);
}

function resourceFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const result = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (!entry.name.endsWith('metadata.json')) result.push(file);
    }
  };
  walk(dir);
  return result.sort();
}

function metadataDirectories(dir) {
  const result = [];
  const walk = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === 'metadata.json')) result.push(current);
    for (const entry of entries) if (entry.isDirectory()) walk(path.join(current, entry.name));
  };
  walk(dir);
  return result;
}

function capabilityEvidenceByInput(items) {
  const evidence = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.cli !== 'ccpg-cli' || item.verified !== true || !text(item.inputId) || !text(item.capability)
      || !text(item.verifiedAt) || !Array.isArray(item.fields) || !item.fields.length) continue;
    evidence.set(text(item.inputId), item);
  }
  return evidence;
}

export function writeSkill(root, chapter, outputs, blockers) {
  const dir = path.join(root, path.dirname(chapter.skill));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    '---',
    `name: ccpg-${chapter.id}`,
    `description: ${JSON.stringify(`在编制或修改物业服务方案的“${chapter.title}”章节时使用。结合当前项目材料、随附知识与模板生成本章正文和附件。`)}`,
    '---',
    '',
    `# ${chapter.title}`,
    '',
    '按已声明输入、输出模板和依赖生成本章节成果。不得把项目示例、文件名或历史数据当作当前项目事实。',
    '',
    '## Processing',
    `- 本章编码 ${chapter.code}，自然顺序 ${chapter.order}。按方案工作目录的 \`.ccpg-scheme/manifest.json\` 校验执行资格，读取 \`.ccpg-scheme/index.json\` 定位材料、解析结果和已提交成果。下方文件链接均相对于本 SKILL.md 所在目录。`,
    '- 复用同一原生会话和已有解析结果；先读必要笔记，再按来源定位精确回读原文，不重复全量解析。',
    '- 当前章提交成功前，不读取后续章知识或起草后续章；提交失败保留正文和附件，只纠正调用参数，重复内部失败则报告问题，不查插件源码或绕过工具。',
    '- 按下列业务规则处理当前项目输入和前置成果。输入编码标识材料用途，不要求用户提供同名文件；按内容匹配并记录当前项目绑定。',
    '- 读取本章必需知识和本次输出模板正文；采集模板仅在材料匹配或补缺项时读取，案例在需要表达参考时读取，必要时核对原件和图片。模板约束结构和字段；案例中的项目、数值、日期与已填数据不能用于当前项目。',
    '- 随附资源的解析状态只是采集快照，不代表当前原件一定需要视觉处理。先使用 material_parse 核对当前原件；complete 直接复用，只按实际业务缺口核对 needs-review/needs-vision。缺少可选案例不阻止生成，缺少必需知识或模板则报告具体缺口。',
    '- 原件和知识文件尚未解析时，使用内置 PDF/Office 技能或多模态能力转换并保存可追溯 Markdown；摘要不替代原文。',
    '- chapter_prepare 自动登记并绑定本章已内置知识原件；提示需文档核对时，按返回材料 ID、原件和解析路径完成核对后重试，不要求用户重新上传内置知识。不调用另一个图片服务重复核验。',
    '- 知识汇编若只有法规名称、文件清单或摘要，它是索引，不是权威原文。只补当前章实际需要的来源：使用当前 DSH 可用的原生搜索/浏览器能力，飞书来源优先用当前用户飞书 CLI；法规优先查发布机关原文，并核对项目所在地、有效期及适用条款。',
    '- 将查得的原件或忠实原文 Markdown 以可读名称保存到 materials/input/knowledge，记录来源 URL、获取日期和版本，准备前解析登记；后续精确引用已保存且核实有效的材料，不重复搜索下载。搜索摘要和模型记忆不替代原文。工具不可用、无权限或原文未取得时保留缺口，请求补充，不能声称已参考。',
    '',
    '## Rules',
    ...(chapter.rules.length ? chapter.rules.flatMap((rule) => rule.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean).flatMap((part) => part.startsWith('-') ? part.split('\n') : [`- ${part}`])) : ['- 业务规则未从来源快照取得，运行前必须补充或确认。']),
    '',
    '## Inputs',
    ...chapter.inputs.map((input) => `- ${input.id}: ${input.name || input.id} (${input.required === true ? '必需' : input.required === false ? '可选' : '必需性待确认'}); 来源行: ${(input.sourceRows ?? []).join(', ') || '未标注'}`),
    '',
    '## Dependencies',
    ...(chapter.dependencies.length ? chapter.dependencies.map((id) => `- 前置章节: ${id}；使用已提交的有效成果，不重复生成。`) : ['- 无声明的跨章节依赖。']),
    ...outputs.flatMap((output) => output.dependencies.map((id) => `- ${output.id} <- ${id}`)),
    '',
    '## Outputs',
    ...outputs.map((output) => `- ${output.id}: ${output.name} (${output.kind}); 模板: ${output.template || '未定义，须确认输出要求'}${chapter.outputDefinitionSource?.kind === 'internal-supplement' ? '；来源：内部测试补充定义，业务验收前不得当作源表定义' : ''}`),
    '',
    '## Drafting',
    '- 默认在当前同一会话逐节成稿，不另开子智能体重新读取整章材料。已读且未变的材料、模板及知识直接复用，只有事实缺口或冲突才按位置精确回读。',
    `- 首次核对事实后，必要时把可复用事实记在 \`materials/notes/${chapter.id}-facts.md\`：数值、来源材料 ID 与位置、期间、单位、冲突和待确认项；简要标明已完成小节。笔记不是完整原文，不替代未读材料。`,
    `- 按 Outputs 及章内依赖顺序，每完成一个正文小节立即保存到 \`materials/notes/${chapter.id}-draft.md\`；长小节可分段保存。使用原生文件工具的实际参数；write 必须同时提供 file_path 和 content，后续使用原生 edit 续写，不重复输出整篇已有正文。`,
    '- 有材料支持即可形成正文，不先在分析中写一遍完整章节再重写；数据冲突按来源列为待确认，不为自行消除冲突反复推演。不压缩模板必需字段、关键依据和必要解释。',
    '- 中断后先看现有草稿和事实笔记，只补未完成部分；已有提交则先读有效成果。最终做一次完整性、模板、数字、证据与附件核对，缺口或人工确认单列，不提前提交部分章节。',
    '- 通过 chapter_submit 的 bodyPath 提交保存的完整正文；summary 只保留后续可复用概况和来源指针，证据、附件和确认项仍单独提交。不要再次把整章正文写入工具参数。',
    '- 附件使用 chapter_prepare.outputs 中 kind=attachment 的精确 id 作为 outputId，name 为含扩展名的可读文件名；content、materials/notes 下的 contentPath、项目内原件 filePath 或 base64 四选一。图片和其他二进制优先用 filePath，不要求模型编造 Base64。不得使用 id、文件路径或自行命名值替代 outputId。',
    '- 图片附件提交真实原图，不用 Markdown 文字解读替代。正文或 Markdown 附件需在指定位置显示原图时，使用标准 ![说明](<materials/原图路径>) 引用项目内 PNG/JPEG/GIF/WebP 原件；插件保存原图快照并保留位置，解析说明与原图分开。图文文件可用原生/官方技能提取其中真正要交付的原图，不以页面截图或水印替代。',
    '',
    '## Boundaries',
    '- 正文面向业务读者，开头直接进入章节内容；不要暴露材料编码、文件名、源表行号、Skill 名、工具调用、内部路径或“依据如下”等内部执行说明。来源关系保存到 evidence、contextRefs 和方案索引中。',
    '- 正文、附件、证据和确认项分开保存。',
    '- 完成后通过方案工具提交成果并更新索引；人工确认由用户完成，不以文件存在代替有效提交。',
    '- 必需输入缺失或关键事实冲突时报告具体缺口；可选输入缺失时仅省略其支撑的结论。不要根据来源名称预设统一事实优先级。',
    '- 数据工具标准名称是 CCPG CLI，实际命令是 `ccpg-cli`；仅使用 manifest 中有明确能力证据的数据映射，不猜测资源或端点。',
    ...blockers.map((blocker) => `- BLOCKER ${blocker.code}: ${blocker.message}`),
    '',
    '## 随附知识、模板与案例',
    ...(chapter.references ?? []).map((ref) => ref.original
      ? `- ${ref.roles.join(' / ')}${ref.inputIds.length ? `（${ref.inputIds.join('、')}）` : ''}：${ref.title}。${ref.content ? `[读取正文](<${ref.content}>)；` : ''}[核对原件](<${ref.original}>)。解析状态：${ref.parseStatus ?? '待解析'}。`
      : `- ${ref.roles.join(' / ')}：${ref.title}。已按用户要求跳过，不能声称已参考此文件。`),
    '',
  ];
  fs.writeFileSync(path.join(dir, 'SKILL.md'), lines.join('\n'));
}

function detectCycles(nodes, edges) {
  const visiting = new Set(), visited = new Set();
  const visit = (node) => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of edges.get(node) ?? []) if (visit(next)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return nodes.some(visit);
}

function chapterCode(value) {
  const match = text(value).match(/^\d+(?:\.\d+)*/);
  return match?.[0] || '';
}

function naturalCompare(left, right) {
  const a = String(left).split('.').map(Number);
  const b = String(right).split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const result = (a[index] ?? 0) - (b[index] ?? 0);
    if (result) return result;
  }
  return String(left).localeCompare(String(right));
}

export function compile(snapshotDir, outputDir, options = {}) {
  if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length) throw new Error(`output directory is nonempty: ${outputDir}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const names = ['input-output.json', 'inputs.json', 'outputs.json', 'dependencies.json', 'unified.json', 'collection.json'];
  const sheets = Object.fromEntries(names.map((name) => [name, readSheet(snapshotDir, name)]));
  const missing = Object.entries(sheets).filter(([, value]) => !value).map(([name]) => name);
  const merges = readMergeMetadata(snapshotDir);
  const sourceRevision = snapshotRevision(snapshotDir);
  if (sheets['input-output.json']) applyMerges(sheets['input-output.json'], merges);

  const unified = sheets['unified.json']?.rows ?? [];
  const inputRows = sheets['inputs.json']?.rows ?? [];
  const outputRows = sheets['outputs.json']?.rows ?? [];
  const inputOutputRows = sheets['input-output.json']?.rows ?? [];
  const inputMap = indexBy(inputRows, '输入编码');
  const outputMap = indexBy(outputRows, '输出编码');
  const chapterMap = new Map();
  const ensureChapter = (code, title) => {
    const key = chapterCode(code) || text(code) || 'unknown';
    if (!chapterMap.has(key)) chapterMap.set(key, {
      id: `chapter-${slug(key)}`, code: key, title: text(title) || `章节 ${key}`, rows: [], rules: [], blockers: [],
    });
    return chapterMap.get(key);
  };
  for (const row of outputRows) ensureChapter(row['所属章节编码'], row['所属章节名称']);
  for (const row of unified) {
    const chapter = ensureChapter(row['章节编码'], row['章节名称']);
    chapter.rows.push(row);
    const rule = text(row['规则']);
    if (rule && !chapter.rules.includes(rule)) chapter.rules.push(rule);
  }
  const mainRuleChapters = new Set();
  for (const [index, row] of inputOutputRows.entries()) {
    const code = chapterCode(row['章节']);
    if (code) {
      const chapter = ensureChapter(code, text(row['章节']).replace(/^\d+(?:\.\d+)*[.\s]*/, ''));
      const rule = text(row['规则']);
      if (rule) {
        if (!mainRuleChapters.has(chapter.id)) {
          chapter.rules = [];
          mainRuleChapters.add(chapter.id);
        }
        if (!chapter.rules.includes(rule)) chapter.rules.push(rule);
      }
      const inputText = text(row['输入资料']);
      const inputId = inputText.match(/(?:IN-\d+(?:-\d+)?|Z-\d+)(?=\s|$)/)?.[0];
      if (inputId) {
        chapter.mainInputs ??= [];
        chapter.mainInputs.push({
          id: inputId,
          name: inputText.replace(new RegExp(`^${inputId}\\s*`), '').trim() || inputId,
          required: parseRequired(row['是否必须-新']),
          sourceRows: [index + 2],
        });
        if (!inputMap.has(inputId)) inputMap.set(inputId, {
          输入编码: inputId, 标准名称: inputText, '来源/系统': row['来源/系统'] ?? null,
        });
      }
    }
  }

  const blockers = [];
  if (missing.length) blockers.push({ code: 'MISSING_SNAPSHOT', message: `缺少快照: ${missing.join(', ')}` });
  const ordered = [...chapterMap.values()].sort((a, b) => naturalCompare(a.code, b.code));
  const chapterByOutput = new Map();
  for (const chapter of ordered) {
    for (const row of outputRows.filter((item) => chapterCode(item['所属章节编码']) === chapter.code)) {
      if (text(row['输出编码'])) chapterByOutput.set(text(row['输出编码']), chapter.id);
    }
  }
  const outputCodes = [...chapterByOutput.keys()];
  const resolveOutputCodes = (input) => {
    const exact = outputCodes.filter((code) => code === input);
    if (exact.length) return exact;
    return outputCodes.filter((code) => code.startsWith(`${input}.`));
  };

  const chapters = ordered.map((chapter, index) => {
    const outputIds = [...new Set(chapter.rows.map((row) => text(row['输出编码'])).filter(Boolean))];
    for (const id of outputRows.filter((row) => chapterCode(row['所属章节编码']) === chapter.code).map((row) => text(row['输出编码']))) {
      if (id && !outputIds.includes(id)) outputIds.push(id);
    }
    const fallbackOutputs = inputOutputRows.filter((row) => chapterCode(row['章节']) === chapter.code && text(row['输出资料']));
    if (!outputIds.length && fallbackOutputs.length) outputIds.push(chapter.code);
    const outputs = outputIds.map((id) => {
      const row = outputMap.get(id) ?? chapter.rows.find((item) => text(item['输出编码']) === id) ?? {};
      const fallback = fallbackOutputs[0] ?? {};
      const outputForm = text(row['输出形式'] || fallback['正文/附件']);
      return {
        id,
        name: text(row['标准输出名称'] || fallback['输出资料']) || id,
        kind: outputForm.includes('附件') ? 'attachment' : 'body',
        template: text(row['标准输出模板名称'] || row['标准输出模板'] || fallback['输出模板']),
        sourceRows: splitRefs(row['原表行号']).map(rowNumber).filter(Number.isFinite),
        dependencies: [],
      };
    });
    const outputSet = new Set(outputs.map((output) => output.id));
    if (!outputIds.length) chapter.blockers.push({ code: 'OUTPUT_DEFINITION_MISSING', message: `${chapter.code} 未定义输出产物` });
    const inputGroups = new Map();
    const edgeMap = new Map(outputs.map((output) => [output.id, new Set()]));
    const dependencies = new Set();
    for (const row of chapter.rows) {
      const out = text(row['输出编码']);
      const input = text(row['输入编码']);
      if (input && out && input !== out) {
        const resolved = resolveOutputCodes(input);
        const upstreamChapters = [...new Set(resolved.map((code) => chapterByOutput.get(code)).filter(Boolean))];
        for (const upstreamChapter of upstreamChapters) if (upstreamChapter !== chapter.id) dependencies.add(upstreamChapter);
        if (outputSet.has(out) && resolved.length) for (const upstream of resolved) {
          if (outputSet.has(upstream)) edgeMap.get(out).add(upstream);
        }
        else if (/^\d+(?:\.\d+)+$/.test(input) && !resolved.length) {
          chapter.blockers.push({ code: 'UNRESOLVED_OUTPUT_DEPENDENCY', message: `${out} 依赖未定义输出 ${input}` });
        }
      }
      if (!input || resolveOutputCodes(input).length) continue;
      if (!inputGroups.has(input)) inputGroups.set(input, {
        id: input, name: text(row['输入标准名称']), required: parseRequired(row['是否必须']), sourceRows: [],
      });
      const item = inputGroups.get(input);
      const source = Number(row['原表行号']) || Number(row['原表行']) || null;
      if (source) item.sourceRows.push(source);
      const required = parseRequired(row['是否必须']);
      if (required !== 'unknown' && item.required !== 'unknown' && required !== item.required) {
        chapter.blockers.push({ code: 'OPTIONALITY_CONFLICT', message: `${input} 在依赖行中同时声明必填与非必填` });
      } else if (item.required === 'unknown') item.required = required;
      const resolvedOutput = resolveOutputCodes(input);
      if (!inputMap.has(input) && !resolvedOutput.length) {
        chapter.blockers.push({ code: 'UNRESOLVED_INPUT', message: `未找到输入定义 ${input}` });
      }
      if (!resolvedOutput.length && inputMap.has(input) && item.name && text(inputMap.get(input)['标准名称']) && item.name !== text(inputMap.get(input)['标准名称'])) {
        chapter.blockers.push({ code: 'AMBIGUOUS_INPUT_ID', message: `${input} 对应多个输入名称` });
      }
      const sourceType = text(inputMap.get(input)?.['来源/系统'] || row['原资料类型'] || row['标准资料类型']);
      if (!resolvedOutput.length && /知识库|knowledge/i.test(sourceType)) {
        chapter.blockers.push({ code: 'KNOWLEDGE_RESOURCE_UNVERIFIED', message: `${input} 的知识原文尚未由可分发资源证明` });
      }
    }
    if (detectCycles(outputs.map((output) => output.id), edgeMap)) {
      chapter.blockers.push({ code: 'OUTPUT_DEPENDENCY_CYCLE', message: '章节内输出依赖存在环，禁止执行' });
    }
    for (const output of outputs) output.dependencies = [...(edgeMap.get(output.id) ?? [])].sort(naturalCompare);
    const mainInputs = new Map();
    for (const input of chapter.mainInputs ?? []) {
      const prior = mainInputs.get(input.id);
      if (!prior) mainInputs.set(input.id, { ...input, sourceRows: [...input.sourceRows] });
      else {
        prior.sourceRows.push(...input.sourceRows);
        if (prior.name !== input.name) chapter.blockers.push({ code: 'AMBIGUOUS_INPUT_ID', message: `${input.id} 对应多个输入名称` });
        if (prior.required !== 'unknown' && input.required !== 'unknown' && prior.required !== input.required) {
          chapter.blockers.push({ code: 'OPTIONALITY_CONFLICT', message: `${input.id} 在主表中同时声明必填与非必填` });
        } else if (prior.required === 'unknown') prior.required = input.required;
      }
    }
    return {
      id: chapter.id, code: chapter.code, title: chapter.title, order: index + 1,
      skill: `skills/ccpg-${chapter.id}/SKILL.md`, dependencies: [...dependencies].sort(),
      inputs: [...new Map([
        ...[...inputGroups.values()],
        ...[...mainInputs.values()].map((item) => ({
          ...inputGroups.get(item.id), ...item,
          sourceRows: [...new Set([...(inputGroups.get(item.id)?.sourceRows ?? []), ...item.sourceRows])],
        })),
      ].map((item) => [item.id, { ...item, required: item.required ?? 'unknown' }])).values()],
      outputs, rules: chapter.rules,
      blockers: [...new Map(chapter.blockers.map((item) => [`${item.code}:${item.message}`, item])).values()],
    };
  });
  const root = path.join(outputDir, 'rules', 'property-quality-plan');
  fs.mkdirSync(root, { recursive: true });
  for (const [chapterId, supplement] of Object.entries(options.outputSupplements ?? {})) {
    const chapter = chapters.find(item => item.id === chapterId);
    if (!chapter || chapter.outputs.length || supplement.source?.kind !== 'internal-supplement'
        || !text(supplement.source.basis) || !Array.isArray(supplement.outputs) || !supplement.outputs.length) {
      throw new Error(`invalid or conflicting output supplement: ${chapterId}`);
    }
    chapter.outputs = structuredClone(supplement.outputs);
    chapter.outputDefinitionSource = structuredClone(supplement.source);
    chapter.blockers = chapter.blockers.filter(item => item.code !== 'OUTPUT_DEFINITION_MISSING');
  }
  if (options.authoredRulesDir) for (const chapter of chapters) {
    const file = path.join(options.authoredRulesDir, `${chapter.id}.md`);
    if (!fs.existsSync(file)) throw new Error(`missing reviewed chapter rules: ${chapter.id}`);
    chapter.rules = [fs.readFileSync(file, 'utf8').trim()];
    if (!chapter.outputDefinitionSource) for (const output of chapter.outputs) output.template = `${output.name}（本技能随附模板）`;
  }

  const resources = [];
  if (options.sourceResourcesDir) {
    const bundled = bundleChapterResources(root, chapters, inputOutputRows, options.sourceResourcesDir, options.distributionAuthorization);
    if (bundled.sourceRevision !== sourceRevision) throw new Error('resource source revision mismatch');
    resources.push(...bundled.resources);
  }
  const knowledgeDir = options.knowledgeDir ?? process.env.CCPG_KNOWLEDGE_DIR;
  if (knowledgeDir) {
    if (!fs.existsSync(knowledgeDir)) blockers.push({ code: 'MISSING_KNOWLEDGE', message: `未找到指定知识资源目录: ${knowledgeDir}` });
    else {
      const sources = resourceFiles(knowledgeDir);
      const directories = metadataDirectories(knowledgeDir);
      if (!sources.length && !directories.length) blockers.push({ code: 'MISSING_KNOWLEDGE', message: `指定知识资源目录为空: ${knowledgeDir}` });
      for (const dir of directories) {
        if (!sources.some((source) => path.dirname(source) === dir)) {
          const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
          blockers.push({ code: 'MISSING_KNOWLEDGE', message: `${metadata.code ?? path.basename(dir)} 缺少知识原文` });
        }
      }
      for (const source of sources) {
        const dir = path.dirname(source), metadataPath = path.join(dir, 'metadata.json');
        const metadata = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : {};
        const rights = text(metadata.rightsAuthorization);
        if (metadata.fullTextCoverage === 'partial') blockers.push({ code: 'KNOWLEDGE_CONTENT_PARTIAL', message: `${metadata.code ?? path.basename(dir)} 仅部分覆盖` });
        if (metadata.distributable !== true || /local skill generation|review only|仅允许.*(生成|审阅)|仅限本地/i.test(rights)) {
          const code = metadata.distributable === false || rights ? 'KNOWLEDGE_RIGHTS_BLOCKED' : 'KNOWLEDGE_RIGHTS_UNKNOWN';
          blockers.push({ code, message: `${metadata.code ?? path.basename(dir)} 未明确允许随包分发` });
          continue;
        }
        if (!fs.statSync(source).isFile() || fs.statSync(source).size === 0) {
          blockers.push({ code: 'MISSING_KNOWLEDGE', message: `${metadata.code ?? path.basename(dir)} 缺少有效知识原文` });
          continue;
        }
        const rel = path.join('resources', 'knowledge', path.relative(knowledgeDir, source));
        const dest = path.join(root, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(source, dest);
        resources.push({ path: rel, sha256: sha256(dest), source: metadata.sourceUrl ?? null, sourceRevision: metadata.sourceRevision ?? null, coverage: metadata.coverage ?? null, permission: rights || 'explicitly-distributable' });
      }
    }
  }
  const capabilityEvidence = capabilityEvidenceByInput(options.capabilityEvidence);
  const revision = sourceRevision ?? [...Object.values(sheets)].map((sheet) => Number(sheet?.payload?.revision)).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? null;
  const manifest = {
    schemaVersion: 1,
    id: options.id ?? 'property-quality-plan',
    version: options.version ?? `source-${revision ?? 'unversioned'}`,
    title: options.title ?? '项目质量计划 PQ ONE 平台',
    source: {
      workbook: options.workbook ?? 'MJ8ashBmrh67GMtoMRQcIbxJn7f',
      sheet: options.sheet ?? '0gVCWf',
      ...(revision == null ? {} : { revision }),
      ...(options.modifiedAt ? { modifiedAt: options.modifiedAt } : {}),
    },
    chapters,
    resources,
    dataMappings: [...inputMap.values()].map((row) => {
      const inputId = text(row['输入编码']);
      const evidence = capabilityEvidence.get(inputId);
      return {
        inputId,
        strategy: text(row['来源/系统']) ? 'candidate' : 'manual',
        status: evidence ? 'verified' : 'unverified',
        source: text(row['来源/系统']) || null,
        ...(evidence ? { cli: 'ccpg-cli', capability: text(evidence.capability), verifiedAt: text(evidence.verifiedAt), fields: evidence.fields.map(text).filter(Boolean) } : {}),
      };
    }),
  };
  manifest.blockers = [...blockers, ...chapters.flatMap((chapter) => chapter.blockers)];
  for (const chapter of chapters) writeSkill(root, chapter, chapter.outputs, chapter.blockers);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), runtimeAgents);
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, blockers: manifest.blockers, outputDir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [snapshotDir, outputDir] = process.argv.slice(2);
  if (!snapshotDir || !outputDir) throw new Error('usage: node scripts/build-rules.mjs <snapshot-dir> <output-dir>');
  compile(snapshotDir, outputDir, {
    authoredRulesDir: process.env.CCPG_AUTHORED_RULES_DIR,
    sourceResourcesDir: process.env.CCPG_SOURCE_RESOURCES_DIR,
    distributionAuthorization: process.env.CCPG_DISTRIBUTION_AUTHORIZATION,
    version: process.env.CCPG_RULE_VERSION,
    outputSupplements: process.env.CCPG_OUTPUT_SUPPLEMENTS
      ? JSON.parse(fs.readFileSync(process.env.CCPG_OUTPUT_SUPPLEMENTS, 'utf8')) : undefined,
  });
}
