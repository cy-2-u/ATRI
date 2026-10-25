const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const textSettings = ['model', 'baseUrl', 'timeZone', 'embeddingModel', 'embeddingBaseUrl'];
const numberSettings = [
  'contextWindowTokens',
  'inputBudgetTokens',
  'maxOutputTokens',
  'requestTimeoutSeconds',
  'turnTimeoutSeconds',
  'diaryHour',
  'quietStart',
  'quietEnd',
  'proactiveAfterHours',
  'maxConcurrentPeers',
  'debounceMs',
  'sandboxSizeMb',
  'sandboxMemoryMb',
];
const purposeName = (value) =>
  ({
    chat: '对话',
    diary: '日记',
    notes: '话题整理',
    proactive: '主动联系',
    chat_tool: '对话·工具查询',
    diary_tool: '日记·工具查询',
    notes_tool: '话题整理·工具查询',
    proactive_tool: '主动联系·工具查询',
  })[value] || value;
const formatNumber = (value) => (Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—');

let authenticated = false,
  currentTab = 'chat',
  currentPeer = 'preview:default',
  peers = [],
  personaState = { list: [], defaultId: '', bindings: {} },
  personaSelected = '',
  stickerMap = new Map(),
  lastTask = null,
  lastQr = '',
  noticeTimer,
  settingsVersion = 0,
  settingsDirtyFlag = false,
  polling = false,
  issuesSnapshot = '',
  chatSnapshot = '',
  // Message ids already pushed to the screen-reader live region. Null means
  // "first load for this contact": seed it silently instead of reading the
  // whole history aloud. An index cursor broke when messages were deleted.
  chatAnnouncedIds = null,
  chatRequestSeq = 0,
  journalSnapshot = '',
  journalRequestSeq = 0,
  peersSnapshot = '',
  peersRequestSeq = 0,
  statusRequestSeq = 0,
  peersPoll = 0,
  journalSub = 'diaries',
  journalPoll = 0,
  waitingReply = false,
  waitingBaseline = 0,
  waitingSince = 0,
  personaDirty = false,
  personaSelects = new Map(),
  formatDropdown = null,
  journalDropdown = null,
  presetDropdown = null,
  personaPresets = [];

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** Stable random id that also works outside a secure context.
 *  `crypto.randomUUID` only exists on HTTPS or localhost, so opening the admin
 *  page over a LAN address (ATRI_BIND=0.0.0.0, phone on the same network) made
 *  "send" throw an unhelpful TypeError and the trial chat unusable. */
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function button(label, handler, classes = 'ghost small') {
  const node = el('button', label, 'btn ' + classes);
  node.type = 'button';
  node.onclick = () => perform(handler, node);
  return node;
}

async function perform(action, node, { rethrow = false } = {}) {
  try {
    if (node) node.disabled = true;
    await action();
  } catch (error) {
    // Polling needs to see the failure to drive its own backoff; callers that
    // want the toast keep the default. Swallowing unconditionally made the
    // poller's own retry counter unreachable, so a server hiccup re-showed the
    // error toast on every tick and the toast timer was reset forever.
    if (rethrow) throw error;
    show(error?.message || String(error), true);
  } finally {
    if (node) node.disabled = false;
  }
}

function show(message, error = false) {
  clearTimeout(noticeTimer);
  const toast = $('notice');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  noticeTimer = setTimeout(
    () => {
      toast.hidden = true;
    },
    error ? 12000 : 6000,
  );
}

function empty(node, message) {
  node.replaceChildren(el('p', message, 'empty'));
}

function confirmButton(label, message, handler, classes = 'ghost small danger') {
  const node = button(
    label,
    async () => {
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
      await handler();
    },
    classes,
  );
  return node;
}

/** Arm-to-confirm for a static button: replaces its onclick so the handler
 *  only fires on the second tap (within 3s of the first). */
function decorateConfirm(node, message) {
  if (!node) return;
  // Keep the markup, not just the text: an icon button has no text label, and
  // restoring textContent would replace the SVG with a bare string.
  const label = node.innerHTML;
  const inner = node.onclick;
  node.onclick = (event) => {
    if (node.dataset.armed === '1') {
      node.dataset.armed = '';
      node.innerHTML = label;
      node.classList.remove('armed');
      inner?.call(node, event);
      return;
    }
    node.dataset.armed = '1';
    node.textContent = message;
    node.classList.add('armed');
    setTimeout(() => {
      if (node.dataset.armed === '1') {
        node.dataset.armed = '';
        node.innerHTML = label;
        node.classList.remove('armed');
      }
    }, 3000);
  };
}

const openDropdowns = new Set();
// One delegated outside-click listener for every dropdown. Each createDropdown
// used to add its own document listener, and the peers/persona panels recreate
// dropdowns on every poll, so those listeners accumulated for the whole page
// lifetime.
document.addEventListener('click', (event) => {
  for (const dropdown of openDropdowns) {
    if (!dropdown.root.contains(event.target)) dropdown.close();
  }
});
function createDropdown({
  options = [],
  value = '',
  onChange,
  ariaLabel = '',
  placeholder = '请选择',
}) {
  const root = el('div', undefined, 'dropdown');
  const toggle = el('button', undefined, 'dropdown-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-haspopup', 'listbox');
  toggle.setAttribute('aria-expanded', 'false');
  if (ariaLabel) toggle.setAttribute('aria-label', ariaLabel);
  const label = el('span', undefined, 'dropdown-label');
  toggle.append(label, el('span', undefined, 'dropdown-caret'));
  const menu = el('div', undefined, 'dropdown-menu');
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  root.append(toggle, menu);
  let current = value;
  let list = options;

  function renderLabel() {
    const found = list.find((o) => o.value === current);
    label.textContent = found ? found.label : placeholder;
    // A shortened label stays readable on one line; the full value is still one
    // hover away, and screen readers get it through the toggle's aria-label.
    toggle.title = found ? (found.title ?? found.label) : '';
    toggle.classList.toggle('placeholder', !found);
  }
  function renderMenu() {
    menu.replaceChildren();
    for (const opt of list) {
      const item = el(
        'button',
        undefined,
        'dropdown-option' + (opt.value === current ? ' selected' : ''),
      );
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(opt.value === current));
      item.textContent = opt.label;
      item.title = opt.title ?? opt.label;
      item.onclick = () => {
        setValue(opt.value, true);
        close();
        toggle.focus();
      };
      menu.append(item);
    }
    if (!list.length) menu.append(el('p', '暂无选项', 'dropdown-empty'));
  }
  function setValue(next, fire) {
    const changed = next !== current;
    current = next;
    renderLabel();
    if (!menu.hidden) renderMenu();
    if (fire && changed) onChange?.(current);
  }
  function open() {
    for (const d of openDropdowns) d.close();
    renderMenu();
    menu.hidden = false;
    root.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
    openDropdowns.add(api);
  }
  function close() {
    menu.hidden = true;
    root.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    openDropdowns.delete(api);
  }
  function focusCurrent() {
    const items = [...menu.querySelectorAll('.dropdown-option')];
    (items.find((i) => i.classList.contains('selected')) ?? items[0])?.focus();
  }
  toggle.onclick = () => (menu.hidden ? open() : close());
  toggle.addEventListener('keydown', (event) => {
    if (menu.hidden && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      open();
      focusCurrent();
    }
  });
  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('.dropdown-option')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[Math.min(items.length - 1, index + 1)]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[Math.max(0, index - 1)]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items.at(-1)?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // The document-level Escape handler closes drawers. Without this a
      // dropdown inside the connection drawer closed the whole drawer too.
      event.stopPropagation();
      close();
      toggle.focus();
    } else if (event.key === 'Tab') close();
  });
  renderLabel();
  const api = {
    root,
    get value() {
      return current;
    },
    set value(next) {
      setValue(next, false);
    },
    setOptions(nextOptions, nextValue) {
      list = nextOptions;
      if (nextValue !== undefined) current = nextValue;
      renderLabel();
      if (!menu.hidden) renderMenu();
    },
    close,
  };
  return api;
}

async function api(path, method = 'GET', body, timeoutMs = 30000) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError')
      throw new Error('请求超时，请稍后重试');
    throw error;
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('服务返回异常');
  }
  if (response.status === 401 && authenticated) teardownSession();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}

function clockTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function relTime(ts) {
  const date = new Date(ts);
  const now = Date.now();
  if (now - ts < 60_000) return '刚刚';
  if (now - ts < 3_600_000) return Math.floor((now - ts) / 60_000) + ' 分钟前';
  const today = new Date();
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return clockTime(ts);
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (sameDay(date, yesterday)) return '昨天 ' + clockTime(ts);
  const sameYear = date.getFullYear() === today.getFullYear();
  const monthDay = date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  return sameYear ? monthDay + ' ' + clockTime(ts) : date.toLocaleDateString('zh-CN');
}

function dayLabel(ts) {
  const date = new Date(ts);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return '今天';
  if (date.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()) return '昨天';
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(
    'zh-CN',
    sameYear
      ? { month: 'long', day: 'numeric', weekday: 'short' }
      : { year: 'numeric', month: 'long', day: 'numeric' },
  );
}

let lastDrawerOpener = null;
function openDrawer(id) {
  lastDrawerOpener = document.activeElement;
  closeDrawers();
  const backdrop = $(id);
  backdrop.hidden = false;
  backdrop.onclick = (event) => {
    if (event.target === backdrop) dismissDrawer(backdrop);
  };
  // Keyboard users used to land outside the dialog: focus its first control
  // and keep Tab cycling inside while it is open.
  const focusable = backdrop.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  (focusable[1] ?? focusable[0])?.focus();
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const open = ['drawer-connection', 'drawer-issues'].map((id) => $(id)).find((d) => !d.hidden);
  if (!open) return;
  const focusable = [...open.querySelectorAll('button, [href], input, select, textarea')].filter(
    (n) => !n.disabled && n.offsetParent !== null,
  );
  if (!focusable.length) return;
  const first = focusable[0],
    last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

// One dismiss path for every way a drawer can close. Backdrop clicks and the
// close button used to set `hidden` directly, leaving lastDrawerOpener pointing
// at a button inside a drawer that was already gone — so the next Escape press
// anywhere in the app yanked focus back to that stale bell icon.
function dismissDrawer(backdrop) {
  if (!backdrop) return;
  backdrop.hidden = true;
  if (lastDrawerOpener?.isConnected) lastDrawerOpener.focus();
  lastDrawerOpener = null;
}
function closeDrawers() {
  for (const id of ['drawer-connection', 'drawer-issues']) {
    const backdrop = $(id);
    if (!backdrop.hidden) dismissDrawer(backdrop);
  }
  // Do NOT clear lastDrawerOpener here: openDrawer() stores the trigger and
  // then calls closeDrawers() to dismiss any other drawer. Clearing it erased
  // the opener before the new drawer even opened.
}

document.querySelectorAll('[data-drawer]').forEach((b) => {
  b.onclick = () => {
    openDrawer(b.dataset.drawer);
    if (b.dataset.drawer === 'drawer-connection') perform(loadPeers);
    perform(loadStatus);
  };
});
document.querySelectorAll('[data-close]').forEach((b) => {
  b.onclick = () => dismissDrawer(b.closest('.drawer-backdrop'));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawers();
});

function renderIssues(state) {
  const issues = $('issues');
  issues.replaceChildren();
  for (const task of state.issues.tasks) {
    const row = el('div', undefined, 'card');
    const actions = el('div', undefined, 'actions');
    actions.append(
      button('重试任务', async () => {
        await api('/api/tasks/' + enc(task.id) + '/retry', 'POST');
        issuesSnapshot = '';
        await loadStatus();
      }),
      button(
        '忽略',
        async () => {
          await api('/api/tasks/' + enc(task.id) + '/dismiss', 'POST');
          issuesSnapshot = '';
          await loadStatus();
        },
        'btn ghost',
      ),
    );
    row.append(el('p', task.address + ' · ' + task.kind + '：' + task.error, 'wrap'), actions);
    issues.append(row);
  }
  for (const delivery of state.issues.deliveries) {
    const row = el('div', undefined, 'card');
    row.append(
      el('p', delivery.address + ' · ' + relTime(delivery.created_at), 'hint'),
      el('p', delivery.content, 'wrap'),
      el(
        'p',
        (delivery.status === 'uncertain' ? '送达情况不明' : '发送失败') + '：' + delivery.error,
        'hint',
      ),
    );
    const actions = el('div', undefined, 'actions');
    for (const [label, action] of [
      ['已在微信收到', 'confirmed'],
      ['跳过', 'skip'],
    ])
      actions.append(
        button(label, async () => {
          await api('/api/deliveries/' + enc(delivery.id), 'POST', { action });
          issuesSnapshot = '';
          await loadStatus();
        }),
      );
    // Two-step resend: first tap explains and arms, second tap actually
    // requeues — the old button was a dead end that only showed a hint.
    actions.append(
      confirmButton('重新发送', '确认重发？', async () => {
        await api('/api/deliveries/' + enc(delivery.id), 'POST', { action: 'retry' });
        issuesSnapshot = '';
        await loadStatus();
      }),
    );
    row.append(actions);
    issues.append(row);
  }
  if (!issues.childNodes.length) empty(issues, '目前没有需要处理的任务。一切正常。');
}

async function loadStatus() {
  const seq = ++statusRequestSeq;
  const state = await api('/api/status');
  // A slow poll finishing after a user-triggered refresh must not repaint the
  // page with older state.
  if (seq !== statusRequestSeq || !authenticated) return state;
  const online = state.wechat.status === '已连接';
  $('connection-text').textContent = online ? '微信已连接' : '微信未连接';
  $('connection').classList.toggle('online', online);
  // Primary action follows state: while connected, logout is the destructive
  // primary and re-login recedes; disconnected, login is the way forward.
  $('wechat-login').classList.toggle('primary', !online);
  $('wechat-login').classList.toggle('ghost', online);
  $('wechat-logout').classList.toggle('primary', online);
  $('wechat-logout').classList.toggle('ghost', !online);
  $('wechat-state').textContent = state.wechat.status;
  $('wechat-error').textContent =
    state.wechat.error || (!state.config.hasApiKey ? '请先在「设置」里配置模型密钥。' : '');
  if (state.wechat.qrData) {
    if (lastQr !== state.wechat.qrData) {
      $('qr').src = state.wechat.qrData;
      lastQr = state.wechat.qrData;
    }
    $('qr').hidden = false;
  } else $('qr').hidden = true;

  if (waitingReply) {
    const failed = Boolean(lastTask && state.issues.tasks.some((t) => t.id === lastTask));
    // A permanent failure never grows the assistant transcript, so the typing
    // bubble used to sit there forever. The long fallback covers a task that
    // vanished without appearing in the issue list.
    if (failed || Date.now() - waitingSince > 5 * 60000) waitingReply = false;
  }
  const issueCount = state.issues.tasks.length + state.issues.deliveries.length;
  const bell = $('issues-count');
  bell.textContent = issueCount > 99 ? '99+' : String(issueCount);
  bell.hidden = issueCount === 0;

  // Snapshot guard: the issues list re-rendered every 2.5s poll, so the button
  // a user was aiming at vanished mid-click. Rebuild only when the serialized
  // content actually changed (same pattern the chat/journal views use).
  const issuesSignature = JSON.stringify([
    state.issues.tasks.map((t) => [t.id, t.error]),
    state.issues.deliveries.map((d) => [d.id, d.status, d.error]),
  ]);
  if (issuesSignature !== issuesSnapshot) {
    issuesSnapshot = issuesSignature;
    renderIssues(state);
  }
  const stuckPeers = new Set(state.issues.deliveries.map((d) => d.peer_id));
  const states = $('peer-states');
  states.replaceChildren();
  for (const peer of state.states ?? []) {
    const row = el('div', undefined, 'row'),
      title = el('div', undefined, 'row-title');
    title.append(el('span', peer.address));
    if (stuckPeers.has(peer.peerId))
      title.append(el('span', '发送待确认，暂停回复', 'badge alert'));
    const badges = el('div', undefined, 'badge-row');
    badges.append(...moodBadges(peer.mood));
    if (peer.dueLoops) badges.append(el('span', '惦记 ' + peer.dueLoops + ' 件事', 'badge'));
    if (peer.lastProactiveAt)
      badges.append(el('span', '上次问候 ' + relTime(peer.lastProactiveAt), 'badge'));
    if (!peer.approved) badges.append(el('span', '未允许', 'badge'));
    row.append(title, badges);
    if (!badges.childNodes.length) row.append(el('p', '状态平静，暂无惦记的事。', 'hint'));
    states.append(row);
  }
  if (!states.childNodes.length) empty(states, '还没有联系人的状态可以显示。');
  renderChatBadges(stuckPeers, state.states ?? []);

  $('usage').replaceChildren(
    ...state.usage.map((u) => {
      const card = el('div', undefined, 'usage-card');
      card.append(
        el('strong', purposeName(u.purpose)),
        el('span', formatNumber(u.calls) + ' 次', 'usage-count'),
        el(
          'p',
          '输入 ' +
            formatNumber(u.input_tokens) +
            ' · 输出 ' +
            formatNumber(u.output_tokens) +
            ' token\n平均 ' +
            (u.average_ms / 1000).toFixed(2) +
            ' 秒',
        ),
      );
      return card;
    }),
  );
  if (!state.usage.length) empty($('usage'), '开始对话后，这里会记录模型调用与耗时。');
  $('recent-usage').replaceChildren(
    ...state.recentUsage.map((u) => {
      const row = el('div', undefined, 'recent-call');
      const heading = el('div');
      const time = el('time', relTime(u.created_at));
      time.dateTime = new Date(u.created_at).toISOString();
      heading.append(el('strong', purposeName(u.purpose)), time);
      // 缓存命中：供应商报告的打折前缀量。命中占比高说明渠道的前缀缓存
      // 在生效（架构按逐字节稳定前缀设计，正常聊天应看到大额命中）。
      const cached = u.cached_tokens ?? 0;
      const cacheNote =
        cached > 0 && u.input_tokens > 0
          ? ' · 缓存命中 ' + formatNumber(cached) + '（' + Math.round((cached / u.input_tokens) * 100) + '%）'
          : '';
      row.append(
        heading,
        el(
          'p',
          '入 ' +
            formatNumber(u.input_tokens) +
            ' · 出 ' +
            formatNumber(u.output_tokens) +
            cacheNote +
            ' · ' +
            (u.duration_ms / 1000).toFixed(1) +
            ' 秒',
        ),
        el('p', u.address || '已删除的对话', 'recent-address'),
      );
      return row;
    }),
  );
  if (!state.recentUsage.length) empty($('recent-usage'), '试聊一次后，这里会显示实际用量。');
  return state;
}

/** The one rendering of a mood state, shared by the peer list and chat header:
 *  they used to duplicate the thresholds, and only one of them showed why. */
function moodBadges(mood) {
  if (!mood) return [];
  const parts = [];
  if (mood.valence >= 0.3) parts.push('心情不错');
  else if (mood.valence <= -0.3) parts.push('心情低落');
  else if (mood.valence <= -0.12) parts.push('情绪平平');
  if (mood.energy <= -0.3) parts.push('有点累');
  else if (mood.energy >= 0.3) parts.push('精力足');
  if (!parts.length) return [];
  const badges = [el('span', parts.join(' · '), 'badge')];
  // Only show the cause while the state it describes still holds; a carried
  // -over reason used to print "心情不错 · 对方提到了不开心的事".
  if (mood.reason) badges.push(el('span', mood.reason, 'badge'));
  return badges;
}

function renderChatBadges(stuckPeers, states) {
  const box = $('chat-badges');
  box.replaceChildren();
  const state = states.find((s) => s.peerId === currentPeer);
  if (!state) return;
  if (stuckPeers.has(currentPeer)) box.append(el('span', '发送待确认，暂停回复', 'badge alert'));
  box.append(...moodBadges(state.mood));
  if (state.dueLoops) box.append(el('span', '惦记 ' + state.dueLoops + ' 件事', 'badge'));
  if (!state.approved) box.append(el('span', '未允许', 'badge'));
}

async function loadPeers() {
  const seq = ++peersRequestSeq;
  const loaded = await api('/api/peers');
  if (seq !== peersRequestSeq || !authenticated) return;
  peers = loaded;
  const wechatPeers = peers.filter((p) => p.channel === 'wechat');
  const previewPeer = peers.find((p) => p.id === 'preview:default');
  const signature = peers
    .map((p) => [p.id, p.address, p.approved, p.persona_id ?? ''].join(':'))
    .join('|');
  const changed = signature !== peersSnapshot;
  peersSnapshot = signature;
  if (changed) renderChatPeerList(previewPeer);
  const target = $('peers');
  if (!changed && target.childNodes.length) {
    refreshJournalPeerSelect(wechatPeers);
    return;
  }
  personaSelects.clear();
  const hadFocus = target.contains(document.activeElement);
  target.replaceChildren();
  if (!wechatPeers.length) empty(target, '扫码登录后，让朋友发来第一条微信消息。');
  for (const peer of wechatPeers) {
    const row = el('div', undefined, 'row peer-row'),
      // ID on its own line (it wraps), status badge + toggle below: mixing a
      // 40-char opaque ID with buttons in one flex row is what stretched the
      // card sideways.
      heading = el('div', undefined, 'row-title peer-name');
    heading.append(
      el('span', peer.address),
      el('span', peer.approved ? '回复中' : '未允许', 'badge'),
    );
    row.append(
      heading,
      // Pausing a peer silences her until re-approved; arm-to-confirm keeps a
      // mis-tap next to the persona dropdown from doing that silently.
      peer.approved
        ? confirmButton('暂停回复', '确认暂停？', async () => {
            await api('/api/peers/' + enc(peer.id), 'PUT', { approved: false });
            await loadPeers();
            await loadStatus();
          })
        : button('允许使用', async () => {
            await api('/api/peers/' + enc(peer.id), 'PUT', { approved: true });
            await loadPeers();
            await loadStatus();
          }),
      buildPersonaSelect(peer),
      // Hard delete: the conversation, memories, diaries, loops and tasks all go
      // with it, so the armed label spells that out instead of a bare "确认删除？".
      confirmButton(
        '删除联系人',
        '删除全部数据？',
        async () => {
          const result = await api('/api/peers/' + enc(peer.id), 'DELETE');
          // The chat panel polls by peer id, so pointing it elsewhere is what
          // stops the next tick from requesting history for a deleted peer.
          if (currentPeer === peer.id) {
            currentPeer = 'preview:default';
            chatSnapshot = '';
            await loadChat();
          }
          await loadPeers();
          await loadStatus();
          show(
            '已删除该联系人：' +
              (result.removed?.messages ?? 0) +
              ' 条消息、' +
              (result.removed?.memories ?? 0) +
              ' 条记忆及日记、惦记的事。',
          );
        },
        'ghost small danger',
      ),
    );
    target.append(row);
  }
  if (previewPeer) {
    const row = el('div', undefined, 'row peer-row'),
      heading = el('div', undefined, 'row-title');
    heading.append(el('span', '本地试聊'));
    row.append(heading, buildPersonaSelect(previewPeer));
    target.append(row);
  }
  if (hadFocus) target.querySelector('button, [aria-haspopup], input')?.focus();
  refreshJournalPeerSelect(wechatPeers);
}

/**
 * WeChat ids are `wechat:<bot>@im.bot:<openid>@im.wechat` — 40+ characters of
 * nothing readable, and the dropdown label can only show one line. Keep both
 * ends so two contacts are still distinguishable, and drop the middle.
 */
function shortAddress(address) {
  if (!address || address.length <= 22) return address;
  return address.slice(0, 11) + '…' + address.slice(-8);
}

function refreshJournalPeerSelect(wechatPeers) {
  const options = [
    { value: 'preview:default', label: '本地试聊' },
    ...wechatPeers.map((p) => ({
      value: p.id,
      label: shortAddress(p.address),
      title: p.address,
    })),
  ];
  const current = journalDropdown.value;
  journalDropdown.setOptions(
    options,
    options.some((o) => o.value === current) ? current : 'preview:default',
  );
}

function renderChatPeerList(previewPeer) {
  const list = $('chat-peer-list');
  list.replaceChildren();
  const items = [];
  if (previewPeer) items.push({ id: 'preview:default', address: '本地试聊', dot: 'preview' });
  for (const peer of peers.filter((p) => p.channel === 'wechat'))
    items.push({ id: peer.id, address: peer.address, dot: peer.approved ? 'ok' : '' });
  for (const item of items) {
    const node = el(
      'button',
      undefined,
      'peer-item' + (item.id === currentPeer ? ' selected' : ''),
    );
    node.type = 'button';
    node.append(el('span', undefined, 'peer-dot ' + item.dot), el('span', item.address));
    node.onclick = () => {
      if (currentPeer === item.id) return;
      currentPeer = item.id;
      chatSnapshot = '';
      // Reset the announce cursor too: carrying the previous contact's ids over
      // would announce a slice of the wrong conversation.
      chatAnnouncedIds = null;
      waitingReply = false;
      waitingSince = 0;
      renderChatPeerList(previewPeer);
      perform(loadChat);
    };
    list.append(node);
  }
}

function buildPersonaSelect(peer) {
  const dropdown = createDropdown({
    options: personaOptions(),
    value: personaState.list.some((p) => p.id === peer.persona_id) ? peer.persona_id : '',
    ariaLabel: '人格选择：' + peer.address,
    placeholder: '默认人格',
    onChange: (value) =>
      perform(async () => {
        await api('/api/peers/' + enc(peer.id) + '/persona', 'PUT', { personaId: value });
        personaState.bindings[peer.id] = value;
        show(
          peer.id === 'preview:default'
            ? '试聊人格已更新，下一次对话生效。'
            : '该联系人的人格已更新。',
        );
      }),
  });
  personaSelects.set(peer.id, dropdown);
  return dropdown.root;
}

function personaOptions() {
  const defaultPersona = personaState.list.find((p) => p.id === personaState.defaultId);
  return [
    { value: '', label: '默认（' + (defaultPersona?.name ?? '未设置') + '）' },
    ...personaState.list
      .filter((p) => p.id !== personaState.defaultId)
      .map((p) => ({ value: p.id, label: p.name })),
  ];
}

function refreshPersonaSelects() {
  for (const [peerId, dropdown] of personaSelects) {
    const bound = personaState.bindings[peerId] ?? '';
    dropdown.setOptions(
      personaOptions(),
      personaState.list.some((p) => p.id === bound) ? bound : '',
    );
  }
}

async function refreshStickerMap() {
  const stickers = await api('/api/stickers');
  stickerMap = new Map(stickers.map((s) => [s.description, s.slug]));
  return stickers;
}

function stickerToken(part) {
  const match = part.match(/^\[表情：([^\]]+)\]$/);
  if (!match || !stickerMap.has(match[1])) return null;
  const img = document.createElement('img');
  img.src = '/api/stickers/' + enc(stickerMap.get(match[1])) + '/image';
  img.alt = match[1];
  img.loading = 'lazy';
  return img;
}

function renderMessageContent(content) {
  const whole = content.match(/^\[表情：([^\]]+)\]$/);
  if (whole && stickerMap.has(whole[1])) {
    const img = stickerToken(content);
    img.className = 'sticker-img';
    return img;
  }
  const span = el('span');
  for (const part of content.split(/(\[表情：[^\]]+\])/g)) {
    if (!part) continue;
    const img = stickerToken(part);
    if (img) {
      img.className = 'sticker-inline';
      span.append(img);
    } else span.append(document.createTextNode(part));
  }
  return span;
}

async function loadChat() {
  const peer = currentPeer;
  const seq = ++chatRequestSeq;
  const history = await api('/api/peers/' + enc(peer) + '/history');
  if (seq !== chatRequestSeq || peer !== currentPeer) return;
  const snapshot = JSON.stringify([peer, history]);
  if (snapshot === chatSnapshot) return;
  chatSnapshot = snapshot;
  const container = $('messages');
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  // Announce only what is new. #messages used to carry aria-live itself, and
  // this function rebuilds the whole list on every 2.5s poll — so one new reply
  // made a screen reader re-read the entire conversation from the top.
  container.replaceChildren();
  if (!history.length) empty(container, '这里还没有对话。发条消息，或等她先开口。');
  let lastDay = '';
  let assistantCount = 0;
  for (const message of history) {
    const day = dayLabel(message.created_at);
    if (day !== lastDay) {
      container.append(el('div', day, 'date-sep'));
      lastDay = day;
    }
    if (message.role === 'assistant') assistantCount++;
    const mine = message.role === 'user';
    const msg = el('div', undefined, 'msg ' + (mine ? 'mine' : 'her'));
    const meta = el('div', undefined, 'bubble-meta');
    meta.append(el('span', mine ? '对方' : '亚托莉'), el('time', relTime(message.created_at)));
    const del = el('button', '删除', 'bubble-del');
    del.type = 'button';
    del.setAttribute('aria-label', '删除这条消息');
    // Arm-to-confirm, same as every other destructive action on the page. On
    // touch the button is always visible (hover is unavailable), so a single
    // stray tap permanently deleted a message with no way back.
    let armed = false;
    let armTimer = 0;
    del.onclick = async () => {
      if (!armed) {
        armed = true;
        del.textContent = '确认删除？';
        del.classList.add('armed');
        armTimer = window.setTimeout(() => {
          if (!del.isConnected) return;
          armed = false;
          del.textContent = '删除';
          del.classList.remove('armed');
        }, 3000);
        return;
      }
      window.clearTimeout(armTimer);
      armed = false;
      await perform(async () => {
        await api('/api/peers/' + enc(peer) + '/records/' + enc(message.id), 'DELETE');
        chatSnapshot = '';
        await loadChat();
      }, del);
    };
    meta.append(del);
    const bubble = el('div', undefined, 'bubble');
    bubble.append(renderMessageContent(message.content));
    msg.append(meta, bubble);
    for (const media of message.media)
      if (media.description) msg.append(el('p', '图片：' + media.description, 'media-note'));
    container.append(msg);
  }
  // Compare against the PREVIOUS baseline first: assigning it before the test
  // made the condition permanently false, so the indicator never cleared even
  // after her reply had been rendered.
  if (waitingReply && assistantCount > waitingBaseline) waitingReply = false;
  waitingBaseline = assistantCount;
  if (waitingReply) {
    const typing = el('div', undefined, 'typing');
    const dots = el('span', undefined, 'typing-dots');
    dots.append(el('i'), el('i'), el('i'));
    typing.append(dots, '她正在输入……');
    container.append(typing);
  }
  if (nearBottom) container.scrollTop = container.scrollHeight;
  // Push just the tail into the live region, keyed by message id so deletions
  // and reordering cannot shift the cursor. A null set means this is the first
  // render for the contact: seed silently rather than reading the transcript.
  const live = $('messages-live');
  if (live) {
    const seen = chatAnnouncedIds;
    const fresh = seen ? history.filter((m) => !seen.has(m.id)) : [];
    chatAnnouncedIds = new Set(history.map((m) => m.id));
    live.textContent = fresh
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join(' ');
  }
  const isPreview = peer === 'preview:default';
  $('chat-form').hidden = !isPreview;
  $('chat-title').textContent =
    peers.find((p) => p.id === peer)?.address || (isPreview ? '本地试聊' : peer);
  $('chat-sub').textContent = isPreview ? '本地试聊 · 人格生效中' : '微信联系人';
  $('chat-hint').textContent = isPreview
    ? '这里的对话不会发送到微信，用来试试她的反应。'
    : '这里查看微信记录；要交谈，直接在微信里发消息即可。';
  $('chat-input').placeholder = isPreview ? '说点什么……' : '在微信里与她交谈';
}

const chatInput = $('chat-input');
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
});
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('chat-form').requestSubmit();
  }
});
$('chat-form').onsubmit = (event) => {
  event.preventDefault();
  const content = chatInput.value.trim();
  if (!content) return;
  perform(async () => {
    const result = await api('/api/chat', 'POST', {
      content,
      eventId: uuid(),
    });
    lastTask = result.taskId;
    waitingReply = true;
    waitingSince = Date.now();
    chatInput.value = '';
    chatInput.style.height = 'auto';
    chatSnapshot = '';
    await loadChat();
    chatInput.focus();
  }, $('chat-form').querySelector('button[type="submit"]'));
};

async function loadJournal() {
  const peer = journalDropdown.value || 'preview:default';
  const seq = ++journalRequestSeq;
  const [diaries, memories, loops] = await Promise.all([
    api('/api/peers/' + enc(peer) + '/diaries'),
    api('/api/peers/' + enc(peer) + '/memories'),
    api('/api/peers/' + enc(peer) + '/loops'),
  ]);
  if (seq !== journalRequestSeq || peer !== (journalDropdown.value || 'preview:default')) return;
  const snapshot = JSON.stringify([peer, diaries, memories, loops]);
  if (snapshot === journalSnapshot) return;
  journalSnapshot = snapshot;

  const journal = $('diaries');
  journal.replaceChildren();
  let day = '';
  for (const section of diaries) {
    const row = el('div', undefined, 'row');
    if (section.day !== day) {
      row.append(el('div', section.day, 'entry-date'));
      day = section.day;
    }
    row.append(el('div', section.content, 'entry'));
    const actions = el('div', undefined, 'actions');
    actions.append(
      button('查看 ' + section.sources.length + ' 条依据', () =>
        showSources(peer, section.sources),
      ),
      confirmButton('删除这一段', '确认删除？', async () => {
        await api('/api/peers/' + enc(peer) + '/records/' + enc(section.id), 'DELETE');
        journalSnapshot = '';
        await loadJournal();
      }),
    );
    row.append(actions);
    journal.append(row);
  }
  if (!diaries.length) empty(journal, '有新的经历后，她会在设定的时间写日记。');

  const memory = $('memories');
  memory.replaceChildren();
  for (const item of memories) {
    const row = el('div', undefined, 'row');
    const badges = el('div', undefined, 'badge-row');
    badges.append(el('span', item.kind === 'stated' ? '对话中确认' : '主观理解', 'badge'));
    if (item.pinned) badges.append(el('span', '已置顶', 'badge'));
    row.append(badges, el('p', item.content));
    const actions = el('div', undefined, 'actions');
    actions.append(
      button('查看依据', () => showSources(peer, item.sources)),
      button(item.pinned ? '取消置顶' : '置顶', async () => {
        await api('/api/peers/' + enc(peer) + '/memories/' + enc(item.id) + '/pinned', 'PUT', {
          pinned: !item.pinned,
        });
        journalSnapshot = '';
        await loadJournal();
      }),
    );
    const editor = el('form', undefined, 'memory-correction');
    editor.hidden = true;
    const textarea = document.createElement('textarea');
    textarea.rows = 3;
    textarea.maxLength = 800;
    textarea.required = true;
    textarea.value = item.content;
    const editorActions = el('div', undefined, 'actions');
    editorActions.append(
      button('取消', () => (editor.hidden = true)),
      button('保存更正', async () => {
        const content = textarea.value.trim();
        if (!content) return;
        await api('/api/peers/' + enc(peer) + '/memories/' + enc(item.id), 'PUT', { content });
        journalSnapshot = '';
        await loadJournal();
      }),
    );
    editor.append(el('label', '更正为正确信息', 'hint'), textarea, editorActions);
    actions.append(
      button('更正', () => {
        editor.hidden = !editor.hidden;
        if (!editor.hidden) {
          textarea.value = item.content;
          textarea.focus();
        }
      }),
      confirmButton('删除', '确认删除？', async () => {
        await api('/api/peers/' + enc(peer) + '/records/' + enc(item.id), 'DELETE');
        journalSnapshot = '';
        await loadJournal();
      }),
    );
    row.append(actions, editor);
    memory.append(row);
  }
  if (!memories.length) empty(memory, '重要的偏好、约定和认识会留在这里。');

  const loopBox = $('loops');
  loopBox.replaceChildren();
  for (const entry of loops) {
    const thread = entry.type === 'thread';
    const row = el('div', undefined, 'row');
    let badge;
    if (entry.status !== 'open') badge = entry.status === 'resolved' ? '已了结' : '已过期';
    else if (thread) badge = entry.asked ? '问过一次' : '等合适时机';
    else badge = entry.due_at <= Date.now() ? '已到期' : '等待中';
    const badges = el('div', undefined, 'badge-row');
    badges.append(el('span', badge, 'badge'));
    if (thread) badges.append(el('span', entry.kind === 'promise' ? '答应的事' : '挂念', 'badge'));
    else if (entry.due_text || entry.dueText)
      badges.append(el('span', entry.due_text || entry.dueText, 'badge'));
    row.append(badges, el('p', entry.content));
    const actions = el('div', undefined, 'actions');
    actions.append(
      entry.status === 'open'
        ? button('了结', async () => {
            if (thread)
              await api(
                '/api/peers/' + enc(peer) + '/threads/' + enc(entry.id) + '/resolve',
                'POST',
              );
            else
              await api('/api/peers/' + enc(peer) + '/loops/' + enc(entry.id) + '/resolve', 'POST');
            journalSnapshot = '';
            await loadJournal();
          })
        : el('span', relTime(entry.resolved_at || entry.created_at), 'hint'),
    );
    row.append(actions);
    loopBox.append(row);
  }
  if (!loops.length)
    empty(
      loopBox,
      '对方提到的具体安排（比如「明天面试」）会出现在这里，到点她会主动问起；没有日期的挂念和答应过的事也会一起列出。',
    );
}

document.querySelectorAll('.subtab').forEach((tab) => {
  tab.onclick = () => {
    journalSub = tab.dataset.sub;
    document.querySelectorAll('.subtab').forEach((t) => {
      const selected = t === tab;
      t.classList.toggle('selected', selected);
      t.setAttribute('aria-selected', String(selected));
    });
    $('journal-diaries-wrap').hidden = journalSub !== 'diaries';
    $('journal-memories-wrap').hidden = journalSub !== 'memories';
    $('journal-loops-wrap').hidden = journalSub !== 'loops';
  };
});

async function showSources(peer, ids) {
  const records = await api('/api/peers/' + enc(peer) + '/sources?ids=' + enc(ids.join(',')));
  const dialog = el('dialog');
  dialog.setAttribute('aria-label', '记忆的依据');
  dialog.append(el('h2', '记忆的依据'));
  for (const record of records) {
    const row = el('div', undefined, 'row');
    const name = record.kind === 'message' ? (record.role === 'user' ? '对方' : '亚托莉') : '日记';
    row.append(
      el('p', name + ' · ' + relTime(record.created_at), 'hint'),
      el('p', record.content, 'entry'),
    );
    if (record.sources?.length)
      row.append(button('继续查看原文', () => showSources(peer, record.sources)));
    dialog.append(row);
  }
  if (!records.length) dialog.append(el('p', '相关依据已删除或失效。'));
  dialog.append(button('关闭', () => dialog.close()));
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}

$('write-diary').onclick = () =>
  perform(async () => {
    const result = await api('/api/peers/' + enc(journalDropdown.value) + '/diary', 'POST');
    show(result.taskId ? '已安排整理，稍后会显示新的日记。' : '目前没有尚未整理的经历。');
  }, $('write-diary'));

function confirmPersonaSwitch(nextId) {
  if (!personaDirty || nextId === personaSelected) return true;
  return window.confirm('人物设定有尚未保存的修改，切换后将丢失。确定要切换吗？');
}

async function loadPersonas(selectId) {
  personaState = await api('/api/personas');
  const target = $('persona-list');
  target.replaceChildren();
  if (!personaState.list.length) empty(target, '还没有人格。');
  for (const persona of personaState.list) {
    const isDefault = persona.id === personaState.defaultId;
    // The row cannot be the click target any more: it now holds a delete button,
    // and a <button> inside a <button> is invalid markup that browsers render as
    // two unfocusable siblings. So the row is a container and the name part is
    // the selection control.
    const item = el(
      'div',
      undefined,
      'persona-item' + (persona.id === personaSelected ? ' selected' : ''),
    );
    const pick = el('button', undefined, 'persona-pick');
    pick.type = 'button';
    pick.setAttribute('aria-pressed', persona.id === personaSelected ? 'true' : 'false');
    const name = el('span', undefined, 'name');
    name.textContent = persona.name;
    pick.append(name);
    if (isDefault) pick.append(el('span', ' 默认', 'tag'));
    pick.onclick = () => {
      if (!confirmPersonaSwitch(persona.id)) return;
      personaSelected = persona.id;
      loadPersonas(persona.id);
    };

    const removable = !isDefault && personaState.list.length > 1;
    if (!removable) {
      // The default persona, and the last remaining one, cannot be deleted. A
      // greyed-out button still read as "tap me later" and its tooltip was the
      // only place the rule was explained, so the slot stays empty instead and
      // the 默认 tag already says why.
      item.append(pick, el('span', undefined, 'persona-del-slot'));
      target.append(item);
      continue;
    }

    const del = el('button', undefined, 'persona-del');
    del.type = 'button';
    del.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6"/>' +
      '<path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
    del.title = '删除「' + persona.name + '」';
    del.setAttribute('aria-label', del.title);
    del.onclick = () =>
      perform(async () => {
        if (persona.id === personaSelected && !confirmPersonaSwitch('')) return;
        await api('/api/personas/' + enc(persona.id), 'DELETE');
        if (personaSelected === persona.id) personaSelected = '';
        await loadPersonas();
        show('已删除「' + persona.name + '」。');
      }, del);
    // After the handler, not before: decorateConfirm wraps whatever onclick it
    // finds, so assigning afterwards would overwrite the arm-to-confirm step
    // and a single tap would delete.
    decorateConfirm(del, '删除？');

    // The 默认 tag used to be information with no control behind it, which left
    // the server's "先设置其他人格为默认" guard telling the user to do something
    // the page could not do. Every deletable (that is, non-default) row can
    // claim the default.
    const makeDefault = el('button', undefined, 'persona-default');
    makeDefault.type = 'button';
    makeDefault.textContent = '设为默认';
    makeDefault.title = '把「' + persona.name + '」设为默认人格';
    makeDefault.onclick = () =>
      perform(async () => {
        await api('/api/personas/' + enc(persona.id) + '/default', 'PUT');
        await loadPersonas(persona.id);
        show('已把「' + persona.name + '」设为默认。');
      }, makeDefault);

    item.append(pick, makeDefault, del);
    target.append(item);
  }
  if (selectId) selectPersona(selectId);
  else if (!personaSelected && personaState.list.length)
    selectPersona(personaState.defaultId || personaState.list[0].id);
}

function selectPersona(id) {
  const persona = personaState.list.find((p) => p.id === id);
  if (!persona) return;
  personaSelected = id;
  $('persona-edit-title').textContent = '编辑：' + persona.name;
  $('persona-name').value = persona.name;
  $('persona-content').value = persona.content;
  $('persona-greeting').value = persona.greeting ?? '';
  personaDirty = false;
  countPersona();
  refreshPersonaSelects();
}

function countPersona() {
  $('persona-count').textContent =
    formatNumber($('persona-content').value.length) + ' / 12,000 字符 · 保存后下次生成生效';
}

$('persona-new').onclick = () => {
  const form = $('persona-create');
  form.hidden = !form.hidden;
  if (!form.hidden) $('persona-create-name').focus();
};
$('persona-create-cancel').onclick = () => {
  $('persona-create').hidden = true;
  $('persona-create-name').value = '';
  presetDropdown?.setOptions(
    [
      { value: '', label: '空白（自己写）' },
      ...personaPresets.map((p) => ({ value: p.id, label: `${p.name} · ${p.description}` })),
    ],
    '',
  );
};
$('persona-create').onsubmit = (event) => {
  event.preventDefault();
  perform(async () => {
    const preset = personaPresets.find((p) => p.id === presetDropdown?.value);
    const entry = await api('/api/personas', 'POST', {
      name: $('persona-create-name').value,
      content: preset?.content || '（在这里写下她是谁）',
    });
    $('persona-create').hidden = true;
    $('persona-create-name').value = '';
    presetDropdown?.setOptions(
      [
        { value: '', label: '空白（自己写）' },
        ...personaPresets.map((p) => ({ value: p.id, label: `${p.name} · ${p.description}` })),
      ],
      '',
    );
    personaSelected = entry.id;
    personaDirty = false;
    await loadPersonas(entry.id);
    show(preset ? `已从模板"${preset.name}"创建，可以继续编辑。` : '已创建，编辑内容后保存。');
  }, event.submitter);
};
const markPersonaDirty = () => {
  personaDirty = true;
  countPersona();
};
$('persona-name').oninput = markPersonaDirty;
$('persona-content').oninput = markPersonaDirty;
$('persona-greeting').oninput = markPersonaDirty;
$('persona-form').onsubmit = (event) => {
  event.preventDefault();
  perform(async () => {
    if (!personaSelected) throw new Error('请先选择要编辑的人格');
    // "留空则不发送开场白" is the documented behaviour, and a new persona starts
    // with an empty greeting — so the field must be sendable as ''.
    await api('/api/personas/' + enc(personaSelected), 'PUT', {
      name: $('persona-name').value,
      content: $('persona-content').value,
      greeting: $('persona-greeting').value,
    });
    personaDirty = false;
    await loadPersonas(personaSelected);
    show('人物设定已保存，下次生成时使用。');
  }, event.submitter);
};

async function loadStickers() {
  const stickers = await refreshStickerMap();
  const container = $('sticker-list');
  container.replaceChildren();
  for (const sticker of stickers) {
    const card = el('article', undefined, 'sticker-card'),
      img = document.createElement('img');
    img.src = '/api/stickers/' + enc(sticker.slug) + '/image';
    img.alt = sticker.description;
    img.loading = 'lazy';
    card.append(
      img,
      el('strong', sticker.slug),
      el('p', sticker.description),
      button(
        sticker.disabled ? '启用' : '停用',
        async () => {
          await api(
            '/api/stickers/' + enc(sticker.slug) + (sticker.disabled ? '/enable' : ''),
            sticker.disabled ? 'POST' : 'DELETE',
          );
          await loadStickers();
        },
        'btn ghost small',
      ),
      // Deleting an upload removes the file for good, so it gets its own verb
      // and its own confirmation instead of hiding behind 停用. Bundled stickers
      // ship with the repo and have no delete affordance at all.
      ...(sticker.custom
        ? [
            confirmButton('删除', '确认删除？', async () => {
              await api('/api/stickers/' + enc(sticker.slug) + '/file', 'DELETE');
              await loadStickers();
            }),
          ]
        : []),
    );
    container.append(card);
  }
  if (!stickers.length) empty(container, '目录还是空的。上传一张图片，教她认识第一个表情。');
}

$('sticker-form').onsubmit = (event) => {
  event.preventDefault();
  perform(async () => {
    const file = $('sticker-file').files[0];
    if (!file || file.size > 3 * 1024 * 1024) throw new Error('请选择 3 MB 以内的图片');
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    await api('/api/stickers', 'POST', {
      slug: $('sticker-slug').value,
      description: $('sticker-description').value,
      tags: $('sticker-tags')
        .value.split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
      base64,
    });
    event.target.reset();
    await loadStickers();
    show('表情已加入目录。');
  }, event.submitter);
};

async function loadSettings() {
  applySettings(await api('/api/config'));
  // Sandbox status is advisory: a failure here must not block the settings page.
  try {
    renderSandbox(await api('/api/sandbox'));
  } catch {
    const fallback = $('sandbox-status');
    fallback.replaceChildren(el('span', '沙箱状态读取失败。', 'hint'));
  }
}

function applySettings(config) {
  for (const key of [...textSettings, ...numberSettings]) $(key).value = config[key];
  formatDropdown.value = config.format;
  $('temperature').value = config.temperature ?? '';
  for (const key of [
    'vision',
    'proactiveEnabled',
    'embeddingEnabled',
    'sandboxEnabled',
    'sandboxNetwork',
  ])
    $(key).checked = config[key];
  // Ticked but inert is the confusing state: the switch only takes effect once a
  // model name AND the separate key are present, and the key deliberately does
  // not fall back to the chat key. Say so instead of leaving a checkbox that
  // claims the feature is on while nothing is ever embedded.
  const embeddingNotice = $('embedding-notice');
  if (embeddingNotice) {
    const requested = config.embeddingEnabled === true;
    const active = config.embeddingActive === true;
    embeddingNotice.hidden = !requested || active;
    embeddingNotice.textContent =
      requested && !active
        ? '已勾选但尚未生效：向量检索需要同时填写向量模型名称和独立的向量密钥，缺一项就不会调用。'
        : '';
  }
  applyKeyState(config);
  $('apiKey').value = '';
  $('tavilyKey').value = '';
  $('embeddingApiKey').value = '';
  settingsDirtyFlag = false;
  updateBudget();
}

/** Update the three secret fields' placeholders without touching any other
 *  (possibly unsaved) form control. Clearing one key used to call
 *  applySettings(), which silently discarded every other edit on the page. */
function applyKeyState(config) {
  $('apiKey').placeholder = config.hasApiKey ? '已配置，留空保持原值' : '尚未配置';
  $('tavilyKey').placeholder = config.hasTavilyKey ? '已配置，留空保持原值' : '尚未配置';
  $('embeddingApiKey').placeholder = config.hasEmbeddingApiKey
    ? '已配置，留空保持原值'
    : '独立填写，不回退到上方模型密钥';
}

function updateBudget() {
  const windowTokens = $('contextWindowTokens').valueAsNumber;
  const input = $('inputBudgetTokens').valueAsNumber;
  const output = $('maxOutputTokens').valueAsNumber;
  const used = input + output + 1024;
  const remaining = windowTokens - used;
  const complete = [windowTokens, input, output].every(Number.isFinite);
  const overBudget = complete && remaining < 0;
  $('budget-input').textContent = formatNumber(input);
  $('budget-output').textContent = formatNumber(output);
  $('budget-free').textContent = formatNumber(remaining);
  $('context-meter').max = windowTokens > 0 ? windowTokens : 1;
  $('context-meter').value = Number.isFinite(used) ? Math.max(0, used) : 0;
  $('context-meter').setAttribute(
    'aria-valuetext',
    complete
      ? '已分配 ' + formatNumber(used) + '，窗口 ' + formatNumber(windowTokens) + ' token'
      : '请填写上下文参数',
  );
  $('inputBudgetTokens').setCustomValidity(
    overBudget ? '输入预算、输出上限和 1024 token 余量之和不能超过窗口。' : '',
  );
  $('turnTimeoutSeconds').setCustomValidity(
    $('turnTimeoutSeconds').valueAsNumber < $('requestTimeoutSeconds').valueAsNumber
      ? '整轮处理超时不能短于单次请求超时。'
      : '',
  );
  $('temperature').max = formatDropdown.value === 'anthropic' ? '1' : '2';
  $('budget-note').textContent = !complete
    ? '填写窗口、输入预算和输出上限，即可查看可用空间。'
    : overBudget
      ? '超出窗口 ' + formatNumber(-remaining) + ' token，请减少输入或输出预算。'
      : '文本和图片按估算计入预算；实际用量以模型返回值为准。';
  $('context-meter').closest('.budget-card').classList.toggle('invalid', overBudget);
}

$('fetch-models').onclick = () =>
  perform(async () => {
    const list = await api('/api/models', 'GET', undefined, 60000);
    let panel = $('model-suggestions');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'model-suggestions';
      panel.className = 'model-suggestions';
      panel.hidden = true;
      panel.innerHTML =
        '<div class="model-suggestions-head">' +
        '<input id="model-filter" type="search" placeholder="筛选模型名…" />' +
        '<button type="button" class="btn ghost small" id="model-filter-close">收起</button>' +
        '</div>' +
        '<div class="model-suggestions-list" id="model-suggestions-list"></div>';
      $('model').closest('.field-with-action').after(panel);
      $('model-filter').oninput = (event) => {
        // The filter lives inside #settings-form. Letting input bubble marked
        // the whole settings form dirty while the user was only searching.
        event.stopPropagation();
        renderModelSuggestions();
      };
      $('model-filter').onkeydown = (event) => {
        // Enter in a search box must not submit the settings form.
        if (event.key === 'Enter') event.preventDefault();
      };
      $('model-filter-close').onclick = () => {
        panel.hidden = true;
      };
    }
    panel.dataset.models = JSON.stringify(list.models);
    renderModelSuggestions();
    panel.hidden = false;
    show('已拉取 ' + list.models.length + ' 个模型，点击即可填入。');
  }, $('fetch-models'));

function renderModelSuggestions() {
  const panel = $('model-suggestions');
  if (!panel) return;
  const models = JSON.parse(panel.dataset.models || '[]');
  const query = ($('model-filter').value || '').trim().toLowerCase();
  const filtered = query ? models.filter((m) => m.toLowerCase().includes(query)) : models;
  $('model-suggestions-list').replaceChildren(
    ...filtered.map((m) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'model-suggestion-item' + (m === $('model').value ? ' current' : '');
      item.textContent = m;
      item.title = m;
      item.onclick = () => {
        $('model').value = m;
        // Programmatic value assignment fires no input event, so without this
        // the picked model was never marked as an unsaved change.
        settingsChanged();
        panel.hidden = true;
      };
      return item;
    }),
  );
  if (!filtered.length) {
    const none = document.createElement('div');
    none.className = 'model-suggestion-empty';
    none.textContent = '没有匹配的模型';
    $('model-suggestions-list').append(none);
  }
}

$('test-llm').onclick = () =>
  perform(async () => {
    const result = await api('/api/test-llm', 'POST', undefined, 120000);
    show(
      '模型连通正常：' +
        result.model +
        '（' +
        result.format +
        '）· 延迟 ' +
        result.latencyMs +
        ' ms',
    );
  }, $('test-llm'));
$('test-system').onclick = () =>
  perform(async () => {
    const result = await api('/api/test-system', 'POST', undefined, 120000);
    show(
      result.ok
        ? '角色生效：该渠道支持 system 提示，人物设定可以正常工作（回复 "' + result.reply + '"）'
        : '角色不生效：该渠道丢弃了 system 提示，人物设定无法工作，建议更换渠道或模型（实际回复 "' + result.reply + '"）',
      !result.ok,
    );
  }, $('test-system'));
$('test-embedding').onclick = () =>
  perform(async () => {
    const result = await api('/api/test-embedding', 'POST', undefined, 120000);
    show(
      '向量连通正常：' +
        result.model +
        ' · 维度 ' +
        result.dims +
        ' · 延迟 ' +
        result.latencyMs +
        ' ms',
    );
  }, $('test-embedding'));

function renderSandbox(state) {
  const kb = (state.usage.bytes / 1024).toFixed(1);
  const limit = state.sizeLimitBytes ? state.sizeLimitBytes / 1024 / 1024 + ' MB' : '不限制';
  const mem = state.memoryLimitMb ? state.memoryLimitMb + ' MB' : '不限制';
  // Labeled chips instead of one long "·"-joined sentence: the old single line
  // wrapped arbitrarily at any character on narrow screens.
  const chips = [
    ['状态', state.enabled ? '已开启' : '已关闭'],
    ['文件', state.usage.files + ' 个 / ' + kb + ' KB'],
    ['大小上限', limit],
    ['内存上限', mem],
  ];
  if (state.isolation?.network) chips.push(['网络', state.isolation.network]);
  // The 隔离 chip and its paragraph-long note were removed: the level is fixed
  // by the deployment (nsjail in the container, directory-level on Windows) and
  // nothing on this page changes it, so the pair was read-once noise that took
  // over the card on a phone.
  //
  // The degraded case is different in kind, not degree — with no namespace the
  // /data volume (SQLite, API keys) is readable by any command and the network
  // switch silently does nothing — so that one keeps a warning. In production
  // the chip never appears; it only shows when isolation is actually missing.
  const degraded = state.isolation?.level === 'directory';
  $('sandbox-status').replaceChildren(
    ...chips.map(([label, value]) => {
      const chip = el('span', undefined, 'status-chip');
      chip.append(el('span', label, 'status-chip-label'), el('span', value, 'status-chip-value'));
      return chip;
    }),
    ...(degraded
      ? [
          (() => {
            const chip = el('span', undefined, 'status-chip status-chip-warn');
            chip.append(
              el('span', '隔离', 'status-chip-label'),
              el('span', '已降级：无命名空间隔离', 'status-chip-value'),
            );
            return chip;
          })(),
        ]
      : []),
  );
}
$('refresh-sandbox').onclick = () =>
  perform(async () => renderSandbox(await api('/api/sandbox')), $('refresh-sandbox'));
$('clear-sandbox').onclick = () =>
  perform(async () => {
    await api('/api/sandbox/clear', 'POST');
    renderSandbox(await api('/api/sandbox'));
    show('沙箱目录已清空。');
  }, $('clear-sandbox'));
// Destructive: stage it behind the same arm-to-confirm the journal uses, so a
// mis-tap next to 刷新状态 cannot wipe the directory.
decorateConfirm($('clear-sandbox'), '确认清空？');

for (const [id, field, input] of [
  ['clear-api-key', 'clearApiKey', 'apiKey'],
  ['clear-tavily-key', 'clearTavilyKey', 'tavilyKey'],
  ['clear-embedding-key', 'clearEmbeddingApiKey', 'embeddingApiKey'],
])
  $(id).onclick = () =>
    perform(async () => {
      const saved = await api('/api/config', 'PUT', { [field]: true });
      applyKeyState(saved);
      $(input).value = '';
      show('密钥已清除，对应服务在重新填写前不可用。');
    }, $(id));

/** The single place that writes the save state, so the in-card hint and the
 *  sticky status bar can never disagree. */
function setSettingsStatus(text) {
  $('settings-saved').textContent = text;
  const bar = $('settings-status-text');
  if (bar) bar.textContent = text;
}

function settingsChanged() {
  settingsVersion++;
  settingsDirtyFlag = true;
  setSettingsStatus('有尚未保存的修改。');
  updateBudget();
}
$('settings-form').oninput = settingsChanged;
$('settings-form').onchange = settingsChanged;
$('settings-form').onsubmit = (event) => {
  event.preventDefault();
  updateBudget();
  if (!event.target.reportValidity()) return;
  perform(async () => {
    const version = settingsVersion;
    const body = {};
    for (const key of [...textSettings, 'apiKey', 'tavilyKey', 'embeddingApiKey'])
      body[key] = $(key).value;
    body.format = formatDropdown.value;
    for (const key of numberSettings) body[key] = $(key).valueAsNumber;
    body.temperature = $('temperature').value === '' ? null : $('temperature').valueAsNumber;
    for (const key of [
      'vision',
      'proactiveEnabled',
      'embeddingEnabled',
      'sandboxEnabled',
      'sandboxNetwork',
    ])
      body[key] = $(key).checked;
    const saved = await api('/api/config', 'PUT', body);
    if (version === settingsVersion) {
      applySettings(saved);
      setSettingsStatus('已保存 · ' + new Date().toLocaleTimeString('zh-CN'));
    }
    show(
      version === settingsVersion
        ? '参数已保存，下一次生成时使用。'
        : '已保存刚才提交的参数；新修改仍需保存。',
    );
    await loadStatus();
  }, event.submitter);
};

$('backup').onclick = () =>
  perform(async () => {
    const result = await api('/api/backup', 'POST', undefined, 120000);
    show('已备份 ' + result.messages + ' 条消息，位置：' + result.directory);
  }, $('backup'));

$('wechat-login').onclick = () =>
  perform(async () => {
    await api('/api/wechat/login', 'POST');
    await loadStatus();
  }, $('wechat-login'));
$('wechat-logout').onclick = () =>
  perform(async () => {
    await api('/api/wechat/logout', 'POST');
    await loadStatus();
  }, $('wechat-logout'));
decorateConfirm($('wechat-logout'), '确认断开？');

$('login-form').onsubmit = (event) => {
  event.preventDefault();
  perform(async () => {
    await api('/api/login', 'POST', { password: $('password').value });
    $('password').value = '';
    await enter();
  }, event.submitter);
};
/** Leave the authenticated UI in a clean state for both explicit logout and a
 *  session that expired mid-request. Previously a 401 only hid the dashboard,
 *  leaving drawers, the typing indicator and cached chat state alive. */
function teardownSession() {
  authenticated = false;
  $('dashboard').hidden = true;
  $('login').hidden = false;
  $('connection-text').textContent = '管理空间';
  $('connection').classList.remove('online');
  $('notice').hidden = true;
  $('password').value = '';
  closeDrawers();
  chatSnapshot = '';
  chatAnnouncedIds = null;
  journalSnapshot = '';
  peersSnapshot = '';
  issuesSnapshot = '';
  personaSelects.clear();
  currentPeer = 'preview:default';
  settingsDirtyFlag = false;
  personaDirty = false;
  waitingReply = false;
  waitingSince = 0;
  lastTask = null;
  $('messages').replaceChildren();
}
$('logout').onclick = () =>
  perform(async () => {
    await api('/api/logout', 'POST');
    teardownSession();
    $('password').focus();
  });

/** True when the settings form holds edits that were never submitted. */
function settingsDirty() {
  return currentTab === 'settings' && settingsDirtyFlag;
}

async function selectTab(tab) {
  // Switching tabs used to discard a half-edited settings form with no warning:
  // the form only lives in the DOM, and applySettings() overwrites it from the
  // server on the next visit. Ask before throwing the edits away.
  if (tab !== currentTab && (settingsDirty() || (currentTab === 'persona' && personaDirty))) {
    const leave = window.confirm(
      currentTab === 'persona'
        ? '人物设定有尚未保存的修改，离开将会丢失。确定要离开吗？'
        : '设置里有尚未保存的修改，离开将会丢失。确定要离开吗？',
    );
    if (!leave) {
      document.querySelectorAll('[data-tab]').forEach((b) => {
        const selected = b.dataset.tab === currentTab;
        b.classList.toggle('selected', selected);
        b.setAttribute('aria-selected', String(selected));
        b.tabIndex = selected ? 0 : -1;
      });
      return;
    }
    if (currentTab === 'persona') personaDirty = false;
  }
  currentTab = tab;
  document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab));
  document.querySelectorAll('[data-tab]').forEach((b) => {
    const selected = b.dataset.tab === tab;
    b.classList.toggle('selected', selected);
    b.setAttribute('aria-selected', String(selected));
    b.tabIndex = selected ? 0 : -1;
  });
  if (tab === 'chat') await loadChat();
  if (tab === 'journal') await loadJournal();
  if (tab === 'stickers') await loadStickers();
  if (tab === 'persona') await loadPersonas(personaSelected);
  if (tab === 'settings') await loadStatus();
}

const nav = $('nav');
const mobileNav = window.matchMedia('(max-width: 960px)');
function orientNav() {
  nav.setAttribute('aria-orientation', mobileNav.matches ? 'horizontal' : 'vertical');
}
orientNav();
mobileNav.addEventListener('change', orientNav);
nav.addEventListener('keydown', (event) => {
  const tabs = [...nav.querySelectorAll('[data-tab]')];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  const previous = mobileNav.matches ? 'ArrowLeft' : 'ArrowUp';
  const next = mobileNav.matches ? 'ArrowRight' : 'ArrowDown';
  let target;
  if (event.key === previous) target = tabs[(index + tabs.length - 1) % tabs.length];
  if (event.key === next) target = tabs[(index + 1) % tabs.length];
  if (event.key === 'Home') target = tabs[0];
  if (event.key === 'End') target = tabs.at(-1);
  if (!target) return;
  event.preventDefault();
  target.focus();
  perform(() => selectTab(target.dataset.tab));
});
document.querySelectorAll('[data-tab]').forEach((b) => {
  b.onclick = () => perform(() => selectTab(b.dataset.tab));
});

formatDropdown = createDropdown({
  // All three formats the backend accepts; gemini was missing here even though
  // config validation and the request builder both support it.
  options: [
    { value: 'openai', label: 'OpenAI 兼容（含 DeepSeek）' },
    { value: 'anthropic', label: 'Anthropic Messages' },
    { value: 'gemini', label: 'Gemini' },
  ],
  value: 'openai',
  ariaLabel: '接口格式',
  onChange: () => {
    // Custom dropdowns are not native form controls, so #settings-form's
    // change listener never sees this selection.
    settingsChanged();
  },
});
$('format').append(formatDropdown.root);
journalDropdown = createDropdown({
  options: [{ value: 'preview:default', label: '本地试聊' }],
  value: 'preview:default',
  ariaLabel: '选择联系人',
  onChange: () => {
    journalSnapshot = '';
    perform(loadJournal);
  },
});
$('journal-peer').append(journalDropdown.root);

async function loadPersonaPresets() {
  personaPresets = await api('/api/persona-presets');
  const options = [
    { value: '', label: '空白（自己写）' },
    ...personaPresets.map((p) => ({ value: p.id, label: `${p.name} · ${p.description}` })),
  ];
  if (!presetDropdown) {
    presetDropdown = createDropdown({
      options,
      value: '',
      ariaLabel: '人格模板',
      placeholder: '空白（自己写）',
    });
    $('persona-preset-host').append(presetDropdown.root);
  } else presetDropdown.setOptions(options, presetDropdown.value);
}

async function enter() {
  await api('/api/config');
  authenticated = true;
  $('login').hidden = true;
  $('dashboard').hidden = false;
  $('notice').hidden = true;
  await Promise.all([loadPersonas(), loadPersonaPresets()]);
  await Promise.all([refreshStickerMap(), loadPeers(), loadSettings()]);
  await loadStatus();
  await selectTab(currentTab);
}

let pollFailures = 0;
setInterval(async () => {
  if (!authenticated || document.hidden || polling) return;
  // A short server hiccup used to re-show the error toast every tick (each
  // show() reset the 12s timer, so the toast never went away). Back off and
  // only re-toast after a run of consecutive failures.
  if (pollFailures >= 3) {
    pollFailures++;
    if (pollFailures === 8) {
      pollFailures = 0;
      show('服务器连续无响应，仍在自动重试。', true);
    }
    return;
  }
  polling = true;
  try {
    // rethrow so this catch actually runs: perform() used to swallow the error,
    // which made pollFailures unreachable and turned every hiccup into the
    // repeated-toast bug the comment above describes.
    await perform(
      async () => {
        const state = await loadStatus();
        if (lastTask) {
          const task = await api('/api/tasks/' + enc(lastTask));
          if (task.state === 'failed') {
            show(task.error + '，可在右上角铃铛里重试。', true);
            lastTask = null;
            waitingReply = false;
            waitingSince = 0;
          } else if (['done', 'superseded'].includes(task.state)) {
            lastTask = null;
            waitingReply = false;
            waitingSince = 0;
          }
        }
        if (currentTab === 'chat') await loadChat();
        if (currentTab === 'journal' && Date.now() - journalPoll >= 10000) {
          journalPoll = Date.now();
          await loadJournal();
        }
        // The connection drawer already refreshes every tick; elsewhere a
        // 10-second cadence keeps the chat peer list (and newly approved
        // contacts) from staying stale until the drawer is opened.
        if ($('drawer-connection').hidden === false) {
          await loadPeers();
          peersPoll = Date.now();
        } else if (Date.now() - peersPoll >= 10000) {
          peersPoll = Date.now();
          await loadPeers();
        }
        // Only a complete round-trip counts as healthy. Resetting this right
        // after loadStatus hid repeated failures in loadChat/loadJournal.
        pollFailures = 0;
        return state;
      },
      null,
      { rethrow: true },
    );
  } catch {
    pollFailures++;
  } finally {
    polling = false;
  }
}, 2500);

enter().catch(() => {});
