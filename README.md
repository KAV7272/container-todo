# Container Todo

Simple self-hosted todo list with basic auth, task assignment, completion history, and real-time notifications via Server-Sent Events.

## Local run
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export FLASK_APP=app.py
python app.py
# Visit http://localhost:5000
```

## Docker
```bash
docker build -t container-todo .
docker run -p 5000:5000 -v todo-data:/data --name container-todo container-todo
# Visit http://localhost:5000
```

Environment variables:
- `SECRET_KEY`: set to a strong value in production.
- `DATABASE_PATH`: optional custom SQLite path (default `/data/data.db` in the container).

Notifications:
- Browser notifications are triggered while the app tab is open; click “Enable notifications” in the top bar to allow.
- For iOS, background notifications require installing the site as a PWA and push configuration (not included); foreground/background while the tab is open works with standard permissions.
