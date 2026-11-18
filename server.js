const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const TZ = process.env.APP_TZ || 'Asia/Kolkata';
const IS_PROD = process.env.NODE_ENV === 'production';
const COOKIE = 'tf_token';

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[warn] JWT_SECRET not set - using a random one. Everyone is logged out on every restart.');
}

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const PRIORITY_WEIGHT = { low: 1, medium: 2, high: 3, urgent: 4 };
const STATUSES = ['pending', 'in_progress', 'completed'];

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: { 'upgrade-insecure-requests': null }, // keeps http://localhost testing working
  },
}));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* ---------------------------------------------------------------- helpers */

function todayStr(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

// Start of "today" (midnight) in the app time zone, as a Date.
function startOfTodayTZ() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(now);
  const g = (t) => Number(parts.find((p) => p.type === t).value) % 24;
  return new Date(now.getTime() - ((g('hour') * 60 + g('minute')) * 60 + g('second')) * 1000);
}

function minutesOfDay(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

async function getSettings() {
  const defaults = { red_hours: '5', shift_start: '09:30', grace_minutes: '15', company_name: 'TeamFlow' };
  const { rows } = await db.query('SELECT key, value FROM settings');
  const s = { ...defaults };
  rows.forEach((r) => (s[r.key] = r.value));
  return {
    red_hours: Number(s.red_hours),
    shift_start: s.shift_start,
    grace_minutes: Number(s.grace_minutes),
    company_name: s.company_name,
  };
}

function decorateTask(t, redHours) {
  const now = Date.now();
  const created = new Date(t.created_at).getTime();
  const out = { ...t, age_minutes: Math.floor((now - created) / 60000) };
  if (t.status === 'completed') {
    out.health = 'green';
    out.red_reason = null;
    return out;
  }
  const overdue = t.due_at && new Date(t.due_at).getTime() < now;
  const aged = now - created > redHours * 3600 * 1000;
  if (overdue) { out.health = 'red'; out.red_reason = 'overdue'; }
  else if (aged) { out.health = 'red'; out.red_reason = 'aged'; }
  else { out.health = t.status === 'in_progress' ? 'yellow' : 'orange'; out.red_reason = null; }
  return out;
}

const TASK_SELECT = `
  SELECT t.*, a.name AS assignee_name, a.username AS assignee_username,
         c.name AS creator_name
  FROM tasks t
  JOIN users a ON a.id = t.assignee_id
  JOIN users c ON c.id = t.creator_id`;

async function logEvent(taskId, userId, kind, body) {
  await db.query('INSERT INTO task_events (task_id, user_id, kind, body) VALUES ($1,$2,$3,$4)', [
    taskId, userId, kind, body,
  ]);
}

function workedMinutes(r) {
  if (!r.punch_in) return 0;
  const start = new Date(r.punch_in).getTime();
  const end = r.punch_out ? new Date(r.punch_out).getTime() : Date.now();
  let brk = r.break_minutes || 0;
  if (r.break_started_at && !r.punch_out) brk += Math.floor((Date.now() - new Date(r.break_started_at).getTime()) / 60000);
  return Math.max(0, Math.floor((end - start) / 60000) - brk);
}

function attendanceState(r) {
  if (!r || !r.punch_in) return 'not_in';
  if (r.punch_out) return 'done';
  if (r.break_started_at) return 'on_break';
  return 'working';
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(headers, rows) {
  return [headers.join(','), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\n');
}

/* ------------------------------------------------------------------- auth */

const attempts = new Map();
function rateLimited(key) {
  const now = Date.now();
  const rec = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(key, rec);
  return rec.length >= 10;
}

function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, department: u.department, active: u.active };
}

async function auth(req, res, next) {
  try {
    const token = req.cookies[COOKIE];
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [payload.id]);
    const u = rows[0];
    if (!u || !u.active) return res.status(401).json({ error: 'Account disabled' });
    req.user = u;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Session expired, please log in again' });
  }
}
const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });

app.post('/api/login', wrap(async (req, res) => {
  const username = clean(req.body.username, 60).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const key = req.ip + '|' + username;
  if (rateLimited(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const { rows } = await db.query('SELECT * FROM users WHERE username=$1', [username]);
  const u = rows[0];
  if (!u || !u.active || !(await bcrypt.compare(password, u.password_hash))) {
    attempts.get(key).push(Date.now());
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  const token = jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '14d' });
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 14 * 24 * 3600 * 1000,
  });
  res.json({ user: publicUser(u), settings: await getSettings() });
}));

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.get('/api/me', auth, wrap(async (req, res) => {
  res.json({ user: publicUser(req.user), settings: await getSettings(), tz: TZ });
}));

app.post('/api/me/password', auth, wrap(async (req, res) => {
  const { current, next: nextPw } = req.body;
  if (typeof nextPw !== 'string' || nextPw.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  if (!(await bcrypt.compare(current || '', req.user.password_hash))) return res.status(400).json({ error: 'Current password is wrong' });
  await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(nextPw, 10), req.user.id]);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ users */

app.get('/api/users', auth, wrap(async (req, res) => {
  const where = req.user.role === 'admin' ? '' : 'WHERE active = TRUE';
  const { rows } = await db.query(`SELECT id, username, name, role, department, active, created_at FROM users ${where} ORDER BY active DESC, name`);
  res.json(rows);
}));

app.post('/api/users', auth, adminOnly, wrap(async (req, res) => {
  const username = clean(req.body.username, 40).toLowerCase().replace(/\s+/g, '');
  const name = clean(req.body.name, 80);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const role = req.body.role === 'admin' ? 'admin' : 'staff';
  const department = clean(req.body.department, 60);
  if (!username || !name) return res.status(400).json({ error: 'Name and username are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const dup = await db.query('SELECT 1 FROM users WHERE username=$1', [username]);
  if (dup.rows.length) return res.status(409).json({ error: 'Username already taken' });
  const { rows } = await db.query(
    'INSERT INTO users (username, name, password_hash, role, department) VALUES ($1,$2,$3,$4,$5) RETURNING id, username, name, role, department, active',
    [username, name, await bcrypt.hash(password, 10), role, department]
  );
  res.status(201).json(rows[0]);
}));

app.patch('/api/users/:id', auth, adminOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [id]);
  const u = rows[0];
  if (!u) return res.status(404).json({ error: 'User not found' });
  const sets = []; const vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (req.body.name !== undefined) add('name', clean(req.body.name, 80) || u.name);
  if (req.body.department !== undefined) add('department', clean(req.body.department, 60));
  if (req.body.role !== undefined) {
    const role = req.body.role === 'admin' ? 'admin' : 'staff';
    if (id === req.user.id && role !== 'admin') return res.status(400).json({ error: "You can't remove your own admin role" });
    add('role', role);
  }
  if (req.body.active !== undefined) {
    if (id === req.user.id && !req.body.active) return res.status(400).json({ error: "You can't deactivate yourself" });
    add('active', !!req.body.active);
  }
  if (req.body.password) {
    if (String(req.body.password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    add('password_hash', await bcrypt.hash(String(req.body.password), 10));
  }
  if (!sets.length) return res.json(publicUser(u));
  vals.push(id);
  const r = await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING id, username, name, role, department, active`, vals);
  res.json(r.rows[0]);
}));

/* ------------------------------------------------------------- attendance */

async function todayRecord(userId) {
  const { rows } = await db.query('SELECT * FROM attendance WHERE user_id=$1 AND work_date=$2', [userId, todayStr()]);
  return rows[0];
}
function attView(r) {
  return r ? { ...r, state: attendanceState(r), worked_minutes: workedMinutes(r) } : { state: 'not_in', worked_minutes: 0 };
}

app.get('/api/attendance/me', auth, wrap(async (req, res) => {
  res.json(attView(await todayRecord(req.user.id)));
}));

app.post('/api/attendance/punch-in', auth, wrap(async (req, res) => {
  const existing = await todayRecord(req.user.id);
  if (existing && existing.punch_in) return res.status(400).json({ error: "You've already punched in today" });
  const s = await getSettings();
  const [h, m] = s.shift_start.split(':').map(Number);
  const late = minutesOfDay() > h * 60 + m + s.grace_minutes;
  const note = clean(req.body.note, 200);
  const { rows } = await db.query(
    `INSERT INTO attendance (user_id, work_date, punch_in, late, note) VALUES ($1,$2,now(),$3,$4)
     ON CONFLICT (user_id, work_date) DO UPDATE SET punch_in=now(), late=$3, note=$4 RETURNING *`,
    [req.user.id, todayStr(), late, note]
  );
  res.json(attView(rows[0]));
}));

app.post('/api/attendance/punch-out', auth, wrap(async (req, res) => {
  const r = await todayRecord(req.user.id);
  if (!r || !r.punch_in) return res.status(400).json({ error: "You haven't punched in today" });
  if (r.punch_out) return res.status(400).json({ error: "You've already punched out" });
  let extra = 0;
  if (r.break_started_at) extra = Math.floor((Date.now() - new Date(r.break_started_at).getTime()) / 60000);
  const { rows } = await db.query(
    'UPDATE attendance SET punch_out=now(), break_started_at=NULL, break_minutes=break_minutes+$1 WHERE id=$2 RETURNING *',
    [extra, r.id]
  );
  res.json(attView(rows[0]));
}));

app.post('/api/attendance/break-start', auth, wrap(async (req, res) => {
  const r = await todayRecord(req.user.id);
  if (!r || !r.punch_in || r.punch_out) return res.status(400).json({ error: 'You are not currently punched in' });
  if (r.break_started_at) return res.status(400).json({ error: 'Break already running' });
  const { rows } = await db.query('UPDATE attendance SET break_started_at=now() WHERE id=$1 RETURNING *', [r.id]);
  res.json(attView(rows[0]));
}));

app.post('/api/attendance/break-end', auth, wrap(async (req, res) => {
  const r = await todayRecord(req.user.id);
  if (!r || !r.break_started_at) return res.status(400).json({ error: 'No break is running' });
  const mins = Math.floor((Date.now() - new Date(r.break_started_at).getTime()) / 60000);
  const { rows } = await db.query(
    'UPDATE attendance SET break_started_at=NULL, break_minutes=break_minutes+$1 WHERE id=$2 RETURNING *', [mins, r.id]);
  res.json(attView(rows[0]));
}));

// Today's board: everyone can see who is in.
app.get('/api/attendance/board', auth, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.id AS user_id, u.name, u.department, a.punch_in, a.punch_out, a.break_started_at, a.break_minutes, a.late
     FROM users u LEFT JOIN attendance a ON a.user_id=u.id AND a.work_date=$1
     WHERE u.active = TRUE ORDER BY u.name`, [todayStr()]);
  res.json(rows.map((r) => ({ ...r, state: attendanceState(r), worked_minutes: workedMinutes(r) })));
}));

async function reportRows(req) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : todayStr(new Date(Date.now() - 29 * 86400000));
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : todayStr();
  let userId = req.query.user_id ? Number(req.query.user_id) : null;
  if (req.user.role !== 'admin') userId = req.user.id; // staff only see their own history
  const vals = [from, to]; let extra = '';
  if (userId) { vals.push(userId); extra = ` AND a.user_id=$${vals.length}`; }
  const { rows } = await db.query(
    `SELECT a.id, a.user_id, u.name, u.department, a.work_date, a.punch_in, a.punch_out, a.break_minutes, a.late, a.note, a.break_started_at
     FROM attendance a JOIN users u ON u.id=a.user_id
     WHERE a.work_date >= $1 AND a.work_date <= $2${extra} ORDER BY a.work_date DESC, u.name`, vals);
  return rows.map((r) => ({ ...r, worked_minutes: workedMinutes(r) }));
}

app.get('/api/attendance/report', auth, wrap(async (req, res) => {
  const rows = await reportRows(req);
  if (req.query.format === 'csv') {
    const data = rows.map((r) => ({
      date: r.work_date, name: r.name, department: r.department,
      punch_in: r.punch_in, punch_out: r.punch_out, break_minutes: r.break_minutes,
      worked_hours: (r.worked_minutes / 60).toFixed(2), late: r.late ? 'yes' : 'no', note: r.note,
    }));
    res.type('text/csv').attachment('attendance.csv').send(toCsv(Object.keys(data[0] || { date: 1, name: 1, department: 1, punch_in: 1, punch_out: 1, break_minutes: 1, worked_hours: 1, late: 1, note: 1 }), data));
    return;
  }
  res.json(rows);
}));

// Admin fix for a forgotten punch.
app.patch('/api/attendance/:id', auth, adminOnly, wrap(async (req, res) => {
  const sets = []; const vals = [];
  const add = (c, v, cast = '') => { vals.push(v); sets.push(`${c}=$${vals.length}${cast}`); };
  if ('punch_in' in req.body) add('punch_in', req.body.punch_in || null, '::timestamptz');
  if ('punch_out' in req.body) add('punch_out', req.body.punch_out || null, '::timestamptz');
  if ('break_minutes' in req.body) add('break_minutes', Math.max(0, parseInt(req.body.break_minutes, 10) || 0));
  if ('late' in req.body) add('late', !!req.body.late);
  if ('note' in req.body) add('note', clean(req.body.note, 200));
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(Number(req.params.id));
  const { rows } = await db.query(`UPDATE attendance SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals);
  if (!rows[0]) return res.status(404).json({ error: 'Record not found' });
  res.json(rows[0]);
}));

/* ------------------------------------------------------------------ tasks */

app.get('/api/tasks', auth, wrap(async (req, res) => {
  const s = await getSettings();
  const vals = []; const where = [];
  if (req.query.assignee_id) { vals.push(Number(req.query.assignee_id)); where.push(`t.assignee_id=$${vals.length}`); }
  if (req.query.creator_id) { vals.push(Number(req.query.creator_id)); where.push(`t.creator_id=$${vals.length}`); }
  if (req.query.priority && PRIORITIES.includes(req.query.priority)) { vals.push(req.query.priority); where.push(`t.priority=$${vals.length}`); }
  const st = req.query.status;
  if (st === 'open') where.push(`t.status <> 'completed'`);
  else if (STATUSES.includes(st)) { vals.push(st); where.push(`t.status=$${vals.length}`); }
  if (req.query.q) { vals.push('%' + clean(req.query.q, 80).toLowerCase() + '%'); where.push(`(LOWER(t.title) LIKE $${vals.length} OR LOWER(t.description) LIKE $${vals.length})`); }
  const sql = `${TASK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.created_at DESC LIMIT 1000`;
  const { rows } = await db.query(sql, vals);
  let tasks = rows.map((t) => decorateTask(t, s.red_hours));
  if (['red', 'yellow', 'orange', 'green'].includes(req.query.health)) tasks = tasks.filter((t) => t.health === req.query.health);
  tasks.sort((a, b) => {
    const ad = a.status === 'completed' ? 1 : 0; const bd = b.status === 'completed' ? 1 : 0;
    if (ad !== bd) return ad - bd;
    if (ad === 0) {
      const ar = a.health === 'red' ? 1 : 0; const br = b.health === 'red' ? 1 : 0;
      if (ar !== br) return br - ar;
      if (PRIORITY_WEIGHT[a.priority] !== PRIORITY_WEIGHT[b.priority]) return PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
      return new Date(a.created_at) - new Date(b.created_at);
    }
    return new Date(b.completed_at) - new Date(a.completed_at);
  });
  res.json(tasks);
}));

app.get('/api/tasks/:id', auth, wrap(async (req, res) => {
  const s = await getSettings();
  const { rows } = await db.query(`${TASK_SELECT} WHERE t.id=$1`, [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
  const ev = await db.query(
    `SELECT e.id, e.kind, e.body, e.created_at, u.name AS user_name FROM task_events e JOIN users u ON u.id=e.user_id
     WHERE e.task_id=$1 ORDER BY e.created_at, e.id`, [Number(req.params.id)]);
  res.json({ ...decorateTask(rows[0], s.red_hours), events: ev.rows });
}));

app.post('/api/tasks', auth, wrap(async (req, res) => {
  const title = clean(req.body.title, 200);
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : 'medium';
  const assignee = Number(req.body.assignee_id) || req.user.id;
  const a = await db.query('SELECT id, name FROM users WHERE id=$1 AND active=TRUE', [assignee]);
  if (!a.rows[0]) return res.status(400).json({ error: 'Assignee not found' });
  let due = null;
  if (req.body.due_at) {
    const d = new Date(req.body.due_at);
    if (isNaN(d)) return res.status(400).json({ error: 'Invalid due date' });
    due = d.toISOString();
  }
  const { rows } = await db.query(
    `INSERT INTO tasks (title, description, priority, creator_id, assignee_id, due_at)
     VALUES ($1,$2,$3,$4,$5,$6::timestamptz) RETURNING id`,
    [title, clean(req.body.description, 4000), priority, req.user.id, assignee, due]);
  await logEvent(rows[0].id, req.user.id, 'event',
    assignee === req.user.id ? 'Created the task' : `Created the task and assigned it to ${a.rows[0].name}`);
  const s = await getSettings();
  const t = await db.query(`${TASK_SELECT} WHERE t.id=$1`, [rows[0].id]);
  res.status(201).json(decorateTask(t.rows[0], s.red_hours));
}));

app.patch('/api/tasks/:id', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.query('SELECT * FROM tasks WHERE id=$1', [id]);
  const t = cur.rows[0];
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const isAdmin = req.user.role === 'admin';
  if (!isAdmin && t.creator_id !== req.user.id && t.assignee_id !== req.user.id)
    return res.status(403).json({ error: 'Only the assignee, the creator or an admin can change this task' });

  const sets = ['updated_at=now()']; const vals = [];
  const add = (c, v, cast = '') => { vals.push(v); sets.push(`${c}=$${vals.length}${cast}`); };
  const events = [];

  if (req.body.title !== undefined) { const v = clean(req.body.title, 200); if (v) add('title', v); }
  if (req.body.description !== undefined) add('description', clean(req.body.description, 4000));
  if (req.body.due_at !== undefined) {
    if (req.body.due_at === null || req.body.due_at === '') add('due_at', null, '::timestamptz');
    else { const d = new Date(req.body.due_at); if (isNaN(d)) return res.status(400).json({ error: 'Invalid due date' }); add('due_at', d.toISOString(), '::timestamptz'); }
  }
  if (req.body.priority !== undefined && req.body.priority !== t.priority) {
    if (!PRIORITIES.includes(req.body.priority)) return res.status(400).json({ error: 'Invalid priority' });
    add('priority', req.body.priority);
    events.push(['event', `Changed priority from ${t.priority} to ${req.body.priority}`]);
  }
  if (req.body.assignee_id !== undefined && Number(req.body.assignee_id) !== t.assignee_id) {
    const a = await db.query('SELECT id, name FROM users WHERE id=$1 AND active=TRUE', [Number(req.body.assignee_id)]);
    if (!a.rows[0]) return res.status(400).json({ error: 'Assignee not found' });
    add('assignee_id', a.rows[0].id);
    events.push(['event', `Reassigned to ${a.rows[0].name}`]);
  }
  if (req.body.status !== undefined && req.body.status !== t.status) {
    if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
    add('status', req.body.status);
    if (req.body.status === 'completed') add('completed_at', new Date().toISOString(), '::timestamptz');
    else sets.push('completed_at=NULL');
    if (req.body.status === 'in_progress' && !t.started_at) add('started_at', new Date().toISOString(), '::timestamptz');
    const label = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed' };
    events.push(['event', req.body.status === 'completed' ? 'Marked as completed' : `Status set to ${label[req.body.status]}`]);
  }
  vals.push(id);
  await db.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
  for (const [k, b] of events) await logEvent(id, req.user.id, k, b);
  const s = await getSettings();
  const out = await db.query(`${TASK_SELECT} WHERE t.id=$1`, [id]);
  res.json(decorateTask(out.rows[0], s.red_hours));
}));

app.delete('/api/tasks/:id', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.query('SELECT creator_id FROM tasks WHERE id=$1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
  if (req.user.role !== 'admin' && rows[0].creator_id !== req.user.id)
    return res.status(403).json({ error: 'Only the creator or an admin can delete a task' });
  await db.query('DELETE FROM tasks WHERE id=$1', [id]);
  res.json({ ok: true });
}));

app.post('/api/tasks/:id/comments', auth, wrap(async (req, res) => {
  const body = clean(req.body.body, 2000);
  if (!body) return res.status(400).json({ error: 'Comment is empty' });
  const { rows } = await db.query('SELECT 1 FROM tasks WHERE id=$1', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
  await logEvent(Number(req.params.id), req.user.id, 'comment', body);
  res.status(201).json({ ok: true });
}));

/* ---------------------------------------------------------------- summary */

// Per-person counts, visible to everyone.
app.get('/api/summary', auth, wrap(async (req, res) => {
  const s = await getSettings();
  const cutoff = new Date(Date.now() - s.red_hours * 3600 * 1000).toISOString();
  const { rows } = await db.query(
    `SELECT u.id AS user_id, u.name, u.department,
       COUNT(t.id) FILTER (WHERE t.status='pending')::int AS pending,
       COUNT(t.id) FILTER (WHERE t.status='in_progress')::int AS in_progress,
       COUNT(t.id) FILTER (WHERE t.status='completed')::int AS completed,
       COUNT(t.id) FILTER (WHERE t.status<>'completed' AND (t.created_at < $1::timestamptz OR (t.due_at IS NOT NULL AND t.due_at < now())))::int AS red,
       COUNT(t.id) FILTER (WHERE t.status<>'completed' AND t.priority IN ('high','urgent'))::int AS high_priority,
       COUNT(t.id) FILTER (WHERE t.status='completed' AND t.completed_at >= $2::timestamptz)::int AS done_today
     FROM users u LEFT JOIN tasks t ON t.assignee_id=u.id
     WHERE u.active=TRUE GROUP BY u.id, u.name, u.department ORDER BY u.name`,
    [cutoff, startOfTodayTZ().toISOString()]);
  const totals = rows.reduce((a, r) => {
    for (const k of ['pending', 'in_progress', 'completed', 'red', 'high_priority', 'done_today']) a[k] += r[k];
    return a;
  }, { pending: 0, in_progress: 0, completed: 0, red: 0, high_priority: 0, done_today: 0 });
  res.json({ people: rows, totals });
}));

/* --------------------------------------------------------- admin settings */

app.get('/api/settings', auth, wrap(async (req, res) => res.json(await getSettings())));

app.put('/api/settings', auth, adminOnly, wrap(async (req, res) => {
  const b = req.body; const out = {};
  if (b.red_hours !== undefined) {
    const n = Number(b.red_hours);
    if (!(n > 0 && n <= 720)) return res.status(400).json({ error: 'Red-flag hours must be between 0 and 720' });
    out.red_hours = String(n);
  }
  if (b.shift_start !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.shift_start)) return res.status(400).json({ error: 'Shift start must be HH:MM' });
    out.shift_start = b.shift_start;
  }
  if (b.grace_minutes !== undefined) {
    const n = parseInt(b.grace_minutes, 10);
    if (!(n >= 0 && n <= 240)) return res.status(400).json({ error: 'Grace minutes must be 0-240' });
    out.grace_minutes = String(n);
  }
  if (b.company_name !== undefined) out.company_name = clean(b.company_name, 40) || 'TeamFlow';
  for (const [k, v] of Object.entries(out))
    await db.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, v]);
  res.json(await getSettings());
}));

app.get('/api/export/tasks', auth, adminOnly, wrap(async (req, res) => {
  const s = await getSettings();
  const { rows } = await db.query(`${TASK_SELECT} ORDER BY t.created_at DESC`);
  const data = rows.map((t) => decorateTask(t, s.red_hours)).map((t) => ({
    id: t.id, title: t.title, priority: t.priority, status: t.status, colour: t.health,
    assignee: t.assignee_name, created_by: t.creator_name, created_at: t.created_at,
    due_at: t.due_at, started_at: t.started_at, completed_at: t.completed_at, description: t.description,
  }));
  const headers = ['id', 'title', 'priority', 'status', 'colour', 'assignee', 'created_by', 'created_at', 'due_at', 'started_at', 'completed_at', 'description'];
  res.type('text/csv').attachment('tasks.csv').send(toCsv(headers, data));
}));

/* ------------------------------------------------------------ static/boot */

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

async function seedAdmin() {
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM users WHERE role='admin'");
  if (rows[0].n > 0) return;
  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const name = process.env.ADMIN_NAME || 'Admin';
  await db.query('INSERT INTO users (username, name, password_hash, role) VALUES ($1,$2,$3,$4)', [
    username, name, await bcrypt.hash(password, 10), 'admin',
  ]);
  console.log(`[setup] Admin created -> username: ${username}`);
  if (!process.env.ADMIN_PASSWORD) console.warn('[warn] Using default admin password "admin123". Change it after first login!');
}

async function start() {
  await db.init();
  await seedAdmin();
  const server = app.listen(PORT, () => console.log(`TeamFlow running on port ${PORT} (db: ${db.kind()}, tz: ${TZ})`));
  return server;
}

if (require.main === module) start().catch((e) => { console.error(e); process.exit(1); });
module.exports = { app, start };
