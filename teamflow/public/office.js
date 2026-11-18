/* Virtual office: live map, avatars, room panel, reactions. Loaded before app.js; uses its globals at call time. */
'use strict';

const AVATARS = ['🙂', '😎', '🤓', '🥳', '😺', '🐶', '🦊', '🐼', '🦁', '🐯', '🐸', '🐵', '🦄', '🐙', '🦉', '🐧',
  '🤖', '👻', '👽', '🧑‍💻', '👩‍💻', '🧑‍🎨', '🦸', '🧙', '🧑‍🚀', '🍕', '🌵', '🚀', '⚡', '🌈'];
const STATUSES = [['🎧', 'Focus mode'], ['☕', 'Coffee break'], ['🍽️', 'Lunch'], ['🗣️', 'In a call'], ['🌴', 'Away'], ['', 'Clear status']];
const DECOR = {
  work: [['🖥️', 20, 52], ['🖥️', 50, 52], ['🖥️', 80, 52], ['🖥️', 20, 80], ['🖥️', 50, 80], ['🖥️', 80, 80], ['🪴', 92, 24]],
  meeting: [['📺', 50, 30], ['🪑', 28, 58], ['🪑', 72, 58], ['🪑', 28, 82], ['🪑', 72, 82], ['📊', 90, 26]],
  break: [['☕', 22, 55], ['🛋️', 55, 74], ['🪴', 90, 28], ['🍪', 78, 52], ['🏓', 24, 82]],
  lobby: [['🪴', 10, 30], ['🛎️', 52, 24], ['🛋️', 86, 80], ['🪴', 92, 28]],
  private: [['📚', 86, 28], ['🖥️', 52, 52], ['🪴', 14, 80]],
  custom: [['🪴', 90, 28]],
};

const office = {
  ws: null, users: new Map(), rooms: [], me: null, feed: [], reactions: ['👋', '👏', '🎉', '❤️', '😂', '🔥', '☕', '👍'],
  keys: new Set(), target: null, scale: 1, loop: null, panelId: null, att: { state: 'not_in' },
  retry: 0, lastSent: 0, wasMoving: false, closed: false, connected: false, refreshTimer: null,
};

/* ------------------------------------------------------------ connection */
function officeConnect() {
  office.closed = false;
  if (office.ws && office.ws.readyState <= 1) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  office.ws = ws;
  ws.onopen = () => { office.retry = 0; office.connected = true; renderHeader(); };
  ws.onmessage = (e) => { try { officeMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => {
    office.connected = false; office.users.clear(); renderAvatars(); renderHeader();
    if (!office.closed && state.me) setTimeout(officeConnect, Math.min(10000, 1000 * 2 ** office.retry++));
  };
}
function officeDisconnect() {
  office.closed = true; office.panelId = null;
  if (office.ws) office.ws.close();
  office.users.clear();
}
const wsSend = (o) => { if (office.ws && office.ws.readyState === 1) office.ws.send(JSON.stringify(o)); };

function officeMsg(m) {
  const u = office.users.get(m.id);
  switch (m.t) {
    case 'hello':
      office.me = m.you; office.users = new Map(m.users.map((x) => [x.id, x]));
      office.feed = m.feed || []; if (m.reactions) office.reactions = m.reactions;
      renderAvatars(); renderHeader(); renderFeed(); renderReactBar(); break;
    case 'join': office.users.set(m.user.id, m.user); addAvatar(m.user); renderHeader(); updateRoomCounts(); break;
    case 'leave': office.users.delete(m.id); { const el = avEl(m.id); if (el) el.remove(); } renderHeader(); updateRoomCounts(); break;
    case 'move':
      if (!u) break;
      u.room_id = m.room_id;
      if (m.id !== office.me) { u.x = m.x; u.y = m.y; placeAvatar(u); }
      updateRoomCounts(); renderHeader(); break;
    case 'status': if (u) { u.status_emoji = m.status_emoji; u.status_text = m.status_text; redrawAvatar(u); } break;
    case 'profile': if (u) { Object.assign(u, m); redrawAvatar(u); } break;
    case 'att': if (u) { u.att = m.state; redrawAvatar(u); } if (m.id === state.me.id) { office.att.state = m.state; renderHeader(); } break;
    case 'react': floatOn(m.id, m.emoji); break;
    case 'chat':
      bubbleOn(m.id, m.body);
      if (office.panelId === m.room_id) appendChat(m);
      break;
    case 'feed': office.feed.push(m); office.feed = office.feed.slice(-30); renderFeed(); break;
    case 'toast': toast(`${m.icon || '🔔'} ${m.text}`); break;
    case 'celebrate': confetti(); toast(`🎉 ${m.name} completed "${m.title}"`); break;
    case 'wave': toast(`👋 ${m.from} waved at you!`); { const el = avEl(office.me); if (el) { el.classList.add('wave'); setTimeout(() => el.classList.remove('wave'), 1200); } } break;
    case 'tasks_changed': clearTimeout(office.refreshTimer); office.refreshTimer = setTimeout(onTasksChanged, 400); break;
    case 'rooms_changed': onRoomsChanged(); break;
    default:
  }
}

function onTasksChanged() {
  const a = document.activeElement;
  if (office.panelId && !$('#roomPanel').classList.contains('hidden')) openRoomPanel(office.panelId, true);
  if (a && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) return;
  if (['home', 'tasks', 'team'].includes(state.route) && !$('#modal-root').children.length) loadView(true);
}
async function onRoomsChanged() {
  try { office.rooms = await api('/rooms'); state.rooms = office.rooms; } catch (e) { return; }
  if ($('#world')) { renderRooms(); renderHeader(); }
  if (office.panelId && !$('#roomPanel').classList.contains('hidden')) openRoomPanel(office.panelId, true);
}

/* ---------------------------------------------------------------- helpers */
const avEl = (id) => document.querySelector(`.av[data-id="${id}"]`);
function roomAtLocal(x, y) {
  let best = null;
  for (const r of office.rooms) if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h && (!best || r.w * r.h < best.w * best.h)) best = r;
  return best;
}
const meUser = () => office.users.get(office.me);
const roomName = (id) => (office.rooms.find((r) => r.id === id) || {}).name;

/* ------------------------------------------------------------------- view */
async function viewOffice(v, silent) {
  const [rooms, att] = await Promise.all([api('/rooms'), api('/attendance/me')]);
  office.rooms = rooms; state.rooms = rooms; office.att = att;
  if (silent && $('#world')) { renderRooms(); renderHeader(); return; }
  v.innerHTML = `
  <div class="card office-head" id="officeHead"></div>
  <div class="map-wrap" id="mapWrap"><div class="world" id="world"><div id="roomsLayer"></div><div id="avatarsLayer"></div></div></div>
  <div class="muted small" style="margin:8px 2px">Click the floor to walk · arrow keys / WASD also work · click a <b>room name</b> for its info · click a <b>person</b> to say hi 👋</div>
  <div class="office-foot">
    <div class="card"><h2>Reactions</h2><div class="react-bar" id="reactBar"></div></div>
    <div class="card"><h2>Office activity</h2><div id="feed" class="feed"></div></div>
  </div>
  <aside id="roomPanel" class="room-panel hidden"></aside>`;
  $('#world').onclick = worldClick;
  renderRooms(); renderAvatars(); renderHeader(); renderFeed(); renderReactBar(); fitWorld(); startLoop();
  if (office.panelId) openRoomPanel(office.panelId, true);
}

function fitWorld() {
  const wrap = $('#mapWrap'); if (!wrap) return;
  office.scale = Math.min(1.25, wrap.clientWidth / 1000);
  $('#world').style.transform = `scale(${office.scale})`;
  wrap.style.height = Math.round(640 * office.scale) + 'px';
}
window.addEventListener('resize', fitWorld);

function renderHeader() {
  const h = $('#officeHead'); if (!h) return;
  const me = meUser(); const r = me && roomAtLocal(me.x, me.y);
  const st = office.att.state;
  const stText = { not_in: 'Not punched in', working: 'Working', on_break: 'On break', done: 'Day complete' }[st];
  const btns = {
    not_in: '<button class="btn green sm" data-p="punch-in">▶ Punch in</button>',
    working: '<button class="btn sm" data-p="break-start">☕ Break</button><button class="btn red sm" data-p="punch-out">⏹ Punch out</button>',
    on_break: '<button class="btn primary sm" data-p="break-end">▶ End break</button><button class="btn red sm" data-p="punch-out">⏹ Punch out</button>',
    done: '',
  }[st];
  h.innerHTML = `
    <div class="oh-where"><span class="oh-ico">${r ? esc(r.icon) : '🚪'}</span>
      <div><b>${r ? esc(r.name) : 'Hallway'}</b>
      <div class="muted small">${office.connected ? `<i class="live"></i>${office.users.size} online` : 'Reconnecting…'}</div></div></div>
    <div class="oh-actions">
      <span class="state-pill state-${st}">${stText}</span>${btns}
      <button class="btn sm" id="meBtn">${esc(state.me.avatar || '🙂')} Me</button>
    </div>`;
  $$('[data-p]', h).forEach((b) => (b.onclick = async () => {
    try { b.disabled = true; office.att = await api(`/attendance/${b.dataset.p}`, { method: 'POST', body: {} }); renderHeader(); }
    catch (e) { fail(e); b.disabled = false; }
  }));
  $('#meBtn').onclick = profileModal;
}

/* ------------------------------------------------------------------ rooms */
function renderRooms() {
  const layer = $('#roomsLayer'); if (!layer) return;
  layer.innerHTML = office.rooms.map((r) => `
    <div class="room" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;--rc:${esc(r.color)}" data-room="${r.id}">
      ${(DECOR[r.kind] || DECOR.custom).map(([e, x, y]) => `<span class="decor" style="left:${x}%;top:${y}%">${e}</span>`).join('')}
      <button class="room-label" data-room-open="${r.id}">${esc(r.icon)} ${esc(r.name)} <span class="rl-n" data-count="${r.id}">0</span>${r.announcement ? ' <span title="Announcement">📢</span>' : ''}</button>
    </div>`).join('');
  $$('[data-room-open]', layer).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); openRoomPanel(Number(b.dataset.roomOpen)); }));
  updateRoomCounts();
}
function updateRoomCounts() {
  const counts = {};
  for (const u of office.users.values()) { const r = roomAtLocal(u.x, u.y); if (r) counts[r.id] = (counts[r.id] || 0) + 1; }
  $$('[data-count]').forEach((el) => { const n = counts[el.dataset.count] || 0; el.textContent = n; el.classList.toggle('on', n > 0); });
}

/* ---------------------------------------------------------------- avatars */
function renderAvatars() {
  const layer = $('#avatarsLayer'); if (!layer) return;
  layer.innerHTML = ''; for (const u of office.users.values()) addAvatar(u);
  updateRoomCounts();
}
function addAvatar(u) {
  const layer = $('#avatarsLayer'); if (!layer) return;
  const old = avEl(u.id); if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'av' + (u.id === office.me ? ' me' : '');
  el.dataset.id = u.id;
  el.innerHTML = avInner(u);
  layer.appendChild(el); placeAvatar(u);
}
function avInner(u) {
  return `<div class="av-body att-${u.att || 'not_in'}">${esc(u.avatar || '🙂')}${u.status_emoji ? `<span class="av-st">${esc(u.status_emoji)}</span>` : ''}</div>
    <div class="av-name">${esc((u.name || '').split(' ')[0])}</div>`;
}
function redrawAvatar(u) { const el = avEl(u.id); if (el) el.innerHTML = avInner(u); }
function placeAvatar(u) { const el = avEl(u.id); if (el) el.style.transform = `translate(${u.x - 24}px, ${u.y - 24}px)`; }

function floatOn(id, emoji) {
  const el = avEl(id); if (!el) return;
  const s = document.createElement('span'); s.className = 'float'; s.textContent = emoji;
  s.style.setProperty('--dx', (Math.random() * 30 - 15) + 'px');
  el.appendChild(s); setTimeout(() => s.remove(), 1900);
}
function bubbleOn(id, text) {
  const el = avEl(id); if (!el) return;
  $$('.bubble', el).forEach((b) => b.remove());
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text.length > 60 ? text.slice(0, 57) + '…' : text;
  el.appendChild(b); setTimeout(() => b.remove(), 5000);
}

function renderReactBar() {
  const bar = $('#reactBar'); if (!bar) return;
  bar.innerHTML = office.reactions.map((e) => `<button class="react" data-e="${e}">${e}</button>`).join('');
  $$('.react', bar).forEach((b) => (b.onclick = () => wsSend({ t: 'react', emoji: b.dataset.e })));
}
function renderFeed() {
  const f = $('#feed'); if (!f) return;
  const items = office.feed.slice(-7).reverse();
  f.innerHTML = items.length ? items.map((i) => `<div class="feed-item"><span>${esc(i.icon || '✨')}</span><span>${esc(i.text)}</span><span class="muted small">${fmtTime(new Date(i.at).toISOString())}</span></div>`).join('')
    : '<div class="muted small">Quiet for now…</div>';
}

function confetti() {
  const box = document.createElement('div'); box.className = 'confetti'; document.body.appendChild(box);
  const set = ['🎉', '✨', '🎊', '⭐', '💫', '🥳'];
  for (let i = 0; i < 45; i++) {
    const s = document.createElement('span'); s.textContent = set[i % set.length];
    s.style.left = Math.random() * 100 + 'vw'; s.style.animationDelay = Math.random() * 0.6 + 's';
    s.style.fontSize = 16 + Math.random() * 20 + 'px'; s.style.setProperty('--sway', (Math.random() * 120 - 60) + 'px');
    box.appendChild(s);
  }
  setTimeout(() => box.remove(), 3500);
}

/* ---------------------------------------------------------------- movement */
function worldClick(e) {
  const av = e.target.closest('.av');
  if (av) { avatarModal(Number(av.dataset.id)); return; }
  if (e.target.closest('.room-label')) return;
  const rect = $('#world').getBoundingClientRect();
  office.target = {
    x: Math.max(16, Math.min(984, (e.clientX - rect.left) / office.scale)),
    y: Math.max(16, Math.min(624, (e.clientY - rect.top) / office.scale)),
  };
}
function startLoop() {
  if (office.loop) return;
  let last = performance.now();
  const tick = (now) => {
    if (!$('#world')) { office.loop = null; return; }
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    stepMe(dt, now);
    office.loop = requestAnimationFrame(tick);
  };
  office.loop = requestAnimationFrame(tick);
}
function stepMe(dt, now) {
  const me = meUser(); if (!me) return;
  let dx = 0, dy = 0;
  if (office.keys.has('left')) dx -= 1; if (office.keys.has('right')) dx += 1;
  if (office.keys.has('up')) dy -= 1; if (office.keys.has('down')) dy += 1;
  const speed = 240; let moving = false;
  if (dx || dy) {
    office.target = null; const len = Math.hypot(dx, dy);
    me.x += (dx / len) * speed * dt; me.y += (dy / len) * speed * dt; moving = true;
  } else if (office.target) {
    const vx = office.target.x - me.x, vy = office.target.y - me.y, dist = Math.hypot(vx, vy);
    if (dist < 4) { me.x = office.target.x; me.y = office.target.y; office.target = null; }
    else { const step = Math.min(dist, speed * dt); me.x += (vx / dist) * step; me.y += (vy / dist) * step; moving = true; }
  }
  me.x = Math.max(16, Math.min(984, me.x)); me.y = Math.max(16, Math.min(624, me.y));
  if (moving || office.wasMoving) {
    placeAvatar(me);
    if (now - office.lastSent > 70 || !moving) { wsSend({ t: 'move', x: Math.round(me.x), y: Math.round(me.y) }); office.lastSent = now; }
    const r = roomAtLocal(me.x, me.y); const rid = r ? r.id : null;
    if (rid !== me.room_id) { me.room_id = rid; renderHeader(); updateRoomCounts(); }
  }
  office.wasMoving = moving;
}
const KEYMAP = { ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right', ArrowUp: 'up', w: 'up', W: 'up', ArrowDown: 'down', s: 'down', S: 'down' };
function keyOk(e) {
  const a = document.activeElement;
  return state.route === 'office' && $('#world') && !$('#modal-root').children.length && !(a && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) && !e.ctrlKey && !e.metaKey;
}
document.addEventListener('keydown', (e) => { const k = KEYMAP[e.key]; if (k && keyOk(e)) { office.keys.add(k); e.preventDefault(); } });
document.addEventListener('keyup', (e) => { const k = KEYMAP[e.key]; if (k) office.keys.delete(k); });
window.addEventListener('blur', () => office.keys.clear());

/* ------------------------------------------------------------ people popup */
function avatarModal(id) {
  const u = office.users.get(id); if (!u) return;
  const r = roomAtLocal(u.x, u.y); const isMe = id === office.me;
  const att = { not_in: 'Not punched in', working: 'Working', on_break: 'On break ☕', done: 'Left for the day' }[u.att || 'not_in'];
  const m = openModal(`<div style="text-align:center"><div style="font-size:54px">${esc(u.avatar)}</div>
    <h2>${esc(u.name)}${isMe ? ' (you)' : ''}</h2>
    <div class="muted">${esc(u.department || 'Team')} · ${r ? esc(r.icon + ' ' + r.name) : 'Hallway'}</div>
    <div style="margin:8px 0"><span class="state-pill state-${u.att || 'not_in'}">${att}</span></div>
    ${u.status_emoji || u.status_text ? `<div>${esc(u.status_emoji)} ${esc(u.status_text)}</div>` : ''}</div>
    <div class="modal-actions" style="justify-content:center">
      ${isMe ? '' : '<button class="btn primary" id="amWave">👋 Wave</button><button class="btn" id="amGo">🚶 Walk over</button>'}
      <button class="btn" id="amTasks">📋 Their tasks</button><button class="btn ghost" id="amClose">Close</button></div>`);
  $('#amClose', m).onclick = closeModal;
  $('#amTasks', m).onclick = () => { closeModal(); state.filters = { assignee: String(id), status: 'open', priority: '', health: '', q: '' }; go('tasks'); };
  if (!isMe) {
    $('#amWave', m).onclick = () => { wsSend({ t: 'wave', to: id }); floatOn(office.me, '👋'); closeModal(); toast(`Waved at ${u.name.split(' ')[0]} 👋`); };
    $('#amGo', m).onclick = () => { office.target = { x: u.x + 36, y: u.y }; closeModal(); };
  }
}

function profileModal() {
  const me = meUser() || {};
  const m = openModal(`<h2>Your look & status</h2>
    <label class="f">Pick your avatar</label>
    <div class="emoji-grid">${AVATARS.map((a) => `<button class="emoji ${a === state.me.avatar ? 'sel' : ''}" data-a="${a}">${a}</button>`).join('')}</div>
    <label class="f">Set a status</label>
    <div class="row" style="gap:6px">${STATUSES.map(([e, t]) => `<button class="btn sm noflex" data-s="${esc(e)}" data-t="${esc(t === 'Clear status' ? '' : t)}">${e} ${t}</button>`).join('')}</div>
    <div class="row" style="margin-top:8px"><input type="text" id="stx" maxlength="40" placeholder="…or type your own" value="${esc(me.status_text || '')}" /><button class="btn noflex" id="stSave">Set</button></div>
    <div class="modal-actions"><button class="btn" id="pfClose">Done</button></div>`);
  $('#pfClose', m).onclick = closeModal;
  $$('[data-a]', m).forEach((b) => (b.onclick = async () => {
    try { await api('/me/profile', { method: 'PATCH', body: { avatar: b.dataset.a } }); state.me.avatar = b.dataset.a; $$('[data-a]', m).forEach((x) => x.classList.toggle('sel', x === b)); renderHeader(); }
    catch (e) { fail(e); }
  }));
  $$('[data-s]', m).forEach((b) => (b.onclick = () => { wsSend({ t: 'status', emoji: b.dataset.s, text: b.dataset.t }); closeModal(); toast('Status updated'); }));
  $('#stSave', m).onclick = () => { wsSend({ t: 'status', emoji: '💬', text: $('#stx', m).value }); closeModal(); toast('Status updated'); };
}

/* -------------------------------------------------------------- room panel */
const dot = (att, online) => `<i class="pdot ${online ? 'on' : ''} att-${att}" title="${online ? 'Online' : 'Offline'} · ${att.replace('_', ' ')}"></i>`;

async function openRoomPanel(id, keep) {
  const panel = $('#roomPanel'); if (!panel) return;
  let d;
  try { d = await api('/rooms/' + id); } catch (e) { return fail(e); }
  const saved = keep ? { t: ($('#rpTitle') || {}).value, c: ($('#rpChat') || {}).value } : {};
  office.panelId = id;
  const inside = [...office.users.values()].filter((u) => { const r = roomAtLocal(u.x, u.y); return r && r.id === id; });
  const me = meUser(); const here = me && roomAtLocal(me.x, me.y) && roomAtLocal(me.x, me.y).id === id;
  const r = d.room;
  const online = new Set(office.users.keys());
  panel.style.setProperty('--rc', r.color);
  panel.innerHTML = `
    <div class="rp-head"><span class="rp-ico">${esc(r.icon)}</span><div style="flex:1;min-width:0"><h2>${esc(r.name)}</h2>
      <div class="muted small">${inside.length} inside now · ${d.members.length} assigned</div></div>
      <button class="btn sm ghost" id="rpClose" title="Close">✕</button></div>
    <div class="rp-body">
      ${r.announcement ? `<div class="announce">📢 ${esc(r.announcement)}</div>` : ''}
      ${r.description ? `<p class="muted" style="margin:0 0 10px">${esc(r.description)}</p>` : ''}
      <div class="row" style="margin-bottom:12px">
        ${here ? '<span class="chip s-green noflex">You are here ✓</span>' : '<button class="btn sm primary noflex" id="rpWalk">🚶 Walk in</button>'}
        ${isAdmin() ? '<button class="btn sm noflex" id="rpEdit">✏️ Edit space</button>' : ''}
      </div>
      <h3>In the room now</h3>
      <div class="whoin" style="margin-bottom:12px">${inside.length ? inside.map((u) => `<span class="state-pill state-${u.att || 'not_in'}">${esc(u.avatar)} ${esc(u.name.split(' ')[0])}</span>`).join('') : '<span class="muted small">Nobody yet. Be the first! 🙌</span>'}</div>
      <h3>Assigned team</h3>
      <div class="members">${d.members.length ? d.members.map((m) => `
        <div class="member" data-uid="${m.id}">${dot(m.att, online.has(m.id))}<span class="m-av">${esc(m.avatar)}</span>
          <div style="flex:1;min-width:0"><b>${esc(m.name)}</b><div class="muted small">${esc(m.department || 'Team')}</div></div>
          <span class="chip s-orange" title="Pending">${m.pending}</span><span class="chip s-yellow" title="In progress">${m.in_progress}</span>${m.red ? `<span class="chip s-red" title="Needs attention">${m.red}</span>` : ''}
        </div>`).join('') : '<div class="muted small">No one is assigned to this space yet.</div>'}</div>
      <h3 style="margin-top:14px">Tasks in this space</h3>
      <div class="row" style="gap:6px;margin-bottom:8px">
        <input type="text" id="rpTitle" maxlength="200" placeholder="Add a task…" />
        <select id="rpAssign" class="noflex" style="width:auto">${userOptions(state.me.id)}</select>
        <select id="rpPrio" class="noflex" style="width:auto">${['low', 'medium', 'high', 'urgent'].map((p) => `<option value="${p}" ${p === 'medium' ? 'selected' : ''}>${cap(p)}</option>`).join('')}</select>
        <button class="btn primary noflex" id="rpAdd">Add</button></div>
      <div id="rpTasks">${d.tasks.length ? d.tasks.map(taskRow).join('') : '<div class="muted small">No tasks yet. Add one for yourself or a teammate ☝️</div>'}</div>
      <h3 style="margin-top:14px">Room chat</h3>
      <div class="chatbox" id="rpMsgs">${d.messages.map(chatHtml).join('') || '<div class="muted small" id="rpNoMsg">No messages yet. Say hi! 👋</div>'}</div>
      <div class="row" style="margin-top:6px;gap:6px"><input type="text" id="rpChat" maxlength="400" ${here ? 'placeholder="Message the room…"' : 'disabled placeholder="Walk into this room to chat 🚶"'} />
        <button class="btn noflex" id="rpSend" ${here ? '' : 'disabled'}>Send</button></div>
    </div>`;
  panel.classList.remove('hidden');
  if (saved.t) $('#rpTitle').value = saved.t;
  if (saved.c && here) $('#rpChat').value = saved.c;
  const box = $('#rpMsgs'); box.scrollTop = box.scrollHeight;

  $('#rpClose').onclick = () => { office.panelId = null; panel.classList.add('hidden'); };
  const walk = $('#rpWalk');
  if (walk) walk.onclick = () => { office.target = { x: r.x + r.w / 2 + (Math.random() * 40 - 20), y: r.y + r.h / 2 + 20 }; toast('Walking over… 🚶'); };
  const edit = $('#rpEdit'); if (edit) edit.onclick = () => roomEditModal(id, () => openRoomPanel(id, true));
  $$('.member', panel).forEach((el) => (el.onclick = () => { state.filters = { assignee: el.dataset.uid, status: 'open', priority: '', health: '', q: '' }; office.panelId = null; panel.classList.add('hidden'); go('tasks'); }));
  const add = async () => {
    const title = $('#rpTitle').value.trim(); if (!title) return toast('Type a task first', true);
    try {
      await api('/tasks', { method: 'POST', body: { title, assignee_id: Number($('#rpAssign').value), priority: $('#rpPrio').value, room_id: id } });
      toast('Task added ✓'); $('#rpTitle').value = ''; openRoomPanel(id);
    } catch (e) { fail(e); }
  };
  $('#rpAdd').onclick = add; $('#rpTitle').onkeydown = (e) => { if (e.key === 'Enter') add(); };
  bindTaskActions($('#rpTasks'), () => openRoomPanel(id, true));
  const send = () => { const i = $('#rpChat'); const v = i.value.trim(); if (!v) return; wsSend({ t: 'chat', body: v }); i.value = ''; };
  $('#rpSend').onclick = send; $('#rpChat').onkeydown = (e) => { if (e.key === 'Enter') send(); };
}

function chatHtml(m) {
  return `<div class="cm"><span class="m-av">${esc(m.avatar)}</span><div><b>${esc(m.name)}</b> <span class="muted small">${fmtTime(m.created_at || m.at)}</span><div>${esc(m.body)}</div></div></div>`;
}
function appendChat(m) {
  const box = $('#rpMsgs'); if (!box) return;
  const none = $('#rpNoMsg'); if (none) none.remove();
  box.insertAdjacentHTML('beforeend', chatHtml(m)); box.scrollTop = box.scrollHeight;
}

/* ------------------------------------------------------ admin: space editor */
async function roomEditModal(id, onDone) {
  let d = null;
  if (id) { try { d = await api('/rooms/' + id); } catch (e) { return fail(e); } }
  const r = d ? d.room : { name: '', kind: 'custom', icon: '🏠', color: '#6366f1', description: '', announcement: '', x: 380, y: 430, w: 240, h: 170 };
  const memberIds = new Set(d ? d.members.map((m) => m.id) : []);
  const m = openModal(`<h2>${id ? 'Edit space' : 'New space'}</h2>
    <div class="row"><div><label class="f">Name</label><input type="text" id="reName" maxlength="40" value="${esc(r.name)}" /></div>
      <div style="flex:0 0 90px"><label class="f">Icon</label><input type="text" id="reIcon" maxlength="8" value="${esc(r.icon)}" /></div>
      <div style="flex:0 0 80px"><label class="f">Colour</label><input type="color" id="reColor" value="${esc(r.color)}" style="height:38px;padding:2px" /></div></div>
    <div class="row"><div><label class="f">Type</label><select id="reKind">${[['lobby', 'Lobby'], ['work', 'Work zone'], ['meeting', 'Meeting room'], ['break', 'Break room'], ['private', 'Private cabin'], ['custom', 'Other']].map(([k, l]) => `<option value="${k}" ${r.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <label class="f">About this space</label><textarea id="reDesc" style="min-height:60px">${esc(r.description)}</textarea>
    <label class="f">📢 Announcement (shown at the top when someone clicks the room)</label><input type="text" id="reAnn" maxlength="500" value="${esc(r.announcement)}" />
    <label class="f">Position on the floor (map is 1000 × 640)</label>
    <div class="row">${[['x', 'X'], ['y', 'Y'], ['w', 'Width'], ['h', 'Height']].map(([k, l]) => `<div><input type="number" id="re_${k}" value="${r[k]}" title="${l}" placeholder="${l}" /><div class="muted small">${l}</div></div>`).join('')}</div>
    <label class="f">Assign people to this space</label>
    <div class="assign-list">${state.users.filter((u) => u.active).map((u) => `<label class="chk"><input type="checkbox" value="${u.id}" ${memberIds.has(u.id) ? 'checked' : ''} /> ${esc(u.avatar || '🙂')} ${esc(u.name)}</label>`).join('')}</div>
    <div class="modal-actions">${id ? '<button class="btn ghost" id="reDel" style="margin-right:auto;color:var(--red)">🗑 Delete</button>' : ''}
      <button class="btn" id="reCancel">Cancel</button><button class="btn primary" id="reSave">Save</button></div>`);
  $('#reCancel', m).onclick = closeModal;
  const del = $('#reDel', m);
  if (del) del.onclick = async () => {
    if (!confirm('Delete this space? Tasks stay, but the room disappears.')) return;
    try { await api('/rooms/' + id, { method: 'DELETE' }); closeModal(); office.panelId = null; const p = $('#roomPanel'); if (p) p.classList.add('hidden'); toast('Space deleted'); onDone && onDone(); } catch (e) { fail(e); }
  };
  $('#reSave', m).onclick = async () => {
    const body = {
      name: $('#reName', m).value, icon: $('#reIcon', m).value, color: $('#reColor', m).value, kind: $('#reKind', m).value,
      description: $('#reDesc', m).value, announcement: $('#reAnn', m).value,
      x: $('#re_x', m).value, y: $('#re_y', m).value, w: $('#re_w', m).value, h: $('#re_h', m).value,
      user_ids: $$('.assign-list input:checked', m).map((c) => Number(c.value)),
    };
    try {
      await api(id ? '/rooms/' + id : '/rooms', { method: id ? 'PATCH' : 'POST', body });
      closeModal(); toast('Space saved ✓'); onDone && onDone();
    } catch (e) { fail(e); }
  };
}
