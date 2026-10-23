import { useState, useMemo, useRef, useEffect } from "react";
import io from "socket.io-client";
import axios from "axios";
import seedGames from "./chessGames.json";
import { Chess } from "chess.js";
import { generateAICommentary } from "./chessCommentator.js";
import Board3D from "./Board3D.jsx";

/* ---------------------------------------------------------------------- */
/* Board model                                                             */
/* ---------------------------------------------------------------------- */

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = [8, 7, 6, 5, 4, 3, 2, 1];

const GLYPH = {
  w: { k: "♔", q: "♕", r: "♖", b: "♗", n: "♘", p: "♙" },
  b: { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" },
};

const PROMO_CHOICES = [
  { type: "q", label: "Queen" },
  { type: "r", label: "Rook" },
  { type: "n", label: "Knight" },
  { type: "b", label: "Bishop" },
];

const QUICK_CHAT_PRESETS = [
  "👋 Hello! Ready to play?",
  "👍 Good luck, have fun!",
  "⏳ One moment please...",
  "👏 Nice move!",
  "🤝 Good game!",
];

const DEFAULT_PAUSE_MS = 1234;
const FLASH_MS = 2550;
const MAX_LOOPS = 250000;
const FAST_FORWARD_MS = 250;
const CHESS_BACKEND_URL = (
  process.env.REACT_APP_CHESS_BACKEND_URL || "http://localhost:8083"
).replace(/\/$/, "");

function formatClock(ms) {
  const total = Math.max(0, Math.ceil((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function parsePieceCode(code) {
  const str = code.trim().toLowerCase();
  const color = str[0];
  const rest = str.slice(1);
  let type = "p";
  if (rest.includes("p")) type = "p";
  else if (rest.includes("r")) type = "r";
  else if (rest.includes("b")) type = "b";
  else if (rest.includes("n")) type = "n";
  else if (rest.includes("q")) type = "q";
  else if (rest.includes("k")) type = "k";
  return { type, color };
}

function initialBoard(strtPos) {
  const board = {};
  if (strtPos && strtPos.trim()) {
    const tokens = strtPos.trim().split(/[\s,;]+/);
    for (const token of tokens) {
      const match = token.match(/([a-h][1-8])\s*[=:]\s*([a-zA-Z]+)/i);
      if (match) {
        const sq = match[1].toLowerCase();
        board[sq] = parsePieceCode(match[2]);
      }
    }
    return board;
  }

  const back = ["r", "n", "b", "q", "k", "b", "n", "r"];
  FILES.forEach((f, i) => {
    board[f + "8"] = { type: back[i], color: "b" };
    board[f + "7"] = { type: "p", color: "b" };
    board[f + "2"] = { type: "p", color: "w" };
    board[f + "1"] = { type: back[i], color: "w" };
  });
  return board;
}

const fileIdx = (sq) => FILES.indexOf(sq[0]);
const rankOf = (sq) => parseInt(sq[1], 10);

function applyPly(board, ply, capturedWhite, capturedBlack) {
  if (!ply || !ply.from || !ply.to) return;
  const piece = board[ply.from];
  if (!piece) return;
  delete board[ply.from];

  if (ply.isEnPassant) {
    const taken = board[ply.epSquare];
    if (taken) {
      (taken.color === "w" ? capturedWhite : capturedBlack).push(taken);
      delete board[ply.epSquare];
    }
  } else if (board[ply.to]) {
    const taken = board[ply.to];
    (taken.color === "w" ? capturedWhite : capturedBlack).push(taken);
  }

  board[ply.to] = ply.promotion
    ? { type: ply.promotion, color: piece.color }
    : { type: piece.type, color: piece.color };

  if (ply.isCastle) {
    const rook = board[ply.rookFrom];
    if (rook) {
      delete board[ply.rookFrom];
      board[ply.rookTo] = rook;
    }
  }
}

function replay(plies, count, strtPos, startColor = "w") {
  const board = initialBoard(strtPos);
  const capturedWhite = [];
  const capturedBlack = [];
  const limit = Math.min(count, plies.length);
  for (let i = 0; i < limit; i++) {
    if (plies[i]) applyPly(board, plies[i], capturedWhite, capturedBlack);
  }
  const startIdx = startColor === "b" ? 1 : 0;
  const turn = (count + startIdx) % 2 === 0 ? "w" : "b";
  return { board, capturedWhite, capturedBlack, turn };
}

function boardToFEN(board, turn) {
  const rows = [];
  for (let r = 8; r >= 1; r--) {
    let row = "";
    let empty = 0;
    for (const f of FILES) {
      const piece = board[f + r];
      if (!piece) {
        empty++;
        continue;
      }
      if (empty > 0) {
        row += empty;
        empty = 0;
      }
      const letter = piece.type;
      row += piece.color === "w" ? letter.toUpperCase() : letter.toLowerCase();
    }
    if (empty > 0) row += empty;
    rows.push(row);
  }

  let castling = "";
  const wk = board.e1, bk = board.e8;
  if (wk && wk.type === "k" && wk.color === "w") {
    if (board.h1 && board.h1.type === "r" && board.h1.color === "w") castling += "K";
    if (board.a1 && board.a1.type === "r" && board.a1.color === "w") castling += "Q";
  }
  if (bk && bk.type === "k" && bk.color === "b") {
    if (board.h8 && board.h8.type === "r" && board.h8.color === "b") castling += "k";
    if (board.a8 && board.a8.type === "r" && board.a8.color === "b") castling += "q";
  }
  if (!castling) castling = "-";

  return `${rows.join("/")} ${turn} ${castling} - 0 1`;
}

function makeChessFromFEN(fen) {
  try {
    return new Chess(fen);
  } catch (err) {
    console.warn("Invalid starting position, falling back to standard start:", err);
    return new Chess();
  }
}

function enPassantTarget(plies, count) {
  if (count === 0) return null;
  const last = plies[count - 1];
  if (
    last &&
    last.pieceType === "p" &&
    last.from &&
    last.to &&
    Math.abs(rankOf(last.from) - rankOf(last.to)) === 2
  ) {
    return last.from[0] + (rankOf(last.from) + rankOf(last.to)) / 2;
  }
  return null;
}

function notate(ply) {
  if (!ply) return "";
  if (ply.notationOverride) return ply.notationOverride;
  if (ply.isCastle) return ply.isCastle === "K" ? "O-O" : "O-O-O";
  const joiner = ply.captured || ply.isEnPassant ? "x" : "-";
  let s = ply.from + joiner + ply.to;
  if (ply.isEnPassant) s += "ep";
  if (ply.promotion) s += "=" + ply.promotion;
  return s;
}

function parseMove(str, board, color) {
  const raw = (str || "").trim();
  if (!raw || raw === "...") return null;

  const normCastle = raw.toUpperCase().replace(/0/g, "O");
  if (normCastle === "O-O" || normCastle === "O-O-O") {
    const rank = color === "w" ? "1" : "8";
    const kingSide = normCastle === "O-O";
    return {
      from: "e" + rank,
      to: (kingSide ? "g" : "c") + rank,
      pieceType: "k",
      pieceColor: color,
      isEnPassant: false,
      epSquare: null,
      isCastle: kingSide ? "K" : "Q",
      rookFrom: (kingSide ? "h" : "a") + rank,
      rookTo: (kingSide ? "f" : "d") + rank,
      promotion: null,
      notationOverride: normCastle,
    };
  }

  let s = raw.replace(/[+#!?]/g, "").trim();
  let promotion = null;
  const promoMatch = s.match(/[=(]?([QRBNqrbn])[)]?$/);
  if (promoMatch) {
    promotion = promoMatch[1].toLowerCase();
    s = s.slice(0, promoMatch.index);
  }

  let isEnPassant = false;
  if (/e\.?p\.?/i.test(s)) {
    isEnPassant = true;
    s = s.replace(/[-(]?e\.?p\.?[)]?/gi, "");
  }

  const sqMatch = s.match(/([a-h][1-8])[x\-–—]?([a-h][1-8])/i);
  if (!sqMatch) return null;

  const from = sqMatch[1].toLowerCase();
  const to = sqMatch[2].toLowerCase();
  const piece = board[from];

  if (piece && piece.type === "k") {
    if (from === "e1" && to === "g1") {
      return {
        from, to, pieceType: "k", pieceColor: color,
        isEnPassant: false, epSquare: null, isCastle: "K",
        rookFrom: "h1", rookTo: "f1", promotion: null, notationOverride: "O-O", captured: null
      };
    }
    if (from === "e1" && to === "c1") {
      return {
        from, to, pieceType: "k", pieceColor: color,
        isEnPassant: false, epSquare: null, isCastle: "Q",
        rookFrom: "a1", rookTo: "d1", promotion: null, notationOverride: "O-O-O", captured: null
      };
    }
    if (from === "e8" && to === "g8") {
      return {
        from, to, pieceType: "k", pieceColor: color,
        isEnPassant: false, epSquare: null, isCastle: "K",
        rookFrom: "h8", rookTo: "f8", promotion: null, notationOverride: "O-O", captured: null
      };
    }
    if (from === "e8" && to === "c8") {
      return {
        from, to, pieceType: "k", pieceColor: color,
        isEnPassant: false, epSquare: null, isCastle: "Q",
        rookFrom: "a8", rookTo: "d8", promotion: null, notationOverride: "O-O-O", captured: null
      };
    }
  }

  let captured = null;
  if (isEnPassant) {
    const takenPawn = board[to[0] + from[1]];
    if (takenPawn) captured = { type: takenPawn.type, color: takenPawn.color };
  } else if (board[to]) {
    captured = { type: board[to].type, color: board[to].color };
  }

  return {
    from,
    to,
    pieceType: piece ? piece.type : "p",
    pieceColor: color,
    isEnPassant,
    epSquare: isEnPassant ? to[0] + from[1] : null,
    isCastle: null,
    rookFrom: null,
    rookTo: null,
    promotion,
    notationOverride: raw,
    captured,
  };
}

function loadGameMoves(movesRows, strtPos) {
  const board = initialBoard(strtPos);
  const plies = [];
  const annotations = {};

  (movesRows || []).forEach((row) => {
    const moveNo = row.MoveNo ? Number(row.MoveNo) : Math.floor(plies.length / 2) + 1;

    if (row.Wh && row.Wh.trim() !== "...") {
      const ply = parseMove(row.Wh, board, "w");
      if (ply) {
        applyPly(board, ply, [], []);
        plies.push(ply);
      }
    }
    if (row.Bl && row.Bl.trim() !== "...") {
      const ply = parseMove(row.Bl, board, "b");
      if (ply) {
        applyPly(board, ply, [], []);
        plies.push(ply);
      }
    }

    const prev = annotations[moveNo] || { annot: "", adAnnot: "" };
    const newAnnot = (row.Annot || "").trim();
    const newAdAnnot = (row.AdAnnot || "").trim();

    annotations[moveNo] = {
      annot: prev.annot ? (newAnnot ? prev.annot + "\n" + newAnnot : prev.annot) : newAnnot,
      adAnnot: prev.adAnnot ? (newAdAnnot ? prev.adAnnot + "\n" + newAdAnnot : prev.adAnnot) : newAdAnnot,
    };
  });

  return { plies, annotations };
}

function buildRows(plies, annotations) {
  const rows = [];
  for (let i = 0; i < plies.length; i += 2) {
    const moveNo = i / 2 + 1;
    const a = annotations[moveNo] || {};
    rows.push({
      moveNo,
      wh: plies[i] ? notate(plies[i]) : "",
      bl: plies[i + 1] ? notate(plies[i + 1]) : "",
      annot: a.annot || "",
      adAnnot: a.adAnnot || "",
      whIndex: i + 1,
      blIndex: i + 2,
      blPlayed: !!plies[i + 1],
    });
  }
  return rows;
}

function getUsernameFromToken(token) {
  try {
    if (!token) return "";
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.username || "";
  } catch (_) {
    return "";
  }
}

/* ---------------------------------------------------------------------- */
/* Component                                                               */
/* ---------------------------------------------------------------------- */

export default function ChessLedger() {
  const [aiColor, setAiColor] = useState("b");
  const [plies, setPlies] = useState([]);
  const [plyIndex, setPlyIndex] = useState(0);
  const [selected, setSelected] = useState(null);
  const [pendingMove, setPendingMove] = useState(null);
  const [annotations, setAnnotations] = useState({});
  const [dragSq, setDragSq] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);

  // library / playback
  const [mode, setMode] = useState("freeplay");
  const [library, setLibrary] = useState(seedGames);
  const [activeGame, setActiveGame] = useState(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");

  const [customStrtPos, setCustomStrtPos] = useState("");
  const [customStartColor, setCustomStartColor] = useState("w");

  const [setupOpen, setSetupOpen] = useState(false);
  const [setupSquares, setSetupSquares] = useState({});
  const [setupTool, setSetupTool] = useState({ type: "p", color: "w" });
  const [setupTurn, setSetupTurn] = useState("w");
  const [setupDragSq, setSetupDragSq] = useState(null);
  const [setupError, setSetupError] = useState("");

  const [gameMeta, setGameMeta] = useState({
    id: 1,
    gName: "Untitled game",
    pauseFor: DEFAULT_PAUSE_MS,
    remind: "",
  });

  const [running, setRunning] = useState(false);
  const [loop, setLoop] = useState(false);
  const [blink, setBlink] = useState(true);
  const [showCountdown, setShowCountdown] = useState(false);
  const [autoScrollAnnot, setAutoScrollAnnot] = useState(false);
  const [boardFlipped, setBoardFlipped] = useState(false);
  const [is3D, setIs3D] = useState(false);
  const [msRemaining, setMsRemaining] = useState(0);
  const [fastN, setFastN] = useState(5);
  const [flash, setFlash] = useState(null);

  // ---- Online play state & coordination ----
  const [onlineToken, setOnlineToken] = useState(() => localStorage.getItem("Ch355_token") || "");
  const [onlineUsername, setOnlineUsername] = useState(() => getUsernameFromToken(localStorage.getItem("Ch355_token")));
  const [authOpen, setAuthOpen] = useState(false);
  const [onlineRole, setOnlineRole] = useState(null);
  const [onlineWinner, setOnlineWinner] = useState(null);
  const [onlinePlayers, setOnlinePlayers] = useState({});
  const [whiteMs, setWhiteMs] = useState(0);
  const [blackMs, setBlackMs] = useState(0);
  const [isSocketConnected, setIsSocketConnected] = useState(false);
  const [playersModalOpen, setPlayersModalOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState("");

  // ---- In-Game Chat state ----
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [unreadChat, setUnreadChat] = useState(0);
  const chatScrollRef = useRef(null);

  const socketRef = useRef(null);
  const modeRef = useRef(mode);
  const isOnline = mode === "online";
  const myColor = onlineRole === "Player 1" ? "w" : onlineRole === "Player 2" ? "b" : null;

  // ---- Saved online games (CRUD) ----
  const [gamesOpen, setGamesOpen] = useState(false);
  const [gamesList, setGamesList] = useState([]);
  const [gamesError, setGamesError] = useState("");
  const [gameExportText, setGameExportText] = useState("");
  const [editingGame, setEditingGame] = useState(null);

  const taRef = useRef(null);
  const pliesRef = useRef(plies);
  const plyIndexRef = useRef(plyIndex);
  const loopRef = useRef(loop);
  const blinkRef = useRef(blink);
  const runningRef = useRef(false);
  const annotationsRef = useRef(annotations);
  const loopCountRef = useRef(0);
  const flashTimeoutRef = useRef(null);
  const fastForwardTimerRef = useRef(null);
  const [vsComputer, setVsComputer] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const lastMoveTimeRef = useRef(0);
  const [autoNext, setAutoNext] = useState(false);
  const autoNextRef = useRef(false);
  const libraryRef = useRef(library);
  const activeGameRef = useRef(activeGame);
  const libraryDirectionRef = useRef(1);
  const pauseForRef = useRef(gameMeta.pauseFor);
  const loadedDefaultPauseForRef = useRef(DEFAULT_PAUSE_MS);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { pliesRef.current = plies; }, [plies]);
  useEffect(() => { plyIndexRef.current = plyIndex; }, [plyIndex]);
  useEffect(() => { loopRef.current = loop; }, [loop]);
  useEffect(() => { blinkRef.current = blink; }, [blink]);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { annotationsRef.current = annotations; }, [annotations]);
  useEffect(() => { autoNextRef.current = autoNext; }, [autoNext]);
  useEffect(() => { libraryRef.current = library; }, [library]);
  useEffect(() => { activeGameRef.current = activeGame; }, [activeGame]);

  const activeStrtPos = activeGame ? activeGame.chsGm.StrtPos : customStrtPos;
  const activeStartColor = activeGame ? "w" : customStartColor;

  const { board, capturedWhite, capturedBlack, turn } = useMemo(
    () => replay(plies, plyIndex, activeStrtPos, activeStartColor),
    [plies, plyIndex, activeStrtPos, activeStartColor]
  );

  const activeInitialFEN = useMemo(
    () => boardToFEN(initialBoard(activeStrtPos), activeStartColor),
    [activeStrtPos, activeStartColor]
  );

  const epTarget = useMemo(() => enPassantTarget(plies, plyIndex), [plies, plyIndex]);
  const rows = useMemo(() => buildRows(plies, annotations), [plies, annotations]);
  const currentMoveNo = plyIndex > 0 ? Math.ceil(plyIndex / 2) : null;
  const currentAdAnnot = currentMoveNo ? annotations[currentMoveNo]?.adAnnot : null;
  const currentAnnot = currentMoveNo ? annotations[currentMoveNo]?.annot : null;

  useEffect(() => {
    if (!currentMoveNo) return;
    const activeRowEl = document.querySelector(`.scoresheet-row[data-moveno="${currentMoveNo}"]`);
    if (activeRowEl) {
      activeRowEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [plyIndex, currentMoveNo]);

  useEffect(() => { pauseForRef.current = gameMeta.pauseFor; }, [gameMeta.pauseFor]);

  const animMapRef = useRef(new Map());
  const activeMoveTaRef = useRef(null);
  const hoveredTaRef = useRef(null);

  function handleAutoNextToggle(checked) {
    setAutoNext(checked);
  }

  function startPingPongScroll(el) {
    if (!el || animMapRef.current.has(el)) return;
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll <= 2) return;

    let isRunning = true;
    let startTime = null;
    let animId = null;
    let isUserWheeling = false;
    let wheelTimeout = null;

    const pauseTopMs = 1400;
    const pauseBottomMs = 1600;
    const scrollSpeedPxPerSec = 7;
    const scrollDurationMs = (maxScroll / scrollSpeedPxPerSec) * 1000;
    const cycleDurationMs = pauseTopMs + scrollDurationMs + pauseBottomMs + scrollDurationMs;

    function onWheel() {
      isUserWheeling = true;
      if (wheelTimeout) clearTimeout(wheelTimeout);
      wheelTimeout = setTimeout(() => {
        isUserWheeling = false;
        const currentProgress = Math.min(1, Math.max(0, el.scrollTop / maxScroll));
        const elapsed = pauseTopMs + currentProgress * scrollDurationMs;
        startTime = performance.now() - elapsed;
      }, 800);
    }

    el.addEventListener("wheel", onWheel, { passive: true });

    function step(timestamp) {
      if (!isRunning) return;
      if (!startTime) startTime = timestamp;

      if (!isUserWheeling) {
        const elapsedInCycle = (timestamp - startTime) % cycleDurationMs;
        if (elapsedInCycle < pauseTopMs) {
          el.scrollTop = 0;
        } else if (elapsedInCycle < pauseTopMs + scrollDurationMs) {
          const progress = (elapsedInCycle - pauseTopMs) / scrollDurationMs;
          el.scrollTop = progress * maxScroll;
        } else if (elapsedInCycle < pauseTopMs + scrollDurationMs + pauseBottomMs) {
          el.scrollTop = maxScroll;
        } else {
          const progress = (elapsedInCycle - (pauseTopMs + scrollDurationMs + pauseBottomMs)) / scrollDurationMs;
          el.scrollTop = (1 - progress) * maxScroll;
        }
      }

      if (isRunning) {
        animId = requestAnimationFrame(step);
      }
    }

    animId = requestAnimationFrame(step);
    animMapRef.current.set(el, {
      stop: () => {
        isRunning = false;
        cancelAnimationFrame(animId);
        el.removeEventListener("wheel", onWheel);
        if (wheelTimeout) clearTimeout(wheelTimeout);
        el.scrollTop = 0;
      },
    });
  }

  function stopPingPongScroll(el) {
    if (!el) return;
    const entry = animMapRef.current.get(el);
    if (entry) {
      entry.stop();
      animMapRef.current.delete(el);
    }
    el.scrollTop = 0;
  }

  function handleAnnotMouseEnter(el) {
    if (!autoScrollAnnot || !el) return;
    if (hoveredTaRef.current && hoveredTaRef.current !== el) {
      if (hoveredTaRef.current !== activeMoveTaRef.current) {
        stopPingPongScroll(hoveredTaRef.current);
      }
    }
    hoveredTaRef.current = el;
    startPingPongScroll(el);
  }

  function handleAnnotMouseLeave(el) {
    if (hoveredTaRef.current === el) {
      hoveredTaRef.current = null;
    }
    if (el !== activeMoveTaRef.current) {
      stopPingPongScroll(el);
    }
  }

  useEffect(() => {
    if (!autoScrollAnnot) {
      animMapRef.current.forEach((entry) => entry.stop());
      animMapRef.current.clear();
      activeMoveTaRef.current = null;
      hoveredTaRef.current = null;
      return;
    }

    if (activeMoveTaRef.current && activeMoveTaRef.current !== hoveredTaRef.current) {
      stopPingPongScroll(activeMoveTaRef.current);
    }

    if (!currentMoveNo || currentMoveNo < 1) {
      activeMoveTaRef.current = null;
      return;
    }

    const currTa = document.querySelector(`textarea[data-annot-moveno="${currentMoveNo}"]`);
    activeMoveTaRef.current = currTa;
    if (currTa) {
      startPingPongScroll(currTa);
    }

    return () => {
      animMapRef.current.forEach((entry) => entry.stop());
      animMapRef.current.clear();
    };
  }, [currentMoveNo, autoScrollAnnot]);

  const atEnd = plyIndex === plies.length;
  const atStart = plyIndex === 0;
  const pauseForActive = Math.min(60000, Math.max(1234, Number(gameMeta.pauseFor) || 1234));

  function getPathSquares(from, to) {
    if (!from || !to) return [];
    const f1 = FILES.indexOf(from[0]), r1 = parseInt(from[1], 10);
    const f2 = FILES.indexOf(to[0]), r2 = parseInt(to[1], 10);
    const df = Math.sign(f2 - f1);
    const dr = Math.sign(r2 - r1);

    const isDiagonal = Math.abs(f2 - f1) === Math.abs(r2 - r1);
    const isStraight = f1 === f2 || r1 === r2;
    if (!isDiagonal && !isStraight) return [];

    const path = [];
    let currF = f1 + df;
    let currR = r1 + dr;
    while (currF !== f2 || currR !== r2) {
      path.push(FILES[currF] + currR);
      currF += df;
      currR += dr;
    }
    return path;
  }

  function flashMove(ply) {
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);

    const fromSquares = [ply.from, ply.rookFrom].filter(Boolean);
    const toSquares = [ply.to, ply.rookTo, ply.epSquare].filter(Boolean);

    const pathSquares = [
      ...getPathSquares(ply.from, ply.to),
      ...getPathSquares(ply.rookFrom, ply.rookTo)
    ];

    const ghosts = [{ sq: ply.from, type: ply.pieceType, color: ply.pieceColor }];
    if (ply.rookFrom) ghosts.push({ sq: ply.rookFrom, type: "r", color: ply.pieceColor });

    const captureSq = ply.isEnPassant ? ply.epSquare : (ply.captured ? ply.to : null);
    const captureGhost = ply.captured && captureSq
      ? { sq: captureSq, type: ply.captured.type, color: ply.captured.color }
      : null;

    setFlash({
      fromSquares,
      toSquares,
      pathSquares,
      ghosts,
      captureGhost,
      moveArrow: { from: ply.from, to: ply.to },
      id: Math.random()
    });
  }

  // Trigger Computer move when it is the computer's turn
  useEffect(() => {
    if (!vsComputer || mode !== "freeplay" || turn !== aiColor || !atEnd || running) return;

    setIsThinking(true);
    const timer = setTimeout(() => {
      const game = makeChessFromFEN(activeInitialFEN);
      for (const p of plies.slice(0, plyIndex)) {
        try {
          game.move({ from: p.from, to: p.to, promotion: p.promotion || undefined });
        } catch (err) {
          console.warn("Skipping non-standard move:", p);
        }
      }

      if (game.isGameOver()) {
        setIsThinking(false);
        return;
      }

      const isMaximizing = aiColor === "w";
      const { move: best } = minimaxChess(game, 3, -Infinity, Infinity, isMaximizing);

      if (best) {
        const isCastle = best.san === "O-O" ? "K" : best.san === "O-O-O" ? "Q" : null;
        const rank = aiColor === "w" ? "1" : "8";
        const ply = {
          from: best.from,
          to: best.to,
          pieceType: best.piece,
          pieceColor: aiColor,
          captured: best.captured ? { type: best.captured, color: aiColor === "w" ? "b" : "w" } : null,
          isEnPassant: best.flags.includes("e"),
          epSquare: best.flags.includes("e") ? best.to[0] + best.from[1] : null,
          isCastle,
          rookFrom: isCastle ? (isCastle === "K" ? "h" + rank : "a" + rank) : null,
          rookTo: isCastle ? (isCastle === "K" ? "f" + rank : "d" + rank) : null,
          promotion: best.promotion || null,
          notationOverride: best.san,
        };
        finalize(ply);
      }
      setIsThinking(false);
    }, 550);

    return () => clearTimeout(timer);
  }, [vsComputer, mode, turn, atEnd, running, plies, aiColor, activeInitialFEN]);

  const gameStatus = useMemo(() => {
    const game = makeChessFromFEN(activeInitialFEN);
    for (const p of plies.slice(0, plyIndex)) {
      try {
        game.move({ from: p.from, to: p.to, promotion: p.promotion || undefined });
      } catch (_) { }
    }

    const isMate = typeof game.isCheckmate === "function" ? game.isCheckmate() : game.in_checkmate?.();
    const isDraw = typeof game.isDraw === "function" ? game.isDraw() : game.in_draw?.();
    const isCheck = typeof game.inCheck === "function" ? game.inCheck() : game.in_check?.();

    if (isMate) {
      const winner = game.turn() === "w" ? "Black" : "White";
      return { type: "checkmate", text: `🏆 Checkmate! ${winner} wins`, isOver: true, checkedColor: game.turn() };
    }
    if (isDraw) {
      return { type: "draw", text: "🤝 Draw / Stalemate", isOver: true };
    }
    if (isCheck) {
      const checkedColor = game.turn() === "w" ? "White" : "Black";
      return { type: "check", text: `⚠️ ${checkedColor} is in Check!`, isOver: false, checkedColor: game.turn() };
    }
    return null;
  }, [plies, plyIndex, activeInitialFEN]);

  function advanceTick() {
    const curPlies = pliesRef.current;
    const curIndex = plyIndexRef.current;
    if (curIndex < curPlies.length) {
      const ply = curPlies[curIndex];
      if (blinkRef.current) flashMove(ply);
      setPlyIndex(curIndex + 1);
    } else if (loopRef.current && loopCountRef.current < MAX_LOOPS) {
      loopCountRef.current += 1;
      if (autoNextRef.current && advanceToNextLibraryGame()) {
        return;
      }
      setPlyIndex(0);
    } else {
      loopCountRef.current = 0;
      setRunning(false);
    }
  }

  useEffect(() => {
    if (!running) return;
    const stepMs = 100;
    const CLOSURE_EXTRA_MS = 11000;
    let remaining = pauseForActive;
    let closureApplied = false;
    setMsRemaining(remaining);
    const id = setInterval(() => {
      remaining -= stepMs;
      if (remaining <= 0) {
        const atFinalPosition =
          pliesRef.current.length > 0 &&
          plyIndexRef.current === pliesRef.current.length;

        if (atFinalPosition && !closureApplied) {
          closureApplied = true;
          remaining = CLOSURE_EXTRA_MS;
          setMsRemaining(remaining);
          return;
        }

        closureApplied = false;
        advanceTick();
        remaining = pauseForActive;
      }
      setMsRemaining(remaining);
    }, stepMs);
    return () => clearInterval(id);
  }, [running, pauseForActive]);

  useEffect(() => () => flashTimeoutRef.current && clearTimeout(flashTimeoutRef.current), []);
  useEffect(() => () => fastForwardTimerRef.current && clearInterval(fastForwardTimerRef.current), []);

  /* --------------------------- online play & sockets --------------------- */

  function leaveOnline() {
    if (socketRef.current) {
      try {
        socketRef.current.emit("quitGame");
      } catch (_) { }
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setIsSocketConnected(false);
    setOnlineRole(null);
    setOnlineWinner(null);
    setOnlinePlayers({});
    newGame();
  }

  useEffect(() => {
    if (mode !== "online" && socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
      setIsSocketConnected(false);
      setOnlineRole(null);
      setOnlineWinner(null);
      setOnlinePlayers({});
    }
  }, [mode]);

  useEffect(() => () => {
    if (socketRef.current) socketRef.current.disconnect();
  }, []);

  useEffect(() => {
    if (mode === "online" && onlineRole && onlineRole !== "Spectator") {
      setBoardFlipped(onlineRole === "Player 2");
    }
  }, [onlineRole, mode]);

  function connectOnline(token) {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    const socket = io(CHESS_BACKEND_URL, {
      auth: { token },
      transports: ["polling", "websocket"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setIsSocketConnected(true);
    });

    socket.on("disconnect", () => {
      setIsSocketConnected(false);
    });

    const applyServerState = (state) => {
      const serverPlies = state.plies || [];
      const prevLen = pliesRef.current.length;
      if (serverPlies.length === 0) setFlash(null);
      else if (serverPlies.length === prevLen + 1 && blinkRef.current) {
        flashMove(serverPlies[serverPlies.length - 1]);
      }
      setPlies(serverPlies);
      setPlyIndex(serverPlies.length);
      setSelected(null);
      setPendingMove(null);
      setOnlineWinner(state.winner || null);
      setOnlinePlayers(state.players || {});
      setWhiteMs(state.whiteTimeMs);
      setBlackMs(state.blackTimeMs);

      const me = state.players && state.players[socket.id];
      if (me) {
        setOnlineRole(me.role);
        if (me.username) setOnlineUsername(me.username);
      }
    };

    socket.on("init", ({ state, role, username }) => {
      setOnlineRole(role);
      if (username) setOnlineUsername(username);
      applyServerState(state);
    });

    socket.on("update", applyServerState);
    socket.on("reset", applyServerState);

    socket.on("clockTick", ({ whiteTimeMs, blackTimeMs }) => {
      setWhiteMs(whiteTimeMs);
      setBlackMs(blackTimeMs);
    });

    const handleChat = (msg) => {
      setChatMessages((prev) => {
        if (msg.id && prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
      if (!chatOpen) setUnreadChat((u) => u + 1);
    };

    socket.on("chat", handleChat);
    socket.on("message", handleChat);

    socket.on("joinFailed", (d) => alert(d.message));
    socket.on("connect_error", (err) => {
      if (err && err.message === "Authentication error") logoutOnline();
    });
  }

  function startOnline(tokenArg) {
    const token = typeof tokenArg === "string" ? tokenArg : onlineToken;
    if (!token) {
      setAuthOpen(true);
      return;
    }
    setRunning(false);
    setVsComputer(false);
    setActiveGame(null);
    setCustomStrtPos("");
    setCustomStartColor("w");
    setAnnotations({});
    setPlies([]);
    setPlyIndex(0);
    setFlash(null);
    setSelected(null);
    setPendingMove(null);
    setOnlineWinner(null);
    setMode("online");
    connectOnline(token);
  }

  function handleLoginSuccess(token) {
    setOnlineToken(token);
    setAuthOpen(false);
    startOnline(token);
  }

  function logoutOnline() {
    localStorage.removeItem("Ch355_token");
    setOnlineToken("");
    setOnlineUsername("");
    setGamesOpen(false);
    leaveOnline();
  }

  function confirmPromotion(type) {
    if (mode === "online") {
      socketRef.current?.emit("move", { from: pendingMove.from, to: pendingMove.to, promotion: type });
      setPendingMove(null);
      return;
    }
    finalize({ ...pendingMove, promotion: type });
  }

  function sendChatMessage(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    const msg = {
      id: Date.now() + Math.random().toString(36).substr(2, 4),
      sender: onlineUsername || (onlineRole || "Player"),
      role: onlineRole,
      text: trimmed,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    if (socketRef.current) {
      socketRef.current.emit("chat", msg);
      socketRef.current.emit("message", msg);
    }
    setChatMessages((prev) => [...prev, msg]);
    setChatInput("");
    setTimeout(() => {
      if (chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
    }, 50);
  }

  function copyInviteLink() {
    const url = window.location.origin + window.location.pathname;
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopyFeedback("Copied!");
        setTimeout(() => setCopyFeedback(""), 2200);
      })
      .catch(() => {
        setCopyFeedback("Copy failed");
        setTimeout(() => setCopyFeedback(""), 2200);
      });
  }

  /* --------------------------- saved games (CRUD) ------------------------ */

  const authHeader = () => ({ Authorization: `Bearer ${onlineToken}` });

  function handleGamesError(err) {
    if (err.response?.status === 401) {
      logoutOnline();
      return;
    }
    setGamesError(err.response?.data?.error || "Request failed");
  }

  async function fetchGames() {
    try {
      const res = await axios.get(`${CHESS_BACKEND_URL}/games`, { headers: authHeader() });
      setGamesList(res.data);
      setGamesError("");
    } catch (err) {
      handleGamesError(err);
    }
  }

  function openGames() {
    setGamesOpen(true);
    setGameExportText("");
    setEditingGame(null);
    fetchGames();
  }

  async function viewSavedGame(id) {
    try {
      const res = await axios.get(`${CHESS_BACKEND_URL}/games/${id}/export`, { headers: authHeader() });
      loadGame(res.data);
      setGamesOpen(false);
    } catch (err) {
      handleGamesError(err);
    }
  }

  async function exportSavedGame(id) {
    try {
      const res = await axios.get(`${CHESS_BACKEND_URL}/games/${id}/export`, { headers: authHeader() });
      const text = JSON.stringify(res.data, null, 2);
      setGameExportText(text);
      try { await navigator.clipboard.writeText(text); } catch (_) { }
    } catch (err) {
      handleGamesError(err);
    }
  }

  async function saveEditedGame() {
    try {
      await axios.put(
        `${CHESS_BACKEND_URL}/games/${editingGame.id}`,
        { title: editingGame.title, notes: editingGame.notes },
        { headers: authHeader() }
      );
      setEditingGame(null);
      fetchGames();
    } catch (err) {
      handleGamesError(err);
    }
  }

  async function deleteSavedGame(id) {
    if (!window.confirm(`Delete saved game #${id}? This cannot be undone.`)) return;
    try {
      await axios.delete(`${CHESS_BACKEND_URL}/games/${id}`, { headers: authHeader() });
      setGameExportText("");
      fetchGames();
    } catch (err) {
      handleGamesError(err);
    }
  }

  /* --------------------------- move making (freeplay) ------------------ */

  function tryMove(fromSq, toSq) {
    if (fromSq === toSq) {
      setSelected(null);
      return;
    }
    const piece = board[fromSq];
    if (!piece || piece.color !== turn) {
      setSelected(null);
      return;
    }

    if (mode === "online") {
      if (!myColor || piece.color !== myColor || onlineWinner || !atEnd) {
        setSelected(null);
        return;
      }
      const onlineTarget = board[toSq];
      if (onlineTarget && onlineTarget.color === piece.color) {
        setSelected(toSq);
        return;
      }
      const probe = new Chess();
      for (const p of plies) {
        try {
          probe.move({ from: p.from, to: p.to, promotion: p.promotion || undefined });
        } catch (_) { }
      }
      try {
        if (!probe.move({ from: fromSq, to: toSq, promotion: "q" })) {
          setSelected(null);
          return;
        }
      } catch (err) {
        setSelected(null);
        return;
      }
      if (piece.type === "p" && (toSq[1] === "8" || toSq[1] === "1")) {
        setPendingMove({ from: fromSq, to: toSq, pieceColor: piece.color, pieceType: "p" });
        setSelected(null);
        return;
      }
      socketRef.current?.emit("move", { from: fromSq, to: toSq });
      setSelected(null);
      return;
    }

    if (vsComputer) {
      const testGame = makeChessFromFEN(activeInitialFEN);
      for (const p of plies.slice(0, plyIndex)) {
        try {
          testGame.move({ from: p.from, to: p.to, promotion: p.promotion || undefined });
        } catch (_) { }
      }

      try {
        const testMove = testGame.move({ from: fromSq, to: toSq, promotion: "q" });
        if (!testMove) {
          setSelected(null);
          return;
        }
      } catch (err) {
        setSelected(null);
        return;
      }
    }

    const targetPiece = board[toSq];
    if (targetPiece && targetPiece.color === piece.color) {
      setSelected(toSq);
      return;
    }

    let isEnPassant = false;
    let epSquare = null;
    if (piece.type === "p" && fromSq[0] !== toSq[0] && !targetPiece && toSq === epTarget) {
      isEnPassant = true;
      epSquare = toSq[0] + fromSq[1];
    }

    let isCastle = null;
    let rookFrom = null;
    let rookTo = null;
    if (
      piece.type === "k" &&
      rankOf(fromSq) === rankOf(toSq) &&
      Math.abs(fileIdx(fromSq) - fileIdx(toSq)) === 2
    ) {
      isCastle = fileIdx(toSq) > fileIdx(fromSq) ? "K" : "Q";
      const r = fromSq[1];
      rookFrom = isCastle === "K" ? "h" + r : "a" + r;
      rookTo = isCastle === "K" ? "f" + r : "d" + r;
    }

    const base = {
      from: fromSq,
      to: toSq,
      pieceType: piece.type,
      pieceColor: piece.color,
      captured: targetPiece || null,
      isEnPassant,
      epSquare,
      isCastle,
      rookFrom,
      rookTo,
    };

    if (piece.type === "p" && (toSq[1] === "8" || toSq[1] === "1")) {
      setPendingMove(base);
      setSelected(null);
      return;
    }
    finalize({ ...base, promotion: null });
  }

  function finalize(ply) {
    const next = plies.slice(0, plyIndex);
    next.push(ply);

    if (blinkRef.current) flashMove(ply);

    setPlies(next);
    setPlyIndex(next.length);
    setSelected(null);
    setPendingMove(null);

    const moveNo = Math.ceil(next.length / 2);
    const isWhite = ply.pieceColor === "w";

    generateAICommentary(next, ply, activeInitialFEN)
      .then((comment) => {
        const movePrefix = isWhite ? `${moveNo}. ` : `${moveNo}... `;
        const formattedComment = `${movePrefix}${comment}`;

        setAnnotations((prev) => {
          const existing = prev[moveNo] || { annot: "", adAnnot: "" };
          let combinedAdAnnot = "";
          if (isWhite) {
            combinedAdAnnot = formattedComment;
          } else {
            combinedAdAnnot = existing.adAnnot
              ? `${existing.adAnnot}\n${formattedComment}`
              : formattedComment;
          }
          return {
            ...prev,
            [moveNo]: {
              ...existing,
              adAnnot: combinedAdAnnot,
            },
          };
        });
      })
      .catch((err) => {
        console.warn("Commentary generation failed:", err);
      });
  }

  function pickSquare(sq) {
    if ((mode !== "freeplay" && mode !== "online") || pendingMove) return;
    if (selected) {
      tryMove(selected, sq);
      return;
    }
    const piece = board[sq];
    if (!piece || piece.color !== turn) return;
    if (mode === "online" && (piece.color !== myColor || onlineWinner || !atEnd)) return;
    setSelected(sq);
  }

  function onDrop(sq) {
    if ((mode === "freeplay" || mode === "online") && !pendingMove && dragSq) tryMove(dragSq, sq);
    setDragSq(null);
  }

  function newGame() {
    setRunning(false);
    setMode("freeplay");
    setActiveGame(null);
    setPlies([]);
    setPlyIndex(0);
    setSelected(null);
    setPendingMove(null);
    setAnnotations({});
    setCustomStrtPos("");
    setCustomStartColor("w");
  }

  /* --------------------------- position setup ---------------------------- */

  function handlePauseForDoubleClick(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const current = Number(gameMeta.pauseFor) || 1234;
    let next;
    if (current >= 60000) {
      next = 1234;
    } else {
      next = Math.min(60000, Math.max(1234, current * 2));
    }

    setGameMeta((prev) => ({ ...prev, pauseFor: next }));
    if (activeGame) {
      setActiveGame((prev) => (prev ? { ...prev, chsGm: { ...prev.chsGm, PauseFor: next } } : null));
    }
  }

  function openSetup() {
    const seed = { ...board };
    setSetupSquares(seed);
    setSetupTurn(turn);
    setSetupTool({ type: "p", color: "w" });
    setSetupError("");
    setSetupOpen(true);
  }

  function setupPlaceOrClear(sq) {
    setSetupSquares((prev) => {
      const next = { ...prev };
      if (!setupTool) {
        delete next[sq];
      } else {
        next[sq] = { type: setupTool.type, color: setupTool.color };
      }
      return next;
    });
    setSetupError("");
  }

  function setupOnDrop(sq) {
    if (setupDragSq) {
      setSetupSquares((prev) => {
        if (setupDragSq === sq || !prev[setupDragSq]) return prev;
        const next = { ...prev };
        next[sq] = next[setupDragSq];
        delete next[setupDragSq];
        return next;
      });
      setSetupDragSq(null);
      setSetupError("");
      return;
    }
    setupPlaceOrClear(sq);
  }

  function setupClearBoard() {
    setSetupSquares({});
    setSetupError("");
  }

  function setupStandardBoard() {
    setSetupSquares(initialBoard(""));
    setSetupError("");
  }

  function startFromSetup() {
    const entries = Object.entries(setupSquares);
    const hasWK = entries.some(([, p]) => p.type === "k" && p.color === "w");
    const hasBK = entries.some(([, p]) => p.type === "k" && p.color === "b");
    if (!hasWK || !hasBK) {
      setSetupError("Both a white king and a black king are required.");
      return;
    }

    const strtPos = entries.map(([sq, p]) => `${sq}=${p.color}${p.type}`).join(",");

    setRunning(false);
    setMode("freeplay");
    setActiveGame(null);
    setPlies([]);
    setPlyIndex(0);
    setSelected(null);
    setPendingMove(null);
    setAnnotations({});
    setCustomStrtPos(strtPos);
    setCustomStartColor(setupTurn);
    setSetupOpen(false);
    setSetupError("");
  }

  function loadGame(game) {
    const { plies: loadedPlies, annotations: loadedAnnot } = loadGameMoves(game.moves, game.chsGm.StrtPos);
    setRunning(false);
    setMode("library");
    setActiveGame(game);
    setPlies(loadedPlies);
    setPlyIndex(0);
    setSelected(null);
    setPendingMove(null);
    setAnnotations(loadedAnnot);
    const loadedPauseFor = Math.min(60000, Math.max(1234, Number(game.chsGm.PauseFor) || 2222));
    loadedDefaultPauseForRef.current = loadedPauseFor;
    setGameMeta({
      id: game.chsGm.Id,
      gName: game.chsGm.GName,
      pauseFor: loadedPauseFor,
      remind: game.chsGm.Remind,
    });
    setLibraryOpen(false);
    loopCountRef.current = 0;
    libraryDirectionRef.current = 1;
  }

  function loadGameForAutoplay(game, factor = 1) {
    const { plies: loadedPlies, annotations: loadedAnnot } = loadGameMoves(game.moves, game.chsGm.StrtPos);
    setMode("library");
    setActiveGame(game);
    setPlies(loadedPlies);
    setPlyIndex(0);
    setSelected(null);
    setPendingMove(null);
    setAnnotations(loadedAnnot);

    const recordedPauseFor = Number(game.chsGm.PauseFor) || 2222;
    loadedDefaultPauseForRef.current = Math.min(60000, Math.max(1234, recordedPauseFor));
    setGameMeta({
      id: game.chsGm.Id,
      gName: game.chsGm.GName,
      pauseFor: Math.min(60000, Math.max(1234, Math.round(recordedPauseFor * factor))),
      remind: game.chsGm.Remind,
    });
  }

  function advanceToNextLibraryGame() {
    const currentGame = activeGameRef.current;
    const lib = libraryRef.current;
    if (!currentGame || !Array.isArray(lib) || lib.length < 2) return false;

    const sorted = [...lib].sort((a, b) => a.chsGm.Id - b.chsGm.Id);
    const curIdx = sorted.findIndex((g) => g.chsGm.Id === currentGame.chsGm.Id);
    if (curIdx === -1) return false;

    let dir = libraryDirectionRef.current;
    let nextIdx = curIdx + dir;
    if (nextIdx >= sorted.length) { dir = -1; nextIdx = curIdx - 1; }
    else if (nextIdx < 0) { dir = 1; nextIdx = curIdx + 1; }
    nextIdx = Math.max(0, Math.min(sorted.length - 1, nextIdx));
    libraryDirectionRef.current = dir;

    const outgoingDefault = loadedDefaultPauseForRef.current || DEFAULT_PAUSE_MS;
    const outgoingCurrent = pauseForRef.current || DEFAULT_PAUSE_MS;
    const factor = outgoingDefault > 0 ? outgoingCurrent / outgoingDefault : 1;

    loadGameForAutoplay(sorted[nextIdx], factor);
    return true;
  }

  function handleRun() {
    setPlyIndex(0);
    loopCountRef.current = 0;
    setSelected(null);
    setRunning(true);
  }
  function handlePauseResume() {
    setRunning((r) => !r);
  }
  function handleStop() {
    setRunning(false);
    loopCountRef.current = 0;
    setPlyIndex(0);
  }
  function handleResetBoard() {
    setRunning(false);
    setPlyIndex(0);
    setSelected(null);
  }

  function undo() {
    setPlyIndex((prev) => Math.max(0, prev - 1));
    setSelected(null);
  }

  function forward() {
    setPlyIndex((prev) => Math.min(plies.length, prev + 1));
    setSelected(null);
  }

  useEffect(() => {
    const THROTTLE_MS = 100;
    const handleKeyDown = (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();

      const now = Date.now();
      if (now - lastMoveTimeRef.current < THROTTLE_MS) return;
      lastMoveTimeRef.current = now;

      if (e.key === "ArrowRight") {
        setPlyIndex((prev) => Math.min(plies.length, prev + 1));
        setSelected(null);
      } else if (e.key === "ArrowLeft") {
        setPlyIndex((prev) => Math.max(0, prev - 1));
        setSelected(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [plies.length]);

  function jumpTo(n) {
    setRunning(false);
    setPlyIndex(Math.max(0, Math.min(plies.length, n)));
    setSelected(null);
  }

  function undoLast() {
    if (mode !== "freeplay" || plies.length === 0) return;
    const stepsToUndo = vsComputer && plies.length >= 2 ? 2 : 1;
    const next = plies.slice(0, Math.max(0, plyIndex - stepsToUndo));
    setPlies(next);
    setPlyIndex(next.length);
    setSelected(null);
  }

  function fastForward() {
    const wasRunning = runningRef.current;
    setRunning(false);
    if (fastForwardTimerRef.current) {
      clearInterval(fastForwardTimerRef.current);
      fastForwardTimerRef.current = null;
    }

    const n = Math.max(1, Number(fastN) || 1);
    const target = Math.min(plies.length, plyIndex + n);
    let stepsLeft = target - plyIndex;
    if (stepsLeft <= 0) {
      if (wasRunning) setRunning(true);
      return;
    }

    setSelected(null);
    fastForwardTimerRef.current = setInterval(() => {
      advanceTick();
      stepsLeft -= 1;
      if (stepsLeft <= 0) {
        clearInterval(fastForwardTimerRef.current);
        fastForwardTimerRef.current = null;
        if (wasRunning) setRunning(true);
      }
    }, FAST_FORWARD_MS);
  }

  function setAnnot(moveNo, value) {
    setAnnotations((prev) => ({ ...prev, [moveNo]: { ...prev[moveNo], annot: value } }));
  }

  function exportPayload() {
    return {
      chsGm: {
        Id: gameMeta.id,
        GName: gameMeta.gName,
        PauseFor: gameMeta.pauseFor,
        StrtPos: activeGame ? activeGame.chsGm.StrtPos : "",
        Remind: gameMeta.remind,
      },
      moves: rows.map((r) => ({
        Id: gameMeta.id,
        MoveNo: String(r.moveNo),
        Wh: r.wh,
        Bl: r.bl,
        ChsBkdPrt: "",
        Annot: r.annot,
        AdAnnot: r.adAnnot,
        RtfAnnot: "",
      })),
    };
  }

  function downloadJSON() {
    const blob = new Blob([JSON.stringify(exportPayload(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${gameMeta.gName.replace(/\s+/g, "_").slice(0, 40) || "game"}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function importGame() {
    try {
      const parsed = JSON.parse(importText);
      if (!parsed.chsGm || !Array.isArray(parsed.moves)) {
        throw new Error("Expected an object with chsGm and moves[]");
      }
      setLibrary((prev) => [...prev, parsed]);
      setImportText("");
      setImportError("");
    } catch (e) {
      setImportError(e.message || "Could not parse JSON");
    }
  }

  function getGameResult() {
    if (gameStatus?.type === "checkmate") {
      return gameStatus.text.includes("White") ? "1-0" : "0-1";
    }
    if (gameStatus?.type === "draw") return "1/2-1/2";
    return "*";
  }

  function downloadPGN() {
    if (plies.length === 0) return;
    const result = getGameResult();
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
    const whitePlayer = vsComputer && aiColor === "w" ? "Computer (1400)" : "Human";
    const blackPlayer = vsComputer && aiColor === "b" ? "Computer (1400)" : "Human";

    let pgn = `[Event "Chess Ledger Game"]\n`;
    pgn += `[Site "Chess Ledger"]\n`;
    pgn += `[Date "${date}"]\n`;
    pgn += `[White "${whitePlayer}"]\n`;
    pgn += `[Black "${blackPlayer}"]\n`;
    pgn += `[Result "${result}"]\n\n`;

    rows.forEach((r) => {
      pgn += `${r.moveNo}. ${r.wh} ${r.bl} `;
    });
    pgn += `${result}\n`;

    const blob = new Blob([pgn], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Game_${whitePlayer}_vs_${blackPlayer}_${date}.pgn`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadCurrentGameJSON() {
    if (plies.length === 0) return;
    const whitePlayer = vsComputer && aiColor === "w" ? "Computer" : "Human";
    const blackPlayer = vsComputer && aiColor === "b" ? "Computer" : "Human";
    const autoTitle = `${whitePlayer} vs ${blackPlayer} (${new Date().toLocaleDateString()})`;

    const payload = {
      chsGm: {
        Id: Date.now(),
        GName: autoTitle,
        PauseFor: gameMeta.pauseFor || 1234,
        StrtPos: activeStrtPos || "",
        Remind: `Played vs Computer`,
      },
      moves: rows.map((r) => ({
        Id: Date.now(),
        MoveNo: String(r.moveNo),
        Wh: r.wh,
        Bl: r.bl,
        ChsBkdPrt: "",
        Annot: r.annot || "",
        AdAnnot: r.adAnnot || "",
        RtfAnnot: "",
      })),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${autoTitle.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* --------------------------------- UI ---------------------------------- */

  const countdownSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
  const nextMover = turn === "w" ? "White" : "Black";
  const displayRanks = boardFlipped ? [...RANKS].reverse() : RANKS;
  const displayFiles = boardFlipped ? [...FILES].reverse() : FILES;

  // Players list extraction
  const onlinePlayersList = Object.values(onlinePlayers);
  const player1 = onlinePlayersList.find((x) => x.role === "Player 1");
  const player2 = onlinePlayersList.find((x) => x.role === "Player 2");
  const spectators = onlinePlayersList.filter(
    (x) => x.role === "Spectator" || (!x.role && x.role !== "Player 1" && x.role !== "Player 2")
  );
  const bothSeated = !!player1 && !!player2;

  const nameOf = (role) => {
    const pl = onlinePlayersList.find((x) => x.role === role);
    return pl ? pl.username : "—";
  };

  const renderClock = (color) => {
    const ms = color === "w" ? whiteMs : blackMs;
    const isMine = myColor === color;
    const ticking = isOnline && !onlineWinner && bothSeated && turn === color;
    return (
      <div className={`online-clock ${ticking ? "ticking" : ""} ${ms < 30000 ? "low" : ""}`}>
        <span className="online-clock-name">
          {isMine ? "You" : nameOf(color === "w" ? "Player 1" : "Player 2")} · {color === "w" ? "White" : "Black"}
        </span>
        <span className="online-clock-time">{formatClock(ms)}</span>
      </div>
    );
  };

  const topClockColor = boardFlipped ? "w" : "b";
  const bottomClockColor = boardFlipped ? "b" : "w";

  return (
    <div className="ledger-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=JetBrains+Mono:wght@400;500;600&display=swap');

        .ledger-root {
          --paper: #efe7d8;
          --paper-dim: #e4d8c1;
          --ink: #2a2724;
          --ink-soft: #6b6459;
          --walnut: #6b5842;
          --walnut-dark: #4a3b2a;
          --light-sq: #ae9e79;
          --dark-sq: #7c6448;
          --oxblood: #7a2e2e;
          --felt: #3f5d4e;
          --gold: #b08d57;
          background: var(--paper);
          color: var(--ink);
          font-family: 'JetBrains Mono', ui-monospace, monospace;
          min-height: 100%;
          padding: 28px 20px 40px;
        }

        .ledger-layout {
          display: flex;
          gap: 28px;
          flex-wrap: wrap;
          align-items: flex-start;
          margin-top: 22px;
        }

        .board-col {
          position: sticky;
          top: 20px;
          align-self: flex-start;
          z-index: 5;
        }

        .board-col:not(.mode-3d) {
          width: fit-content;
          flex: 0 0 auto;
        }
        .board-col:not(.mode-3d) .board-wrap {
          width: fit-content;
        }
        .board-col:not(.mode-3d) .ad-annot-banner {
          max-width: 454px;
          box-sizing: border-box;
        }

        .board-col.mode-3d {
          flex: 1 1 680px;
          max-width: 70%;
          width: auto;
        }
  
        .side-panel { flex: 1; min-width: 340px; }
        .side-panel.mode-3d {
          flex: 1 1 280px;
          max-width: 30%;
          min-width: 260px;
        }

        .board-wrap {
          background: var(--walnut-dark);
          padding: 16px;
          border-radius: 4px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
        }

        .board-grid {
          display: grid;
          grid-template-columns: repeat(8, 52px);
          grid-template-rows: repeat(8, 52px);
          border: 3px solid var(--walnut);
        }

        .board-square {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 34px;
          user-select: none;
          cursor: pointer;
          line-height: 1;
        }

        .board-square.light { background: var(--light-sq); }
        .board-square.dark { background: var(--dark-sq); }
        .board-square.selected {
          outline: 3px solid var(--gold);
          outline-offset: -3px;
        }

        .board-square.flash-path { animation: slowFadePath 1500ms ease-out forwards; }
        .board-square.flash-from { animation: slowFadeFrom 1500ms ease-out forwards; }
        .board-square.flash-to { animation: slowFadeTo 3500ms ease-out forwards; }
        .board-square.flash { animation: flashPulse ${FLASH_MS}ms ease; }

        .floating-thinking-badge {
          position: fixed;
          top: 20px;
          left: 50%;
          transform: translateX(-50%);
          background: var(--walnut-dark);
          color: #fbf8f2;
          border: 2px solid var(--gold);
          border-radius: 999px;
          padding: 8px 18px;
          font-size: 13px;
          font-weight: 600;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
          z-index: 9999;
          display: flex;
          align-items: center;
          gap: 8px;
          pointer-events: none;
          animation: slideDownFade 0.25s ease-out;
        }

        .status-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-weight: 700;
          font-size: 12px;
          padding: 6px 14px;
          border-radius: 999px;
          animation: pulseBadge 1.2s infinite ease-in-out;
        }

        .status-pill.check {
          background: #fff2f0;
          color: var(--oxblood);
          border: 1px solid var(--oxblood);
        }
        .status-pill.checkmate {
          background: var(--oxblood);
          color: #fff;
          border: 1px solid var(--oxblood);
        }
        .status-pill.draw {
          background: var(--walnut-dark);
          color: var(--paper);
          border: 1px solid var(--walnut);
        }

        .board-status-alert {
          font-family: 'Fraunces', Georgia, serif;
          font-weight: 700;
          font-size: 14px;
          text-align: center;
          padding: 8px 12px;
          border-radius: 4px;
          margin-bottom: 8px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          animation: slideInDown 0.3s ease-out;
        }

        .board-status-alert.check { background: #ff4d4f; color: #fff; border: 1px solid #d9363e; }
        .board-status-alert.checkmate { background: var(--oxblood); color: #fff; border: 1px solid #4a1515; font-size: 15px; }
        .board-status-alert.draw { background: var(--walnut-dark); color: var(--paper); border: 1px solid var(--walnut); }

        /* Online Coordination Banner */
        .online-coordination-banner {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          background: var(--paper-dim);
          border: 1px solid var(--walnut);
          border-left: 4px solid var(--gold);
          border-radius: 4px;
          padding: 8px 12px;
          margin-bottom: 8px;
          font-size: 12px;
          font-weight: 600;
        }
        .online-coordination-banner.waiting {
          border-left-color: #d97706;
          background: #fef3c7;
          color: #92400e;
        }
        .online-coordination-banner.active {
          border-left-color: var(--felt);
          background: #ecfdf5;
          color: #065f46;
        }

        .board-square.king-in-check {
          animation: kingCheckGlow 1s ease-in-out infinite;
        }
        .piece-disc.king-tilted {
          transform: rotate(90deg);
        }

        @keyframes kingCheckGlow {
          0%, 100% {
            box-shadow: inset 0 0 0 999px rgba(220, 20, 20, 0.35), 0 0 14px 4px rgba(220, 20, 20, 0.55);
          }
          50% {
            box-shadow: inset 0 0 0 999px rgba(220, 20, 20, 0.6), 0 0 22px 8px rgba(220, 20, 20, 0.85);
          }
        }

        @keyframes slideInDown {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes pulseBadge {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.04); }
        }

        @keyframes slideDownFade {
          from { opacity: 0; transform: translate(-50%, -14px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }

        @keyframes slowFadePath {
          0% { box-shadow: inset 0 0 0 999px rgba(180, 160, 220, 0.65); }
          100% { box-shadow: inset 0 0 0 999px rgba(180, 160, 220, 0); }
        }

        @keyframes slowFadeFrom {
          0% { box-shadow: inset 0 0 0 999px rgba(41, 188, 36, 0.9); }
          100% { box-shadow: inset 0 0 0 999px rgba(223, 31, 14, 0.38); }
        }

        @keyframes slowFadeTo {
          0% { box-shadow: inset 0 0 0 999px rgba(80, 140, 90, 0.9); }
          100% { box-shadow: inset 0 0 0 999px rgba(80, 140, 90, 0.45); }
        }

        @keyframes pieceSettle {
          0% { opacity: 0.18; }
          100% { opacity: 1; }
        }
        .piece-disc.piece-settle { animation: pieceSettle 480ms ease-out; }

        @keyframes ghostFade {
          0% { opacity: 0.55; }
          100% { opacity: 0; }
        }
        .ghost-piece {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: none;
          animation: ghostFade 2650ms ease-out forwards;
        }

        @keyframes captureFade {
          0% { opacity: 0.9; transform: translate(0%, -50%) rotate(40deg) scale(1.1); }
          100% { opacity: 0; transform: translate(55%, -120%) rotate(28deg) scale(1.1); }
        }
        .capture-ghost {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 30px;
          pointer-events: none;
          z-index: 6;
          animation: captureFade 3900ms ease-out forwards;
        }

        @keyframes flashPulse {
          0% { box-shadow: inset 0 0 0 999px rgba(176, 141, 87, 0); }
          25% { box-shadow: inset 0 0 0 999px rgba(176, 141, 87, 0.85); }
          100% { box-shadow: inset 0 0 0 999px rgba(176, 141, 87, 0); }
        }

        .piece-disc {
          width: 82%;
          height: 82%;
          border-radius: 999px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .piece-disc.white-disc {
          background: radial-gradient(circle, rgba(42, 39, 36, 0.6) 0%, rgba(42, 39, 36, 0.3) 55%, rgba(42, 39, 36, 0.4) 76%);
        }
        .piece-disc.black-disc {
          background: radial-gradient(circle, rgba(255, 255, 255, 0.5) 0%, rgba(255, 255, 255, 0.24) 55%, rgba(255, 255, 255, 0) 76%);
        }

        .board-square .white-piece {
          color: #fbf8f2;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
        }
        .board-square .black-piece {
          color: #201c18;
          text-shadow: 0 1px 1px rgba(255, 255, 255, 0.25);
        }

        .coord-file, .coord-rank {
          font-size: 10px;
          color: var(--paper-dim);
          position: absolute;
          opacity: 0.7;
        }
        .coord-file { bottom: 2px; right: 4px; }
        .coord-rank { top: 2px; left: 4px; }

        .captured-rail {
          min-height: 26px;
          display: flex;
          gap: 4px;
          padding: 4px 2px;
          font-size: 20px;
          color: var(--ink-soft);
        }

        .ad-annot-banner {
          font-family: 'Fraunces', Georgia, serif;
          font-style: italic;
          font-weight: 600;
          font-size: 17px;
          line-height: 1.35;
          color: var(--ink);
          background: var(--paper-dim);
          border: 1px solid var(--walnut);
          border-left: 4px solid var(--oxblood);
          border-radius: 3px;
          padding: 8px 14px;
          margin-bottom: 8px;
          max-width: 100%;
          height: 78px;
          overflow-y: auto;
          white-space: pre-wrap;
        }

        .pill-row {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          align-items: center;
        }

        .turn-pill, .mode-pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          background: var(--paper-dim);
          border: 1px solid var(--walnut);
          border-radius: 999px;
          padding: 6px 14px;
          font-size: 12px;
        }
        .mode-pill.library {
          background: var(--felt);
          color: var(--paper);
          border-color: var(--felt);
        }
        .mode-pill.online {
          background: #1e3a8a;
          color: #f8fafc;
          border-color: #1e3a8a;
        }

        .dot {
          width: 9px;
          height: 9px;
          border-radius: 999px;
          border: 1px solid var(--ink);
        }

        .section-label {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--ink-soft);
          margin: 16px 0 6px;
        }

        .btn-row {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          align-items: center;
          margin: 8px 0;
        }

        .btn {
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          background: var(--paper);
          border: 1px solid var(--walnut);
          color: var(--ink);
          padding: 7px 12px;
          border-radius: 3px;
          cursor: pointer;
        }
        .btn:hover { background: var(--paper-dim); }
        .btn:disabled { opacity: 0.4; cursor: default; }
        .btn.primary { background: var(--oxblood); border-color: var(--oxblood); color: #f7f0e8; }
        .btn.active { background: var(--felt); border-color: var(--felt); color: #f7f0e8; }
        .btn.small { padding: 4px 8px; font-size: 11px; }

        .check-row {
          display: flex;
          gap: 16px;
          align-items: center;
          font-size: 12px;
          color: var(--ink-soft);
          flex-wrap: wrap;
        }
        .check-row label {
          display: flex;
          align-items: center;
          gap: 5px;
          cursor: pointer;
        }

        .countdown {
          font-family: 'Fraunces', serif;
          font-weight: 600;
          font-size: 15px;
          color: var(--oxblood);
          min-width: 74px;
        }

        .meta-row {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          margin-bottom: 8px;
        }
        .meta-field {
          display: flex;
          flex-direction: column;
          gap: 3px;
          font-size: 11px;
          color: var(--ink-soft);
        }
        .meta-field input {
          font-family: 'JetBrains Mono', monospace;
          background: var(--paper);
          border: 1px solid var(--walnut);
          border-radius: 3px;
          padding: 5px 7px;
          color: var(--ink);
          font-size: 12px;
        }

        .scoresheet {
          border: 1px solid var(--walnut);
          border-radius: 4px;
          overflow: hidden;
          background: var(--paper);
          margin-top: 6px;
        }
        .scoresheet-head {
          display: grid;
          grid-template-columns: 40px 9ch 9ch 1fr;
          background: var(--walnut);
          color: var(--paper);
          font-size: 11px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }
        .scoresheet-head div { padding: 7px 8px; }
        .scoresheet-body {
          max-height: min(44vh, 460px);
          overflow-y: auto;
          overscroll-behavior: contain;
        }
        .scoresheet-row {
          display: grid;
          grid-template-columns: 40px 9ch 9ch 1fr;
          border-top: 1px solid var(--paper-dim);
          font-size: 13px;
        }
        .scoresheet-row div { padding: 6px 8px; display: flex; align-items: center; }
        .scoresheet-row .mv-no { color: var(--ink-soft); font-family: 'Fraunces', serif; }
        .mv-cell { cursor: pointer; border-radius: 2px; }
        .mv-cell:hover { background: var(--paper-dim); }
        .mv-cell.active { background: var(--gold); color: var(--ink); font-weight: 600; }
        .mv-cell.captured-move { color: var(--oxblood); }
        .adannot-row {
          grid-column: 1 / -1;
          padding: 0 8px 8px 48px !important;
          font-size: 11px;
          font-style: italic;
          color: var(--ink-soft);
        }

        .annot-input {
          width: 100%;
          border: none;
          background: transparent;
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          color: var(--ink-soft);
          outline: none;
          resize: none;
          overflow-y: auto;
          line-height: 18px;
        }

        .caption {
          font-size: 11px;
          color: var(--ink-soft);
          margin-top: 10px;
          line-height: 1.5;
        }

        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(20, 16, 12, 0.55);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 50;
        }
        .modal {
          background: var(--paper);
          border: 1px solid var(--walnut);
          border-radius: 6px;
          padding: 22px;
          min-width: 260px;
          max-width: 90vw;
        }
        .modal h3 { font-family: 'Fraunces', serif; margin: 0 0 14px; }

        .promo-choices { display: flex; gap: 8px; }
        .promo-choices button {
          flex: 1;
          font-size: 26px;
          padding: 10px 0;
          background: var(--paper-dim);
          border: 1px solid var(--walnut);
          border-radius: 4px;
          cursor: pointer;
        }
        .promo-choices button:hover { background: var(--gold); }

        textarea.export-area, textarea.import-area {
          width: 100%;
          height: 220px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          padding: 10px;
          border: 1px solid var(--walnut);
          border-radius: 4px;
          background: #fbf8f2;
          color: var(--ink);
        }

        .library-list {
          max-height: 300px;
          overflow-y: auto;
          border: 1px solid var(--walnut);
          border-radius: 4px;
          margin-bottom: 14px;
        }
        .library-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          border-top: 1px solid var(--paper-dim);
        }
        .library-row:first-child { border-top: none; }
        .library-row-title { font-size: 13px; }
        .library-row-meta { font-size: 11px; color: var(--ink-soft); }

        .import-error { color: var(--oxblood); font-size: 11px; margin-top: 6px; }

        .setup-modal { min-width: 460px; }
        .setup-layout { display: flex; gap: 20px; flex-wrap: wrap; align-items: flex-start; }
        .setup-board-grid {
          display: grid;
          grid-template-columns: repeat(8, 40px);
          grid-template-rows: repeat(8, 40px);
          border: 3px solid var(--walnut);
        }
        .setup-square {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 26px;
          user-select: none;
          cursor: pointer;
          line-height: 1;
        }
        .setup-square.light { background: var(--light-sq); }
        .setup-square.dark { background: var(--dark-sq); }
        .setup-side { min-width: 190px; }
        .setup-palette-row { display: flex; gap: 4px; margin-bottom: 6px; }
        .setup-piece-btn {
          flex: 1;
          font-size: 22px;
          padding: 6px 0;
          background: var(--paper-dim);
          border: 1px solid var(--walnut);
          border-radius: 4px;
          cursor: pointer;
          line-height: 1;
        }
        .setup-piece-btn:hover { background: var(--gold); }
        .setup-piece-btn.active {
          background: var(--gold);
          outline: 2px solid var(--walnut-dark);
          outline-offset: -2px;
        }
        .setup-eraser-btn {
          width: 100%;
          padding: 6px 0;
          margin-bottom: 12px;
          background: var(--paper-dim);
          border: 1px solid var(--walnut);
          border-radius: 4px;
          cursor: pointer;
          font-size: 12px;
        }
        .setup-eraser-btn.active { background: var(--oxblood); color: #fff; }
        .setup-turn-row { display: flex; gap: 6px; margin: 10px 0; }
        .setup-turn-row .btn.active { background: var(--gold); }

        .online-clock {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          background: var(--paper-dim);
          border: 1px solid var(--walnut);
          border-radius: 4px;
          padding: 6px 12px;
          margin: 6px 0;
          font-size: 12px;
          color: var(--ink-soft);
        }
        .online-clock-time {
          font-family: 'Fraunces', serif;
          font-weight: 700;
          font-size: 20px;
          color: var(--ink);
          font-variant-numeric: tabular-nums;
        }
        .online-clock.ticking {
          background: var(--felt);
          border-color: var(--felt);
          color: var(--paper);
        }
        .online-clock.ticking .online-clock-time { color: #fbf8f2; }
        .online-clock.low .online-clock-time { color: var(--oxblood); }
        .online-clock.ticking.low .online-clock-time { color: #ffb3b3; }

        .games-input {
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          padding: 5px 7px;
          border: 1px solid var(--walnut);
          border-radius: 3px;
          background: var(--paper);
          color: var(--ink);
        }

        /* Messaging & Chat Panel */
        .chat-container {
          border: 1px solid var(--walnut);
          border-radius: 4px;
          background: var(--paper);
          margin-top: 10px;
          overflow: hidden;
        }
        .chat-header {
          background: var(--walnut);
          color: var(--paper);
          padding: 6px 10px;
          font-size: 12px;
          font-weight: 600;
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: pointer;
        }
        .chat-body {
          padding: 8px;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .chat-messages {
          height: 120px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding-right: 4px;
        }
        .chat-msg {
          font-size: 11px;
          line-height: 1.3;
          padding: 3px 6px;
          background: var(--paper-dim);
          border-radius: 3px;
          word-break: break-word;
        }
        .chat-msg-author {
          font-weight: 700;
          color: var(--walnut-dark);
        }
        .chat-msg-time {
          font-size: 9px;
          color: var(--ink-soft);
          margin-left: 4px;
        }
        .chat-presets {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
          padding: 4px 0;
        }
        .chat-chip {
          font-size: 10px;
          padding: 2px 6px;
          background: var(--paper-dim);
          border: 1px solid var(--walnut);
          border-radius: 999px;
          cursor: pointer;
          white-space: nowrap;
        }
        .chat-chip:hover {
          background: var(--gold);
        }
        .chat-input-row {
          display: flex;
          gap: 6px;
        }
        .chat-input {
          flex: 1;
          font-family: inherit;
          font-size: 11px;
          padding: 5px 8px;
          border: 1px solid var(--walnut);
          border-radius: 3px;
          background: #fbf8f2;
        }
      `}</style>

      <div className="ledger-layout">
        {/* Board */}
        <div className={`board-col ${is3D ? "mode-3d" : ""}`}>
          <div className="ad-annot-banner">
            {currentAdAnnot || currentAnnot || (
              <span style={{ opacity: 0.45, fontStyle: "normal" }}>No annotation for this move</span>
            )}
          </div>

          {/* Online Match Coordination Status Banner */}
          {isOnline && (
            <div className={`online-coordination-banner ${bothSeated ? "active" : "waiting"}`}>
              <div>
                {!bothSeated ? (
                  <>
                    <span>⏳ Waiting for an opponent to join... </span>
                    {onlineRole === "Player 1" && <span>(You are White)</span>}
                    {onlineRole === "Player 2" && <span>(You are Black)</span>}
                    {onlineRole === "Spectator" && <span>(Seat is open — click "Join Game")</span>}
                  </>
                ) : (
                  <>
                    <span>⚔️ Match in progress: {nameOf("Player 1")} (W) vs {nameOf("Player 2")} (B)</span>
                  </>
                )}
              </div>
              {!bothSeated && (
                <button className="btn small" onClick={copyInviteLink}>
                  {copyFeedback ? `✓ ${copyFeedback}` : "📋 Copy Invite Link"}
                </button>
              )}
            </div>
          )}

          {/* Sticky Real-Time Check / Checkmate / Draw Alert */}
          {gameStatus && (
            <div className={`board-status-alert ${gameStatus.type}`}>
              {gameStatus.text}
            </div>
          )}
          {isOnline && (onlineWinner === "Timeout" || onlineWinner === "Abandoned") && (
            <div className="board-status-alert checkmate">
              {onlineWinner === "Timeout"
                ? `⏱ ${whiteMs === 0 ? "White" : "Black"} ran out of time`
                : "🚪 Game abandoned"}
            </div>
          )}

          {isOnline && renderClock(topClockColor)}
          <div className="captured-rail">
            {capturedBlack.map((p, i) => (
              <span key={i} className="black-piece">{GLYPH.b[p.type]}</span>
            ))}
          </div>

          <div className="board-wrap">
            {is3D ? (
              <Board3D
                board={board}
                FILES={FILES}
                RANKS={RANKS}
                selected={selected}
                flash={flash}
                gameStatus={gameStatus}
                pickSquare={pickSquare}
                onDrop={onDrop}
                fileIdx={fileIdx}
              />
            ) : (
              <div className="board-grid">
                {displayRanks.map((r) =>
                  displayFiles.map((f, fi) => {
                    const sq = f + r;
                    const piece = board[sq];
                    const light = (fileIdx(sq) + r) % 2 === 0;

                    const isFrom = flash && flash.fromSquares?.includes(sq);
                    const isTo = flash && flash.toSquares?.includes(sq);
                    const isPath = flash && flash.pathSquares?.includes(sq);
                    const ghost = !piece && flash && flash.ghosts?.find((g) => g.sq === sq);
                    const isCheckedKing =
                      piece &&
                      piece.type === "k" &&
                      (gameStatus?.type === "check" || gameStatus?.type === "checkmate") &&
                      piece.color === gameStatus.checkedColor;
                    const isMatedKing =
                      piece &&
                      piece.type === "k" &&
                      gameStatus?.type === "checkmate" &&
                      piece.color === gameStatus.checkedColor;

                    return (
                      <div
                        key={sq + (isFrom || isTo || isPath ? flash.id : "")}
                        className={`board-square ${light ? "light" : "dark"} ${selected === sq ? "selected" : ""} ${isFrom ? "flash-from" : ""} ${isTo ? "flash-to" : ""} ${isPath ? "flash-path" : ""} ${isCheckedKing ? "king-in-check" : ""}`}
                        onClick={() => pickSquare(sq)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => onDrop(sq)}
                      >
                        {fi === 0 && <span className="coord-rank">{r}</span>}
                        {r === displayRanks[displayRanks.length - 1] && <span className="coord-file">{f}</span>}
                        {piece && (
                          <div
                            className={`piece-disc ${piece.color === "w" ? "white-disc" : "black-disc"} ${isTo ? "piece-settle" : ""} ${isMatedKing ? "king-tilted" : ""}`}
                          >
                            <span
                              draggable={
                                (mode === "freeplay" ||
                                  (mode === "online" && piece.color === myColor && !onlineWinner)) &&
                                atEnd &&
                                piece.color === turn &&
                                !pendingMove
                              }
                              onDragStart={() => setDragSq(sq)}
                              className={piece.color === "w" ? "white-piece" : "black-piece"}
                            >
                              {GLYPH[piece.color][piece.type]}
                            </span>
                          </div>
                        )}
                        {ghost && (
                          <div className="ghost-piece">
                            <span className={ghost.color === "w" ? "white-piece" : "black-piece"}>
                              {GLYPH[ghost.color][ghost.type]}
                            </span>
                          </div>
                        )}
                        {flash?.captureGhost?.sq === sq && (
                          <div className="capture-ghost">
                            <span className={flash.captureGhost.color === "w" ? "white-piece" : "black-piece"}>
                              {GLYPH[flash.captureGhost.color][flash.captureGhost.type]}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
          <div className="captured-rail">
            {capturedWhite.map((p, i) => (
              <span key={i} className="white-piece" style={{ color: "#4a3b2a" }}>
                {GLYPH.w[p.type]}
              </span>
            ))}
          </div>
          {isOnline && renderClock(bottomClockColor)}
        </div>

        {/* Side panel */}
        <div className="side-panel">
          <div className="pill-row">
            <span className="turn-pill">
              <span className="dot" style={{ background: turn === "w" ? "#f7f3ea" : "#201c18" }} />
              {gameStatus?.isOver ? "Game Over" : `${nextMover} to move`}
              {!atEnd && <span style={{ color: "var(--oxblood)" }}> · ply {plyIndex}/{plies.length}</span>}
            </span>

            {gameStatus && (
              <span className={`status-pill ${gameStatus.type}`}>
                {gameStatus.text}
              </span>
            )}

            <span className={`mode-pill ${mode === "library" ? "library" : mode === "online" ? "online" : ""}`}>
              {mode === "online" ? (
                <>
                  <span
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: isSocketConnected ? "#22c55e" : "#ef4444",
                    }}
                  />
                  Online: {onlineUsername ? `${onlineUsername} (${onlineRole || "joining..."})` : (onlineRole || "connecting...")}
                </>
              ) : mode === "library" ? (
                `Library: ${gameMeta.gName.slice(0, 28)}${gameMeta.gName.length > 28 ? "…" : ""} (Id ${gameMeta.id})`
              ) : (
                "Free play"
              )}
            </span>
          </div>

          <div className="section-label">Online & Players</div>
          <div className="btn-row">
            <button className={`btn ${isOnline ? "active" : ""}`} onClick={isOnline ? leaveOnline : startOnline}>
              {isOnline ? "🌐 Online (ON) — Leave" : "🌐 Play Online"}
            </button>
            {isOnline && (
              <button className="btn" onClick={() => setPlayersModalOpen(true)}>
                👥 Who's Online ({onlinePlayersList.length})
              </button>
            )}
            {isOnline && onlineRole === "Spectator" && (
              <button className="btn primary" onClick={() => socketRef.current?.emit("joinGame")}>
                🎮 Join Game
              </button>
            )}
            {isOnline && (onlineRole === "Player 1" || onlineRole === "Player 2") && (
              <button className="btn" onClick={() => socketRef.current?.emit("quitGame")}>
                Quit Playing
              </button>
            )}
            {isOnline && onlineWinner && (
              <button className="btn primary" onClick={() => socketRef.current?.emit("reset")}>
                Rematch (swap sides)
              </button>
            )}
            {onlineToken ? (
              <>
                <button className="btn" onClick={openGames}>📚 My Games</button>
                <button className="btn" onClick={logoutOnline}>Logout</button>
              </>
            ) : (
              <button className="btn" onClick={() => setAuthOpen(true)}>🔑 Login / Register</button>
            )}
          </div>

          <div className="section-label">Library & Position</div>
          <div className="btn-row">
            <button className="btn primary" onClick={() => setLibraryOpen(true)}>Load…</button>
            <button className="btn" onClick={newGame}>New Game</button>
            <button className="btn" onClick={() => setBoardFlipped((f) => !f)}>
              {boardFlipped ? "🔃 Flip Board (Black)" : "🔃 Flip Board (White)"}
            </button>
            <button className={`btn ${is3D ? "active" : ""}`} onClick={() => setIs3D((v) => !v)}>
              {is3D ? "🟫 2D Board" : "🧊 3D Board"}
            </button>
            <button className="btn" onClick={openSetup}>Set Up Position…</button>
            <button className={`btn ${vsComputer ? "active" : ""}`} onClick={() => setVsComputer((v) => !v)}>
              {vsComputer ? "👤 vs.🤖 (ON)" : "👤 vs.🤖"}
            </button>
            {vsComputer && (
              <button className="btn" onClick={() => setAiColor((c) => (c === "b" ? "w" : "b"))}>
                AI: {aiColor === "w" ? "White (First)" : "Black (Second)"}
              </button>
            )}
            <button
              className="btn"
              onClick={() => {
                const current = localStorage.getItem("user_groq_key") || "";
                const key = window.prompt("Enter your personal Groq API Key for AI Grandmaster Commentary (Saved locally on your browser only):", current);
                if (key !== null) {
                  if (key.trim()) {
                    localStorage.setItem("user_groq_key", key.trim());
                    alert("API Key saved! You now have AI commentary enabled.");
                  } else {
                    localStorage.removeItem("user_groq_key");
                    alert("API Key removed.");
                  }
                }
              }}
            >
              🤖 Set AI Key
            </button>
          </div>

          <div className="btn-row" style={{ alignItems: "center" }}>
            <button className="btn primary" onClick={downloadPGN} disabled={plies.length === 0}>
              💾 Download PGN
            </button>
            <button className="btn" onClick={downloadCurrentGameJSON} disabled={plies.length === 0}>
              💾 Download JSON
            </button>
            <button className="btn" onClick={() => setExportOpen(true)}>
              Export / View Text
            </button>
          </div>

          {/* In-Game Chat Accordion */}
          {isOnline && (
            <div className="chat-container">
              <div
                className="chat-header"
                onClick={() => {
                  setChatOpen((o) => !o);
                  setUnreadChat(0);
                }}
              >
                <span>💬 Game Chat {unreadChat > 0 && `(${unreadChat} new)`}</span>
                <span>{chatOpen ? "▲" : "▼"}</span>
              </div>
              {chatOpen && (
                <div className="chat-body">
                  <div className="chat-messages" ref={chatScrollRef}>
                    {chatMessages.length === 0 && (
                      <div style={{ fontSize: 11, color: "var(--ink-soft)", fontStyle: "italic" }}>
                        No messages yet. Send a quick phrase or chat below.
                      </div>
                    )}
                    {chatMessages.map((m, idx) => (
                      <div key={m.id || idx} className="chat-msg">
                        <span className="chat-msg-author">{m.sender}:</span> {m.text}
                        <span className="chat-msg-time">{m.time}</span>
                      </div>
                    ))}
                  </div>
                  <div className="chat-presets">
                    {QUICK_CHAT_PRESETS.map((p, i) => (
                      <button key={i} className="chat-chip" onClick={() => sendChatMessage(p)}>
                        {p}
                      </button>
                    ))}
                  </div>
                  <div className="chat-input-row">
                    <input
                      className="chat-input"
                      placeholder="Type a message..."
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") sendChatMessage(chatInput);
                      }}
                    />
                    <button className="btn small primary" onClick={() => sendChatMessage(chatInput)}>
                      Send
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="check-row" style={{ marginTop: 12 }}>
            <label><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop</label>
            <label><input type="checkbox" checked={blink} onChange={(e) => setBlink(e.target.checked)} /> Blink</label>
            <label><input type="checkbox" checked={showCountdown} onChange={(e) => setShowCountdown(e.target.checked)} /> Show countdown</label>
            <label title="With Loop on: advances library games continuously">
              <input type="checkbox" checked={autoNext} onChange={(e) => handleAutoNextToggle(e.target.checked)} disabled={mode !== "library"} />
              Auto-Next/Prev
            </label>
            <span>pause: {pauseForActive}ms</span>
          </div>

          <div className="section-label">Game meta</div>
          <div className="meta-row">
            <label className="meta-field">Id
              <input
                type="number"
                value={gameMeta.id}
                onChange={(e) => setGameMeta({ ...gameMeta, id: Number(e.target.value) })}
                style={{ width: 60 }}
                disabled={mode === "library"}
              />
            </label>
            <label className="meta-field">GName
              <input
                value={gameMeta.gName}
                onChange={(e) => setGameMeta({ ...gameMeta, gName: e.target.value })}
                style={{ width: 200 }}
                disabled={mode === "library"}
              />
            </label>
            <label
              className="meta-field"
              onDoubleClick={handlePauseForDoubleClick}
              style={{ cursor: "pointer", userSelect: "none" }}
              title="Double-click to double this value"
            >
              PauseFor (1234–60000 ms)
              <input
                type="number"
                min={1234}
                max={60000}
                step={500}
                value={gameMeta.pauseFor}
                onDoubleClick={handlePauseForDoubleClick}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setGameMeta((prev) => ({ ...prev, pauseFor: val }));
                  if (activeGame) {
                    setActiveGame((prev) => (prev ? { ...prev, chsGm: { ...prev.chsGm, PauseFor: val } } : null));
                  }
                }}
                style={{ width: 110, cursor: "pointer" }}
              />
            </label>
          </div>

          <div className="section-label">Playback</div>
          <div className="btn-row">
            <button className="btn" onClick={handleRun} disabled={plies.length === 0}>▶ Run</button>
            <button className="btn" onClick={handlePauseResume} disabled={plies.length === 0}>{running ? "⏸ Pause" : "⏵ Resume"}</button>
            <button className="btn" onClick={handleStop} disabled={plies.length === 0}>■ Stop</button>
            <button className="btn" onClick={handleResetBoard} disabled={plies.length === 0}>⟲ Reset</button>
            {showCountdown && running && <span className="countdown">⏱ {countdownSeconds}s</span>}
          </div>

          <div className="btn-row">
            <button className="btn" onClick={undo} disabled={atStart}>◂ Back</button>
            <button className="btn" onClick={forward} disabled={atEnd}>Forward ▸</button>
            <button className="btn" onClick={undoLast} disabled={mode !== "freeplay" || plies.length === 0}>
              ↩ Take Back Move
            </button>
            <input
              type="number"
              min={1}
              value={fastN}
              onChange={(e) => setFastN(e.target.value)}
              style={{ width: 46, fontFamily: "inherit", fontSize: 12, border: "1px solid var(--walnut)", borderRadius: 3, padding: "6px 4px" }}
            />
            <button className="btn" onClick={fastForward} disabled={atEnd}>⏩ Fastmove</button>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                fontSize: 12,
                cursor: "pointer",
                marginLeft: 6,
                color: "var(--ink-soft)",
              }}
            >
              <input type="checkbox" checked={autoScrollAnnot} onChange={(e) => setAutoScrollAnnot(e.target.checked)} />
              Auto-Scroll
            </label>
          </div>

          <div className="btn-row" style={{ alignItems: "center" }}>
            {isThinking && (
              <div className="floating-thinking-badge">
                <span>⏳</span> Computer is thinking…
              </div>
            )}
          </div>

          <div className="scoresheet">
            <div className="scoresheet-head">
              <div>#</div><div>White</div><div>Black</div><div>Annot</div>
            </div>
            <div className="scoresheet-body">
              {rows.length === 0 && (
                <div className="scoresheet-row">
                  <div className="mv-no">—</div><div /><div /><div style={{ color: "var(--ink-soft)" }}>no moves yet</div>
                </div>
              )}
              {rows.map((r) => (
                <div key={r.moveNo} style={{ display: "contents" }}>
                  <div className="scoresheet-row" data-moveno={r.moveNo}>
                    <div className="mv-no">{r.moveNo}.</div>
                    <div
                      className={`mv-cell ${plyIndex === r.whIndex ? "active" : ""} ${r.wh.includes("x") ? "captured-move" : ""}`}
                      onClick={() => jumpTo(r.whIndex)}
                    >
                      {r.wh}
                    </div>
                    <div
                      className={`mv-cell ${plyIndex === r.blIndex ? "active" : ""} ${r.bl.includes("x") ? "captured-move" : ""}`}
                      onClick={() => r.blPlayed && jumpTo(r.blIndex)}
                    >
                      {r.bl}
                    </div>
                    <div style={{ padding: "4px 8px" }}>
                      <textarea
                        className="annot-input"
                        data-annot-moveno={r.moveNo}
                        placeholder="note…"
                        value={annotations[r.moveNo]?.annot || ""}
                        onChange={(e) => setAnnot(r.moveNo, e.target.value)}
                        onMouseEnter={(e) => handleAnnotMouseEnter(e.currentTarget)}
                        onMouseLeave={(e) => handleAnnotMouseLeave(e.currentTarget)}
                        rows={3}
                        style={{
                          resize: "none",
                          height: "54px",
                          overflowY: "auto",
                          lineHeight: "18px",
                          width: "100%",
                          display: "block",
                        }}
                      />
                    </div>
                  </div>
                  {r.adAnnot && (
                    <div className="scoresheet-row" data-moveno={r.moveNo}>
                      <div className="adannot-row">{r.adAnnot}</div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="caption">
            Use Load to browse recorded games or New Game to play locally. Play Online
            connects you to other logged-in players in real time.
          </div>
        </div>
      </div>

      {/* Promotions Modal */}
      {pendingMove && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Promote to…</h3>
            <div className="promo-choices">
              {PROMO_CHOICES.map((c) => (
                <button key={c.type} title={c.label} onClick={() => confirmPromotion(c.type)}>
                  {GLYPH[pendingMove.pieceColor][c.type]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Online Users Modal */}
      {playersModalOpen && (
        <div className="modal-backdrop" onClick={() => setPlayersModalOpen(false)}>
          <div className="modal" style={{ minWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <h3>Online Room Presence</h3>
            <div style={{ fontSize: 12, marginBottom: 14 }}>
              Connection status:{" "}
              <strong style={{ color: isSocketConnected ? "#15803d" : "#b91c1c" }}>
                {isSocketConnected ? "🟢 Connected" : "🔴 Disconnected"}
              </strong>
            </div>

            <div className="library-list">
              <div className="library-row">
                <div>
                  <div className="library-row-title">⚪ Player 1 (White)</div>
                  <div className="library-row-meta">
                    {player1 ? `${player1.username} ${player1.username === onlineUsername ? "(You)" : ""}` : "Open Seat — Waiting"}
                  </div>
                </div>
              </div>
              <div className="library-row">
                <div>
                  <div className="library-row-title">⚫ Player 2 (Black)</div>
                  <div className="library-row-meta">
                    {player2 ? `${player2.username} ${player2.username === onlineUsername ? "(You)" : ""}` : "Open Seat — Waiting"}
                  </div>
                </div>
              </div>
              <div className="library-row">
                <div>
                  <div className="library-row-title">👁️ Spectators ({spectators.length})</div>
                  <div className="library-row-meta">
                    {spectators.length > 0 ? spectators.map((s) => s.username).join(", ") : "No spectators"}
                  </div>
                </div>
              </div>
            </div>

            <div className="btn-row">
              <button className="btn" onClick={copyInviteLink}>
                {copyFeedback ? `✓ ${copyFeedback}` : "📋 Copy Room Link"}
              </button>
              <button className="btn primary" onClick={() => setPlayersModalOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Game Library Modal */}
      {libraryOpen && (
        <div className="modal-backdrop" onClick={() => setLibraryOpen(false)}>
          <div className="modal" style={{ minWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <h3>Game library</h3>
            <div className="library-list">
              {library.map((g) => (
                <div className="library-row" key={g.chsGm.Id}>
                  <div>
                    <div className="library-row-title">{g.chsGm.GName}</div>
                    <div className="library-row-meta">
                      Id {g.chsGm.Id} · pause {g.chsGm.PauseFor}ms · {g.moves.length} recorded move-pairs
                    </div>
                  </div>
                  <button className="btn primary" onClick={() => loadGame(g)}>Load</button>
                </div>
              ))}
            </div>
            <div className="section-label">Import a game (JSON)</div>
            <textarea
              className="import-area"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder='{ "chsGm": { ... }, "moves": [ ... ] }'
            />
            {importError && <div className="import-error">{importError}</div>}
            <div className="btn-row">
              <button className="btn primary" onClick={importGame}>Add to library</button>
              <button className="btn" onClick={() => setLibraryOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Export Modal */}
      {exportOpen && (
        <div className="modal-backdrop" onClick={() => setExportOpen(false)}>
          <div className="modal" style={{ minWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3>Export — CHSGM / MOVES</h3>
            <textarea ref={taRef} className="export-area" readOnly value={JSON.stringify(exportPayload(), null, 2)} />
            <div className="btn-row">
              <button className="btn" onClick={() => { taRef.current.select(); document.execCommand("copy"); }}>Copy</button>
              <button className="btn primary" onClick={downloadJSON}>Download .json</button>
              <button className="btn" onClick={() => setExportOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Board Setup Modal */}
      {setupOpen && (
        <div className="modal-backdrop" onClick={() => setSetupOpen(false)}>
          <div className="modal setup-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Set up position</h3>
            <div className="setup-layout">
              <div className="board-wrap" style={{ padding: 12 }}>
                <div className="setup-board-grid">
                  {RANKS.map((r) =>
                    FILES.map((f) => {
                      const sq = f + r;
                      const piece = setupSquares[sq];
                      const light = (fileIdx(sq) + r) % 2 === 0;
                      return (
                        <div
                          key={sq}
                          className={`setup-square ${light ? "light" : "dark"}`}
                          onClick={() => setupPlaceOrClear(sq)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => setupOnDrop(sq)}
                        >
                          {piece && (
                            <span
                              draggable
                              onDragStart={() => setSetupDragSq(sq)}
                              className={piece.color === "w" ? "white-piece" : "black-piece"}
                            >
                              {GLYPH[piece.color][piece.type]}
                            </span>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="setup-side">
                <div className="section-label">White pieces</div>
                <div className="setup-palette-row">
                  {["k", "q", "r", "b", "n", "p"].map((t) => (
                    <button
                      key={"w" + t}
                      className={`setup-piece-btn ${setupTool && setupTool.color === "w" && setupTool.type === t ? "active" : ""}`}
                      onClick={() => setSetupTool({ type: t, color: "w" })}
                    >
                      {GLYPH.w[t]}
                    </button>
                  ))}
                </div>
                <div className="section-label">Black pieces</div>
                <div className="setup-palette-row">
                  {["k", "q", "r", "b", "n", "p"].map((t) => (
                    <button
                      key={"b" + t}
                      className={`setup-piece-btn ${setupTool && setupTool.color === "b" && setupTool.type === t ? "active" : ""}`}
                      onClick={() => setSetupTool({ type: t, color: "b" })}
                    >
                      {GLYPH.b[t]}
                    </button>
                  ))}
                </div>
                <button
                  className={`setup-eraser-btn ${!setupTool ? "active" : ""}`}
                  onClick={() => setSetupTool(null)}
                >
                  Eraser (click square to remove)
                </button>

                <div className="section-label">Side to move first</div>
                <div className="setup-turn-row">
                  <button className={`btn ${setupTurn === "w" ? "active" : ""}`} onClick={() => setSetupTurn("w")}>White</button>
                  <button className={`btn ${setupTurn === "b" ? "active" : ""}`} onClick={() => setSetupTurn("b")}>Black</button>
                </div>

                <div className="btn-row">
                  <button className="btn" onClick={setupStandardBoard}>Standard setup</button>
                  <button className="btn" onClick={setupClearBoard}>Clear board</button>
                </div>
              </div>
            </div>

            {setupError && <div className="import-error">{setupError}</div>}

            <div className="btn-row" style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={startFromSetup}>Start game from here</button>
              <button className="btn" onClick={() => setSetupOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Auth Modal */}
      {authOpen && (
        <div className="modal-backdrop" onClick={() => setAuthOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <Auth onLogin={handleLoginSuccess} />
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => setAuthOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Saved Online Games Modal */}
      {gamesOpen && (
        <div className="modal-backdrop" onClick={() => setGamesOpen(false)}>
          <div className="modal" style={{ minWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <h3>Saved online games</h3>
            {gamesError && <div className="import-error">{gamesError}</div>}
            <div className="library-list">
              {gamesList.length === 0 && (
                <div className="library-row"><span className="library-row-meta">No saved games yet.</span></div>
              )}
              {gamesList.map((g) => (
                <div className="library-row" key={g.id} style={{ flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    {editingGame && editingGame.id === g.id ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <input
                          className="games-input"
                          placeholder="Title"
                          value={editingGame.title}
                          onChange={(e) => setEditingGame({ ...editingGame, title: e.target.value })}
                        />
                        <input
                          className="games-input"
                          placeholder="Notes"
                          value={editingGame.notes}
                          onChange={(e) => setEditingGame({ ...editingGame, notes: e.target.value })}
                        />
                      </div>
                    ) : (
                      <>
                        <div className="library-row-title">{g.title || `${g.white_username} vs ${g.black_username}`}</div>
                        <div className="library-row-meta">
                          #{g.id} · {new Date(g.started_at).toLocaleString()} · {g.result}
                          {g.winner_username ? ` · won by ${g.winner_username}` : ""}
                        </div>
                        {g.notes && <div className="library-row-meta">{g.notes}</div>}
                      </>
                    )}
                  </div>
                  <div className="btn-row" style={{ margin: 0 }}>
                    {editingGame && editingGame.id === g.id ? (
                      <>
                        <button className="btn primary" onClick={saveEditedGame}>Save</button>
                        <button className="btn" onClick={() => setEditingGame(null)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button className="btn primary" onClick={() => viewSavedGame(g.id)}>View</button>
                        <button className="btn" onClick={() => exportSavedGame(g.id)}>Export JSON</button>
                        <button className="btn" onClick={() => setEditingGame({ id: g.id, title: g.title || "", notes: g.notes || "" })}>Edit</button>
                        <button className="btn" onClick={() => deleteSavedGame(g.id)}>Delete</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {gameExportText && (
              <>
                <div className="section-label">chessGames.json entry</div>
                <textarea className="export-area" readOnly value={gameExportText} />
              </>
            )}
            <div className="btn-row">
              <button className="btn" onClick={fetchGames}>Refresh</button>
              <button className="btn" onClick={() => setGamesOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Lightweight Minimax Chess Engine (~1400 ELO)                           */
/* ---------------------------------------------------------------------- */

const PIECE_VALS = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

const PST = {
  p: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [50, 50, 50, 50, 50, 50, 50, 50],
    [10, 10, 20, 30, 30, 20, 10, 10],
    [5, 5, 10, 25, 25, 10, 5, 5],
    [0, 0, 0, 20, 20, 0, 0, 0],
    [5, -5, -10, 0, 0, -10, -5, 5],
    [5, 10, 10, -20, -20, 10, 10, 5],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ],
  n: [
    [-50, -40, -30, -30, -30, -30, -40, -50],
    [-40, -20, 0, 5, 5, 0, -20, -40],
    [-30, 5, 10, 15, 15, 10, 5, -30],
    [-30, 0, 15, 20, 20, 15, 0, -30],
    [-30, 5, 15, 20, 20, 15, 5, -30],
    [-30, 0, 10, 15, 15, 10, 0, -30],
    [-40, -20, 0, 0, 0, 0, -20, -40],
    [-50, -40, -30, -30, -30, -30, -40, -50],
  ],
  b: [
    [-20, -10, -10, -10, -10, -10, -10, -20],
    [-10, 5, 0, 0, 0, 0, 5, -10],
    [-10, 10, 10, 10, 10, 10, 10, -10],
    [-10, 0, 10, 10, 10, 10, 0, -10],
    [-10, 5, 5, 10, 10, 5, 5, -10],
    [-10, 0, 5, 10, 10, 5, 0, -10],
    [-10, 0, 0, 0, 0, 0, 0, -10],
    [-20, -10, -10, -10, -10, -10, -10, -20],
  ],
  r: [
    [0, 0, 0, 5, 5, 0, 0, 0],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [5, 10, 10, 10, 10, 10, 10, 5],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ],
  q: [
    [-20, -10, -10, -5, -5, -10, -10, -20],
    [-10, 0, 5, 0, 0, 0, 0, -10],
    [-10, 5, 5, 5, 5, 5, 0, -10],
    [0, 0, 5, 5, 5, 5, 0, -5],
    [-5, 0, 5, 5, 5, 5, 0, -5],
    [-10, 0, 5, 5, 5, 5, 0, -10],
    [-10, 0, 0, 0, 0, 0, 0, -10],
    [-20, -10, -10, -5, -5, -10, -10, -20],
  ],
  k: [
    [20, 30, 10, 0, 0, 10, 30, 20],
    [20, 20, 0, 0, 0, 0, 20, 20],
    [-10, -20, -20, -20, -20, -20, -20, -10],
    [-20, -30, -30, -40, -40, -30, -30, -20],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
  ],
};

function evaluateGame(game) {
  let score = 0;
  const board = game.board();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) continue;
      const val = PIECE_VALS[piece.type] || 0;
      const pstVal =
        PST[piece.type] && PST[piece.type][piece.color === "w" ? r : 7 - r]
          ? PST[piece.type][piece.color === "w" ? r : 7 - r][c]
          : 0;
      const total = val + pstVal;
      score += piece.color === "w" ? total : -total;
    }
  }
  return score;
}

function minimaxChess(game, depth, alpha, beta, isMaximizing) {
  if (game.isCheckmate()) return { score: isMaximizing ? -99999 + (3 - depth) : 99999 - (3 - depth) };
  if (game.isDraw()) return { score: 0 };
  if (depth === 0) return { score: evaluateGame(game) };

  const legalMoves = game.moves({ verbose: true });
  let bestMove = legalMoves[Math.floor(Math.random() * legalMoves.length)];

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const m of legalMoves) {
      game.move(m);
      const evaluation = minimaxChess(game, depth - 1, alpha, beta, false).score;
      game.undo();
      if (evaluation > maxEval) {
        maxEval = evaluation;
        bestMove = m;
      }
      alpha = Math.max(alpha, evaluation);
      if (beta <= alpha) break;
    }
    return { score: maxEval, move: bestMove };
  } else {
    let minEval = Infinity;
    for (const m of legalMoves) {
      game.move(m);
      const evaluation = minimaxChess(game, depth - 1, alpha, beta, true).score;
      game.undo();
      if (evaluation < minEval) {
        minEval = evaluation;
        bestMove = m;
      }
      beta = Math.min(beta, evaluation);
      if (beta <= alpha) break;
    }
    return { score: minEval, move: bestMove };
  }
}

/* ---------------------------------------------------------------------- */
/* Auth Component                                                         */
/* ---------------------------------------------------------------------- */

function Auth({ onLogin }) {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errorData, setErrorData] = useState(null); // stores { text, isFull }

  const handleSubmit = async (e) => {
    e.preventDefault();
    const endpoint = isRegister ? "/register" : "/login";
    setErrorData(null);

    try {
      const res = await axios.post(`${CHESS_BACKEND_URL}${endpoint}`, { username, password });
      if (!isRegister) {
        localStorage.setItem("Ch355_token", res.data.token);
        onLogin(res.data.token);
      } else {
        setIsRegister(false);
        setErrorData({ text: "Account created! Please log in.", isSuccess: true });
      }
    } catch (err) {
      const respData = err.response?.data;
      if (respData?.isFull) {
        // Triggered when 30 user limit is reached!
        setErrorData({
          isFull: true,
          text: respData.error,
        });
      } else {
        setErrorData({
          text: `Status: ${err.response?.status || "None"} | ${respData?.error || err.message}`,
        });
      }
    }
  };

  return (
    <div style={{ marginTop: "6px" }}>
      <h3 style={{ margin: "0 0 12px", fontFamily: "Fraunces, serif" }}>
        {isRegister ? "Register" : "Login"} — Chess Ledger
      </h3>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          className="games-input"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <input
          className="games-input"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit" className="btn primary" style={{ marginTop: 4 }}>
          {isRegister ? "Sign Up" : "Log In"}
        </button>
      </form>

      {/* Capacity & Error Display */}
      {errorData && (
        <div
          style={{
            color: errorData.isSuccess ? "var(--felt)" : "var(--oxblood)",
            fontSize: 12,
            marginTop: 10,
            lineHeight: 1.5,
            padding: "8px 10px",
            background: errorData.isFull ? "#fef2f2" : "transparent",
            borderRadius: 4,
            border: errorData.isFull ? "1px solid var(--oxblood)" : "none",
          }}
        >
          {errorData.isFull ? (
            <div>
              <strong>🔒 Registration Capacity Reached!</strong>
              <p style={{ margin: "4px 0 0" }}>
                We have reached our 30-player limit. You can clone the project and run your own server from{" "}
                <a
                  href="https://github.com/YOUR_GITHUB_USERNAME/Ch355"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--walnut)", textDecoration: "underline", fontWeight: 700 }}
                >
                  our GitHub repository
                </a>.
              </p>
            </div>
          ) : (
            <p style={{ margin: 0 }}>{errorData.text}</p>
          )}
        </div>
      )}

      <p
        onClick={() => {
          setIsRegister(!isRegister);
          setErrorData(null);
        }}
        style={{ cursor: "pointer", color: "var(--felt)", fontSize: 12, marginTop: 12 }}
      >
        {isRegister ? "Already have an account? Log In" : "Need an account? Register"}
      </p>
    </div>
  );
}

