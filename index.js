const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// ----- Game constants/helpers -----
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["7", "8", "9", "10", "J", "Q", "K", "A"];
const LEFT_OF = (p) => (p + 1) % 4;

const PLAIN_VALUES = { A: 11, 10: 10, K: 4, Q: 3, J: 2, 9: 0, 8: 0, 7: 0 };
const TRUMP_VALUES = { J: 20, 9: 14, A: 11, 10: 10, K: 4, Q: 3, 8: 0, 7: 0 };

function newDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(`${r}${s}`);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function parseCard(card) {
  const suit = SUITS.find((s) => card.endsWith(s)) || null;
  const rank = suit ? card.slice(0, card.length - suit.length) : card;
  return { rank, suit };
}

// Enforce trump / overtrump legality
function isLegalPlay(room, seat, card) {
  const contract = room.contract;
  if (!contract) return true;

  const player = room.players[seat];
  const hand = player.hand || [];
  const played = room.currentTrick || [];

  // Helpers
  const isTrump = (c) =>
    contract.type === "ALL_TRUMP" ||
    (contract.type === "SUIT" && parseCard(c).suit === contract.suit);

  const rankVal = (c, ledIsTrumpMode) => {
    const r = parseCard(c).rank;
    if (ledIsTrumpMode) return TRUMP_VALUES[r] ?? -1;
    return PLAIN_VALUES[r] ?? -1;
  };

  if (!played.length) return true; // leader may play anything

  const ledSuit = room.ledSuit;
  const ledIsTrump =
    contract.type === "ALL_TRUMP" ||
    (contract.type === "SUIT" && ledSuit === contract.suit);

  const cardSuit = parseCard(card).suit;

  // Highest of led suit currently on table (using appropriate table)
  const highestLed = played
    .filter((t) => parseCard(t.card).suit === ledSuit)
    .reduce((m, t) => Math.max(m, rankVal(t.card, ledIsTrump)), -1);

  const hasLedSuit = hand.some((h) => parseCard(h).suit === ledSuit);
  const canBeatInLed = hand.some(
    (h) => parseCard(h).suit === ledSuit && rankVal(h, ledIsTrump) > highestLed
  );

  // ------------- COMMON FIRST RULE (all contracts):
  // If you can play a HIGHER card of the LED SUIT, you MUST.
  if (canBeatInLed) {
    return cardSuit === ledSuit && rankVal(card, ledIsTrump) > highestLed;
  }

  // If you cannot beat in the led suit:
  if (hasLedSuit) {
    // You still must FOLLOW the led suit (any card of that suit is OK).
    return cardSuit === ledSuit;
  }

  // No cards of led suit in hand:
  // Contract-specific behavior for what comes next.
  if (contract.type === "SUIT") {
    // SUIT contract:
    if (ledIsTrump) {
      // Led TRUMP: must play TRUMP if possible; if trick already has trumps, must overtrump if possible.
      const hasTrump = hand.some((h) => isTrump(h));
      if (!hasTrump) return true; // free
      const highestTrumpOnTable = played
        .filter((t) => isTrump(t.card))
        .reduce(
          (m, t) => Math.max(m, TRUMP_VALUES[parseCard(t.card).rank] ?? -1),
          -1
        );
      const canOvertrump = hand.some(
        (h) =>
          isTrump(h) &&
          (TRUMP_VALUES[parseCard(h).rank] ?? -1) > highestTrumpOnTable
      );
      if (canOvertrump)
        return (
          isTrump(card) &&
          (TRUMP_VALUES[parseCard(card).rank] ?? -1) > highestTrumpOnTable
        );
      // cannot overtrump → any trump required
      return isTrump(card);
    } else {
      // Led NON-TRUMP: must play TRUMP if you have it (higher-than-existing trump not required unless there is one)
      const hasTrump = hand.some((h) => isTrump(h));
      if (!hasTrump) return true; // free
      const highestTrumpOnTable = played
        .filter((t) => isTrump(t.card))
        .reduce(
          (m, t) => Math.max(m, TRUMP_VALUES[parseCard(t.card).rank] ?? -1),
          -1
        );
      // If someone already trumped, must overtrump if possible
      if (highestTrumpOnTable >= 0) {
        const canOvertrump = hand.some(
          (h) =>
            isTrump(h) &&
            (TRUMP_VALUES[parseCard(h).rank] ?? -1) > highestTrumpOnTable
        );
        if (canOvertrump)
          return (
            isTrump(card) &&
            (TRUMP_VALUES[parseCard(card).rank] ?? -1) > highestTrumpOnTable
          );
      }
      return isTrump(card); // no trump in trick or cannot overtrump → any trump
    }
  }

  // ALL_TRUMP or NO_TRUMP:
  // No obligation beyond "beat in led suit if you can"; since you cannot, you are free.
  return true;
}

function cardValueByContract(card, contract) {
  const { rank, suit } = parseCard(card);
  if (contract.type === "ALL_TRUMP") return TRUMP_VALUES[rank] ?? 0;
  if (contract.type === "NO_TRUMP") return PLAIN_VALUES[rank] ?? 0;
  const isTrump = contract.type === "SUIT" && suit === contract.suit;
  return (isTrump ? TRUMP_VALUES[rank] : PLAIN_VALUES[rank]) ?? 0;
}

function trickPointsSum(trick, contract) {
  let sum = 0;
  for (const t of trick) sum += cardValueByContract(t.card, contract);
  return sum;
}

function trickWinner(trick, contract, ledSuit) {
  if (!trick || trick.length === 0) return null;
  const rankVal = (tab, card) => tab[parseCard(card).rank] ?? 0;

  if (contract.type === "SUIT") {
    const trumpSuit = contract.suit;
    const trumps = trick.filter((t) => parseCard(t.card).suit === trumpSuit);
    if (trumps.length > 0) {
      let win = trumps[0];
      for (let i = 1; i < trumps.length; i++) {
        if (
          rankVal(TRUMP_VALUES, trumps[i].card) >
          rankVal(TRUMP_VALUES, win.card)
        )
          win = trumps[i];
      }
      return win.seat;
    }
    const ledCards = trick.filter((t) => parseCard(t.card).suit === ledSuit);
    let win = ledCards[0];
    for (let i = 1; i < ledCards.length; i++) {
      if (
        rankVal(PLAIN_VALUES, ledCards[i].card) >
        rankVal(PLAIN_VALUES, win.card)
      )
        win = ledCards[i];
    }
    return win.seat;
  }

  const tab = contract.type === "ALL_TRUMP" ? TRUMP_VALUES : PLAIN_VALUES;
  const ledCards = trick.filter((t) => parseCard(t.card).suit === ledSuit);
  let win = ledCards[0];
  for (let i = 1; i < ledCards.length; i++) {
    if (rankVal(tab, ledCards[i].card) > rankVal(tab, win.card))
      win = ledCards[i];
  }
  return win.seat;
}

function contractLabel(c) {
  return c.type === "SUIT"
    ? `${c.suit}`
    : c.type === "ALL_TRUMP"
    ? "All Trump"
    : "No Trump";
}

function bidMultiplier(bidding) {
  if (!bidding) return 1;
  if (bidding.surcoincheBy != null) return 4;
  if (bidding.coincheBy != null) return 2;
  return 1;
}

// ----- Room state -----
const rooms = Object.create(null);

function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let c = "";
  for (let i = 0; i < 4; i++) c += letters[Math.floor(Math.random() * (i + 1))];
  return rooms[c] ? makeCode() : c;
}

function baseRoom(code) {
  return {
    code,
    phase: "room",
    waiting: [], // players in lobby before seating
    players: null, // [{id,name,team,hand:[]}, ...] in seat order (A1,B1,A2,B2)
    dealer: 0,
    leader: 0,
    turn: 0,
    handStarter: 0,

    scores: [0, 0], // match total across hands
    roundScores: [], // per-hand totals (A,B)

    bidding: null, // { min, lastBid, consecutivePasses, coincheBy?, surcoincheBy? }
    contract: null, // { value, type, suit?, bidderSeat }

    activity: [],
    currentTrick: [],
    ledSuit: null,
    handPoints: [0, 0], // live points inside the current hand
  };
}

function getRoomBySocket(socket) {
  const set = io.sockets.adapter.sids.get(socket.id);
  if (!set) return null;
  for (const r of set) if (rooms[r]) return rooms[r];
  return null;
}

function seatOf(room, socketId) {
  if (!room.players) return -1;
  return room.players.findIndex((p) => p && p.id === socketId);
}

function emitRoom(room) {
  const common = {
    code: room.code,
    phase: room.phase,
    dealer: room.dealer,
    leader: room.leader,
    turn: room.turn,
    scores: room.scores,
    roundScores: room.roundScores,
    contract: room.contract,
    bidding: room.bidding,
    activity: room.activity,
    currentTrick: room.currentTrick,
    handPoints: room.handPoints,
  };

  if (room.phase === "room") {
    room.waiting.forEach((w) => {
      io.to(w.id).emit("room:update", {
        ...common,
        lobby: room.waiting.map((p) => ({
          name: p.name,
          team: p.team,
          ready: p.ready,
        })),
        players: null,
        you: { name: w.name, team: w.team, ready: w.ready },
      });
    });
  } else {
    room.players.forEach((p, i) => {
      io.to(p.id).emit("room:update", {
        ...common,
        players: room.players.map((q, seat) => ({
          seat,
          name: q.name,
          team: q.team,
          handCount: q.hand ? q.hand.length : 0,
        })),
        lobby: null,
        you: { seat: i, name: p.name, team: p.team, hand: p.hand || [] },
      });
    });
  }
}

function deal(room) {
  const deck = newDeck();
  for (let i = 0; i < 4; i++) {
    const p = room.players[i];
    p.hand = deck.splice(0, 8);
  }
}

// Redeal when everyone passes without any bid
function redealAndRestartBidding(room) {
  // Remember who started the last bidding round
  const prevLeader = room.leader ?? LEFT_OF(room.dealer);

  // Fresh hands
  deal(room);

  room.activity.push("All players passed. Redealing and restarting bidding.");

  // Reset hand/bidding state
  room.bidding = {
    min: 60,
    lastBid: null,
    consecutivePasses: 0,
    coincheBy: null,
    surcoincheBy: null,
  };
  room.contract = null;
  room.currentTrick = [];
  room.ledSuit = null;
  room.handPoints = [0, 0];

  // IMPORTANT: start with the NEXT player clockwise after the previous leader
  room.leader = LEFT_OF(prevLeader);
  room.turn = room.leader;

  // Stay in bidding phase
  room.phase = "bidding";
}

// ----- Socket handlers -----
io.on("connection", (socket) => {
  // Lobby
  socket.on("room:create", ({ name }, ack) => {
    if (!name) return ack?.({ ok: false, error: "Name required" });
    const code = makeCode();
    const room = (rooms[code] = baseRoom(code));
    room.waiting.push({
      id: socket.id,
      name: name.trim(),
      team: null,
      ready: false,
    });
    socket.join(code);
    emitRoom(room);
    ack?.({ ok: true, code });
  });

  socket.on("room:join", ({ code, name }, ack) => {
    // Normalize input early
    code = (code || "").trim().toUpperCase();
    name = (name || "").trim();

    // Validate room & inputs
    const room = rooms[code];
    if (!room) return ack?.({ ok: false, error: "Room not found" });
    if (!name) return ack?.({ ok: false, error: "Name required" });

    // Only allow joining while still in lobby
    if (room.phase !== "room") {
      return ack?.({ ok: false, error: "Game already started" });
    }

    // Capacity check
    if (room.waiting.length >= 4) {
      return ack?.({ ok: false, error: "Room full" });
    }

    // Avoid duplicates if socket already in this room (rejoin after refresh, etc.)
    const already =
      room.waiting.find((p) => p.id === socket.id) ||
      (room.players || []).find((p) => p && p.id === socket.id);
    if (already) {
      socket.join(code); // ensure joined to the namespace room
      emitRoom(room);
      return ack?.({ ok: true, code });
    }

    // Add player and emit lobby state
    room.waiting.push({ id: socket.id, name, team: null, ready: false });
    socket.join(code);
    emitRoom(room);
    return ack?.({ ok: true, code });
  });

  socket.on("team:choose", ({ team }, ack) => {
    const room = getRoomBySocket(socket);
    if (!room || room.phase !== "room") return ack?.({ ok: false });
    const p = room.waiting.find((x) => x.id === socket.id);
    if (!p) return ack?.({ ok: false });
    p.team = team;
    emitRoom(room);
    ack?.({ ok: true });
  });

  socket.on("player:ready", (_, ack) => {
    const room = getRoomBySocket(socket);
    if (!room || room.phase !== "room") return ack?.({ ok: false });
    const p = room.waiting.find((x) => x.id === socket.id);
    if (!p) return ack?.({ ok: false });
    p.ready = !p.ready;
    emitRoom(room);
    ack?.({ ok: true });
    maybeStartGame(room);
  });

  // Bidding
  socket.on("bid:place", ({ value, contract }, ack) => {
    const room = getRoomBySocket(socket);
    if (!room || room.phase !== "bidding")
      return ack?.({ ok: false, error: "Not bidding phase" });
    const seat = seatOf(room, socket.id);
    if (seat < 0 || seat !== room.turn)
      return ack?.({ ok: false, error: "Not your turn" });

    value = Number(value);
    if (!value || value < 60) return ack?.({ ok: false, error: "Min 60" });
    if (!contract || !["SUIT", "ALL_TRUMP", "NO_TRUMP"].includes(contract.type))
      return ack?.({ ok: false, error: "Invalid contract" });
    if (contract.type === "SUIT" && !SUITS.includes(contract.suit))
      return ack?.({ ok: false, error: "Pick suit" });

    const last = room.bidding.lastBid;
    if (last && value < last.value + 10)
      return ack?.({ ok: false, error: "Raise by ≥10" });
    // Disallow any new bids once coinche is active
    if (room.bidding.coincheBy != null) {
      return ack?.({ ok: false, error: "Coinche active — no further raises" });
    }

    room.bidding.lastBid = { seat, value, contract: { ...contract } };
    room.bidding.consecutivePasses = 0;
    room.activity.push(
      `${room.players[seat].name} bids ${value} ${contractLabel(contract)}`
    );
    room.turn = LEFT_OF(room.turn);
    emitRoom(room);
    ack?.({ ok: true });
  });

  socket.on("bid:pass", (_, ack) => {
    const room = getRoomBySocket(socket);
    if (!room || room.phase !== "bidding")
      return ack?.({ ok: false, error: "Not bidding phase" });
    const seat = seatOf(room, socket.id);
    if (seat < 0 || seat !== room.turn)
      return ack?.({ ok: false, error: "Not your turn" });

    room.activity.push(`${room.players[seat].name} passes`);
    room.bidding.consecutivePasses += 1;
    // If coinche is on the table and the next player declines (passes),
    // bidding ends immediately with the last bid (coinched).
    if (room.bidding.coincheBy && !room.bidding.surcoincheBy) {
      room.activity.push(`${room.players[seat].name} declines surcoinche`);
      acceptBidAndStartPlaying(room);
      emitRoom(room);
      return ack?.({ ok: true });
    }

    // Everyone passed with NO bid → redeal & restart bidding
    if (!room.bidding.lastBid && room.bidding.consecutivePasses >= 4) {
      redealAndRestartBidding(room);
      emitRoom(room);
      return ack?.({ ok: true });
    }

    // After a bid is placed, 3 passes end bidding
    if (room.bidding.lastBid && room.bidding.consecutivePasses >= 3) {
      acceptBidAndStartPlaying(room);
      emitRoom(room);
      return ack?.({ ok: true });
    }

    room.turn = LEFT_OF(room.turn);
    emitRoom(room);
    ack?.({ ok: true });
  });

  // -- Coinche: lock bidding at last bid; only next player (clockwise) may surcoinche.
  socket.on("bid:coinche", (_, ack) => {
    const room = getRoomBySocket(socket);
    if (!room || room.phase !== "bidding")
      return ack?.({ ok: false, error: "Not bidding phase" });
    if (!room.bidding?.lastBid)
      return ack?.({ ok: false, error: "No bid to coinche" });
    if (room.bidding.coincheBy != null)
      return ack?.({ ok: false, error: "Already coinched" });

    const seat = seatOf(room, socket.id);
    if (seat !== room.turn) return ack?.({ ok: false, error: "Not your turn" });

    // Only opponents of the last bidder can coinche
    const bidderSeat = room.bidding.lastBid.seat;
    const bidderTeam = room.players[bidderSeat].team;
    const coincherTeam = room.players[seat].team;
    if (coincherTeam === bidderTeam) {
      return ack?.({ ok: false, error: "Only the opposing team may coinche" });
    }

    room.bidding.coincheBy = seat;
    room.activity.push(`${room.players[seat].name} calls COINCHE (×2)`);

    // Lock out further bids; only next player may pass or surcoinche.
    room.turn = LEFT_OF(room.turn);
    emitRoom(room);
    ack?.({ ok: true });
  });

  // -- Surcoinche: only allowed once, after coinche, by the next player.
  socket.on("bid:surcoinche", (_, ack) => {
    const room = getRoomBySocket(socket);
    if (!room || room.phase !== "bidding")
      return ack?.({ ok: false, error: "Not bidding phase" });
    if (!room.bidding?.lastBid || !room.bidding.coincheBy)
      return ack?.({ ok: false, error: "No coinche to surcoinche" });
    if (room.bidding.surcoincheBy)
      return ack?.({ ok: false, error: "Already surcoinched" });

    const seat = seatOf(room, socket.id);
    if (seat !== room.turn) return ack?.({ ok: false, error: "Not your turn" });

    room.bidding.surcoincheBy = seat;
    room.activity.push(`${room.players[seat].name} calls SURCOINCHE (×4)`);

    // After surcoinche, bidding ends immediately with the last bid.
    acceptBidAndStartPlaying(room);
    emitRoom(room);
    ack?.({ ok: true });
  });

  // Play
  socket.on("play:card", ({ card }, ack) => {
    const room = getRoomBySocket(socket);
    if (!room || room.phase !== "playing")
      return ack?.({ ok: false, error: "Not playing phase" });
    const seat = seatOf(room, socket.id);
    if (seat < 0 || seat !== room.turn)
      return ack?.({ ok: false, error: "Not your turn" });

    const p = room.players[seat];
    const idx = p.hand.indexOf(card);
    if (idx < 0) return ack?.({ ok: false, error: "Card not in hand" });

    // Enforce trump / overtrump legality
    if (!isLegalPlay(room, seat, card)) {
      return ack?.({
        ok: false,
        error: "Illegal play: you must (over)trump if possible",
      });
    }

    if (!room.currentTrick) room.currentTrick = [];
    if (room.currentTrick.length === 0) room.ledSuit = parseCard(card).suit;

    p.hand.splice(idx, 1);
    room.currentTrick.push({ seat, name: p.name, card });

    if (room.currentTrick.length === 4) {
      const winnerSeat = trickWinner(
        room.currentTrick,
        room.contract,
        room.ledSuit
      );
      const winTeam = room.players[winnerSeat].team;
      const trickPts = trickPointsSum(room.currentTrick, room.contract);
      room.handPoints[winTeam] += trickPts;
      room.activity.push(
        `${winTeam === 0 ? "Team A" : "Team B"} won the trick (+${trickPts})`
      );

      // next trick starts from winner
      room.turn = winnerSeat;
      room.leader = winnerSeat;
      room.currentTrick = [];
      room.ledSuit = null;
      room.lastTrickWinnerTeam = winTeam;
      // If all hands are empty → settle the hand
      const anyCardsLeft = room.players.some(
        (pp) => pp.hand && pp.hand.length > 0
      );
      if (!anyCardsLeft) {
        settleHand(room);
        return ack?.({ ok: true });
      }
    } else {
      room.turn = LEFT_OF(room.turn);
    }

    emitRoom(room);
    ack?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const room = getRoomBySocket(socket);
    if (!room) return;
    if (room.phase === "room") {
      room.waiting = room.waiting.filter((w) => w.id !== socket.id);
      if (room.waiting.length === 0) delete rooms[room.code];
      else emitRoom(room);
      return;
    }
    if (room.players) {
      const idx = room.players.findIndex((p) => p && p.id === socket.id);
      if (idx >= 0) room.players[idx] = null;
      if (room.players.every((x) => !x)) delete rooms[room.code];
      else emitRoom(room);
    }
  });
});

// ----- Phase transitions -----
function maybeStartGame(room) {
  if (room.phase !== "room" || room.waiting.length !== 4) return;

  const counts = [0, 0];
  room.waiting.forEach((p) => {
    if (p.team === 0) counts[0]++;
    if (p.team === 1) counts[1]++;
  });
  const valid =
    counts[0] === 2 && counts[1] === 2 && room.waiting.every((p) => p.ready);
  if (!valid) return;

  const teamA = room.waiting.filter((p) => p.team === 0);
  const teamB = room.waiting.filter((p) => p.team === 1);
  const order = [teamA[0], teamB[0], teamA[1], teamB[1]]; // seating A1 B1 A2 B2
  room.players = order.map((p) => ({
    id: p.id,
    name: p.name,
    team: p.team,
    hand: [],
  }));
  room.waiting = [];

  // Randomize dealer so initial starter is random
  room.dealer = Math.floor(Math.random() * 4);
  deal(room);
  room.leader = LEFT_OF(room.dealer);
  room.turn = room.leader;
  room.handStarter = room.leader; // card phase always begins with this

  room.bidding = { min: 60, lastBid: null, consecutivePasses: 0 };
  room.contract = null;
  room.handPoints = [0, 0];
  room.phase = "bidding";
  emitRoom(room);
}

function acceptBidAndStartPlaying(room) {
  const { seat, value, contract } = room.bidding.lastBid;
  room.contract = { value, ...contract, bidderSeat: seat };
  room.contract.mult = bidMultiplier(room.bidding); // persist 1/2/4
  room.phase = "playing";
  // Card phase always begins with the hand starter chosen earlier (not the bidder)
  room.leader = room.handStarter;
  room.turn = room.handStarter;
  room.activity.push(
    `Contract accepted: ${value} ${contractLabel(contract)} by ${
      room.players[seat].name
    }`
  );
  room.bidding = null;
  room.handPoints = [0, 0];
  room.currentTrick = [];
  room.ledSuit = null;
}

function settleHand(room) {
  // Last-trick +10
  if (room.lastTrickWinnerTeam != null) {
    room.handPoints[room.lastTrickWinnerTeam] += 10;
    room.activity.push(
      `Last trick bonus: +10 to ${
        room.lastTrickWinnerTeam === 0 ? "Team A" : "Team B"
      }`
    );
  }

  const m = room.contract?.mult || 1; // 1 / 2 / 4
  const contractTeam = room.players[room.contract.bidderSeat].team;
  const otherTeam = contractTeam === 0 ? 1 : 0;

  const ctPts = room.handPoints[contractTeam] || 0;
  const otPts = room.handPoints[otherTeam] || 0;
  const totalPts = (room.handPoints[0] || 0) + (room.handPoints[1] || 0);
  const target = room.contract.value;

  let addA = 0,
    addB = 0;
  if (ctPts >= target) {
    // MADE: bidders take their trick points + contract (× mult); defenders take their trick points
    if (contractTeam === 0) {
      addA = ctPts + target * m;
      addB = otPts;
    } else {
      addB = ctPts + target * m;
      addA = otPts;
    }
    room.activity.push(
      `Contract MADE by Team ${
        contractTeam === 0 ? "A" : "B"
      }: +${ctPts} (tricks) + ${target} ×${m}`
    );
  } else {
    // FAILED: bidders get 0; defenders take all trick points + contract (× mult)
    if (contractTeam === 0) {
      addA = 0;
      addB = totalPts + target * m;
    } else {
      addB = 0;
      addA = totalPts + target * m;
    }
    room.activity.push(
      `Contract FAILED: defenders take ${totalPts} (all tricks) + ${target} ×${m}`
    );
  }

  // Update match totals
  room.scores[0] += addA;
  room.scores[1] += addB;
  room.roundScores.push([addA, addB]);

  // Hand over → check 501 end
  if (room.scores[0] >= 501 || room.scores[1] >= 501) {
    room.activity.push(
      `Game over. Final: Team A ${room.scores[0]} – Team B ${room.scores[1]}`
    );
    room.phase = "ended";
    emitRoom(room);
    return;
  }

  // Next hand: rotate dealer, redeal, bidding restarts
  room.dealer = LEFT_OF(room.dealer);
  deal(room);
  room.bidding = {
    min: 60,
    lastBid: null,
    consecutivePasses: 0,
    coincheBy: null,
    surcoincheBy: null,
  };
  room.contract = null;
  room.currentTrick = [];
  room.ledSuit = null;
  room.handPoints = [0, 0];
  room.lastTrickWinnerTeam = null;

  // Determine next hand's starter:
  // If previous starter's team won the hand → same starter; else next player clockwise.
  const prevStarter = room.handStarter ?? room.leader;
  const winnerTeam = ctPts >= target ? contractTeam : otherTeam;
  const nextStarter =
    room.players[prevStarter]?.team === winnerTeam
      ? prevStarter
      : LEFT_OF(prevStarter);

  room.handStarter = nextStarter;
  room.leader = nextStarter;
  room.turn = nextStarter;
  room.phase = "bidding";
  room.activity.push("New hand: bidding restarted.");
  emitRoom(room);
}

// ----- Server start -----
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
