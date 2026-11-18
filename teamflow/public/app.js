/* TeamFlow front-end (vanilla JS, no build step) */
'use strict';

const state = {
  me: null, settings: null, tz: 'Asia/Kolkata', users: [], route: 'office',
  filters: { assignee: '', status: 'open', priority: '', health: '', q: '' },
  att: { user: '', from: '', to: '' },
  refresh: null,
};

/* ------------------------------------------------------------- utilities */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const initials = (n) => (n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const isAdmin = () => state.me && state.me.role === 'admin';

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* csv etc. */ }
  if (res.status === 401 && state.me) { officeDisconnect(); state.me = null; showLogin('Session expired. Please log in again.'); throw new Error('auth'); }
  if (!res.ok) throw new Error((data && data.error) || 'Request failed');
  return data;
}

let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3200);
}
const fail = (e) => { if (e.message !== 'auth') toast(e.message, true); };

function dur(mins) {
  mins = Math.max(0, Math.round(mins || 0));
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: state.tz, hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { timeZone: state.tz, day: '2-digit', month: 'short' }) : '—');
const fmtDateTime = (iso) => (iso ? `${fmtDate(iso)}, ${fmtTime(iso)}` : '—');
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
function todayLocalStr(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toLocaleDateString('en-CA', { timeZone: state.tz });
}

/* ----------------------------------------------------------------- login */
function showLogin(msg) {
  clearInterval(state.refresh);
  $('#modal-root').innerHTML = '';
  $('#app').innerHTML = `
    <div class="login-wrap"><form class="card login" id="loginForm">
      <h1>TeamFlow</h1>
      <p class="muted" style="margin:4px 0 12px">Punch in, share tasks, stay on track.</p>
      <label class="f">Username</label><input type="text" id="lu" autocomplete="username" autofocus required />
      <label class="f">Password</label><input type="password" id="lp" autocomplete="current-password" required />
      <button class="btn primary" style="width:100%;justify-content:center;margin-top:16px">Log in</button>
      <div class="error" id="lerr">${esc(msg || '')}</div>
    </form></div>`;
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/login', { method: 'POST', body: { username: $('#lu').value, password: $('#lp').value } });
      await boot();
    } catch (err) { $('#lerr').textContent = err.message; }
  };
}

/* ------------------------------------------------------------------ shell */
const TABS = [
  ['office', 'Office'], ['home', 'My Day'], ['tasks', 'Tasks'], ['team', 'Team'], ['attendance', 'Attendance'],
];

function renderShell() {
  const tabs = [...TABS, ...(isAdmin() ? [['admin', 'Admin']] : [])];
  document.title = state.settings.company_name;
  $('#app').innerHTML = `
    <header class="topbar">
      <div class="brand">${esc(state.settings.company_name)}</div>
      <nav class="tabs">${tabs.map(([k, l]) => `<button class="tab ${state.route === k ? 'active' : ''}" data-route="${k}">${l}</button>`).join('')}</nav>
      <div class="userbox">
        <span class="avatar">${esc(initials(state.me.name))}</span>
        <span class="small" style="line-height:1.2"><b>${esc(state.me.name)}</b><br><span class="muted">${isAdmin() ? 'Admin' : 'Staff'}</span></span>
        <button class="btn sm ghost" id="pwBtn" title="Change password">🔑</button>
        <button class="btn sm" id="logoutBtn">Log out</button>
      </div>
    </header>
    <main id="view"></main>`;
  $$('.tab').forEach((b) => (b.onclick = () => go(b.dataset.route)));
  $('#logoutBtn').onclick = async () => { await api('/logout', { method: 'POST' }).catch(() => {}); officeDisconnect(); state.me = null; showLogin(); };
  $('#pwBtn').onclick = passwordModal;
}

function go(route) {
  state.route = route;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.route === route));
  loadView();
}

async function loadView(silent) {
  const v = $('#view'); if (!v) return;
  try {
    if (state.route === 'office') await viewOffice(v, silent);
    else if (state.route === 'home') await viewHome(v);
    else if (state.route === 'tasks') await viewTasks(v, silent);
    else if (state.route === 'team') await viewTeam(v);
    else if (state.route === 'attendance') await viewAttendance(v, silent);
    else if (state.route === 'admin') await viewAdmin(v, silent);
  } catch (e) { fail(e); }
}

function startAutoRefresh() {
  clearInterval(state.refresh);
  state.refresh = setInterval(() => {
    if ($('#modal-root').children.length) return;
    const a = document.activeElement;
    if (a && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) return;
    loadView(true);
  }, 30000);
}

async function refreshUsers() { state.users = await api('/users'); }

/* ------------------------------------------------------------- task bits */
function canEditTask(t) { return isAdmin() || t.creator_id === state.me.id || t.assignee_id === state.me.id; }
function canDeleteTask(t) { return isAdmin() || t.creator_id === state.me.id; }
const STATUS_LABEL = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed' };

function taskRow(t) {
  const reason = t.health === 'red'
    ? (t.red_reason === 'overdue' ? '⏰ Overdue' : `🔥 Open ${dur(t.age_minutes)}`) : '';
  const edit = canEditTask(t);
  const acts = [];
  if (edit && t.status === 'pending') acts.push(`<button class="btn sm" data-act="start" data-id="${t.id}">▶ Start</button>`);
  if (edit && t.status !== 'completed') acts.push(`<button class="btn sm green" data-act="done" data-id="${t.id}">✓ Done</button>`);
  if (edit && t.status === 'completed') acts.push(`<button class="btn sm" data-act="reopen" data-id="${t.id}">↺ Reopen</button>`);
  const due = t.due_at ? `<span>📅 Due ${fmtDateTime(t.due_at)}</span>` : '';
  return `
  <div class="task h-${t.health}">
    <div class="task-main" data-act="open" data-id="${t.id}">
      <div class="task-title">${esc(t.title)}</div>
      <div class="chips">
        <span class="chip pr-${t.priority}">⚑ ${cap(t.priority)}</span>
        <span class="chip s-${t.health === 'red' ? 'red' : t.health}">${STATUS_LABEL[t.status]}</span>
        ${reason ? `<span class="chip s-red" style="background:var(--red-bg);color:var(--red)">${reason}</span>` : ''}
        <span class="chip">👤 ${esc(t.assignee_name)}</span>
        <span>from ${esc(t.creator_name)}</span>
        <span>🕒 ${t.status === 'completed' ? 'Done ' + fmtDateTime(t.completed_at) : fmtDateTime(t.created_at)}</span>
        ${due}
      </div>
    </div>
    <div class="task-actions">${acts.join('')}</div>
  </div>`;
}

function bindTaskActions(root, reload) {
  root.onclick = async (e) => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const id = Number(el.dataset.id); const act = el.dataset.act;
    try {
      if (act === 'open') return taskModal(id, reload);
      const status = { start: 'in_progress', done: 'completed', reopen: 'pending' }[act];
      if (status) {
        el.disabled = true;
        await api(`/tasks/${id}`, { method: 'PATCH', body: { status } });
        toast(status === 'completed' ? 'Marked as completed ✓' : 'Updated');
        reload();
      }
    } catch (err) { fail(err); }
  };
}

const legend = () => `<div class="legend">
  <span><i class="dot green"></i>Completed</span>
  <span><i class="dot yellow"></i>In progress</span>
  <span><i class="dot orange"></i>Pending</span>
  <span><i class="dot red"></i>Overdue or open more than ${state.settings.red_hours}h</span>
</div>`;

/* ------------------------------------------------------------------ home */
async function viewHome(v) {
  const [att, board, sum, mine, red] = await Promise.all([
    api('/attendance/me'), api('/attendance/board'), api('/summary'),
    api(`/tasks?assignee_id=${state.me.id}&status=open`), api('/tasks?health=red&status=open'),
  ]);
  const me = sum.people.find((p) => p.user_id === state.me.id) || {};
  const stateText = { not_in: 'Not punched in', working: 'Working', on_break: 'On break', done: 'Day complete' }[att.state];
  v.innerHTML = `
  <div class="page-head"><h1>Hello, ${esc(state.me.name.split(' ')[0])} 👋</h1>
    <button class="btn primary" id="newTask">＋ New task</button></div>
  <div class="grid two">
    <div class="grid" style="align-content:start">
      <div class="card" id="punchCard">
        <div class="row" style="justify-content:space-between"><h2 style="margin:0">Attendance</h2>
          <span class="state-pill state-${att.state} noflex">${stateText}</span></div>
        <div class="clock" id="clock">--:--:--</div>
        <div class="small muted">${new Date().toLocaleDateString('en-IN', { timeZone: state.tz, weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <div style="margin-top:10px" class="small">
          ${att.punch_in ? `In <b>${fmtTime(att.punch_in)}</b>${att.late ? ' <span class="chip s-orange">Late</span>' : ''}` : ''}
          ${att.punch_out ? ` · Out <b>${fmtTime(att.punch_out)}</b>` : ''}
          ${att.punch_in ? ` · Worked <b id="worked" data-m="${att.worked_minutes}" data-run="${att.state === 'working' ? 1 : 0}">${dur(att.worked_minutes)}</b>` : ''}
          ${att.break_minutes ? ` · Breaks ${dur(att.break_minutes)}` : ''}
        </div>
        <div class="punch-actions">
          ${att.state === 'not_in' ? '<button class="btn green" data-p="punch-in">▶ Punch in</button>' : ''}
          ${att.state === 'working' ? '<button class="btn" data-p="break-start">☕ Start break</button><button class="btn red" data-p="punch-out">⏹ Punch out</button>' : ''}
          ${att.state === 'on_break' ? '<button class="btn primary" data-p="break-end">▶ End break</button><button class="btn red" data-p="punch-out">⏹ Punch out</button>' : ''}
        </div>
      </div>
      <div class="card"><h2>My tasks</h2>
        <div class="tiles">
          <div class="tile t-orange"><div class="num">${me.pending || 0}</div><div class="lbl">Pending</div></div>
          <div class="tile t-yellow"><div class="num">${me.in_progress || 0}</div><div class="lbl">In progress</div></div>
          <div class="tile t-green"><div class="num">${me.completed || 0}</div><div class="lbl">Completed</div></div>
          <div class="tile t-red"><div class="num">${me.red || 0}</div><div class="lbl">Needs attention</div></div>
        </div>
      </div>
      <div class="card"><h2>Who's in today <span class="muted small">(${board.filter((b) => b.state === 'working' || b.state === 'on_break').length} of ${board.length})</span></h2>
        <div class="whoin">${board.map((b) => {
          const cls = { working: 'state-working', on_break: 'state-on_break', done: 'state-done', not_in: 'state-not_in' }[b.state];
          return `<span class="state-pill ${cls}" title="${esc(b.state.replace('_', ' '))}">${esc(b.name.split(' ')[0])}${b.state === 'on_break' ? ' ☕' : ''}</span>`;
        }).join('')}</div>
      </div>
    </div>
    <div class="grid" style="align-content:start">
      <div class="card"><h2>Team snapshot</h2>
        <div class="tiles">
          <div class="tile t-orange"><div class="num">${sum.totals.pending}</div><div class="lbl">Pending</div></div>
          <div class="tile t-yellow"><div class="num">${sum.totals.in_progress}</div><div class="lbl">In progress</div></div>
          <div class="tile t-green"><div class="num">${sum.totals.done_today}</div><div class="lbl">Done today</div></div>
          <div class="tile t-red"><div class="num">${sum.totals.red}</div><div class="lbl">Red flags</div></div>
        </div>
      </div>
      <div class="card" id="redList"><h2>🔴 Needs attention <span class="muted small">(${red.length})</span></h2>
        ${red.length ? red.slice(0, 6).map(taskRow).join('') : '<div class="empty">Nothing is overdue. Nice work! 🎉</div>'}
        ${red.length > 6 ? '<button class="btn sm" id="moreRed">See all red tasks →</button>' : ''}
      </div>
      <div class="card" id="mineList"><h2>My open tasks <span class="muted small">(${mine.length})</span></h2>
        ${mine.length ? mine.slice(0, 8).map(taskRow).join('') : '<div class="empty">No open tasks assigned to you.</div>'}
        ${mine.length > 8 ? '<button class="btn sm" id="moreMine">See all my tasks →</button>' : ''}
      </div>
    </div>
  </div>`;
  $('#newTask').onclick = () => taskModal(null, () => loadView());
  $$('[data-p]', v).forEach((b) => (b.onclick = async () => {
    try { b.disabled = true; await api(`/attendance/${b.dataset.p}`, { method: 'POST', body: {} }); toast('Done'); loadView(); }
    catch (e) { fail(e); b.disabled = false; }
  }));
  bindTaskActions($('#redList'), () => loadView());
  bindTaskActions($('#mineList'), () => loadView());
  const mr = $('#moreRed'); if (mr) mr.onclick = () => { state.filters = { assignee: '', status: 'open', priority: '', health: 'red', q: '' }; go('tasks'); };
  const mm = $('#moreMine'); if (mm) mm.onclick = () => { state.filters = { assignee: String(state.me.id), status: 'open', priority: '', health: '', q: '' }; go('tasks'); };
  tickClock();
}

let clockTimer;
function tickClock() {
  clearInterval(clockTimer);
  const upd = () => {
    const c = $('#clock'); if (!c) return clearInterval(clockTimer);
    c.textContent = new Date().toLocaleTimeString('en-GB', { timeZone: state.tz });
    const w = $('#worked');
    if (w && w.dataset.run === '1') {
      const base = Number(w.dataset.m); w.dataset.t = w.dataset.t || Date.now();
      w.textContent = dur(base + (Date.now() - Number(w.dataset.t)) / 60000);
    }
  };
  upd(); clockTimer = setInterval(upd, 1000);
}

/* ----------------------------------------------------------------- tasks */
async function viewTasks(v, silent) {
  if (!silent || !$('#taskList')) {
    const f = state.filters;
    v.innerHTML = `
    <div class="page-head"><h1>Tasks</h1><button class="btn primary" id="newTask">＋ New task</button></div>
    ${legend()}
    <div class="filters">
      <input type="search" class="search" id="fq" placeholder="Search tasks…" value="${esc(f.q)}" />
      <select id="fa"><option value="">Everyone</option>${state.users.filter((u) => u.active).map((u) => `<option value="${u.id}" ${String(u.id) === String(f.assignee) ? 'selected' : ''}>${esc(u.name)}${u.id === state.me.id ? ' (me)' : ''}</option>`).join('')}</select>
      <select id="fs">${[['open', 'Open (not done)'], ['', 'All'], ['pending', 'Pending'], ['in_progress', 'In progress'], ['completed', 'Completed']].map(([k, l]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="fp"><option value="">Any priority</option>${['urgent', 'high', 'medium', 'low'].map((p) => `<option value="${p}" ${f.priority === p ? 'selected' : ''}>${cap(p)}</option>`).join('')}</select>
      <select id="fh"><option value="">Any colour</option>${[['red', '🔴 Red'], ['orange', '🟠 Orange'], ['yellow', '🟡 Yellow'], ['green', '🟢 Green']].map(([k, l]) => `<option value="${k}" ${f.health === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn" id="fmine">My tasks</button>
    </div>
    <div id="taskList"></div>`;
    $('#newTask').onclick = () => taskModal(null, () => loadView(true));
    let timer;
    $('#fq').oninput = (e) => { state.filters.q = e.target.value; clearTimeout(timer); timer = setTimeout(() => loadView(true), 250); };
    [['#fa', 'assignee'], ['#fs', 'status'], ['#fp', 'priority'], ['#fh', 'health']].forEach(([sel, key]) => ($(sel).onchange = (e) => { state.filters[key] = e.target.value; loadView(true); }));
    $('#fmine').onclick = () => { state.filters.assignee = String(state.me.id); $('#fa').value = state.filters.assignee; loadView(true); };
    bindTaskActions($('#taskList'), () => loadView(true));
  }
  const f = state.filters; const qs = new URLSearchParams();
  if (f.assignee) qs.set('assignee_id', f.assignee);
  if (f.status) qs.set('status', f.status);
  if (f.priority) qs.set('priority', f.priority);
  if (f.health) qs.set('health', f.health);
  if (f.q) qs.set('q', f.q);
  const tasks = await api('/tasks?' + qs);
  const open = tasks.filter((t) => t.status !== 'completed').length;
  $('#taskList').innerHTML = `<div class="muted small" style="margin-bottom:8px">${tasks.length} task${tasks.length === 1 ? '' : 's'} · ${open} open</div>` +
    (tasks.length ? tasks.map(taskRow).join('') : '<div class="card empty">No tasks match these filters.</div>');
}

function userOptions(selected) {
  return state.users.filter((u) => u.active).map((u) => `<option value="${u.id}" ${u.id === selected ? 'selected' : ''}>${esc(u.name)}${u.id === state.me.id ? ' (me)' : ''}</option>`).join('');
}

function closeModal() { $('#modal-root').innerHTML = ''; }
function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal">${html}</div></div>`;
  $('.overlay', root).onmousedown = (e) => { if (e.target.classList.contains('overlay')) closeModal(); };
  return $('.modal', root);
}

async function taskModal(id, onChange) {
  let t = null;
  if (id) { try { t = await api('/tasks/' + id); } catch (e) { return fail(e); } }
  const editable = !t || canEditTask(t);
  const m = openModal(`
    <h2>${t ? `Task #${t.id}` : 'New task'}</h2>
    ${t ? `<div class="chips"><span class="chip s-${t.health}">${STATUS_LABEL[t.status]}</span>
      ${t.health === 'red' ? `<span class="chip" style="background:var(--red-bg);color:var(--red)">${t.red_reason === 'overdue' ? '⏰ Overdue' : '🔥 Open ' + dur(t.age_minutes)}</span>` : ''}
      <span>Created by ${esc(t.creator_name)} · ${fmtDateTime(t.created_at)}</span></div>` : ''}
    <label class="f">Title</label><input type="text" id="tt" maxlength="200" value="${esc(t ? t.title : '')}" ${editable ? '' : 'disabled'} />
    <label class="f">Details</label><textarea id="td" ${editable ? '' : 'disabled'}>${esc(t ? t.description : '')}</textarea>
    <div class="row">
      <div><label class="f">Assign to</label><select id="ta" ${editable ? '' : 'disabled'}>${userOptions(t ? t.assignee_id : state.me.id)}</select></div>
      <div><label class="f">Priority</label><select id="tp" ${editable ? '' : 'disabled'}>${['low', 'medium', 'high', 'urgent'].map((p) => `<option value="${p}" ${(t ? t.priority : 'medium') === p ? 'selected' : ''}>${cap(p)}</option>`).join('')}</select></div>
    </div>
    <div class="row">
      <div><label class="f">Due (optional)</label><input type="datetime-local" id="tdue" value="${t ? toLocalInput(t.due_at) : ''}" ${editable ? '' : 'disabled'} /></div>
      ${t ? `<div><label class="f">Status</label><select id="ts" ${editable ? '' : 'disabled'}>${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}
    </div>
    ${t ? `<div class="timeline" id="tl">${t.events.map((e) => `<div class="ev ${e.kind}"><b>${esc(e.user_name)}</b> ${e.kind === 'comment' ? '' : '· '}${esc(e.body)} <span class="muted small">· ${fmtDateTime(e.created_at)}</span></div>`).join('')}</div>
    <div class="row" style="margin-top:8px"><input type="text" id="tc" placeholder="Write a comment…" maxlength="2000" /><button class="btn noflex" id="tcb">Send</button></div>` : ''}
    <div class="modal-actions">
      ${t && canDeleteTask(t) ? '<button class="btn ghost" id="tdel" style="margin-right:auto;color:var(--red)">🗑 Delete</button>' : ''}
      <button class="btn" id="tcancel">Close</button>
      ${editable ? `<button class="btn primary" id="tsave">${t ? 'Save changes' : 'Create task'}</button>` : ''}
    </div>`);
  $('#tcancel', m).onclick = closeModal;
  const tl = $('#tl', m); if (tl) tl.scrollTop = tl.scrollHeight;
  if (t) {
    const send = async () => {
      const v = $('#tc', m).value.trim(); if (!v) return;
      try { await api(`/tasks/${t.id}/comments`, { method: 'POST', body: { body: v } }); closeModal(); taskModal(t.id, onChange); }
      catch (e) { fail(e); }
    };
    $('#tcb', m).onclick = send;
    $('#tc', m).onkeydown = (e) => { if (e.key === 'Enter') send(); };
    const del = $('#tdel', m);
    if (del) del.onclick = async () => {
      if (!confirm('Delete this task permanently?')) return;
      try { await api('/tasks/' + t.id, { method: 'DELETE' }); closeModal(); toast('Task deleted'); onChange && onChange(); } catch (e) { fail(e); }
    };
  }
  const save = $('#tsave', m);
  if (save) save.onclick = async () => {
    const body = {
      title: $('#tt', m).value, description: $('#td', m).value, assignee_id: Number($('#ta', m).value),
      priority: $('#tp', m).value, due_at: fromLocalInput($('#tdue', m).value),
    };
    if (!body.title.trim()) return toast('Please enter a title', true);
    if (t) body.status = $('#ts', m).value;
    try {
      save.disabled = true;
      await api(t ? '/tasks/' + t.id : '/tasks', { method: t ? 'PATCH' : 'POST', body });
      closeModal(); toast(t ? 'Task updated' : 'Task created & assigned'); onChange && onChange();
    } catch (e) { fail(e); save.disabled = false; }
  };
}

/* ------------------------------------------------------------------ team */
async function viewTeam(v) {
  const [sum, board] = await Promise.all([api('/summary'), api('/attendance/board')]);
  const bmap = Object.fromEntries(board.map((b) => [b.user_id, b]));
  const stText = { not_in: 'Not in', working: 'Working', on_break: 'On break', done: 'Left' };
  v.innerHTML = `
  <div class="page-head"><h1>Team</h1><span class="muted small">Tap a person to see their tasks</span></div>
  <div class="card" style="margin-bottom:14px"><div class="tiles">
    <div class="tile t-orange"><div class="num">${sum.totals.pending}</div><div class="lbl">Pending</div></div>
    <div class="tile t-yellow"><div class="num">${sum.totals.in_progress}</div><div class="lbl">In progress</div></div>
    <div class="tile t-green"><div class="num">${sum.totals.completed}</div><div class="lbl">Completed (all time)</div></div>
    <div class="tile t-red"><div class="num">${sum.totals.red}</div><div class="lbl">Red flags</div></div>
    <div class="tile"><div class="num">${sum.totals.high_priority}</div><div class="lbl">High / urgent open</div></div>
  </div></div>
  <div class="grid cards">${sum.people.map((p) => {
    const b = bmap[p.user_id] || { state: 'not_in' };
    const total = p.pending + p.in_progress + p.completed;
    return `<div class="card person" data-uid="${p.user_id}">
      <div class="person-head"><span class="avatar lg">${esc(initials(p.name))}</span>
        <div style="flex:1;min-width:0"><b>${esc(p.name)}</b><div class="muted small">${esc(p.department || 'Staff')}</div></div>
        <span class="state-pill state-${b.state}">${stText[b.state]}</span></div>
      <div class="counts">
        <div class="c-orange"><b>${p.pending}</b>Pending</div>
        <div class="c-yellow"><b>${p.in_progress}</b>Working</div>
        <div class="c-green"><b>${p.completed}</b>Done</div>
        <div class="c-red"><b>${p.red}</b>Red</div>
      </div>
      <div class="bar"><i style="width:${total ? Math.round((p.completed / total) * 100) : 0}%"></i></div>
      <div class="small muted" style="margin-top:6px">${total ? Math.round((p.completed / total) * 100) : 0}% completed${p.high_priority ? ` · ⚑ ${p.high_priority} high/urgent open` : ''}</div>
    </div>`;
  }).join('')}</div>`;
  $$('.person', v).forEach((c) => (c.onclick = () => {
    state.filters = { assignee: c.dataset.uid, status: 'open', priority: '', health: '', q: '' };
    go('tasks');
  }));
}

/* ------------------------------------------------------------ attendance */
async function viewAttendance(v, silent) {
  const a = state.att;
  if (!a.from) { a.from = todayLocalStr(-29); a.to = todayLocalStr(); }
  if (!silent || !$('#attBody')) {
    v.innerHTML = `
    <div class="page-head"><h1>Attendance</h1><a class="btn" id="csv" href="#">⬇ Download CSV</a></div>
    <div class="card">
      <div class="row">
        ${isAdmin() ? `<div><label class="f">Person</label><select id="au"><option value="">Everyone</option>${state.users.map((u) => `<option value="${u.id}" ${String(u.id) === String(a.user) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>` : ''}
        <div><label class="f">From</label><input type="date" id="af" value="${a.from}" /></div>
        <div><label class="f">To</label><input type="date" id="at" value="${a.to}" /></div>
      </div>
      <div id="attBody" style="margin-top:12px"></div>
    </div>`;
    ['#au', '#af', '#at'].forEach((s) => { const el = $(s); if (el) el.onchange = () => { a.user = ($('#au') || {}).value || ''; a.from = $('#af').value; a.to = $('#at').value; loadView(true); }; });
  }
  const qs = new URLSearchParams({ from: a.from, to: a.to });
  if (isAdmin() && a.user) qs.set('user_id', a.user);
  const rows = await api('/attendance/report?' + qs);
  const csv = $('#csv'); if (csv) { qs.set('format', 'csv'); csv.href = '/api/attendance/report?' + qs; }
  const total = rows.reduce((s, r) => s + r.worked_minutes, 0);
  const late = rows.filter((r) => r.late).length;
  $('#attBody').innerHTML = `
    <div class="small muted" style="margin-bottom:8px">${rows.length} day record${rows.length === 1 ? '' : 's'} · ${dur(total)} worked · ${late} late</div>
    <div class="tablewrap"><table><thead><tr><th>Date</th>${isAdmin() ? '<th>Name</th>' : ''}<th>In</th><th>Out</th><th>Breaks</th><th>Worked</th><th>Status</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>
    ${rows.map((r) => `<tr class="${r.late ? 'late' : ''}"><td>${r.work_date}</td>${isAdmin() ? `<td>${esc(r.name)}</td>` : ''}<td>${fmtTime(r.punch_in)}</td><td>${r.punch_out ? fmtTime(r.punch_out) : '<span class="muted">—</span>'}</td><td>${dur(r.break_minutes)}</td><td><b>${dur(r.worked_minutes)}</b></td>
      <td>${r.late ? '<span class="chip s-orange">Late</span>' : '<span class="chip s-green">On time</span>'}${!r.punch_out ? ' <span class="chip">Open</span>' : ''}</td>
      ${isAdmin() ? `<td><button class="btn sm" data-edit="${r.id}">Edit</button></td>` : ''}</tr>`).join('') || `<tr><td colspan="8" class="empty">No attendance in this range.</td></tr>`}
    </tbody></table></div>`;
  $$('[data-edit]').forEach((b) => (b.onclick = () => attEditModal(rows.find((r) => r.id === Number(b.dataset.edit)))));
}

function attEditModal(r) {
  const m = openModal(`<h2>Edit attendance</h2><div class="muted small">${esc(r.name)} · ${r.work_date}</div>
    <div class="row"><div><label class="f">Punch in</label><input type="datetime-local" id="ei" value="${toLocalInput(r.punch_in)}" /></div>
    <div><label class="f">Punch out</label><input type="datetime-local" id="eo" value="${toLocalInput(r.punch_out)}" /></div></div>
    <div class="row"><div><label class="f">Break minutes</label><input type="number" id="eb" min="0" value="${r.break_minutes}" /></div>
    <div><label class="f">Late?</label><select id="el"><option value="false" ${!r.late ? 'selected' : ''}>No</option><option value="true" ${r.late ? 'selected' : ''}>Yes</option></select></div></div>
    <label class="f">Note</label><input type="text" id="en" value="${esc(r.note || '')}" />
    <div class="modal-actions"><button class="btn" id="ec">Cancel</button><button class="btn primary" id="es">Save</button></div>`);
  $('#ec', m).onclick = closeModal;
  $('#es', m).onclick = async () => {
    try {
      await api('/attendance/' + r.id, { method: 'PATCH', body: {
        punch_in: fromLocalInput($('#ei', m).value), punch_out: fromLocalInput($('#eo', m).value),
        break_minutes: Number($('#eb', m).value), late: $('#el', m).value === 'true', note: $('#en', m).value } });
      closeModal(); toast('Attendance updated'); loadView(true);
    } catch (e) { fail(e); }
  };
}

/* ----------------------------------------------------------------- admin */
async function viewAdmin(v) {
  await refreshUsers();
  state.rooms = await api('/rooms');
  const s = state.settings;
  v.innerHTML = `
  <div class="page-head"><h1>Admin</h1><a class="btn" href="/api/export/tasks">⬇ Export all tasks (CSV)</a></div>
  <div class="card" style="margin-bottom:14px"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Office spaces</h2><button class="btn primary sm noflex" id="addSpace">＋ Add space</button></div>
    <div class="spaces">${(state.rooms || []).map((r) => `<div class="space-chip" style="border-color:${esc(r.color)}"><span>${esc(r.icon)}</span><div style="flex:1;min-width:0"><b>${esc(r.name)}</b><div class="muted small">${r.member_count} assigned</div></div><button class="btn sm" data-space="${r.id}">Edit</button></div>`).join('')}</div></div>
  <div class="grid two" style="grid-template-columns:1fr 340px">
    <div class="card"><h2>Staff accounts</h2>
      <div class="tablewrap"><table><thead><tr><th>Name</th><th>Username</th><th>Dept</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
      ${state.users.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.username)}</td><td>${esc(u.department || '')}</td>
        <td>${u.role === 'admin' ? '<span class="chip" style="color:var(--brand)">Admin</span>' : 'Staff'}</td>
        <td>${u.active ? '<span class="chip s-green">Active</span>' : '<span class="chip">Disabled</span>'}</td>
        <td><button class="btn sm" data-pw="${u.id}">Reset password</button>
          ${u.id !== state.me.id ? `<button class="btn sm" data-tog="${u.id}">${u.active ? 'Disable' : 'Enable'}</button>
          <button class="btn sm" data-role="${u.id}">${u.role === 'admin' ? 'Make staff' : 'Make admin'}</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div></div>
    <div class="grid" style="align-content:start">
      <form class="card" id="newUser"><h2>Add staff member</h2>
        <label class="f">Full name</label><input type="text" id="nn" required />
        <label class="f">Username (for login)</label><input type="text" id="nu" required />
        <label class="f">Department (optional)</label><input type="text" id="nd" />
        <label class="f">Avatar</label><select id="nav">${AVATARS.map((a) => `<option>${a}</option>`).join('')}</select>
        <label class="f">Assign to space</label><select id="nsp"><option value="">— none (starts in the Lobby) —</option>${(state.rooms || []).map((r) => `<option value="${r.id}">${esc(r.icon)} ${esc(r.name)}</option>`).join('')}</select>
        <label class="f">Temporary password</label><input type="text" id="np" minlength="6" required />
        <label class="f">Role</label><select id="nr"><option value="staff">Staff</option><option value="admin">Admin</option></select>
        <button class="btn primary" style="margin-top:14px">Create account</button></form>
      <form class="card" id="settingsForm"><h2>Settings</h2>
        <label class="f">Company / app name</label><input type="text" id="sn" value="${esc(s.company_name)}" />
        <label class="f">Mark task RED if open longer than (hours)</label><input type="number" id="sr" min="0.5" step="0.5" value="${s.red_hours}" />
        <label class="f">Shift start time</label><input type="time" id="ss" value="${s.shift_start}" />
        <label class="f">Late grace (minutes)</label><input type="number" id="sg" min="0" value="${s.grace_minutes}" />
        <button class="btn primary" style="margin-top:14px">Save settings</button></form>
    </div>
  </div>`;
  $('#newUser').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/users', { method: 'POST', body: { name: $('#nn').value, username: $('#nu').value, department: $('#nd').value, password: $('#np').value, role: $('#nr').value, avatar: $('#nav').value, room_id: $('#nsp').value || undefined } });
      toast('Account created'); loadView();
    } catch (err) { fail(err); }
  };
  $('#settingsForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      state.settings = await api('/settings', { method: 'PUT', body: { company_name: $('#sn').value, red_hours: $('#sr').value, shift_start: $('#ss').value, grace_minutes: $('#sg').value } });
      renderShell(); toast('Settings saved'); loadView();
    } catch (err) { fail(err); }
  };
  $('#addSpace').onclick = () => roomEditModal(null, () => loadView());
  $$('[data-space]', v).forEach((b) => (b.onclick = () => roomEditModal(Number(b.dataset.space), () => loadView())));
  const byId = (id) => state.users.find((u) => u.id === Number(id));
  $$('[data-pw]', v).forEach((b) => (b.onclick = async () => {
    const u = byId(b.dataset.pw); const pw = prompt(`New password for ${u.name} (min 6 characters):`);
    if (!pw) return;
    try { await api('/users/' + u.id, { method: 'PATCH', body: { password: pw } }); toast('Password updated'); } catch (e) { fail(e); }
  }));
  $$('[data-tog]', v).forEach((b) => (b.onclick = async () => {
    const u = byId(b.dataset.tog);
    try { await api('/users/' + u.id, { method: 'PATCH', body: { active: !u.active } }); loadView(); } catch (e) { fail(e); }
  }));
  $$('[data-role]', v).forEach((b) => (b.onclick = async () => {
    const u = byId(b.dataset.role);
    if (!confirm(`Change ${u.name} to ${u.role === 'admin' ? 'staff' : 'admin'}?`)) return;
    try { await api('/users/' + u.id, { method: 'PATCH', body: { role: u.role === 'admin' ? 'staff' : 'admin' } }); loadView(); } catch (e) { fail(e); }
  }));
}

function passwordModal() {
  const m = openModal(`<h2>Change password</h2>
    <label class="f">Current password</label><input type="password" id="pc" autocomplete="current-password" />
    <label class="f">New password (min 6 characters)</label><input type="password" id="pn" autocomplete="new-password" />
    <div class="modal-actions"><button class="btn" id="pcancel">Cancel</button><button class="btn primary" id="psave">Update</button></div>`);
  $('#pcancel', m).onclick = closeModal;
  $('#psave', m).onclick = async () => {
    try { await api('/me/password', { method: 'POST', body: { current: $('#pc', m).value, next: $('#pn', m).value } }); closeModal(); toast('Password changed'); }
    catch (e) { fail(e); }
  };
}

/* ------------------------------------------------------------------ boot */
async function boot() {
  try {
    const me = await api('/me');
    state.me = me.user; state.settings = me.settings; state.tz = me.tz || state.tz;
    await refreshUsers();
    renderShell(); loadView(); startAutoRefresh(); officeConnect();
  } catch (e) { if (e.message !== 'auth') showLogin(); }
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
boot();
