// Lake House – Deno Deploy WebSocket server
// Deploy this repo on https://dash.deno.com → New Project → link GitHub repo → entry point: server.ts

const clients = new Map<string, WebSocket>();

Deno.serve((req) => {
  const url = new URL(req.url);

  // Health check
  if (url.pathname === "/") {
    return new Response("Lake House server running 🏡", { status: 200 });
  }

  // WebSocket upgrade
  if (url.pathname === "/ws") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    let clientId: string | null = null;

    socket.onopen = () => {
      // Send current player list to new joiner
      const playerList: unknown[] = [];
      clients.forEach((_, id) => {
        // We'll get player data from the first join message
      });
    };

    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);

        if (msg.type === "join" || msg.type === "move") {
          clientId = msg.player.id;
          clients.set(clientId, socket);
        }

        if (msg.type === "leave" && msg.id) {
          clients.delete(msg.id);
        }

        // Broadcast to all other clients
        const data = e.data;
        clients.forEach((ws, id) => {
          if (ws !== socket && ws.readyState === WebSocket.OPEN) {
            ws.send(data);
          }
        });

        // If it's a join, also broadcast the new player back to everyone
        // including the sender so they see themselves rendered server-side
        if (msg.type === "join") {
          // Already handled above — sender renders themselves locally
        }

      } catch (_) {
        // ignore malformed messages
      }
    };

    socket.onclose = () => {
      if (clientId) {
        clients.delete(clientId);
        const leaveMsg = JSON.stringify({ type: "leave", id: clientId });
        clients.forEach((ws) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(leaveMsg);
        });
      }
    };

    socket.onerror = () => {
      if (clientId) clients.delete(clientId);
    };

    return response;
  }

  return new Response("Not found", { status: 404 });
});
