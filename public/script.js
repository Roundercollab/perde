let videoPlayer = document.getElementById("video-player");
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
  if (renameVideo.open) renameVideo.close();
  peerVolumes.clear();
  clearTimeout(reconnectTimer);

  cameraLayout.clear();
  renderPlaylist([]);
  deviceSession++;
  setPresenter(null);
  deviceSelect.disabled = qualitySelect.disabled = cameraBtn.disabled = false;
  pageLookup?.abort();
  showCameraStatus("");
  disableCamera();
  disableMic();
  teardownAllVoicePeers();

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
  resetPlayer();
  showMediaStatus("");
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
    setPresenter(null);
    teardownAllVoicePeers();
    reconnectTimer = setTimeout(connectSocket, 3000);
  };

  ws.onerror = () => {
    ws.close();
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "joined" && window.RTCPeerConnection) {
      if (data.turn) RTC_CONFIG.iceServers = [RTC_CONFIG.iceServers[0], data.turn];
      ws.send(JSON.stringify({ type: "voice-join" }));
    }
    if (data.type === "mic-state") remoteMic(data.id, data.name, data.active);
    if (data.type === "mic-relay") prepareMicRelay(data.active);
    if (data.type === "mic-audio") playRoomAudio(data.from, data.pcm);
    if (data.type === "playlist") renderPlaylist(data.items);
    if (data.type === "joined") {
      renderPlaylist(data.playlist || []);
      for (const mic of data.microphones || []) remoteMic(mic.id, mic.name, true);
      sendRoom({type: "mic-state", active: Boolean(localStream)});
      setPresenter(data.presenter || null);
      for (const camera of data.cameras || []) setRemoteCamera(camera.id, camera.name, true);
      announceCamera();
    }
    if (data.type === "camera-state") setRemoteCamera(data.id, data.name, data.active);
    if (data.type === "camera-relay") setCameraRelay(data.active);
    if (data.type === "camera-frame" && cameraReceivers.get(data.from)?.subscribed) {
      const image = cameraTiles.get(data.from)?.querySelector("img");
      if (image) {
        image.src = data.jpeg;
        image.hidden = false;
      }
    }
    if (data.type === "presenter") setPresenter(data.id);
    if (data.type === "joined" && data.state) {
      applyState(data.state);
    }

    if (data.type === "state" || data.type === "snapshot") {
      if (data.type === "state") pageLookup?.abort();
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

const mediaStatus = document.getElementById("media-status");
const nativeTemplate = videoPlayer.cloneNode(false);
let desiredState = null;
let loadTimer;
let pageLookup;
let sourceChoices = [];

function requestPlaybackSync() {
  if (ws?.readyState !== WebSocket.OPEN || !desiredState) return;
  const report = { type: "sync" };
  if (desiredState.by === myClientId && videoPlayer.readyState >= 2 && !videoPlayer.seeking) {
    Object.assign(report, { source: desiredState.source, item: desiredState.item || null, time: videoPlayer.currentTime, playing: !videoPlayer.paused, rate: videoPlayer.playbackRate });
  }
  ws.send(JSON.stringify(report));
}
setInterval(requestPlaybackSync, 5000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) requestPlaybackSync();
});

function showMediaStatus(message) {
  mediaStatus.textContent = message;
  mediaStatus.hidden = !message;
}

function identifySource(input) {
  const raw = input.trim();
  const url = new URL(/^[\w.-]+\.[a-z]{2,}\//i.test(raw) ? "https://" + raw : raw);
  if (!["http:", "https:"].includes(url.protocol) || url.href.length > 2000 || url.username || url.password) throw Error();
  const host = url.hostname.replace(/^(www\.|m\.)/, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if (["youtube.com", "youtube-nocookie.com", "youtu.be"].includes(host)) {
    const id = host === "youtu.be" ? parts[0] : url.searchParams.get("v") ||
      (["shorts", "embed", "live"].includes(parts[0]) && parts[1]);
    if (!id || !/^[\w-]{11}$/.test(id)) throw Error();
    return { tag: "youtube-video", url: "https://www.youtube.com/watch?v=" + id };
  }
  if (["vimeo.com", "player.vimeo.com"].includes(host) && /^(\/video)?\/\d+(\/|$)/.test(url.pathname)) {
    return { tag: "vimeo-video", url: url.href };
  }
  return { tag: /\.m3u8$/i.test(url.pathname) ? "hls-video" : "video", url: url.href };
}

function resetPlayer() {
  desiredState = null;
  clearTimeout(loadTimer);
  clearTimeout(remoteUpdateResetTimer);
  isRemoteUpdate = false;
  const old = videoPlayer;
  videoPlayer = nativeTemplate.cloneNode(false);
  old.replaceWith(videoPlayer);
  old.removeAttribute("src");
  if (old instanceof HTMLVideoElement) old.load();
  lastPlaybackTime = 0;
  seekStartTime = null;
}

function applyState(state) {
  if (!state?.source) return;
  let source;
  try { source = identifySource(state.source); } catch { return; }
  state = { ...state, updatedAt: Date.now() };
  const changedItem = desiredState?.item !== state.item;
  if (desiredState?.source === source.url && (desiredState.item || null) === (state.item || null)) {
    desiredState = state;
    if (videoPlayer.readyState >= 1) syncPlayback();
    return;
  }
  resetPlayer();
  desiredState = { ...state, source: source.url };
  if (changedItem) renderPlaylist();
  const player = source.tag === "video" ? videoPlayer : document.createElement(source.tag);
  if (player !== videoPlayer) {
    player.id = "video-player";
    player.setAttribute("controls", "");
    player.setAttribute("playsinline", "");
    videoPlayer.replaceWith(player);
    videoPlayer = player;
  }
  theatre.classList.add("has-video");
  showMediaStatus("");
  bindPlayer(player);
  const failed = () => {
    if (player !== videoPlayer) return;
    player.dataset.failed = "true";
    clearTimeout(loadTimer);
    showMediaStatus("Video açılamadı. Paylaşım iznini kontrol et veya doğrudan bir video bağlantısı dene. ");
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Kaynağında aç";
    mediaStatus.appendChild(link);
    if (!shareTab.hidden) mediaStatus.append(" veya videoyu ayrı bir sekmede açıp Sekme paylaş düğmesini kullan.");

    if (sourceChoices.includes(source.url) && sourceChoices.length > 1) {
      const next = document.createElement("button");
      next.type = "button";
      next.textContent = "Sayfadaki sonraki videoyu dene";
      next.onclick = () => publishSource(sourceChoices[(sourceChoices.indexOf(source.url) + 1) % sourceChoices.length]);
      mediaStatus.append(" ", next);
    }
  };
  player.addEventListener("error", failed);
  player.addEventListener("loadedmetadata", () => {
    if (player !== videoPlayer) return;
    clearTimeout(loadTimer);
    delete player.dataset.failed;
    showMediaStatus("");
    syncPlayback();
  });
  loadTimer = setTimeout(failed, 25000);
  const open = () => { if (player === videoPlayer) player.src = source.url; };
  if (source.tag === "video") open();
  else import("./players/" + source.tag + "-element.js").then(() => {
    if (player !== videoPlayer) return;
    if (source.tag === "youtube-video") player.config = { fs: 0, origin: location.origin };
    open();
  }, failed);
}

function syncPlayback() {
  const state = desiredState;
  if (!state) return;
  const elapsed = state.playing && state.updatedAt ? Math.max(0, Date.now() - state.updatedAt) / 1000 : 0;
  const time = state.time + elapsed * state.rate;
  const needsSeek = Math.abs(videoPlayer.currentTime - time) > 1;
  if (!needsSeek && videoPlayer.playbackRate === state.rate && state.playing === !videoPlayer.paused) return;
  isRemoteUpdate = true;
  clearTimeout(remoteUpdateResetTimer);
  try {
    if (needsSeek) videoPlayer.currentTime = time;
    if (videoPlayer.playbackRate !== state.rate) videoPlayer.playbackRate = state.rate;
    if (state.playing && videoPlayer.paused) {
      const player = videoPlayer;
      Promise.resolve(player.play()).catch(() => {
        if (player === videoPlayer) showMediaStatus("Devam etmek için oynat düğmesine dokun.");
      });
    } else if (!state.playing && !videoPlayer.paused) videoPlayer.pause();
  } finally {
    remoteUpdateResetTimer = setTimeout(() => { isRemoteUpdate = false; }, 350);
  }
}

function sendState() {
  if (isRemoteUpdate || !ws || ws.readyState !== WebSocket.OPEN) return;

  if (!desiredState || presenter) return;
  Object.assign(desiredState, { by: myClientId, playing: !videoPlayer.paused, time: videoPlayer.currentTime, rate: videoPlayer.playbackRate, updatedAt: Date.now() });
  ws.send(JSON.stringify({
    type: "state",
    source: desiredState.source,
    item: desiredState.item || null,
    playing: !videoPlayer.paused,
    time: videoPlayer.currentTime,
    rate: videoPlayer.playbackRate
  }));
}

// Zamanı sürekli takip ediyoruz ki bir sarma (seek) başladığında
// öncesindeki zamanı bilip kaç saniye sarıldığını hesaplayabilelim.
function bindPlayer(player) {
  player.addEventListener("timeupdate", () => {
    if (player !== videoPlayer) return;
    if (!videoPlayer.seeking) {
      lastPlaybackTime = videoPlayer.currentTime;
    }
  });

  player.addEventListener("seeking", () => {
    if (player !== videoPlayer) return;
    if (isRemoteUpdate) return;
    if (seekStartTime === null) {
      seekStartTime = lastPlaybackTime;
    }
  });

  player.addEventListener("play", () => {
    if (player !== videoPlayer) return;
    if (desiredState?.playing === false) isRemoteUpdate = false;
    sendState();
    if (!isRemoteUpdate) sendAction("videoyu oynattı");
  });

  player.addEventListener("pause", () => {
    if (player !== videoPlayer) return;
    if (desiredState?.playing === true) isRemoteUpdate = false;
    sendState();
    if (!isRemoteUpdate) sendAction("videoyu durdurdu");
  });

  player.addEventListener("seeked", () => {
    if (player !== videoPlayer) return;
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

  player.addEventListener("ratechange", () => {
    if (player !== videoPlayer) return;
    if (videoPlayer.playbackRate !== desiredState?.rate) isRemoteUpdate = false;
    sendState();
    if (!isRemoteUpdate) sendAction(`hızı ${videoPlayer.playbackRate}x yaptı`);
  });
  player.addEventListener("ended", () => {
    if (player !== videoPlayer || !desiredState || presenter) return;
    sendState();
    sendRoom({type: "playlist", action: "ended", source: desiredState.source, id: desiredState.item || null});
  });
  player.addEventListener("webkitbeginfullscreen", () => {
    player.webkitExitFullscreen?.();
    goFullscreenOnTheatre();
  });
}

seekBackBtn.addEventListener("click", () => {
  if (!videoPlayer.readyState) return;
  videoPlayer.currentTime = Math.max(0, videoPlayer.currentTime - 5);
});

seekFwdBtn.addEventListener("click", () => {
  if (!videoPlayer.readyState) return;
  const max = isFinite(videoPlayer.duration) ? videoPlayer.duration : Infinity;
  videoPlayer.currentTime = Math.min(max, videoPlayer.currentTime + 5);
});

function publishSource(url) {
  const state = { source: url, playing: false, time: 0, rate: 1, by: myClientId };
  if (videoPlayer.dataset.failed) resetPlayer();
  applyState(state);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "state", ...state, load: true }));
}

function sendRoom(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

let playlistItems = [];
const renameVideo = document.getElementById("rename-video");
const videoName = document.getElementById("video-name");
let namingEntry;
document.getElementById("cancel-name").onclick = () => renameVideo.close();
renameVideo.querySelector("form").onsubmit = event => {
  event.preventDefault();
  if (namingEntry?.socket === ws) sendRoom({type: "playlist", action: "rename", id: namingEntry.id, title: videoName.value});
  renameVideo.close();
};
function renderPlaylist(items = playlistItems) {
  playlistItems = items;
  document.getElementById("queue-count").textContent = items.length;
  const list = document.getElementById("queue-items");
  list.replaceChildren();
  for (const entry of items) {
    const row = document.createElement("li");
    const play = document.createElement("button");
    play.textContent = entry.title || entry.source;
    play.title = "Oynat · " + entry.source;
    play.disabled = Boolean(presenter);
    play.onclick = () => sendRoom({type: "playlist", action: "play", id: entry.id});
    const current = desiredState?.item === entry.id;
    if (current) row.setAttribute("aria-current", "true");
    const remove = document.createElement("button");
    remove.textContent = current ? "Oynatılıyor" : "Kaldır";
    remove.disabled = current;
    remove.onclick = () => sendRoom({type: "playlist", action: "remove", id: entry.id});
    const rename = document.createElement("button");
    rename.textContent = "Ad ver";
    rename.onclick = () => {
      namingEntry = {id: entry.id, socket: ws};
      videoName.value = entry.title || "";
      renameVideo.showModal();
      videoName.select();
    };
    row.append(play, rename, remove);
    list.appendChild(row);
  }
}

async function resolveInput(signal) {
  let choices = [];
  const url = videoUrlInput.value.trim();
  if (!url) return;
  let source;
  try { source = identifySource(url); } catch {
    showMediaStatus("Geçerli bir video bağlantısı gir.");
    return;
  }
  if (source.tag === "video" && !/\.(mp4|m4v|webm|ogv|ogg|mov)$/i.test(new URL(source.url).pathname)) {

    showMediaStatus("Sayfadaki video aranıyor…");
    try {
      const response = await fetch("/api/video-page?url=" + encodeURIComponent(source.url), { signal });
      if (response.ok) {
        const { sources } = await response.json();
        choices = sources.flatMap(value => {
          try { return [identifySource(value).url]; } catch { return []; }
        });
      }
    } catch {}
    if (signal.aborted) return;
  }
  return {url: choices[0] || source.url, choices};
}

loadVideoBtn.addEventListener("click", async () => {
  pageLookup?.abort();
  pageLookup = new AbortController();
  const result = await resolveInput(pageLookup.signal);
  if (!result) return;
  sourceChoices = result.choices;
  publishSource(result.url);
});

const addToList = document.getElementById("queue-add");
addToList.onclick = async () => {
  const socket = ws;
  const input = videoUrlInput.value;
  addToList.disabled = true;
  try {
    const result = await resolveInput(AbortSignal.timeout(9000));
    if (!result || socket !== ws || ws?.readyState !== WebSocket.OPEN) return;
    sendRoom({type: "playlist", action: "add", source: result.url});
    if (videoUrlInput.value === input) videoUrlInput.value = "";
    document.getElementById("playlist").open = true;
    showMediaStatus("");
  } finally { addToList.disabled = false; }
};
videoUrlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadVideoBtn.click();
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
  if (emoji === "sahur") {
    el.appendChild(emoteBar.querySelector('[data-emoji="sahur"] img').cloneNode());
  } else if (emoji === "sahur-og" || emoji === "sahur-yk") {
    el.appendChild(emoteBar.querySelector('[data-emoji="' + emoji + '"] span').cloneNode());
  } else {
    el.textContent = emoji;
  }

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
//
// NOT: Firefox `controlsList="nofullscreen"` özelliğini desteklemiyor
// (bu sadece Chromium tabanlı tarayıcılarda çalışan standart-dışı bir
// özellik), bu yüzden Firefox'ta videonun kendi native tam ekran ikonu
// hâlâ görünür durumda. Ayrıca Firefox, bir fullscreen isteğinden hemen
// sonra (kullanıcı tıklamasından kopmuş, ör. bir .then() içinde) yapılan
// İKİNCİ bir fullscreen isteğini genelde reddeder ("transient activation"
// kuralı) — bu yüzden exit + tekrar-fullscreen zincirini tek adımda,
// mümkünse exit'e hiç gerek kalmadan yapıyoruz ve her hatayı görünür
// kılıyoruz (önceden sessizce başarısız oluyordu).

function requestFullscreenOn(el) {
  const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
  if (!fn) {
    appendMessage({ system: true, text: "Bu tarayıcı tam ekranı desteklemiyor." });
    return Promise.reject(new Error("no fullscreen API"));
  }
  return Promise.resolve(fn.call(el)).catch((err) => {
    appendMessage({ system: true, text: "Tam ekran açılamadı: " + (err?.message || "tarayıcı reddetti") + ". Lütfen tam ekran butonuna tekrar basmayı deneyin." });
    throw err;
  });
}

function exitFullscreenNow() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
  return fn ? Promise.resolve(fn.call(document)).catch(() => {}) : Promise.resolve();
}

function currentFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || null;
}

function goFullscreenOnTheatre() {
  return requestFullscreenOn(theatre);
}

fullscreenBtn.addEventListener("click", () => {
  if (currentFullscreenElement()) {
    exitFullscreenNow();
  } else {
    goFullscreenOnTheatre();
  }
});

let redirectingFullscreen = false;

function redirectNativeVideoFullscreen() {
  const fsEl = currentFullscreenElement();

  if (fsEl === videoPlayer && !redirectingFullscreen) {
    redirectingFullscreen = true;

    // Önce exit etmeden, video zaten fullscreen'deyken doğrudan theatre'ı
    // isteyerek deniyoruz — bu, kullanıcı tıklamasıyla aynı olay zincirine
    // daha yakın kaldığı için Firefox'ta exit+then'e göre daha güvenilir.
    goFullscreenOnTheatre()
      .catch(() => exitFullscreenNow().then(() => goFullscreenOnTheatre()).catch(() => {}))
      .finally(() => { redirectingFullscreen = false; });
  }
}

document.addEventListener("fullscreenchange", redirectNativeVideoFullscreen);
document.addEventListener("webkitfullscreenchange", redirectNativeVideoFullscreen);
document.addEventListener("mozfullscreenchange", redirectNativeVideoFullscreen);

document.addEventListener("fullscreenerror", () => {
  appendMessage({ system: true, text: "Tam ekran isteği tarayıcı tarafından reddedildi." });
});

// iOS Safari, videoyu standart Fullscreen API yerine kendi native tam ekran
// oynatıcısına açar (webkitbeginfullscreen). Bunu da yakalayıp theatre'a
// yönlendirmeyi deniyoruz.
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
const disconnectTimers = new Map();  // clientId -> "disconnected" durumundan toparlanma bekleme zamanlayıcısı
const relayRetried = new Set();      // clientId'ler — relay-only ile zaten bir kez yeniden denendi mi

// İki taraf da bağlantıyı aynı anda yeniden kurmaya çalışıp çakışmasın diye
// basit bir "kimin başlatacağı" kuralı: clientId'si küçük olan taraf başlatır.
function shouldInitiateTo(peerId) {
  return myClientId < peerId;
}

const micMode = document.getElementById("mic-mode");
micMode.value = localStorage.getItem("perde-mic-mode") === "ptt" ? "ptt" : "open";
micMode.onchange = () => {
  localStorage.setItem("perde-mic-mode", micMode.value);
  if (!localStream) return;
  stopTalking();
  localStream.getAudioTracks()[0].enabled = micMode.value === "open";
  setMicState("on");
};

function setMicState(state) {
  micState = state;
  micBtn.dataset.state = state;

  const labels = {
    off: "Mikrofonu aç",
    connecting: "Bağlanıyor…",
    on: micMode.value === "ptt" ? "Bas-konuş etkin" : "Mikrofon açık",
    error: "Mikrofon hatası"
  };
  micLabel.textContent = labels[state] || "Mikrofon";
  micBtn.title = state === "on" ? "Sesli sohbetten çık" : "Sesli sohbete katıl";

  const connected = state === "on";
  micBtn.setAttribute("aria-pressed", String(connected));
  micBtn.setAttribute("aria-label", connected ? "Mikrofonu kapat" : "Mikrofonu aç");
  pttBtn.hidden = pttRebindBtn.hidden = !connected || micMode.value !== "ptt";
  if (!connected) stopTalking();
}

function renderVoiceRoster() {
  voiceRoster.innerHTML = "";

  if (activeMics.size === 0) {
    voiceRoster.hidden = true;
    return;
  }

  voiceRoster.hidden = false;

  for (const [id, name] of voicePeerNames.entries()) {
    if (!activeMics.has(id)) continue;
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

    const row = document.createElement("div");
    row.className = "voice-level";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "200";
    slider.step = "5";
    slider.value = String(Math.round(100 * (peerVolumes.get(id) ?? 1)));
    slider.setAttribute("aria-label", name + " için dinleme sesi");
    const percent = document.createElement("span");
    const display = () => {
      percent.textContent = "%" + slider.value;
      slider.setAttribute("aria-valuetext", percent.textContent);
    };
    display();
    slider.oninput = () => {
      peerVolumes.set(id, Number(slider.value) / 100);
      display();
      updateVoiceOutput(id);
    };
    row.append(pill, slider, percent);
    voiceRoster.appendChild(row);
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
  updateVoiceOutput(id);
  renderVoiceRoster();
}

function createPeerConnection(peerId, forceRelay = false, initiator = true) {
  const config = forceRelay
    ? { iceServers: RTC_CONFIG.iceServers, iceTransportPolicy: "relay" }
    : RTC_CONFIG;

  const pc = new RTCPeerConnection(config);

  for (const [kind, track] of [["audio", localStream?.getAudioTracks()[0]], ["video", cameraTrack]]) {
    if (initiator) pc.addTransceiver(track || kind, { direction: "sendrecv" });
  }
  if (initiator) {
    const channels = ["video", "audio"].map(kind =>
      pc.addTransceiver(outgoingPresentationTrack(kind) || kind, { direction: "sendrecv" })
    );
    presentationChannels.set(pc, channels);
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendSignal(peerId, { candidate: e.candidate });
    }
  };

  pc.ontrack = (e) => {
    if (isPresentationChannel(pc, e.transceiver)) {
      const stream = remotePresentations.get(peerId) || new MediaStream();
      stream.getTracks().filter(t => t.kind === e.track.kind).forEach(t => stream.removeTrack(t));
      stream.addTrack(e.track);
      remotePresentations.set(peerId, stream);
      if (presenter === peerId) displayPresentation();
      return;
    }
    if (e.track.kind === "video") {
      remoteVideoTracks.set(peerId, e.track);
      renderCamera(peerId);
      return;
    }
    let audioEl = remoteAudioEls.get(peerId);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.muted = mutedPeers.has(peerId);
      voiceAudioLayer.appendChild(audioEl);
      remoteAudioEls.set(peerId, audioEl);
    }
    audioEl.srcObject = new MediaStream([e.track]);
    updateVoiceOutput(peerId);

    // Bazı tarayıcılar (özellikle Chrome) kullanıcı etkileşimi olmadan
    // programatik olarak eklenen sesi otomatik oynatmayı engelleyebiliyor.
    // Bu durumda sessizce başarısız olmasın, kullanıcıyı uyaralım ve bir
    // sonraki tıklamada tekrar deneyelim.
    const tryPlay = () => audioEl.play().catch(() => {
      appendMessage({ system: true, text: "Tarayıcı sesi otomatik oynatmayı engelledi — sayfaya bir kez tıklayın." });
      const retryOnce = () => { audioEl.play().catch(() => {}); document.removeEventListener("click", retryOnce); };
      document.addEventListener("click", retryOnce, { once: true });
    });
    tryPlay();
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;

    if (state === "connected") {
      clearTimeout(disconnectTimers.get(peerId));
      disconnectTimers.delete(peerId);
      relayRetried.delete(peerId); // başarıyla bağlandı, retry sayacını sıfırla
      return;
    }

    if (state === "failed") {
      handleConnectionTrouble(peerId);
      return;
    }

    if (state === "disconnected") {
      // "disconnected" genelde geçici bir ağ tıkanıklığıdır ve kendiliğinden
      // toparlanabilir — hemen kapatmak yerine birkaç saniye bekleyip hâlâ
      // toparlanmadıysa sorunlu kabul ediyoruz.
      if (!disconnectTimers.has(peerId)) {
        const timer = setTimeout(() => {
          disconnectTimers.delete(peerId);
          if (peerConnections.get(peerId) === pc && pc.connectionState !== "connected") {
            handleConnectionTrouble(peerId);
          }
        }, 6000);
        disconnectTimers.set(peerId, timer);
      }
      return;
    }

    if (state === "closed") {
      closePeerConnection(peerId);
    }
  };

  peerConnections.set(peerId, pc);
  return pc;
}

// Bağlantı kurulamadığında/koptuğunda bir kez TURN relay'e zorlayarak
// yeniden denenir (birçok "ses hiç gitmiyor" durumu doğrudan P2P bağlantı
// kurulamamasından kaynaklanır — relay'e zorlamak bunu genelde çözer).
function handleConnectionTrouble(peerId) {
  const alreadyVoiceConnected = voicePeerNames.has(peerId);
  const attempted = relayRetried.has(peerId);
  closePeerConnection(peerId);

  if (!alreadyVoiceConnected) return;

  if (attempted) {
    appendMessage({ system: true, text: "Kamera ve ses bağlantısı kurulamadı. Farklı ağlar arasında TURN bağlantısını kontrol edin." });
    return;
  }
  relayRetried.add(peerId);

  if (shouldInitiateTo(peerId)) {
    callPeer(peerId, true);
  } else {
    sendSignal(peerId, { retry: true });
  }
  // Diğer taraf yeni offer'ı bekleyecek (createPeerConnection offer geldiğinde otomatik kurulur).
}

function closePeerConnection(peerId) {
  disconnectDirectMixer(peerId);
  const pc = peerConnections.get(peerId);
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.close();
    peerConnections.delete(peerId);
  }

  clearTimeout(disconnectTimers.get(peerId));
  disconnectTimers.delete(peerId);

  const audioEl = remoteAudioEls.get(peerId);
  if (audioEl) {
    audioEl.srcObject = null;
    audioEl.remove();
    remoteAudioEls.delete(peerId);
  }

  remotePresentations.delete(peerId);
  if (presenter === peerId) displayPresentation();
  remoteVideoTracks.delete(peerId);
  renderCamera(peerId);
  pendingCandidates.delete(peerId);
  relayRetried.delete(peerId);
}

function sendSignal(toId, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "signal", to: toId, data: { ...data, camera: Boolean(cameraTrack), mic: Boolean(localStream) } }));
}

async function callPeer(peerId, forceRelay = false) {
  const pc = createPeerConnection(peerId, forceRelay);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (peerConnections.get(peerId) === pc) sendSignal(peerId, { sdp: pc.localDescription, presentationMids: (presentationChannels.get(pc) || []).map(t => t.mid) });
  } catch (err) {
    if (peerConnections.get(peerId) === pc) closePeerConnection(peerId);
  }
}

async function handleSignal(fromId, data) {
  if (!window.RTCPeerConnection || !roomCode) return;
  if (typeof data.mic === "boolean" && activeMics.has(fromId) !== data.mic) {
    if (data.mic) activeMics.add(fromId);
    else activeMics.delete(fromId);
    renderVoiceRoster();
  }
  if (typeof data.camera === "boolean" && !cameraReceivers.has(fromId)) {
    if (data.camera) visibleCameras.add(fromId);
    else visibleCameras.delete(fromId);
    renderCamera(fromId);
  }

  if (data.retry && shouldInitiateTo(fromId) && voicePeerNames.has(fromId) && !relayRetried.has(fromId)) {
    handleConnectionTrouble(fromId);
    return;
  }
  let pc = peerConnections.get(fromId);

  if (data.sdp) {
    if (!pc) pc = createPeerConnection(fromId, false, false);

    try {
      if (data.sdp.type === "offer") presentationMids.set(pc, new Set(data.presentationMids || []));
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (peerConnections.get(fromId) !== pc) return;

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
        for (const channel of pc.getTransceivers()) {
          channel.direction = "sendrecv";
          const kind = channel.receiver.track.kind;
          const track = isPresentationChannel(pc, channel) ? outgoingPresentationTrack(kind)
            : kind === "video" ? cameraTrack : localStream?.getAudioTracks()[0];
          await channel.sender.replaceTrack(track || null);
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (peerConnections.get(fromId) === pc) sendSignal(fromId, { sdp: pc.localDescription });
      }
    } catch (err) {
      if (peerConnections.get(fromId) === pc) closePeerConnection(fromId);
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
  peerVolumes.delete(id);
  remoteMic(id, "", false);
  mutedPeers.delete(id);
  activeMics.delete(id);
  cameraReceivers.delete(id);
  visibleCameras.delete(id);
  voicePeerNames.delete(id);
  closePeerConnection(id);
  renderVoiceRoster();
}

function teardownAllVoicePeers() {
  prepareMicRelay(false);
  for (const id of voiceRoutes.keys()) remoteMic(id, "", false);
  mutedPeers.clear();
  setCameraRelay(false);
  for (const id of [...visibleCameras]) setRemoteCamera(id, "", false);
  for (const id of Array.from(peerConnections.keys())) {
    closePeerConnection(id);
  }
  activeMics.clear();
  visibleCameras.clear();
  voicePeerNames.clear();
  renderVoiceRoster();
}

function micErrorMessage(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Mikrofon izni reddedildi. Tarayıcının adres çubuğundaki kilit/site ayarları simgesinden mikrofona izin verip tekrar deneyin.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "Mikrofon bulunamadı. Bir mikrofonun takılı/etkin olduğundan emin olun.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Mikrofona ulaşılamıyor — muhtemelen başka bir uygulama (Zoom, Discord, Teams vb.) kullanıyor.";
  }
  if (name === "SecurityError") {
    return "Güvenlik kısıtlaması: site HTTPS (veya localhost) üzerinden açılmalı, mikrofon aksi halde çalışmaz.";
  }
  if (!window.isSecureContext) {
    return "Bu sayfa güvenli bağlamda (HTTPS) açılmadığı için tarayıcı mikrofona izin vermiyor.";
  }
  return `Mikrofon hatası: ${name || "bilinmeyen hata"}.`;
}

const cameraBtn = document.getElementById("camera-btn");
const cameraStrip = document.getElementById("camera-strip");
const remoteVideoTracks = new Map();
const cameraReceivers = new Map();
const relayCanvas = document.createElement("canvas");
let frameTimer;

function announceCamera() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "camera-state", active: Boolean(cameraTrack) }));
}

function setCameraRelay(active) {
  clearInterval(frameTimer);
  if (!active || !cameraTrack) return;
  frameTimer = setInterval(() => {
    const video = cameraTiles.get(myClientId)?.querySelector("video");
    if (ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount > 65536 || !video?.videoWidth || video.readyState < 2) return;
    const scale = Math.min(1, 320 / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    if (relayCanvas.width !== width || relayCanvas.height !== height) {
      relayCanvas.width = width;
      relayCanvas.height = height;
    }
    relayCanvas.getContext("2d").drawImage(video, 0, 0, width, height);
    let jpeg = relayCanvas.toDataURL("image/jpeg", 0.55);
    if (jpeg.length > 65536) jpeg = relayCanvas.toDataURL("image/jpeg", 0.30);
    if (jpeg.length <= 65536) ws.send(JSON.stringify({ type: "camera-frame", jpeg }));
  }, 160);
}

function setRemoteCamera(id, name, active) {
  if (active) {
    visibleCameras.add(id);
    voicePeerNames.set(id, name);
    if (!cameraReceivers.has(id)) cameraReceivers.set(id, { progress: 0, lastFrame: performance.now(), steady: 0, subscribed: false });
  } else {
    cameraReceivers.delete(id);
    visibleCameras.delete(id);
  }
  renderCamera(id);
}

setInterval(() => {
  if (ws?.readyState !== WebSocket.OPEN) return;
  for (const [id, receiver] of cameraReceivers) {
    const tile = cameraTiles.get(id);
    const video = tile?.querySelector("video");
    const progress = video?.getVideoPlaybackQuality?.().totalVideoFrames ?? video?.currentTime;
    if (video?.readyState >= 2 && !remoteVideoTracks.get(id)?.muted && progress !== receiver.progress) {
      receiver.progress = progress;
      receiver.lastFrame = performance.now();
      receiver.steady++;
    } else receiver.steady = 0;
    const stalled = performance.now() - receiver.lastFrame > 3000;
    if (receiver.subscribed === stalled) continue;
    if (!stalled && receiver.steady < 2) continue;
    receiver.subscribed = stalled;
    if (!stalled && tile) tile.querySelector("img").hidden = true;
    ws.send(JSON.stringify({ type: "camera-subscribe", to: id, active: stalled }));
  }
}, 750);
const visibleCameras = new Set();
const activeMics = new Set();
const cameraTiles = new Map();
let deviceSession = 0;
let cameraTrack = null;

const shareTab = document.getElementById("share-tab");
const shareAudio = document.getElementById("share-audio");
const sharedVideo = document.getElementById("shared-tab-video");
const remotePresentations = new Map();
const presentationChannels = new WeakMap();
const presentationMids = new WeakMap();
let presenter = null;
let capture = null;
let pickingTab = false;

function isPresentationChannel(pc, channel) {
  return presentationChannels.get(pc)?.includes(channel) || presentationMids.get(pc)?.has(channel.mid);
}
function outgoingPresentationTrack(kind) {
  if (presenter === myClientId) return capture?.getTracks().find(t => t.kind === kind);
}
function displayPresentation() {
  const own = presenter === myClientId;
  const stream = own ? capture : remotePresentations.get(presenter);
  if (sharedVideo.srcObject !== (stream || null)) sharedVideo.srcObject = stream || null;
  sharedVideo.hidden = !presenter;
  shareAudio.hidden = !presenter || own;
  theatre.classList.toggle("presenting", Boolean(presenter));
  if (stream) sharedVideo.play().catch(() => { if (!own) shareAudio.hidden = false; });
}
function setPresenter(id) {
  if (presenter !== id) {
    sharedVideo.muted = true;
    shareAudio.textContent = "Paylaşım sesini aç";
  }
  presenter = id;
  if (id) pageLookup?.abort();
  if (id !== myClientId && capture) {
    capture.getTracks().forEach(track => track.stop());
    capture = null;
  }
  for (const pc of peerConnections.values()) {
    for (const channel of pc.getTransceivers().filter(t => isPresentationChannel(pc, t))) {
      channel.sender.replaceTrack(outgoingPresentationTrack(channel.receiver.track.kind) || null).catch(() => {});
    }
  }
  shareTab.textContent = id === myClientId ? "Paylaşımı bitir" : "Sekme paylaş";
  shareTab.disabled = pickingTab || Boolean(id && id !== myClientId);
  loadVideoBtn.disabled = Boolean(id);
  renderPlaylist();
  displayPresentation();
}
function stopPresentation() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "present", active: false }));
  setPresenter(null);
}
shareAudio.onclick = () => {
  sharedVideo.muted = !sharedVideo.muted;
  shareAudio.textContent = sharedVideo.muted ? "Paylaşım sesini aç" : "Paylaşım sesini kapat";
  sharedVideo.play().catch(() => {});
};
shareTab.hidden = !navigator.mediaDevices?.getDisplayMedia || !window.RTCPeerConnection;
shareTab.onclick = async () => {
  if (presenter === myClientId) return stopPresentation();
  if (!roomCode || ws?.readyState !== WebSocket.OPEN || presenter || pickingTab) return;
  pickingTab = shareTab.disabled = true;
  const socket = ws;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" }, audio: true, selfBrowserSurface: "exclude", monitorTypeSurfaces: "exclude"
    });
    if (socket !== ws || ws.readyState !== WebSocket.OPEN || presenter) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    capture = stream;
    capture.getVideoTracks()[0].onended = stopPresentation;
    ws.send(JSON.stringify({ type: "present", active: true }));
  } catch (error) {
    if (socket === ws && error.name !== "NotAllowedError") showMediaStatus("Sekme paylaşımı başlatılamadı (" + error.name + ").");
  } finally {
    pickingTab = false;
    shareTab.disabled = Boolean(presenter && presenter !== myClientId);
  }
};

function placeCameraStrip() {
  if (currentFullscreenElement() === theatre) document.getElementById("video-wrap").appendChild(cameraStrip);
  else theatre.before(cameraStrip);
  for (const video of cameraStrip.querySelectorAll("video")) video.play().catch(() => { video.controls = true; });
}
document.addEventListener("fullscreenchange", placeCameraStrip);
document.addEventListener("webkitfullscreenchange", placeCameraStrip);
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !roomCode) return;
  for (const tile of cameraTiles.values()) {
    const preview = tile.querySelector("video");
    if (preview.srcObject && preview.paused) preview.play().catch(() => { preview.controls = true; });
  }
});

const cameraLayout = new Map();
function positionCamera(tile, layout) {
  const width = Math.min(innerWidth, innerHeight * 4 / 3, Math.max(72, layout.width));
  const left = Math.max(0, Math.min(innerWidth - width, layout.left));
  const top = Math.max(0, Math.min(innerHeight - width * 0.75, layout.top));
  tile.classList.add("placed");
  Object.assign(tile.style, {width: width + "px", left: left + "px", top: top + "px"});
}
function restoreCameraPositions() {
  for (const [id, tile] of cameraTiles) if (cameraLayout.has(id)) positionCamera(tile, cameraLayout.get(id));
}
window.addEventListener("resize", restoreCameraPositions);
document.getElementById("reset-cameras").onclick = () => {
  cameraLayout.clear();
  for (const tile of cameraTiles.values()) {
    tile.classList.remove("placed");
    tile.style.removeProperty("width");
    tile.style.removeProperty("left");
    tile.style.removeProperty("top");
  }
};

function cameraHandle(button, tile, id, resize) {
  let start;
  function adjust(rect, dx, dy) {
    const layout = resize
      ? {left: rect.left, top: rect.top, width: rect.width + (Math.abs(dx) >= Math.abs(dy) ? dx : dy * 4 / 3)}
      : {left: rect.left + dx, top: rect.top + dy, width: rect.width};
    cameraLayout.set(id, layout);
    positionCamera(tile, layout);
  }
  button.onpointerdown = event => {
    if (event.button !== 0) return;
    event.preventDefault();
    start = {rect: tile.getBoundingClientRect(), x: event.clientX, y: event.clientY};
    button.setPointerCapture(event.pointerId);
  };
  button.onpointermove = event => {
    if (start) adjust(start.rect, event.clientX - start.x, event.clientY - start.y);
  };
  button.onlostpointercapture = () => { start = null; };
  button.onkeydown = event => {
    const arrow = {ArrowLeft: [-12,0], ArrowRight: [12,0], ArrowUp: [0,-12], ArrowDown: [0,12]}[event.key];
    if (arrow) { event.preventDefault(); adjust(tile.getBoundingClientRect(), ...arrow); }
  };
}

function renderCamera(id) {
  const local = id === myClientId;
  const track = local ? cameraTrack : visibleCameras.has(id) && remoteVideoTracks.get(id);
  let tile = cameraTiles.get(id);
  if (!track && (local || !visibleCameras.has(id))) {
    if (tile) {
      tile.querySelector("video").srcObject = null;
      tile.remove();
      cameraTiles.delete(id);
    }
    return;
  }
  if (!tile) {
    tile = document.createElement("figure");
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    const caption = document.createElement("figcaption");
    const move = document.createElement("button");
    move.textContent = local ? "Sen" : voicePeerNames.get(id) || "Misafir";
    move.title = move.textContent + " · Kamerayı sürükle veya ok tuşlarıyla taşı";
    move.setAttribute("aria-label", move.title);
    caption.appendChild(move);
    const resize = document.createElement("button");
    resize.className = "camera-resize";
    resize.textContent = "⤡";
    resize.title = "Kamera boyutunu değiştir";
    resize.setAttribute("aria-label", resize.title);
    cameraHandle(move, tile, id, false);
    cameraHandle(resize, tile, id, true);
    const image = document.createElement("img");
    image.alt = "Oda bağlantısıyla iletilen kamera görüntüsü";
    image.hidden = true;
    tile.append(video, image, caption, resize);
    if (cameraLayout.has(id)) positionCamera(tile, cameraLayout.get(id));
    cameraTiles.set(id, tile);
    cameraStrip.appendChild(tile);
  }
  const video = tile.querySelector("video");
  if (!track) {
    video.srcObject = null;
  } else if (video.srcObject?.getVideoTracks()[0] !== track) {
    video.srcObject = new MediaStream([track]);
    video.play().catch(() => { video.controls = true; });
  }
}

function replaceOutgoingTrack(kind, track) {
  for (const [id, pc] of peerConnections) {
    const channel = pc.getTransceivers().find(t => !isPresentationChannel(pc, t) && t.receiver.track.kind === kind);
    channel?.sender.replaceTrack(track).catch(() => {
      if (peerConnections.get(id) === pc) appendMessage({ system: true, text: "Medya paylaşımı güncellenemedi. Odaya tekrar katıl." });
    });
  }
}

function updateCamera() {
  announceCamera();
  if (!cameraTrack) setCameraRelay(false);
  renderCamera(myClientId);
  replaceOutgoingTrack("video", cameraTrack);
  for (const id of peerConnections.keys()) sendSignal(id, {});
  cameraBtn.dataset.state = cameraTrack ? "on" : "off";
  cameraBtn.setAttribute("aria-pressed", String(Boolean(cameraTrack)));
  cameraBtn.textContent = cameraTrack ? "Kamera kapat" : "Kamera aç";
}

function disableCamera() {
  cameraTrack?.stop();
  cameraTrack = null;
  updateCamera();
}

const deviceSelect = document.getElementById("camera-device");
const qualitySelect = document.getElementById("camera-quality");
const cameraSize = document.getElementById("camera-size");
const cameraStatus = document.getElementById("camera-status");
function showCameraStatus(message) {
  cameraStatus.textContent = message;
  cameraStatus.hidden = !message;
}
async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput" && d.deviceId);
    const selected = deviceSelect.value || cameraTrack?.getSettings().deviceId;
    deviceSelect.replaceChildren(new Option("Varsayılan kamera", ""));
    for (const [index, device] of devices.entries()) deviceSelect.add(new Option(device.label || "Kamera " + (index + 1), device.deviceId));
    deviceSelect.value = devices.some(d => d.deviceId === selected) ? selected : "";
  } catch {}
}
document.getElementById("camera-settings").addEventListener("toggle", refreshDevices);
navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
cameraSize.oninput = () => cameraStrip.style.setProperty("--camera-size", cameraSize.value + "px");
deviceSelect.onchange = qualitySelect.onchange = () => { if (cameraTrack) openCamera(); };
cameraBtn.addEventListener("click", () => {
  if (cameraTrack) { disableCamera(); showCameraStatus(""); }
  else openCamera();
});

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraStatus("Kamera için siteyi HTTPS üzerinden, Chrome veya Safari gibi bir tarayıcıda aç.");
    return;
  }
  const session = deviceSession;
  deviceSelect.disabled = qualitySelect.disabled = cameraBtn.disabled = true;
  showCameraStatus("Kamera açılıyor. Tarayıcı izin isterse kameraya izin ver.");
  try {
    const height = Number(qualitySelect.value);
    const constraints = { height: { ideal: height }, width: { ideal: Math.round(height * 4 / 3) } };
    if (deviceSelect.value) constraints.deviceId = { exact: deviceSelect.value };
    if (cameraTrack && deviceSelect.value === cameraTrack.getSettings().deviceId) {
      await cameraTrack.applyConstraints({ height: constraints.height, width: constraints.width });
      if (session === deviceSession) showCameraStatus("");
      return;
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: constraints }); }
    catch (error) {
      if (!cameraTrack || error.name !== "NotReadableError" || session !== deviceSession) throw error;
      disableCamera();
      stream = await navigator.mediaDevices.getUserMedia({ video: constraints });
    }
    const track = stream.getVideoTracks()[0];
    if (session !== deviceSession) {
      track.stop();
      return;
    }
    cameraTrack?.stop();
    cameraTrack = track;
    track.onended = () => {
      if (cameraTrack !== track) return;
      disableCamera();
      showCameraStatus("Kamera bağlantısı kesildi. Kamera ayarlarından cihazı seçip tekrar aç.");
    };
    updateCamera();
    showCameraStatus("");
    await refreshDevices();
  } catch (error) {
    const messages = {
      NotAllowedError: "Kamera izni kapalı. Adres çubuğundaki site izinlerinden kameraya izin ver ve cihazının kamera gizlilik ayarını kontrol et.",
      NotFoundError: "Tarayıcı kamera bulamadı. Cihazı bağla ve Kamera ayarları bölümünden seç.",
      NotReadableError: "Kamera kullanımda olabilir. Kamerayı kullanan diğer uygulamayı kapatıp tekrar dene.",
      OverconstrainedError: "Seçilen kamera veya kalite kullanılamıyor. Varsayılan kamerayı ya da daha düşük kaliteyi seç."
    };
    if (session === deviceSession) showCameraStatus(messages[error.name] || "Kamera açılamadı (" + error.name + ").");
  } finally {
    if (session === deviceSession) deviceSelect.disabled = qualitySelect.disabled = cameraBtn.disabled = false;
  }
}

const noiseOption = document.getElementById("mic-noise");
const supportsNoise = Boolean(navigator.mediaDevices?.getSupportedConstraints?.().noiseSuppression);
noiseOption.checked = supportsNoise && localStorage.getItem("perde-noise") !== "off";
noiseOption.disabled = !supportsNoise;
if (!supportsNoise) noiseOption.parentElement.title = "Bu tarayıcı mikrofon gürültü azaltma ayarı sunmuyor.";
noiseOption.onchange = async () => {
  const wanted = noiseOption.checked;
  const track = localStream?.getAudioTracks()[0];
  noiseOption.disabled = true;
  try {
    if (track) {
      const constraints = {...track.getConstraints(), noiseSuppression: {exact: wanted}};
      try { await track.applyConstraints(constraints); } catch (error) {
        if (track.getSettings().noiseSuppression === undefined) throw error;
      }
      if (localStream?.getAudioTracks()[0] !== track) return;
      if (track.getSettings().noiseSuppression !== wanted) {
        // Some audio drivers only change processing when opening a new capture.
        const stream = await navigator.mediaDevices.getUserMedia({audio: constraints});
        const next = stream.getAudioTracks()[0];
        if (localStream?.getAudioTracks()[0] !== track) { next.stop(); return; }
        if (next.getSettings().noiseSuppression !== wanted) { next.stop(); throw Error(); }
        next.enabled = track.enabled;
        next.onended = disableMic;
        localStream = stream;
        disconnectCapture();
        replaceOutgoingTrack("audio", next);
        if (relayWanted) prepareMicRelay(true);
        track.stop();
      }
    }
    localStorage.setItem("perde-noise", wanted ? "on" : "off");
  } catch {
    noiseOption.checked = track?.getSettings().noiseSuppression ?? !wanted;
    appendMessage({system: true, text: "Bu mikrofon seçilen gürültü azaltma ayarını uygulayamadı."});
  } finally { noiseOption.disabled = !supportsNoise; }
};

async function enableMic() {
  const session = deviceSession;
  setMicState("connecting");

  try {
    noiseOption.disabled = true;
    const audio = supportsNoise ? {noiseSuppression: {ideal: noiseOption.checked}} : true;
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    if (session !== deviceSession) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    localStream = stream;
    const applied = stream.getAudioTracks()[0].getSettings().noiseSuppression;
    if (supportsNoise && typeof applied === "boolean") noiseOption.checked = applied;
  } catch (err) {
    if (session !== deviceSession) return;
    setMicState("error");
    appendMessage({ system: true, text: micErrorMessage(err) });

    return;
  } finally { if (session === deviceSession) noiseOption.disabled = !supportsNoise; }

  localStream.getAudioTracks()[0].enabled = micMode.value === "open";
  isTalking = false;

  replaceOutgoingTrack("audio", localStream.getAudioTracks()[0]);
  localStream.getAudioTracks()[0].onended = disableMic;
  setMicState("on");
  sendRoom({type: "mic-state", active: true});
  for (const id of peerConnections.keys()) sendSignal(id, {});
  appendMessage({ system: true, text: micMode.value === "open" ? "Mikrofon açık. Konuşman odadakilere iletiliyor." : `Sesli sohbete bağlandın. Konuşmak için "${friendlyKeyName(pttKey)}" tuşunu veya bas-konuş düğmesini basılı tut.` });

}

function disableMic() {
  noiseOption.disabled = !supportsNoise;
  prepareMicRelay(false);
  sendRoom({type: "mic-state", active: false});
  stopTalking();

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  replaceOutgoingTrack("audio", null);
  for (const id of peerConnections.keys()) sendSignal(id, {});

  setMicState("off");
}

micBtn.addEventListener("click", () => {
  if (micState === "on") {
    disableMic();
  } else if (micState === "off" || micState === "error") {
    enableMic();
  }
});

if (!navigator.mediaDevices?.getUserMedia) {
  micBtn.disabled = true;
  micBtn.title = "Kamera ve mikrofon için HTTPS veya localhost kullan.";

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
  if (!localStream || micMode.value !== "ptt" || micState !== "on" || isTalking) return;
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
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
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

  if (micMode.value === "ptt" && micState === "on" && e.code === pttKey && !e.repeat && !isTypingTarget(document.activeElement)) {
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
