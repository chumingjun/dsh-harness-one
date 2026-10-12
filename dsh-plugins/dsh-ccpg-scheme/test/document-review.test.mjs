import assert from 'node:assert/strict';
import test from 'node:test';
import { splitReviewSections, documentReview } from '../lib/document-review.js';

test('review sections are separated without removing ordinary body or quoted examples', () => {
  const text = '# 正文\n内容\n\n```md\n## 待确认事项\n示例\n```\n\n## 待确认事项\n1. 合同待续签。\n   请核对日期。\n2. 录像期限存在差异。\n\n## 其他正文\n保留内容';
  const result = splitReviewSections(text);
  assert.match(result.body, /其他正文\n保留内容/);
  assert.match(result.body, /## 待确认事项\n示例/);
  assert.doesNotMatch(result.body, /合同待续签|录像期限/);
  assert.deepEqual(result.items.map((item) => item.message), ['合同待续签。\n请核对日期。', '录像期限存在差异。']);
  assert.equal(result.items[0].sectionLabel, '正文');
  assert.equal(result.items[1].sectionLabel, '正文');
  const review = documentReview({ body: text, confirmations: [{ id: 'manual', message: '合同待续签。\n请核对日期。', status: 'pending' }] });
  assert.equal(review.items.length, 2, 'equivalent structured and inline issues are not duplicated');
  assert.equal(review.items[0].sectionLabel, '正文', 'structured confirmation inherits the body location');
  assert.equal(documentReview({ body: text, confirmed: true }).items[0].status, 'confirmed');
});

test('review sections attach the nearest numeric subsection without parsing fenced examples', () => {
  const result = splitReviewSections('## 4.1 总体目标\n正文\n\n### 待确认事项\n- 核验目标值\n\n## 4.2 服务承诺\n正文');
  assert.deepEqual(result.items[0], {
    id: 'body-review-1',
    message: '核验目标值',
    sectionCode: '4.1',
    sectionLabel: '4.1 总体目标',
    status: 'pending',
    required: true,
  });
});

test('historical inline gaps create located review items without changing the business body', () => {
  const body = '## 3.1 基本概况\n|项目|值|\n|---|---|\n|建筑面积|[待确认：核对面积]|\n\n## 3.2 顾客需求\n顾客名称：{{顾客名称}}。\n\n```md\n示例：待确认\n```\n`TODO` 是代码示例。';
  const result = documentReview({ body });
  assert.equal(result.body, body);
  assert.deepEqual(result.items.map(({ message, sectionCode }) => ({ message, sectionCode })), [
    { message: '|建筑面积|[待确认：核对面积]|', sectionCode: '3.1' },
    { message: '顾客名称：{{顾客名称}}。', sectionCode: '3.2' },
  ]);
  assert.ok(documentReview({ body, confirmed: true }).items.every((item) => item.status === 'confirmed'));
  assert.equal(documentReview({ body, confirmations: result.items }).items.length, 2);
});

test('generation notes are excluded while legal business content, tables, images and examples remain', () => {
  const body = '# 第3章 项目与顾客分析\n\n> 本章依据 haiyin-quality-plan-v2 绑定的 8 份输入材料编制（IN-001），全部事实取自材料原文；\n> 未载明的字段标注「待确认」。\n\n## 3.1 基本概况\n\n本表基于用户提供的材料生成，按 Skill 要求保留字段。\n\n|项目|值|\n|---|---|\n|建筑面积|待确认|\n\n依据有效服务合同，公共区域纳入服务范围。\n\n![平面图](图纸.png)\n\n```md\n本章依据 IN-001 输入材料编制。\n```\n';
  const result = documentReview({ body });
  assert.doesNotMatch(result.body, /绑定的 8 份|按 Skill|未载明的字段/);
  assert.match(result.body, /依据有效服务合同/);
  assert.match(result.body, /\|建筑面积\|待确认\|/);
  assert.match(result.body, /!\[平面图\]\(图纸.png\)/);
  assert.match(result.body, /```md\n本章依据 IN-001 输入材料编制。\n```/);
  assert.deepEqual(result.items.map((item) => item.message), ['|建筑面积|待确认|']);
});

test('inline review follows edited text while independent business checks remain', () => {
  const original = documentReview({ body: '## 2.2 合同版本\n版本：待确认\n面积：待填写' });
  const manual = { id: 'contract', message: '请核对合同是否续签', sectionCode: '2.2', status: 'pending' };
  const edited = documentReview({ body: '## 2.2 合同版本\n版本：现行有效\n面积：待填写', confirmations: [...original.items, manual] });
  assert.deepEqual(edited.items.map(item => item.message), ['面积：待填写', manual.message]);
  const completed = documentReview({ body: '## 2.2 合同版本\n版本：现行有效\n面积：1250平方米', confirmations: edited.items });
  assert.deepEqual(completed.items, [manual]);
  assert.equal(documentReview({ body: '## 2.2 合同版本\n版本：现行有效', confirmations: original.items }).items.length, 0);
});

test('explicit user review status replaces the prior status without approving remaining inline gaps', () => {
  const item = { id: 'manual', message: '核对期限', sectionCode: '2.2', status: 'pending' };
  assert.equal(documentReview({ body: '## 2.2 合同\n有效', confirmations: [item, { ...item, status: 'confirmed' }] }).items[0].status, 'confirmed');
  const inline = documentReview({ body: '版本：待确认' }).items[0];
  assert.equal(documentReview({ body: '版本：待确认', confirmations: [{ ...inline, status: 'confirmed' }] }).items[0].status, 'pending');
});

