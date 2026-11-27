const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/video-page", require("./resolve-video").resolveVideo);

function playbackSnapshot(room) {
  if (!room.state) return null;
  const state = room.state;
  const elapsed = state.playing ? Math.max(0, Date.now() - state.updatedAt) / 1000 : 0;
  return { ...state, time: state.time + elapsed * state.rate };
}

const rooms = new Map();
const MAX_ROOM_CODE_LEN = 30;
const MAX_SOURCE_LEN = 2000;
const MAX_ACTION_LEN = 100;
const MAX_EMOJI_LEN = 8;

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      users: new Map(),
      playlist: [],
      nextItem: 1,
      state: null
    });
  }

  return rooms.get(code);
}

function broadcast(room, message, except = null) {
  const data = JSON.stringify(message);

  for (const client of room.users.keys()) {
    if (client !== except && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// clientId'ye göre o odadaki websocket bağlantısını bulur (sinyal iletimi için).
function findWsByClientId(room, id) {
  for (const [clientWs, info] of room.users.entries()) {
    if (info.id === id) return clientWs;
  }
  return null;
}

// Odayı temizler: kullanıcı kalmadıysa Map'ten O(1) sürede kaldırır.
function cleanupRoomIfEmpty(room) {
  if (room && room.users.size === 0) {
    rooms.delete(room.code);
  }
}

wss.on("connection", (ws) => {
  let room = null;
  let clientId = null;
  let name = "Misafir";

  // Heartbeat: sekmesi kapanmadan aniden kopan (wifi kesilmesi vb.)
  // bağlantıları tespit edip odada hayalet kullanıcı bırakmamak için.
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    // Odaya katıl
    if (message.type === "join") {
      if (room) return;
      const code = String(message.room || "")
        .trim()
        .toUpperCase()
        .slice(0, MAX_ROOM_CODE_LEN);

      if (!code) return;

      room = getRoom(code);
      clientId = message.clientId || Math.random().toString(36);
      name = String(message.name || "Misafir").slice(0, 20);

      room.users.set(ws, {
        id: clientId,
        name,
        voice: false,
        camera: false,
        mic: false,
        listeners: new Set(),
        viewers: new Set(),
        lastFrame: 0
      });

      send(ws, {
        type: "joined",
        room: code,
        state: playbackSnapshot(room),
        playlist: room.playlist,
        microphones: [...room.users.values()].filter(user => user.mic).map(({id, name}) => ({id, name})),
        presenter: room.presenter || null,
        cameras: [...room.users.values()].filter(user => user.camera).map(({id, name}) => ({id, name})),
        turn: process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_PASSWORD ? {
          urls: process.env.TURN_URL.split(","), username: process.env.TURN_USERNAME, credential: process.env.TURN_PASSWORD
        } : null
      });

      broadcast(room, {
        type: "system",
        text: `${name} odaya katıldı.`
      }, ws);

      return;
    }

    if (!room) return;

    if (message.type === "present") {
      if (message.active && (!room.presenter || room.presenter === clientId)) {
        room.presenter = clientId;
        if (room.state?.playing) {
          room.state = { ...playbackSnapshot(room), playing: false, updatedAt: Date.now() };
          broadcast(room, { type: "state", state: room.state });
        }
      } else if (!message.active && room.presenter === clientId) {
        room.presenter = null;
      }
      broadcast(room, { type: "presenter", id: room.presenter || null });
      return;
    }

    if (message.type === "playlist") {
      let item;
      if (message.action === "add") {
        try {
          const url = new URL(message.source);
          if (!["http:", "https:"].includes(url.protocol) || url.href.length > MAX_SOURCE_LEN || url.username || url.password) return;
          if (room.playlist.length >= 100) return send(ws, {type: "system", text: "Oynatma listesi dolu (100 video)."});
          item = { id: room.nextItem++, source: url.href };
        } catch { return; }
        room.playlist.push(item);
        broadcast(room, {type: "playlist", items: room.playlist});
        if (room.state || room.presenter) return;
      } else if (message.action === "rename") {
        const entry = room.playlist.find(video => video.id === message.id);
        if (!entry || typeof message.title !== "string") return;
        entry.title = message.title.trim().slice(0, 100);
        broadcast(room, {type: "playlist", items: room.playlist});
        return;
      } else if (message.action === "remove") {
        if (room.state?.item === message.id) return;
        room.playlist = room.playlist.filter(entry => entry.id !== message.id);
        broadcast(room, {type: "playlist", items: room.playlist});
        return;
      } else if (message.action === "play") {
        item = room.playlist.find(entry => entry.id === message.id);
      } else if (message.action === "ended") {
        if (!room.state || room.state.source !== message.source || (room.state.item || null) !== message.id) return;
        const index = room.playlist.findIndex(entry => entry.id === message.id);
        item = room.playlist[index + 1];
      }
      if (!item || room.presenter) return;
      room.state = {source: item.source, item: item.id, time: 0, rate: 1, playing: true, updatedAt: Date.now(), by: clientId};
      broadcast(room, {type: "state", state: room.state});
      return;
    }

    if (message.type === "sync") {
      if (room.state?.by === clientId && room.state.source === message.source &&
          (message.item || null) === (room.state.item || null) &&
          typeof message.time === "number" && Number.isFinite(message.time) &&
          message.playing === room.state.playing && message.rate === room.state.rate) {
        room.state.time = Math.max(0, message.time);
        room.state.updatedAt = Date.now();
      } else if (room.state) {
        send(ws, { type: "snapshot", state: playbackSnapshot(room) });
      }
      return;
    }

    // Video durumu değişti
    if (message.type === "state") {
      if (room.presenter) return;
      const source = typeof message.source === "string"
        ? message.source.slice(0, MAX_SOURCE_LEN)
        : null;
      if ("item" in message && !message.load && (message.item !== (room.state?.item || null) || source !== room.state?.source)) return;

      room.state = {
        source,
        item: message.load ? null : (room.state?.source === source ? room.state.item : null),
        playing: !!message.playing,
        time: Number(message.time) || 0,
        rate: Number(message.rate) || 1,
        updatedAt: Date.now(),
        by: clientId
      };

      broadcast(room, {
        type: "state",
        state: room.state
      }, ws);

      return;
    }

    // Oynatma aksiyonu bildirimi (ör. "X 5sn ileri sardı") — sohbete
    // sistem mesajı olarak düşer. Herkese (aksiyonu yapan kişi dahil)
    // gönderiliyor ki kendi yaptığın değişikliği de sohbette görebilesin.
    if (message.type === "action") {
      const text = String(message.text || "").slice(0, MAX_ACTION_LEN);
      if (!text) return;

      broadcast(room, {
        type: "system",
        text: `${name} ${text}`
      });

      return;
    }

    // Emote: küçük bir emoji, odadaki diğer herkesin ekranında uçuşsun
    if (message.type === "emote") {
      const emoji = String(message.emoji || "").slice(0, MAX_EMOJI_LEN);
      if (!emoji) return;

      broadcast(room, {
        type: "emote",
        emoji
      }, ws);

      return;
    }

    // ---- Sesli sohbet (WebRTC) sinyalleşmesi ----

    // Mikrofonunu açan kullanıcı odadaki diğer sesli kullanıcıları öğrenir,
    // onlara da yeni katılımcının geldiği bildirilir. Bağlantıları her zaman
    // yeni katılan taraf başlatır (offer gönderir).
    if (message.type === "voice-join") {
      const info = room.users.get(ws);
      if (!info) return;
      info.voice = true;

      const peers = [];
      for (const [clientWs, otherInfo] of room.users.entries()) {
        if (clientWs === ws || !otherInfo.voice) continue;
        peers.push({ id: otherInfo.id, name: otherInfo.name });
      }

      send(ws, { type: "voice-peers", peers });

      broadcast(room, {
        type: "voice-join",
        id: clientId,
        name
      }, ws);

      return;
    }

    // Mikrofonu kapatma
    if (message.type === "voice-leave") {
      const info = room.users.get(ws);
      if (info) info.voice = false;

      broadcast(room, {
        type: "voice-leave",
        id: clientId
      }, ws);

      return;
    }

    if (message.type === "mic-state") {
      const user = room.users.get(ws);
      user.mic = message.active === true;
      if (!user.mic) user.listeners.clear();
      broadcast(room, {type: "mic-state", id: clientId, name, active: user.mic}, ws);
      return;
    }
    if (message.type === "mic-subscribe") {
      const owner = findWsByClientId(room, message.to);
      const user = room.users.get(owner);
      if (!user?.mic || owner === ws) return;
      const before = user.listeners.size;
      if (message.active) user.listeners.add(ws);
      else user.listeners.delete(ws);
      if (Boolean(before) !== Boolean(user.listeners.size)) send(owner, {type: "mic-relay", active: Boolean(user.listeners.size)});
      return;
    }
    if (message.type === "mic-audio") {
      const user = room.users.get(ws);
      if (!user.mic || !user.listeners.size || typeof message.pcm !== "string" || message.pcm.length !== 2136) return;
      const frame = JSON.stringify({type: "mic-audio", from: clientId, pcm: message.pcm});
      for (const listener of user.listeners) {
        if (listener.readyState === WebSocket.OPEN && listener.bufferedAmount < 32768) listener.send(frame);
      }
      return;
    }
    if (message.type === "camera-state") {
      const user = room.users.get(ws);
      user.camera = message.active === true;
      if (!user.camera) user.viewers.clear();
      broadcast(room, { type: "camera-state", id: clientId, name, active: user.camera }, ws);
      return;
    }

    if (message.type === "camera-subscribe") {
      const owner = findWsByClientId(room, message.to);
      const user = room.users.get(owner);
      if (!user?.camera || owner === ws) return;
      const hadViewers = user.viewers.size > 0;
      if (message.active === true) user.viewers.add(ws);
      else user.viewers.delete(ws);
      if (hadViewers !== (user.viewers.size > 0)) {
        send(owner, { type: "camera-relay", active: user.viewers.size > 0 });
      }
      return;
    }

    if (message.type === "camera-frame") {
      const user = room.users.get(ws);
      const jpeg = message.jpeg;
      if (!user.camera || !user.viewers.size || Date.now() - user.lastFrame < 100 ||
          typeof jpeg !== "string" || jpeg.length > 65536 || !jpeg.startsWith("data:image/jpeg;base64,/9j/")) return;
      user.lastFrame = Date.now();
      const frame = JSON.stringify({ type: "camera-frame", from: clientId, jpeg });
      for (const viewer of user.viewers) {
        if (viewer.readyState === WebSocket.OPEN && viewer.bufferedAmount < 65536) viewer.send(frame);
      }
      return;
    }

    // WebRTC offer/answer/ICE — sadece hedeflenen tek bir katılımcıya iletilir
    if (message.type === "signal") {
      const targetId = message.to;
      if (!targetId) return;

      const targetWs = findWsByClientId(room, targetId);
      if (!targetWs) return;

      send(targetWs, {
        type: "signal",
        from: clientId,
        data: message.data
      });

      return;
    }

    // Sohbet
    if (message.type === "chat") {
      broadcast(room, {
        type: "chat",
        name,
        text: String(message.text || "").slice(0, 300)
      });

      return;
    }

    // Odadan çık
    if (message.type === "leave") {
      ws.close();
    }
  });

  ws.on("close", () => {
    if (!room) return;

    const info = room.users.get(ws);
    const wasInVoice = !!(info && info.voice);

    room.users.delete(ws);
    if (info?.camera) broadcast(room, { type: "camera-state", id: clientId, name, active: false });
    if (info?.mic) broadcast(room, { type: "mic-state", id: clientId, name, active: false });
    for (const [owner, user] of room.users) {
      if (user.listeners.delete(ws) && !user.listeners.size) send(owner, {type: "mic-relay", active: false});
      if (user.viewers.delete(ws) && !user.viewers.size) send(owner, { type: "camera-relay", active: false });
    }
    if (room.presenter === clientId) {
      room.presenter = null;
      broadcast(room, { type: "presenter", id: null });
    }

    broadcast(room, {
      type: "system",
      text: `${name} odadan ayrıldı.`
    });

    if (wasInVoice) {
      broadcast(room, {
        type: "voice-leave",
        id: clientId
      });
    }

    cleanupRoomIfEmpty(room);
  });
});

// Ölü bağlantıları periyodik olarak tespit edip kapat (bkz. isAlive/pong).
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Perde çalışıyor: http://localhost:${PORT}`);
});
