/* 留言墙 · 拉取渲染与提交；4 秒轮询跟控制台同一节奏。 */

const list = document.getElementById('notes');
const form = document.getElementById('post');
const box = document.getElementById('text');
const button = form.querySelector('button');

const timeText = (at) => {
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const hm = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `今天 ${hm}` : `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
};

function render(notes) {
  list.replaceChildren();
  if (!notes.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '墙上还没有留言，写下第一句吧。';
    list.append(empty);
    return;
  }
  for (const note of [...notes].reverse()) {
    const item = document.createElement('li');
    item.className = note.from;
    if (note.text) item.append(note.text);
    if (note.image) {
      const img = document.createElement('img');
      img.src = `/api/wall/images/${encodeURIComponent(note.image)}`;
      img.alt = '墙上的图片';
      img.loading = 'lazy';
      img.onclick = () => window.open(img.src, '_blank');
      item.append(img);
    }
    const time = document.createElement('time');
    time.textContent = `${note.from === 'her' ? '她' : '他'} · ${timeText(note.at)}`;
    item.append(time);
    list.append(item);
  }
}

async function refresh() {
  try {
    render(await fetch('/api/wall').then((res) => res.json()));
  } catch {
    /* 网络抖动，下一轮再拉 */
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = box.value.trim();
  if (!text) return;
  button.disabled = true;
  try {
    const res = await fetch('/api/wall', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? '没贴上去，稍后再试');
      return;
    }
    box.value = '';
    await refresh();
  } finally {
    button.disabled = false;
  }
});

refresh();
setInterval(refresh, 4000);
