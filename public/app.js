/** 管理页：她的一切。轮询用快照差分（不变不重绘），破坏性操作双击确认。
 *  数据层对接正式版契约：所有非 GET 带 x-csrf-token；配置保存走 {patch}；
 *  她的话 = accepted 事件，对方的话 = received 事件；会话（peer）维度贯穿全部页签。 */

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;

let authenticated = false,
  csrf = '',
  currentTab = 'chat',
  journalSub = 'diary',
  peers = [],
  peerId = '',
  configCache = null,
  statusSeq = 0,
  chatSnapshot = '',
  journalSnapshot = '',
  stickersSnapshot = '',
  usageSnapshot = '',
  issuesSnapshot = '',
  chipsSnapshot = '',
  pollTimer = 0;
/** 最近一次待办列表：打开抽屉时据此写已读指纹。 */
let lastIssues = [];

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function show(message, error = false) {
  const toast = $('notice');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  clearTimeout(show.timer);
  show.timer = setTimeout(
    () => {
      toast.hidden = true;
    },
    error ? 12000 : 5000,
  );
}
function empty(node, message) {
  node.replaceChildren(el('p', message, 'empty'));
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401 && authenticated) {
    authenticated = false;
    $('dashboard').hidden = true;
    $('login').hidden = false;
    throw new Error('登录已过期，请重新进入');
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `请求失败（HTTP ${response.status}）`);
  return json;
}
async function perform(action, node) {
  try {
    if (node) node.disabled = true;
    await action();
  } catch (error) {
    show(error?.message || String(error), true);
  } finally {
    if (node) node.disabled = false;
  }
}
function confirmButton(label, message, handler, classes = 'ghost small danger') {
  const node = el('button', label, 'btn ' + classes);
  node.type = 'button';
  node.onclick = async () => {
    if (node.dataset.armed !== '1') {
      node.dataset.armed = '1';
      node.textContent = message;
      node.classList.add('armed');
      setTimeout(() => {
        if (node.isConnected) {
          node.dataset.armed = '';
          node.textContent = label;
          node.classList.remove('armed');
        }
      }, 3000);
      return;
    }
    node.dataset.armed = '';
    node.textContent = label;
    node.classList.remove('armed');
    await perform(handler, node);
  };
  return node;
}
function usageDayLine(label, totals, isTotal) {
  const line = el('div', undefined, 'usage-day' + (isTotal ? ' usage-total' : ''));
  const nums = (value) => value.toLocaleString('zh-CN');
  line.append(
    el('span', label, 'usage-day-label'),
    el(
      'span',
      `${totals.calls} 次调用 · 输入 ${nums(totals.input)} · 输出 ${nums(totals.output)}${totals.cached ? ` · 缓存命中 ${nums(totals.cached)}` : ''}`,
      'usage-day-count',
    ),
  );
  return line;
}

function timeText(at) {
  if (!at) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at));
}
function hmTime(at) {
  if (!at) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at));
}
const peerName = (id) => peers.find((p) => p.id === id)?.name || id;
// 入睡/醒来从纯分钟改成 HH:MM：人读的是钟点不是分钟数。
const minutesToHM = (minutes) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const hmToMinutes = (value) => {
  const text = String(value).trim();
  // 清空不是 00:00：静默把入睡改到午夜比报错更糟。
  if (!text) throw new Error('时间不能为空（HH:MM）');
  const parsed = /^(\d{1,2}):(\d{1,2})$/.exec(text);
  if (parsed) {
    const minutes = Number(parsed[1]) * 60 + Number(parsed[2]);
    if (Number(parsed[1]) > 23 || Number(parsed[2]) > 59 || minutes > 1439)
      throw new Error('时间无效（HH:MM，00:00–23:59）');
    return minutes;
  }
  const minutes = Number(text);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1439)
    throw new Error('时间无效（HH:MM 或分钟 0–1439）');
  return minutes;
};
// 她的话 = accepted 事件（data 是发送的 part + 平台回执）；对方的话 = received。
function bubbleText(event) {
  const data = event.data ?? {};
  if (event.kind === 'accepted') {
    if (typeof data.text === 'string' && data.text) return data.text;
    if (data.slug) return '[表情]';
    if (data.path) return '[图片]';
    return '[一条消息]';
  }
  // 单聊里 author 就是对方的 openid：32 位匿名 ID 是平台噪音，不进对话视图（身份由会话名表达）。
  const target = peerId.slice(peerId.indexOf(':') + 1);
  const prefix = data.author && data.author !== '本地管理员' && data.author !== target ? `【${data.author}】` : '';
  return prefix + (typeof data.text === 'string' ? data.text : '[图片]');
}

// ---------- 登录 ----------

$('login-form').onsubmit = async (event) => {
  event.preventDefault();
  await perform(async () => {
    const data = await api('/api/login', { method: 'POST', body: { password: $('password').value } });
    csrf = data.csrf;
    await enter();
  }, $('login-form').querySelector('button'));
};
$('logout').onclick = async () => {
  await perform(async () => {
    await api('/api/logout', { method: 'POST', body: {} });
    authenticated = false;
    $('dashboard').hidden = true;
    $('login').hidden = false;
  });
};

/** 登录或会话恢复后的共同入口：拉会话与配置，点亮面板。 */
async function enter() {
  authenticated = true;
  peers = await api('/api/peers');
  const real = peers.find((p) => p.id !== 'c2c:preview');
  if (!peerId || !peers.some((p) => p.id === peerId)) peerId = real?.id ?? '';
  $('chat-head-name').textContent = peerId ? peerName(peerId) : '她';
  fillPersonaForm.done = false;
  fillSystemForm.done = false;
  $('login').hidden = true;
  $('dashboard').hidden = false;
  // 五个视图初始都是 hidden：不点亮当前 tab，登录后就是一个空壳面板。
  selectTab(currentTab);
  startPolling();
}

// ---------- 导航 ----------

for (const tab of document.querySelectorAll('#nav .nav-item')) {
  tab.onclick = () => {
    if (tab.dataset.tab) selectTab(tab.dataset.tab);
  };
}
function selectTab(name) {
  currentTab = name;
  for (const item of document.querySelectorAll('#nav .nav-item')) {
    const selected = item.dataset.tab === name;
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-selected', String(selected));
  }
  for (const view of document.querySelectorAll('#views .view'))
    view.hidden = view.id !== `view-${name}`;
  chatSnapshot = journalSnapshot = stickersSnapshot = usageSnapshot = '';
  refreshCurrent();
}
for (const sub of document.querySelectorAll('#view-journal .subtab')) {
  sub.onclick = () => {
    journalSub = sub.dataset.journal;
    for (const item of document.querySelectorAll('#view-journal .subtab')) {
      const selected = item === sub;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-selected', String(selected));
    }
    journalSnapshot = '';
    refreshCurrent();
  };
}
$('peer-select')?.remove();

// ---------- 抽屉 ----------

// 非阻塞侧板：点开关在开/合间切换，点面板外任意处收起，Esc 全收。
// 全页遮罩是对话框的做法——这两块是随手瞟一眼的侧板，遮住页面反而碍事。
for (const opener of document.querySelectorAll('[data-drawer]')) {
  opener.onclick = (event) => {
    event.stopPropagation();
    const drawer = $(opener.dataset.drawer);
    drawer.hidden = !drawer.hidden;
    if (!drawer.hidden) {
      // 打开待办抽屉即视为"看过"：refreshDrawers 拉到最新件后把整批
      // 记进已读指纹，红点立刻消失，列表与裁决按钮保留。
      if (opener.dataset.drawer === 'drawer-issues') markIssuesSeen();
      if (opener.dataset.drawer === 'drawer-connection') fillQQForm();
      refreshDrawers();
    }
  };
}
document.addEventListener('click', (event) => {
  for (const drawer of document.querySelectorAll('.drawer')) {
    if (!drawer.hidden && !drawer.contains(event.target)) drawer.hidden = true;
  }
});
for (const closer of document.querySelectorAll('[data-close]')) {
  closer.onclick = () => (closer.closest('.drawer').hidden = true);
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape')
    for (const drawer of document.querySelectorAll('.drawer')) drawer.hidden = true;
});

// ---------- 轮询：快照差分，不变不重绘 ----------

function startPolling() {
  clearInterval(pollTimer);
  const tick = async () => {
    const results = await refreshCurrent();
    // 断线可见：网络层失败（非登录过期）显示横幅，恢复即撤——
    // 空白页不解释自己是失职。
    const offline = results.some(
      (r) =>
        r.status === 'rejected' &&
        !(r.reason instanceof Error && r.reason.message.includes('登录已过期')),
    );
    const banner = $('offline-banner');
    if (banner) banner.hidden = !offline;
  };
  tick();
  pollTimer = setInterval(tick, 4000);
}
function refreshCurrent() {
  return Promise.allSettled([
    refreshStatus(),
    currentTab === 'chat' ? refreshChat() : Promise.resolve(),
    currentTab === 'journal' ? refreshJournal() : Promise.resolve(),
    currentTab === 'persona' ? refreshPersona() : Promise.resolve(),
    currentTab === 'stickers' ? refreshStickers() : Promise.resolve(),
    currentTab === 'system' ? refreshSystem() : Promise.resolve(),
  ]);
}
// 人设表单只填一次（进入页时），轮询不回写：别覆盖正在编辑的值。
async function refreshPersona() {
  const config = configCache ?? (await api('/api/config'));
  configCache = config;
  if (!fillPersonaForm.done) fillPersonaForm(config);
}
async function refreshStatus() {
  const seq = ++statusSeq;
  const status = await api('/api/status');
  if (seq !== statusSeq) return;
  // 人设全文不该每 4 秒拖一遍：config 走缓存，保存配置时置空重拉。
  const config = configCache ?? (await api('/api/config'));
  configCache = config;
  // 连接状态：QQ 官方网关的在线位。
  const qq = status.qq ?? {};
  const connected = Boolean(qq.online);
  $('connection-text').textContent = connected ? 'QQ 在线' : 'QQ 离线';
  const pill = $('connection');
  const dot = pill.querySelector('.pill-dot');
  pill.classList.toggle('online', connected);
  dot?.classList.toggle('warn', !connected);
  // 待办：unknown/failed 才是需要人工裁决的件。红点只对"没见过的新告警"亮。
  const deliveries = await api('/api/deliveries').catch(() => []);
  const issues = deliveries.filter((env) => env.status === 'unknown' || env.status === 'failed');
  lastIssues = issues;
  if (drawerIssuesOpen()) markIssuesSeen();
  const issuesSig = JSON.stringify(issues);
  if (issuesSig !== issuesSnapshot) {
    issuesSnapshot = issuesSig;
    renderIssues(issues);
  }
  const seen = new Set(issuesSeen());
  const unseen = issues.filter((env) => !seen.has(`${env.id}:${env.status}`));
  const count = $('issues-count');
  count.hidden = !unseen.length;
  count.textContent = String(unseen.length);
  // 她此刻（对话页侧栏）
  if (currentTab === 'chat') await renderSelfChips(status, peerId);
}

/** 已读指纹读取：损坏/不支持（隐身模式配额）时退化为全未读，红点多亮
 *  一次无害，轮询不能因此挂掉。 */
function issuesSeen() {
  try {
    const raw = JSON.parse(sessionStorage.getItem('issuesSeen') ?? '[]');
    return Array.isArray(raw) ? raw.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** 待办抽屉开着 = 用户正在看：把当前整批件记进已读指纹。 */
function drawerIssuesOpen() {
  return !$('drawer-issues').hidden;
}
function markIssuesSeen() {
  if (!lastIssues.length) return;
  try {
    sessionStorage.setItem(
      'issuesSeen',
      JSON.stringify(lastIssues.map((env) => `${env.id}:${env.status}`)),
    );
  } catch {
    /* 写不进去就让红点常亮：告警比安静安全 */
  }
}

async function renderSelfChips(status, id) {
  if (!id) {
    empty($('self-chips'), '等第一个人来找她。');
    return;
  }
  const inner = await api(`/api/inner?peer=${enc(id)}`).catch(() => null);
  if (!inner) return;
  const self = inner.self ?? {};
  const feeling = inner.feeling;
  const jobs = await api('/api/jobs').catch(() => []);
  // 队列的 kind 是内核术语，人读的是"心跳/日记"这样的钟点安排。
  const jobName = { chat: '回复', beat: '心跳', night: '夜间整理', reminder: '提醒' };
  const mood = feeling?.label
    ? `${feeling.label}${feeling.reason ? `（${feeling.reason}）` : ''}`
    : '平静';
  const parts = [
    { label: '心情', value: mood, sub: feeling?.at ? timeText(feeling.at) : '' },
    { label: '在做', value: self.activity || '没有在做特定的事' },
    { label: '在追', value: self.pursuit || '—' },
    {
      label: '黏人度',
      value: `${Math.round((self.closeness ?? 0) * 100)}${self.closenessDay ? ' · 每日演化中' : ''}`,
    },
    {
      label: 'QQ',
      value: status.qq?.error
        ? `最近出错：${status.qq.error}`
        : status.qq?.online
          ? '在线'
          : status.qq?.enabled
            ? '已启用，网关未连上'
            : '未启用',
      ok: !status.qq?.error,
    },
    {
      label: '队列',
      value: jobs.length
        ? jobs
            .slice(0, 4)
            .map((job) => `${jobName[job.kind] ?? job.kind} ${hmTime(job.dueAt)}`)
            .join(' · ')
        : '空',
    },
  ];
  const sig = JSON.stringify(parts);
  if (chipsSnapshot === sig) return;
  chipsSnapshot = sig;
  const chips = $('self-chips');
  chips.replaceChildren();
  for (const { label, value, sub, ok } of parts) {
    const chip = el('div', undefined, 'status-chip' + (ok === false ? ' status-chip-warn' : ''));
    chip.append(
      el('span', label, 'status-chip-label'),
      el('span', String(value), 'status-chip-value'),
    );
    if (sub) chip.append(el('span', String(sub), 'status-chip-sub'));
    chips.append(chip);
  }
}

async function refreshChat() {
  if (!peerId) {
    empty($('chat-messages'), '还没有对话。');
    return;
  }
  // 只拉这一个会话的近 200 条，前端留对话本体：日记、念头、failure 不进聊天视图。
  const events = await api(`/api/events?peer=${enc(peerId)}`).catch(() => []);
  const visible = events.filter((e) => e.kind === 'received' || e.kind === 'accepted');
  const sig = JSON.stringify(visible.map((e) => [e.seq, e.kind, e.data]));
  if (sig === chatSnapshot) return;
  chatSnapshot = sig;
  const list = $('chat-messages');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  list.replaceChildren();
  let lastDay = '';
  for (const event of visible) {
    const day = new Intl.DateTimeFormat('zh-CN', {
      timeZone: configCache?.life?.timezone || 'Asia/Shanghai',
      month: 'long',
      day: 'numeric',
    }).format(new Date(event.at));
    if (day !== lastDay) {
      lastDay = day;
      list.append(el('div', day, 'date-sep'));
    }
    const she = event.kind === 'accepted';
    // 消息结构 = .msg（方向与宽度）> .bubble（底色圆角）+ 时间戳。
    const msg = el('div', undefined, 'msg ' + (she ? 'her' : 'mine'));
    const bubble = el('div', undefined, 'bubble');
    bubble.append(el('div', bubbleText(event), 'bubble-text'));
    msg.append(bubble, el('div', timeText(event.at), 'bubble-meta'));
    list.append(msg);
  }
  if (!visible.length) empty(list, '还没有对话。她只属于一个人：在 QQ 上加她好友打个招呼。');
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function entryDate(at) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: configCache?.life?.timezone || 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(at));
}

async function refreshJournal() {
  const load = async () => {
    if (!peerId) return [];
    const scope = enc(peerId);
    if (journalSub === 'diary') {
      const events = await api(`/api/events?peer=${scope}`);
      // 日记从新到旧：夜里的她最先想被读到的是昨天的自己。
      return events
        .filter((e) => e.kind === 'diary')
        .sort((a, b) => b.at - a.at)
        .map((e) => ({
          id: e.seq,
          at: e.at,
          title: entryDate(e.at),
          body: e.data.content,
          badge:
            typeof e.data.emotion === 'number' && Math.abs(e.data.emotion) >= 0.2
              ? e.data.emotion > 0
                ? '开心的'
                : '难过的'
              : '',
        }));
    }
    if (journalSub === 'memories') {
      const memories = await api(`/api/memories?peer=${scope}`);
      const kindName = { stated: '他说的', identity: '我是谁', fact: '我的理解' };
      return memories
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((m) => ({
          id: m.id,
          at: m.createdAt,
          title: `${kindName[m.kind] ?? m.kind} · 清晰度 ${(m.detail * 100).toFixed(0)}%${m.slot ? ` · 槽位 ${m.slot}` : ''}`,
          body: m.detail >= 0.75 ? m.content : m.gist,
          badge: m.detail < 0.5 ? '细节已模糊' : '',
        }));
    }
    if (journalSub === 'thoughts') {
      const thoughts = await api(`/api/thoughts?peer=${scope}`);
      return thoughts
        .filter((t) => t.state === 'idle')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((t) => ({
          id: t.id,
          at: t.updatedAt,
          title: `想找他：${t.topic}`,
          body: t.meaning,
          badge: t.dueAt ? `期待 ${timeText(t.dueAt)}` : '等一个开口的时机',
        }));
    }
    if (journalSub === 'impressions') {
      const inner = await api(`/api/inner?peer=${scope}`);
      const beliefs = inner.impressions?.beliefs ?? [];
      return beliefs.map((b, i) => ({
        id: `imp-${i}`,
        at: inner.impressions.updatedAt ?? 0,
        title: `她对你的认识 #${i + 1}`,
        body: b.text,
        badge: '',
      }));
    }
    if (journalSub === 'works') {
      const [wall, files] = await Promise.all([
        api(`/api/wall?peer=${scope}`).catch(() => []),
        api(`/api/files?peer=${scope}`).catch(() => []),
      ]);
      const wallItems = wall.map((w) => ({
        id: w.id,
        at: w.at,
        title: w.author === peerId ? '她的作品' : '剪贴簿',
        body: w.text || '',
        badge: w.path ? '有附件' : '',
        file: w.path,
      }));
      const fileItems = files
        .filter((f) => !f.directory)
        .slice(0, 20)
        .map((f) => ({ id: `file-${f.name}`, at: 0, title: '文件', body: f.name, badge: '' }));
      return [...wallItems, ...fileItems];
    }
    const commitments = await api(`/api/commitments?peer=${scope}`);
    return commitments
      .map((c) => ({
        id: c.id,
        at: c.createdAt,
        title: `${c.kind === 'reminder' ? '约定' : c.kind === 'promise' ? '她答应的事' : '挂念'}（v${c.version}）${c.status !== 'open' ? ' · 已了结' : ''}`,
        body:
          c.content +
          (c.dueAt ? ` · ${timeText(c.dueAt)}` : '') +
          (c.recurrence ? ` · 每 ${c.recurrence.interval} ${c.recurrence.unit}` : ''),
        badge: c.status === 'open' && c.dueAt && c.dueAt <= Date.now() ? '已到时间' : '',
        open: c.status === 'open',
      }))
      .sort((a, b) => b.at - a.at);
  };
  const items = await load();
  const sig2 = journalSub + peerId + ':' + JSON.stringify(items.map((i) => [i.id, i.body]));
  if (sig2 === journalSnapshot) return;
  journalSnapshot = sig2;
  const list = $('journal-list');
  list.replaceChildren();
  if (!items.length)
    empty(
      list,
      {
        diary: '夜深时她会自己写日记。',
        memories: '还没有记下的东西。',
        thoughts: '她此刻没有存着的念头。',
        commitments: '没有挂着的约定。',
        impressions: '她还没有写下对你的认识；夜间整理轮会生成。',
        works: '墙上还没有作品。',
      }[journalSub],
    );
  for (const item of items) {
    const entry = el('div', undefined, 'row entry');
    const head = el('div', undefined, 'entry-date');
    head.append(el('span', item.title));
    if (item.badge) head.append(el('span', item.badge, 'tag'));
    entry.append(
      head,
      el('div', item.body, 'entry-body'),
      el('div', item.at ? timeText(item.at) : '', 'entry-time'),
    );
    // 约定的人工裁决：complete=她确实做到了；cancel=作废。都要双击确认。
    if (item.open) {
      const actions = el('div', undefined, 'actions');
      actions.append(
        Object.assign(el('button', '确认履约', 'btn ghost small'), {
          type: 'button',
          onclick: () =>
            resolveCommitment(item.id, 'complete', '确认她已经做到了？').then(refreshJournal),
        }),
        confirmButton('作废', '确认作废？', async () => {
          await api('/api/commitment', {
            method: 'POST',
            body: { peer: peerId, id: item.id, op: 'cancel' },
          });
          await refreshJournal();
        }),
      );
      entry.append(actions);
    }
    if (item.file) {
      const link = el('a', '下载附件', 'btn ghost small');
      link.type = 'button';
      link.href = `/api/file?peer=${enc(peerId)}&path=${enc(item.file)}`;
      entry.append(link);
    }
    list.append(entry);
  }
}

async function resolveCommitment(id, op, message) {
  // 完成履约会写一条"管理员确认"事件进她的经历：让她知道，不瞒她。
  if (!window.confirm(`${message}\n她会看到这条确认记录。`)) return;
  await api('/api/commitment', { method: 'POST', body: { peer: peerId, id, op } });
  show('已确认，她会在下一拍看到。');
}

async function refreshStickers() {
  const stickers = await api('/api/stickers');
  const sig = JSON.stringify(stickers.map((s) => [s.slug, s.description]));
  if (sig === stickersSnapshot) return;
  stickersSnapshot = sig;
  const grid = $('sticker-grid');
  grid.replaceChildren();
  if (!stickers.length) empty(grid, '目录为空。');
  for (const sticker of stickers) {
    const card = el('div', undefined, 'sticker-card');
    const img = el('img', undefined, 'sticker-img');
    img.src = `/api/sticker?slug=${enc(sticker.slug)}`;
    img.alt = sticker.description;
    img.loading = 'lazy';
    img.onerror = () => img.replaceWith(el('p', '（图片缺失）', 'hint'));
    card.append(img, el('p', sticker.description, 'sticker-desc'));
    grid.append(card);
  }
}

$('add-sticker').onclick = () =>
  perform(async () => {
    const file = $('sticker-file').files[0];
    if (!file) throw new Error('请选择一张图片');
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.readAsDataURL(file);
    });
    await api('/api/stickers', {
      method: 'POST',
      body: {
        slug: $('sticker-slug').value.trim(),
        description: $('sticker-desc').value.trim(),
        bytes: base64,
      },
    });
    $('sticker-slug').value = $('sticker-desc').value = '';
    $('sticker-file').value = '';
    stickersSnapshot = '';
    await refreshStickers();
    show('表情已入库');
  });

// ---------- 人设 ----------

function fillPersonaForm(config) {
  fillPersonaForm.done = true;
  const life = config.life ?? {};
  $('persona-text').value = config.persona ?? '';
  $('heartbeat').checked = Boolean(life.enabled);
  $('beat-minutes').value = life.beatMinutes ?? 90;
  $('sleep-start').value = minutesToHM(life.sleepStart ?? 60);
  $('sleep-end').value = minutesToHM(life.sleepEnd ?? 480);
  $('diary-hour').value = life.diaryHour ?? 23;
  $('timezone').value = life.timezone ?? 'Asia/Shanghai';
  $('turn-timeout').value = life.turnTimeoutMs ?? 300000;
  $('debounce').value = life.debounceMs ?? 700;
}
$('save-persona').onclick = () =>
  perform(async () => {
    await api('/api/config', {
      method: 'POST',
      body: {
        patch: {
          persona: $('persona-text').value,
          life: {
            enabled: $('heartbeat').checked,
            beatMinutes: Number($('beat-minutes').value),
            sleepStart: hmToMinutes($('sleep-start').value),
            sleepEnd: hmToMinutes($('sleep-end').value),
            diaryHour: Number($('diary-hour').value),
            timezone: $('timezone').value.trim(),
            turnTimeoutMs: Number($('turn-timeout').value),
            debounceMs: Number($('debounce').value),
          },
        },
      },
    });
    configCache = null;
    fillPersonaForm.done = false;
    show('已保存。她在下一拍读到新的人设与节律。');
  });

// ---------- 系统 ----------

// 手绘下拉：CSS 早已备好 .dropdown-* 全套，JS 组件随页而上。
// 值落在 host.dataset.value；选项由调用方给。
function createDropdown(id, options) {
  const host = $(id);
  host.innerHTML =
    '<div class="dropdown">' +
    '<button type="button" class="dropdown-toggle">' +
    '<span class="dropdown-label"></span><i class="dropdown-caret"></i>' +
    '</button><div class="dropdown-menu" hidden></div></div>';
  const dropdown = host.querySelector('.dropdown');
  const toggle = host.querySelector('.dropdown-toggle');
  const label = host.querySelector('.dropdown-label');
  const menu = host.querySelector('.dropdown-menu');
  let value = options[0].value;
  const set = (v) => {
    value = v;
    const opt = options.find((o) => o.value === v);
    label.textContent = opt.label;
    host.dataset.value = v;
    for (const btn of menu.children) btn.classList.toggle('selected', btn.dataset.value === v);
  };
  for (const opt of options) {
    const btn = el('button', opt.label, 'dropdown-option');
    btn.type = 'button';
    btn.dataset.value = opt.value;
    btn.onclick = () => {
      set(opt.value);
      menu.hidden = true;
      dropdown.classList.remove('open');
    };
    menu.append(btn);
  }
  toggle.onclick = () => {
    menu.hidden = !menu.hidden;
    dropdown.classList.toggle('open', !menu.hidden);
  };
  document.addEventListener('click', (event) => {
    if (!host.contains(event.target)) {
      menu.hidden = true;
      dropdown.classList.remove('open');
    }
  });
  set(value);
  return {
    get value() {
      return value;
    },
    set value(v) {
      set(v);
    },
  };
}
const FORMAT_OPTIONS = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic' },
];
const primaryFormat = createDropdown('primary-format', FORMAT_OPTIONS);
const fallbackFormat = createDropdown('fallback-format', FORMAT_OPTIONS);

function fillSystemForm(config) {
  // 轮询每 4 秒到系统页就会走到这里：无守卫的重填会把正在输入的密钥
  // 清空、正在改的地址覆盖回旧值——表单只在进面板后填一次。
  if (fillSystemForm.done) return;
  fillSystemForm.done = true;
  const primary = config.primary ?? {};
  primaryFormat.value = primary.format ?? 'openai';
  $('primary-model').value = primary.model ?? '';
  $('primary-url').value = primary.url ?? '';
  $('primary-key').value = '';
  $('primary-key-state').textContent = primary.keyConfigured ? '（已保存）' : '（未设置）';
  // 已存的密钥不回填明文，但也不能是空白——占位点告诉用户"这里有钥匙"。
  $('primary-key').placeholder = primary.keyConfigured ? '••••••••' : '';
  $('primary-vision').checked = Boolean(primary.vision);
  $('primary-temp').value = primary.temperature ?? '';
  $('primary-timeout').value = primary.timeoutMs ?? 120000;
  $('primary-output').value = primary.outputTokens ?? 4096;
  $('primary-context').value = primary.contextTokens ?? 32768;
  // 备用渠道没有独立开关：三要素齐全即接管。开关联到 url/model 是否留空。
  const fallbackActive = Boolean(config.fallback?.url && config.fallback?.model);
  $('fallback-on').checked = fallbackActive;
  $('fallback-fields').hidden = !fallbackActive;
  if (fallbackActive) {
    fallbackFormat.value = config.fallback.format ?? 'openai';
    $('fallback-model').value = config.fallback.model ?? '';
    $('fallback-url').value = config.fallback.url ?? '';
    $('fallback-key').value = '';
    $('fallback-key-state').textContent = config.fallback.keyConfigured ? '（已保存）' : '（未设置）';
    $('fallback-key').placeholder = config.fallback.keyConfigured ? '••••••••' : '';
    $('fallback-vision').checked = Boolean(config.fallback.vision);
    $('fallback-temp').value = config.fallback.temperature ?? '';
    $('fallback-timeout').value = config.fallback.timeoutMs ?? 120000;
    $('fallback-output').value = config.fallback.outputTokens ?? 4096;
    $('fallback-context').value = config.fallback.contextTokens ?? 32768;
  }
  $('web-on').checked = Boolean(config.web?.enabled);
  $('web-key').value = '';
  $('web-key-state').textContent = config.web?.keyConfigured ? '（已保存）' : '（未设置）';
  $('web-key').placeholder = config.web?.keyConfigured ? '••••••••' : '';
  const embedding = config.embedding ?? {};
  $('embedding-model').value = embedding.model ?? '';
  $('embedding-url').value = embedding.url ?? '';
  $('embedding-key').value = '';
  $('embedding-key-state').textContent = embedding.keyConfigured ? '（已保存）' : '（未设置）';
  $('embedding-key').placeholder = embedding.keyConfigured ? '••••••••' : '';
  const image = config.image ?? {};
  $('image-on').checked = Boolean(image.enabled);
  $('image-model').value = image.model ?? '';
  $('image-url').value = image.url ?? '';
  $('image-key').value = '';
  $('image-key-state').textContent = image.keyConfigured ? '（已保存）' : '（未设置）';
  $('image-key').placeholder = image.keyConfigured ? '••••••••' : '';
  const backup = config.backup ?? {};
  $('backup-on').checked = Boolean(backup.enabled);
  $('backup-fields').hidden = !backup.enabled;
  $('backup-url').value = backup.url ?? '';
  $('backup-user').value = backup.user ?? '';
  $('backup-password').value = '';
  $('backup-password-state').textContent = backup.passwordConfigured ? '（已保存）' : '（未设置）';
  $('backup-password').placeholder = backup.passwordConfigured ? '••••••••' : '';
  $('backup-hours').value = backup.intervalHours ?? 24;
  const execution = config.execution ?? {};
  $('execution-on').checked = Boolean(execution.enabled);
  $('execution-net').checked = Boolean(execution.network);
}
$('fallback-on').onchange = () => {
  $('fallback-fields').hidden = !$('fallback-on').checked;
};
$('backup-on').onchange = () => {
  $('backup-fields').hidden = !$('backup-on').checked;
};

$('save-system').onclick = () =>
  perform(async () => {
    const primary = {
      format: primaryFormat.value,
      model: $('primary-model').value.trim(),
      url: $('primary-url').value.trim(),
      vision: $('primary-vision').checked,
      timeoutMs: Number($('primary-timeout').value),
      outputTokens: Number($('primary-output').value),
      contextTokens: Number($('primary-context').value),
    };
    if ($('primary-temp').value !== '') primary.temperature = Number($('primary-temp').value);
    if ($('primary-key').value.trim()) primary.key = $('primary-key').value.trim();
    const fallbackActive = $('fallback-on').checked;
    const fallback = fallbackActive
      ? {
          format: fallbackFormat.value,
          model: $('fallback-model').value.trim(),
          url: $('fallback-url').value.trim(),
          vision: $('fallback-vision').checked,
          timeoutMs: Number($('fallback-timeout').value),
          outputTokens: Number($('fallback-output').value),
          contextTokens: Number($('fallback-context').value),
        }
      : // 关闭 = 三要素拆掉两样：密钥后端不支持清空，url/model 空了就不会接管。
        { model: '', url: '' };
    if (fallbackActive && $('fallback-key').value.trim()) fallback.key = $('fallback-key').value.trim();
    if (fallbackActive && $('fallback-temp').value !== '')
      fallback.temperature = Number($('fallback-temp').value);
    const patch = {
      primary,
      fallback,
      web: { enabled: $('web-on').checked },
      embedding: {
        model: $('embedding-model').value.trim(),
        url: $('embedding-url').value.trim(),
      },
      image: {
        enabled: $('image-on').checked,
        model: $('image-model').value.trim(),
        url: $('image-url').value.trim(),
      },
      execution: {
        enabled: $('execution-on').checked,
        network: $('execution-net').checked,
      },
      backup: {
        enabled: $('backup-on').checked,
        url: $('backup-url').value.trim(),
        user: $('backup-user').value.trim(),
        intervalHours: Number($('backup-hours').value),
      },
    };
    if ($('web-key').value.trim()) patch.web.key = $('web-key').value.trim();
    if ($('embedding-key').value.trim()) patch.embedding.key = $('embedding-key').value.trim();
    if ($('image-key').value.trim()) patch.image.key = $('image-key').value.trim();
    if ($('backup-password').value.trim()) patch.backup.password = $('backup-password').value.trim();
    await api('/api/config', { method: 'POST', body: { patch } });
    configCache = null;
    fillSystemForm.done = false;
    await refreshSystem();
    show('系统配置已保存');
  });

// ---------- 渠道体检 ----------

$('test-llm').onclick = () =>
  perform(async () => {
    const result = await api('/api/model/probe', { method: 'POST', body: { mode: 'system' } });
    show(
      result.follows
        ? '渠道连通正常，角色生效'
        : '渠道连通正常，但角色不生效：渠道丢弃了 system 提示，人设无法工作，建议更换渠道',
      !result.follows,
    );
  }, $('test-llm'));
$('test-fallback').onclick = () =>
  perform(async () => {
    const result = await api('/api/model/probe', { method: 'POST', body: { channel: 'fallback', mode: 'system' } });
    show(
      result.follows
        ? '备用渠道连通正常，角色生效'
        : '备用渠道连通正常，但角色不生效：渠道丢弃了 system 提示，人设无法工作，建议更换渠道',
      !result.follows,
    );
  }, $('test-fallback'));
$('qq-probe').onclick = () =>
  perform(async () => {
    const result = await api('/api/qq/probe', { method: 'POST', body: {} });
    const name = result.bot?.username ? `：${result.bot.username}` : '';
    show(`QQ 凭证有效${name}`);
  }, $('qq-probe'));

// ---------- 模型目录（主/备用渠道一比一） ----------

const fetchedModels = {};
const chanId = (channel, base) => `${base}-${channel}`;
$('fetch-models').onclick = () => fetchModels('primary');
$('fetch-models-fallback').onclick = () => fetchModels('fallback');
async function fetchModels(channel) {
  const body = { channel };
  const urlValue = $(channel === 'fallback' ? 'fallback-url' : 'primary-url').value.trim();
  const keyValue = $(channel === 'fallback' ? 'fallback-key' : 'primary-key').value.trim();
  if (urlValue) body.url = urlValue;
  if (keyValue) body.key = keyValue;
  body.format = channel === 'fallback' ? fallbackFormat.value : primaryFormat.value;
  const { models } = await api('/api/model/list', { method: 'POST', body });
  if (!models.length) throw new Error('渠道返回了空模型列表');
  fetchedModels[channel] = models;
  renderModelSuggestions(channel);
  $(ensureModelPanel(channel)).hidden = false;
}
function ensureModelPanel(channel) {
  const panelId = chanId(channel, 'model-suggestions');
  if ($(panelId)) return panelId;
  const panel = document.createElement('div');
  panel.id = panelId;
  panel.className = 'model-suggestions';
  panel.hidden = true;
  panel.innerHTML =
    '<div class="model-suggestions-head">' +
    `<input id="${chanId(channel, 'model-filter')}" type="search" placeholder="筛选模型名…" />` +
    `<button type="button" class="btn ghost small" id="${chanId(channel, 'model-filter-close')}">收起</button>` +
    `</div><div class="model-suggestions-list" id="${chanId(channel, 'model-suggestions-list')}"></div>`;
  $(channel === 'fallback' ? 'fallback-model' : 'primary-model').closest('.field-with-action').after(panel);
  $(chanId(channel, 'model-filter')).oninput = () => renderModelSuggestions(channel);
  $(chanId(channel, 'model-filter-close')).onclick = () => {
    panel.hidden = true;
  };
  return panelId;
}
function renderModelSuggestions(channel) {
  const panelId = ensureModelPanel(channel);
  const models = fetchedModels[channel] ?? [];
  const query = ($(chanId(channel, 'model-filter')).value || '').trim().toLowerCase();
  const filtered = query ? models.filter((m) => m.toLowerCase().includes(query)) : models;
  const list = $(chanId(channel, 'model-suggestions-list'));
  list.replaceChildren();
  if (!filtered.length) {
    list.append(el('p', '没有匹配的模型。', 'model-suggestion-empty'));
    return;
  }
  const inputId = channel === 'fallback' ? 'fallback-model' : 'primary-model';
  for (const model of filtered) {
    const item = el(
      'button',
      model,
      'model-suggestion-item' + (model === $(inputId).value ? ' current' : ''),
    );
    item.type = 'button';
    item.title = model;
    item.onclick = () => {
      $(inputId).value = model;
      $(panelId).hidden = true;
    };
    list.append(item);
  }
}

// ---------- WebDAV 备份 ----------

function backupStateText(state) {
  if (!state?.at) return '';
  if (state.ok === false) return `上次失败（${timeText(state.at)}）：${state.error ?? ''}`;
  return `上次备份：${timeText(state.at)}${state.name ? ` · ${state.name}` : ''}`;
}
function renderBackupState(state) {
  $('backup-state').textContent = backupStateText(state);
}
$('backup-now').onclick = () =>
  perform(async () => {
    const result = await api('/api/backup', { method: 'POST', body: {} });
    renderBackupState({ at: Date.now(), ok: true, name: result.name });
    show(`备份完成：${result.name}`);
  }, $('backup-now'));

async function refreshSystem() {
  const config = configCache ?? (await api('/api/config'));
  configCache = config;
  fillSystemForm(config);
  const status = await api('/api/status').catch(() => null);
  renderBackupState(status?.backup);
  const usage = await api('/api/usage?days=7').catch(() => null);
  if (!usage) return;
  const usageSig = JSON.stringify([usage.calls, usage.input, usage.output, usage.rows?.length]);
  if (usageSig === usageSnapshot) return;
  usageSnapshot = usageSig;
  const grid = $('usage-grid');
  grid.replaceChildren();
  // rows 是近 100 条明细：按天归拢，尾部合计用聚合总量（不漏 rows 之外的调用）。
  const byDay = new Map();
  for (const row of usage.rows ?? []) {
    const day = new Intl.DateTimeFormat('sv-SE', {
      timeZone: configCache?.life?.timezone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(row.at));
    const totals = byDay.get(day) ?? { calls: 0, input: 0, output: 0, cached: 0 };
    totals.calls += 1;
    totals.input += row.input ?? 0;
    totals.output += row.output ?? 0;
    totals.cached += row.cached ?? 0;
    byDay.set(day, totals);
  }
  if (!byDay.size) {
    empty(grid, '还没有模型调用。');
    return;
  }
  for (const [day, totals] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)))
    grid.append(usageDayLine(day.slice(5).replace('-', '/'), totals, false));
  grid.append(
    usageDayLine('合计', { calls: usage.calls, input: usage.input, output: usage.output, cached: usage.cached }, true),
  );
}

// ---------- 抽屉渲染 ----------

function renderIssues(issues) {
  const list = $('issues-list');
  list.replaceChildren();
  if (!issues.length) {
    empty(list, '没有待处理的事项。发送结果未知时会停在这里等确认。');
    return;
  }
  for (const envelope of issues) {
    const row = el('div', undefined, 'entry');
    row.append(
      el(
        'div',
        bubbleText({
          kind: 'accepted',
          data: envelope.part ?? {},
        }),
        'entry-body',
      ),
      el(
        'div',
        `${envelope.status === 'failed' ? '发送失败' : '发送结果未知'}${
          envelope.error ? ` · ${envelope.error}` : ''
        } · ${envelope.peer ? peerName(envelope.peer) : ''} · ${timeText(envelope.createdAt)}`,
        'entry-time',
      ),
    );
    // 已判死的件没有"可能已发出"的歧义，只留一个撤回入口；unknown 才
    // 需要人工二选一。
    if (envelope.status !== 'failed') {
      const actions = el('div', undefined, 'actions');
      actions.append(
        Object.assign(el('button', '确认已送达', 'btn ghost small'), {
          type: 'button',
          onclick: () =>
            perform(async () => {
              await api('/api/delivery', {
                method: 'POST',
                body: { id: envelope.id, accepted: true },
              });
              issuesSnapshot = '';
              await refreshStatus();
            }),
        }),
        confirmButton('确认失败', '确认失败？', async () => {
          await api('/api/delivery', { method: 'POST', body: { id: envelope.id, accepted: false } });
          issuesSnapshot = '';
          await refreshStatus();
        }),
      );
      row.append(actions);
    }
    list.append(row);
  }
}

function fillQQForm() {
  const config = configCache;
  if (!config) return;
  $('qq-appid').value = config.qq?.appId ?? '';
  $('qq-secret').value = '';
  $('qq-secret-state').textContent = config.qq?.secretConfigured ? '（已保存）' : '（未设置）';
  $('qq-secret').placeholder = config.qq?.secretConfigured ? '••••••••' : '';
  $('qq-enabled').checked = Boolean(config.qq?.enabled);
}

async function refreshDrawers() {
  const status = await api('/api/status').catch(() => null);
  if (status) {
    const qq = status.qq ?? {};
    const row = $('qq-status');
    row.replaceChildren(
      el(
        'div',
        `状态：${qq.online ? '在线' : '未在线'}${qq.session ? ' · 已登录会话' : ''}${qq.error ? `（${qq.error}）` : ''} · 会话数 ${status.peers ?? 0}`,
        'row-title',
      ),
    );
    // 绑定卡：她只属于一个人。开关直接落 /api/peer。
    peers = await api('/api/peers').catch(() => peers);
    const list = $('contact-list');
    list.replaceChildren();
    const real = peers.filter((p) => p.id !== 'c2c:preview');
    if (!real.length) {
      empty(list, '她在等第一个人来找她。');
      return;
    }
    for (const peer of real) {
      const card = el('div', undefined, 'row contact-card' + (peer.autonomous ? ' contact-bound' : ''));
      const head = el('div', undefined, 'row-title');
      const dot = el('span', undefined, 'contact-dot' + (peer.autonomous ? ' ok' : ''));
      head.append(dot, el('span', peer.name || peer.id), el('span', peer.autonomous ? '自主' : '托管', 'tag'));
      card.append(head);
      card.append(
        el(
          'p',
          peer.autonomous ? '自主开着：她会主动想、主动说。' : '托管中：只在收到消息时回应。',
          'contact-note',
        ),
      );
      const actions = el('div', undefined, 'actions');
      for (const [field, label] of [
        ['enabled', '启用'],
        ['autonomous', '自主'],
        ['activeAllowed', '主动'],
      ]) {
        const check = el('input');
        check.type = 'checkbox';
        check.checked = Boolean(peer[field]);
        const wrap = el('label', undefined, 'field-check');
        wrap.style.margin = '0';
        wrap.append(check, el('span', label));
        check.onchange = () =>
          perform(async () => {
            await api('/api/peer', {
              method: 'POST',
              body: { id: peer.id, patch: { [field]: check.checked } },
            });
            await refreshDrawers();
            show('已更新');
          });
        actions.append(wrap);
      }
      card.append(actions);
      list.append(card);
    }
  }
}

$('save-qq').onclick = () =>
  perform(async () => {
    const appId = $('qq-appid').value.trim();
    const enabled = $('qq-enabled').checked;
    if (enabled && !appId && !configCache?.qq?.appId)
      throw new Error('启用 QQ 前请填写 AppID 和 AppSecret');
    const patch = { qq: { appId, enabled } };
    if ($('qq-secret').value.trim()) patch.qq.secret = $('qq-secret').value.trim();
    await api('/api/config', { method: 'POST', body: { patch } });
    configCache = null;
    fillQQForm();
    show('已保存。网关连上后她会出现在 QQ 里。');
  }, $('save-qq'));

// ---------- 启动与断线可见性 ----------

// 会话还活着就直接进面板：刷新/重开页面不该让人重输密码。
void (async () => {
  try {
    const session = await api('/api/session');
    csrf = session.csrf;
    await enter();
  } catch {
    /* 未登录：停留登录页 */
  }
})();
