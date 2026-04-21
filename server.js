const { WebSocketServer } = require("ws");
const http = require("http");

const PORT = process.env.PORT || 3001;

const clients = new Map();   // id -> { ws, player }
const economy = new Map();   // id -> { bucks, fishCaught, gamesWon, timeOnline, hats[] }

let weather = "clear";
let gameTime = 720;
let pokerGame = null;
const pokerQueue = new Set();

const WEATHERS = ["clear","clear","clear","rain","storm","foggy","clear","clear"];
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  clients.forEach(({ ws }) => { if (ws.readyState === 1) ws.send(data); });
}

function broadcastExcept(msg, excludeId) {
  const data = JSON.stringify(msg);
  clients.forEach(({ ws }, id) => { if (id !== excludeId && ws.readyState === 1) ws.send(data); });
}

function sendTo(id, msg) {
  const c = clients.get(id);
  if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
}

function getEco(id) {
  if (!economy.has(id)) economy.set(id, { bucks: 100, fishCaught: 0, gamesWon: 0, timeOnline: 0, hats: [] });
  return economy.get(id);
}

function buildLeaderboard() {
  const entries = [];
  economy.forEach((data, id) => {
    const p = clients.get(id)?.player;
    if (p) entries.push({ id, name: p.name, color: p.color, ...data });
  });
  return {
    bucks: [...entries].sort((a,b)=>b.bucks-a.bucks).slice(0,10),
    fish:  [...entries].sort((a,b)=>b.fishCaught-a.fishCaught).slice(0,10),
    wins:  [...entries].sort((a,b)=>b.gamesWon-a.gamesWon).slice(0,10),
    time:  [...entries].sort((a,b)=>b.timeOnline-a.timeOnline).slice(0,10),
  };
}

// ── Weather ───────────────────────────────────────────────────────────────────
function cycleWeather() {
  weather = WEATHERS[Math.floor(Math.random() * WEATHERS.length)];
  broadcastAll({ type: "weather", weather });
  setTimeout(cycleWeather, 120000 + Math.random() * 180000);
}
// weather disabled

// ── Time ──────────────────────────────────────────────────────────────────────
setInterval(() => {
  gameTime = (gameTime + 1) % 1440;
  if (gameTime % 30 === 0) broadcastAll({ type: "time", gameTime });
}, 2500);

// ── Poker ─────────────────────────────────────────────────────────────────────
function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return d.sort(() => Math.random() - 0.5);
}

function pokerStart(playerIds) {
  const deck = makeDeck();
  const hands = {};
  playerIds.forEach(id => { hands[id] = [deck.pop(), deck.pop()]; });

  pokerGame = {
    playerIds,
    deck,
    hands,
    community: [],
    pot: 0,
    bets: {},
    phase: 'pre-flop',
    turnIndex: 0,
    folded: new Set(),
    acted: new Set(),
  };

  const ante = 20;
  playerIds.forEach(id => {
    const eco = getEco(id);
    const paid = Math.min(ante, eco.bucks);
    eco.bucks -= paid;
    pokerGame.pot += paid;
    pokerGame.bets[id] = paid;
    sendTo(id, { type: 'economy-update', economy: eco });
  });

  broadcastAll({ type: 'announcement', text: `♠ Poker started! ${playerIds.length} players. Ante: 20🪙`, color: '#cc44ff' });

  // Send private hands
  playerIds.forEach(id => {
    sendTo(id, {
      type: 'poker-deal',
      hand: hands[id],
      pot: pokerGame.pot,
      phase: pokerGame.phase,
      community: [],
      currentPlayer: playerIds[pokerGame.turnIndex],
      players: playerIds.map(pid => ({ id: pid, name: clients.get(pid)?.player?.name, folded: false }))
    });
  });
}

function pokerStateMsg() {
  return {
    type: 'poker-state',
    phase: pokerGame.phase,
    pot: pokerGame.pot,
    community: pokerGame.community,
    currentPlayer: pokerGame.playerIds[pokerGame.turnIndex],
    players: pokerGame.playerIds.map(id => ({
      id,
      name: clients.get(id)?.player?.name || id,
      bet: pokerGame.bets[id] || 0,
      folded: pokerGame.folded.has(id)
    }))
  };
}

function pokerNextTurn() {
  const active = pokerGame.playerIds.filter(id => !pokerGame.folded.has(id));

  // Only one left — win by fold
  if (active.length <= 1) {
    pokerEnd(active[0] || pokerGame.playerIds[0], 'fold');
    return;
  }

  // Everyone active has acted — move to next phase
  if (pokerGame.acted.size >= active.length) {
    pokerGame.acted.clear();
    pokerGame.turnIndex = pokerGame.playerIds.indexOf(active[0]); // reset to first active
    pokerAdvancePhase();
    return;
  }

  // Move to next active player
  let next = pokerGame.turnIndex;
  let safety = 0;
  do {
    next = (next + 1) % pokerGame.playerIds.length;
    safety++;
  } while (pokerGame.folded.has(pokerGame.playerIds[next]) && safety < 10);
  pokerGame.turnIndex = next;

  sendPokerUpdate();
}

function sendPokerUpdate() {
  broadcastAll(pokerStateMsg());
  pokerGame.playerIds.forEach(id => {
    sendTo(id, {
      type: 'poker-deal',
      hand: pokerGame.hands[id],
      pot: pokerGame.pot,
      phase: pokerGame.phase,
      community: pokerGame.community,
      currentPlayer: pokerGame.playerIds[pokerGame.turnIndex],
      players: pokerGame.playerIds.map(pid => ({
        id: pid,
        name: clients.get(pid)?.player?.name || pid,
        folded: pokerGame.folded.has(pid)
      }))
    });
  });
}

function pokerAdvancePhase() {
  if (pokerGame.phase === 'pre-flop') {
    pokerGame.community.push(pokerGame.deck.pop(), pokerGame.deck.pop(), pokerGame.deck.pop());
    pokerGame.phase = 'flop';
  } else if (pokerGame.phase === 'flop') {
    pokerGame.community.push(pokerGame.deck.pop());
    pokerGame.phase = 'turn';
  } else if (pokerGame.phase === 'turn') {
    pokerGame.community.push(pokerGame.deck.pop());
    pokerGame.phase = 'river';
  } else if (pokerGame.phase === 'river') {
    // Showdown
    const active = pokerGame.playerIds.filter(id => !pokerGame.folded.has(id));
    let best = -1, winner = active[0];
    active.forEach(id => {
      const all = [...pokerGame.hands[id], ...pokerGame.community];
      const score = all.reduce((acc, c) => acc + RANKS.indexOf(c.slice(0, -1)), 0);
      if (score > best) { best = score; winner = id; }
    });
    const reveal = {};
    active.forEach(id => { reveal[id] = pokerGame.hands[id]; });
    pokerEnd(winner, 'showdown', reveal);
    return;
  }

  pokerGame.turnIndex = 0;
  while (pokerGame.folded.has(pokerGame.playerIds[pokerGame.turnIndex])) {
    pokerGame.turnIndex = (pokerGame.turnIndex + 1) % pokerGame.playerIds.length;
  }
  sendPokerUpdate();
}

function pokerEnd(winnerId, reason, reveal) {
  const eco = getEco(winnerId);
  eco.bucks += pokerGame.pot;
  eco.gamesWon++;
  sendTo(winnerId, { type: 'economy-update', economy: eco });
  broadcastAll({
    type: 'poker-end',
    winner: winnerId,
    winnerName: clients.get(winnerId)?.player?.name || winnerId,
    pot: pokerGame.pot,
    reason,
    hands: reveal || {}
  });
  pokerGame = null;
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Lake House server running. Players: " + clients.size);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let clientId = null;
  let incomeInterval = null;

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // ── Register player ──
      if (msg.type === "join" || msg.type === "move") {
        clientId = msg.player.id;
        clients.set(clientId, { ws, player: msg.player });

        if (msg.type === "join") {
          const eco = getEco(clientId);
          ws.send(JSON.stringify({ type: "welcome", economy: eco, weather, gameTime, leaderboard: buildLeaderboard() }));
          clearInterval(incomeInterval);
          incomeInterval = setInterval(() => {
            const e = getEco(clientId);
            e.bucks += 1; e.timeOnline += 1;
            ws.send(JSON.stringify({ type: "economy-update", economy: e }));
          }, 30000);
        }
      }

      // ── Relay to others (skip server-only types) ──
      const noRelay = ["poker-join","poker-action","buy-hat","leaderboard-request","fish-catch","game-win","slots-spin","slots-win"];
      if (!noRelay.includes(msg.type)) {
        broadcastExcept(msg, clientId);
      }

      // ── Economy ──
      if (msg.type === "fish-catch" && clientId) {
        const eco = getEco(clientId);
        eco.bucks += msg.value || 0;
        eco.fishCaught++;
        ws.send(JSON.stringify({ type: "economy-update", economy: eco }));
        if (msg.legendary) broadcastAll({ type: "announcement", text: `🎣 ${clients.get(clientId)?.player?.name} caught ${msg.name}!`, color: "#ffcc44" });
      }

      if (msg.type === "game-win" && clientId) {
        const eco = getEco(clientId);
        eco.bucks += msg.value || 0;
        eco.gamesWon++;
        ws.send(JSON.stringify({ type: "economy-update", economy: eco }));
      }

      if (msg.type === "slots-spin" && clientId) {
        const eco = getEco(clientId);
        eco.bucks = Math.max(0, eco.bucks - (msg.bet || 10));
        ws.send(JSON.stringify({ type: "economy-update", economy: eco }));
      }

      if (msg.type === "slots-win" && clientId) {
        const eco = getEco(clientId);
        eco.bucks += msg.value || 0;
        ws.send(JSON.stringify({ type: "economy-update", economy: eco }));
        if (msg.jackpot) broadcastAll({ type: "announcement", text: `🎰 JACKPOT! ${clients.get(clientId)?.player?.name} won ${msg.value} 🪙!`, color: "#ffee00" });
      }

      // ── Hat shop ──
      if (msg.type === "buy-hat" && clientId) {
        const HAT_PRICES = { cowboy:50, crown:200, santa:75, cap:30, wizard:150, party:40 };
        const eco = getEco(clientId);
        const price = HAT_PRICES[msg.hat] || 50;
        if (eco.hats.includes(msg.hat)) {
          ws.send(JSON.stringify({ type: "error", msg: "Already owned!" }));
        } else if (eco.bucks < price) {
          ws.send(JSON.stringify({ type: "error", msg: "Not enough Lake Bucks!" }));
        } else {
          eco.bucks -= price;
          eco.hats.push(msg.hat);
          ws.send(JSON.stringify({ type: "economy-update", economy: eco }));
          ws.send(JSON.stringify({ type: "hat-bought", hat: msg.hat }));
        }
      }

      // ── Leaderboard ──
      if (msg.type === "leaderboard-request") {
        ws.send(JSON.stringify({ type: "leaderboard", data: buildLeaderboard() }));
      }

      // ── Poker join ──
      if (msg.type === "poker-join" && clientId) {
        if (pokerGame) {
          ws.send(JSON.stringify({ type: "error", msg: "A game is already running!" }));
          return;
        }
        if (pokerQueue.has(clientId)) {
          ws.send(JSON.stringify({ type: "error", msg: "Already in queue!" }));
          return;
        }
        pokerQueue.add(clientId);
        const queueList = [...pokerQueue];
        broadcastAll({ type: "announcement", text: `♠ ${clients.get(clientId)?.player?.name} joined poker queue (${queueList.length}/2)`, color: "#cc44ff" });
        ws.send(JSON.stringify({ type: "poker-waiting", count: queueList.length }));

        if (queueList.length >= 2) {
          const players = queueList.slice(0, 4);
          players.forEach(id => pokerQueue.delete(id));
          pokerStart(players);
        }
      }

      // ── Poker action ──
      if (msg.type === "poker-action" && clientId && pokerGame) {
        const currentId = pokerGame.playerIds[pokerGame.turnIndex];
        if (currentId !== clientId) return; // not your turn
        if (pokerGame.folded.has(clientId)) return;

        if (msg.action === "fold") {
          pokerGame.folded.add(clientId);
          pokerGame.acted.add(clientId);
          broadcastAll({ type: "announcement", text: `${clients.get(clientId)?.player?.name} folded`, color: "#888" });
        } else if (msg.action === "call") {
          const eco = getEco(clientId);
          const amt = Math.min(20, eco.bucks);
          eco.bucks -= amt; pokerGame.pot += amt;
          pokerGame.bets[clientId] = (pokerGame.bets[clientId] || 0) + amt;
          pokerGame.acted.add(clientId);
          ws.send(JSON.stringify({ type: "economy-update", economy: eco }));
        } else if (msg.action === "raise") {
          const eco = getEco(clientId);
          const amt = Math.min(40, eco.bucks);
          eco.bucks -= amt; pokerGame.pot += amt;
          pokerGame.bets[clientId] = (pokerGame.bets[clientId] || 0) + amt;
          pokerGame.acted.add(clientId);
          pokerGame.acted.clear(); // reset so others must respond
          pokerGame.acted.add(clientId);
          ws.send(JSON.stringify({ type: "economy-update", economy: eco }));
          broadcastAll({ type: "announcement", text: `♠ ${clients.get(clientId)?.player?.name} raises!`, color: "#cc44ff" });
        }

        pokerNextTurn();
      }

      // ── Leave ──
      if (msg.type === "leave" && msg.id) {
        clients.delete(msg.id);
        pokerQueue.delete(msg.id);
        broadcastAll({ type: "leave", id: msg.id });
      }

    } catch(e) { console.error("msg error:", e.message); }
  });

  ws.on("close", () => {
    if (clientId) {
      clearInterval(incomeInterval);
      pokerQueue.delete(clientId);
      clients.delete(clientId);
      broadcastAll({ type: "leave", id: clientId });
      // If in a poker game, fold them out
      if (pokerGame && pokerGame.playerIds.includes(clientId)) {
        pokerGame.folded.add(clientId);
        const active = pokerGame.playerIds.filter(id => !pokerGame.folded.has(id));
        if (active.length <= 1) pokerEnd(active[0] || pokerGame.playerIds[0], 'disconnect');
        else if (pokerGame.playerIds[pokerGame.turnIndex] === clientId) pokerNextTurn();
      }
    }
  });

  ws.on("error", () => { if (clientId) clients.delete(clientId); });
});

server.listen(PORT, () => console.log(`Lake House running on port ${PORT}`));
