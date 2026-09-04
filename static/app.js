const QUICK_EMOJIS = ["👍", "😂", "❤️", "🔥"];

let token = localStorage.getItem("instachat_token");
let me = JSON.parse(localStorage.getItem("instachat_user") || "null");
let channels = [];
let currentChannelId = null;
let ws = null;
let wsReconnectDelay = 1000;
let pollOptionCount = 2;

const el = (id) => document.getElementById(id);

// ---------- api helper ----------
async function api(path, options = {}) {
  const headers = options.headers || {};
  if (token) headers["X-Auth-Token"] = token;
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Fehler" }));
    throw new Error(err.detail || "Fehler");
  }
  return res.status === 204 ? null : res.json();
}

// ---------- login ----------
el("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = el("login-code").value;
  const name = el("login-name").value.trim();
  const errBox = el("login-error");
  errBox.hidden = true;
  try {
    const data = await api("/api/login", { method: "POST", body: JSON.stringify({ code, name }) });
    token = data.token;
    me = data.user;
    localStorage.setItem("instachat_token", token);
    localStorage.setItem("instachat_user", JSON.stringify(me));
    startApp();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
  }
});

function showLogin() {
  el("login-screen").hidden = false;
  el("app").hidden = true;
}

async function startApp() {
  el("login-screen").hidden = true;
  el("app").hidden = false;
  el("sidebar-me").textContent = `angemeldet als ${me.name}`;
  await loadChannels();
  connectWebSocket();
}

// ---------- channels ----------
async function loadChannels() {
  channels = await api("/api/channels");
  renderChannelList();
  if (!currentChannelId && channels.length) {
    selectChannel(channels[0].id);
  } else if (!channels.length) {
    showNoChannelsState();
  }
}

function renderChannelList() {
  const list = el("channel-list");
  list.innerHTML = "";
  if (!channels.length) {
    const li = document.createElement("li");
    li.className = "channel-empty-hint";
    li.textContent = "Noch keine Kanäle – leg unten den ersten an! 👇";
    list.appendChild(li);
    return;
  }
  for (const ch of channels) {
    const li = document.createElement("li");
    li.textContent = `#${ch.name}`;
    li.className = ch.id === currentChannelId ? "active" : "";
    li.addEventListener("click", () => selectChannel(ch.id));
    list.appendChild(li);
  }
}

function showNoChannelsState() {
  currentChannelId = null;
  el("current-channel-name").textContent = "#";
  el("messages").innerHTML = "";
  const hint = document.createElement("div");
  hint.className = "msg-system";
  hint.textContent = "Noch keine Kanäle vorhanden – leg links deinen ersten Kanal an!";
  el("messages").appendChild(hint);
  setComposerEnabled(false);
}

function setComposerEnabled(enabled) {
  for (const id of ["snap-btn", "attach-btn", "poll-btn", "message-input", "send-btn"]) {
    el(id).disabled = !enabled;
  }
}

async function selectChannel(id) {
  currentChannelId = id;
  setComposerEnabled(true);
  renderChannelList();
  const ch = channels.find((c) => c.id === id);
  el("current-channel-name").textContent = ch ? `#${ch.name}` : "#";
  el("messages").innerHTML = "";
  const msgs = await api(`/api/channels/${id}/messages`);
  for (const m of msgs) renderMessage(m);
  scrollToBottom();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "join", channel_id: id }));
  }
  closeMobileSidebar();
}

el("new-channel-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = el("new-channel-input");
  const name = input.value.trim();
  if (!name) return;
  const ch = await api("/api/channels", { method: "POST", body: JSON.stringify({ name }) });
  input.value = "";
  await loadChannels();
  selectChannel(ch.id);
});

// ---------- websocket ----------
function connectWebSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.addEventListener("open", () => {
    wsReconnectDelay = 1000;
    if (currentChannelId) ws.send(JSON.stringify({ type: "join", channel_id: currentChannelId }));
  });

  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    handleWsEvent(data);
  });

  ws.addEventListener("close", () => {
    setTimeout(connectWebSocket, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 15000);
  });

  ws.addEventListener("error", () => ws.close());
}

function handleWsEvent(data) {
  if (data.type === "message") {
    if (data.message.channel_id === currentChannelId) {
      renderMessage(data.message);
      scrollToBottom();
    }
  } else if (data.type === "reaction_update") {
    updateReactionsUI(data.message_id, data.reactions);
  } else if (data.type === "poll_update") {
    updatePollUI(data.message_id, data.poll);
  } else if (data.type === "presence") {
    renderOnline(data.online);
  } else if (data.type === "bingo_win") {
    if (data.message.channel_id === currentChannelId) {
      renderMessage(data.message);
      scrollToBottom();
    }
    toast(data.message.content);
  }
}

function renderOnline(names) {
  const list = el("online-list");
  list.innerHTML = "";
  for (const name of names) {
    const li = document.createElement("li");
    li.textContent = name;
    list.appendChild(li);
  }
}

// ---------- rendering messages ----------
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function withMentions(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(/@([A-Za-z0-9_.\-]{2,32})/g, '<span class="mention">@$1</span>');
}

function scrollToBottom() {
  const box = el("messages");
  box.scrollTop = box.scrollHeight;
}

function renderMessage(msg) {
  if (msg.type === "system") {
    const div = document.createElement("div");
    div.className = "msg-system";
    div.textContent = msg.content;
    el("messages").appendChild(div);
    return;
  }

  const mine = msg.user_id === me.id;
  const wrap = document.createElement("div");
  wrap.className = "msg" + (mine ? " mine" : "");
  wrap.dataset.messageId = msg.id;

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = (msg.user_name || "?").slice(0, 1).toUpperCase();

  const body = document.createElement("div");
  body.className = "msg-body";

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const time = new Date(msg.created_at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  meta.textContent = `${msg.user_name || "?"} · ${time}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const quickbar = document.createElement("div");
  quickbar.className = "reaction-quickbar";
  for (const emoji of QUICK_EMOJIS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = emoji;
    btn.addEventListener("click", () => sendReaction(msg.id, emoji));
    quickbar.appendChild(btn);
  }
  bubble.appendChild(quickbar);

  if (msg.type === "text") {
    const content = document.createElement("div");
    content.innerHTML = withMentions(msg.content || "");
    bubble.appendChild(content);
  } else if (msg.type === "image") {
    const img = document.createElement("img");
    img.className = "chat-image";
    img.src = msg.image_url;
    img.alt = "Bild";
    bubble.appendChild(img);
  } else if (msg.type === "poll") {
    bubble.appendChild(buildPollElement(msg));
  } else if (msg.type === "snap") {
    bubble.appendChild(buildSnapElement(msg));
  }

  const reactions = document.createElement("div");
  reactions.className = "reactions";
  reactions.dataset.role = "reactions";
  renderReactionPills(reactions, msg.reactions || []);
  bubble.appendChild(reactions);

  body.appendChild(meta);
  body.appendChild(bubble);
  wrap.appendChild(avatar);
  wrap.appendChild(body);
  el("messages").appendChild(wrap);
}

function renderReactionPills(container, reactions) {
  container.innerHTML = "";
  for (const r of reactions) {
    const pill = document.createElement("button");
    pill.type = "button";
    const mine = r.user_ids && r.user_ids.includes(me.id);
    pill.className = "reaction-pill" + (mine ? " mine" : "");
    pill.textContent = `${r.emoji} ${r.count}`;
    pill.addEventListener("click", () => {
      const messageEl = container.closest(".msg");
      sendReaction(parseInt(messageEl.dataset.messageId, 10), r.emoji);
    });
    container.appendChild(pill);
  }
}

function updateReactionsUI(messageId, reactions) {
  const wrap = document.querySelector(`.msg[data-message-id="${messageId}"]`);
  if (!wrap) return;
  const container = wrap.querySelector('[data-role="reactions"]');
  renderReactionPills(container, reactions);
}

function sendReaction(messageId, emoji) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "reaction", message_id: messageId, emoji }));
  }
}

// ---------- polls ----------
function buildPollElement(msg) {
  const box = document.createElement("div");
  box.className = "poll";
  box.dataset.messageId = msg.id;

  const q = document.createElement("div");
  q.className = "poll-question";
  q.textContent = msg.poll.question;
  box.appendChild(q);

  const optionsWrap = document.createElement("div");
  optionsWrap.dataset.role = "poll-options";
  box.appendChild(optionsWrap);

  const total = document.createElement("div");
  total.className = "poll-total";
  total.dataset.role = "poll-total";
  box.appendChild(total);

  renderPollOptions(box, msg.poll);
  return box;
}

function renderPollOptions(pollBox, poll) {
  const optionsWrap = pollBox.querySelector('[data-role="poll-options"]');
  const totalEl = pollBox.querySelector('[data-role="poll-total"]');
  optionsWrap.innerHTML = "";
  const messageId = parseInt(pollBox.dataset.messageId, 10);

  for (const opt of poll.options) {
    const pct = poll.total_votes ? Math.round((opt.votes / poll.total_votes) * 100) : 0;
    const row = document.createElement("div");
    row.className = "poll-option" + (opt.id === poll.my_option_id ? " voted" : "");
    row.innerHTML = `
      <div class="poll-option-label"><span>${escapeHtml(opt.text)}</span><span>${pct}%</span></div>
      <div class="poll-bar-track"><div class="poll-bar-fill" style="width:${pct}%"></div></div>
    `;
    row.addEventListener("click", () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "poll_vote", message_id: messageId, option_id: opt.id }));
      }
      pollBox.dataset.myVote = opt.id;
    });
    optionsWrap.appendChild(row);
  }
  totalEl.textContent = `${poll.total_votes} Stimme${poll.total_votes === 1 ? "" : "n"}`;
}

function updatePollUI(messageId, poll) {
  const pollBox = document.querySelector(`.poll[data-message-id="${messageId}"]`);
  if (!pollBox) return;
  const myVote = pollBox.dataset.myVote ? parseInt(pollBox.dataset.myVote, 10) : poll.my_option_id;
  poll.my_option_id = myVote || poll.my_option_id;
  renderPollOptions(pollBox, poll);
}

el("poll-btn").addEventListener("click", () => {
  el("poll-composer").hidden = false;
  el("poll-options").innerHTML = "";
  pollOptionCount = 0;
  addPollOption();
  addPollOption();
});
el("poll-close-btn").addEventListener("click", () => (el("poll-composer").hidden = true));

function addPollOption() {
  if (pollOptionCount >= 6) return;
  pollOptionCount++;
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = `Option ${pollOptionCount}`;
  input.maxLength = 120;
  input.dataset.pollOption = "1";
  el("poll-options").appendChild(input);
}
el("poll-add-option").addEventListener("click", addPollOption);

el("poll-submit").addEventListener("click", () => {
  const question = el("poll-question").value.trim();
  const options = Array.from(document.querySelectorAll('[data-poll-option]'))
    .map((i) => i.value.trim())
    .filter(Boolean);
  if (!question || options.length < 2) {
    toast("Frage + mind. 2 Optionen nötig");
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "poll_create", channel_id: currentChannelId, question, options }));
  }
  el("poll-composer").hidden = true;
  el("poll-question").value = "";
});

// ---------- snap rendering (ephemeral view-once effect) ----------
const VIEWED_SNAPS_KEY = "instachat_viewed_snaps";

function getViewedSnaps() {
  try {
    return new Set(JSON.parse(localStorage.getItem(VIEWED_SNAPS_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function markSnapViewed(id) {
  const viewed = getViewedSnaps();
  viewed.add(id);
  localStorage.setItem(VIEWED_SNAPS_KEY, JSON.stringify([...viewed]));
}

function buildSnapElement(msg) {
  const wrap = document.createElement("div");
  wrap.className = "snap-frame";

  const label = document.createElement("div");
  label.className = "snap-label";
  label.textContent = "⚡ Snap";
  wrap.appendChild(label);

  const img = document.createElement("img");
  img.className = "chat-image snap-image";
  img.src = msg.image_url;
  img.alt = "Snap";
  wrap.appendChild(img);

  const seenHint = document.createElement("div");
  seenHint.className = "snap-seen-hint";
  seenHint.textContent = "👁 Bereits angesehen";
  seenHint.hidden = true;
  wrap.appendChild(seenHint);

  if (getViewedSnaps().has(msg.id)) {
    wrap.classList.add("snap-viewed");
    seenHint.hidden = false;
  } else {
    markSnapViewed(msg.id);
    setTimeout(() => {
      wrap.classList.add("snap-viewed");
      seenHint.hidden = false;
    }, 4000);
  }
  return wrap;
}

// ---------- text messages ----------
el("message-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = el("message-input");
  const content = input.value.trim();
  if (!content) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "message", channel_id: currentChannelId, content }));
  }
  input.value = "";
});

// ---------- image upload ----------
el("attach-btn").addEventListener("click", () => el("file-input").click());
el("file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await uploadAndSendImage(file);
  e.target.value = "";
});

const dropZone = el("messages");
dropZone.addEventListener("dragover", (e) => e.preventDefault());
dropZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("image/")) {
    await uploadAndSendImage(file);
  }
});

async function uploadAndSendImage(file) {
  try {
    const form = new FormData();
    form.append("file", file);
    const result = await api("/api/upload", { method: "POST", body: form });
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "image_message", channel_id: currentChannelId, image_path: result.image_path }));
    }
  } catch (err) {
    toast(err.message);
  }
}

// ---------- snap (webcam) ----------
let snapStream = null;
let snapBlob = null;

el("snap-btn").addEventListener("click", openSnapModal);
el("snap-close-btn").addEventListener("click", closeSnapModal);
el("snap-capture-btn").addEventListener("click", captureSnap);
el("snap-retake-btn").addEventListener("click", resetSnapUI);
el("snap-send-btn").addEventListener("click", sendSnap);

async function openSnapModal() {
  if (!currentChannelId) return;
  resetSnapUI();
  el("snap-error").hidden = true;
  el("snap-modal").hidden = false;
  try {
    snapStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    el("snap-video").srcObject = snapStream;
  } catch (err) {
    el("snap-error").textContent = "Kein Kamerazugriff: " + err.message;
    el("snap-error").hidden = false;
  }
}

function closeSnapModal() {
  el("snap-modal").hidden = true;
  stopSnapStream();
  resetSnapUI();
}

function stopSnapStream() {
  if (snapStream) {
    snapStream.getTracks().forEach((t) => t.stop());
    snapStream = null;
  }
}

function resetSnapUI() {
  snapBlob = null;
  el("snap-video").hidden = false;
  el("snap-preview-img").hidden = true;
  el("snap-capture-btn").hidden = false;
  el("snap-retake-btn").hidden = true;
  el("snap-send-btn").hidden = true;
}

function captureSnap() {
  const video = el("snap-video");
  const canvas = el("snap-canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    if (!blob) return;
    snapBlob = blob;
    el("snap-preview-img").src = URL.createObjectURL(blob);
    el("snap-video").hidden = true;
    el("snap-preview-img").hidden = false;
    el("snap-capture-btn").hidden = true;
    el("snap-retake-btn").hidden = false;
    el("snap-send-btn").hidden = false;
  }, "image/jpeg", 0.9);
}

async function sendSnap() {
  if (!snapBlob || !currentChannelId) return;
  try {
    const form = new FormData();
    form.append("file", snapBlob, "snap.jpg");
    const result = await api("/api/upload", { method: "POST", body: form });
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "snap_message", channel_id: currentChannelId, image_path: result.image_path }));
    }
    closeSnapModal();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- bingo ----------
el("bingo-open-btn").addEventListener("click", openBingo);
el("bingo-close-btn").addEventListener("click", () => (el("bingo-modal").hidden = true));

async function openBingo() {
  el("bingo-modal").hidden = false;
  const data = await api("/api/bingo");
  renderBingoGrid(data.cells, data.checked);
}

function renderBingoGrid(cells, checked) {
  const grid = el("bingo-grid");
  grid.innerHTML = "";
  cells.forEach((text, i) => {
    const cell = document.createElement("button");
    cell.type = "button";
    const isFree = i === 12;
    cell.className = "bingo-cell" + (checked[i] ? " checked" : "") + (isFree ? " free" : "");
    cell.textContent = text;
    if (!isFree) {
      cell.addEventListener("click", () => toggleBingoCell(i));
    }
    grid.appendChild(cell);
  });
}

async function toggleBingoCell(index) {
  const result = await api("/api/bingo/check", {
    method: "POST",
    body: JSON.stringify({ cell_index: index, channel_id: currentChannelId }),
  });
  const cells = Array.from(el("bingo-grid").children).map((c) => c.textContent);
  renderBingoGrid(cells, result.checked);
  if (result.new_bingo) {
    toast("🎉 BINGO! Ist im Kanal gepostet.");
  }
}

// ---------- toast ----------
let toastTimer = null;
function toast(text) {
  const box = el("toast");
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 3500);
}

// ---------- mobile sidebar ----------
el("sidebar-toggle").addEventListener("click", () => {
  el("sidebar").classList.toggle("open");
});
function closeMobileSidebar() {
  el("sidebar").classList.remove("open");
}

// ---------- boot ----------
if (token && me) {
  startApp().catch(() => {
    localStorage.removeItem("instachat_token");
    localStorage.removeItem("instachat_user");
    showLogin();
  });
} else {
  showLogin();
}
