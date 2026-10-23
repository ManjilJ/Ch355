// chessCommentator.js
import { Chess } from "chess.js";

const RAW_KEY =
  process.env.REACT_APP_AI_API_KEY ||
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_AI_API_KEY) ||
  "";

const AI_API_KEY = RAW_KEY ? RAW_KEY.trim() : "";

// Cache the active model once discovered so we don't query /models every time
let activeModelCache = null;

/**
 * Automatically discovers which model is currently live on your Groq account
 */
async function getActiveModel() {
  if (activeModelCache) return activeModelCache;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${AI_API_KEY}` },
    });
    if (res.ok) {
      const data = await res.json();
      // Find a current text/chat model (prefer llama or gemma or deepseek)
      const chatModels = data.data.filter(
        (m) =>
          !m.id.includes("whisper") &&
          !m.id.includes("guard") &&
          !m.id.includes("embed")
      );
      if (chatModels.length > 0) {
        activeModelCache = chatModels[0].id;
        console.log("✅ Auto-discovered active Groq model:", activeModelCache);
        return activeModelCache;
      }
    }
  } catch (err) {
    console.error("Could not fetch active models list:", err);
  }

  // Fallback to currently supported defaults
  return "llama-3.3-70b-versatile";
}

/**
 * Generates a short Grandmaster-style commentary line for one move.
 *
 * @param {Array} pliesList - full move history up to and including currentPly
 * @param {Object} currentPly - the move just played ({ from, to, promotion, pieceColor, ... })
 * @param {string} [startFen] - FEN of the game's actual starting position.
 *   Pass this whenever the game may not have started from the standard
 *   array (e.g. a custom Setup Position) — without it, the board used to
 *   build the FEN sent to the AI defaults to the standard starting
 *   position, which caused the AI to "see" pieces (pawns, etc.) that were
 *   never actually on the board, and comment on impossible moves as a
 *   result.
 */
export async function generateAICommentary(pliesList, currentPly, startFen) {
  if (!currentPly || !currentPly.from || !currentPly.to) return "";

  const mover = currentPly.pieceColor === "w" ? "White" : "Black";

  if (!AI_API_KEY) {
    console.warn("❌ AI_API_KEY is missing from .env!");
    return `${mover} plays ${currentPly.from}-${currentPly.to}.`;
  }

  // 1. Rebuild board state for FEN and SAN move notation, starting from the
  //    actual game's starting position (custom Setup Position included),
  //    not always the standard array.
  let game;
  try {
    game = startFen ? new Chess(startFen) : new Chess();
  } catch (err) {
    console.warn("Commentary: invalid startFen, falling back to standard start:", err);
    game = new Chess();
  }

  let lastSan = "";
  for (let i = 0; i < pliesList.length; i++) {
    try {
      const res = game.move({
        from: pliesList[i].from,
        to: pliesList[i].to,
        promotion: pliesList[i].promotion || undefined,
      });
      if (i === pliesList.length - 1 && res) {
        lastSan = res.san;
      }
    } catch (_) { }
  }

  // Plain, honest fallback text — used any time we don't have a usable
  // AI-generated line (a request failure, or a reasoning model that burned
  // its token budget on <think>...</think> and left nothing after it).
  // Prefers real SAN (e.g. "e4") once we have it, over raw squares.
  const plainFallback = `${mover} plays ${lastSan || `${currentPly.from}-${currentPly.to}`}.`;

  const fen = game.fen();
  const moveNumber = Math.ceil(pliesList.length / 2);

  // 2. Discover the exact live model for your account
  const modelToUse = await getActiveModel();

  const systemPrompt = `You are a Grandmaster chess commentator in the style of Irving Chernev.
Explain the strategic purpose, opening ideas, tactical consequences, threats, or mistakes of the move.
Rules:
1. Write strictly 1 or 2 concise, insightful sentences.
2. Focus on WHY the move was played.
3. If it's a recognized opening, name the strategic concept.
4. If it attacks, restricts, defends, or blunders, explain the concrete consequence.
5. Do NOT include move number prefixes or quotation marks.`;

  const userPrompt = `Move ${moveNumber}: ${mover} plays ${lastSan || currentPly.from + "-" + currentPly.to}.
Board FEN: ${fen}`;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: modelToUse,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.6,
        max_tokens: 80,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      if (data.choices && data.choices[0]?.message?.content) {
        // Strip any <think>...</think> block a reasoning model might emit —
        // whether it closed normally or got cut off mid-thought by
        // max_tokens (in which case there's no closing tag at all).
        const cleaned = data.choices[0].message.content
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .replace(/<think>[\s\S]*$/gi, "")
          .trim();
        if (cleaned) return cleaned;
        console.warn(`Model ${modelToUse} returned only reasoning, no final answer — using plain fallback.`);
      }
    } else {
      const errText = await response.text();
      console.error(`❌ Groq Error with model ${modelToUse}:`, errText);
    }
  } catch (err) {
    console.error("AI Fetch Error:", err);
  }

  return plainFallback;
}

export const generateTacticalCommentary = generateAICommentary;

export function getApiKey() {
  if (typeof window !== "undefined") {
    const saved = localStorage.getItem("user_groq_key");
    if (saved && saved.trim()) return saved.trim();
  }
  return process.env.REACT_APP_AI_API_KEY || "";
}

export function saveApiKey(key) {
  if (typeof window !== "undefined") {
    if (key && key.trim()) {
      localStorage.setItem("user_groq_key", key.trim());
    } else {
      localStorage.removeItem("user_groq_key");
    }
  }
}