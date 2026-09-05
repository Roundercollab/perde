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
const seekBackBtn = document.getElementById("seek-back-btn");
const seekFwdBtn = document.getElementById("seek-fwd-btn");
const emoteFlyLayer = document.getElementById("emote-fly-layer");
const emoteBar = document.getElementById("emote-bar");
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
let lastPlaybackTime = 0; // Sarma miktarını hesaplamak için son bilinen zaman
let seekStartTime = null; // Bir sarma işlemi başladığındaki zaman

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

    if (data.type === "emote") {
      spawnEmote(data.emoji);
    }
  };
}

function sendAction(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "action", text }));
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

// Zamanı sürekli takip ediyoruz ki bir sarma (seek) başladığında
// öncesindeki zamanı bilip kaç saniye sarıldığını hesaplayabilelim.
videoPlayer.addEventListener("timeupdate", () => {
  if (!videoPlayer.seeking) {
    lastPlaybackTime = videoPlayer.currentTime;
  }
});

videoPlayer.addEventListener("seeking", () => {
  if (isRemoteUpdate) return;
  if (seekStartTime === null) {
    seekStartTime = lastPlaybackTime;
  }
});

videoPlayer.addEventListener("play", () => {
  sendState();
  if (!isRemoteUpdate) sendAction("videoyu oynattı");
});

videoPlayer.addEventListener("pause", () => {
  sendState();
  if (!isRemoteUpdate) sendAction("videoyu durdurdu");
});

videoPlayer.addEventListener("seeked", () => {
  sendState();

  if (!isRemoteUpdate && seekStartTime !== null) {
    const delta = videoPlayer.currentTime - seekStartTime;
    if (Math.abs(delta) >= 0.75) {
      const secs = Math.round(Math.abs(delta));
      sendAction(delta > 0 ? `${secs}sn ileri sardı` : `${secs}sn geri sardı`);
    }
  }

  seekStartTime = null;
});

videoPlayer.addEventListener("ratechange", () => {
  sendState();
  if (!isRemoteUpdate) sendAction(`hızı ${videoPlayer.playbackRate}x yaptı`);
});

seekBackBtn.addEventListener("click", () => {
  if (!videoPlayer.src) return;
  videoPlayer.currentTime = Math.max(0, videoPlayer.currentTime - 5);
});

seekFwdBtn.addEventListener("click", () => {
  if (!videoPlayer.src) return;
  const max = isFinite(videoPlayer.duration) ? videoPlayer.duration : Infinity;
  videoPlayer.currentTime = Math.min(max, videoPlayer.currentTime + 5);
});

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

// ---------- Emote bar: sağ alttan uçan küçük emojiler ----------

function spawnEmote(emoji) {
  const el = document.createElement("span");
  el.className = "flying-emote";
  el.textContent = emoji;

  const drift = Math.round((Math.random() - 0.5) * 70); // hafif yatay sapma
  el.style.setProperty("--drift", drift + "px");
  el.style.right = (16 + Math.random() * 40) + "px";

  emoteFlyLayer.appendChild(el);
  el.addEventListener("animationend", () => el.remove());
}

emoteBar.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-emoji]");
  if (!btn) return;

  const emoji = btn.dataset.emoji;
  spawnEmote(emoji);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "emote", emoji }));
  }
});

// ---------- Tam ekran: theatre tam ekran olur; CSS'te video ve sohbet
// artık üst üste değil, yan yana (flex) gösteriliyor ----------

fullscreenBtn.addEventListener("click", () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    (theatre.requestFullscreen || theatre.webkitRequestFullscreen)?.call(theatre);
  }
});