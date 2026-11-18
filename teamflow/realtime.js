// Real-time layer: WebSocket presence for the virtual office.
// Presence lives in memory (who is online, where they stand); chat is saved to the database.
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');

const WORLD = { w: 1000, h: 640 };
const REACTIONS = ['👋', '👏', '🎉', '❤️', '😂', '🔥', '☕', '👍'];

function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
const text = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

module.exports = function createRealtime({ secret, cookieName, db, getAttState }) {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Map();   // userId -> Set<ws>
  const presence = new Map();  // userId -> presence object
  let rooms = [];
  const feedLog = [];

  const roomAt = (x, y) => {
    // smallest room containing the point wins (so a small room can sit inside a big one)
    let best = null;
    for (const r of rooms) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h && (!best || r.w * r.h < best.w * best.h)) best = r;
    }
    return best ? best.id : null;
  };

  const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const set of sockets.values()) for (const ws of set) if (ws.readyState === 1) ws.send(data);
  }
  function sendTo(userId, msg) {
    for (const ws of sockets.get(userId) || []) send(ws, msg);
  }
  function feed(textLine, icon = '✨') {
    const item = { text: textLine, icon, at: Date.now() };
    feedLog.push(item); if (feedLog.length > 30) feedLog.shift();
    broadcast({ t: 'feed', ...item });
  }

  function spawnPoint(homeRoomId) {
    const r = rooms.find((x) => x.id === homeRoomId) || rooms.find((x) => x.kind === 'lobby') || rooms[0];
    if (!r) return { x: 500, y: 320 };
    return {
      x: Math.round(r.x + r.w / 2 + (Math.random() - 0.5) * Math.min(100, r.w * 0.4)),
      y: Math.round(r.y + r.h / 2 + (Math.random() - 0.5) * Math.min(60, r.h * 0.3)),
    };
  }

  async function onConnect(ws, user) {
    ws.alive = true; ws.userId = user.id; ws.lastMove = 0; ws.lastChat = 0;
    if (!sockets.has(user.id)) sockets.set(user.id, new Set());
    sockets.get(user.id).add(ws);

    let p = presence.get(user.id);
    const isNew = !p;
    if (isNew) {
      const home = await db.query('SELECT room_id FROM room_members WHERE user_id=$1 ORDER BY room_id LIMIT 1', [user.id]);
      const pos = spawnPoint(home.rows[0] && home.rows[0].room_id);
      const att = await getAttState(user.id).catch(() => 'not_in');
      p = {
        id: user.id, name: user.name, avatar: user.avatar || '🙂', department: user.department || '',
        role: user.role, x: pos.x, y: pos.y, room_id: roomAt(pos.x, pos.y), att,
        status_emoji: '', status_text: '',
      };
      presence.set(user.id, p);
    }
    send(ws, { t: 'hello', you: user.id, users: [...presence.values()], feed: feedLog.slice(-8), reactions: REACTIONS });
    if (isNew) { broadcast({ t: 'join', user: p }); feed(`${p.name} entered the office`, '🚪'); }

    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      handle(ws, p, m).catch((e) => console.error('ws error', e.message));
    });
    ws.on('close', () => {
      const set = sockets.get(user.id);
      if (set) { set.delete(ws); if (!set.size) { sockets.delete(user.id); presence.delete(user.id); broadcast({ t: 'leave', id: user.id }); } }
    });
  }

  async function handle(ws, p, m) {
    const cur = presence.get(p.id); if (!cur) return;
    switch (m.t) {
      case 'move': {
        const now = Date.now(); if (now - ws.lastMove < 40) return; ws.lastMove = now;
        cur.x = Math.round(num(m.x, 16, WORLD.w - 16)); cur.y = Math.round(num(m.y, 16, WORLD.h - 16));
        cur.room_id = roomAt(cur.x, cur.y);
        broadcast({ t: 'move', id: cur.id, x: cur.x, y: cur.y, room_id: cur.room_id });
        break;
      }
      case 'status':
        cur.status_emoji = text(m.emoji, 8); cur.status_text = text(m.text, 40);
        broadcast({ t: 'status', id: cur.id, status_emoji: cur.status_emoji, status_text: cur.status_text });
        break;
      case 'react':
        if (REACTIONS.includes(m.emoji)) broadcast({ t: 'react', id: cur.id, emoji: m.emoji });
        break;
      case 'wave': {
        const to = Number(m.to);
        if (presence.has(to) && to !== cur.id) sendTo(to, { t: 'wave', from: cur.name, avatar: cur.avatar, from_id: cur.id });
        break;
      }
      case 'chat': {
        const body = text(m.body, 400); const now = Date.now();
        if (!body || now - ws.lastChat < 600 || !cur.room_id) return;
        ws.lastChat = now;
        const r = await db.query('INSERT INTO room_messages (room_id, user_id, body) VALUES ($1,$2,$3) RETURNING id, created_at', [cur.room_id, cur.id, body]);
        broadcast({ t: 'chat', room_id: cur.room_id, id: cur.id, name: cur.name, avatar: cur.avatar, body, at: r.rows[0].created_at });
        break;
      }
      default:
    }
  }

  function attach(server) {
    server.on('upgrade', async (req, socket, head) => {
      try {
        if (!req.url.startsWith('/ws')) return socket.destroy();
        const token = parseCookies(req.headers.cookie)[cookieName];
        const payload = jwt.verify(token, secret);
        const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [payload.id]);
        const user = rows[0];
        if (!user || !user.active) return socket.destroy();
        wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, user));
      } catch (e) { socket.destroy(); }
    });
    const timer = setInterval(() => {
      for (const set of sockets.values()) for (const ws of set) {
        if (!ws.alive) { ws.terminate(); continue; }
        ws.alive = false; try { ws.ping(); } catch (e) { /* ignore */ }
      }
    }, 30000);
    timer.unref();
    server.on('close', () => { clearInterval(timer); wss.close(); });
  }

  return {
    attach, broadcast, sendTo, feed,
    setRooms(list) {
      rooms = list;
      for (const p of presence.values()) p.room_id = roomAt(p.x, p.y);
    },
    setAtt(userId, state) {
      const p = presence.get(userId);
      if (p) p.att = state;
      broadcast({ t: 'att', id: userId, state });
    },
    updateUser(userId, patch) {
      const p = presence.get(userId);
      if (p) { Object.assign(p, patch); broadcast({ t: 'profile', id: userId, ...patch }); }
    },
    kick(userId) { for (const ws of sockets.get(userId) || []) ws.close(); },
    online: () => [...presence.keys()],
  };
};
