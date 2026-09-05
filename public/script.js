const videoPlayer = document.getElementById("video-player");
const videoUrlInput = document.getElementById("video-url");
const loadVideoBtn = document.getElementById("load-video");
const theatre = document.getElementById("theatre");
const chatBox = document.getElementById("chat-box");
const chatInput = document.getElementById("chat-input");
const sendChatBtn = document.getElementById("send-chat");
const chatToggleBtn = document.getElementById("chat-toggle");
const chatPanel = document.getElementById("chat-panel");
const chatResizeHandle = document.getElementById("chat-resize-handle");
const fullscreenBtn = document.getElementById("fullscreen-btn");
const seekBackBtn = document.getElementById("seek-back-btn");
const seekFwdBtn = document.getElementById("seek-fwd-btn");
const emoteFlyLayer = document.getElementById("emote-fly-layer");
const emoteBar = document.getElementById("emote-bar");
const emoteToggleBtn = document.getElementById("emote-toggle-btn");
const micBtn = document.getElementById("mic-btn");
const micLabel = micBtn.querySelector(".mic-label");
const pttBtn = document.getElementById("ptt-btn");
const pttKeyLabel = document.getElementById("ptt-key-label");
const pttRebindBtn = document.getElementById("ptt-rebind-btn");
const voiceRoster = document.getElementById("voice-roster");
const voiceAudioLayer = document.getElementById("voice-audio-layer");
const connIndicator = document.getElementById("conn-indicator");
const roomPill = document.getElementById("room-pill");
const roomPillCode = document.getElementById("room-pill-code");
const leaveRoomBtn = document.getElementById("leave-room-btn");
const joinOverlay = document.getElementById("join-overlay");
const joinForm = document.getElementById("join-form");
const joinNameInput = document.getElementById("join-name");
const joinRoomInput = document.getElementById("join-room");

let ws = null;
let roomCode = "";
let userName = "Misafir";
let myClientId = Math.random().toString(36).slice(2);
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
  leaveRoomBtn.hidden = false;
  joinOverlay.hidden = true;

  connectSocket();
});

// ---------- Odadan çıkış (ana menüye dön) ----------

function leaveRoom() {
  clearTimeout(reconnectTimer);

  disableMic();

  if (ws) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "leave" }));
      }
    } catch {}
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }

  // Videoyu ve arayüzü sıfırla
  videoPlayer.pause();
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  delete videoPlayer.dataset.src;
  theatre.classList.remove("has-video");
  videoUrlInput.value = "";

  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  }

  chatBox.innerHTML = "";
  chatInput.value = "";

  roomCode = "";
  roomPill.hidden = true;
  leaveRoomBtn.hidden = true;
  setConnState("connecting", "Bağlanıyor…");

  joinOverlay.hidden = false;
  joinRoomInput.value = "";
  joinNameInput.focus();
}

leaveRoomBtn.addEventListener("click", leaveRoom);

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
    ws.send(JSON.stringify({ type: "join", room: roomCode, name: userName, clientId: myClientId }));
  };

  ws.onclose = () => {
    setConnState("offline", "Bağlantı koptu, tekrar deneniyor…");
    teardownAllVoicePeers();
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

    if (data.type === "voice-peers") {
      handleVoicePeers(data.peers);
    }

    if (data.type === "voice-join") {
      handleVoiceJoin(data.id, data.name);
    }

    if (data.type === "voice-leave") {
      handleVoiceLeave(data.id);
    }

    if (data.type === "signal") {
      handleSignal(data.from, data.data);
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

// Emoji çubuğunu göster/gizle
emoteToggleBtn.addEventListener("click", () => {
  const nowHidden = emoteBar.classList.toggle("hidden-bar");
  emoteToggleBtn.setAttribute("aria-pressed", String(!nowHidden));
});

// ---------- Sohbet panelini yeniden boyutlandırma ----------

const CHAT_WIDTH_STORAGE_KEY = "perde-chat-width";
const CHAT_MIN_WIDTH = 220;
const CHAT_MAX_WIDTH = 640;

(function restoreChatWidth() {
  const saved = parseInt(localStorage.getItem(CHAT_WIDTH_STORAGE_KEY), 10);
  if (saved && saved >= CHAT_MIN_WIDTH && saved <= CHAT_MAX_WIDTH) {
    chatPanel.style.setProperty("--chat-width", saved + "px");
  }
})();

let resizeStartX = 0;
let resizeStartWidth = 0;
let isResizingChat = false;

chatResizeHandle.addEventListener("pointerdown", (e) => {
  isResizingChat = true;
  resizeStartX = e.clientX;
  resizeStartWidth = chatPanel.getBoundingClientRect().width;
  chatResizeHandle.classList.add("dragging");
  chatResizeHandle.setPointerCapture(e.pointerId);
  e.preventDefault();
});

chatResizeHandle.addEventListener("pointermove", (e) => {
  if (!isResizingChat) return;

  const delta = e.clientX - resizeStartX;
  // Panel her zaman sağ kenara hizalı; kolu sola çekmek genişletir.
  let newWidth = resizeStartWidth - delta;
  const maxAllowed = Math.min(CHAT_MAX_WIDTH, window.innerWidth * 0.7);
  newWidth = Math.max(CHAT_MIN_WIDTH, Math.min(maxAllowed, newWidth));

  chatPanel.style.setProperty("--chat-width", Math.round(newWidth) + "px");
});

function endChatResize(e) {
  if (!isResizingChat) return;
  isResizingChat = false;
  chatResizeHandle.classList.remove("dragging");

  const width = Math.round(chatPanel.getBoundingClientRect().width);
  localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, width);
}

chatResizeHandle.addEventListener("pointerup", endChatResize);
chatResizeHandle.addEventListener("pointercancel", endChatResize);

// ---------- Tam ekran ----------
// theatre tam ekran olur; CSS'te video ve sohbet artık üst üste değil,
// yan yana (flex) gösteriliyor. Tarayıcının kendi video oynatıcısındaki
// (native) tam ekran butonuna veya video'ya çift tıklamaya basılırsa,
// tarayıcı doğrudan <video> elemanını tam ekran yapar ve bizim CSS'imiz
// (.theatre:fullscreen) devreye girmez — bu da "chat kayboluyor" sorununa
// yol açıyordu. Aşağıdaki dinleyiciler bunu yakalayıp otomatik olarak
// doğru elemanı (theatre) tam ekrana alıyor, kimin tetiklediğinden
// bağımsız olarak herkeste aynı düzen çalışsın diye.

function goFullscreenOnTheatre() {
  (theatre.requestFullscreen || theatre.webkitRequestFullscreen)?.call(theatre);
}

fullscreenBtn.addEventListener("click", () => {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  } else {
    goFullscreenOnTheatre();
  }
});

function redirectNativeVideoFullscreen() {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl === videoPlayer) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    Promise.resolve(exit?.call(document)).catch(() => {}).then(goFullscreenOnTheatre);
  }
}

document.addEventListener("fullscreenchange", redirectNativeVideoFullscreen);
document.addEventListener("webkitfullscreenchange", redirectNativeVideoFullscreen);

// iOS Safari, videoyu standart Fullscreen API yerine kendi native tam ekran
// oynatıcısına açar (webkitbeginfullscreen). Bunu da yakalayıp theatre'a
// yönlendirmeyi deniyoruz.
videoPlayer.addEventListener("webkitbeginfullscreen", () => {
  try { videoPlayer.webkitExitFullscreen(); } catch {}
  goFullscreenOnTheatre();
});

// ---------- Mikrofon / Sesli sohbet (WebRTC) ----------

// STUN tek başına, iki farklı ağdaki (ör. iki farklı ev interneti) kullanıcılar
// arasında çoğu zaman doğrudan bağlantı kuramaz (NAT/firewall engeller) — bu da
// "mikrofon açık ama karşıya ses gitmiyor" şikayetinin en yaygın sebebidir.
// Aşağıya bir TURN sunucusu (relay) ekliyoruz ki bağlantı doğrudan kurulamadığında
// ses trafiği relay üzerinden akabilsin. Bu ücretsiz/genel bir test TURN'üdür;
// üretimde kendi TURN sunucunuzu (örn. coturn) kullanmanız önerilir.
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ]
};

let localStream = null;
let micState = "off"; // off | connecting | on | error
let isTalking = false; // bas-konuş: şu an gerçekten ses gönderiyor muyuz
const peerConnections = new Map(); // clientId -> RTCPeerConnection
const remoteAudioEls = new Map();  // clientId -> <audio>
const voicePeerNames = new Map();  // clientId -> name
const mutedPeers = new Set();      // clientId'ler — sadece bizim tarafımızda sessize alınmış
const pendingCandidates = new Map(); // clientId -> ICE aday kuyruğu (remote description gelmeden önce)

function setMicState(state) {
  micState = state;
  micBtn.dataset.state = state;

  const labels = {
    off: "Mikrofon",
    connecting: "Bağlanıyor…",
    on: "Sesli sohbette",
    error: "Mikrofon hatası"
  };
  micLabel.textContent = labels[state] || "Mikrofon";
  micBtn.title = state === "on" ? "Sesli sohbetten çık" : "Sesli sohbete katıl";

  const connected = state === "on";
  pttBtn.hidden = !connected;
  pttRebindBtn.hidden = !connected;
  if (!connected) stopTalking();
}

function renderVoiceRoster() {
  voiceRoster.innerHTML = "";

  if (voicePeerNames.size === 0) {
    voiceRoster.hidden = true;
    return;
  }

  voiceRoster.hidden = false;

  for (const [id, name] of voicePeerNames.entries()) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "voice-peer";
    const muted = mutedPeers.has(id);
    pill.dataset.muted = String(muted);
    pill.title = muted ? `${name} — sesi kapalı, açmak için tıkla` : `${name} — sesi açık, kapatmak için tıkla`;

    const dot = document.createElement("span");
    dot.className = "dot";

    const label = document.createElement("span");
    label.textContent = name;

    pill.appendChild(dot);
    pill.appendChild(label);

    pill.addEventListener("click", () => togglePeerMute(id));

    voiceRoster.appendChild(pill);
  }
}

function togglePeerMute(id) {
  const audioEl = remoteAudioEls.get(id);
  if (mutedPeers.has(id)) {
    mutedPeers.delete(id);
    if (audioEl) audioEl.muted = false;
  } else {
    mutedPeers.add(id);
    if (audioEl) audioEl.muted = true;
  }
  renderVoiceRoster();
}

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(RTC_CONFIG);

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignal(peerId, { candidate: e.candidate });
    }
  };

  pc.ontrack = (e) => {
    let audioEl = remoteAudioEls.get(peerId);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.muted = mutedPeers.has(peerId);
      voiceAudioLayer.appendChild(audioEl);
      remoteAudioEls.set(peerId, audioEl);
    }
    audioEl.srcObject = e.streams[0];
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      closePeerConnection(peerId);
    }
  };

  peerConnections.set(peerId, pc);
  return pc;
}

function closePeerConnection(peerId) {
  const pc = peerConnections.get(peerId);
  if (pc) {
    pc.close();
    peerConnections.delete(peerId);
  }

  const audioEl = remoteAudioEls.get(peerId);
  if (audioEl) {
    audioEl.srcObject = null;
    audioEl.remove();
    remoteAudioEls.delete(peerId);
  }

  mutedPeers.delete(peerId);
  pendingCandidates.delete(peerId);
}

function sendSignal(toId, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "signal", to: toId, data }));
}

async function callPeer(peerId) {
  const pc = createPeerConnection(peerId);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(peerId, { sdp: pc.localDescription });
  } catch (err) {
    closePeerConnection(peerId);
  }
}

async function handleSignal(fromId, data) {
  if (!localStream) return; // sesli sohbete katılmadıysak sinyalleri yok say

  let pc = peerConnections.get(fromId);

  if (data.sdp) {
    if (!pc) pc = createPeerConnection(fromId);

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

      // Remote description gelmeden önce biriken ICE adaylarını şimdi ekle —
      // aksi halde sessizce yok sayılıp bağlantı hiç kurulamayabiliyordu.
      const queued = pendingCandidates.get(fromId);
      if (queued && queued.length) {
        for (const cand of queued) {
          try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch {}
        }
        pendingCandidates.delete(fromId);
      }

      if (data.sdp.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(fromId, { sdp: pc.localDescription });
      }
    } catch (err) {
      closePeerConnection(fromId);
    }
    return;
  }

  if (data.candidate) {
    if (pc && pc.remoteDescription) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch {}
    } else {
      // Henüz remote description yok (offer/answer daha ulaşmadı) —
      // adayı kuyruğa al, description gelince ekleyeceğiz.
      if (!pendingCandidates.has(fromId)) pendingCandidates.set(fromId, []);
      pendingCandidates.get(fromId).push(data.candidate);
    }
  }
}

function handleVoicePeers(peers) {
  for (const peer of peers) {
    voicePeerNames.set(peer.id, peer.name);
    callPeer(peer.id);
  }
  renderVoiceRoster();
}

function handleVoiceJoin(id, name) {
  voicePeerNames.set(id, name);
  renderVoiceRoster();
  // Bağlantıyı her zaman yeni katılan taraf başlatır; biz burada sadece
  // gelecek offer'ı bekleriz.
}

function handleVoiceLeave(id) {
  voicePeerNames.delete(id);
  closePeerConnection(id);
  renderVoiceRoster();
}

function teardownAllVoicePeers() {
  for (const id of Array.from(peerConnections.keys())) {
    closePeerConnection(id);
  }
  voicePeerNames.clear();
  renderVoiceRoster();
}

async function enableMic() {
  setMicState("connecting");

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setMicState("error");
    setTimeout(() => setMicState("off"), 2000);
    return;
  }

  // Sesli sohbete katılıyoruz ama bas-konuş tuşuna/basılı tutma butonuna
  // basılana kadar mikrofon sessiz (track devre dışı) — bağlantı hazır
  // bekliyor, konuşmaya başladığımız an track'i etkinleştiriyoruz.
  localStream.getTracks().forEach((t) => { t.enabled = false; });
  isTalking = false;

  setMicState("on");

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "voice-join" }));
  }
}

function disableMic() {
  stopTalking();

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  teardownAllVoicePeers();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "voice-leave" }));
  }

  setMicState("off");
}

micBtn.addEventListener("click", () => {
  if (micState === "on") {
    disableMic();
  } else if (micState === "off" || micState === "error") {
    enableMic();
  }
});

if (!navigator.mediaDevices || !window.RTCPeerConnection) {
  micBtn.disabled = true;
  micBtn.title = "Bu tarayıcı sesli sohbeti desteklemiyor";
}

// ---------- Bas-konuş (push-to-talk) ----------

const PTT_KEY_STORAGE_KEY = "perde-ptt-key";
let pttKey = localStorage.getItem(PTT_KEY_STORAGE_KEY) || "Space";
let isRebindingPtt = false;

function friendlyKeyName(code) {
  if (!code) return "Space";
  if (code === "Space") return "Space";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Arrow")) return code.slice(5);
  return code;
}

function renderPttKeyLabel() {
  pttKeyLabel.textContent = friendlyKeyName(pttKey);
}
renderPttKeyLabel();

function startTalking() {
  if (!localStream || micState !== "on" || isTalking) return;
  isTalking = true;
  localStream.getTracks().forEach((t) => { t.enabled = true; });
  micBtn.dataset.talking = "true";
  pttBtn.dataset.talking = "true";
}

function stopTalking() {
  if (!isTalking) {
    micBtn.removeAttribute("data-talking");
    pttBtn.removeAttribute("data-talking");
    return;
  }
  isTalking = false;
  if (localStream) {
    localStream.getTracks().forEach((t) => { t.enabled = false; });
  }
  micBtn.removeAttribute("data-talking");
  pttBtn.removeAttribute("data-talking");
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

// Basılı tutma: bas-konuş butonuna fare/dokunmatikle basılı tutmak
pttBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  pttBtn.setPointerCapture(e.pointerId);
  startTalking();
});
["pointerup", "pointercancel", "pointerleave"].forEach((evt) => {
  pttBtn.addEventListener(evt, () => stopTalking());
});

// Basılı tutma: klavyeden atanan tuş (varsayılan: Space)
document.addEventListener("keydown", (e) => {
  if (isRebindingPtt) return;

  if (e.code === pttKey && !e.repeat && !isTypingTarget(document.activeElement)) {
    e.preventDefault();
    startTalking();
  }
});

document.addEventListener("keyup", (e) => {
  if (e.code === pttKey) {
    stopTalking();
  }
});

// Sekme/pencere odağını kaybedince tuş bırakılmış sayılır, aksi halde
// mikrofon "yapışık" kalıp sürekli açık kalabilir.
window.addEventListener("blur", () => stopTalking());

// Tuş değiştirme: butona tıkla, sonra istediğin tuşa bas
pttRebindBtn.addEventListener("click", () => {
  if (isRebindingPtt) return;
  isRebindingPtt = true;
  pttRebindBtn.dataset.listening = "true";
  const prevLabel = pttKeyLabel.textContent;
  pttKeyLabel.textContent = "Tuşa bas…";

  const onKey = (e) => {
    e.preventDefault();
    if (e.code === "Escape") {
      pttKeyLabel.textContent = prevLabel;
    } else {
      pttKey = e.code;
      localStorage.setItem(PTT_KEY_STORAGE_KEY, pttKey);
      renderPttKeyLabel();
    }
    isRebindingPtt = false;
    pttRebindBtn.removeAttribute("data-listening");
    document.removeEventListener("keydown", onKey, true);
  };

  document.addEventListener("keydown", onKey, true);
});