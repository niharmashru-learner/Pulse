// Virtual-office routes: spaces (rooms), who is assigned where, room details.
const KINDS = ['lobby', 'work', 'meeting', 'break', 'private', 'custom'];

const DEFAULT_ROOMS = [
  { name: 'Lobby', kind: 'lobby', icon: '🏢', color: '#6366f1', x: 380, y: 235, w: 240, h: 175,
    description: 'The heart of the office. Say hi, grab a coffee chat, and check the announcements.', announcement: 'Welcome to our virtual office! Walk around by clicking the floor 🚶' },
  { name: 'Work Zone A', kind: 'work', icon: '💻', color: '#0ea5e9', x: 20, y: 20, w: 340, h: 205,
    description: 'Heads-down space for the first team. Assigned members sit here.', announcement: '' },
  { name: 'Work Zone B', kind: 'work', icon: '🎨', color: '#10b981', x: 640, y: 20, w: 340, h: 205,
    description: 'Heads-down space for the second team. Assigned members sit here.', announcement: '' },
  { name: 'Meeting Room', kind: 'meeting', icon: '📅', color: '#f59e0b', x: 20, y: 425, w: 340, h: 195,
    description: 'Walk in to talk things through. Chat here stays with the room.', announcement: '' },
  { name: 'Café & Break Room', kind: 'break', icon: '☕', color: '#ec4899', x: 640, y: 425, w: 340, h: 195,
    description: 'Recharge, chat about anything except work. You earned it!', announcement: 'Friday snacks are on the house 🍪' },
  { name: "Admin's Cabin", kind: 'private', icon: '👑', color: '#8b5cf6', x: 380, y: 20, w: 240, h: 175,
    description: 'The boss\'s cabin. Knock before entering 😉', announcement: '' },
];

module.exports = function mount(app, d) {
  const { db, auth, adminOnly, wrap, clean, rt, decorateTask, getSettings, TASK_SELECT, attendanceState, todayStr } = d;

  async function loadRooms() {
    const { rows } = await db.query(
      `SELECT r.id, r.name, r.kind, r.icon, r.color, r.description, r.announcement, r.x, r.y, r.w, r.h,
        (SELECT COUNT(*) FROM room_members m WHERE m.room_id=r.id)::int AS member_count
       FROM rooms r ORDER BY r.id`);
    return rows;
  }
  async function refreshRooms() {
    const rows = await loadRooms();
    rt.setRooms(rows);
    return rows;
  }
  async function seed() {
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM rooms');
    if (!rows[0].n) {
      for (const r of DEFAULT_ROOMS) {
        await db.query(
          'INSERT INTO rooms (name, kind, icon, color, description, announcement, x, y, w, h) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [r.name, r.kind, r.icon, r.color, r.description, r.announcement, r.x, r.y, r.w, r.h]);
      }
      // the first admin lives in the admin's cabin
      const cabin = await db.query("SELECT id FROM rooms WHERE kind='private' ORDER BY id LIMIT 1");
      const admins = await db.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
      if (cabin.rows[0] && admins.rows[0])
        await db.query('INSERT INTO room_members (room_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [cabin.rows[0].id, admins.rows[0].id]);
    }
    return refreshRooms();
  }

  const int = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
  function fields(b, cur = {}) {
    const o = {};
    o.name = b.name !== undefined ? clean(b.name, 40) : cur.name;
    if (!o.name) return { error: 'Space name is required' };
    o.kind = KINDS.includes(b.kind) ? b.kind : (cur.kind || 'custom');
    o.icon = b.icon !== undefined ? (clean(b.icon, 8) || '🏠') : (cur.icon || '🏠');
    o.color = /^#[0-9a-fA-F]{6}$/.test(b.color || '') ? b.color : (cur.color || '#6366f1');
    o.description = b.description !== undefined ? clean(b.description, 1000) : (cur.description || '');
    o.announcement = b.announcement !== undefined ? clean(b.announcement, 500) : (cur.announcement || '');
    o.w = int(b.w, 80, 1000, cur.w || 300);
    o.h = int(b.h, 80, 640, cur.h || 180);
    o.x = int(b.x, 0, 1000 - o.w, cur.x || 0);
    o.y = int(b.y, 0, 640 - o.h, cur.y || 0);
    return { o };
  }

  async function setMembers(roomId, ids) {
    const clean_ids = [...new Set((ids || []).map(Number).filter(Boolean))];
    await db.query('DELETE FROM room_members WHERE room_id=$1', [roomId]);
    for (const uid of clean_ids)
      await db.query('INSERT INTO room_members (room_id, user_id) SELECT $1, id FROM users WHERE id=$2 ON CONFLICT DO NOTHING', [roomId, uid]);
  }

  app.get('/api/rooms', auth, wrap(async (req, res) => res.json(await loadRooms())));

  app.get('/api/rooms/:id', auth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const rr = await db.query('SELECT * FROM rooms WHERE id=$1', [id]);
    if (!rr.rows[0]) return res.status(404).json({ error: 'Space not found' });
    const s = await getSettings();
    const cutoff = new Date(Date.now() - s.red_hours * 3600 * 1000).toISOString();
    const mem = await db.query(
      `SELECT u.id, u.name, u.avatar, u.department,
        COUNT(t.id) FILTER (WHERE t.status='pending')::int AS pending,
        COUNT(t.id) FILTER (WHERE t.status='in_progress')::int AS in_progress,
        COUNT(t.id) FILTER (WHERE t.status<>'completed' AND (t.created_at < $2::timestamptz OR (t.due_at IS NOT NULL AND t.due_at < now())))::int AS red
       FROM room_members m JOIN users u ON u.id=m.user_id AND u.active=TRUE
       LEFT JOIN tasks t ON t.assignee_id=u.id
       WHERE m.room_id=$1 GROUP BY u.id, u.name, u.avatar, u.department ORDER BY u.name`, [id, cutoff]);
    const att = await db.query('SELECT * FROM attendance WHERE work_date=$1', [todayStr()]);
    const attMap = Object.fromEntries(att.rows.map((a) => [a.user_id, attendanceState(a)]));
    const members = mem.rows.map((m) => ({ ...m, att: attMap[m.id] || 'not_in', online: rt.online().includes(m.id) }));

    const tk = await db.query(`${TASK_SELECT} WHERE t.room_id=$1 ORDER BY t.created_at DESC LIMIT 200`, [id]);
    let tasks = tk.rows.map((t) => decorateTask(t, s.red_hours));
    const open = tasks.filter((t) => t.status !== 'completed').sort((a, b) => (b.health === 'red') - (a.health === 'red'));
    const done = tasks.filter((t) => t.status === 'completed').slice(0, 8);
    tasks = [...open, ...done];

    const msgs = await db.query(
      `SELECT * FROM (SELECT m.id, m.body, m.created_at, u.id AS user_id, u.name, u.avatar FROM room_messages m JOIN users u ON u.id=m.user_id
        WHERE m.room_id=$1 ORDER BY m.id DESC LIMIT 40) x ORDER BY id`, [id]);
    res.json({ room: rr.rows[0], members, tasks, messages: msgs.rows });
  }));

  app.post('/api/rooms', auth, adminOnly, wrap(async (req, res) => {
    const f = fields(req.body);
    if (f.error) return res.status(400).json({ error: f.error });
    const o = f.o;
    const { rows } = await db.query(
      'INSERT INTO rooms (name, kind, icon, color, description, announcement, x, y, w, h) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [o.name, o.kind, o.icon, o.color, o.description, o.announcement, o.x, o.y, o.w, o.h]);
    if (Array.isArray(req.body.user_ids)) await setMembers(rows[0].id, req.body.user_ids);
    await refreshRooms(); rt.broadcast({ t: 'rooms_changed' });
    res.status(201).json({ id: rows[0].id });
  }));

  app.patch('/api/rooms/:id', auth, adminOnly, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const cur = await db.query('SELECT * FROM rooms WHERE id=$1', [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'Space not found' });
    const f = fields(req.body, cur.rows[0]);
    if (f.error) return res.status(400).json({ error: f.error });
    const o = f.o;
    await db.query('UPDATE rooms SET name=$1, kind=$2, icon=$3, color=$4, description=$5, announcement=$6, x=$7, y=$8, w=$9, h=$10 WHERE id=$11',
      [o.name, o.kind, o.icon, o.color, o.description, o.announcement, o.x, o.y, o.w, o.h, id]);
    if (Array.isArray(req.body.user_ids)) await setMembers(id, req.body.user_ids);
    await refreshRooms(); rt.broadcast({ t: 'rooms_changed' });
    if (o.announcement && o.announcement !== cur.rows[0].announcement) rt.feed(`New announcement in ${o.name}: ${o.announcement}`, '📢');
    res.json({ ok: true });
  }));

  app.delete('/api/rooms/:id', auth, adminOnly, wrap(async (req, res) => {
    const n = await db.query('SELECT COUNT(*)::int AS n FROM rooms');
    if (n.rows[0].n <= 1) return res.status(400).json({ error: 'You need at least one space' });
    await db.query('DELETE FROM rooms WHERE id=$1', [Number(req.params.id)]);
    await refreshRooms(); rt.broadcast({ t: 'rooms_changed' });
    res.json({ ok: true });
  }));

  app.put('/api/rooms/:id/members', auth, adminOnly, wrap(async (req, res) => {
    await setMembers(Number(req.params.id), req.body.user_ids);
    await refreshRooms(); rt.broadcast({ t: 'rooms_changed' });
    res.json({ ok: true });
  }));

  return { seed, refreshRooms };
};
