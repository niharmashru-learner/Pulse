import os, secrets
from datetime import datetime, timedelta
from functools import wraps
from flask import Flask, render_template, request, redirect, url_for, flash, session, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_socketio import SocketIO, emit
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', secrets.token_hex(24))
db_url = os.getenv('DATABASE_URL', 'sqlite:///pulse.db')
if db_url.startswith('postgres://'): db_url = db_url.replace('postgres://', 'postgresql://', 1)
app.config['SQLALCHEMY_DATABASE_URI'] = db_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'pool_pre_ping': True}
db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins='*')

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    employee_id = db.Column(db.String(40), unique=True, nullable=False)
    name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(120), unique=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), default='staff')
    team = db.Column(db.String(80), default='General')
    presence = db.Column(db.String(20), default='Offline')
    last_seen = db.Column(db.DateTime, default=datetime.utcnow)
    active = db.Column(db.Boolean, default=True)

class Room(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    category = db.Column(db.String(40), default='Lobby')
    description = db.Column(db.String(240), default='A shared space for the team.')
    team = db.Column(db.String(80), default='All')

class Task(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(180), nullable=False)
    description = db.Column(db.Text, default='')
    creator_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    assignee_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    room_id = db.Column(db.Integer, db.ForeignKey('room.id'))
    priority = db.Column(db.String(20), default='Medium')
    status = db.Column(db.String(30), default='Pending')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    due_at = db.Column(db.DateTime)
    started_at = db.Column(db.DateTime)
    completed_at = db.Column(db.DateTime)
    blocked_reason = db.Column(db.Text, default='')
    creator = db.relationship('User', foreign_keys=[creator_id])
    assignee = db.relationship('User', foreign_keys=[assignee_id])
    room = db.relationship('Room')

class Routine(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    title = db.Column(db.String(160), nullable=False)
    done_today = db.Column(db.Boolean, default=False)


def current_user():
    return db.session.get(User, session.get('user_id')) if session.get('user_id') else None

def login_required(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        if not current_user(): return redirect(url_for('login'))
        return fn(*args, **kwargs)
    return wrapped

def admin_required(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        u=current_user()
        if not u: return redirect(url_for('login'))
        if u.role != 'admin': flash('Admin access required.', 'error'); return redirect(url_for('office'))
        return fn(*args, **kwargs)
    return wrapped

def task_age_hours(t):
    if t.status != 'In Progress' or not t.started_at: return 0
    return (datetime.utcnow()-t.started_at).total_seconds()/3600

def task_dict(t):
    return {'id':t.id,'title':t.title,'description':t.description,'status':t.status,'priority':t.priority,
            'assignee':t.assignee.name,'creator':t.creator.name,'room':t.room.name if t.room else 'My Desk',
            'created':t.created_at.strftime('%d %b, %H:%M'),'age_hours':round(task_age_hours(t),1),
            'aging':task_age_hours(t)>=5,'due':t.due_at.strftime('%d %b %H:%M') if t.due_at else None,
            'blocked_reason':t.blocked_reason}

@app.route('/login', methods=['GET','POST'])
def login():
    if request.method=='POST':
        username=request.form.get('username','').strip()
        password=request.form.get('password','')
        u=User.query.filter((User.employee_id==username)|(User.email==username)).first()
        if u and u.active and check_password_hash(u.password_hash,password):
            session['user_id']=u.id; u.presence='Online'; u.last_seen=datetime.utcnow(); db.session.commit()
            return redirect(url_for('office'))
        flash('Invalid credentials or account inactive.', 'error')
    return render_template('login.html')

@app.route('/logout')
def logout():
    u=current_user()
    if u: u.presence='Offline'; db.session.commit(); socketio.emit('presence_update', {'id':u.id,'presence':'Offline'})
    session.clear(); return redirect(url_for('login'))

@app.route('/')
@login_required
def office():
    u=current_user(); users=User.query.filter_by(active=True).order_by(User.name).all(); rooms=Room.query.order_by(Room.name).all()
    tasks=Task.query.order_by(Task.created_at.desc()).limit(150).all()
    my_tasks=[t for t in tasks if t.assignee_id==u.id]
    assigned_by_me=[t for t in tasks if t.creator_id==u.id]
    stats={'total':len(tasks),'pending':sum(t.status=='Pending' for t in tasks),'working':sum(t.status=='In Progress' for t in tasks),
           'done':sum(t.status=='Completed' for t in tasks),'blocked':sum(t.status=='Blocked' for t in tasks),
           'aging':sum(task_age_hours(t)>=5 for t in tasks),'online':sum(x.presence!='Offline' for x in users)}
    routines=Routine.query.filter_by(user_id=u.id).all()
    return render_template('office.html', user=u, users=users, rooms=rooms, tasks=tasks, my_tasks=my_tasks,
                         assigned_by_me=assigned_by_me, stats=stats, routines=routines, task_age_hours=task_age_hours)

@app.route('/task/create', methods=['POST'])
@login_required
def create_task():
    u=current_user(); title=request.form.get('title','').strip()
    if not title: flash('Task title is required.','error'); return redirect(url_for('office'))
    due=None
    try:
        if request.form.get('due'): due=datetime.strptime(request.form['due'],'%Y-%m-%dT%H:%M')
    except ValueError: pass
    assignee_id=int(request.form.get('assignee_id') or u.id)
    t=Task(title=title, description=request.form.get('description',''), creator_id=u.id, assignee_id=assignee_id,
            room_id=int(request.form.get('room_id')) if request.form.get('room_id') else None,
            priority=request.form.get('priority','Medium'), due_at=due)
    db.session.add(t); db.session.commit(); socketio.emit('task_update', {'type':'created','task':task_dict(t)})
    flash('Task created.','success'); return redirect(url_for('office'))

@app.route('/task/<int:task_id>/status', methods=['POST'])
@login_required
def task_status(task_id):
    t=Task.query.get_or_404(task_id); status=request.form.get('status','Pending')
    allowed=['Pending','In Progress','Blocked','Completed']
    if status not in allowed: return jsonify({'error':'invalid status'}),400
    if status=='In Progress' and t.status!='In Progress': t.started_at=datetime.utcnow()
    if status=='Completed': t.completed_at=datetime.utcnow()
    if status!='Completed': t.completed_at=None
    if status!='Blocked': t.blocked_reason=''
    if status=='Blocked': t.blocked_reason=request.form.get('reason','').strip()
    t.status=status; db.session.commit(); socketio.emit('task_update', {'type':'status','task':task_dict(t)})
    flash('Task updated.','success'); return redirect(url_for('office'))

@app.route('/routine/add',methods=['POST'])
@login_required
def routine_add():
    title=request.form.get('title','').strip()
    if title: db.session.add(Routine(user_id=current_user().id,title=title)); db.session.commit()
    return redirect(url_for('office'))
@app.route('/routine/<int:rid>/toggle',methods=['POST'])
@login_required
def routine_toggle(rid):
    r=Routine.query.get_or_404(rid)
    if r.user_id!=current_user().id: return 'forbidden',403
    r.done_today=not r.done_today; db.session.commit(); return redirect(url_for('office'))
@app.route('/routine/<int:rid>/delete',methods=['POST'])
@login_required
def routine_delete(rid):
    r=Routine.query.get_or_404(rid)
    if r.user_id==current_user().id: db.session.delete(r); db.session.commit()
    return redirect(url_for('office'))

@app.route('/admin/staff',methods=['POST'])
@admin_required
def create_staff():
    eid=request.form.get('employee_id','').strip(); name=request.form.get('name','').strip(); email=request.form.get('email','').strip()
    password=request.form.get('password','')
    if not eid or not name or not password: flash('Employee ID, name and password are required.','error')
    elif User.query.filter((User.employee_id==eid)|(User.email==email)).first(): flash('ID or email already exists.','error')
    else:
        db.session.add(User(employee_id=eid,name=name,email=email or None,password_hash=generate_password_hash(password),team=request.form.get('team','General')))
        db.session.commit(); flash('Staff account created.','success')
    return redirect(url_for('office'))
@app.route('/admin/room',methods=['POST'])
@admin_required
def create_room():
    name=request.form.get('name','').strip()
    if name: db.session.add(Room(name=name,category=request.form.get('category','Lobby'),description=request.form.get('description',''),team=request.form.get('team','All'))); db.session.commit(); flash('Room created.','success')
    return redirect(url_for('office'))
@app.route('/admin/staff/<int:uid>/toggle',methods=['POST'])
@admin_required
def toggle_staff(uid):
    u=User.query.get_or_404(uid)
    if u.id!=current_user().id: u.active=not u.active; u.presence='Offline' if not u.active else u.presence; db.session.commit()
    return redirect(url_for('office'))

@socketio.on('connect')
def socket_connect():
    u=current_user()
    if u:
        u.presence='Online'; u.last_seen=datetime.utcnow(); db.session.commit()
        emit('presence_update',{'id':u.id,'presence':'Online'},broadcast=True)
@socketio.on('presence')
def set_presence(data):
    u=current_user()
    if u and data.get('presence') in ['Online','Working','Away','Focus']:
        u.presence=data['presence']; u.last_seen=datetime.utcnow(); db.session.commit(); emit('presence_update',{'id':u.id,'presence':u.presence},broadcast=True)

@app.route('/health')
def health(): return {'status':'ok','app':'PULSE'},200

with app.app_context():
    db.create_all()
    if not User.query.filter_by(role='admin').first():
        admin_id=os.getenv('ADMIN_ID','PULSE-ADMIN'); admin_pw=os.getenv('ADMIN_PASSWORD','ChangeMe123!')
        db.session.add(User(employee_id=admin_id,name=os.getenv('ADMIN_NAME','Pulse Admin'),email=os.getenv('ADMIN_EMAIL','admin@pulse.local'),password_hash=generate_password_hash(admin_pw),role='admin',team='Admin'))
        for name,cat,desc,team in [
            ('Main Lobby','Lobby','Announcements and office pulse.','All'),('My Desk','Workspace','Your personal work zone.','All'),('Task Room','Work','Shared task board.','All'),('Meeting Room','Meeting','Collaboration and discussion.','All'),('Operations Room','Operations','Team activity and operational work.','Operations'),('Analytics Room','Project','Data, reporting and insights.','Analytics'),('Sales Lobby','Lobby','Sales team shared space.','Sales'),('Modern Trade Room','Project','Modern trade projects and tasks.','Modern Trade')]:
            db.session.add(Room(name=name,category=cat,description=desc,team=team))
        db.session.commit()

if __name__=='__main__':
    socketio.run(app, host='0.0.0.0', port=int(os.getenv('PORT',5000)), allow_unsafe_werkzeug=True)
