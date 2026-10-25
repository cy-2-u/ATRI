# test/

ATRI 的全部测试，与 `../docker/` 平级。由 `../docker/` 的 `npm test`（即 `run.mjs`）驱动，也可直接 `node run.mjs [--smoke|--all]`（需要以 `../docker` 为工作目录，或让 `process.cwd()` 指向它——提示词路径按 cwd 解析）。

```text
run.mjs               统一入口：单元测试 + 管理页/路由配对检查（--smoke 加端到端冒烟）
helpers.ts            夹具：临时目录、FakeModel、Runtime 装配、promptText 断言工具
memory.test.ts        记忆六变量、分层渲染、演练巩固、心境一致性、日记淡忘、心情状态机、时间感知
conversation.test.ts  回复解析（beat/表情纠错/来源剥除）、对话轮、工具循环上界、话题笔记、日记整理
delivery.test.ts      投递状态机、部分失败、送达不明、重启恢复、任务清理、备份与恢复
proactive.test.ts     主动门控、开环独立配额、askedLoops 契约、挂念生命周期、读空气、作息择时
retrieval.test.ts     全文检索、稀有度、纠正替代、删除失效链、语义去重、向量回填
platform.test.ts      三种模型接口、重试与预算、嵌入客户端、微信协议工具、私网判定
api.test.ts           HTTP 层：鉴权、配置校验、人格、表情、联系人、任务动作、备份
```

约定：一个文件一个领域；涉及时间显式传 timeZone；测试以 `../docker` 为 cwd 运行。Windows 下临时目录清理带重试，仍失败则留给系统清理。
