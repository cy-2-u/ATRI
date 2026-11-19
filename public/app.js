/** 管理页：她的一切。轮询用快照差分（不变不重绘），破坏性操作双击确认。 */

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;

let authenticated = false,
  currentTab = 'chat',
  journalSub = 'diary',
  configCache = null,
  statusSeq = 0,
  chatSnapshot = '',
  journalSnapshot = '',
  stickersSnapshot = '',
  sandboxSnapshot = '',
  usageSnapshot = '',
  issuesSnapshot = '',
  sandboxFilesOpen = false,
  pollTimer = 0;

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
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
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
// 微信 ID 是 40+ 字符不可读串：保留两端，两个联系人仍可区分，title 里有全名。
function shortAddress(address) {
  if (!address || address.length <= 22) return address;
  return address.slice(0, 11) + '…' + address.slice(-8);
}
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
function bubbleText(content, isShe) {
  // said 事件存的是 Bubble JSON；旧数据可能已是纯文本。
  try {
    const part = JSON.parse(content);
    if (part && typeof part === 'object' && 'type' in part)
      return part.type === 'text' ? part.text : `[${part.type === 'sticker' ? '表情' : '图片'}]`;
  } catch {
    /* 纯文本 */
  }
  return isShe ? content : content.replace(/^data:[\w./+-]+;base64,[\w+/=]+$/s, '[图片数据]');
}

// ---------- 登录 ----------

$('login-form').onsubmit = async (event) => {
  event.preventDefault();
  await perform(async () => {
    await api('/api/login', { method: 'POST', body: { password: $('password').value } });
    authenticated = true;
    fillPersonaForm.done = false;
    fillSystemForm.done = false;
    $('login').hidden = true;
    $('dashboard').hidden = false;
    // 五个视图初始都是 hidden：不点亮当前 tab，登录后就是一个空壳面板。
    selectTab(currentTab);
    startPolling();
  }, $('login-form').querySelector('button'));
};
$('logout').onclick = async () => {
  await perform(async () => {
    await api('/api/logout', { method: 'POST' });
    authenticated = false;
    $('dashboard').hidden = true;
    $('login').hidden = false;
  });
};

// ---------- 导航 ----------

for (const tab of document.querySelectorAll('#nav .nav-item')) {
  // 墙的入口是外链（无 data-tab）：新标签打开，本页不切视图。
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
  chatSnapshot = journalSnapshot = stickersSnapshot = sandboxSnapshot = usageSnapshot = '';
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

// ---------- 抽屉 ----------

// 非阻塞侧板：点开关在开/合间切换，点面板外任意处收起，Esc 全收。
// 全页遮罩是对话框的做法——这两块是随手瞟一眼的侧板，遮住页面反而碍事。
for (const opener of document.querySelectorAll('[data-drawer]')) {
  opener.onclick = (event) => {
    event.stopPropagation();
    const drawer = $(opener.dataset.drawer);
    drawer.hidden = !drawer.hidden;
    if (!drawer.hidden) refreshDrawers();
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
  // 连接状态
  const wechat = status.wechat ?? {};
  const connected = Boolean(wechat.status && /已连接/.test(wechat.status));
  // "未登录"在管理面板语境里读作管理员未登录——加主语，一眼分清
  // 这是她的连接态，不是你的登录态。
  $('connection-text').textContent = wechat.status ? `她 · ${wechat.status}` : '她 · 未上线';
  const pill = $('connection');
  const dot = pill.querySelector('.pill-dot');
  pill.classList.toggle('online', connected);
  dot?.classList.toggle('warn', !connected);
  // 待办
  const issues = await api('/api/deliveries').catch(() => []);
  const issuesSig = JSON.stringify(issues);
  if (issuesSig !== issuesSnapshot) {
    issuesSnapshot = issuesSig;
    const count = $('issues-count');
    count.hidden = !issues.length;
    count.textContent = String(issues.length);
    renderIssues(issues);
  }
  // 她此刻（对话页侧栏）
  if (currentTab === 'chat') renderSelfChips(status, config);
}

function renderSelfChips(status, config) {
  const chips = $('self-chips');
  const self = status.self ?? {};
  const mood = status.mood;
  const jobs = status.jobs ?? [];
  const channel = status.channel ?? {};
  // 队列的 kind 是内核术语，人读的是"心跳/日记"这样的钟点安排。
  const jobName = { chat: '回复', beat: '心跳', diary: '日记', tidy: '整理', reminder: '提醒' };
  const parts = [
    { label: '状态', value: self.activity || '没有在做特定的事' },
    { label: '在追', value: self.pursuit || '—' },
    {
      label: '心情',
      value: mood ? `愉悦 ${mood.valence.toFixed(2)} · 精力 ${mood.energy.toFixed(2)}` : '平静',
      sub: mood?.reason,
    },
    {
      label: '心跳',
      value: config.heartbeat ? `开 · 黏人度 ${Math.round((self.closeness ?? 0.5) * 100)}` : '关',
    },
    {
      label: '渠道',
      value:
        channel.cooldownUntil > Date.now()
          ? `主渠道冷却至 ${timeText(channel.cooldownUntil)}`
          : channel.probing
            ? '主渠道恢复探测中'
            : channel.failures
              ? `主渠道连续失败 ${channel.failures} 次`
              : '正常',
      ok: !channel.failures,
    },
    {
      label: '队列',
      value: jobs.length
        ? jobs.map((job) => `${jobName[job.kind] ?? job.kind} ${hmTime(job.due_at)}`).join(' · ')
        : '空',
    },
  ];
  const sig = JSON.stringify(parts);
  if (chips.dataset.sig === sig) return;
  chips.dataset.sig = sig;
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
  // 只拉对话本身：全量 events 会把日记、念头、failure 的内容每 4 秒拖一遍。
  const events = await api('/api/events?kinds=received,said');
  const visible = events.filter((e) => e.kind === 'received' || e.kind === 'said');
  const sig = JSON.stringify(visible.map((e) => [e.id, e.kind, e.content]));
  if (sig === chatSnapshot) return;
  chatSnapshot = sig;
  const list = $('chat-messages');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  list.replaceChildren();
  let lastDay = '';
  for (const event of visible) {
    const day = new Intl.DateTimeFormat('zh-CN', {
      timeZone: configCache?.timezone || 'Asia/Shanghai',
      month: 'long',
      day: 'numeric',
    }).format(new Date(event.created_at));
    if (day !== lastDay) {
      lastDay = day;
      list.append(el('div', day, 'date-sep'));
    }
    const she = event.kind === 'said';
    // 消息结构 = .msg（方向与宽度）> .bubble（底色圆角）+ 时间戳——
    // 此前把方向类压在 bubble 上、缺 .msg 层，气泡底色与左右对齐全丢。
    const msg = el('div', undefined, 'msg ' + (she ? 'her' : 'mine'));
    const bubble = el('div', undefined, 'bubble');
    bubble.append(el('div', bubbleText(event.content, she), 'bubble-text'));
    msg.append(bubble, el('div', timeText(event.created_at), 'bubble-meta'));
    list.append(msg);
  }
  if (!visible.length)
    empty(
      list,
      '还没有对话。她的第一句话会出现在这里——这里只读：她聊天的对象在微信那头，不在管理页里。',
    );
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function entryDate(at) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: configCache?.timezone || 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(at));
}

async function refreshJournal() {
  const load = async () => {
    if (journalSub === 'diary') {
      // 各分区只拉自己那类事件（后端 kinds 过滤）——别让一次切换拖全量。
      const events = await api('/api/events?kinds=diary');
      // 日记从新到旧：夜里的她最先想被读到的是昨天的自己。
      return events
        .sort((a, b) => b.created_at - a.created_at)
        .map((e) => {
          let content = e.content,
            emotion = null;
          try {
            const parsed = JSON.parse(e.content);
            content = parsed.content;
            emotion = parsed.emotion;
          } catch {
            /* 原样 */
          }
          return {
            id: e.id,
            at: e.created_at,
            title: entryDate(e.created_at),
            body: content,
            badge:
              emotion !== null && Math.abs(emotion) >= 0.2
                ? emotion > 0
                  ? '开心的'
                  : '难过的'
                : '',
          };
        });
    }
    if (journalSub === 'memories') {
      const memories = await api('/api/memories');
      return memories
        .filter((m) => m.status === 'active')
        .map((m) => ({
          id: m.id,
          at: m.createdAt,
          title: `${m.kind === 'stated' ? '他说的' : m.kind === 'identity' ? '我是谁' : '我的理解'} · 清晰度 ${(m.detail * 100).toFixed(0)}%${m.pinned ? ' · 钉住' : ''}`,
          body: m.detail >= 0.75 ? m.content : m.gist,
          badge: m.detail < 0.5 ? '细节已模糊' : '',
        }));
    }
    if (journalSub === 'thoughts') {
      const [thoughts, muses] = await Promise.all([
        api('/api/thoughts'),
        api('/api/events?kinds=muse'),
      ]);
      const flashes = muses.map((e) => {
        let content = e.content;
        try {
          content = JSON.parse(e.content).content;
        } catch {
          /* 原样 */
        }
        return { id: e.id, at: e.created_at, title: '一闪而过的念头', body: content, badge: '' };
      });
      const idle = thoughts
        .filter((t) => t.state === 'idle')
        .map((t) => ({
          id: t.id,
          at: t.updatedAt,
          title: `想找他：${t.topic}`,
          body: t.meaning,
          badge: '等一个开口的时机',
        }));
      return [...idle, ...flashes].sort((a, b) => b.at - a.at);
    }
    const commitments = await api('/api/commitments');
    return commitments
      .map((c) => ({
        id: c.id,
        at: c.createdAt,
        title: `${c.kind === 'reminder' ? '约定' : c.kind === 'promise' ? '她答应的事' : '挂念'}${c.state !== 'open' ? '（已了结）' : ''}`,
        body:
          c.content + (c.dueAt ? ` · ${timeText(c.dueAt)}${c.askedAt ? ' · 问过一次' : ''}` : ''),
        badge: c.state === 'open' && c.dueAt && c.dueAt <= Date.now() ? '已到时间' : '',
      }))
      .sort((a, b) => b.at - a.at);
  };
  const items = await load();
  const sig2 = journalSub + ':' + JSON.stringify(items.map((i) => [i.id, i.body]));
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
      el('div', timeText(item.at), 'entry-time'),
    );
    list.append(entry);
  }
}

async function refreshStickers() {
  const stickers = await api('/api/stickers');
  const sig = JSON.stringify(stickers.map((s) => [s.slug, s.disabled]));
  if (sig === stickersSnapshot) return;
  stickersSnapshot = sig;
  const grid = $('sticker-grid');
  grid.replaceChildren();
  if (!stickers.length) empty(grid, '目录为空。');
  for (const sticker of stickers) {
    const card = el('div', undefined, 'sticker-card' + (sticker.disabled ? ' disabled' : ''));
    const img = el('img', undefined, 'sticker-img');
    img.src = `/assets/stickers/${enc(sticker.file)}`;
    img.alt = sticker.description;
    img.loading = 'lazy';
    img.onerror = () => img.replaceWith(el('p', '（自定义文件）', 'hint'));
    card.append(img, el('p', sticker.description, 'sticker-desc'));
    const actions = el('div', undefined, 'actions');
    actions.append(
      sticker.disabled
        ? Object.assign(el('button', '启用', 'btn ghost small'), {
            type: 'button',
            onclick: () =>
              perform(() =>
                api(`/api/stickers/${enc(sticker.slug)}/enable`, { method: 'POST' }),
              ).then(refreshStickers),
          })
        : Object.assign(el('button', '停用', 'btn ghost small'), {
            type: 'button',
            onclick: () =>
              perform(() =>
                api(`/api/stickers/${enc(sticker.slug)}/disable`, { method: 'POST' }),
              ).then(refreshStickers),
          }),
    );
    if (sticker.file.startsWith('custom/'))
      actions.append(
        confirmButton('删除', '确认删除？', async () => {
          await api(`/api/stickers/${enc(sticker.slug)}`, { method: 'DELETE' });
          await refreshStickers();
        }),
      );
    card.append(actions);
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
        tags: $('sticker-tags')
          .value.split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        base64,
      },
    });
    $('sticker-slug').value = $('sticker-desc').value = $('sticker-tags').value = '';
    $('sticker-file').value = '';
    stickersSnapshot = '';
    await refreshStickers();
    show('表情已添加');
  });

// ---------- 人设 ----------

function fillPersonaForm(config) {
  fillPersonaForm.done = true;
  $('persona-text').value = config.persona ?? '';
  $('heartbeat').checked = Boolean(config.heartbeat);
  $('closeness').value = config.closeness ?? 50;
  $('sleep-start').value = minutesToHM(config.sleepStart ?? 60);
  $('sleep-end').value = minutesToHM(config.sleepEnd ?? 420);
  $('diary-hour').value = config.diaryHour ?? 3;
  $('timezone').value = config.timezone ?? 'Asia/Shanghai';
  $('turn-timeout').value = config.turnTimeoutMs ?? 180000;
  $('debounce').value = config.debounceMs ?? 800;
}
$('save-persona').onclick = () =>
  perform(async () => {
    await api('/api/config', {
      method: 'PUT',
      body: {
        persona: $('persona-text').value,
        heartbeat: $('heartbeat').checked,
        closeness: Number($('closeness').value),
        sleepStart: hmToMinutes($('sleep-start').value),
        sleepEnd: hmToMinutes($('sleep-end').value),
        diaryHour: Number($('diary-hour').value),
        timezone: $('timezone').value.trim(),
        turnTimeoutMs: Number($('turn-timeout').value),
        debounceMs: Number($('debounce').value),
      },
    });
    configCache = null;
    show('已保存。她在下一拍读到新的人设与节律。');
  });

// ---------- 系统 ----------

// 手绘下拉：CSS 早已备好 .dropdown-* 全套，JS 组件缺席——补上通用实现。
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
  { value: 'gemini', label: 'Gemini' },
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
  $('primary-url').value = primary.baseUrl ?? '';
  $('primary-key').value = '';
  $('primary-key-state').textContent = primary.hasApiKey ? '（已保存）' : '（未设置）';
  // 已存的密钥不回填明文，但也不能是空白——占位点告诉用户"这里有钥匙"。
  $('primary-key').placeholder = primary.hasApiKey ? '••••••••' : '';
  $('primary-vision').checked = Boolean(primary.vision);
  $('primary-temp').value = primary.temperature ?? '';
  $('primary-timeout').value = primary.timeoutMs ?? 45000;
  $('primary-max-tokens').value = primary.maxTokens ?? 3000;
  $('primary-retries').value = primary.retries ?? 2;
  const fallback = config.fallback;
  $('fallback-on').checked = Boolean(fallback);
  $('fallback-fields').hidden = !fallback;
  if (fallback) {
    fallbackFormat.value = fallback.format ?? 'openai';
    $('fallback-model').value = fallback.model ?? '';
    $('fallback-url').value = fallback.baseUrl ?? '';
    $('fallback-key').value = '';
    $('fallback-key-state').textContent = fallback.hasApiKey ? '（已保存）' : '（未设置）';
    $('fallback-key').placeholder = fallback.hasApiKey ? '••••••••' : '';
  }
  $('web-key').value = '';
  $('web-key-state').textContent = config.hasWebSearchKey ? '（已保存）' : '（未设置）';
  $('web-key').placeholder = config.hasWebSearchKey ? '••••••••' : '';
  const embedding = config.embedding;
  $('embedding-on').checked = Boolean(embedding);
  $('embedding-fields').hidden = !embedding;
  $('embedding-model').value = embedding?.model ?? '';
  $('embedding-url').value = embedding?.baseUrl ?? '';
  $('embedding-key').value = '';
  $('embedding-key-state').textContent = embedding?.hasApiKey ? '（已保存）' : '（未设置）';
  $('embedding-key').placeholder = embedding?.hasApiKey ? '••••••••' : '';
  const image = config.image;
  $('image-on').checked = Boolean(image);
  $('image-fields').hidden = !image;
  $('image-model').value = image?.model ?? '';
  $('image-url').value = image?.baseUrl ?? '';
  $('image-key').value = '';
  $('image-key-state').textContent = image?.hasApiKey ? '（已保存）' : '（未设置）';
  $('image-key').placeholder = image?.hasApiKey ? '••••••••' : '';
  const webdav = config.webdav;
  $('webdav-on').checked = Boolean(webdav);
  $('webdav-fields').hidden = !webdav;
  $('webdav-url').value = webdav?.url ?? '';
  $('webdav-user').value = webdav?.user ?? '';
  $('webdav-password').value = '';
  $('webdav-password-state').textContent = webdav?.hasPassword ? '（已保存）' : '（未设置）';
  $('webdav-password').placeholder = webdav?.hasPassword ? '••••••••' : '';
  const sandbox = config.sandbox ?? {};
  $('sandbox-on').checked = Boolean(sandbox.enabled);
  $('sandbox-net').checked = Boolean(sandbox.network);
  $('sandbox-size').value = sandbox.sizeLimitMb ?? 512;
  $('sandbox-memory').value = sandbox.memoryLimitMb ?? 2048;
}
$('fallback-on').onchange = () => {
  $('fallback-fields').hidden = !$('fallback-on').checked;
};
$('embedding-on').onchange = () => {
  $('embedding-fields').hidden = !$('embedding-on').checked;
};
$('image-on').onchange = () => {
  $('image-fields').hidden = !$('image-on').checked;
};
$('webdav-on').onchange = () => {
  $('webdav-fields').hidden = !$('webdav-on').checked;
};

$('save-system').onclick = () =>
  perform(async () => {
    const primary = {
      format: primaryFormat.value,
      model: $('primary-model').value.trim(),
      baseUrl: $('primary-url').value.trim(),
      vision: $('primary-vision').checked,
      timeoutMs: Number($('primary-timeout').value),
      maxTokens: Number($('primary-max-tokens').value),
      inputTokens: configCache?.primary?.inputTokens ?? 256000,
      retries: Number($('primary-retries').value),
    };
    if ($('primary-temp').value !== '') primary.temperature = Number($('primary-temp').value);
    if ($('primary-key').value.trim()) primary.apiKey = $('primary-key').value.trim();
    const body = {
      primary,
      sandbox: {
        enabled: $('sandbox-on').checked,
        network: $('sandbox-net').checked,
        sizeLimitMb: Number($('sandbox-size').value),
        memoryLimitMb: Number($('sandbox-memory').value),
        timeoutMs: configCache?.sandbox?.timeoutMs ?? 600000,
      },
    };
    if ($('fallback-on').checked) {
      const fallback = {
        format: fallbackFormat.value,
        model: $('fallback-model').value.trim(),
        baseUrl: $('fallback-url').value.trim(),
        vision: $('primary-vision').checked,
        timeoutMs: configCache?.fallback?.timeoutMs ?? primary.timeoutMs,
        maxTokens: primary.maxTokens,
        inputTokens: primary.inputTokens,
        retries: primary.retries,
      };
      if ($('fallback-key').value.trim()) fallback.apiKey = $('fallback-key').value.trim();
      body.fallback = fallback;
    } else body.fallback = null;
    if ($('web-key').value.trim()) body.webSearchKey = $('web-key').value.trim();
    if (!$('embedding-on').checked) body.embedding = null;
    else {
      // 勾着"启用"却没给模型：不静默吞掉，直接说明缺什么。
      const model = $('embedding-model').value.trim();
      if (!model) throw new Error('启用向量搜索需要填写向量模型');
      body.embedding = {
        model,
        // 留空复用主渠道：先取旧向量地址，再退主渠道地址，都没有才交给
        // 后端报错——标签说的"留空复用"要真的成立。
        baseUrl:
          $('embedding-url').value.trim() ||
          configCache?.embedding?.baseUrl ||
          configCache?.primary?.baseUrl ||
          '',
        ...($('embedding-key').value.trim() ? { apiKey: $('embedding-key').value.trim() } : {}),
      };
    }
    if (!$('image-on').checked) body.image = null;
    else {
      const model = $('image-model').value.trim();
      if (!model) throw new Error('启用画笔需要填写画图模型');
      body.image = {
        model,
        baseUrl:
          $('image-url').value.trim() ||
          configCache?.image?.baseUrl ||
          configCache?.primary?.baseUrl ||
          '',
        ...($('image-key').value.trim() ? { apiKey: $('image-key').value.trim() } : {}),
      };
    }
    // WebDAV：开关关 = 关闭备份；开着沿用旧值（密码留空保持已存的）。
    if (!$('webdav-on').checked) body.webdav = null;
    else {
      const webdavUrl = $('webdav-url').value.trim();
      if (!webdavUrl && !configCache?.webdav?.url) throw new Error('启用备份需要填写 WebDAV 地址');
      body.webdav = {
        url: webdavUrl || configCache?.webdav?.url || '',
        user: $('webdav-user').value.trim() || configCache?.webdav?.user || '',
        ...($('webdav-password').value.trim()
          ? { password: $('webdav-password').value.trim() }
          : {}),
      };
    }
    await api('/api/config', { method: 'PUT', body });
    configCache = null;
    // 保存后的重填与刚提交的值一致（协议下拉会回到"自动"），且解禁下一次
    // 填充让密钥状态行等反映新配置。
    fillSystemForm.done = false;
    await refreshSystem();
    show('系统配置已保存');
  });

// ---------- 渠道体检（v5 时代的按钮回归） ----------
// 探针失败随 200 返回 {ok:false,error}——诊断信息就是产出，不走报错兜底。

$('test-llm').onclick = () =>
  perform(async () => {
    const result = await api('/api/test-llm', { method: 'POST' });
    if (!result.ok) throw new Error(result.error);
    show(`模型连通正常：${result.model}（${result.format}）· 延迟 ${result.latencyMs} ms`);
  }, $('test-llm'));
$('test-system').onclick = () =>
  perform(async () => {
    const result = await api('/api/test-system', { method: 'POST' });
    if (result.ok === false && result.error) throw new Error(result.error);
    show(
      result.ok
        ? `角色生效：该渠道支持 system 提示，人设可以正常工作（回复“${result.reply}”）`
        : `角色不生效：该渠道丢弃了 system 提示，人设无法工作，建议更换渠道或模型（实际回复“${result.reply}”）`,
      !result.ok,
    );
  }, $('test-system'));
$('test-embedding').onclick = () =>
  perform(async () => {
    const result = await api('/api/test-embedding', { method: 'POST' });
    if (!result.ok) throw new Error(result.error);
    show(`向量连通正常：${result.model} · 维度 ${result.dims} · 延迟 ${result.latencyMs} ms`);
  }, $('test-embedding'));

// ---------- WebDAV 备份 ----------
// 备份状态跟系统表单一起刷；"立即备份"绕过每日闸门当场跑一轮。

function backupStateText(state) {
  if (!state?.configured) return '';
  if (state.error) return `上次失败（${state.failedAt ?? ''}）：${state.error}`;
  if (state.at) return `上次备份：${state.at}`;
  return '尚未备份过';
}
function renderBackupState(state) {
  $('backup-state').textContent = backupStateText(state);
}
$('backup-now').onclick = () =>
  perform(async () => {
    const state = await api('/api/backup', { method: 'POST' });
    if (state.ok === false) throw new Error(state.error || '备份失败');
    renderBackupState(state);
    show(`备份完成：atri-backup/${state.at}`);
  }, $('backup-now'));

// 拉取模型列表（v5 回归）：面板可筛选，点选填入模型框。
let fetchedModels = null;
$('fetch-models').onclick = () =>
  perform(async () => {
    const { models } = await api('/api/models');
    if (!models.length) throw new Error('渠道返回了空模型列表');
    fetchedModels = models;
    renderModelSuggestions();
    $('model-suggestions').hidden = false;
  }, $('fetch-models'));
function ensureModelPanel() {
  if ($('model-suggestions')) return;
  const panel = document.createElement('div');
  panel.id = 'model-suggestions';
  panel.className = 'model-suggestions';
  panel.hidden = true;
  panel.innerHTML =
    '<div class="model-suggestions-head">' +
    '<input id="model-filter" type="search" placeholder="筛选模型名…" />' +
    '<button type="button" class="btn ghost small" id="model-filter-close">收起</button>' +
    '</div><div class="model-suggestions-list" id="model-suggestions-list"></div>';
  $('primary-model').closest('.field-with-action').after(panel);
  $('model-filter').oninput = () => renderModelSuggestions();
  $('model-filter-close').onclick = () => {
    panel.hidden = true;
  };
}
function renderModelSuggestions() {
  ensureModelPanel();
  const panel = $('model-suggestions');
  const models = fetchedModels ?? [];
  const query = ($('model-filter').value || '').trim().toLowerCase();
  const filtered = query ? models.filter((m) => m.toLowerCase().includes(query)) : models;
  const list = $('model-suggestions-list');
  list.replaceChildren();
  if (!filtered.length) {
    list.append(el('p', '没有匹配的模型。', 'model-suggestion-empty'));
    return;
  }
  for (const model of filtered) {
    const item = el(
      'button',
      model,
      'model-suggestion-item' + (model === $('primary-model').value ? ' current' : ''),
    );
    item.type = 'button';
    item.title = model;
    item.onclick = () => {
      $('primary-model').value = model;
      panel.hidden = true;
    };
    list.append(item);
  }
}

async function refreshSystem() {
  const config = configCache ?? (await api('/api/config'));
  configCache = config;
  fillSystemForm(config);
  renderBackupState(await api('/api/backup').catch(() => null));
  // 沙箱实况与文件
  const sandbox = await api('/api/sandbox').catch(() => null);
  if (sandbox) {
    const state = sandbox.enabled
      ? `${sandbox.level === 'nsjail' ? 'nsjail 命名空间隔离' : '目录模式'} · ${sandbox.network} · 已用 ${(sandbox.usage.bytes / 1024 / 1024).toFixed(1)} MB / ${sandbox.sizeLimit ? (sandbox.sizeLimit / 1024 / 1024).toFixed(0) + ' MB' : '不限'}`
      : '未启用——她没有手，做不了需要动手的事。';
    const sig = state + JSON.stringify(config.sandbox);
    if (sig !== sandboxSnapshot) {
      sandboxSnapshot = sig;
      $('sandbox-state').textContent = state;
      const files = sandbox.enabled
        ? await api('/api/sandbox/files?path=.').catch(() => null)
        : null;
      const list = $('sandbox-files');
      list.replaceChildren();
      if (files?.entries?.length) {
        // 工作目录默认折叠：她的房间在侧栏只是一行标题，点开才铺文件。
        const title = el('p', `工作目录（${files.entries.length} 项）`, 'side-title file-toggle');
        const render = () => {
          for (const row of [...list.querySelectorAll('.row')]) row.remove();
          if (!sandboxFilesOpen) return;
          for (const file of files.entries.slice(0, 20))
            list.append(
              el(
                'div',
                `${file.kind === 'dir' ? '📁' : '📄'} ${file.name}${file.size ? `（${file.size} B）` : ''}`,
                'row',
              ),
            );
        };
        title.textContent = `工作目录（${files.entries.length} 项）${sandboxFilesOpen ? ' ▾' : ' ▸'}`;
        title.onclick = () => {
          sandboxFilesOpen = !sandboxFilesOpen;
          title.textContent = `工作目录（${files.entries.length} 项）${sandboxFilesOpen ? ' ▾' : ' ▸'}`;
          render();
        };
        list.append(title);
        render();
      }
    }
  }
  const usage = await api('/api/usage?days=7');
  const usageSig = JSON.stringify(usage);
  if (usageSig !== usageSnapshot) {
    usageSnapshot = usageSig;
    const grid = $('usage-grid');
    grid.replaceChildren();
    // 按天一行（API 本来就带 day 维度，此前二次聚合成一条"主渠道"把
    // 她每天的思考量全部抹平了）；尾部合计。
    const byDay = new Map();
    for (const row of usage) {
      const totals = byDay.get(row.day) ?? { calls: 0, input: 0, output: 0, cached: 0 };
      totals.calls += row.calls;
      totals.input += row.input;
      totals.output += row.output;
      totals.cached += row.cached;
      byDay.set(row.day, totals);
    }
    if (!byDay.size) {
      empty(grid, '还没有模型调用。');
    } else {
      const grand = { calls: 0, input: 0, output: 0, cached: 0 };
      for (const [day, totals] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
        grand.calls += totals.calls;
        grand.input += totals.input;
        grand.output += totals.output;
        grand.cached += totals.cached;
        grid.append(usageDayLine(day.slice(5).replace('-', '/'), totals, false));
      }
      grid.append(usageDayLine('合计', grand, true));
    }
  }
  const embeddings = await api('/api/embeddings').catch(() => null);
  $('embeddings-state').textContent = embeddings?.model
    ? `语义召回：${embeddings.model}，待补向量 ${embeddings.pending} 条（每 5 分钟自动滴灌）`
    : '语义召回未启用——词面（bigram）召回在工作。';
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
        bubbleText(
          envelope.part.text ??
            (envelope.part.slug ? `[表情]` : `[图片 ${envelope.part.path ?? ''}]`),
          true,
        ),
        'entry-body',
      ),
      el(
        'div',
        `${envelope.status === 'failed' ? '发送失败' : '发送结果未知'}${
          envelope.lastError ? ` · ${envelope.lastError}` : ''
        } · ${timeText(envelope.created_at)}`,
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
              await api(`/api/deliveries/${enc(envelope.id)}/resolve`, {
                method: 'POST',
                body: { status: 'sent' },
              });
              issuesSnapshot = '';
              await refreshStatus();
            }),
        }),
        confirmButton('确认失败', '确认失败？', async () => {
          await api(`/api/deliveries/${enc(envelope.id)}/resolve`, {
            method: 'POST',
            body: { status: 'failed' },
          });
          issuesSnapshot = '';
          await refreshStatus();
        }),
      );
      row.append(actions);
    }
    list.append(row);
  }
}

async function refreshDrawers() {
  const status = await api('/api/wechat/status').catch(() => null);
  if (status) {
    const row = $('wechat-status');
    const head = el('div', undefined, 'row-title');
    head.append(
      el(
        'span',
        `状态：${status.status}${status.error ? `（${status.error}）` : ''}${status.lastPollAt ? ` · 最近轮询 ${timeText(status.lastPollAt)}` : ''}`,
      ),
    );
    row.replaceChildren(head);
    const qr = $('wechat-qr');
    qr.replaceChildren();
    // 没二维码就整框藏起：白底圆角的空壳悬在状态行下面，看着像一个坏掉的输入框。
    qr.hidden = !status.qrData;
    if (status.qrData) {
      const img = el('img');
      img.alt = '微信扫码';
      img.src = status.qrData;
      qr.append(img);
    }
  }
  const contacts = await api('/api/wechat/contacts').catch(() => []);
  const list = $('contact-list');
  list.replaceChildren();
  if (!contacts.length) {
    empty(list, '还没有联系人出现。让 TA 给这个账号发一条消息。');
    return;
  }
  // 她只属于一个人：这里不是联系人列表，是一张关系卡——敲门中是等待，
  // 已绑定是名分。
  for (const contact of contacts) {
    const card = el(
      'div',
      undefined,
      'row contact-card' + (contact.approved ? ' contact-bound' : ''),
    );
    const head = el('div', undefined, 'row-title');
    const dot = el('span', undefined, 'contact-dot' + (contact.approved ? ' ok' : ''));
    const name = el('span', shortAddress(contact.address));
    name.title = contact.address;
    head.append(dot, name, el('span', contact.approved ? '已绑定' : '敲门中', 'tag'));
    card.append(head);
    card.append(
      el(
        'p',
        contact.approved
          ? '她只属于这一个人——对话、记忆与约定，都只与你进行。'
          : '有人来找她说话。批准后，她的世界就只有这一个人。',
        'contact-note',
      ),
    );
    if (!contact.approved) {
      const actions = el('div', undefined, 'actions');
      const approve = el('button', '允许使用', 'btn primary small');
      approve.type = 'button';
      approve.onclick = () =>
        perform(async () => {
          await api('/api/wechat/approve', { method: 'POST', body: { address: contact.address } });
          await refreshDrawers();
          show('已绑定。她会在十分钟内开口。');
        }, approve);
      actions.append(approve);
      card.append(actions);
    }
    list.append(card);
  }
}

$('wechat-login').onclick = () =>
  perform(async () => {
    await api('/api/wechat/login', { method: 'POST' });
    show('二维码生成中，几秒后刷新这里。');
    setTimeout(refreshDrawers, 3000);
    // 扫码窗口 5 分钟：人走了或一直没扫就停轮询，别让观察者永远空转。
    const started = Date.now();
    const watch = setInterval(async () => {
      if (Date.now() - started > 5 * 60_000) return clearInterval(watch);
      const status = await api('/api/wechat/status').catch(() => null);
      if (!status) return clearInterval(watch);
      if (status.status === '已连接') {
        clearInterval(watch);
        await refreshDrawers();
        show('她上线了。');
      } else if (status.status?.includes('过期') || status.status?.includes('失败'))
        clearInterval(watch);
      else await refreshDrawers();
    }, 4000);
  });
$('wechat-logout').onclick = () =>
  perform(async () => {
    await api('/api/wechat/logout', { method: 'POST' });
    await refreshDrawers();
  });

// ---------- 启动与断线可见性 ----------

// 会话还活着就直接进面板：刷新/重开页面不该让人重输密码。
void (async () => {
  try {
    configCache = await api('/api/config');
    authenticated = true;
    fillPersonaForm.done = false;
    fillSystemForm.done = false;
    $('login').hidden = true;
    $('dashboard').hidden = false;
    selectTab(currentTab);
    startPolling();
  } catch {
    /* 未登录：停留登录页 */
  }
})();
