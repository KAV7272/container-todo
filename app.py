import json
import os
import queue
import sqlite3
import threading
from datetime import datetime
from functools import wraps

from flask import (
    Flask,
    Response,
    jsonify,
    render_template,
    request,
    session,
    g,
    stream_with_context,
)
from werkzeug.security import check_password_hash, generate_password_hash


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

DATABASE_PATH = os.environ.get("DATABASE_PATH", os.path.join(DATA_DIR, "data.db"))
os.makedirs(os.path.dirname(DATABASE_PATH), exist_ok=True)

app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = os.environ.get("SECRET_KEY", "replace-me-in-prod")

event_queues: list[queue.Queue] = []
listeners_lock = threading.Lock()


def get_db():
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    cur = conn.cursor()
    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            completed INTEGER DEFAULT 0,
            assigned_user_id INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            completed_at TEXT,
            due_date TEXT,
            FOREIGN KEY (assigned_user_id) REFERENCES users(id)
        );
        """
    )
    # Ensure due_date exists if DB already created.
    cols = {row[1] for row in cur.execute("PRAGMA table_info(tasks)").fetchall()}
    if "due_date" not in cols:
        cur.execute("ALTER TABLE tasks ADD COLUMN due_date TEXT")
    conn.commit()
    conn.close()


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("user_id"):
            return jsonify({"error": "Unauthorized"}), 401
        return fn(*args, **kwargs)

    return wrapper


@app.before_request
def load_logged_in_user():
    user_id = session.get("user_id")
    g.user = None
    if user_id is not None:
        conn = get_db()
        user = conn.execute(
            "SELECT id, username FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        conn.close()
        g.user = user


def broadcast_event(kind: str, message: str, payload=None):
    event = {
        "type": kind,
        "message": message,
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "payload": payload or {},
    }
    with listeners_lock:
        for q in list(event_queues):
            q.put(event)


def format_task(row):
    return {
        "id": row["id"],
        "title": row["title"],
        "completed": bool(row["completed"]),
        "assigned_user_id": row["assigned_user_id"],
        "assigned_username": row["assigned_username"],
        "created_at": row["created_at"],
        "completed_at": row["completed_at"],
        "due_date": row["due_date"],
    }


@app.route("/")
def index():
    return render_template("index.html", user=g.user)


@app.post("/auth/register")
def register():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    if len(username) < 3 or len(password) < 4:
        return jsonify({"error": "Username or password too short."}), 400

    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO users (username, password_hash) VALUES (?, ?)",
            (username, generate_password_hash(password)),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({"error": "Username already taken."}), 400

    user = conn.execute(
        "SELECT id, username FROM users WHERE username = ?", (username,)
    ).fetchone()
    conn.close()

    session["user_id"] = user["id"]
    return jsonify({"user": {"id": user["id"], "username": user["username"]}})


@app.post("/auth/login")
def login():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    conn = get_db()
    user = conn.execute(
        "SELECT id, username, password_hash FROM users WHERE username = ?", (username,)
    ).fetchone()
    conn.close()

    if user is None or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Invalid credentials."}), 400

    session["user_id"] = user["id"]
    return jsonify({"user": {"id": user["id"], "username": user["username"]}})


@app.post("/auth/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/me")
@login_required
def current_user():
    return jsonify({"user": {"id": g.user["id"], "username": g.user["username"]}})


@app.get("/api/users")
@login_required
def list_users():
    conn = get_db()
    users = conn.execute(
        "SELECT id, username, created_at FROM users ORDER BY created_at ASC"
    ).fetchall()
    conn.close()
    return jsonify(
        {
            "users": [
                {"id": u["id"], "username": u["username"], "created_at": u["created_at"]}
                for u in users
            ]
        }
    )


@app.delete("/api/users/<int:user_id>")
@login_required
def delete_user(user_id: int):
    conn = get_db()
    user = conn.execute(
        "SELECT id, username FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    if user is None:
        conn.close()
        return jsonify({"error": "User not found."}), 404

    # Unassign tasks owned by this user to keep history intact.
    conn.execute(
        "UPDATE tasks SET assigned_user_id = NULL WHERE assigned_user_id = ?", (user_id,)
    )
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()

    if session.get("user_id") == user_id:
        session.clear()
    broadcast_event("user_deleted", f'User "{user["username"]}" removed', {"user_id": user_id})
    return jsonify({"ok": True})


@app.get("/api/tasks")
@login_required
def get_tasks():
    conn = get_db()
    rows = conn.execute(
        """
        SELECT tasks.*, users.username AS assigned_username
        FROM tasks
        LEFT JOIN users ON users.id = tasks.assigned_user_id
        ORDER BY
          CASE WHEN tasks.due_date IS NULL THEN 1 ELSE 0 END,
          datetime(tasks.due_date) ASC,
          tasks.created_at DESC
        """
    ).fetchall()
    conn.close()
    return jsonify({"tasks": [format_task(r) for r in rows]})


@app.post("/api/tasks")
@login_required
def create_task():
    data = request.get_json() or {}
    title = (data.get("title") or "").strip()
    assigned_user_id = data.get("assigned_user_id")
    due_date = (data.get("due_date") or "").strip() or None

    if not title:
        return jsonify({"error": "Title is required."}), 400

    conn = get_db()

    if assigned_user_id:
        user_exists = conn.execute(
            "SELECT id FROM users WHERE id = ?", (assigned_user_id,)
        ).fetchone()
        if user_exists is None:
            conn.close()
            return jsonify({"error": "Assigned user not found."}), 400

    cur = conn.execute(
        "INSERT INTO tasks (title, assigned_user_id, due_date) VALUES (?, ?, ?)",
        (title, assigned_user_id, due_date),
    )
    conn.commit()
    task_id = cur.lastrowid
    row = conn.execute(
        """
        SELECT tasks.*, users.username AS assigned_username
        FROM tasks
        LEFT JOIN users ON users.id = tasks.assigned_user_id
        WHERE tasks.id = ?
        """,
        (task_id,),
    ).fetchone()
    conn.close()

    broadcast_event(
        "created",
        f'"{title}" added',
        {"task_id": task_id, "assigned_user_id": assigned_user_id},
    )
    return jsonify({"task": format_task(row)})


@app.patch("/api/tasks/<int:task_id>")
@login_required
def update_task(task_id: int):
    data = request.get_json() or {}
    title = data.get("title")
    completed = data.get("completed")
    assigned_user_id = data.get("assigned_user_id")
    due_date = data.get("due_date")

    conn = get_db()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify({"error": "Task not found."}), 404

    updates = []
    params = []

    if title is not None:
        title = title.strip()
        updates.append("title = ?")
        params.append(title)

    if completed is not None:
        updates.append("completed = ?")
        params.append(1 if completed else 0)
        updates.append("completed_at = ?")
        params.append(datetime.utcnow().isoformat() + "Z" if completed else None)

    if assigned_user_id is not None:
        if assigned_user_id == "":
            assigned_user_id = None
        else:
            assigned_exists = conn.execute(
                "SELECT id FROM users WHERE id = ?", (assigned_user_id,)
            ).fetchone()
            if assigned_exists is None:
                conn.close()
                return jsonify({"error": "Assigned user not found."}), 400
        updates.append("assigned_user_id = ?")
        params.append(assigned_user_id)

    if due_date is not None:
        due_val = due_date.strip() if isinstance(due_date, str) else None
        updates.append("due_date = ?")
        params.append(due_val or None)

    if not updates:
        conn.close()
        return jsonify({"error": "Nothing to update."}), 400

    params.append(task_id)
    conn.execute(f"UPDATE tasks SET {', '.join(updates)} WHERE id = ?", params)
    conn.commit()

    updated = conn.execute(
        """
        SELECT tasks.*, users.username AS assigned_username
        FROM tasks
        LEFT JOIN users ON users.id = tasks.assigned_user_id
        WHERE tasks.id = ?
        """,
        (task_id,),
    ).fetchone()
    conn.close()

    if completed is not None:
        broadcast_event(
            "completed" if completed else "reopened",
            f'"{updated["title"]}" {"completed" if completed else "reopened"}',
            {"task_id": task_id},
        )
    if assigned_user_id is not None:
        broadcast_event(
            "assigned",
            f'"{updated["title"]}" assigned',
            {
                "task_id": task_id,
                "assigned_user_id": assigned_user_id,
                "assigned_username": updated["assigned_username"],
            },
        )

    return jsonify({"task": format_task(updated)})


@app.delete("/api/tasks/<int:task_id>")
@login_required
def delete_task(task_id: int):
    conn = get_db()
    row = conn.execute("SELECT title FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify({"error": "Task not found."}), 404
    conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    conn.commit()
    conn.close()

    broadcast_event("deleted", f'"{row["title"]}" removed', {"task_id": task_id})
    return jsonify({"ok": True})


@app.get("/api/events")
@login_required
def events():
    client_queue: queue.Queue = queue.Queue()
    with listeners_lock:
        event_queues.append(client_queue)

    def stream():
        try:
            while True:
                try:
                    event = client_queue.get(timeout=25)
                except queue.Empty:
                    yield "event: ping\ndata: {}\n\n"
                    continue
                yield f"data: {json.dumps(event)}\n\n"
        except GeneratorExit:
            pass
        finally:
            with listeners_lock:
                if client_queue in event_queues:
                    event_queues.remove(client_queue)

    return Response(stream_with_context(stream()), mimetype="text/event-stream")


@app.errorhandler(404)
def not_found(_):
    return render_template("index.html", user=g.user), 404


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5000, debug=True)
else:
    init_db()
