# ♟️ Chess Ledger & Engine

A vintage, parchment-styled interactive chess scoresheet, analysis board, and playback engine built with **React** and **chess.js**. Includes an integrated **~1400 ELO Minimax AI Opponent**, visual move trajectory fading, real-time checkmate detection, and game recording/exporting capabilities.

---

## ✨ Features

### 🎨 Visuals & Aesthetics
* **📜 Vintage Parchment Theme:** Warm walnut, felt greens, oxblood accents, and classic typography (*Fraunces* + *JetBrains Mono*).
* **✨ Trajectory Path Fading:** Moving pieces leave a smooth, color-fading trail along their entire route (origin, intermediate path, and settled square).
* **⏳ Floating Status & Thinking Badge:** Responsive live-status banner directly over the board, displaying live game status (*Check*, *Checkmate*, *Draw*, and *Computer is thinking…*).
### 🎞️ Move Feedback & Board Effects
* **🟩 Persistent Last-Move Highlight:** The origin and destination squares of the most recent move stay visibly tinted — not a quick flash that vanishes — so it's always clear which move was just played, even while paused waiting for a reply. Only clears when the *next* move overwrites it.
* **👻 Departure Ghost:** A fading afterimage of a piece briefly lingers on the square it just left, making rapid or auto-played moves easier to track.
* **💨 Capture Ghost:** A captured piece doesn't just vanish — it drifts, tilts, and fades away above the square where it was taken, so it's clear what was captured even at a glance.
* **➡️ Move Arrow (3D):** A brief directional arrow traces each move from its origin to destination square, fading out gradually as the position settles.
* **🔴 Glowing Check Indicator:** The King's square pulses in bright glowing red whenever placed in check or checkmate.
* **🤴 Checkmated King:** The losing King's piece visibly topples over (90°) the moment checkmate is delivered.
* **🔃 Flip Board:** View the board from either side — flips which color sits at the bottom without affecting game state, move history, or any other feature.


---

### 🤖 Single-Player vs. Computer Engine (~1400 ELO)
* **🧠 Minimax with Alpha-Beta Pruning:** Evaluates legal moves 3 half-moves deep with material evaluation and center-control positional bonuses.
* **⚪ / ⚫ Play as White or Black:** Toggle whether the computer plays as Black or makes the opening move as White.
* **🛡️ 100% Legal Move Guarantee:** Backed by standard FIDE rules with pin validation, castling, en-passant, and promotion handling.
* **↩️ Smart Take Back:** Undoes both the AI's move and your move in a single click, instantly rewinding the game to your turn without getting stuck.

---

### 🌐 Real-Time Online Multiplayer & Coordination
* **⚡ Live Socket Synchronization:** Full two-player and spectator multiplayer powered by **Socket.IO** with server-authoritative move validation and synchronized chess clocks.
* **⏳ Matchmaking & Closure Banner:** A dedicated live-status banner shows whether a match is in progress or waiting for an opponent. Includes a one-click **📋 Copy Invite Link** button so Player 1 can easily share the room URL.
* **👥 Room Presence & "Who's Online":** Modal displaying real-time connection status (🟢 Connected / 🔴 Disconnected) alongside who is seated as **White (Player 1)**, **Black (Player 2)**, and who is currently **Spectating**.
* **💬 In-Game Chat & Quick Presets:** Integrated, collapsible chat widget with an unread badge counter, custom text messaging, and quick-broadcast chips (*"👋 Hello!"*, *"👍 Good luck!"*, *"⏳ One moment"*, *"👏 Nice move!"*, *"🤝 Good game!"*).
* **🚪 Clean Departure & Role Handoff:** Leaving online play or logging out immediately vacates the seat (`quitGame`), preventing ghost players from blocking seats for others.
* **📚 Saved Online Games:** Authenticated users can review, edit notes, view, and export past online games to JSON format.

---

### 📋 Scoresheet Ledger & Library
* **📖 Move-by-Move Record:** Automatically records moves in classical notation (e.g. `e2-e4`, `e4xd5`, `O-O`).
* **✍️ Move Annotations:** Add custom notes to any move, with featured annotations displayed in the sticky top banner.
* **🎞️ Automated Playback Engine:**
  * **▶ Run / ⏸ Pause / ■ Stop / ⟲ Reset**
  * **Infinite Loop mode** & **Blink animation**
  * **Adjustable Pause Interval** (1234 ms – 25555 ms)
  * **⏸️ Closure Pause:** When auto-run (or a loop) reaches the final recorded move — checkmate, resignation, or wherever the game record ends — playback holds on that position for a few extra seconds before looping back to move 0 or stopping, rather than snapping through it at the normal per-move pace.
  * **Auto-Next/Prev** 🔁 — with Loop enabled, automatically advances through the library by Id when a game finishes, then reverses direction at the last Id and steps back down, bouncing indefinitely.
  * **📜 Per-Row Note Auto-Scroll:** During Run, once a move-pair finishes and play advances into the next pair's White move, that finished pair's own typed note (in the scoresheet's *Annot* column) auto-scrolls to reveal any text that overflowed its box — no manual scrolling needed to catch a long note before it's out of view.
  * **⏩ Fastmove:** Step forward *N* moves at once — plays each intermediate move in quick (~250ms) blitz succession rather than teleporting straight to the target, so you still see what happened along the way.
* **📚 Game Library:** Pre-seeded games with import/export support for custom game collections.

---

### 💾 Export & Download Options
* **💾 Download PGN:** One-click export to standard `.pgn` format, ready to import and analyze on **Chess.com** or **Lichess**.
* **💾 Download JSON:** Save the complete state (metadata + moves + annotations) to reload into your local library anytime.
* **📋 Copy Payload:** Quick-copy raw CHSGM / MOVES structured JSON to clipboard.

---

## 🚀 Getting Started

### 1. Prerequisites
Ensure you have [Node.js](https://nodejs.org/) (v16 or newer) installed.

### 2. Installation
Clone the repository and install the dependencies:

```bash
git clone https://github.com/manjilj/chess-ledger.git
cd chess-ledger
npm install
```

### 3. Run it

```bash
npm start
```

Opens the app at `http://localhost:3000`.

---

## 🎮 Playing Against the Computer

The AI opponent is off by default — every fresh load or **New Game** starts as a
two-human free-play board until you turn it on. Sequence:

1. **New Game** — clears the board back to the standard starting position and
   drops you into free play (skip this if you're already mid-game and just
   want to switch modes).
2. **👤 vs.🤖 → 👤 vs.🤖 (ON)** — click this button to turn the AI
   on. A second button, **AI plays: …**, appears next to it once it's on.
3. **AI plays: White (First) / Black (Second)** — click this to flip which
   side the computer takes:
   * **AI plays: Black (Second)** *(the default)* — you're White and move
     first; after your move the **⏳ Computer is thinking…** message appears
     briefly and the AI replies on its own.
   * **AI plays: White (First)** — the computer immediately plays White's
     opening move for you (same brief "thinking" delay), then it's your turn
     as Black.
4. **Make your moves** the normal way — click a piece then its destination
   square, or drag-and-drop. Illegal moves are rejected automatically; the
   AI only ever replies once it's actually its turn.
5. **↩ Take Back Move** — undoes a mistake. With the AI on, one click removes
   *both* the computer's reply and your move before it, so you land back on
   your own turn instead of getting stuck answering the same AI move twice.
6. Toggle **👤 vs.🤖** off any time to go back to two-human play — the
   on/off state and which color the AI plays both carry over the next time
   you click **New Game**, so you don't have to re-pick them each game.

You can also start the AI from a **custom position**: use **Set Up Position…**
(see below) to place whatever pieces you want and pick who moves first, click
**Start game from here**, then turn on **👤 vs.🤖** — the order doesn't
matter, both can be set up in either sequence before you make your first move.

---

## 🌐 Playing Online

1. Click **🌐 Play Online** (or **🔑 Login / Register** if not yet logged in). 
   * **Local Testing / Sandbox Tip:** Because authentication tokens are stored in your browser's `localStorage`, open the second player in an **Incognito / Private Window** (or a different browser such as Firefox / Edge). Create and log into two separate accounts (e.g., `PlayerOne` and `PlayerTwo`) so both sessions connect independently without overwriting each other's credentials.
2. Once connected, your role is assigned automatically:
   * **Player 1 (White):** First player to enter; a banner prompts with a **Copy Invite Link** button to send to an opponent.
   * **Player 2 (Black):** The second player to join takes Black and the match begins.
   * **Spectator:** Any subsequent players enter as spectators and can watch with live clocks. If a seat opens up, click **🎮 Join Game**.
3. Use **👥 Who's Online** at any time to verify who is connected and seated.
4. Open **💬 Game Chat** to send quick preset phrases or custom chat messages to everyone in the room.
5. Click **🌐 Online (ON) — Leave** or **Quit Playing** to cleanly surrender/vacate your seat.

---

## 🧩 Setting Up a Custom Position

Click **Set Up Position…** to open the board editor instead of always starting
from the standard array:

1. Pick a piece from the **White pieces** / **Black pieces** palette.
2. Click a square on the editor board to place it there (clicking an occupied
   square overwrites whatever was on it). Drag pieces already placed to move
   them elsewhere on the board.
3. Select the **Eraser** tool, then click a square to remove a piece.
4. **Standard setup** resets the editor to the normal starting array;
   **Clear board** empties it completely.
5. Pick **White** or **Black** under *Side to move first*.
6. **Start game from here** validates that both a white and a black king are
   present, then loads the position into free play with the side you chose
   to move first (works with 👤 vs.🤖 either on or off).

Handy for drilling specific endgames — e.g. king + rook vs. king + rook —
without playing through an entire game to reach them.

---

## 🧊 3D Board Mode

Toggle **🟫 2D Board / 🧊 3D Board ** to switch the board into an interactive
3D scene, rendered with [Three.js](https://threejs.org/) via
[@react-three/fiber](https://github.com/pmndrs/react-three-fiber).

* **🖱️ Orbit Camera:** Click-and-drag to rotate around the board, scroll to
  zoom, right-click & up/down drag to move board up & down. Movement is still click-to-move (piece, then destination square) —
  drag-and-drop isn't supported in 3D mode.
* **🪵 Real 3D Pieces:** A full Staunton-style set in light and dark wood,
  correctly scaled and oriented per piece type.
* **✨ Effects, reimagined in 3D:** The departure ghost, capture ghost, and
  check/checkmate indicators from the 2D board all have 3D-native
  equivalents — fading and drifting through actual 3D space rather than
  flat CSS transforms — plus a settling outline on the square a piece just
  moved to, and a brief bright flash the instant a piece starts to move or
  gets captured, to draw the eye before the fade takes over.
* **💡 Lighting:** A simple ambient + directional light setup, tuned so dark
  pieces stay clearly distinct from the board rather than blending into
  shadow.

3D mode is entirely optional and additive — it reads the exact same game
state as the 2D board (whose move logic, rules engine, and AI are completely
unmodified) and never diverges from it; you can switch back and forth mid-game freely.

---
## 🤖 Set AI Key for commentary

Move commentary is generated by an LLM call to Groq's API, so you'll need a
free Groq API key for that feature to work (the app still runs fine without
it — commentary just falls back to plain "White plays e4" style text).

1. Sign up / log in at [console.groq.com](https://console.groq.com).
2. Go to **API Keys** and create a new key (starts with `gsk_...`).
3. Copy the key and paste it in the input when shown when '🤖 Set AI Key' is clicked.
---
## 🔧⚙ Environment Variables

In the project root (same folder as `package.json`), create a file named
   `.env` (Example code is in `.env.example`):


DISABLE_ESLINT_PLUGIN=true

GENERATE_SOURCEMAP=false

DB_FILE=./ch355.db

JWT_SECRET=change_to_a_long_random_string

GITHUB_REPO_URL=https://github.com/manjilj/Ch355

REACT_APP_CHESS_BACKEND_URL=http://localhost:8083

PORT=8083

REACT_APP_CHESS_BACKEND_URL=http://localhost:8083

ALLOWED_ORIGINS=http://localhost:3001,http://localhost:3002

CHESS_TIME_MS=3600000

---

## 📜 Licenses & Third-Party Credits

This project itself is licensed under **[MIT]**. 

### Code dependencies
All are MIT-licensed, open-source libraries:
* [React](https://react.dev/) & [react-dom](https://react.dev/)
* [chess.js](https://github.com/jhlywa/chess.js) — chess rules engine
* [three.js](https://threejs.org/), [@react-three/fiber](https://github.com/pmndrs/react-three-fiber), [@react-three/drei](https://github.com/pmndrs/drei), [@react-spring/three](https://github.com/pmndrs/react-spring) — 3D board mode

### 3D Assets
The 3D chess piece models are from **[3D Chess Pieces Pack by Polyy.AI](https://polyyai.itch.io/3d-chess-pieces-pack)**,
released under **[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)**
(public domain dedication — free for commercial use, modification, and
remixing, no attribution legally required). Credited here anyway as good
practice. Note: these models are tagged by their author as AI-assisted in
their creation; this doesn't affect their CC0 licensing or your right to use
them, but is disclosed here for transparency.

### Move Commentary
AI-generated move commentary is powered by the [Groq API](https://groq.com/)
(see **Environment Variables** above) — a paid third-party service outside
this project's own license; usage is subject to Groq's own terms.

🥂Cheers!