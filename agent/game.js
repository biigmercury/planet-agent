const { log } = require("./logger");

require("dotenv").config();

const BASE_URL = process.env.PLANET_GAMES_BACKEND_URL;
const AGENT_SECRET = process.env.AGENT_API_SECRET;

function assertConfig() {
  if (!BASE_URL) throw new Error("Missing PLANET_GAMES_BACKEND_URL");
  if (!AGENT_SECRET) throw new Error("Missing AGENT_API_SECRET");
}

function headers(extra = {}) {
  return {
    "content-type": "application/json",
    "x-agent-secret": AGENT_SECRET,
    ...extra,
  };
}

async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `Invalid JSON response: ${text.slice(0, 300)}` };
  }
}

async function getMatchResult(matchId) {
  assertConfig();

  const id = String(matchId || "").trim();
  if (!id) throw new Error("matchId is required");

  const url = `${BASE_URL}/wager/match/${encodeURIComponent(id)}`;
  log("backend", "Fetching match result", { matchId: id, url });

  const res = await fetch(url, { method: "GET", headers: headers() });
  const body = await safeJson(res);

  if (!res.ok || body?.ok === false) {
    const err = body?.error || `HTTP ${res.status}`;
    throw new Error(`getMatchResult failed: ${err}`);
  }

  return body;
}

async function getWinAttestation(wagerId, winnerAddress) {
  assertConfig();

  if (!wagerId && wagerId !== 0) throw new Error("wagerId is required");
  if (!winnerAddress) throw new Error("winnerAddress is required");

  const payload = {
    wagerId: String(wagerId),
    winner: winnerAddress,
    winnerAddress,
  };

  const url = `${BASE_URL}/wager/match/attest-agent`;
  log("backend", "Requesting win attestation", payload);

  const res = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });

  const body = await safeJson(res);
  if (!res.ok || body?.ok === false) {
    const err = body?.error || `HTTP ${res.status}`;
    throw new Error(`getWinAttestation failed: ${err}`);
  }

  return body;
}

async function getDrawAttestation(wagerId) {
  assertConfig();

  if (!wagerId && wagerId !== 0) throw new Error("wagerId is required");

  const payload = { wagerId: String(wagerId) };
  const url = `${BASE_URL}/wager/match/attest-draw`;

  log("backend", "Requesting draw attestation", payload);

  const res = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });

  const body = await safeJson(res);
  if (!res.ok || body?.ok === false) {
    const err = body?.error || `HTTP ${res.status}`;
    throw new Error(`getDrawAttestation failed: ${err}`);
  }

  return body;
}

module.exports = {
  getMatchResult,
  getWinAttestation,
  getDrawAttestation,
};
