const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
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

wss.on("connection", (ws) => {
  let room = null;
  let clientId = null;
  let name = "Misafir";

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
        .toUpperCase();

      if (!code) return;

      room = getRoom(code);
      clientId = message.clientId || Math.random().toString(36);
      name = String(message.name || "Misafir").slice(0, 20);

      room.users.set(ws, {
        id: clientId,
        name
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
      room.state = {
        source: message.source,
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

    room.users.delete(ws);

    broadcast(room, {
      type: "system",
      text: `${name} odadan ayrıldı.`
    });

    if (room.users.size === 0) {
      rooms.delete(
        [...rooms.entries()].find(([, r]) => r === room)?.[0]
      );
    }
  });
});

server.listen(3000, () => {
  console.log("Perde çalışıyor: http://localhost:3000");
});