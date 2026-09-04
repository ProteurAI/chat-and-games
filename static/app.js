const QUICK_EMOJIS = ["👍", "😂", "❤️", "🔥"];

let token = localStorage.getItem("instachat_token");
let me = JSON.parse(localStorage.getItem("instachat_user") || "null");
let channels = [];
let currentChannelId = null;
let ws = null;
let wsReconnectDelay = 1000;
let pollOptionCount = 2;

let gameTypes = [];
let gameSessions = [];
let myGameSessionId = null;
let myGameType = null;
let myGamePlayers = [];
let pongCtx = null;
let pongPressedKey = null;

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
  await loadGames();
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
  } else if (data.type === "games_update") {
    gameSessions = data.games;
    renderGameSidebar();
  } else if (data.type === "game_joined") {
    myGameSessionId = data.session_id;
    myGameType = data.game_type;
  } else if (data.type === "game_started") {
    openGameModal(data);
  } else if (data.type === "game_state") {
    if (data.session_id === myGameSessionId) updateGameState(data.state);
  } else if (data.type === "game_over") {
    if (data.session_id === myGameSessionId) showGameOver(data);
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
// Stores { [messageId]: firstViewedAtEpochMs } per viewer (localStorage), not
// just a seen/unseen flag. That timestamp is the single source of truth for
// "how long has this been visible" - every render (including a channel
// switch away-and-back, which fully rebuilds the message list) recomputes
// the remaining time from it instead of restarting or truncating a fresh
// per-render setTimeout, so a snap always stays sharp for exactly
// SNAP_VISIBLE_MS from the very first time it was actually shown.
const VIEWED_SNAPS_KEY = "instachat_viewed_snaps";
const SNAP_VISIBLE_MS = 8000;

function getViewedSnapTimestamps() {
  try {
    const parsed = JSON.parse(localStorage.getItem(VIEWED_SNAPS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstViewedAt(id) {
  const viewed = getViewedSnapTimestamps();
  if (viewed[id] === undefined) {
    viewed[id] = Date.now();
    localStorage.setItem(VIEWED_SNAPS_KEY, JSON.stringify(viewed));
  }
  return viewed[id];
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

  const remaining = SNAP_VISIBLE_MS - (Date.now() - firstViewedAt(msg.id));
  if (remaining <= 0) {
    wrap.classList.add("snap-viewed");
    seenHint.hidden = false;
  } else {
    setTimeout(() => {
      wrap.classList.add("snap-viewed");
      seenHint.hidden = false;
    }, remaining);
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

// ---------- games: lobby ----------
async function loadGames() {
  const data = await api("/api/games");
  gameTypes = data.game_types;
  gameSessions = data.sessions;
  renderGameSidebar();
}

function renderGameSidebar() {
  const iAmInSession = gameSessions.some((s) => s.players.some((p) => p.id === me.id));

  const typeList = el("game-type-list");
  typeList.innerHTML = "";
  for (const gt of gameTypes) {
    const li = document.createElement("li");
    li.className = "game-type-item";
    const label = document.createElement("span");
    label.textContent = `${gt.emoji} ${gt.name}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Starten";
    btn.disabled = iAmInSession;
    btn.addEventListener("click", () => startGame(gt.game_type));
    li.appendChild(label);
    li.appendChild(btn);
    typeList.appendChild(li);
  }

  const lobbyList = el("game-lobby-list");
  lobbyList.innerHTML = "";
  for (const s of gameSessions) {
    const amIIn = s.players.some((p) => p.id === me.id);
    const li = document.createElement("li");
    li.className = "game-lobby-item";

    const title = document.createElement("div");
    title.className = "game-lobby-title";
    const hostName = s.players[0] ? s.players[0].name : "Jemand";
    title.textContent = amIIn ? `${s.emoji} ${s.game_name}` : `${s.emoji} ${hostName} spielt gerade ${s.game_name}`;
    li.appendChild(title);

    const count = document.createElement("div");
    count.className = "game-lobby-count";
    count.textContent = `${s.player_count}/${s.max_players} Spieler`;
    li.appendChild(count);

    if (amIIn && s.status === "waiting") {
      const isHost = s.players[0] && s.players[0].id === me.id;
      if (s.manual_start && isHost) {
        const startBtn = document.createElement("button");
        startBtn.type = "button";
        startBtn.textContent = "▶ Jetzt starten";
        startBtn.disabled = s.player_count < s.min_players;
        startBtn.addEventListener("click", () => startGameNow(s.id));
        li.appendChild(startBtn);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ghost-btn";
      btn.textContent = "Abbrechen";
      btn.addEventListener("click", () => leaveGame(s.id));
      li.appendChild(btn);
    } else if (!amIIn && !iAmInSession && s.status === "waiting" && s.player_count < s.max_players) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Beitreten";
      btn.addEventListener("click", () => joinGame(s.id));
      li.appendChild(btn);
    }

    lobbyList.appendChild(li);
  }
}

function startGame(gameType) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "game_create", game_type: gameType }));
  }
}

function joinGame(sessionId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "game_join", session_id: sessionId }));
  }
}

function leaveGame(sessionId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "game_leave", session_id: sessionId }));
  }
}

function startGameNow(sessionId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "game_start_now", session_id: sessionId }));
  }
}

function sendGameInput(payload) {
  if (ws && ws.readyState === WebSocket.OPEN && myGameSessionId) {
    ws.send(JSON.stringify({ type: "game_input", session_id: myGameSessionId, payload }));
  }
}

// ---------- games: modal ----------
function openGameModal(data) {
  myGameSessionId = data.session_id;
  myGameType = data.game_type;
  myGamePlayers = data.players;

  el("game-overlay-msg").hidden = true;
  el("game-rematch-btn").hidden = true;
  el("game-modal-title").textContent = GAME_TITLES[data.game_type] || "🎮 Spiel";

  const stage = el("game-stage");
  stage.innerHTML = "";
  if (data.game_type === "pong") {
    buildPongStage(stage);
  } else if (data.game_type === "tictactoe") {
    buildTttStage(stage);
  } else if (data.game_type === "lightcycles") {
    buildLightCyclesStage(stage);
  } else if (data.game_type === "buzzer") {
    buildBuzzerStage(stage);
  }
  updateGameState(data.state);
  el("game-modal").hidden = false;
}

const GAME_TITLES = {
  pong: "🏓 Pong",
  tictactoe: "⭕ Tic-Tac-Toe",
  lightcycles: "🏍️ Light Cycles",
  buzzer: "🔔 Buzzer",
};
const REMATCH_GAME_TYPES = ["tictactoe", "buzzer"];

function closeGameModal() {
  if (myGameSessionId && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "game_leave", session_id: myGameSessionId }));
  }
  stopPongControls();
  stopLcControls();
  el("game-modal").hidden = true;
  myGameSessionId = null;
  myGameType = null;
  myGamePlayers = [];
}

el("game-close-btn").addEventListener("click", closeGameModal);
el("game-overlay-close-btn").addEventListener("click", closeGameModal);
el("game-rematch-btn").addEventListener("click", () => {
  if (myGameSessionId && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "game_rematch", session_id: myGameSessionId }));
  }
  el("game-overlay-msg").hidden = true;
});

function updateGameState(state) {
  if (myGameType === "pong") renderPong(state);
  else if (myGameType === "tictactoe") renderTtt(state);
  else if (myGameType === "lightcycles") renderLightCycles(state);
  else if (myGameType === "buzzer") renderBuzzer(state);
}

function showGameOver(data) {
  stopPongControls();
  stopLcControls();
  let text;
  if (data.reason === "draw") {
    text = "🤝 Unentschieden!";
  } else if (data.reason === "opponent_left") {
    text = data.winner_user_id === me.id ? "🏆 Du gewinnst — dein Gegner hat das Spiel verlassen." : "Spiel beendet.";
  } else if (data.reason === "last_standing") {
    text = data.winner_user_id === me.id ? "🏆 Du hast überlebt und gewonnen!" : `${data.winner_name || "Jemand"} hat gewonnen.`;
  } else if (data.reason === "buzzer") {
    text = data.winner_user_id === null
      ? "😅 Alle haben zu früh geklickt!"
      : data.winner_user_id === me.id
        ? "🏆 Du warst am schnellsten!"
        : `${data.winner_name || "Jemand"} war am schnellsten.`;
  } else if (data.winner_user_id === me.id) {
    text = "🏆 Du hast gewonnen!";
  } else {
    text = `${data.winner_name || "Dein Gegner"} hat gewonnen.`;
  }
  el("game-overlay-text").textContent = text;

  const rankingBox = el("game-overlay-ranking");
  rankingBox.innerHTML = "";
  rankingBox.hidden = true;
  if (data.reason === "buzzer" && data.details && data.details.ranking) {
    rankingBox.hidden = false;
    data.details.ranking.forEach((entry, i) => {
      const row = document.createElement("div");
      row.className = "ranking-row" + (i === 0 && !entry.disqualified ? " rank-1" : "");
      const player = myGamePlayers.find((p) => p.id === entry.user_id);
      const name = player ? player.name : "?";
      const label = entry.disqualified ? "Fehlstart ⛔" : entry.reaction_ms !== null ? `${entry.reaction_ms} ms` : "–";
      row.innerHTML = `<span>${i + 1}. ${escapeHtml(name)}</span><span>${label}</span>`;
      rankingBox.appendChild(row);
    });
  }

  el("game-rematch-btn").hidden = !REMATCH_GAME_TYPES.includes(myGameType) || data.reason === "opponent_left";
  el("game-overlay-msg").hidden = false;
}

// ---------- games: pong ----------
function buildPongStage(stage) {
  const scoreRow = document.createElement("div");
  scoreRow.className = "pong-score-row";
  scoreRow.innerHTML = `
    <span id="pong-name-left">…</span>
    <span class="pong-score" id="pong-score-text">0 : 0</span>
    <span id="pong-name-right">…</span>
  `;
  stage.appendChild(scoreRow);

  const canvas = document.createElement("canvas");
  canvas.id = "pong-canvas";
  canvas.width = 480;
  canvas.height = 288;
  stage.appendChild(canvas);
  pongCtx = canvas.getContext("2d");

  const hint = document.createElement("p");
  hint.style.cssText = "font-size:12px;color:var(--text-dim);margin:0;";
  hint.textContent = "Steuerung: Pfeiltaste hoch/runter";
  stage.appendChild(hint);

  startPongControls();
}

function renderPong(state) {
  const leftUid = Object.keys(state.sides).find((u) => state.sides[u] === "left");
  const rightUid = Object.keys(state.sides).find((u) => state.sides[u] === "right");
  const leftPlayer = myGamePlayers.find((p) => String(p.id) === leftUid);
  const rightPlayer = myGamePlayers.find((p) => String(p.id) === rightUid);
  if (el("pong-name-left")) el("pong-name-left").textContent = leftPlayer ? leftPlayer.name : "?";
  if (el("pong-name-right")) el("pong-name-right").textContent = rightPlayer ? rightPlayer.name : "?";
  if (el("pong-score-text")) {
    el("pong-score-text").textContent = `${state.score[leftUid]} : ${state.score[rightUid]}`;
  }

  if (!pongCtx) return;
  const canvas = el("pong-canvas");
  const w = canvas.width;
  const h = canvas.height;
  const scale = w / state.width;

  pongCtx.fillStyle = "#14121f";
  pongCtx.fillRect(0, 0, w, h);
  pongCtx.strokeStyle = "rgba(255,255,255,0.25)";
  pongCtx.setLineDash([8, 10]);
  pongCtx.beginPath();
  pongCtx.moveTo(w / 2, 0);
  pongCtx.lineTo(w / 2, h);
  pongCtx.stroke();
  pongCtx.setLineDash([]);

  const paddleW = 8;
  const paddleH = state.paddle_half * 2 * scale;
  pongCtx.fillStyle = "#ffffff";
  pongCtx.fillRect(state.paddle_x_left * scale - paddleW / 2, state.paddles[leftUid] * scale - paddleH / 2, paddleW, paddleH);
  pongCtx.fillRect(state.paddle_x_right * scale - paddleW / 2, state.paddles[rightUid] * scale - paddleH / 2, paddleW, paddleH);

  pongCtx.beginPath();
  pongCtx.arc(state.ball.x * scale, state.ball.y * scale, 6, 0, Math.PI * 2);
  pongCtx.fill();
}

function startPongControls() {
  pongPressedKey = null;
  document.addEventListener("keydown", onPongKeyDown);
  document.addEventListener("keyup", onPongKeyUp);
}

function stopPongControls() {
  document.removeEventListener("keydown", onPongKeyDown);
  document.removeEventListener("keyup", onPongKeyUp);
  pongPressedKey = null;
  pongCtx = null;
}

function onPongKeyDown(e) {
  if (myGameType !== "pong" || !myGameSessionId) return;
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  e.preventDefault();
  const dir = e.key === "ArrowUp" ? "up" : "down";
  if (pongPressedKey === dir) return;
  pongPressedKey = dir;
  sendGameInput({ direction: dir });
}

function onPongKeyUp(e) {
  if (myGameType !== "pong" || !myGameSessionId) return;
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  e.preventDefault();
  if (pongPressedKey === (e.key === "ArrowUp" ? "up" : "down")) {
    pongPressedKey = null;
    sendGameInput({ direction: "stop" });
  }
}

// ---------- games: tic-tac-toe ----------
function buildTttStage(stage) {
  const turnRow = document.createElement("div");
  turnRow.id = "ttt-turn-indicator";
  turnRow.className = "ttt-turn-indicator";
  stage.appendChild(turnRow);

  const grid = document.createElement("div");
  grid.className = "ttt-grid";
  grid.id = "ttt-grid";
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "ttt-cell";
    cell.disabled = true;
    cell.addEventListener("click", () => sendGameInput({ cell_index: i }));
    grid.appendChild(cell);
  }
  stage.appendChild(grid);
}

function renderTtt(state) {
  const mySymbol = state.symbols[String(me.id)];
  const isMyTurn = state.turn === String(me.id);
  const indicator = el("ttt-turn-indicator");
  if (indicator) {
    indicator.textContent = isMyTurn ? `Du bist dran (${mySymbol})` : "Gegner ist dran …";
    indicator.classList.toggle("my-turn", isMyTurn);
  }
  const grid = el("ttt-grid");
  if (!grid) return;
  state.board.forEach((val, i) => {
    const cell = grid.children[i];
    cell.textContent = val || "";
    cell.classList.toggle("symbol-o", val === "O");
    cell.disabled = !!val || !isMyTurn || !!state.winner;
  });
}

// ---------- games: light cycles ----------
let lcCtx = null;
let lastSentLcDir = null;
const LC_COLOR_HEX = { red: "#ff5252", blue: "#4fa8ff", green: "#4ade80", yellow: "#fbbf24" };

function buildLightCyclesStage(stage) {
  const hint = document.createElement("p");
  hint.style.cssText = "font-size:12px;color:var(--text-dim);margin:0 0 8px;text-align:center;";
  hint.textContent = "Steuerung: Pfeiltasten — nicht in die eigene Spur zurückfahren!";
  stage.appendChild(hint);

  const canvas = document.createElement("canvas");
  canvas.id = "lc-canvas";
  canvas.width = 360;
  canvas.height = 360;
  stage.appendChild(canvas);
  lcCtx = canvas.getContext("2d");

  const status = document.createElement("div");
  status.id = "lc-status";
  status.className = "lc-status";
  stage.appendChild(status);

  lastSentLcDir = null;
  document.addEventListener("keydown", onLightCyclesKeyDown);
}

function stopLcControls() {
  document.removeEventListener("keydown", onLightCyclesKeyDown);
  lastSentLcDir = null;
  lcCtx = null;
}

function onLightCyclesKeyDown(e) {
  const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  const dir = map[e.key];
  if (!dir || myGameType !== "lightcycles" || !myGameSessionId) return;
  e.preventDefault();
  if (dir === lastSentLcDir) return;
  lastSentLcDir = dir;
  sendGameInput({ direction: dir });
}

function renderLightCycles(state) {
  const status = el("lc-status");
  if (status) {
    const aliveNames = Object.entries(state.players)
      .filter(([, p]) => p.alive)
      .map(([uid]) => (myGamePlayers.find((p) => String(p.id) === uid) || {}).name || "?");
    status.textContent = aliveNames.length ? `Noch am Leben: ${aliveNames.join(", ")}` : "";
  }

  if (!lcCtx) return;
  const canvas = el("lc-canvas");
  const size = state.grid_size;
  const cell = canvas.width / size;

  lcCtx.fillStyle = "#14121f";
  lcCtx.fillRect(0, 0, canvas.width, canvas.height);

  lcCtx.globalAlpha = 0.55;
  for (const [x, y, color] of state.trail) {
    lcCtx.fillStyle = LC_COLOR_HEX[color] || "#ffffff";
    lcCtx.fillRect(x * cell, y * cell, cell, cell);
  }
  lcCtx.globalAlpha = 1;

  for (const p of Object.values(state.players)) {
    if (!p.alive) continue;
    lcCtx.fillStyle = LC_COLOR_HEX[p.color] || "#ffffff";
    lcCtx.fillRect(p.x * cell, p.y * cell, cell, cell);
    lcCtx.strokeStyle = "#ffffff";
    lcCtx.lineWidth = 1.5;
    lcCtx.strokeRect(p.x * cell + 0.75, p.y * cell + 0.75, cell - 1.5, cell - 1.5);
  }
}

// ---------- games: buzzer ----------
function buildBuzzerStage(stage) {
  const status = document.createElement("div");
  status.id = "buzzer-status";
  status.className = "buzzer-status";
  status.textContent = "Bereit machen …";
  stage.appendChild(status);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "buzzer-btn";
  btn.className = "buzzer-btn waiting";
  btn.textContent = "⏳";
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    btn.disabled = true;
    sendGameInput({ action: "buzz" });
  });
  stage.appendChild(btn);
}

function renderBuzzer(state) {
  const status = el("buzzer-status");
  const btn = el("buzzer-btn");
  if (!status || !btn) return;

  if (state.phase === "signal") {
    status.textContent = "JETZT KLICKEN!";
    btn.textContent = "JETZT!";
    btn.className = "buzzer-btn armed";
  } else {
    status.textContent = "Bereit machen …";
    btn.textContent = "⏳";
    btn.className = "buzzer-btn waiting";
  }

  const mine = state.results[String(me.id)];
  if (mine && mine.clicked_at !== null) {
    btn.disabled = true;
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
