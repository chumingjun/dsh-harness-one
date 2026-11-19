// System One 真实环境探针：打本地 Ollama，三模式判决 + 耗时 + usage。
// 文件名刻意不匹配 *.test.mjs——默认测试/CI 不跑（依赖本地 Ollama 与模型）。
// 用法：node test/systemone.live.mjs [url] [model]
// 冷启动首调 ~5s（模型加载），热调用 ~0.5s、零输出 token。
import {
  callSystemOne, buildSystemOneQuestion, shapeSystemOneAnswer, mapSystemOneUsage, probeSystemOne,
} from '../lib/systemone.js';

const url = process.argv[2] || process.env.SYSTEMONE_URL || 'http://localhost:11434/v1/systemone';
const model = process.argv[3] || process.env.SYSTEMONE_MODEL || 'pplx-decider-flash';

const probe = await probeSystemOne({ url, model });
console.log('probe:', JSON.stringify(probe));
if (!probe.available) {
  console.error('Ollama/模型未就绪，终止');
  process.exit(1);
}

const cases = [
  {
    name: 'noul', mode: 'noul',
    state: '登录表单顶部出现红色横幅：密码错误，请重试。',
    rendered: { statement: '这次登录尝试失败了', instructions: '', trueCriteria: '', falseCriteria: '', options: [], levels: [] },
  },
  {
    name: 'choice', mode: 'choice',
    state: '用户消息：我上周的订单还没退款，客服一直不回复。',
    rendered: {
      statement: '', instructions: '这条消息属于哪类诉求', trueCriteria: '', falseCriteria: '',
      options: [{ name: 'refund', description: '退款相关' }, { name: 'shipping', description: '物流相关' }, { name: 'complaint', description: '投诉服务态度' }],
      levels: [],
    },
  },
  {
    name: 'score', mode: 'score',
    state: '报告包含完整数据表格与结论，但缺少来源引用。',
    rendered: {
      statement: '', instructions: '报告质量', trueCriteria: '', falseCriteria: '', options: [],
      levels: ['缺少关键内容', '内容完整但有小瑕疵', '内容完整且论证严谨'],
    },
  },
];

for (const c of cases) {
  const t0 = Date.now();
  const raw = await callSystemOne({ url, model, state: c.state, question: buildSystemOneQuestion(c.mode, c.rendered) });
  const { data, output } = shapeSystemOneAnswer({ mode: c.mode, answer: raw.answer, d: {}, rendered: c.rendered });
  console.log(`\n[${c.name}] ${Date.now() - t0}ms usage=${JSON.stringify(mapSystemOneUsage(raw.usage, raw.cachedCount))}`);
  console.log(output);
  console.log('data:', JSON.stringify(data));
}
console.log('\n✓ 三模式真实探针完成');
