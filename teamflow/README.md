# TeamFlow

Staff attendance punch + shared team task board, with colour-coded task health, priorities and an admin panel.

## What it does

**Attendance**
- Punch in, start/end break, punch out (one tap each). Live "worked today" timer.
- Automatic **Late** flag based on shift start + grace minutes (admin sets both).
- "Who's in today" board visible to everyone.
- Attendance history: staff see their own, admin sees everyone, filter by date/person, **CSV download**, and admin can fix a forgotten punch.

**Tasks**
- Anyone can create a task and assign it to **any** person. Priority: Low / Medium / High / Urgent.
- Optional due date, details, comments and an activity timeline (who changed what, when).
- Assignee, creator or admin can **Start**, mark **Done** or **Reopen**.
- **Everyone can see everyone's tasks** and per-person counts (pending / in progress / completed / red, high-priority open, % done).

**Colour rules**
| Colour | Meaning |
|---|---|
| 🟢 Green | Completed |
| 🟡 Yellow | In progress |
| 🟠 Orange | Pending |
| 🔴 Red | Not completed **and** (open for more than the red limit — default **5 hours** — **or** past its due date) |

The 5-hour limit is editable by the admin (Admin → Settings). Red tasks are listed first and shown on the Home page under "Needs attention".

**Admin (you)**
- Create / disable staff, reset passwords, promote to admin.
- Settings: app name, red-flag hours, shift start, late grace.
- Export all tasks to CSV.


## Virtual office (live)

The **Office** tab is a real-time floor plan:
- Everyone who is logged in appears as an avatar and can **walk** (click the floor, or arrow keys / WASD). Movement, chat, reactions and status are live via WebSockets.
- Default spaces: Lobby, Work Zone A/B, Meeting Room, Café & Break Room, Admin's Cabin.
- **Click a room name** to open its panel: announcement, description, who is inside, assigned team (with task counts and online/attendance dots), the room's tasks (anyone can add a task for themselves or a teammate), and room chat (you must be inside the room to talk).
- Avatar ring colour shows attendance: green = working, yellow = on break, grey dashed = not punched in.
- Fun bits: pick your avatar, set a status (🎧 Focus, ☕ Coffee…), reactions that float over your head, wave at people, confetti when someone completes a task, and a live activity feed ("Asha just punched in", "Ravi completed …").

**Admin:** Admin → *Office spaces* to add, rename, recolour, move/resize rooms, post announcements and assign people. When adding a staff member you pick their avatar and their space; they start the day standing in it.

Note: the WebSocket works on Render's free plan, but a sleeping service disconnects everyone until the next visit wakes it.

## Run locally

```bash
npm install
npm start          # http://localhost:3000   (login: admin / admin123 unless ADMIN_PASSWORD is set)
npm test           # 38-check end-to-end smoke test (API + live WebSocket)
```
Locally it uses an embedded Postgres (stored in `./data`), so no database setup is needed.

## Put it on GitHub

```bash
cd teamflow
git init
git add .
git commit -m "TeamFlow: attendance + tasks"
git branch -M main
# create an empty repo on github.com first, then:
git remote add origin https://github.com/<your-username>/teamflow.git
git push -u origin main
```

## Deploy on Render

1. On render.com: **New → Blueprint** → connect your GitHub repo.
2. Render reads `render.yaml` and creates the web service **and** a Postgres database.
3. When asked, type a strong **ADMIN_PASSWORD** (this is your admin login; username is `admin`).
4. Click **Apply**. After the build, open the `https://teamflow-xxxx.onrender.com` URL and log in.

Notes
- Free web services sleep after inactivity (first load can take ~30–60 s).
- Render's **free Postgres expires after 30 days**. For real daily use, upgrade the database plan, or create a free permanent Postgres (e.g. Neon or Supabase) and paste its connection string into the `DATABASE_URL` environment variable.
- Change `APP_TZ` in the Render environment if your office is not in India (IANA name, e.g. `Asia/Dubai`).

## Environment variables

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (set automatically by `render.yaml`) |
| `JWT_SECRET` | Signs login cookies (auto-generated on Render) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_NAME` | First admin account, created on first start only |
| `APP_TZ` | Time zone for "today", late checks (default `Asia/Kolkata`) |

## Tech
Node.js + Express, PostgreSQL (`pg`; PGlite for local dev), bcrypt password hashing, JWT in an HTTP-only cookie, login rate-limiting, vanilla JS front-end (no build step).
