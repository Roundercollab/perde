const videoPlayer = document.getElementById("video-player");
const videoUrlInput = document.getElementById("video-url");
const loadVideoBtn = document.getElementById("load-video");
const theatre = document.getElementById("theatre");
const chatBox = document.getElementById("chat-box");
const chatInput = document.getElementById("chat-input");
const sendChatBtn = document.getElementById("send-chat");
const chatToggleBtn = document.getElementById("chat-toggle");
const chatPanel = document.getElementById("chat-panel");
const fullscreenBtn = document.getElementById("fullscreen-btn");
const connIndicator = document.getElementById("conn-indicator");
const roomPill = document.getElementById("room-pill");
const roomPillCode = document.getElementById("room-pill-code");
const joinOverlay = document.getElementById("join-overlay");
const joinForm = document.getElementById("join-form");
const joinNameInput = document.getElementById("join-name");
const joinRoomInput = document.getElementById("join-room");

let ws = null;
let roomCode = "";
let userName = "Misafir";
let isRemoteUpdate = false; // Kendi tetiklediğimiz olayların döngüye girmesini engeller
let remoteUpdateResetTimer = null;
let reconnectTimer = null;

// ---------- Odaya giriş (native prompt() yerine temalı modal) ----------

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = joinNameInput.value.trim().slice(0, 20) || "Misafir";
  const room = joinRoomInput.value.trim().slice(0, 30);
  if (!room) return;

  userName = name;
  roomCode = room.toUpperCase();
  roomPillCode.textContent = roomCode;
  roomPill.hidden = false;
  joinOverlay.hidden = true;

  connectSocket();
});

// ---------- WebSocket bağlantısı + otomatik yeniden bağlanma ----------

function setConnState(state, label) {
  connIndicator.dataset.state = state;
  connIndicator.querySelector(".conn-label").textContent = label;
}

function connectSocket() {
  clearTimeout(reconnectTimer);
  setConnState("connecting", "Bağlanıyor…");

  ws = new WebSocket(
    location.protocol === "https:"
      ? "wss://" + location.host
      : "ws://" + location.host
  );

  ws.onopen = () => {
    setConnState("online", "Bağlı");
    ws.send(JSON.stringify({ type: "join", room: roomCode, name: userName }));
  };

  ws.onclose = () => {
    setConnState("offline", "Bağlantı koptu, tekrar deneniyor…");
    reconnectTimer = setTimeout(connectSocket, 3000);
  };

  ws.onerror = () => {
    ws.close();
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "joined" && data.state) {
      applyState(data.state);
    }

    if (data.type === "state") {
      applyState(data.state);
    }

    if (data.type === "chat") {
      appendMessage({ name: data.name, text: data.text });
    }

    if (data.type === "system") {
      appendMessage({ system: true, text: data.text });
    }
  };
}

// ---------- Video senkronizasyonu ----------

function applyState(state) {
  if (!state) return;

  isRemoteUpdate = true;
  clearTimeout(remoteUpdateResetTimer);

  const finishSync = () => {
    if (Math.abs(videoPlayer.currentTime - state.time) > 1) {
      videoPlayer.currentTime = state.time;
    }
    videoPlayer.playbackRate = state.rate || 1;

    if (state.playing) {
      videoPlayer.play().catch(() => {});
    } else {
      videoPlayer.pause();
    }

    // Play()/pause() olayları asenkron gelebildiği için bayrağı hemen değil,
    // kısa bir payla kaldırıyoruz ki gecikmeli event'ler tekrar broadcast tetiklemesin.
    remoteUpdateResetTimer = setTimeout(() => { isRemoteUpdate = false; }, 300);
  };

  const isNewSource = state.source && videoPlayer.dataset.src !== state.source;

  if (isNewSource) {
    videoPlayer.dataset.src = state.source;
    videoPlayer.src = state.source;
    theatre.classList.add("has-video");
    // Metadata yüklenmeden currentTime atamak tarayıcıda güvenilir çalışmıyor,
    // bu yüzden seek/rate/play işlemini metadata gelene kadar erteliyoruz.
    videoPlayer.addEventListener("loadedmetadata", finishSync, { once: true });
  } else if (videoPlayer.readyState >= 1) {
    finishSync();
  } else if (state.source) {
    videoPlayer.addEventListener("loadedmetadata", finishSync, { once: true });
  } else {
    isRemoteUpdate = false;
  }
}

function sendState() {
  if (isRemoteUpdate || !ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: "state",
    source: videoPlayer.src,
    playing: !videoPlayer.paused,
    time: videoPlayer.currentTime,
    rate: videoPlayer.playbackRate
  }));
}

videoPlayer.addEventListener("play", sendState);
videoPlayer.addEventListener("pause", sendState);
videoPlayer.addEventListener("seeked", sendState);
videoPlayer.addEventListener("ratechange", sendState);

loadVideoBtn.addEventListener("click", () => {
  const url = videoUrlInput.value.trim();
  if (!url) return;
  videoPlayer.dataset.src = url;
  videoPlayer.src = url;
  theatre.classList.add("has-video");
  sendState();
});

// ---------- Sohbet ----------

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({ type: "chat", text }));
  chatInput.value = "";
}

sendChatBtn.addEventListener("click", sendMessage);

// ENTER tuşu ile mesaj gönderme
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendMessage();
  }
});

function appendMessage({ name, text, system }) {
  const wrap = document.createElement("div");

  if (system) {
    wrap.className = "msg system";
    wrap.textContent = text;
  } else {
    const isOwn = name === userName;
    wrap.className = "msg" + (isOwn ? " own" : "");

    const nameEl = document.createElement("div");
    nameEl.className = "msg-name";
    nameEl.textContent = isOwn ? "Sen" : name;

    const textEl = document.createElement("span");
    textEl.className = "msg-text";
    textEl.textContent = text;

    wrap.appendChild(nameEl);
    wrap.appendChild(textEl);
  }

  chatBox.appendChild(wrap);
  // Yeni mesaj geldiğinde otomatik olarak en alta kaydır
  chatBox.scrollTop = chatBox.scrollHeight;
}

chatToggleBtn.addEventListener("click", () => {
  const collapsed = chatPanel.classList.toggle("collapsed");
  chatToggleBtn.textContent = collapsed ? "+" : "–";
  chatToggleBtn.setAttribute("aria-label", collapsed ? "Sohbeti büyüt" : "Sohbeti küçült");
});

// ---------- Tam ekran: video büyür, sohbet küçük bir overlay olarak üstünde kalır ----------

fullscreenBtn.addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    (theatre.requestFullscreen || theatre.webkitRequestFullscreen)?.call(theatre);
  }
});