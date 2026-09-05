const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

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
        voice: false
      });

      send(ws, {
        type: "joined",
        room: code,
        state: room.state
      });

      broadcast(room, {
        type: "system",
        text: `${name} odaya katıldı.`
      }, ws);

      return;
    }

    if (!room) return;

    // Video durumu değişti
    if (message.type === "state") {
      const source = typeof message.source === "string"
        ? message.source.slice(0, MAX_SOURCE_LEN)
        : null;

      room.state = {
        source,
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