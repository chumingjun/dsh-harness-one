import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compile } from '../scripts/build-rules.mjs';
import { validateManifest } from '../lib/core.js';

function writeSnapshot(dir, name, columns, data) {
  fs.writeFileSync(
    path.join(dir, name),
    JSON.stringify({ sheets: [{ name: name.replace(/\.json$/, ''), range: `A1:${String.fromCharCode(64 + columns.length)}${data.length + 1}`, columns, data }] }),
  );
}

function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-rules-'));
  writeSnapshot(dir, 'inputs.json', ['输入编码', '标准名称', '标准资料类型', '来源/系统', '载体形式', '是否公共材料'], overrides.inputs ?? [
    ['IN-1', '现场资料', '现场台账', null, 'xlsx', '否'],
    ['IN-2', '系统资料', '系统导出', '611', 'xlsx', '否'],
  ]);
  writeSnapshot(dir, 'outputs.json', ['输出编码', '标准输出名称', '所属章节编码', '所属章节名称', '输出形式', '标准输出模板名称', '原始输出模板', '参考案例'], overrides.outputs ?? [
    ['1.1', '概况', '1', '范围', '正文', '概况模板', '概况模板', null],
    ['1.2', '清单', '1', '范围', '附件', '清单模板', '清单模板', '案例'],
  ]);
  writeSnapshot(dir, 'unified.json', [
    '依赖ID', '原表行号', '章节编码', '章节名称', '输出编码', '标准输出名称', '输入编码', '输入标准名称',
    '依赖材料（编码+标准名称）', '原始输入名称', '原资料类型', '标准资料类型', '是否必须', '归并说明',
    '输出形式', '标准输出模板', '原始输出模板', '参考案例', '收集模板', '规则', '项目采集材料', '来源/系统', '载体形式',
  ], overrides.unified ?? [
    ['R1', '2', '1', '范围', '1.1', '概况', 'IN-1', '现场资料', 'IN-1 现场资料', '现场资料', '现场台账', '现场台账', '是', 'row', '正文', '概况模板', '概况模板', null, null, '规则原文', null, null, 'xlsx'],
    ['R2', '3', '1', '范围', '1.2', '清单', '1.1', '概况', '1.1 概况', '概况', null, null, '是', 'upstream', '附件', '清单模板', '清单模板', '案例', null, null, null, null, null],
    ['R3', '4', '1', '范围', '1.1', '概况', 'Z-1', '标准', 'Z-1 标准', '标准', null, null, '是', 'knowledge', '正文', '概况模板', '概况模板', null, null, null, null, null, null],
  ]);
  for (const [name, columns, data] of overrides.extra ?? []) writeSnapshot(dir, name, columns, data);
  return dir;
}

test('compiles chapters, body/attachment outputs, stable ids and provenance', () => {
  const snapshots = fixture();
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-rules-out-'));
  const result = compile(snapshots, output);
  const root = path.join(output, 'rules', 'property-quality-plan');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.chapters[0].id, 'chapter-1');
  assert.deepEqual(manifest.chapters[0].outputs.map((x) => x.kind), ['body', 'attachment']);
  assert.equal(manifest.chapters[0].inputs[0].sourceRows[0], 2);
  assert.equal(manifest.chapters[0].inputs[0].required, true);
  assert.match(fs.readFileSync(path.join(root, 'skills', 'ccpg-chapter-1', 'SKILL.md'), 'utf8'), /name: ccpg-chapter-1/);
  assert.ok(result.blockers.some((x) => x.code === 'MISSING_SNAPSHOT'));
  assert.ok(manifest.resources.every((x) => x.path !== 'manifest.json'));
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /CCPG CLI/);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /feishu_collect_materials/);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /examples must not be read or downloaded/);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /current DSH conversation attachments/);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /registered material or artifact ID/i);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /do not inspect plugin source/i);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /material_complete/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /fresh native.*child|material_visual_read/);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /Text-only documents complete without image reading/);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /preflight_compress_failed/);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /failed submission does not advance/);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /automatically binds declared bundled knowledge/);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /outputId/);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /正文面向业务读者/);
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /不要暴露材料编码/);
  assert.doesNotThrow(() => validateManifest(manifest, { rulesRoot: root }));
});

test('chapter skills preserve quality while saving sections and reusing source readings', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-section-draft-'));
  compile(fixture(), output);
  const skill = fs.readFileSync(path.join(output, 'rules/property-quality-plan/skills/ccpg-chapter-1/SKILL.md'), 'utf8');
  assert.match(skill, /## Drafting/);
  assert.match(skill, /不另开子智能体.*整章/);
  assert.match(skill, /采集模板.*缺项|采集模板.*材料匹配/);
  assert.match(skill, /materials\/notes\/chapter-1-draft\.md/);
  assert.match(skill, /每完成一个.*小节.*保存/);
  assert.match(skill, /file_path.*content/);
  assert.match(skill, /来源.*期间.*单位.*待确认/);
  assert.match(skill, /bodyPath/);
  assert.match(skill, /当前章提交成功前.*后续章/);
  assert.match(skill, /outputId.*contentPath/);
  assert.match(skill, /完整性.*模板.*证据/);
  assert.match(skill, /正文面向业务读者/);
  assert.match(skill, /不要暴露材料编码/);
  assert.match(fs.readFileSync(path.join(output, 'rules/property-quality-plan/AGENTS.md'), 'utf8'), /save each completed section/i);
});

test('knowledge indexes require relevant authoritative originals and never imply retrieval succeeded', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-knowledge-index-'));
  compile(fixture(), output);
  const root = path.join(output, 'rules/property-quality-plan');
  const skill = fs.readFileSync(path.join(root, 'skills/ccpg-chapter-1/SKILL.md'), 'utf8');
  assert.match(skill, /它是索引，不是权威原文/);
  assert.match(skill, /当前章实际需要/);
  assert.match(skill, /原生搜索.*当前用户飞书 CLI/);
  assert.match(skill, /发布机关原文.*所在地.*有效期.*适用条款/);
  assert.match(skill, /materials\/input\/knowledge.*来源 URL.*获取日期.*版本/);
  assert.match(skill, /准备前解析登记/);
  assert.match(skill, /工具不可用.*保留缺口/);
  assert.match(skill, /搜索摘要和模型记忆不替代原文/);
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /index, not the authoritative text/);
  assert.match(agents, /never invent a retrieval or citation/);
});

test('refuses to overwrite an existing nonempty output tree', () => {
  const snapshots = fixture();
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-rules-existing-'));
  const marker = path.join(output, 'approved.txt');
  fs.writeFileSync(marker, 'keep');
  assert.throws(() => compile(snapshots, output), /nonempty|not empty|existing/i);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(output), ['approved.txt']);
});

test('reviewed internal output supplements survive compilation without replacing source definitions', () => {
  const snapshots = fixture({ outputs: [], unified: [
    ['R1', '2', '7', '要求管理', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, '识别适用要求', null, null, null],
  ] });
  const supplement = {
    source: { kind: 'internal-supplement', date: '2026-10-10', basis: '内部测试补充，待业务验收' },
    outputs: [{ id: '7', name: '要求管理', kind: 'body', template: '技能正文结构', sourceRows: [], dependencies: [] }],
  };
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-supplement-'));
  const result = compile(snapshots, output, { outputSupplements: { 'chapter-7': supplement } });
  const chapter = result.manifest.chapters[0];
  assert.deepEqual(chapter.outputs, supplement.outputs);
  assert.deepEqual(chapter.outputDefinitionSource, supplement.source);
  assert.ok(!result.blockers.some(item => item.code === 'OUTPUT_DEFINITION_MISSING'));
  assert.match(fs.readFileSync(path.join(output, 'rules/property-quality-plan/skills/ccpg-chapter-7/SKILL.md'), 'utf8'), /内部测试补充定义/);
  assert.doesNotThrow(() => validateManifest(result.manifest, { rulesRoot: path.join(output, 'rules/property-quality-plan') }));
  const occupied = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-supplement-occupied-'));
  assert.throws(() => compile(fixture(), occupied, { outputSupplements: { 'chapter-1': supplement } }), /supplement/);
});

test('packages only explicitly distributable knowledge and preserves rights and coverage blockers', () => {
  const snapshots = fixture();
  const knowledge = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-knowledge-'));
  for (const [name, metadata] of [
    ['unknown', { code: 'K-UNKNOWN' }],
    ['blocked', { code: 'K-BLOCKED', distributable: false }],
    ['allowed', { code: 'K-ALLOWED', distributable: true, fullTextCoverage: 'complete' }],
    ['partial', { code: 'K-PARTIAL', distributable: true, fullTextCoverage: 'partial' }],
  ]) {
    const dir = path.join(knowledge, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(metadata));
    fs.writeFileSync(path.join(dir, 'content.md'), `${name} content`);
  }
  const missing = path.join(knowledge, 'missing');
  fs.mkdirSync(missing);
  fs.writeFileSync(path.join(missing, 'metadata.json'), JSON.stringify({ code: 'K-MISSING', distributable: true }));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-rules-out-'));
  const { manifest } = compile(snapshots, output, { knowledgeDir: knowledge });
  assert.deepEqual(manifest.resources.map((resource) => resource.path), [
    'resources/knowledge/allowed/content.md',
    'resources/knowledge/partial/content.md',
  ]);
  const codes = new Set(manifest.blockers.map((blocker) => blocker.code));
  assert.ok(codes.has('KNOWLEDGE_RIGHTS_UNKNOWN'));
  assert.ok(codes.has('KNOWLEDGE_RIGHTS_BLOCKED'));
  assert.ok(codes.has('KNOWLEDGE_CONTENT_PARTIAL'));
  assert.ok(codes.has('MISSING_KNOWLEDGE'));
});

test('treats an explicitly selected empty knowledge directory as missing knowledge', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-rules-out-'));
  const knowledge = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-knowledge-empty-'));
  const { blockers } = compile(fixture(), output, { knowledgeDir: knowledge });
  assert.ok(blockers.some(({ code }) => code === 'MISSING_KNOWLEDGE'));
});

test('keeps data mappings unverified until explicit ccpg-cli capability evidence is supplied', () => {
  const snapshots = fixture();
  const firstOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-rules-out-'));
  const first = compile(snapshots, firstOutput);
  assert.equal(first.manifest.dataMappings.find(({ inputId }) => inputId === 'IN-2').status, 'unverified');
  assert.match(fs.readFileSync(path.join(firstOutput, 'rules/property-quality-plan/skills/ccpg-chapter-1/SKILL.md'), 'utf8'), /CCPG CLI/);
  assert.match(fs.readFileSync(path.join(firstOutput, 'rules/property-quality-plan/skills/ccpg-chapter-1/SKILL.md'), 'utf8'), /ccpg-cli/);

  const secondOutput = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-rules-out-'));
  const second = compile(snapshots, secondOutput, {
    capabilityEvidence: [{
      inputId: 'IN-2',
      cli: 'ccpg-cli',
      capability: 'project-quality-data',
      verified: true,
      verifiedAt: '2026-10-10T00:00:00Z',
      fields: ['projectId', 'period'],
    }],
  });
  const mapping = second.manifest.dataMappings.find(({ inputId }) => inputId === 'IN-2');
  assert.equal(mapping.status, 'verified');
  assert.equal(mapping.capability, 'project-quality-data');
  assert.deepEqual(mapping.fields, ['projectId', 'period']);
});

test('does not fill nulls without merge metadata, but applies explicit merge ranges', () => {
  const snapshots = fixture({
    inputs: [['IN-1', null, '现场台账', null, 'xlsx', '否']],
    extra: [
      ['merges.json', ['sheet', 'merges'], [['unified', JSON.stringify([{ range: 'A2:B2' }])]]],
    ],
  });
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-rules-out-'));
  compile(snapshots, output);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'rules/property-quality-plan/manifest.json')));
  assert.equal(manifest.chapters[0].inputs[0].name, '现场资料');
});

test('reports unresolved dependencies and optionality conflicts without silently repairing them', () => {
  const snapshots = fixture({
    unified: [
      ['R1', '2', '1', '范围', '1.1', '概况', 'IN-1', '现场资料 A', 'IN-1 现场资料 A', '现场资料 A', '现场台账', '现场台账', '是', 'row', '正文', '概况模板', '概况模板', null, null, null, null, null, 'xlsx'],
      ['R2', '3', '1', '范围', '1.1', '概况', 'IN-1', '现场资料 B', 'IN-1 现场资料 B', '现场资料 B', '现场台账', '现场台账', '否', 'row', '正文', '概况模板', '概况模板', null, null, null, null, null, 'xlsx'],
      ['R3', '4', '1', '范围', '1.1', '概况', 'IN-MISSING', '缺失', 'IN-MISSING 缺失', '缺失', '现场台账', '现场台账', '是', 'row', '正文', '概况模板', '概况模板', null, null, null, null, null, 'xlsx'],
    ],
  });
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-rules-out-'));
  compile(snapshots, output);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'rules/property-quality-plan/manifest.json')));
  const codes = new Set(manifest.chapters[0].blockers.map((x) => x.code));
  assert.ok(codes.has('AMBIGUOUS_INPUT_ID'));
  assert.ok(codes.has('OPTIONALITY_CONFLICT'));
  assert.ok(codes.has('UNRESOLVED_INPUT'));
});

test('reads annotated multiline CSV snapshots and preserves row provenance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-csv-'));
  const csv = [
    '[row=1] 章节,输出资料,正文/附件,输出模板,参考案例,输入资料,资料类型,是否必须-新,是否必须-旧,收集模板,规则,项目采集材料',
    '[row=2] 1.范围,1. 范围,正文,范围模板,,IN-005,现场台账,是,是,/,"第一行',
    '',
    '第二行",合同.pdf',
  ].join('\n');
  fs.writeFileSync(path.join(dir, '00-main.json'), JSON.stringify({
    annotated_csv: csv, row_indices: [1, 2, 3, 4], col_indices: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'],
    revision: 42, has_more: false,
  }));
  fs.writeFileSync(path.join(dir, '01-output.json'), JSON.stringify({
    annotated_csv: [
      '[row=1] 输出编码,标准输出名称,所属章节编码,所属章节名称,输出形式,标准输出模板名称,原表行号',
      '[row=2] 1,范围,1,范围,正文,范围模板,2',
    ].join('\n'), revision: 42,
  }));
  fs.writeFileSync(path.join(dir, '02-input.json'), JSON.stringify({
    annotated_csv: [
      '[row=1] 输入编码,标准名称,标准资料类型,来源/系统,载体形式,原表行号',
      '[row=2] IN-005,物业服务合同,现场台账,,pdf,2',
    ].join('\n'), revision: 42,
  }));
  fs.writeFileSync(path.join(dir, '03-dependencies.json'), JSON.stringify({
    annotated_csv: '[row=1] 依赖ID,原表行号,章节编码,章节名称,输出编码,输入编码,输入标准名称,是否必须\n[row=2] R1,2,1,范围,1,IN-005,物业服务合同,是',
    revision: 42,
  }));
  fs.writeFileSync(path.join(dir, '04-unified.json'), JSON.stringify({
    annotated_csv: '[row=1] 依赖ID,原表行号,章节编码,章节名称,输出编码,输出形式,输入编码,输入标准名称,是否必须,规则\n[row=2] R1,2,1,范围,1,正文,IN-005,物业服务合同,是,"第一行\n第二行"',
    revision: 42,
  }));
  fs.writeFileSync(path.join(dir, '05-collection.json'), JSON.stringify({
    annotated_csv: '[row=1] 序号,资料类型,输入资料,是否必须\n[row=2] 1,现场台账,IN-005,是',
    revision: 42,
  }));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-csv-out-'));
  const result = compile(dir, output);
  const manifest = result.manifest;
  assert.equal(manifest.source.revision, 42);
  assert.equal(manifest.version, 'source-42');
  assert.equal(manifest.chapters[0].order, 1);
  assert.match(fs.readFileSync(path.join(output, 'rules/property-quality-plan/skills/ccpg-chapter-1/SKILL.md'), 'utf8'), /第二行/);
  assert.equal(manifest.chapters[0].inputs[0].sourceRows[0], 2);
});

test('orders decimal chapters naturally and records cross-chapter dependencies', () => {
  const snapshots = fixture({
    outputs: [
      ['1', '范围', '1', '范围', '正文', '范围模板', null, null],
      ['3.1', '概况', '3.1', '概况', '正文', '概况模板', null, null],
      ['3.2', '画像', '3.2', '画像', '正文', '画像模板', null, null],
    ],
    unified: [
      ['R1', '2', '1', '范围', '1', '范围', '', '', '', '', '', '', '', '', '正文', '范围模板', '', '', '', '', '', '', ''],
      ['R2', '3', '3.1', '概况', '3.1', '概况', '1', '范围', '范围', '范围', '', '', '是', 'upstream', '正文', '概况模板', '', '', '', '', '', '', ''],
      ['R3', '4', '3.2', '画像', '3.2', '画像', '3.1', '概况', '概况', '概况', '', '', '是', 'upstream', '正文', '画像模板', '', '', '', '', '', '', ''],
    ],
  });
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-order-out-'));
  const { manifest } = compile(snapshots, output);
  assert.deepEqual(manifest.chapters.map((chapter) => chapter.code), ['1', '3.1', '3.2']);
  assert.deepEqual(manifest.chapters.map((chapter) => chapter.order), [1, 2, 3]);
  assert.ok(manifest.chapters[1].dependencies.includes('chapter-1'));
  assert.ok(manifest.chapters[2].dependencies.includes('chapter-3-1'));
});

test('resolves declared aggregate outputs and does not compare upstream labels as material identities', () => {
  const snapshots = fixture({
    inputs: [['4.2', '服务标准汇总', '章节依赖', '前序章节输出', null, null]],
    outputs: [
      ['4.2.1', '标准附件', '4', '质量目标', '附件', '标准模板', null, null],
      ['4.2.2', '服务承诺', '4', '质量目标', '正文', '承诺模板', null, null],
      ['4.3', '目标', '4', '质量目标', '正文', '目标模板', null, null],
      ['8.1.1', '保洁分析', '8.1', '保洁', '正文', '保洁模板', null, null],
      ['8.5.1', '客户分析', '8.5', '客服', '正文', '客服模板', null, null],
    ],
    unified: [
      ['R1', '2', '4', '质量目标', '4.3', '目标', '4.2', '服务标准及承诺', '', '', '章节依赖', '章节依赖', '是'],
      ['R2', '3', '8.5', '客服', '8.5.1', '客户分析', '8.1', '保洁汇总', '', '', '章节依赖', '章节依赖', '是'],
      ['R3', '4', '8.5', '客服', '8.5.1', '客户分析', '9.9', '未定义', '', '', '章节依赖', '章节依赖', '是'],
    ],
  });
  const { manifest } = compile(snapshots, fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-aggregate-')));
  assert.deepEqual(manifest.chapters[0].outputs.find(({ id }) => id === '4.3').dependencies, ['4.2.1', '4.2.2']);
  assert.deepEqual(manifest.chapters[2].dependencies, ['chapter-8-1']);
  assert.ok(!manifest.blockers.some(({ code }) => code === 'AMBIGUOUS_INPUT_ID'));
  assert.deepEqual(manifest.blockers.filter(({ code }) => code === 'UNRESOLVED_OUTPUT_DEPENDENCY').map(({ message }) => message), ['8.5.1 依赖未定义输出 9.9']);
});

test('reads one fixed revision workbook with main-table rules, merged titles and newly declared inputs', () => {
  const snapshots = fixture({
    extra: [
      ['input-output.json', ['章节', '输出资料', '正文/附件', '输出模板', '输入资料', '资料类型', '是否必须-新', '规则'], [
        ['1.范围', '1.1 概况', '正文', '概况模板', 'IN-50 新岗位流程', '数据模板', '是', '当前业务规则'],
        [null, null, null, null, 'IN-51 新现场材料', '现场台账', '否', null],
        ['7.变更控制', null, null, null, null, null, null, '变更规则'],
      ]],
      ['dependencies.json', ['依赖ID'], []],
      ['collection.json', ['输入资料'], []],
    ],
  });
  const names = ['input-output.json', 'outputs.json', 'inputs.json', 'dependencies.json', 'unified.json', 'collection.json'];
  const titles = ['项目质量计划输入输出材料清单', '01_输出产物主数据', '02_输入材料主数据', '03_章节依赖关系明细', '04_最终统一依赖表', '05_项目需收集资料'];
  const sheets = names.map((name, index) => ({ ...JSON.parse(fs.readFileSync(path.join(snapshots, name))).sheets[0], name: titles[index] }));
  for (const name of names) fs.unlinkSync(path.join(snapshots, name));
  fs.writeFileSync(path.join(snapshots, 'table.json'), JSON.stringify({ revision: 8073, sheets }));
  fs.writeFileSync(path.join(snapshots, 'merges.json'), JSON.stringify({ data: { revision: 8073, merged_cells: [{ range: 'A2:A3' }, { range: 'B2:B3' }] } }));
  const { manifest } = compile(snapshots, fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-workbook-')));
  assert.equal(manifest.source.revision, 8073);
  assert.ok(!manifest.blockers.some(({ code }) => code === 'MISSING_SNAPSHOT'));
  const chapter = manifest.chapters.find(({ code }) => code === '1');
  assert.deepEqual(chapter.rules, ['当前业务规则']);
  assert.equal(chapter.inputs.find(({ id }) => id === 'IN-50').required, true);
  assert.equal(chapter.inputs.find(({ id }) => id === 'IN-51').required, false);
  assert.deepEqual(chapter.inputs.find(({ id }) => id === 'IN-51').sourceRows, [3]);
  assert.ok(manifest.dataMappings.some(({ inputId }) => inputId === 'IN-50'));
  assert.ok(manifest.chapters.find(({ code }) => code === '7').blockers.some(({ code }) => code === 'OUTPUT_DEFINITION_MISSING'));
});

test('rejects mixed snapshot revisions before producing an executable rule pack', () => {
  const snapshots = fixture();
  const input = JSON.parse(fs.readFileSync(path.join(snapshots, 'inputs.json')));
  input.revision = 8073;
  fs.writeFileSync(path.join(snapshots, 'inputs.json'), JSON.stringify(input));
  const output = JSON.parse(fs.readFileSync(path.join(snapshots, 'outputs.json')));
  output.revision = 8025;
  fs.writeFileSync(path.join(snapshots, 'outputs.json'), JSON.stringify(output));
  assert.throws(() => compile(snapshots, fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-mixed-'))), /revision/i);
});

test('embeds chapter processing inputs, upstream outputs and output templates in its generated skill', () => {
  const snapshots = fixture();
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-skill-contract-'));
  const { manifest } = compile(snapshots, output);
  const chapter = manifest.chapters[0];
  const skill = fs.readFileSync(path.join(output, 'rules/property-quality-plan', chapter.skill), 'utf8');
  assert.ok(skill.includes(chapter.rules[0]));
  for (const input of chapter.inputs) {
    assert.ok(skill.includes(`${input.id}: ${input.name}`));
  }
  for (const artifact of chapter.outputs) {
    assert.ok(skill.includes(artifact.template));
    for (const upstream of artifact.dependencies) {
      assert.ok(skill.includes(`${artifact.id} <- ${upstream}`));
    }
  }
  assert.ok(skill.includes('manifest.json'));
  assert.ok(skill.includes('.ccpg-scheme/index.json'));
});

test('preserves repeated main-input provenance and rejects contradictory requirements', () => {
  const snapshots = fixture({
    extra: [
      ['input-output.json', ['章节', '输入资料', '是否必须-新', '规则'], [
        ['1.范围', 'IN-50 新流程', '是', '当前规则'],
        ['1.范围', 'IN-50 新流程', '否', '当前规则'],
      ]],
    ],
  });
  const { manifest } = compile(snapshots, fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-main-inputs-')));
  const chapter = manifest.chapters[0];
  assert.deepEqual(chapter.inputs.find(({ id }) => id === 'IN-50').sourceRows, [2, 3]);
  assert.ok(chapter.blockers.some(({ code }) => code === 'OPTIONALITY_CONFLICT'));
  assert.deepEqual(chapter.rules, ['当前规则']);
});

test('compiles reviewed generic rules with readable bundled skill resources', () => {
  const snapshots = fixture({
    outputs: [['1', '范围', '1', '范围', '正文', '范围模板', '范围模板', null]],
    unified: [['R1', '2', '1', '范围', '1', '范围', 'IN-1', '现场资料', 'IN-1 现场资料', '现场资料', '现场台账', '现场台账', '是', 'row', '正文', '范围模板', '范围模板', null, null, '案例化规则', null, null, 'xlsx']],
    extra: [['input-output.json', ['章节', '输入资料', '是否必须-新', '规则'], [
      ['1.范围', 'IN-1 现场资料', '是', '案例化规则'],
      ['1.范围', 'Z-1 标准', '是', null],
    ]]],
  });
  const authored = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-authored-'));
  fs.writeFileSync(path.join(authored, 'chapter-1.md'), '- 通用章节规则\n- 不使用案例项目事实\n');
  const sources = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-source-resources-'));
  fs.mkdirSync(path.join(sources, 'output-template', '范围模板'), { recursive: true });
  fs.mkdirSync(path.join(sources, 'knowledge', '服务标准'), { recursive: true });
  const template = path.join(sources, 'output-template', '范围模板', '范围模板.md');
  const knowledge = path.join(sources, 'knowledge', '服务标准', '服务标准.md');
  fs.writeFileSync(template, '# 模板\n');
  fs.writeFileSync(knowledge, '# 知识\n');
  const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(sources, 'index.json'), JSON.stringify({
    group: 'rules', sourceRevision: null,
    records: [
      { title: '范围模板', source: 'https://example.invalid/template', uses: [{ row: 2, role: 'output-template' }], status: 'downloaded', original: path.relative(sources, template), sha256: hash(template) },
      { title: '服务标准', source: 'https://example.invalid/knowledge', uses: [{ row: 3, role: 'knowledge' }], status: 'downloaded', original: path.relative(sources, knowledge), sha256: hash(knowledge), parsed: { path: path.relative(sources, knowledge), status: 'complete', sha256: hash(knowledge) } },
    ],
  }));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpg-bundled-'));
  const { manifest } = compile(snapshots, output, {
    authoredRulesDir: authored,
    sourceResourcesDir: sources,
    distributionAuthorization: 'Internal distribution approved: fixture',
  });
  const root = path.join(output, 'rules', 'property-quality-plan');
  const chapter = manifest.chapters[0];
  const skill = fs.readFileSync(path.join(root, chapter.skill), 'utf8');
  assert.match(skill, /通用章节规则/);
  assert.doesNotMatch(skill, /案例化规则/);
  assert.match(skill, /assets\/输出模板\/范围模板\/范围模板\.md/);
  assert.match(skill, /references\/知识依据\/服务标准\/服务标准\.md/);
  assert.ok(manifest.resources.every((resource) => !/[a-f0-9]{16}/.test(resource.path)));
  assert.ok(!chapter.blockers.some(({ code }) => code === 'KNOWLEDGE_RESOURCE_UNVERIFIED'));
  assert.doesNotThrow(() => validateManifest(manifest, { rulesRoot: root }));
});
