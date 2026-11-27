import type { Journal } from '../storage/journal.js';
import { Recollection, type PeerBelief } from './memory.js';
import { instant } from './rhythm.js';
import type { ToolHandler } from './mind.js';
import type { Sandbox } from '../sandbox.js';
import type { WebTools } from '../web.js';
import type { ImagePainter } from '../image.js';
import type { Wall } from '../wall.js';
import type { Stickers } from '../stickers.js';

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} 必须是非空文本`);
  return value;
}

function ids(value: unknown): string[] {
  // 格式层容错：单个字符串自动包成单元素数组、数字/布尔 id 转字符串——
  // 无歧义的死错误代码修比整轮重试便宜；真数组混对象等垃圾仍打回。
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    value = [value];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string') || value.length > 30)
    throw new TypeError('sources 需要最多三十项的来源 ID 数组');
  return [...new Set(value as string[])];
}

/** 约定/念头的到期时刻：Unix 毫秒直通；墙钟 ISO 时间（含裸本地时间）按她的
 *  时区锚定成毫秒——墙钟归模型，时区换算归代码，模型不猜 UTC 偏移。 */
function dueAt(value: unknown, timeZone: string): number {
  const at = instant(value, timeZone);
  if (at < 0) throw new TypeError('dueAt 不能早于 1970 年');
  return at;
}

/** 聊天/心跳工具集（记忆与约定）+ 手（沙箱）+ 眼（联网）+ 画笔 + 日记。
 *  全部工具注册进同一个 Mind，按 turn.kind 的工具集决定本轮谁可用。
 *  timezone 现读：管理面改时区即时生效，不需要重启进程。 */
export function lifeTools(
  journal: Journal,
  deps: {
    sandbox?: Sandbox;
    web?: WebTools;
    image?: ImagePainter;
    wall?: Wall;
    stickers?: Stickers;
    timezone?: () => string;
  },
): ToolHandler[] {
  const recollection = new Recollection(journal);
  const herZone = (): string => deps.timezone?.() ?? 'Asia/Shanghai';
  const tools: ToolHandler[] = [
    {
      definition: {
        name: 'search_memory',
        description:
          '按主题回想记忆或翻自己写过的日记（kind:"diary"）；模糊记忆只返回要旨，精确原文需查历史。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            kind: { type: 'string', enum: ['memory', 'diary'] },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      async execute(args, _options, turn) {
        if (args.kind === 'diary')
          return recollection.diaryRecall(turn.peer, text(args.query, 'query')).map((hit) => ({
            id: hit.id,
            text: hit.text,
            certainty: hit.detail >= 0.75 ? 'clear' : 'gist',
            kind: 'diary',
            at: hit.at,
          }));
        return recollection.recall(turn.peer, text(args.query, 'query')).map((hit) => ({
          id: hit.memory.id,
          text: hit.text,
          certainty: hit.memory.detail >= 0.75 ? 'clear' : 'gist',
          kind: hit.memory.kind,
          sources: hit.memory.sources,
        }));
      },
    },
    {
      definition: {
        name: 'read_history',
        description:
          '查阅聊天记录：给 ids 就精确取回那几条（记忆或念头 sources 里的原文用它核对），不给则返回最近若干条。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50 },
            ids: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          },
          additionalProperties: false,
        },
      },
      async execute(args, _options, turn) {
        const render = (row: { id: string; kind: string; content: string; created_at: number }) => {
          let text = row.content;
          try {
            const part = JSON.parse(row.content) as {
              type?: string;
              text?: string;
              content?: string;
            };
            if (part?.type === 'sticker') text = '[发了个表情]';
            else if (part?.type === 'image') text = '[发了张图片]';
            else if (typeof part?.text === 'string') text = part.text;
            else if (typeof part?.content === 'string') text = part.content;
          } catch {
            /* 纯文本 */
          }
          return {
            id: row.id,
            who: row.kind === 'received' ? '他' : '你',
            text,
            at: row.created_at,
          };
        };
        if (Array.isArray(args.ids)) {
          const wanted = args.ids.filter((id): id is string => typeof id === 'string').slice(0, 8);
          if (wanted.length) return journal.eventsByIds(turn.peer, wanted).map(render);
        }
        const limit = args.limit === undefined ? 20 : args.limit;
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50)
          throw new TypeError('limit 必须在 1–50 之间');
        return journal.conversation(turn.peer, limit).map(render);
      },
    },
    {
      definition: {
        name: 'remember',
        description:
          '从真实来源记住事实或自己的理解。相近不等于重复；更正旧事实必须显式给 supersedes。identity（我是谁的长期认识）只在夜里可用，且至少两处来源。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            gist: { type: 'string' },
            kind: { type: 'string', enum: ['stated', 'interpretation', 'identity'] },
            sources: { type: 'array', items: { type: 'string' } },
            importance: { type: 'number', minimum: 0, maximum: 1 },
            emotion: { type: 'number', minimum: -1, maximum: 1 },
            supersedes: { type: 'array', items: { type: 'string' } },
          },
          required: ['content', 'gist', 'kind', 'sources'],
          additionalProperties: false,
        },
      },
      async execute(args, _options, turn) {
        if (args.kind !== 'stated' && args.kind !== 'interpretation' && args.kind !== 'identity')
          throw new TypeError('kind 无效');
        if (args.kind === 'identity' && turn.kind !== 'diary' && turn.kind !== 'tidy')
          throw new TypeError('对自己的认识只在夜里的日记拍和整理拍写');
        const memory = recollection.remember(turn.peer, {
          content: text(args.content, 'content'),
          gist: text(args.gist, 'gist'),
          kind: args.kind,
          sources: ids(args.sources),
          importance: args.importance === undefined ? 0.5 : Number(args.importance),
          emotion: args.emotion === undefined ? 0 : Number(args.emotion),
          supersedes: args.supersedes === undefined ? [] : ids(args.supersedes),
        });
        return { id: memory.id, status: memory.status };
      },
      mutates: true,
    },
    {
      definition: {
        name: 'keep_commitment',
        description:
          '记下有来源的提醒、承诺或挂念。dueAt 为未来的时刻：带时区的 ISO 时间（如 2026-07-01T20:00:00+08:00）或 Unix 毫秒，无日期挂念用 0；不凭空承诺已完成。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            kind: { type: 'string', enum: ['reminder', 'concern', 'promise'] },
            sources: { type: 'array', items: { type: 'string' } },
            dueAt: { description: '未来的时刻：带时区的 ISO 时间或 Unix 毫秒，0 表示无时间' },
            recurring: { type: 'string', enum: ['none', 'day', 'week', 'month', 'year'] },
          },
          required: ['content', 'kind', 'sources', 'dueAt'],
          additionalProperties: false,
        },
      },
      async execute(args, _options, turn) {
        if (args.kind !== 'reminder' && args.kind !== 'concern' && args.kind !== 'promise')
          throw new TypeError('约定类型无效');
        const due = args.dueAt === 0 ? 0 : dueAt(args.dueAt, herZone());
        if (
          args.recurring !== undefined &&
          !['none', 'day', 'week', 'month', 'year'].includes(String(args.recurring))
        )
          throw new TypeError('重复周期无效');
        const item = journal.keepCommitment(turn.peer, {
          content: text(args.content, 'content'),
          kind: args.kind,
          sources: ids(args.sources),
          dueAt: due,
          recurring: (args.recurring as 'none' | 'day' | 'week' | 'month' | 'year') ?? 'none',
        });
        return { id: item.id, dueAt: item.dueAt, state: item.state };
      },
      mutates: true,
    },
    {
      definition: {
        name: 'resolve_commitment',
        description: '根据新证据了结约定或挂念；周年安排自动续到未来。单纯生成草稿不表示已履约。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            sources: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'sources'],
          additionalProperties: false,
        },
      },
      async execute(args, _options, turn) {
        // 校验松绑（用户裁决 2026-11-26）：履约依据门槛摘除——她乐意了结就让她
        // 了结，引用失效来源照单全收；resolveCommitment 落空返回 false 不炸轮。
        return { resolved: journal.resolveCommitment(turn.peer, text(args.id, 'id')) };
      },
      mutates: true,
    },
    {
      definition: {
        name: 'consider',
        description:
          '保留尚未表达的念头；带 dueAt（未来的时刻：带时区的 ISO 时间或 Unix 毫秒）就是你在期待的事，材料里会有倒计时。相同主题和证据不会反复重新激活已表达念头。',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string' },
            meaning: { type: 'string' },
            sources: { type: 'array', items: { type: 'string' } },
            dueAt: {
              description:
                '未来的时刻：带时区的 ISO 时间（如 2026-07-01T20:00:00+08:00）或 Unix 毫秒',
            },
          },
          required: ['topic', 'meaning', 'sources'],
          additionalProperties: false,
        },
      },
      async execute(args, _options, turn) {
        const due =
          args.dueAt === undefined || args.dueAt === 0 ? undefined : dueAt(args.dueAt, herZone());
        const thought = recollection.consider(
          turn.peer,
          text(args.topic, 'topic'),
          text(args.meaning, 'meaning'),
          ids(args.sources),
          due,
        );
        return { id: thought.id, state: thought.state, dueAt: thought.dueAt ?? 0 };
      },
      mutates: true,
    },
    {
      definition: {
        name: 'update_peer_model',
        description:
          '把你此刻对"他"的认识整批重写（最多八条，每条一句话、带真实依据：消息/事件/记忆 ID）。夜里整理时用；写下的东西会带着"最后核实时间"出现在你之后的资料里。',
        parameters: {
          type: 'object',
          properties: {
            beliefs: {
              type: 'array',
              maxItems: 8,
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  basis: { type: 'array', items: { type: 'string' } },
                },
                required: ['text', 'basis'],
                additionalProperties: false,
              },
            },
          },
          required: ['beliefs'],
          additionalProperties: false,
        },
      },
      async execute(args, _options, turn) {
        if (turn.kind !== 'tidy') throw new TypeError('心智模型只在夜里的整理拍修订');
        if (!Array.isArray(args.beliefs)) throw new TypeError('beliefs 必须是数组');
        const beliefs: PeerBelief[] = [];
        for (const raw of args.beliefs.slice(0, 8)) {
          if (!raw || typeof raw !== 'object') throw new TypeError('信念必须是对象');
          const item = raw as { text?: unknown; basis?: unknown };
          const content = text(item.text, 'text').slice(0, 160);
          // 校验松绑（用户裁决 2026-11-26）：依据存在性门槛摘除——失效引用
          // 静默跳过（filter 剔除）后照存，不炸整轮整理拍。
          const basis = ids(item.basis).filter((id) => journal.supports(turn.peer, [id]) === 1);
          beliefs.push({ text: content, basis: [...new Set(basis)] });
        }
        const model = { beliefs, updatedAt: Date.now() };
        journal.savePeerModel(turn.peer, model);
        return { beliefs: beliefs.length };
      },
      mutates: true,
    },
    {
      definition: {
        name: 'update_topic_notes',
        description:
          '重写"你们最近在聊什么"的话题笔记（滚动摘要，六百字内）。只在夜里整理时可用；资料里有 notesTask 才值得调用。',
        parameters: {
          type: 'object',
          properties: { content: { type: 'string' } },
          required: ['content'],
          additionalProperties: false,
        },
      },
      async execute(args, _options, turn) {
        if (turn.kind !== 'tidy') throw new TypeError('话题笔记只在夜里的整理拍重写');
        const content = text(args.content, 'content');
        if (content.length > 600) throw new TypeError('笔记太长了，三百字以内');
        const lastSeq = journal.setting<number>(`notes:seq:${turn.peer}`, 0);
        // 游标取增量材料的末条；没给 notesTask 时（无新对话）只允许改写文本。
        const fresh = journal.conversationAfter(turn.peer, lastSeq);
        if (fresh.length >= 6)
          journal.setSetting(`notes:seq:${turn.peer}`, fresh[fresh.length - 1]!.seq);
        journal.setSetting(`notes:${turn.peer}`, content.trim());
        return { saved: true };
      },
      mutates: true,
    },
    {
      definition: {
        name: 'write_journal',
        description: '把日记段落提交进你的日记；每段都必须有真实来源。只在夜里写日记时使用。',
        parameters: {
          type: 'object',
          properties: {
            sections: {
              type: 'array',
              maxItems: 6,
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string' },
                  sources: { type: 'array', items: { type: 'string' } },
                  emotion: { type: 'number', minimum: -1, maximum: 1 },
                },
                required: ['content', 'sources'],
                additionalProperties: false,
              },
            },
          },
          required: ['sections'],
          additionalProperties: false,
        },
      },
      async execute(args, _options, turn) {
        if (turn.kind !== 'diary') throw new TypeError('日记只在夜里的日记拍写');
        if (!Array.isArray(args.sections)) throw new TypeError('sections 必须是数组');
        const sections = args.sections.slice(0, 6);
        const written: { id: string; emotion: number }[] = [];
        for (const section of sections) {
          if (!section || typeof section !== 'object') throw new TypeError('日记段必须是对象');
          const item = section as { content?: unknown; sources?: unknown; emotion?: unknown };
          const content = text(item.content, 'content').slice(0, 2000);
          // 校验松绑（用户裁决 2026-11-26）：日记来源门槛摘除——她写的日记
          // 不因引用问题被拒；sources 留档不校验。情绪轴超界 clamp（主观权重非诚实凭据）。
          const emotionRaw = item.emotion === undefined ? 0 : Number(item.emotion);
          const emotion = Number.isFinite(emotionRaw) ? Math.max(-1, Math.min(1, emotionRaw)) : 0;
          const id = journal.appendEvent(turn.peer, turn.id, 'diary', { content, emotion });
          written.push({ id, emotion });
        }
        return { written };
      },
      mutates: true,
    },
  ];
  if (deps.sandbox) {
    const sandbox = deps.sandbox;
    tools.push(
      {
        definition: {
          name: 'run_command',
          description:
            '在你的工作目录里真实运行一条 shell 命令（隔离沙箱内，限时）。做东西、跑脚本、处理文件都靠它。',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
            additionalProperties: false,
          },
        },
        async execute(args, options) {
          const result = await sandbox.run(text(args.command, 'command'), options.signal);
          return result;
        },
        mutates: true,
      },
      {
        definition: {
          name: 'write_file',
          description: '在工作目录里写一个文本文件。',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
        async execute(args) {
          return sandbox.write(
            text(args.path, 'path'),
            typeof args.content === 'string' ? args.content : '',
          );
        },
        mutates: true,
      },
      {
        definition: {
          name: 'read_file',
          description: '读工作目录里的一个文本文件。',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
        async execute(args) {
          return sandbox.read(text(args.path, 'path'));
        },
      },
      {
        definition: {
          name: 'list_files',
          description: '列出工作目录（或子目录）里的文件。',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            additionalProperties: false,
          },
        },
        async execute(args) {
          return sandbox.list(typeof args.path === 'string' && args.path ? args.path : '.');
        },
      },
      {
        definition: {
          name: 'delete_file',
          description: '删除工作目录里的文件或空目录；recursive 为 true 时递归删除目录。',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
        async execute(args) {
          return sandbox.delete(text(args.path, 'path'), args.recursive === true);
        },
        mutates: true,
      },
    );
  }
  if (deps.web) {
    const web = deps.web;
    tools.push(
      {
        definition: {
          name: 'web_search',
          description: '联网搜索新闻、天气与时效事实；结果带真实链接。',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              freshness: { type: 'string', enum: ['d', 'w', 'm', 'y'] },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
        async execute(args, options) {
          const results = await web.search(
            text(args.query, 'query'),
            typeof args.freshness === 'string' ? args.freshness : undefined,
            options.signal,
          );
          return { results };
        },
      },
      {
        definition: {
          name: 'open_page',
          description: '读取一个公开网页的正文。',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
            additionalProperties: false,
          },
        },
        async execute(args, options) {
          return web.open(text(args.url, 'url'), options.signal);
        },
      },
    );
  }
  // 画笔需要手：画好的图是沙箱里的真实文件，没有落盘处就没有"画成"。
  if (deps.image && deps.sandbox) {
    const painter = deps.image;
    const sandbox = deps.sandbox;
    tools.push({
      definition: {
        name: 'draw_image',
        // 提示词格式随引擎走：注册时静态求值会锁死引擎，改为读取时动态
        // 求值——管理页切换引擎后她下一拍就拿对新格式（beta 实测技巧）。
        get description() {
          return painter.engine === 'nai'
            ? '调用 NAI 画图生成一张真实图片文件（存在你的 pictures/ 目录里）。prompt 必须是英文 danbooru tag 串：逗号分隔的英文标签（如 1girl, white hair, looking at viewer, smile, simple background），质量词开头（best quality, masterpiece），复合概念拆成独立 tag，角色名用官方英文 tag；禁止中文、禁止自然句子、禁止引号内对话。想给他看就用 {"type":"image","path":"pictures/文件名"} 发送。画得慢（最多两分钟）；画不成如实说。'
            : '把想画的东西画成一张真实图片文件（存在你的 pictures/ 目录里）。想给他看就用 {"type":"image","path":"pictures/文件名"} 发送。画得慢（最多两分钟）；画不成如实说。';
        },
        parameters: {
          type: 'object',
          properties: { prompt: { type: 'string' } },
          required: ['prompt'],
          additionalProperties: false,
        },
      },
      async execute(args, options) {
        const painted = await painter.paint(text(args.prompt, 'prompt'), options.signal);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const saved = await sandbox.writeBytes(
          `pictures/${stamp}-${Math.random().toString(36).slice(2, 6)}.${painted.ext}`,
          painted.bytes,
        );
        return {
          path: saved.path,
          mime: painted.mime,
          bytes: painted.bytes.length,
          note: '画好了，在 pictures/ 里；想给他看就发 image 气泡',
        };
      },
      mutates: true,
    });
  }
  // 留言墙需要手：贴图是沙箱文件的快照，没有手就没有图。
  if (deps.wall && deps.sandbox) {
    const wall = deps.wall;
    const sandbox = deps.sandbox;
    const stickers = deps.stickers;
    tools.push({
      definition: {
        name: 'publish',
        description:
          '往你们的留言墙上贴一张便签（免登录网页，他路过时会看见）。text 是便签上的话（500 字内）；想配图有三个来路：sticker 给目录里的表情包 slug（回他的话用表情包最顺手，动图也行）、path 给沙箱里的图片文件路径（如 pictures/xx.png，自己画的画走这里）、两者都不给就是纯文字便签。文字与图至少有一样。便签贴上去就独立存在，不指向任何一段对话，也不需要谁回应。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            path: { type: 'string' },
            sticker: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      async execute(args) {
        const stickerSlug =
          stickers && typeof args.sticker === 'string' && args.sticker
            ? stickers.resolve(args.sticker)
            : undefined;
        if (typeof args.sticker === 'string' && args.sticker && !stickerSlug)
          throw new TypeError('目录里没有这个表情，用 catalogPrompt 里的 slug 原样照抄');
        const bytes = stickerSlug ? stickers!.bytes(stickerSlug) : undefined;
        const note = await wall.post(
          'her',
          typeof args.text === 'string' ? args.text : '',
          typeof args.path === 'string' && args.path && !bytes ? args.path : undefined,
          sandbox,
          bytes,
        );
        return { posted: true, at: note.at, note: '已贴上墙。想看墙上还有什么，用 read_wall。' };
      },
      mutates: true,
    });
    tools.push({
      definition: {
        name: 'read_wall',
        description:
          '凑近看墙：墙上贴着你们俩的便签（他的和你自己的都在）。不带参数返回最近的便签目录（谁贴的、说了什么、有没有图）；给 id 看单张全文，图会复制进沙箱（用 read_file 或视觉看它）；给 from 和 limit 翻指定的人贴的更多便签。翻过之后墙上的新东西就都算你见过了。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            from: { type: 'string', enum: ['him', 'her'] },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
          },
          additionalProperties: false,
        },
      },
      async execute(args) {
        if (typeof args.id === 'string' && args.id) {
          const note = wall.note(args.id);
          if (!note) throw new TypeError('墙上没有这张便签');
          let sandboxPath: string | undefined;
          if (note.image) {
            const bytes = wall.imageBytes(note.image);
            if (bytes) {
              const written = await sandbox.writeBytes(`wall-${note.image}`, Buffer.from(bytes));
              sandboxPath = written.path;
            }
          }
          return {
            from: note.from,
            text: note.text,
            at: note.at,
            ...(sandboxPath ? { image: sandboxPath } : {}),
          };
        }
        const notes = wall.notes({
          from: args.from === 'her' || args.from === 'him' ? args.from : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
        // 翻过就算看过：seen 指针推进，材料里的提示牌随之清零。
        wall.markSeen();
        return notes.map((n) => ({
          id: n.id,
          from: n.from,
          text: n.text.slice(0, 80),
          hasImage: Boolean(n.image),
          at: n.at,
        }));
      },
    });
  }
  return tools;
}

/** 各思考类型可用的工具集（未列出的类型用全部工具）。 */
const HAND_AND_EYE = [
  'run_command',
  'write_file',
  'read_file',
  'list_files',
  'delete_file',
  'web_search',
  'open_page',
  'draw_image',
  'publish',
] as const;

export const TOOL_SETS = {
  chat: [
    'search_memory',
    'read_history',
    'remember',
    'keep_commitment',
    'resolve_commitment',
    'consider',
    'read_wall',
    ...HAND_AND_EYE,
  ],
  beat: [
    'search_memory',
    'read_history',
    'remember',
    'keep_commitment',
    'resolve_commitment',
    'consider',
    'read_wall',
    ...HAND_AND_EYE,
  ],
  reminder: [
    'search_memory',
    'read_history',
    'remember',
    'keep_commitment',
    'resolve_commitment',
    'consider',
    ...HAND_AND_EYE,
  ],
  diary: ['search_memory', 'read_history', 'remember', 'write_journal'],
  tidy: ['remember', 'search_memory', 'update_peer_model', 'update_topic_notes'],
} as const;
