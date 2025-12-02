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
    addUserForm: document.getElementById("add-user-form"),
    addUserName: document.getElementById("add-user-name"),
    addUserPass: document.getElementById("add-user-pass"),
    logoutBtn: document.getElementById("logout-btn"),
    newTaskForm: document.getElementById("new-task-form"),
    taskTitle: document.getElementById("task-title"),
    taskDueDate: document.getElementById("task-due-date"),
    taskDueTime: document.getElementById("task-due-time"),
    taskAssignee: document.getElementById("task-assignee"),
    taskList: document.getElementById("task-list"),
    completedList: document.getElementById("completed-list"),
    userList: document.getElementById("user-list"),
    refreshBtn: document.getElementById("refresh-btn"),
    toastContainer: document.getElementById("toast-container"),
    notifyBtn: document.getElementById("notify-btn"),
    themeBtn: document.getElementById("theme-btn"),
    taskCount: document.getElementById("task-count"),
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
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
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

  function updateNotifyButton() {
    if (!els.notifyBtn) return;
    if (!("Notification" in window)) {
      els.notifyBtn.textContent = "Notifications unsupported";
      els.notifyBtn.disabled = true;
      return;
    }
    const perm = Notification.permission;
    if (perm === "granted") {
      els.notifyBtn.textContent = "Notifications on";
      els.notifyBtn.disabled = true;
    } else if (perm === "denied") {
      els.notifyBtn.textContent = "Notifications blocked";
      els.notifyBtn.disabled = true;
    } else {
      els.notifyBtn.textContent = "Enable notifications";
      els.notifyBtn.disabled = false;
    }
  }

  async function requestNotifyPermission() {
    if (!("Notification" in window)) {
      toast("Notifications not supported in this browser", "error");
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      if (perm === "granted") {
        toast("Notifications enabled");
      } else {
        toast("Notifications blocked by browser", "error");
      }
    } catch (_) {
      toast("Could not request notifications", "error");
    } finally {
      updateNotifyButton();
    }
  }

  function maybeNotify(event) {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    if (!document.hidden) return;
    const title = "Todo update";
    const body = event && event.message ? event.message : "Task activity";
    try {
      new Notification(title, { body });
    } catch (_) {
      // Some browsers need a service worker for notifications; ignore if not available.
    }
  }

  function getStoredTheme() {
    return localStorage.getItem("todo-theme");
  }

  function applyTheme(theme) {
    const resolved = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", resolved);
    if (els.themeBtn) els.themeBtn.textContent = resolved === "light" ? "Dark" : "Light";
    localStorage.setItem("todo-theme", resolved);
  }

  function initTheme() {
    const stored = getStoredTheme();
    if (stored) {
      applyTheme(stored);
      return;
    }
    const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    applyTheme(prefersLight ? "light" : "dark");
  }

  function formatDateTime(isoString) {
    if (!isoString) return "—";
    try {
      const dt = new Date(isoString);
      return dt.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    } catch (_) {
      return isoString;
    }
  }

  function toDateInput(isoString) {
    if (!isoString) return "";
    try {
      const dt = new Date(isoString);
      const pad = (n) => String(n).padStart(2, "0");
      return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    } catch (_) {
      return "";
    }
  }

  function toTimeInput(isoString) {
    if (!isoString) return "";
    try {
      const dt = new Date(isoString);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    } catch (_) {
      return "";
    }
  }

  function combineDateTime(dateStr, timeStr) {
    if (!dateStr) return null;
    const time = timeStr && timeStr.length ? timeStr : "00:00";
    const candidate = new Date(`${dateStr}T${time}`);
    if (isNaN(candidate.getTime())) return null;
    return candidate.toISOString();
  }

  async function handleAuth(form, endpoint) {
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const res = await api(endpoint, {
        method: "POST",
        body: JSON.stringify(data),
      });
      if (endpoint === "/auth/register" && state.currentUser?.is_admin) {
        toast("User created");
        return;
      }
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
          <div class="muted small">created ${formatDateTime(user.created_at)}</div>
        </div>
        <div class="user-actions">
          <button class="ghost small" data-assign="${user.id}">Assign</button>
          ${state.currentUser?.is_admin ? `<button class="ghost small danger" data-delete-user="${user.id}">Delete</button>` : ""}
        </div>
      `;
      li
        .querySelector("[data-assign]")
        .addEventListener("click", () => setAssignee(user.id));
      li
        .querySelector("[data-delete-user]")
        ?.addEventListener("click", () => deleteUser(user.id));
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
    if (els.taskCount) {
      const total = tasks.length;
      els.taskCount.textContent = `${total} ${total === 1 ? "task" : "tasks"}`;
    }

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
    const due = formatDateTime(task.due_date);
    li.innerHTML = `
      <input class="checkbox" type="checkbox" ${
        task.completed ? "checked" : ""
      } aria-label="complete ${task.title}">
      <div>
        <div class="title-row">
          <div class="title">${task.title}</div>
          <div class="info-wrapper">
            <button class="info-btn" aria-label="Task info">i</button>
            <div class="info-tooltip">
              <div><strong>Assigned:</strong> ${task.assigned_user_id ? assigned : "Unassigned"}</div>
              <div><strong>Due:</strong> ${due}</div>
              ${
                task.completed_at
                  ? `<div><strong>Completed:</strong> ${formatDateTime(task.completed_at)}</div>`
                  : ""
              }
              <div><strong>Created:</strong> ${formatDateTime(task.created_at)}</div>
            </div>
          </div>
        </div>
        <div class="meta">Due ${due}</div>
      </div>
      <div class="task-actions">
        <select class="assign">
          <option value="">Unassigned</option>
        </select>
        <div class="split-input">
          <input class="due-date-input" type="date" value="${toDateInput(
            task.due_date
          )}" aria-label="set due date">
          <input class="due-time-input" type="time" value="${toTimeInput(
            task.due_date
          )}" aria-label="set due time">
        </div>
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

    const dueDateInput = li.querySelector(".due-date-input");
    const dueTimeInput = li.querySelector(".due-time-input");
    dueDateInput.addEventListener("change", () =>
      updateDueDate(task.id, dueDateInput.value, dueTimeInput.value)
    );
    dueTimeInput.addEventListener("change", () =>
      updateDueDate(task.id, dueDateInput.value, dueTimeInput.value)
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
    const dueDate = els.taskDueDate ? els.taskDueDate.value : "";
    const dueTime = els.taskDueTime ? els.taskDueTime.value : "";
    const due_date = combineDateTime(dueDate, dueTime);
    try {
      await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ title, assigned_user_id: assigned, due_date }),
      });
      els.taskTitle.value = "";
      if (els.taskDueDate) els.taskDueDate.value = "";
      if (els.taskDueTime) els.taskDueTime.value = "";
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

  async function updateDueDate(id, dueInput, timeInput) {
    const due_date = combineDateTime(dueInput, timeInput);
    try {
      await api(`/api/tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ due_date }),
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

  async function deleteUser(id) {
    if (!confirm("Delete this user? Tasks will be unassigned.")) return;
    try {
      await api(`/api/users/${id}`, { method: "DELETE" });
      await refreshAll();
      toast("User deleted");
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
    if (els.notifyBtn) {
      els.notifyBtn.addEventListener("click", requestNotifyPermission);
      updateNotifyButton();
    }
    if (els.themeBtn) {
      els.themeBtn.addEventListener("click", () => {
        const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
        applyTheme(next);
      });
    }

    if (state.currentUser?.is_admin && els.addUserForm) {
      els.addUserForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const username = els.addUserName.value.trim();
        const password = els.addUserPass.value;
        if (!username || !password) return;
        api("/auth/register", {
          method: "POST",
          body: JSON.stringify({ username, password }),
        })
          .then(() => {
            els.addUserName.value = "";
            els.addUserPass.value = "";
            toast("User created");
            refreshAll();
          })
          .catch((err) => toast(err.message, "error"));
      });
    }
  }

  function connectEvents() {
    let source = new EventSource("/api/events");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        toast(data.message);
        chime(data.type);
        maybeNotify(data);
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
    initTheme();
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
