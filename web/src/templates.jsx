// 新建工作流模板库：空画布引导 + 快速起步。
import { useState } from 'react';
import { Modal } from './ui.jsx';

export const TEMPLATES = [
  {
    id: 'blank',
    name: '空白画布',
    description: '从零开始自由搭建',
    graph: { nodes: [], edges: [] },
  },
  {
    id: 'gongdan',
    name: '报修工单整理',
    description: '输入报修信息 → 智能体按工单规范整理落盘 → 汇总输出',
    graph: {
      nodes: [
        { id: 'in', type: 'input', position: { x: 60, y: 200 }, data: { label: '报修单输入', text: '3栋2单元501室 张先生 13800001111：厨房水槽下水缓慢已有三天，偶尔返味，希望尽快上门查看。', attachments: [] } },
        { id: 'agent', type: 'agent', position: { x: 380, y: 190 }, data: { label: '工单整理', prompt: '你是物业客服助手。把上游的报修信息整理为规范工单，写成 gongdan.md 落盘：提取报修人、联系方式、位置、故障描述、紧急程度（低/中/高）。', tools: [] } },
        { id: 'out', type: 'output', position: { x: 700, y: 210 }, data: { label: '工单输出' } },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'agent' },
        { id: 'e2', source: 'agent', target: 'out' },
      ],
    },
  },
  {
    id: 'urgency-route',
    name: '紧急度分流',
    description: '条件节点按关键词把工单分到紧急/常规两条处理线',
    graph: {
      nodes: [
        { id: 'in', type: 'input', position: { x: 40, y: 220 }, data: { label: '工单输入', text: '10栋1单元101 李女士 13911112222：家里水管爆了大量漏水，地板已经泡水！', attachments: [] } },
        { id: 'cond', type: 'condition', position: { x: 320, y: 220 }, data: { label: '紧急判断', include: '紧急,爆管,漏水,火灾,电梯困人', exclude: '' } },
        { id: 'urgent', type: 'agent', position: { x: 600, y: 100 }, data: { label: '紧急响应', prompt: '你是物业应急协调员。对紧急工单立即生成应急处置卡（emergency.md）：安抚话术、15分钟内上门、需带工具、升级路径。', tools: [] } },
        { id: 'normal', type: 'agent', position: { x: 600, y: 330 }, data: { label: '常规处理', prompt: '你是物业客服。对常规工单生成次日处理计划（plan.md）：时间段、负责人角色、需准备的物料。', tools: [] } },
        { id: 'out', type: 'output', position: { x: 900, y: 215 }, data: { label: '分流输出' } },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'cond' },
        { id: 'e2', source: 'cond', target: 'urgent', branch: 'true' },
        { id: 'e3', source: 'cond', target: 'normal', branch: 'false' },
        { id: 'e4', source: 'urgent', target: 'out' },
        { id: 'e5', source: 'normal', target: 'out' },
      ],
    },
  },
  {
    id: 'review-summary',
    name: '多方汇总评审',
    description: '并行两个视角分析 → 汇总合并出结论（并行分支同时执行）',
    graph: {
      nodes: [
        { id: 'in', type: 'input', position: { x: 60, y: 220 }, data: { label: '议题输入', text: '本季度小区绿化改造预算 8 万元，方案包括：更换草坪 2000㎡、补种树木 30 棵、增设灌溉系统。', attachments: [] } },
        { id: 'cost', type: 'agent', position: { x: 360, y: 100 }, data: { label: '成本视角', prompt: '你是预算分析师。从成本角度评审该方案，输出 cost.md：单价合理性、超支风险、可削减项。', tools: [] } },
        { id: 'quality', type: 'agent', position: { x: 360, y: 340 }, data: { label: '品质视角', prompt: '你是园区品质经理。从业主体验角度评审该方案，输出 quality.md：观赏性、维护成本、噪音扬尘影响。', tools: [] } },
        { id: 'merge', type: 'agent', position: { x: 660, y: 220 }, data: { label: '汇总评审', prompt: '你是评审组长。综合两个视角的分析，写 conclusion.md：结论、分歧点、最终建议。', tools: [] } },
        { id: 'out', type: 'output', position: { x: 950, y: 220 }, data: { label: '评审结论' } },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'cost' },
        { id: 'e2', source: 'in', target: 'quality' },
        { id: 'e3', source: 'cost', target: 'merge' },
        { id: 'e4', source: 'quality', target: 'merge' },
        { id: 'e5', source: 'merge', target: 'out' },
      ],
    },
  },
];

export function TemplateModal({ onClose, onApply }) {
  const [picked, setPicked] = useState('gongdan');
  const tpl = TEMPLATES.find((t) => t.id === picked);
  return (
    <Modal
      title="从模板开始"
      onClose={onClose}
      footer={(
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => onApply(tpl)}>应用模板</button>
        </>
      )}
    >
      <div className="tpl-grid">
        {TEMPLATES.map((t) => (
          <button key={t.id} className={`tpl-card ${picked === t.id ? 'tpl-on' : ''}`} onClick={() => setPicked(t.id)}>
            <div className="tpl-name">{t.name}</div>
            <div className="tpl-desc">{t.description}</div>
          </button>
        ))}
      </div>
      {tpl.graph.nodes.length > 0 && (
        <p className="sec-hint">含 {tpl.graph.nodes.length} 个节点（{tpl.graph.nodes.filter((n) => n.type === 'agent').length} 个智能体）、{tpl.graph.edges.length} 条连线</p>
      )}
    </Modal>
  );
}
