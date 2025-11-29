(() => {
  const state = {
    currentUser: (window.APP_CONTEXT && window.APP_CONTEXT.user) || null,
    users: [],
    tasks: [],
    audioContext: null,
  };

  const els = {
    authView: document.getElementById("auth-view"),
    appView: document.getElementById("app-view"),
    loginForm: document.getElementById("login-form"),
    registerForm: document.getElementById("register-form"),
    logoutBtn: document.getElementById("logout-btn"),
    newTaskForm: document.getElementById("new-task-form"),
    taskTitle: document.getElementById("task-title"),
    taskAssignee: document.getElementById("task-assignee"),
    taskList: document.getElementById("task-list"),
    completedList: document.getElementById("completed-list"),
    userList: document.getElementById("user-list"),
    refreshBtn: document.getElementById("refresh-btn"),
    toastContainer: document.getElementById("toast-container"),
  };

  const api = async (path, options = {}) => {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      ...options,
    });
    if (!res.ok) {
      let err = "Something went wrong.";
      try {
        const body = await res.json();
        if (body.error) err = body.error;
      } catch (_) {
        err = `${res.status} error`;
      }
      throw new Error(err);
    }
    const text = await res.text();
    if (!text) return {};
    return JSON.parse(text);
  };

  function toast(message, tone = "info") {
    if (!message) return;
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    if (tone === "error") el.style.background = "#f43f5e";
    els.toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function chime(kind = "info") {
    try {
      if (!state.audioContext) {
        state.audioContext =
          new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = state.audioContext;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      const tones = {
        created: 880,
        deleted: 420,
        assigned: 660,
        completed: 560,
        reopened: 520,
        info: 760,
      };
      osc.frequency.value = tones[kind] || 720;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        ctx.currentTime + 0.35
      );
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch (_) {
      // Ignore audio errors (e.g., autoplay restrictions)
    }
  }

  async function handleAuth(form, endpoint) {
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await api(endpoint, {
        method: "POST",
        body: JSON.stringify(data),
      });
      location.reload();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  function renderUsers(users) {
    els.userList.innerHTML = "";
    users.forEach((user) => {
      const li = document.createElement("li");
      li.className = "user";
      li.dataset.userId = user.id;
      li.innerHTML = `
        <div>
          <div><strong>${user.username}</strong></div>
          <div class="muted small">created ${new Date(
            user.created_at
          ).toLocaleString()}</div>
        </div>
        <button class="ghost small" data-assign="${user.id}">Assign</button>
      `;
      li
        .querySelector("[data-assign]")
        .addEventListener("click", () => setAssignee(user.id));
      els.userList.appendChild(li);
    });
  }

  function renderAssigneeOptions(users) {
    const select = els.taskAssignee;
    const existing = select.value;
    select.innerHTML = `<option value="">Unassigned</option>`;
    users.forEach((user) => {
      const opt = document.createElement("option");
      opt.value = user.id;
      opt.textContent = user.username;
      select.appendChild(opt);
    });
    if (existing) select.value = existing;
  }

  function renderTasks(tasks) {
    els.taskList.innerHTML = "";
    els.completedList.innerHTML = "";
    const active = tasks.filter((t) => !t.completed);
    const done = tasks.filter((t) => t.completed);

    active.forEach((task) => {
      const li = createTaskElement(task);
      els.taskList.appendChild(li);
    });

    done.forEach((task) => {
      const li = createTaskElement(task, true);
      els.completedList.appendChild(li);
    });
  }

  function createTaskElement(task, completed = false) {
    const li = document.createElement("li");
    li.className = `task${completed ? " complete" : ""}`;
    li.dataset.id = task.id;
    const assigned =
      task.assigned_username || (task.assigned_user_id ? "User" : "Nobody");
    li.innerHTML = `
      <input class="checkbox" type="checkbox" ${
        task.completed ? "checked" : ""
      } aria-label="complete ${task.title}">
      <div>
        <div class="title">${task.title}</div>
        <div class="meta">
          ${task.assigned_user_id ? `Assigned to ${assigned}` : "Unassigned"} ·
          Created ${new Date(task.created_at).toLocaleString()}
          ${
            task.completed_at
              ? " · Completed " + new Date(task.completed_at).toLocaleString()
              : ""
          }
        </div>
      </div>
      <div class="task-actions">
        <select class="assign">
          <option value="">Unassigned</option>
        </select>
        <button class="ghost small" data-delete>Delete</button>
      </div>
    `;

    const checkbox = li.querySelector(".checkbox");
    checkbox.addEventListener("change", () =>
      toggleComplete(task.id, checkbox.checked)
    );

    const select = li.querySelector(".assign");
    populateAssignSelect(select, task.assigned_user_id);
    select.addEventListener("change", () =>
      updateAssignee(task.id, select.value)
    );

    li.querySelector("[data-delete]").addEventListener("click", () =>
      deleteTask(task.id)
    );

    return li;
  }

  function populateAssignSelect(select, selectedId) {
    select.innerHTML = `<option value="">Unassigned</option>`;
    state.users.forEach((user) => {
      const opt = document.createElement("option");
      opt.value = user.id;
      opt.textContent = user.username;
      if (String(user.id) === String(selectedId)) opt.selected = true;
      select.appendChild(opt);
    });
  }

  async function fetchUsers() {
    const { users } = await api("/api/users");
    state.users = users;
    renderUsers(users);
    renderAssigneeOptions(users);
  }

  async function fetchTasks() {
    const { tasks } = await api("/api/tasks");
    state.tasks = tasks;
    renderTasks(tasks);
  }

  async function refreshAll() {
    await Promise.all([fetchUsers(), fetchTasks()]);
  }

  async function createTask() {
    const title = els.taskTitle.value.trim();
    if (!title) return;
    const assigned = els.taskAssignee.value || null;
    try {
      await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ title, assigned_user_id: assigned }),
      });
      els.taskTitle.value = "";
      await refreshAll();
      chime("created");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function toggleComplete(id, done) {
    try {
      await api(`/api/tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ completed: done }),
      });
      await refreshAll();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function updateAssignee(id, assigned) {
    const payload = { assigned_user_id: assigned || null };
    try {
      await api(`/api/tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      await refreshAll();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function deleteTask(id) {
    try {
      await api(`/api/tasks/${id}`, { method: "DELETE" });
      await refreshAll();
      chime("deleted");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    location.reload();
  }

  function setAssignee(userId) {
    els.taskAssignee.value = String(userId);
    toast("Assignee preselected for new tasks.");
  }

  function bindAuth() {
    if (els.loginForm) {
      els.loginForm.addEventListener("submit", (e) => {
        e.preventDefault();
        handleAuth(els.loginForm, "/auth/login");
      });
    }
    if (els.registerForm) {
      els.registerForm.addEventListener("submit", (e) => {
        e.preventDefault();
        handleAuth(els.registerForm, "/auth/register");
      });
    }
  }

  function bindApp() {
    els.newTaskForm.addEventListener("submit", (e) => {
      e.preventDefault();
      createTask();
    });

    els.refreshBtn.addEventListener("click", refreshAll);
    els.logoutBtn.addEventListener("click", logout);
  }

  function connectEvents() {
    let source = new EventSource("/api/events");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        toast(data.message);
        chime(data.type);
        refreshAll();
      } catch (_) {
        refreshAll();
      }
    };
    source.addEventListener("ping", () => {});
    source.onerror = () => {
      toast("Connection lost, retrying...", "error");
      source.close();
      setTimeout(connectEvents, 2000);
    };
  }

  async function bootstrap() {
    if (!state.currentUser) {
      els.authView?.classList.remove("hidden");
      bindAuth();
      return;
    }
    els.appView?.classList.remove("hidden");
    bindApp();
    await refreshAll();
    connectEvents();
  }

  bootstrap();
})();
