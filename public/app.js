const socket = io();

const el = (id) => document.getElementById(id);
const show = (id) => el(id).classList.remove("hidden");
const hide = (id) => el(id).classList.add("hidden");

// Views
const viewHome = el("viewHome");
const viewRoom = el("viewRoom");
const viewGame = el("viewGame");

// Home actions
const nameInput = el("name");
const codeInput = el("code");
el("create").onclick = () => {
  const name = nameInput.value.trim();
  if (!name) return alert("Enter your name");
  socket.emit("room:create", { name }, (res) => {
    if (!res.ok) alert(res.error);
  });
};
el("join").onclick = () => {
  const name = nameInput.value.trim();
  const code = codeInput.value.trim().toUpperCase();
  if (!name || !code) return alert("Enter name and room code");
  socket.emit("room:join", { code, name }, (res) => {
    if (!res || !res.ok) return alert(res?.error || "Join failed");
  });
};

// Lobby actions
el("teamA").onclick = () => socket.emit("team:choose", { team: 0 });
el("teamB").onclick = () => socket.emit("team:choose", { team: 1 });
el("ready").onclick = () => socket.emit("player:ready");

// Game UI elements
const statusLeft = el("statusLeft");
const handEl = el("hand");
const scoreTotal = el("scoreTotal");
const scoreRounds = el("scoreRounds");
const currentRound = el("currentRound");
const activityLog = el("activityLog");
const panelBidding = el("panelBidding");

// Bidding controls
const bidValueEl = el("bidValue");
const bidKindEl = el("bidKind");
el("placeBid").onclick = () => {
  const value = Number(bidValueEl.value || 60);
  const kind = bidKindEl.value; // one of: ♠ ♥ ♦ ♣ or ALL_TRUMP / NO_TRUMP
  const isSuit = ["♠", "♥", "♦", "♣"].includes(kind);
  const contract = isSuit ? { type: "SUIT", suit: kind } : { type: kind };
  socket.emit("bid:place", { value, contract });
};

el("passBid").onclick = () => socket.emit("bid:pass");
const coincheBtn = el("coinche");

coincheBtn.onclick = () => {
  if (coincheBtn.dataset.state === "coinche") {
    socket.emit("bid:coinche");
  } else if (coincheBtn.dataset.state === "surcoinche") {
    socket.emit("bid:surcoinche");
  }
};

// Seats
const gSeats = [el("g0"), el("g1"), el("g2"), el("g3")];

function paintSeated(players, turn, currentTrick = []) {
  const bySeat = {};
  currentTrick.forEach((t) => {
    bySeat[t.seat] = t.card;
  });
  for (let i = 0; i < 4; i++) {
    const box = gSeats[i];
    const p = players[i];
    const name = p ? p.name : "—";
    const team = p ? p.team : null;
    box.classList.remove("teamA", "teamB", "turn");
    if (team === 0) box.classList.add("teamA");
    if (team === 1) box.classList.add("teamB");
    if (i === turn) box.classList.add("turn");
    box.querySelector(".name").textContent = name;
    const playedEl = box.querySelector(".played");
    if (playedEl) playedEl.textContent = bySeat[i] || "—";
  }
}

function teamNames(list, teamNum) {
  return (
    list
      .filter((x) => x && x.team === teamNum)
      .map((x) => x.name)
      .join(" & ") || "—"
  );
}

function currentTurnInfo(state) {
  const p = (state.players || [])[state.turn];
  return p
    ? `${p.name}${p.team === 0 ? " (Team A)" : p.team === 1 ? " (Team B)" : ""}`
    : "—";
}

function currentBidText(state) {
  const last = state.bidding?.lastBid;
  if (!last) return "—";
  const who = (state.players || [])[last.seat]?.name || "?";
  const label =
    last.contract.type === "SUIT"
      ? last.contract.suit
      : last.contract.type === "ALL_TRUMP"
      ? "All Trump"
      : "No Trump";
  const mult = state.bidding?.surcoincheBy
    ? " ×4"
    : state.bidding?.coincheBy
    ? " ×2"
    : "";
  return `${last.value} ${label}${mult} by ${who}`;
}

function renderCardValuesRight() {
  const container = el("cardValues");
  if (!container) return;
  const ranks = ["A", "10", "K", "Q", "J", "9", "8", "7"];
  const PLAIN = { A: 11, 10: 10, K: 4, Q: 3, J: 2, 9: 0, 8: 0, 7: 0 };
  const TRUMP = { J: 20, 9: 14, A: 11, 10: 10, K: 4, Q: 3, 8: 0, 7: 0 };
  const descTrump = [...ranks].sort((a, b) => TRUMP[b] - TRUMP[a]);
  const descPlain = [...ranks].sort((a, b) => PLAIN[b] - PLAIN[a]);
  container.innerHTML = `
    <table class="vals">
      <thead>
        <tr>
          <th>Trump Rank</th><th>Pts</th>
          <th style="width:22px"></th>
          <th>Non-Trump Rank</th><th>Pts</th>
        </tr>
      </thead>
      <tbody>
        ${descTrump
          .map((tr, i) => {
            const nr = descPlain[i] || "";
            const tPts = TRUMP[tr] ?? "";
            const nPts = PLAIN[nr] ?? "";
            return `<tr><td>${tr}</td><td>${tPts}</td><td></td><td>${nr}</td><td>${nPts}</td></tr>`;
          })
          .join("")}
      </tbody>
    </table>
    <div class="note">+10 to last-trick winner</div>
  `;
}

function legalForYou(card, state) {
  const you = state.you || {};
  const hand = you.hand || [];
  const trick = state.currentTrick || [];
  const c = parseCard(card);

  const contract = state.contract || state.bidding?.lastBid?.contract || null;
  const TRUMP = { J: 20, 9: 14, A: 11, 10: 10, K: 4, Q: 3, 8: 0, 7: 0 };
  const isTrump = (cc) =>
    contract &&
    (contract.type === "ALL_TRUMP" ||
      (contract.type === "SUIT" && parseCard(cc).suit === contract.suit));
  const trumpVal = (cc) => (isTrump(cc) ? TRUMP[parseCard(cc).rank] ?? -1 : -1);

  if (!contract) return true; // free before contract locked

  const led = trick[0] ? parseCard(trick[0].card).suit : null;
  if (!led) return true; // leader free

  const ledIsTrump =
    contract.type === "ALL_TRUMP" ||
    (contract.type === "SUIT" && led === contract.suit);

  const PLAIN = { A: 11, 10: 10, K: 4, Q: 3, J: 2, 9: 0, 8: 0, 7: 0 };
  const plainVal = (cc) => PLAIN[parseCard(cc).rank] ?? -1;

  // Highest value currently on table for the LED suit
  const highestLed = (trick || [])
    .filter((t) => parseCard(t.card).suit === led)
    .reduce(
      (m, t) =>
        Math.max(
          m,
          ledIsTrump ? TRUMP[parseCard(t.card).rank] ?? -1 : plainVal(t.card)
        ),
      -1
    );

  const hasLedSuit = (hand || []).some((h) => parseCard(h).suit === led);

  // Can you beat the current highest of the led suit?
  const canBeatInLed = (hand || []).some((h) => {
    if (parseCard(h).suit !== led) return false;
    const val = ledIsTrump ? TRUMP[parseCard(h).rank] ?? -1 : plainVal(h);
    return val > highestLed;
  });

  // Recompute correctly for led comparison
  const beatLed = (cc) => {
    const val = ledIsTrump ? TRUMP[parseCard(cc).rank] ?? -1 : plainVal(cc);
    return parseCard(cc).suit === led && val > highestLed;
  };
  const hasTrump = (hand || []).some((h) => isTrump(h));

  // Part 1: must beat in led suit if you can
  if (canBeatInLed) return beatLed(card);

  // If you cannot beat in led suit but have led suit, you still must follow led suit (any)
  if (hasLedSuit) return parseCard(card).suit === led;

  // No led suit in hand → contract-specific:
  if (contract.type === "SUIT") {
    if (ledIsTrump) {
      const highestTrumpOnTable = (trick || [])
        .filter((t) => isTrump(t.card))
        .reduce((m, t) => Math.max(m, TRUMP[parseCard(t.card).rank] ?? -1), -1);
      if (!hasTrump) return true;
      const canOvertrump = (hand || []).some(
        (h) =>
          isTrump(h) && (TRUMP[parseCard(h).rank] ?? -1) > highestTrumpOnTable
      );
      if (canOvertrump)
        return (
          isTrump(card) &&
          (TRUMP[parseCard(card).rank] ?? -1) > highestTrumpOnTable
        );
      return isTrump(card);
    } else {
      // led is non-trump → must play trump if you have it (overtrump if someone already trumped)
      if (!hasTrump) return true;
      const highestTrumpOnTable = (trick || [])
        .filter((t) => isTrump(t.card))
        .reduce((m, t) => Math.max(m, TRUMP[parseCard(t.card).rank] ?? -1), -1);
      if (highestTrumpOnTable >= 0) {
        const canOvertrump = (hand || []).some(
          (h) =>
            isTrump(h) && (TRUMP[parseCard(h).rank] ?? -1) > highestTrumpOnTable
        );
        if (canOvertrump)
          return (
            isTrump(card) &&
            (TRUMP[parseCard(card).rank] ?? -1) > highestTrumpOnTable
          );
      }
      return isTrump(card);
    }
  }

  // ALL_TRUMP or NO_TRUMP → free (since you can't beat in led suit)
  return true;
}

function parseCard(card) {
  const suits = ["♠", "♥", "♦", "♣"];
  const suit = suits.find((s) => card.endsWith(s)) || null;
  const rank = suit ? card.slice(0, card.length - suit.length) : card;
  return { rank, suit };
}

function render(state) {
  // Lobby
  if (state.phase === "room") {
    show("viewRoom");
    hide("viewHome");
    hide("viewGame");
    el("roomCode").textContent = `Room Code: ${state.code}`;
    const lobby = state.lobby || [];
    const a = lobby.filter((p) => p.team === 0);
    const b = lobby.filter((p) => p.team === 1);
    const u = lobby.filter((p) => p.team !== 0 && p.team !== 1);
    el("lobbyList").innerHTML = `
      <div><strong>Team A:</strong> ${
        a.map((p) => `${p.name}${p.ready ? " ✓" : ""}`).join(", ") || "—"
      }</div>
      <div><strong>Team B:</strong> ${
        b.map((p) => `${p.name}${p.ready ? " ✓" : ""}`).join(", ") || "—"
      }</div>
      <div><strong>Unassigned:</strong> ${
        u.map((p) => `${p.name}${p.ready ? " ✓" : ""}`).join(", ") || "—"
      }</div>`;
    return;
  }

  // Game
  if (["bidding", "playing", "ended"].includes(state.phase)) {
    show("viewGame");
    hide("viewHome");
    hide("viewRoom");

    const bidStr = state.contract
      ? `${state.contract.value} ${
          state.contract.type === "SUIT"
            ? state.contract.suit
            : state.contract.type === "ALL_TRUMP"
            ? "All Trump"
            : "No Trump"
        }`
      : currentBidText(state);

    statusLeft.textContent = `Phase: ${state.phase.toUpperCase()} | Turn: ${currentTurnInfo(
      state
    )} | Bid: ${bidStr}`;

    // Hide/show bidding panel
    panelBidding.classList.toggle("hidden", state.phase !== "bidding");
    // Coinche/Surcoinche dynamic label
    if (state.bidding?.coincheBy) {
      // Coinche already called
      coincheBtn.textContent = "Surcoinche";
      coincheBtn.dataset.state = "surcoinche";

      // Only the next player can surcoinche, others just see disabled button
      if (state.turn === state.you?.seat) {
        coincheBtn.disabled = false;
      } else {
        coincheBtn.disabled = true;
      }
    } else {
      // No coinche yet → show Coinche
      coincheBtn.textContent = "Coinche";
      coincheBtn.dataset.state = "coinche";
      coincheBtn.disabled = false;
    }

    // Scoreboard
    const namesA = teamNames(state.players || [], 0);
    const namesB = teamNames(state.players || [], 1);
    const scoreA = state.scores?.[0] || 0;
    const scoreB = state.scores?.[1] || 0;
    scoreTotal.innerHTML = `
      <div><strong>Team A:</strong> ${namesA}</div>
      <div>Score: ${scoreA}</div>
      <hr/>
      <div><strong>Team B:</strong> ${namesB}</div>
      <div>Score: ${scoreB}</div>`;

    // Live current round score
    const rA = state.handPoints?.[0] || 0;
    const rB = state.handPoints?.[1] || 0;
    currentRound.textContent = `Team A: ${rA} — Team B: ${rB}`;

    // Past hands
    scoreRounds.innerHTML = "";
    (state.roundScores || []).forEach((r, i) => {
      const d = document.createElement("div");
      d.textContent = `Hand ${i + 1}: A ${r[0]} – B ${r[1]}`;
      scoreRounds.appendChild(d);
    });

    // Activity (newest on top)
    activityLog.innerHTML = (state.activity || [])
      .slice(-20)
      .reverse()
      .map((m) => `<div>${m}</div>`)
      .join("");

    // Seats / trick
    paintSeated(state.players || [], state.turn, state.currentTrick);

    // Hand
    handEl.innerHTML = "";
    const you = state.you || {};
    (you.hand || []).forEach((card) => {
      const b = document.createElement("button");
      b.textContent = card;
      b.className = "card-btn";
      if (legalForYou(card, state)) b.classList.add("legal");
      else b.classList.add("illegal");
      const suitMap = {
        "♠": "s-spade",
        "♥": "s-heart",
        "♦": "s-diamond",
        "♣": "s-club",
      };
      b.classList.add(suitMap[parseCard(card).suit] || "");
      b.onclick = () => socket.emit("play:card", { card });
      handEl.appendChild(b);
    });

    // Right column values
    renderCardValuesRight();
    return;
  }

  // Fallback
  show("viewHome");
  hide("viewRoom");
  hide("viewGame");
}

socket.on("room:update", render);
socket.on("connect", () => console.log("Connected:", socket.id));
