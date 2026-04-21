// Lake House — Node.js WebSocket server
// Deploy on Railway: connect GitHub repo, it auto-detects this file.
// Set start command to: node server.js

const { WebSocketServer } = require("ws");
const http = require("http");

const PORT = process.env.PORT || 3001;

// Track connected clients: id -> { ws, player }
const clients = new Map();

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Lake House server running. Players online: " + clients.size);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let clientId = null;

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);

      // Register / update player
      if (msg.type === "join" || msg.type === "move") {
        clientId = msg.player.id;
        clients.set(clientId, { ws, player: msg.player });
      }

      if (msg.type === "leave" && msg.id) {
        clients.delete(msg.id);
      }

      // Broadcast to everyone else
      const data = raw.toString();
      clients.forEach(({ ws: client }, id) => {
        if (client !== ws && client.readyState === 1) {
          client.send(data);
        }
      });

    } catch (_) {
      // ignore bad messages
    }
  });

  ws.on("close", () => {
    if (clientId) {
      clients.delete(clientId);
      const leaveMsg = JSON.stringify({ type: "leave", id: clientId });
      clients.forEach(({ ws: client }) => {
        if (client.readyState === 1) client.send(leaveMsg);
      });
    }
  });

  ws.on("error", () => {
    if (clientId) clients.delete(clientId);
  });
});

server.listen(PORT, () => {
  console.log(`Lake House server listening on port ${PORT}`);
});
