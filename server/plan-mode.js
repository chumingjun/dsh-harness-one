// Plan-Execute-Summarize 三阶段 agent 流程（节点级开关，默认关闭）。
// 阶段 1 PLAN：基于任务生成编号步骤清单（不执行）
// 阶段 2 EXEC：按计划逐步执行，可调用工具；每步结果回填
// 阶段 3 总结：基于计划与全部执行记录产出最终输出

const PLAN_PROMPT = `你是任务规划器。基于给定任务，产出执行计划，严格按以下格式输出（不要执行任务本身）：

PLAN
1. <步骤一，一句动宾短语>
2. <步骤二>
...

规则：3-6 步为宜；每步必须是可独立执行的动作（可包含工具调用、信息整理、判断）；最后一步通常是"汇总输出"。只输出 PLAN 清单，不要任何额外解释。`;

function execPrompt(nodePrompt, plan) {
  return `${nodePrompt}

你之前制定了如下执行计划，现在逐步执行它。每完成一步，输出：

STEP <编号>. <做了什么 / 调用了什么工具 / 得到什么结果>

规则：按编号顺序执行；需要外部信息就用可用工具；某步无法完成就标注 STEP <编号>. [失败] 原因并继续；全部完成后停止（不需要写总结，后续另有总结环节）。

计划：
${plan}`;
}

function summarizePrompt(nodePrompt, plan, execLog) {
  return `${nodePrompt}

你已按计划完成执行。基于以下计划与执行记录，产出最终交付结果（面向任务提出者，直接给结论/产物，不要复述过程流水账）。

计划：
${plan}

执行记录：
${execLog}`;
}

// 解析 PLAN 输出为步骤数组；解析失败返回 null（调用方回退单阶段）
export function parsePlan(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const m = line.match(/^\d+[.、)）]?\s*(.+)$/) || line.match(/^[-*]\s*(.+)$/);
    if (m && !/^plan$/i.test(line)) steps.push(m[1]);
  }
  return steps.length >= 2 ? steps : null;
}

// 执行一次 plan→exec→总结。llm 已是节点级路由后的实例。
export async function runPlanExecute(llm, { systemPrompt, userPrompt, tools, executeTool, maxRounds }) {
  // 1. PLAN（不给工具：规划阶段不产生副作用）
  const planRaw = await llm.chat({ systemPrompt: PLAN_PROMPT, userPrompt, tools: [], executeTool: null });
  const planSteps = parsePlan(planRaw);
  const plan = planSteps
    ? planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : String(planRaw).trim();

  // 2. EXEC（带工具）
  let execLog;
  if (!planSteps) {
    // 计划解析失败：exec 阶段直接执行原任务（相当于两次尝试中的执行步）
    execLog = await llm.chat({ systemPrompt, userPrompt, tools, executeTool, maxRounds });
  } else {
    execLog = await llm.chat({
      systemPrompt: execPrompt(systemPrompt, plan),
      userPrompt,
      tools,
      executeTool,
      maxRounds,
    });
  }

  // 3. 总结（不给工具：纯归纳）
  const summary = await llm.chat({
    systemPrompt: summarizePrompt(systemPrompt, plan, execLog),
    userPrompt,
    tools: [],
    executeTool: null,
  });

  return {
    output: summary,
    trace: { plan, execLog, summarized: true },
  };
}
