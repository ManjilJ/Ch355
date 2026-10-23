require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const sqlite3 = require("sqlite3").verbose();
const { Chess } = require("chess.js");
const { authenticateJWT } = require("./authMiddleware");

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is missing. Copy .env.example to .env and set it.");
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(origin => origin.trim().replace(/\/$/, ""))
  : [
    "http://localhost:3000",
    "http://localhost:3001"
  ];
const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};
// const corsOptions = {
//   origin: allowedOrigins,
//   methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
//   allowedHeaders: ['Content-Type', 'Authorization', 'X-Tunnel-Skip-Anti-Phishing-Page'],
//   credentials: true
// };

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  }
});
/* ------------------------------ DATABASE ------------------------------ */
const db = new sqlite3.Database(process.env.DB_FILE || "./ch355.db", (err) => {
  if (err) return console.error(err.message);
  console.log("Connected to SQLite database.");
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    draws INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    white_user_id INTEGER NOT NULL,
    black_user_id INTEGER NOT NULL,
    result TEXT NOT NULL,
    winner_user_id INTEGER,
    moves_json TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    title TEXT,
    notes TEXT,
    FOREIGN KEY (white_user_id) REFERENCES users(id),
    FOREIGN KEY (black_user_id) REFERENCES users(id),
    FOREIGN KEY (winner_user_id) REFERENCES users(id)
  )`);
});

const runQuery = (query, params = []) =>
  new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

const getQuery = (query, params = []) =>
  new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

const allQuery = (query, params = []) =>
  new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
/* -------------------------------- AUTH -------------------------------- */
const MAX_USERS_CAP = 30; //  hard user limit
const GITHUB_REPO_URL = process.env.GITHUB_REPO_URL || "https://github.com/manjilj/Ch355";

app.post("/register", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || username.trim() === "" || username.includes(" ")) {
        return res.status(400).json({ error: "Invalid username (no spaces allowed) or password" });
    }

    try {
        // 1. Check current total user count before inserting
        const countRow = await getQuery(`SELECT COUNT(*) AS total FROM users`);
        if (countRow && countRow.total >= MAX_USERS_CAP) {
            return res.status(403).json({
                isFull: true,
                error: `We have reached our maximum capacity of ${MAX_USERS_CAP} players! You can still play by running your own copy from our repo: ${GITHUB_REPO_URL}`
            });
        }

        // 2. Proceed with user registration if under capacity
        const hashedPassword = await bcrypt.hash(password, 10);
        await runQuery(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, hashedPassword]);
        res.json({ message: "User created" });
    } catch (err) {
        res.status(400).json({ error: "Username already exists" });
    }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Missing fields" });
  try {
    const user = await getQuery(`SELECT * FROM users WHERE username = ?`, [username]);
    if (!user) return res.status(400).json({ error: "User not found" });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });
    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, username });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/me", authenticateJWT, async (req, res) => {
  try {
    res.json(await getQuery(`SELECT id, username, wins, losses, draws FROM users WHERE id = ?`, [req.user.id]));
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

const LEADERBOARD_SQL = `SELECT username, wins FROM users ORDER BY wins DESC LIMIT 10`;

app.get("/leaderboard", async (req, res) => {
  try {
    res.json(await allQuery(LEADERBOARD_SQL));
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

/* --------------------------- SAVED GAMES (CRUD) ------------------------ */
// The list omits moves_json so it stays light; single-game routes include it.
const GAME_FROM_SQL = `
  FROM games g
  JOIN users w ON w.id = g.white_user_id
  JOIN users b ON b.id = g.black_user_id
  LEFT JOIN users winr ON winr.id = g.winner_user_id`;

const GAME_LIST_SQL = `
  SELECT g.id, g.result, g.started_at, g.ended_at, g.title, g.notes,
         g.white_user_id, g.black_user_id,
         w.username AS white_username, b.username AS black_username,
         winr.username AS winner_username
  ${GAME_FROM_SQL}`;
// const GAME_LIST_SQL = `
//   SELECT g.id, g.result, g.started_at, g.ended_at, g.title, g.notes,
//          w.username AS white_username, b.username AS black_username,
//          winr.username AS winner_username
//   ${GAME_FROM_SQL}`;

const GAME_FULL_SQL = `
  SELECT g.*, w.username AS white_username, b.username AS black_username,
         winr.username AS winner_username
  ${GAME_FROM_SQL}`;

// Coordinate notation ("e2-e4", "e4xd5", "O-O", "e7-e8=q") — the same style
// chessGames.json uses and parseMove() in ch355.js reads back. SAN would not
// round-trip, so stored plies deliberately carry no SAN override.
function notatePly(ply) {
  if (!ply) return "";
  if (ply.isCastle) return ply.isCastle === "K" ? "O-O" : "O-O-O";
  const joiner = ply.captured || ply.isEnPassant ? "x" : "-";
  let s = ply.from + joiner + ply.to;
  if (ply.isEnPassant) s += "ep";
  if (ply.promotion) s += "=" + ply.promotion;
  return s;
}

function buildChsGmPayload(gameRow) {
  const plies = JSON.parse(gameRow.moves_json);
  const moves = [];
  for (let i = 0; i < plies.length; i += 2) {
    moves.push({
      MoveNo: String(i / 2 + 1),
      Wh: plies[i] ? notatePly(plies[i]) : "",
      Bl: plies[i + 1] ? notatePly(plies[i + 1]) : "",
      Annot: "",
      AdAnnot: "",
      RtfAnnot: "",
    });
  }
  const dateStr = new Date(gameRow.started_at).toISOString().slice(0, 19).replace("T", " ");
  return {
    chsGm: {
      Id: gameRow.id,
      GName: gameRow.title || `${dateStr} ${gameRow.white_username} vs ${gameRow.black_username} (${gameRow.result})`,
      PauseFor: 3333, // a live game has no natural replay pace — edit after pasting if you like
      StrtPos: "",
      Remind: gameRow.notes || gameRow.result,
    },
    moves,
  };
}

app.get("/games", authenticateJWT, async (req, res) => {
  try {
    res.json(await allQuery(`${GAME_LIST_SQL} ORDER BY g.ended_at DESC`));
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/games/:id", authenticateJWT, async (req, res) => {
  try {
    const game = await getQuery(`${GAME_FULL_SQL} WHERE g.id = ?`, [req.params.id]);
    if (!game) return res.status(404).json({ error: "Game not found" });
    res.json({ ...game, plies: JSON.parse(game.moves_json) });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/games/:id/export", authenticateJWT, async (req, res) => {
  try {
    const game = await getQuery(`${GAME_FULL_SQL} WHERE g.id = ?`, [req.params.id]);
    if (!game) return res.status(404).json({ error: "Game not found" });
    res.json(buildChsGmPayload(game));
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Only title/notes are editable — a played game itself is immutable.
// Only one of the two players who actually played a game may edit or delete
// its record — everything else (including other registered users) gets 403.
function isGameParticipant(game, userId) {
  return game.white_user_id === userId || game.black_user_id === userId;
}

app.put("/games/:id", authenticateJWT, async (req, res) => {
  const { title, notes } = req.body;
  try {
    const existing = await getQuery(`SELECT id, white_user_id, black_user_id FROM games WHERE id = ?`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Game not found" });
    if (!isGameParticipant(existing, req.user.id)) {
      return res.status(403).json({ error: "Only players from this game can edit it" });
    }
    await runQuery(`UPDATE games SET title = ?, notes = ? WHERE id = ?`, [
      title || null,
      notes || null,
      req.params.id,
    ]);
    res.json(await getQuery(`${GAME_LIST_SQL} WHERE g.id = ?`, [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/games/:id", authenticateJWT, async (req, res) => {
  try {
    const existing = await getQuery(`SELECT id, white_user_id, black_user_id FROM games WHERE id = ?`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Game not found" });
    if (!isGameParticipant(existing, req.user.id)) {
      return res.status(403).json({ error: "Only players from this game can delete it" });
    }
    await runQuery(`DELETE FROM games WHERE id = ?`, [req.params.id]);
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// app.delete("/games/:id", authenticateJWT, async (req, res) => {
//   try {
//     const result = await runQuery(`DELETE FROM games WHERE id = ?`, [req.params.id]);
//     if (result.changes === 0) return res.status(404).json({ error: "Game not found" });
//     res.json({ message: "Deleted" });
//   } catch (err) {
//     res.status(500).json({ error: "Server error" });
//   }
// });

/* ---------------------------- SOCKET SECURITY -------------------------- */
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication error"));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    next(new Error("Authentication error"));
  }
});

/* ------------------------------ GAME STATE ----------------------------- */
const CHESS_TIME_MS = Number(process.env.CHESS_TIME_MS) || 5 * 60 * 1000;
console.log(CHESS_TIME_MS, "ms per player", process.env.CHESS_TIME_MS);
const CLOCK_TICK_MS = 250;

// One live game, held in memory (same model as the tic-tac-toe server).
// isXNext keeps that server's name: true = White (Player 1) to move.
let gameObject = {
  plies: [],
  isXNext: true,
  players: {}, // socketId -> { username, userId, role }
  winner: null,
  whiteTimeMs: CHESS_TIME_MS,
  blackTimeMs: CHESS_TIME_MS,
  startedAt: null,
};

let clockRunning = false;
let lastTickAt = Date.now();
let lastEmittedKey = "";

function makeLiveChess() {
  const game = new Chess();
  for (const p of gameObject.plies) {
    try {
      game.move({ from: p.from, to: p.to, promotion: p.promotion || undefined });
    } catch (_) { /* moves were validated when they arrived */ }
  }
  return game;
}

function startClockIfReady() {
  const roles = Object.values(gameObject.players).map((p) => p.role);
  const bothSeated = roles.includes("Player 1") && roles.includes("Player 2");
  clockRunning = bothSeated && !gameObject.winner;
  lastTickAt = Date.now();
  if (bothSeated && gameObject.plies.length === 0 && !gameObject.startedAt) {
    gameObject.startedAt = Date.now();
  }
}

function resetBoardState() {
  gameObject.plies = [];
  gameObject.startedAt = null;
  gameObject.isXNext = true;
  gameObject.winner = null;
  gameObject.whiteTimeMs = CHESS_TIME_MS;
  gameObject.blackTimeMs = CHESS_TIME_MS;
  lastEmittedKey = "";
  startClockIfReady();
}

// Seats come from the players map itself (not live sockets), so they are still
// readable while a disconnect is being processed.
function getSeats() {
  const find = (role) => {
    const socketId = Object.keys(gameObject.players).find((k) => gameObject.players[k].role === role);
    return socketId ? { socketId, ...gameObject.players[socketId] } : null;
  };
  return { white: find("Player 1"), black: find("Player 2") };
}

// Saves the finished game and settles win/loss/draw counters. Abandoned games
// are saved but leave the counters alone.
async function finishGame(resultType, winnerColor) {
  const { white, black } = getSeats();
  if (!white || !black || gameObject.plies.length === 0) return;

  const winnerSeat = winnerColor === "w" ? white : winnerColor === "b" ? black : null;
  const loserSeat = winnerColor === "w" ? black : winnerColor === "b" ? white : null;

  try {
    await runQuery(
      `INSERT INTO games (white_user_id, black_user_id, result, winner_user_id, moves_json, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        white.userId,
        black.userId,
        resultType,
        winnerSeat ? winnerSeat.userId : null,
        JSON.stringify(gameObject.plies),
        gameObject.startedAt || Date.now(),
        Date.now(),
      ]
    );

    if (resultType === "Draw") {
      await runQuery(`UPDATE users SET draws = draws + 1 WHERE id IN (?, ?)`, [white.userId, black.userId]);
    } else if (winnerSeat && loserSeat) {
      await runQuery(`UPDATE users SET wins = wins + 1 WHERE id = ?`, [winnerSeat.userId]);
      await runQuery(`UPDATE users SET losses = losses + 1 WHERE id = ?`, [loserSeat.userId]);
    }

    for (const seat of [white, black]) {
      const fresh = await getQuery(
        `SELECT id, username, wins, losses, draws FROM users WHERE id = ?`,
        [seat.userId]
      );
      io.to(seat.socketId).emit("statsUpdated", fresh);
    }
    io.emit("leaderboardUpdated", await allQuery(LEADERBOARD_SQL));
  } catch (e) {
    console.error("Failed to persist finished game:", e);
  }
}

// One authoritative clock: only the side to move is charged. Pushes to clients
// happen only when a displayed second changes.
setInterval(() => {
  if (!clockRunning) return;
  const now = Date.now();
  const elapsed = now - lastTickAt;
  lastTickAt = now;

  if (gameObject.isXNext) gameObject.whiteTimeMs = Math.max(0, gameObject.whiteTimeMs - elapsed);
  else gameObject.blackTimeMs = Math.max(0, gameObject.blackTimeMs - elapsed);

  if (gameObject.whiteTimeMs === 0 || gameObject.blackTimeMs === 0) {
    gameObject.winner = "Timeout";
    clockRunning = false;
    const winnerColor = gameObject.whiteTimeMs === 0 ? "b" : "w";
    io.emit("update", gameObject);
    finishGame("Timeout", winnerColor);
    return;
  }

  const key = `${Math.ceil(gameObject.whiteTimeMs / 1000)}:${Math.ceil(gameObject.blackTimeMs / 1000)}`;
  if (key !== lastEmittedKey) {
    lastEmittedKey = key;
    io.emit("clockTick", { whiteTimeMs: gameObject.whiteTimeMs, blackTimeMs: gameObject.blackTimeMs });
  }
}, CLOCK_TICK_MS);

io.on("connection", (socket) => {
  console.log(`Authenticated User Connected: ${socket.user.username}`);

  const taken = (role) => Object.values(gameObject.players).some((p) => p.role === role);
  let assignedRole = "Spectator";
  if (!taken("Player 1")) assignedRole = "Player 1";
  else if (!taken("Player 2")) assignedRole = "Player 2";

  gameObject.players[socket.id] = {
    username: socket.user.username,
    userId: socket.user.id,
    role: assignedRole,
  };
  startClockIfReady();

  socket.emit("init", { state: gameObject, role: assignedRole });
  io.emit("update", gameObject);

  socket.on("move", async ({ from, to, promotion } = {}) => {
    const playerRecord = gameObject.players[socket.id];
    if (!playerRecord || playerRecord.role === "Spectator" || gameObject.winner) return;
    if (!clockRunning) return; // no moves until both seats are filled
    if (playerRecord.role !== (gameObject.isXNext ? "Player 1" : "Player 2")) return;

    const game = makeLiveChess();
    let move;
    try {
      move = game.move({ from, to, promotion: promotion || "q" });
    } catch (err) {
      return; // illegal move: ignored
    }
    if (!move) return;

    const moverColor = gameObject.isXNext ? "w" : "b";
    const rank = moverColor === "w" ? "1" : "8";
    const isCastle = move.flags.includes("k") ? "K" : move.flags.includes("q") ? "Q" : null;

    gameObject.plies.push({
      from: move.from,
      to: move.to,
      pieceType: move.piece,
      pieceColor: moverColor,
      captured: move.captured ? { type: move.captured, color: moverColor === "w" ? "b" : "w" } : null,
      isEnPassant: move.flags.includes("e"),
      epSquare: move.flags.includes("e") ? move.to[0] + move.from[1] : null,
      isCastle,
      rookFrom: isCastle ? (isCastle === "K" ? "h" + rank : "a" + rank) : null,
      rookTo: isCastle ? (isCastle === "K" ? "f" + rank : "d" + rank) : null,
      promotion: move.promotion || null,
    });

    gameObject.isXNext = !gameObject.isXNext;
    lastTickAt = Date.now();

    if (game.isCheckmate()) gameObject.winner = "Checkmate";
    else if (game.isDraw()) gameObject.winner = "Draw";

    if (gameObject.winner) clockRunning = false;
    io.emit("update", gameObject);

    if (gameObject.winner === "Checkmate") await finishGame("Checkmate", moverColor);
    else if (gameObject.winner === "Draw") await finishGame("Draw", null);
  });

  // Rematch: seats swap colours when both are filled.
  socket.on("reset", () => {
    const { white, black } = getSeats();
    if (white && black) {
      gameObject.players[white.socketId].role = "Player 2";
      gameObject.players[black.socketId].role = "Player 1";
    }
    resetBoardState();
    io.emit("update", gameObject);
    io.emit("reset", gameObject);
  });

  socket.on("quitGame", async () => {
    const playerRecord = gameObject.players[socket.id];
    if (!playerRecord || (playerRecord.role !== "Player 1" && playerRecord.role !== "Player 2")) return;

    if (gameObject.plies.length > 0 && !gameObject.winner) {
      await finishGame("Abandoned", null); // seats still intact at this point
    }
    playerRecord.role = "Spectator";
    resetBoardState();
    io.emit("update", gameObject);
    io.emit("reset", gameObject);
  });

  socket.on("joinGame", () => {
    const playerRecord = gameObject.players[socket.id];
    if (!playerRecord || playerRecord.role !== "Spectator") return;

    const taken = (role) => Object.values(gameObject.players).some((p) => p.role === role);
    if (!taken("Player 1")) playerRecord.role = "Player 1";
    else if (!taken("Player 2")) playerRecord.role = "Player 2";
    else {
      socket.emit("joinFailed", { message: "Game is full. Please wait for a seat to open." });
      return;
    }
    resetBoardState();
    io.emit("update", gameObject);
    io.emit("reset", gameObject);
  });

  socket.on("chat", (data) => {
    io.emit("chat", {
      ...data,
      sender: socket.user?.username || data.sender || "Player",
    });
  });

  socket.on("disconnect", async () => {
    const playerRecord = gameObject.players[socket.id];
    if (!playerRecord) return;

    const wasSeated = playerRecord.role === "Player 1" || playerRecord.role === "Player 2";
    if (wasSeated && gameObject.plies.length > 0 && !gameObject.winner) {
      gameObject.winner = "Abandoned"; // freezes the position; move handler checks winner
      clockRunning = false;
      await finishGame("Abandoned", null); // must run before the seat is removed
    }
    delete gameObject.players[socket.id];
    startClockIfReady();
    io.emit("update", gameObject);
  });
});

const PORT = process.env.PORT || 8083;
server.listen(PORT, () => {
  console.log(`Chess server running on port ${PORT}`);
  console.log("Database: SQLite3");
});

module.exports = { server, io }; // exported for tests
