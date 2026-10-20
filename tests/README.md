# tests/

`npm test`（即 `node scripts/test.mjs`）递归收集 `tests/**/*.test.ts` 与
`packages/**/*.test.ts`，所以子目录不影响执行；同一入口还会核对管理页调用与后端路由。
加 `--smoke` 运行需要先 `npm run build` 的编译后服务烟雾测试，加 `--all` 两者都跑。

```
tests/
  helpers.ts             共享夹具：临时目录、FakeModel、Runtime 装配、来源断言
  api.test.ts            管理 API：鉴权、配置校验、人格 CRUD、表情、扫码登录
  sandbox.test.ts        nsjail 沙箱：限额、路径穿越、软链逃逸、联网开关
  audit-fixes.test.ts    全量审计回归：气泡并发、主动消息边界、退避、备份密码等
  agent/                 对话内核
    conversation.test.ts 生成流程、事务、部分发送失败、工具循环上界、上下文预算
    proactive.test.ts    主动联系门控：安静时段、每日配额、开场白豁免
    realism.test.ts      开环、读空气、情绪脉冲、作息节律
    batch2.test.ts       本地时间解析、表情轮换、用量归档、来源标注剥除
    p0fixes.test.ts      P0/P1/P2 修复回归（情绪符号、开环配额、向量开关、MMR 等）
    regressions.test.ts  表情窗口可解析性、年度循环跨闰日、脉冲边际递减
    safety.test.ts       外键不崩、超预算不吞原话、SSRF 十六进制映射、取消投递清理
    web.test.ts          实时搜索、网页读取的私网拦截、非法表情不外发
  storage/               持久化
    memory.test.ts       来源隔离、纠正替代、日记增量、FTS 越窗召回、语义去重
    enhancements.test.ts 记忆混合排序、向量精排、失效、时间感知渲染
    recovery.test.ts     重启后的发送状态判定、快照含附件、备份校验
  platform/              外部协议适配
    llm.test.ts          三种接口格式、思考内容剥离、预算与重试、密钥不外泄
    ilink.test.ts        iLink 协议全套：crypto、headers、入站解析、媒体收发、typing
```

## 加测试时的约定

- **一个文件一个领域**，文件名描述被测行为而不是"修了什么"。`p0fixes` / `regressions`
  是历史遗留的名字，新测试请进对应领域文件，不要再开新的"fixes"文件。
- 需要 Runtime/Store 的测试用 `helpers.ts` 的 `fixture(t)`，它已经处理临时目录和清理。
- 涉及时间的测试显式传入 `timeZone`，不要依赖机器本地时区——`moodPulse` 曾经只在
  01:00–07:00 这个窗口内失败过。
- 只调参不测机制的断言容易随调优失效：表情窗口测试显式传 `window = 24`，而不是依赖
  `PROMPT_STICKERS` 的当前取值。
