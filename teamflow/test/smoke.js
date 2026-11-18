// End-to-end smoke test: boots the app on an in-memory database and exercises the main flows.
process.env.PGLITE_MEMORY = '1';
process.env.PORT = '0';
process.env.ADMIN_PASSWORD = 'adminpass1';
process.env.JWT_SECRET = 'test-secret';

const assert = require('assert');
const { start } = require('../server');
const db = require('../db');

function client(base) {
  let cookie = '';
  const fn = async (method, path, body) => {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  fn.cookie = () => cookie;
  return fn;
}

(async () => {
  const server = await start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = client(base), asha = client(base), ravi = client(base);
  let n = 0; const ok = (m) => console.log(`  ✓ ${m}`, ++n && '');

  // auth
  assert.strictEqual((await admin('POST', '/login', { username: 'admin', password: 'nope' })).status, 401); ok('bad login rejected');
  assert.strictEqual((await admin('POST', '/login', { username: 'admin', password: 'adminpass1' })).status, 200); ok('admin login');
  assert.strictEqual((await asha('GET', '/tasks')).status, 401); ok('API requires login');

  // users
  const a = await admin('POST', '/users', { name: 'Asha Rao', username: 'asha', password: 'secret1', department: 'Sales' });
  const r = await admin('POST', '/users', { name: 'Ravi Kumar', username: 'ravi', password: 'secret2' });
  assert.strictEqual(a.status, 201); assert.strictEqual(r.status, 201); ok('admin creates staff');
  assert.strictEqual((await asha('POST', '/login', { username: 'asha', password: 'secret1' })).status, 200);
  assert.strictEqual((await ravi('POST', '/login', { username: 'ravi', password: 'secret2' })).status, 200); ok('staff login');
  assert.strictEqual((await asha('POST', '/users', { name: 'x', username: 'x', password: 'secret1' })).status, 403); ok('staff cannot create users');

  // attendance
  let s = await asha('GET', '/attendance/me'); assert.strictEqual(s.body.state, 'not_in');
  s = await asha('POST', '/attendance/punch-in', {}); assert.strictEqual(s.body.state, 'working');
  assert.strictEqual((await asha('POST', '/attendance/punch-in', {})).status, 400); ok('punch in once per day');
  s = await asha('POST', '/attendance/break-start', {}); assert.strictEqual(s.body.state, 'on_break');
  s = await asha('POST', '/attendance/break-end', {}); assert.strictEqual(s.body.state, 'working');
  s = await asha('POST', '/attendance/punch-out', {}); assert.strictEqual(s.body.state, 'done'); ok('punch in / break / punch out');
  const board = await ravi('GET', '/attendance/board');
  assert.ok(board.body.find((b) => b.name === 'Asha Rao').state === 'done'); ok('everyone sees today board');
  const rep = await asha('GET', '/attendance/report');
  assert.ok(rep.body.every((x) => x.name === 'Asha Rao')); ok('staff only see own attendance report');
  const csv = await admin('GET', '/attendance/report?format=csv'); assert.ok(String(csv.body).includes('Asha Rao')); ok('attendance CSV');

  // tasks: anyone can assign to anyone
  const t1 = await asha('POST', '/tasks', { title: 'Call supplier', assignee_id: r.body.id, priority: 'urgent' });
  assert.strictEqual(t1.status, 201); assert.strictEqual(t1.body.health, 'orange'); assert.strictEqual(t1.body.assignee_name, 'Ravi Kumar'); ok('task assigned, starts orange (pending)');
  const id = t1.body.id;
  let p = await ravi('PATCH', `/tasks/${id}`, { status: 'in_progress' }); assert.strictEqual(p.body.health, 'yellow'); ok('in progress -> yellow');

  // red rule: age > red_hours, and overdue
  await db.query("UPDATE tasks SET created_at = now() - interval '6 hours' WHERE id=$1", [id]);
  let g = await asha('GET', `/tasks/${id}`); assert.strictEqual(g.body.health, 'red'); assert.strictEqual(g.body.red_reason, 'aged'); ok('open > 5h -> red');
  const t2 = await ravi('POST', '/tasks', { title: 'Past due', due_at: new Date(Date.now() - 3600e3).toISOString() });
  assert.strictEqual(t2.body.health, 'red'); assert.strictEqual(t2.body.red_reason, 'overdue'); ok('overdue -> red');

  // everyone sees counts
  let sum = await asha('GET', '/summary');
  const rv = sum.body.people.find((x) => x.name === 'Ravi Kumar');
  assert.strictEqual(rv.in_progress, 1); assert.strictEqual(rv.pending, 1); assert.strictEqual(rv.red, 2); ok('team counts visible to all staff');

  // permissions + completion
  const outsider = await asha('PATCH', `/tasks/${t2.body.id}`, { status: 'completed' });
  assert.strictEqual(outsider.status, 403); ok('third party cannot change someone else\'s task');
  p = await ravi('PATCH', `/tasks/${id}`, { status: 'completed' });
  assert.strictEqual(p.body.health, 'green'); ok('completed -> green');
  assert.strictEqual((await asha('POST', `/tasks/${id}/comments`, { body: 'Thanks!' })).status, 201);
  g = await ravi('GET', `/tasks/${id}`); assert.ok(g.body.events.length >= 3); ok('comments + activity timeline');
  assert.strictEqual((await asha('PATCH', `/tasks/${id}`, { priority: 'low' })).body.priority, 'low'); ok('creator can edit priority');

  // filters
  const open = await admin('GET', '/tasks?status=open'); assert.ok(open.body.every((t) => t.status !== 'completed'));
  const red = await admin('GET', '/tasks?health=red'); assert.ok(red.body.length === 1 && red.body[0].title === 'Past due'); ok('filters (open, red)');
  assert.strictEqual((await admin('GET', '/export/tasks')).status, 200); ok('admin task export');

  // settings
  const st = await admin('PUT', '/settings', { red_hours: 1 }); assert.strictEqual(st.body.red_hours, 1);
  assert.strictEqual((await asha('PUT', '/settings', { red_hours: 9 })).status, 403); ok('only admin edits settings');

  // admin controls
  assert.strictEqual((await admin('PATCH', `/users/${r.body.id}`, { active: false })).body.active, false);
  assert.strictEqual((await ravi('GET', '/tasks')).status, 401); ok('disabled user is locked out');
  assert.strictEqual((await admin('PATCH', '/users/1', { active: false })).status, 400); ok('admin cannot disable self');
  assert.strictEqual((await admin('DELETE', `/tasks/${id}`)).status, 200); ok('admin deletes task');


  // ---------- virtual office ----------
  const WebSocket = require('ws');
  const rooms = await admin('GET', '/rooms'); assert.ok(rooms.body.length >= 6); ok('default office spaces created');
  const work = rooms.body.find((x) => x.kind === 'work');
  const lobby = rooms.body.find((x) => x.kind === 'lobby');
  const mk = await admin('POST', '/rooms', { name: 'War Room', icon: '🚨', color: '#ff0000', kind: 'meeting', x: 10, y: 10, w: 100, h: 100, user_ids: [a.body.id] });
  assert.strictEqual(mk.status, 201); ok('admin creates a space and assigns people');
  assert.strictEqual((await asha('POST', '/rooms', { name: 'Nope' })).status, 403); ok('staff cannot create spaces');
  assert.strictEqual((await admin('PUT', `/rooms/${work.id}/members`, { user_ids: [a.body.id] })).status, 200);
  const nu = await admin('POST', '/users', { name: 'Meera Das', username: 'meera', password: 'secret3', avatar: '🦊', room_id: work.id });
  assert.strictEqual(nu.status, 201); assert.strictEqual(nu.body.avatar, '🦊'); ok('new account created with avatar + assigned space');

  // admin tasks in a room by a staff member for themselves
  const rt1 = await asha('POST', '/tasks', { title: 'My own room task', room_id: work.id });
  assert.strictEqual(rt1.status, 201);
  const detail = await asha('GET', `/rooms/${work.id}`);
  assert.strictEqual(detail.status, 200);
  assert.ok(detail.body.members.length === 2 && detail.body.tasks.some((t) => t.title === 'My own room task'));
  assert.ok(detail.body.members.find((m) => m.name === 'Asha Rao').pending >= 1); ok('room detail: members, counts and tasks');

  // websocket presence
  const openWs = (cl) => new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { Cookie: cl.cookie() } });
    ws.msgs = []; ws.on('message', (d) => ws.msgs.push(JSON.parse(d)));
    ws.on('open', () => resolve(ws)); ws.on('error', reject);
  });
  const waitFor = async (ws, pred, ms = 2500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = ws.msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout waiting for message'); };
  const bad = new WebSocket(base.replace('http', 'ws') + '/ws');
  await new Promise((r) => { bad.on('error', r); bad.on('close', r); }); ok('websocket rejects anonymous users');
  const w1 = await openWs(asha); const w2 = await openWs(admin);
  const hello = await waitFor(w1, (m) => m.t === 'hello'); assert.strictEqual(hello.you, a.body.id);
  await waitFor(w1, (m) => m.t === 'join' && m.user.name === 'Admin'); ok('presence: join broadcast');
  w1.send(JSON.stringify({ t: 'move', x: lobby.x + 50, y: lobby.y + 50 }));
  const mv = await waitFor(w2, (m) => m.t === 'move' && m.id === a.body.id && m.room_id === lobby.id); ok('movement is broadcast with the room detected');
  w1.send(JSON.stringify({ t: 'chat', body: 'Hello lobby!' }));
  await waitFor(w2, (m) => m.t === 'chat' && m.body === 'Hello lobby!');
  const hist = await admin('GET', `/rooms/${lobby.id}`); assert.ok(hist.body.messages.some((m) => m.body === 'Hello lobby!')); ok('room chat is live and saved');
  w1.send(JSON.stringify({ t: 'react', emoji: '🎉' })); await waitFor(w2, (m) => m.t === 'react' && m.emoji === '🎉'); ok('reactions broadcast');
  await asha('POST', '/attendance/punch-in', {}).catch(() => {});
  const t3 = await asha('POST', '/tasks', { title: 'Celebrate me', assignee_id: a.body.id });
  await asha('PATCH', `/tasks/${t3.body.id}`, { status: 'completed' });
  await waitFor(w2, (m) => m.t === 'celebrate' && m.title === 'Celebrate me'); ok('task completion celebrates live for everyone');
  const asg = await admin('POST', '/tasks', { title: 'For Asha', assignee_id: a.body.id });
  await waitFor(w1, (m) => m.t === 'toast' && /For Asha/.test(m.text)); ok('assignee gets a live notification');
  w1.close(); w2.close();

  console.log(`\nAll ${n} checks passed.`);
  server.close(); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
