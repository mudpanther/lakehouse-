const { WebSocketServer } = require("ws");
const http = require("http");

const PORT = process.env.PORT || 3001;

// In-memory state
const clients = new Map();    // id -> { ws, player }
const economy = new Map();    // id -> { bucks, fishCaught, gamesWon, timeOnline, hats[] }
const leaderboard = { fish: [], bucks: [], time: [] };

let weather = "clear";
let weatherTimer = null;
let gameTime = 720; // 0-1440 minutes in a day, synced
let timeInterval = null;

// Weather cycle
const WEATHERS = ["clear","clear","clear","clear","rain","storm","foggy","clear"];
function cycleWeather() {
  weather = WEATHERS[Math.floor(Math.random() * WEATHERS.length)];
  broadcast({ type: "weather", weather });
  weatherTimer = setTimeout(cycleWeather, 120000 + Math.random() * 180000);
}
cycleWeather();

// Day/night cycle (1 real minute = 1 game hour, 24 min = full day)
function tickTime() {
  gameTime = (gameTime + 1) % 1440;
  if (gameTime % 30 === 0) broadcast({ type: "time", gameTime });
}
timeInterval = setInterval(tickTime, 2500);

function broadcast(msg, excludeId) {
  const data = JSON.stringify(msg);
  clients.forEach(({ ws }, id) => {
    if (id !== excludeId && ws.readyState === 1) ws.send(data);
  });
}

function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  clients.forEach(({ ws }) => { if (ws.readyState === 1) ws.send(data); });
}

function getEconomy(id) {
  if (!economy.has(id)) economy.set(id, { bucks: 100, fishCaught: 0, gamesWon: 0, timeOnline: 0, hats: [] });
  return economy.get(id);
}

function buildLeaderboard() {
  const entries = [];
  economy.forEach((data, id) => {
    const player = clients.get(id)?.player;
    if (player) entries.push({ id, name: player.name, color: player.color, ...data });
  });
  return {
    fish: [...entries].sort((a,b) => b.fishCaught - a.fishCaught).slice(0,10),
    bucks: [...entries].sort((a,b) => b.bucks - a.bucks).slice(0,10),
    time: [...entries].sort((a,b) => b.timeOnline - a.timeOnline).slice(0,10),
    wins: [...entries].sort((a,b) => b.gamesWon - a.gamesWon).slice(0,10),
  };
}

// Poker state
let pokerGame = null;
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r+s);
  return deck.sort(() => Math.random() - 0.5);
}

function startPoker(players) {
  const deck = makeDeck();
  const hands = {};
  players.forEach(id => { hands[id] = [deck.pop(), deck.pop()]; });
  pokerGame = {
    players, deck, hands,
    community: [], pot: 0, bets: {},
    phase: 'pre-flop', currentTurn: 0,
    ante: 20, folded: new Set()
  };
  // Collect antes
  players.forEach(id => {
    const eco = getEconomy(id);
    eco.bucks = Math.max(0, eco.bucks - pokerGame.ante);
    pokerGame.pot += pokerGame.ante;
    pokerGame.bets[id] = pokerGame.ante;
  });
  // Send each player their hand privately
  players.forEach(id => {
    const c = clients.get(id);
    if (c) c.ws.send(JSON.stringify({ type: 'poker-hand', hand: hands[id], pot: pokerGame.pot, phase: pokerGame.phase, community: [], currentPlayer: players[pokerGame.currentTurn] }));
  });
  broadcastAll({ type: 'poker-state', phase: pokerGame.phase, pot: pokerGame.pot, community: pokerGame.community, players: players.map(id=>({id, name: clients.get(id)?.player?.name, bet: pokerGame.bets[id]||0, folded: pokerGame.folded.has(id)})), currentPlayer: players[pokerGame.currentTurn] });
}

function advancePoker() {
  if (!pokerGame) return;
  const activePlayers = pokerGame.players.filter(id => !pokerGame.folded.has(id));
  if (activePlayers.length <= 1) {
    // Winner by fold
    const winner = activePlayers[0] || pokerGame.players[0];
    const eco = getEconomy(winner);
    eco.bucks += pokerGame.pot;
    eco.gamesWon++;
    broadcastAll({ type: 'poker-end', winner, winnerName: clients.get(winner)?.player?.name, pot: pokerGame.pot, reason: 'fold' });
    pokerGame = null; return;
  }
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
    // Showdown - simple: highest card wins
    let bestScore = -1, winner = activePlayers[0];
    activePlayers.forEach(id => {
      const hand = [...(pokerGame.hands[id]||[]), ...pokerGame.community];
      const score = hand.reduce((acc,c) => acc + RANKS.indexOf(c.slice(0,-1).replace('10','T')), 0);
      if (score > bestScore) { bestScore = score; winner = id; }
    });
    const eco = getEconomy(winner);
    eco.bucks += pokerGame.pot;
    eco.gamesWon++;
    const reveal = {};
    activePlayers.forEach(id => { reveal[id] = pokerGame.hands[id]; });
    broadcastAll({ type: 'poker-end', winner, winnerName: clients.get(winner)?.player?.name, pot: pokerGame.pot, hands: reveal, community: pokerGame.community, reason: 'showdown' });
    pokerGame = null; return;
  }
  pokerGame.currentTurn = 0;
  broadcastAll({ type: 'poker-state', phase: pokerGame.phase, pot: pokerGame.pot, community: pokerGame.community, players: pokerGame.players.map(id=>({id, name: clients.get(id)?.player?.name, bet: pokerGame.bets[id]||0, folded: pokerGame.folded.has(id)})), currentPlayer: pokerGame.players[pokerGame.currentTurn] });
  // Re-send hands
  pokerGame.players.forEach(id => {
    const c = clients.get(id);
    if (c) c.ws.send(JSON.stringify({ type: 'poker-hand', hand: pokerGame.hands[id], pot: pokerGame.pot, phase: pokerGame.phase, community: pokerGame.community, currentPlayer: pokerGame.players[pokerGame.currentTurn] }));
  });
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Lake House server. Players: " + clients.size);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let clientId = null;
  let timeOnlineInterval = null;

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === "join" || msg.type === "move") {
        clientId = msg.player.id;
        clients.set(clientId, { ws, player: msg.player });
        if (msg.type === "join") {
          const eco = getEconomy(clientId);
          // Send state to new joiner
          ws.send(JSON.stringify({ type: "welcome", economy: eco, weather, gameTime, leaderboard: buildLeaderboard() }));
          // Passive income timer
          timeOnlineInterval = setInterval(() => {
            const e = getEconomy(clientId);
            e.bucks += 1; e.timeOnline += 1;
            ws.send(JSON.stringify({ type: "economy-update", economy: e }));
          }, 30000);
        }
      }

      // Relay to others
      if (msg.type !== "poker-action" && msg.type !== "poker-join" && msg.type !== "buy-hat" && msg.type !== "leaderboard-request") {
        const data = raw.toString();
        clients.forEach(({ ws: cws }, id) => {
          if (id !== clientId && cws.readyState === 1) cws.send(data);
        });
      }

      // Economy events
      if (msg.type === "fish-catch" && clientId) {
        const eco = getEconomy(clientId);
        eco.bucks += msg.value || 0;
        eco.fishCaught++;
        ws.send(JSON.stringify({ type: "economy-update", economy: eco }));
        if (msg.legendary) broadcastAll({ type: "announcement", text: `🎣 ${clients.get(clientId)?.player?.name} caught a ${msg.name}!`, color: "#ffcc44" });
      }

      if (msg.type === "game-win" && clientId) {
        const eco = getEconomy(clientId);
        eco.bucks += msg.value || 0;
        eco.gamesWon++;
        ws.send(JSON.stringify({ type: "economy-update", economy: eco }));
      }

      if (msg.type === "slots-win" && clientId) {
        const eco = getEconomy(clientId);
        eco.bucks += msg.value || 0;
        ws.send(JSON.stringify({ type: "economy-update", economy: eco }));
        if (msg.jackpot) broadcastAll({ type: "announcement", text: `🎰 JACKPOT! ${clients.get(clientId)?.player?.name} won ${msg.value} Lake Bucks!`, color: "#ffee00" });
      }

      if (msg.type === "slots-spin" && clientId) {
        const eco = getEconomy(clientId);
        eco.bucks = Math.max(0, eco.bucks - (msg.bet || 10));
        ws.send(JSON.stringify({ type: "economy-update", economy: eco }));
      }

      if (msg.type === "buy-hat" && clientId) {
        const eco = getEconomy(clientId);
        const HAT_PRICES = { cowboy: 50, crown: 200, santa: 75, cap: 30, wizard: 150, party: 40 };
        const price = HAT_PRICES[msg.hat] || 50;
        if (eco.bucks >= price && !eco.hats.includes(msg.hat)) {
          eco.bucks -= price;
          eco.hats.push(msg.hat);
          ws.send(JSON.stringify({ type: "economy-update", economy: eco }));
          ws.send(JSON.stringify({ type: "hat-bought", hat: msg.hat }));
        } else {
          ws.send(JSON.stringify({ type: "error", msg: eco.hats.includes(msg.hat) ? "Already owned!" : "Not enough Lake Bucks!" }));
        }
      }

      if (msg.type === "leaderboard-request") {
        ws.send(JSON.stringify({ type: "leaderboard", data: buildLeaderboard() }));
      }

      // Poker
      if (msg.type === "poker-join" && clientId) {
        if (!pokerGame) {
          ws._pokerWaiting = true;
          const waiting = [];
          clients.forEach(({ ws: cws }, id) => { if (cws._pokerWaiting) waiting.push(id); });
          broadcastAll({ type: "announcement", text: `♠ ${clients.get(clientId)?.player?.name} joined poker (${waiting.length}/2 players)`, color: "#cc44ff" });
          ws.send(JSON.stringify({ type: "poker-waiting", count: waiting.length }));
          if (waiting.length >= 2) {
            waiting.forEach(id => { const c = clients.get(id); if(c) c.ws._pokerWaiting = false; });
            startPoker(waiting.slice(0,4));
          }
        } else {
          ws.send(JSON.stringify({ type: "error", msg: "A game is already in progress!" }));
        }
      }

      if (msg.type === "poker-action" && clientId && pokerGame) {
        const idx = pokerGame.players.indexOf(clientId);
        if (idx === pokerGame.currentTurn && !pokerGame.folded.has(clientId)) {
          if (msg.action === "fold") {
            pokerGame.folded.add(clientId);
            broadcast({ type: "poker-fold", id: clientId, name: clients.get(clientId)?.player?.name }, null);
          } else if (msg.action === "call") {
            const eco = getEconomy(clientId);
            const callAmt = Math.min(20, eco.bucks);
            eco.bucks -= callAmt; pokerGame.pot += callAmt;
            pokerGame.bets[clientId] = (pokerGame.bets[clientId]||0) + callAmt;
          } else if (msg.action === "raise") {
            const eco = getEconomy(clientId);
            const raiseAmt = Math.min(40, eco.bucks);
            eco.bucks -= raiseAmt; pokerGame.pot += raiseAmt;
            pokerGame.bets[clientId] = (pokerGame.bets[clientId]||0) + raiseAmt;
            broadcast({ type: "announcement", text: `♠ ${clients.get(clientId)?.player?.name} raises!`, color: "#cc44ff" }, null);
          }
          // Advance turn
          pokerGame.currentTurn++;
          const active = pokerGame.players.filter(id => !pokerGame.folded.has(id));
          if (pokerGame.currentTurn >= pokerGame.players.length || active.length <= 1) {
            advancePoker();
          } else {
            broadcastAll({ type: "poker-state", phase: pokerGame.phase, pot: pokerGame.pot, community: pokerGame.community, players: pokerGame.players.map(id=>({id, name: clients.get(id)?.player?.name, bet: pokerGame.bets[id]||0, folded: pokerGame.folded.has(id)})), currentPlayer: pokerGame.players[pokerGame.currentTurn] });
          }
        }
      }

      if (msg.type === "leave" && msg.id) {
        clients.delete(msg.id);
        broadcastAll({ type: "leave", id: msg.id });
      }

    } catch(e) { console.error(e); }
  });

  ws.on("close", () => {
    if (clientId) {
      clearInterval(timeOnlineInterval);
      clients.delete(clientId);
      const leaveMsg = JSON.stringify({ type: "leave", id: clientId });
      clients.forEach(({ ws: cws }) => { if (cws.readyState === 1) cws.send(leaveMsg); });
    }
  });

  ws.on("error", () => { if (clientId) clients.delete(clientId); });
});

server.listen(PORT, () => console.log(`Lake House server on port ${PORT}`));
