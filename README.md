# ATRI · 微信里的对话与日记

ATRI 是一个以《ATRI -My Dear Moments-》为灵感的陪伴对话服务。通过微信聊天，用原始对话、有来源的记忆和第一人称日记保持相处的连续性。人设、语气和情绪表达由提示词结合实际经历生成。

v3.0 是对 v2.0 的完整重写：单包分层结构（无 workspaces）、按功能组织的 `src/`、注释只保留约束说明。行为语义与 v2.0 一致，并包含：读空气不再数字数（由模型语义判断）、模型可控的气泡停顿（beat）、日记与记忆同一套淡忘阈值、心境一致性召回、askedLoops 显式契约、久别锚点从对方最后一条消息起算、前缀缓存命中可视化。

## 可以做什么

- 微信扫码接入、私聊文字、按顺序发送多个气泡和表情图片（气泡间隔随长度变化，不是机关枪）。
- 读取近期原话，按需查询历史、长期记忆和日记；支持纠正、删除和查看依据。
- 长对话整理话题笔记；有新经历时按日写日记，供后续回忆。
- 记忆像人而不是录像机：细节先淡、意义后淡、情绪残留更久；常想起的更牢固（巩固），被相似记忆淹没的更快模糊（干扰）。提示词里分层呈现（清晰 / 大致记得 / 有印象）；置顶记忆永不衰减。
- 可选向量检索：换一种说法也能找回旧事（需在管理页开启并填写嵌入模型）。
- 时间感知：对话间隔与当前时刻进入提示词，久别带“上次聊天是周五晚上”这样的锚点（从对方最后一条消息算起，越过未获回应的主动消息）；深夜与清晨的语气符合时刻。
- 三层情绪：模型每轮的语义自评心情（跨对话持续、随时间回落）、带情绪记忆或旧日记的回想泛化、所有残留铺成的情绪基线。以体感文字进入提示词，不输出数值。
- 作息节律、开环记忆（“明天面试”到点问一句）、软惦记（无日期的持续事件）、读空气（连续无回应后指数冷却）。
- 通过 Tavily 搜索实时信息；支持视觉模型读图；可选 nsjail 沙箱执行命令。
- 管理页：连接、联系人、试聊、日记、记忆、惦记的事、人设、素材、设置和备份；“测试模型连通”旁有“测试角色生效”探测渠道是否真的把 system 提示送达模型（人物设定与回复契约都依赖它），调试页展示每次调用的前缀缓存命中量与占比。

## 启动

服务器需要 Docker Engine 和 Docker Compose v2：

```sh
cp .env.example .env
docker compose up -d --build
docker compose exec atri cat /data/admin-secret.txt   # 未设 ADMIN_PASSWORD 时读取管理密码
```

打开 http://127.0.0.1:3000（远程服务器默认只绑本机，用 SSH 隧道：`ssh -L 3000:127.0.0.1:3000 user@server`）。登录后：调试页填模型接口与密钥（DeepSeek/OpenAI 兼容、Anthropic、Gemini）→ 点“测试模型连通”与“测试角色生效”确认渠道 → 试聊验证 → 连接页扫码 → 联系人页“允许使用”。

默认模型窗口 65,536 token、输入预算 24,000、输出上限 3,000，均可在调试页改；输入+输出+1024 余量不能超过窗口。主动联系默认关闭，开启后默认安静时段 23:00–08:00。主动由真实动机驱动：聊天中形成的想法（initiatives）与到期的约定，事件到达时才评估要不要开口；没有每日次数上限、固定探询节拍或行为抖动，连续无回应自动拉长冷却（打扰保护，不是性格）。

## 本地开发

需要 Node.js 24+（运行时用内置 SQLite，无需另装数据库）：

```sh
npm ci
npm run dev          # 开发启动（读 .env，监听 127.0.0.1:3000）
npm run check        # 类型检查 + 格式 + 全部测试 + 构建
npm test -- --smoke  # 编译后服务 + 本地模型替身的端到端冒烟
npx tsx scripts/simulate-month.ts   # 一个月模拟（剧本扮演双方，机制走生产代码）
```

运行数据在 `data/`；`DATA_DIR`、`HOST`、`PORT` 可覆盖。备份：管理页一键或 `node dist/backup.js`；恢复必须指向空目录（`DATA_DIR=<空目录> node dist/restore.js <备份目录>`），恢复后旧任务暂停、主动联系关闭。

## 代码结构

```text
src/index.ts        入口：装配全部模块
src/api/            HTTP 层：server（路由/鉴权/探测端点）、config（设置/人格）、wechat（桥接）、sandbox（nsjail）、stickers
src/core/           对话内核：agent（预算规划+工具循环+来源校验）、runtime（调度/投递/主动）、reply（解析）、
                    memory-context（分层渲染/情绪泛化）、prompt-blocks、mood、time（时间感知）、web、constants
src/db/             数据层：store（SQLite 全部表与查询，含用量缓存列）、memory-model（六变量纯函数）、backup、format
src/llm.ts          模型适配：三接口格式 + 保守 token 估算 + 缓存命中解析 + 嵌入客户端
src/ilink/          微信协议：client（含 CDN 媒体加密）、media、types
src/net.ts          私网/回环判定（SSRF 防线）
shared/prompts/     persona、chat、diary、context_notes 四份提示词
public/             管理页静态资源
scripts/            build、backup、restore、sim-lib、simulate-month、_live-probe（真实模型管线探针，端点走环境变量）
test/               单元测试（七个领域文件）+ run.mjs（配对检查与冒烟）
```

关键设计约束（改动前请读对应代码注释）：system 消息只放逐字节稳定的前缀（供应商前缀缓存）；`peers.version` 是全部写路径的乐观锁；任务与气泡先落库再处理，送达不明暂停队列 10 分钟；来源与检索一律按联系人隔离；沙箱工具在开关关闭时既不进 schema 也不可派发。

## 模拟验证

`npx tsx scripts/simulate-month.ts` 推进模拟时钟一个月，剧本同时扮演双方，心情、记忆六变量、日记、主动调度全部由生产代码实时计算，转写写入 `simulation-month-transcript.md`。覆盖：多气泡分开投递、表情调用格式、记忆产生与淡忘、话题笔记压缩、情绪轨迹（自评/深夜/基线）、挂念浮现与了结、开环到点提醒与读空气冷却、久别锚点与日记回看。

## 来源与许可

微信协议模块和原测试复用自 [SMNETSTUDIO/WeChat-AI](https://github.com/SMNETSTUDIO/WeChat-AI/tree/cf8fbec)（Apache 2.0 + Commons Clause），见 `licenses/`；其余代码沿用本仓库的 PolyForm Noncommercial 许可（见 `LICENSE`）。内置的五张基础表情为本项目绘制。
