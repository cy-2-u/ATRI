import type { Journal } from '../storage/journal.js';
import { Recollection } from './memory.js';
import type { ToolHandler } from './mind.js';
import type { Sandbox } from '../sandbox.js';
import type { WebTools } from '../web.js';

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} 必须是非空文本`);
  return value;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string') || value.length > 30)
    throw new TypeError('sources 必须是最多三十项的来源 ID 数组');
  return value;
}

/** 聊天/心跳工具集（记忆与约定）+ 手（沙箱）+ 眼（联网）+ 日记。
 *  全部工具注册进同一个 Mind，按 turn.kind 的工具集决定本轮谁可用。 */
export function lifeTools(
  journal: Journal,
  deps: { sandbox?: Sandbox; web?: WebTools },
): ToolHandler[] {
  const recollection = new Recollection(journal);
  const tools: ToolHandler[] = [
    {
      definition: {
        name: 'search_memory',
        description: '按主题回想；模糊记忆只返回要旨，精确原文需查历史。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
      async execute(args, _options, turn) {
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
        description: '查阅最近实际收到和确认送达的聊天记录；这是查到的原文。',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
          additionalProperties: false,
        },
      },
      async execute(args, _options, turn) {
        const limit = args.limit === undefined ? 20 : args.limit;
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50)
          throw new TypeError('limit 必须在 1–50 之间');
        return journal.conversation(turn.peer, limit);
      },
    },
    {
      definition: {
        name: 'remember',
        description:
          '从真实来源记住事实或自己的理解。相近不等于重复；更正旧事实必须显式给 supersedes。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            gist: { type: 'string' },
            kind: { type: 'string', enum: ['stated', 'interpretation'] },
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
        if (args.kind !== 'stated' && args.kind !== 'interpretation')
          throw new TypeError('kind 无效');
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
    },
    {
      definition: {
        name: 'keep_commitment',
        description:
          '记下有来源的提醒、承诺或挂念。dueAt 为带明确时区计算出的 Unix 毫秒，无日期挂念用 0；不凭空承诺已完成。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            kind: { type: 'string', enum: ['reminder', 'concern', 'promise'] },
            sources: { type: 'array', items: { type: 'string' } },
            dueAt: { type: 'integer', minimum: 0 },
            recurring: { type: 'string', enum: ['none', 'yearly'] },
          },
          required: ['content', 'kind', 'sources', 'dueAt'],
          additionalProperties: false,
        },
      },
      async execute(args, _options, turn) {
        if (args.kind !== 'reminder' && args.kind !== 'concern' && args.kind !== 'promise')
          throw new TypeError('约定类型无效');
        if (typeof args.dueAt !== 'number' || !Number.isSafeInteger(args.dueAt) || args.dueAt < 0)
          throw new TypeError('dueAt 必须是有效 Unix 毫秒');
        if (
          args.recurring !== undefined &&
          args.recurring !== 'none' &&
          args.recurring !== 'yearly'
        )
          throw new TypeError('重复周期无效');
        const item = journal.keepCommitment(turn.peer, {
          content: text(args.content, 'content'),
          kind: args.kind,
          sources: ids(args.sources),
          dueAt: args.dueAt,
          recurring: args.recurring ?? 'none',
        });
        return { id: item.id, dueAt: item.dueAt, state: item.state };
      },
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
        const sources = ids(args.sources);
        const evidence = journal.evidence(turn.peer, sources);
        if (
          !sources.length ||
          evidence.length !== new Set(sources).size ||
          evidence.some((event) => !['received', 'experienced'].includes(event.kind))
        )
          throw new TypeError('了结约定必须有对方反馈或实际行动依据');
        return { resolved: journal.resolveCommitment(turn.peer, text(args.id, 'id')) };
      },
    },
    {
      definition: {
        name: 'consider',
        description: '保留尚未表达的念头。相同主题和证据不会反复重新激活已表达念头。',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string' },
            meaning: { type: 'string' },
            sources: { type: 'array', items: { type: 'string' } },
          },
          required: ['topic', 'meaning', 'sources'],
          additionalProperties: false,
        },
      },
      async execute(args, _options, turn) {
        const thought = recollection.consider(
          turn.peer,
          text(args.topic, 'topic'),
          text(args.meaning, 'meaning'),
          ids(args.sources),
        );
        return { id: thought.id, state: thought.state };
      },
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
          const sources = ids(item.sources);
          const evidence = journal.evidence(turn.peer, sources);
          if (
            !sources.length ||
            evidence.length !== new Set(sources).size ||
            evidence.some((event) => !['received', 'said', 'experienced'].includes(event.kind))
          )
            throw new TypeError('日记段缺少真实来源');
          const emotion = item.emotion === undefined ? 0 : Number(item.emotion);
          if (!Number.isFinite(emotion) || emotion < -1 || emotion > 1)
            throw new TypeError('emotion 必须在 -1 到 1 之间');
          const id = journal.appendEvent(turn.peer, turn.id, 'diary', { content, emotion });
          written.push({ id, emotion });
        }
        return { written };
      },
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
  return tools;
}

/** 各思考类型可用的工具集（未列出的类型用全部工具）。 */
export const TOOL_SETS = {
  chat: [
    'search_memory',
    'read_history',
    'remember',
    'keep_commitment',
    'resolve_commitment',
    'consider',
    'run_command',
    'write_file',
    'read_file',
    'list_files',
    'delete_file',
    'web_search',
    'open_page',
  ],
  beat: [
    'search_memory',
    'read_history',
    'remember',
    'keep_commitment',
    'resolve_commitment',
    'consider',
    'run_command',
    'write_file',
    'read_file',
    'list_files',
    'delete_file',
    'web_search',
    'open_page',
  ],
  reminder: [
    'search_memory',
    'read_history',
    'remember',
    'keep_commitment',
    'resolve_commitment',
    'consider',
    'run_command',
    'write_file',
    'read_file',
    'list_files',
    'delete_file',
    'web_search',
    'open_page',
  ],
  diary: ['search_memory', 'read_history', 'remember', 'write_journal'],
  tidy: ['remember', 'search_memory'],
} as const;
