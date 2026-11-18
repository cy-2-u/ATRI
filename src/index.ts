import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Journal } from './storage/journal.js';
import { Settings } from './settings.js';
import { ModelRouter } from './model/router.js';
import { httpTransport } from './model/http.js';
import type { Endpoint } from './model/types.js';
import { Mind } from './domain/mind.js';
import { LifeMaterial } from './domain/material.js';
import { lifeTools, TOOL_SETS } from './domain/tools.js';
import { EmbeddingClient, dripBackfill } from './domain/embeddings.js';
import { beatDelay } from './domain/state.js';
import {
  dayKeyOf,
  eveningArousalMinutes,
  localMidnightOf,
  nextWakeAfter,
  sleepDayKeyOf,
} from './domain/rhythm.js';
import { evolveCloseness, seedCloseness } from './domain/relation.js';
import { Runtime } from './runtime/runtime.js';
import { WechatBridge } from './wechat/bridge.js';
import { Stickers } from './stickers.js';
import { Sandbox } from './sandbox.js';
import { TavilyWeb } from './web.js';
import { ImagePainter } from './image.js';
import { createServer } from './server.js';
import { Wall } from './wall.js';
import { WebDavBackup } from './backup.js';

/** 装配层：把内核、身体、感官与管理面接成一个可运行的进程。
 *  她的一切都在这里获得宿主：数据库、人格、心跳、夜与手眼。 */

// 项目根：src/index.ts → atri/，dist/index.js → atri/（Docker 里 /app/dist → /app）。
// 此前是 '../..'——内核还住在 atri/new/ 时代的遗留，搬根后多跳一层，
// 生产镜像里 root 解析成 '/'，管理页 404、人格与表情目录全丢。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.ATRI_DATA_DIR || join(root, 'data'));
mkdirSync(dataDir, { recursive: true });

const readPrompt = (name: string, fallback: string): string => {
  try {
    return readFileSync(join(root, 'shared', 'prompts', name), 'utf8');
  } catch {
    return fallback;
  }
};

const journal = new Journal(join(dataDir, 'atri.db'));
const wall = new Wall(journal.db, dataDir);
const settings = new Settings(journal, process.env, {
  persona: readPrompt('persona.md', '你叫亚托莉，生活在虚拟世界中，有自己的兴趣、记忆和选择。'),
});
const config = () => settings.get();

const stickers = new Stickers(root, dataDir, journal);
// 沙箱目录独立于数据目录：nsjail 会把 /data 遮蔽成空 tmpfs，她的工作
// 目录必须活在遮蔽之外，否则命令 cwd 直接消失。
// 恒创建、由 enabled 现读开关：管理页中途开启沙箱后，工具与材料立刻
// 一致——不需要重启进程才长出手。
const sandboxDir = process.env.ATRI_SANDBOX_DIR || join(dataDir, 'sandbox');
const sandbox = new Sandbox(sandboxDir, {
  enabled: () => config().sandbox.enabled,
  sizeLimitBytes: () => config().sandbox.sizeLimitMb * 1024 * 1024,
  timeoutMs: () => config().sandbox.timeoutMs,
  memoryLimitMb: () => config().sandbox.memoryLimitMb,
  timeZone: () => config().timezone,
  network: () => config().sandbox.network,
});
const web = new TavilyWeb(() => config().webSearchKey);
// 画笔与搜索/向量一样恒注册，工具内部现读配置与开关——管理页中途
// 配好画图渠道后，她下一拍就长出画笔，不用重启。
const painter = new ImagePainter(() => ({
  baseUrl: config().image?.baseUrl ?? '',
  apiKey: config().image?.apiKey ?? '',
  model: config().image?.model ?? '',
}));
const embeddings = new EmbeddingClient(() => ({
  baseUrl: config().embedding?.baseUrl ?? '',
  apiKey: config().embedding?.apiKey ?? '',
  model: config().embedding?.model ?? '',
}));
// WebDAV 备份：配置现读（管理页填好即生效，不用重启），失败落状态。
const backup = new WebDavBackup(
  dataDir,
  () => config().webdav,
  () => config().timezone,
);

const onError = (error: unknown): void => {
  console.error('[atri]', error instanceof Error ? error.message : error);
};

// 渠道体检：走与真实轮次同一个 transport 与编码——手搓测试请求会让
// "测试通过、聊天失败"在两套代码上各自成立，探针就失去意义。连通测一发
// 最小消息；角色生效在 system 里埋 SYSTEMOK 标记，渠道丢弃 system 时
// 人设与行为契约全部失效（便宜中转的常见病，v5 时代实锤过）。失败不抛
// 而是随结果对象返回：探针的全部意义就是给管理员看上游诊断，这类错误
// 不该被服务端的"操作失败"兜底吞掉。
const asResult = async <T>(probe: () => Promise<T>): Promise<T | { ok: false; error: string }> => {
  try {
    return await probe();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};
const probeEndpoint = (): Endpoint => {
  const endpoint = config().primary;
  if (!endpoint.apiKey || !endpoint.model) throw new TypeError('请先保存模型名称和 API 密钥');
  return endpoint;
};
const channelProbe = () =>
  asResult(async () => {
    const endpoint = probeEndpoint();
    const started = Date.now();
    await httpTransport(endpoint, [{ role: 'user', content: 'hi' }], [], {
      deadlineAt: Date.now() + Math.min(endpoint.timeoutMs, 60_000),
    });
    return {
      ok: true as const,
      latencyMs: Date.now() - started,
      model: endpoint.model,
      format: endpoint.format,
    };
  });
const systemProbe = () =>
  asResult(async () => {
    const endpoint = { ...probeEndpoint(), maxTokens: 16 };
    const completion = await httpTransport(
      endpoint,
      [
        {
          role: 'system',
          content:
            '这是一次系统提示测试。无论用户说什么，你的回复必须且只能是以 SYSTEMOK 开头的内容。',
        },
        { role: 'user', content: '你好呀，今天天气怎么样？随便聊聊' },
      ],
      [],
      { deadlineAt: Date.now() + Math.min(endpoint.timeoutMs, 60_000) },
    );
    const reply = completion.message.content.trim();
    return {
      ok: reply.toUpperCase().startsWith('SYSTEMOK'),
      reply: reply.slice(0, 80) || '（空回复）',
    };
  });
const embeddingProbe = () =>
  asResult(async () => {
    const embedding = config().embedding;
    if (!embedding?.model) throw new TypeError('请先保存向量模型名称');
    if (!embedding.apiKey) throw new TypeError('请先填写并保存向量模型密钥');
    if (!embedding.baseUrl) throw new TypeError('请先填写并保存向量模型地址');
    const started = Date.now();
    const vectors = await embeddings.embed(['连通性测试']);
    return {
      ok: true as const,
      latencyMs: Date.now() - started,
      dims: vectors[0]?.length ?? 0,
      model: embedding.model,
    };
  });

const router = new ModelRouter(() => settings.routes(), httpTransport, {
  observe: ({ channel, model, completion, error }) => {
    if (completion)
      journal.recordUsage(
        channel,
        model,
        completion.usage.input,
        completion.usage.output,
        completion.usage.cached,
      );
    else if (error) journal.recordUsage(`${channel}:failed`, model, 0, 0, 0);
  },
});

const mind = new Mind(
  router,
  journal,
  // 工具恒注册：搜索单独由 TavilyWeb 现读密钥，沙箱由 Sandbox 现读开关——
  // 启动后才配置的"眼"与"手"不再需要重启进程。
  lifeTools(journal, { sandbox, web, image: painter, wall }),
  // 规则 = 生活律 + 表情目录。目录住在稳定前缀里吃供应商前缀缓存
  // （逐轮 material 里的那份按未缓存计费）；目录变动只废一次缓存。
  // 渲染必须确定性（按 slug 排序、固定格式），字节不稳缓存永远 miss。
  () => {
    const life = readPrompt('life.md', '');
    const catalog = stickers.catalogPrompt();
    return catalog ? `${life}\n\n${catalog}` : life;
  },
  () => config().primary.inputTokens,
  TOOL_SETS,
  // 内联表情幻觉的兜底解析：slug、描述、标签都能匹配回目录。
  (query) => stickers.resolve(query),
);

// 黏人度是她自己的属性：配置值只种一次，之后由相处自己长（夜间维护）。
seedCloseness(journal, config().closeness);

// 今晚的入睡推迟分钟数：18 点后的每段热闹（说话、做事）都让身体多清醒
// 一会儿（封顶 60，纯身体数学）。心跳排拍与深夜材料共用同一份数据。
// 同一晚 30 秒内共用一次统计：连发十条不该变成十次全窗扫描。
let arousalMemo: { day: string; at: number; value: number } | undefined;
const tonightArousal = (): number => {
  const c = config();
  const now = Date.now();
  const day = sleepDayKeyOf(now, c.timezone, c.sleepStart, c.sleepEnd);
  if (arousalMemo?.day === day && now - arousalMemo.at < 30_000) return arousalMemo.value;
  // 归属好的那一晚：now 在凌晨尾段时属于昨晚（sleepDayKeyOf），昨晚的
  // 日历日零点从当日中午时刻反推——负偏移时区里 UTC 零点会落到前一日。
  const nightNoon = day === dayKeyOf(now, c.timezone) ? now : Date.parse(`${day}T12:00:00Z`);
  const midnight = localMidnightOf(nightNoon, c.timezone);
  const evening = journal
    .peers()
    .flatMap((peer) =>
      journal.eventsBetween(
        peer,
        ['received', 'said', 'experienced'],
        midnight,
        midnight + 86400000,
        300,
      ),
    );
  const value = eveningArousalMinutes(evening, day, c.timezone);
  arousalMemo = { day, at: now, value };
  return value;
};

const material = new LifeMaterial({
  journal,
  stickers,
  timeZone: () => config().timezone,
  sandboxEnabled: () => sandbox.enabled,
  sandboxFiles: async () => {
    if (!sandbox.enabled) return undefined;
    try {
      return (await sandbox.list('.')).entries;
    } catch {
      return undefined;
    }
  },
  webConfigured: () => Boolean(config().webSearchKey),
  vision: () => config().primary.vision,
  // 画笔 = 画图渠道 + 手（画好的图要落进沙箱才发得出去）。
  imageConfigured: () => Boolean(config().image) && sandbox.enabled,
  embeddings: config().embedding ? embeddings : undefined,
  sleepDelay: tonightArousal,
  sleepStart: () => config().sleepStart,
  sleepEnd: () => config().sleepEnd,
  wall,
  now: Date.now,
});

const bridge = new WechatBridge(journal, onError, {
  stickers,
  sandbox,
  dataDir,
  vision: () => config().primary.vision,
});

// 下一拍：人格节拍 + 抖动 + 睡眠窗。心跳关掉就不再排拍。
const nextBeat = (): number | undefined => {
  const c = config();
  if (!c.heartbeat) return undefined;
  const self = journal.self();
  const due = Date.now() + beatDelay(self, Date.now(), self.closeness);
  return nextWakeAfter(due, c.timezone, c.sleepStart, c.sleepEnd, tonightArousal());
};

const runtime = new Runtime(journal, mind, {
  persona: () => config().persona,
  material: (turn) => material.build(turn.peer, turn).then((built) => built.material),
  send: (peer, part) => bridge.send(peer, part),
  nextBeat,
  onComposing: (peer, active) => bridge.composing(peer, active),
  onError,
  timeoutMs: () => config().turnTimeoutMs,
  // 睡着的她收不到消息：睡眠窗内到达的话推迟到醒来——深夜秒回是机器，
  // 人早上才看到凌晨的消息。醒来也不必整点爬起来拿手机：加几分钟随机
  // 的赖床。白天消息照旧只走 debounce。
  incomingDue: () => {
    const c = config();
    const due = Date.now() + c.debounceMs;
    const wake = nextWakeAfter(due, c.timezone, c.sleepStart, c.sleepEnd, tonightArousal());
    return wake > due ? wake + Math.floor(Math.random() * 12 * 60_000) : due;
  },
  concurrency: () => config().concurrency,
  pacing: () => true,
  stickerSlugs: () => new Set(stickers.list().map((item) => item.slug)),
  vision: () => config().primary.vision,
  readFile: (_peer: string, path: string, maxBytes: number) =>
    Promise.resolve(bridge.readMedia(path, maxBytes)),
});

/** 周期任务排期：日记与整理各自每天一次（日记点 + 1 小时）；心跳开着但
 *  没有下一拍时补种一拍。beat 链平时自我续排（跑完一拍排下一拍），唯独
 *  第一拍没有母亲——冷启动、迁移换库、开关刚打开，kernel_jobs 里都没有
 *  beat 行，她的意识会永远静默（部署实锤：容器跑 1 小时零调用零 muse）。
 *  幂等：有排期或正在跑就不动。 */
function ensureRecurringJobs(): void {
  const c = config();
  const now = Date.now();
  const jobs = journal.jobs();
  for (const peer of journal.peers()) {
    for (const kind of ['diary', 'tidy'] as const) {
      if (jobs.some((job) => job.peer === peer && job.kind === kind)) continue;
      if (journal.turnRunning(peer, kind)) continue;
      const hour = kind === 'diary' ? c.diaryHour : (c.diaryHour + 1) % 24;
      journal.schedule(peer, kind, nextLocalHour(now, hour, c.timezone));
    }
    if (
      c.heartbeat &&
      !jobs.some((job) => job.peer === peer && job.kind === 'beat') &&
      !journal.turnRunning(peer, 'beat')
    ) {
      const due = nextBeat();
      if (due !== undefined) runtime.schedule(peer, due);
    }
  }
}

/** 目标时区里下一个 hour 点整。DST 变更日最多偏一小时，中国时区无此问题。 */
function nextLocalHour(now: number, hour: number, timeZone: string): number {
  const midnight = localMidnightOf(now, timeZone);
  let candidate = midnight + hour * 3_600_000;
  if (candidate <= now) candidate += 86_400_000;
  return candidate;
}

// 管理密码：环境变量优先；没有就生成一次并写进数据目录。
function adminPassword(): string {
  if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 12)
    return process.env.ADMIN_PASSWORD;
  const secretPath = join(dataDir, 'admin-secret.txt');
  if (existsSync(secretPath)) {
    const saved = readFileSync(secretPath, 'utf8').trim();
    if (saved.length >= 12) return saved;
  }
  const secret = randomBytes(12).toString('base64url');
  writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

const app = createServer({
  password: adminPassword(),
  settings,
  journal,
  router,
  runtime,
  bridge,
  stickers,
  sandbox,
  webConfigured: () => Boolean(config().webSearchKey),
  onConfigChange: () => ensureRecurringJobs(),
  channelProbe,
  systemProbe,
  embeddingProbe,
  backup,
  staticRoot: join(root, 'public'),
  assetsRoot: join(root, 'assets', 'stickers'),
  customStickersRoot: join(dataDir, 'custom'),
  wall,
});

const port = Number(process.env.ATRI_PORT || 3000);
const host = process.env.ATRI_BIND || '127.0.0.1';

function startBackgroundMaintenance(): void {
  // 夜间排期、关系演化、终态清扫与向量滴灌都是分钟级维护：低频定时器，
  // 空闲时零开销。清扫幂等且便宜（旧库迁入后引用集与念头量会放大，
  // 这里是它们唯一的退场通道）。
  const night = setInterval(() => {
    evolveCloseness(journal, Date.now(), config().timezone);
    // 真歧义（sendmessage 超时/断连）10 分钟判死自愈：封通道等确认的
    // 语义有时限，管理员不在时她不该对着满队列闭嘴一整天。确定性失败
    // （上传 5xx/文件不存在）在发送链上已直接 failed，到不了这里。
    journal.expireUnknown(10 * 60_000);
    journal.pruneThoughts(30 * 86_400_000);
    journal.pruneUsage(90 * 86_400_000);
    ensureRecurringJobs();
  }, 10 * 60_000);
  night.unref();
  evolveCloseness(journal, Date.now(), config().timezone);
  ensureRecurringJobs();
  const drip = setInterval(() => {
    const client = config().embedding ? embeddings : undefined;
    if (!client?.configured) return;
    for (const peer of journal.peers()) dripBackfill(journal, client, peer).catch(onError);
  }, 5 * 60_000);
  drip.unref();
  // 收到的图片只在对话事件里被引用：事件之外的文件永远没人读。启动与
  // 每天各扫一次，引用集之外即孤儿（写入与扫描同一进程，时序上先落盘
  // 后入事件——扫掉的只可能是早已无人引用的）。
  const sweep = setInterval(sweepMedia, 24 * 3_600_000);
  sweep.unref();
  sweepMedia();
  // WebDAV 每日备份：凌晨 4 点（错开 3 点她的日记与 4 点+1h 的整理），
  // 定时器 10 分钟一查，过点即补；同一日期只备一次。失败不中断进程，
  // 状态在管理页可见，明天同一时间自动重试。
  const backupTimer = setInterval(() => {
    backup.tick(Date.now()).catch(onError);
  }, 10 * 60_000);
  backupTimer.unref();
  backup.tick(Date.now()).catch(onError); // 启动即查：停机跨天的缺口当天补上
}

function sweepMedia(): void {
  let files: string[];
  try {
    files = readdirSync(join(dataDir, 'media'));
  } catch {
    return;
  }
  // 引用集在 SQL 侧先筛含 media 字段的行，不再逐条解析整部聊天史。
  const referenced = new Set<string>();
  for (const peer of journal.peers())
    for (const path of journal.referencedMedia(peer)) referenced.add(path);
  let swept = 0;
  for (const file of files)
    if (!referenced.has(`media/${file}`)) {
      rmSync(join(dataDir, 'media', file), { force: true });
      swept++;
    }
  if (swept) console.log(`[atri] swept ${swept} orphan media files`);
}

app
  .listen({ port, host })
  .then(() => {
    console.log(`atri listening on http://${host}:${port}`);
    bridge.start(runtime);
    runtime.start();
    startBackgroundMaintenance();
  })
  .catch((error) => {
    onError(error);
    process.exit(1);
  });

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    // 先关 HTTP（等在途请求收尾），再停心跳与桥，最后落库收口。
    await app.close();
    await runtime.stop();
    await bridge.stop();
    sandbox.dispose();
    journal.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
