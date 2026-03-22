const { ethers } = require("ethers");
const { getOpenWagers, getWagerDetails } = require("./wager");
const { getMatchResult, getWinAttestation, getDrawAttestation } = require("./game");
const { log, writeLogs } = require("./logger");

require("dotenv").config();

const POLL_MS = 15_000;
const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS || 10);
const ZERO_ADDRESS = ethers.ZeroAddress;

function getProvider() {
  return new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
}

function getSigner(provider) {
  if (!process.env.AGENT_PRIVATE_KEY) throw new Error("Missing AGENT_PRIVATE_KEY");
  return new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
}

function getContract(signerOrProvider) {
  const abi = require("../contracts/abi.json");
  return new ethers.Contract(process.env.CONTRACT_ADDRESS, abi, signerOrProvider);
}

function isDrawStatus(status) {
  const s = String(status || "").toLowerCase();
  return s.includes("draw") || s.includes("tie") || s === "drew";
}

function isFinalStatus(status) {
  const s = String(status || "").toLowerCase();
  return ["completed", "complete", "settled", "closed", "final", "finished", "draw", "tie"].some((k) => s.includes(k));
}

function assertHexSig(signature) {
  if (!ethers.isHexString(signature)) throw new Error("Attestation signature is not hex bytes");
  if (ethers.dataLength(signature) < 64) throw new Error("Attestation signature too short");
}

async function ensureTxGuardrails(contract, wagerId, winner, deadline, signature, isDraw) {
  if (!process.env.CONTRACT_ADDRESS || !ethers.isAddress(process.env.CONTRACT_ADDRESS)) {
    throw new Error("Invalid CONTRACT_ADDRESS");
  }

  if (!wagerId && wagerId !== 0) throw new Error("Missing wagerId");
  if (!deadline) throw new Error("Missing deadline");
  if (Number(deadline) <= Math.floor(Date.now() / 1000) + 5) throw new Error("Attestation deadline is expired/too close");

  assertHexSig(signature);

  const fresh = await getWagerDetails(wagerId, contract);
  if (!fresh) throw new Error("Wager not readable");
  if (fresh.claimed) throw new Error("Wager already claimed");
  if (fresh.cancelled) throw new Error("Wager already cancelled");
  if (!fresh.player2 || fresh.player2 === ZERO_ADDRESS) throw new Error("Wager not joined by player2");

  if (!isDraw) {
    if (!winner || !ethers.isAddress(winner)) throw new Error("Invalid winner address");
    const w = winner.toLowerCase();
    if (w !== fresh.player1.toLowerCase() && w !== fresh.player2.toLowerCase()) {
      throw new Error("Winner is not a participant in the wager");
    }

    await contract.claimWithAttestation.staticCall(
      BigInt(wagerId),
      winner,
      BigInt(deadline),
      signature
    );
  } else {
    await contract.claimDraw.staticCall(
      BigInt(wagerId),
      BigInt(deadline),
      signature
    );
  }
}

async function claimWin(contract, wagerId, winnerAddress) {
  const att = await getWinAttestation(wagerId, winnerAddress);
  const signature = att.signature;
  const deadline = att.deadline;

  await ensureTxGuardrails(contract, wagerId, winnerAddress, deadline, signature, false);

  log("tx", "Submitting claimWithAttestation", { wagerId, winnerAddress, deadline });
  const tx = await contract.claimWithAttestation(
    BigInt(wagerId),
    winnerAddress,
    BigInt(deadline),
    signature
  );
  const rcpt = await tx.wait();
  log("tx", "claimWithAttestation confirmed", { wagerId, txHash: rcpt.hash, blockNumber: rcpt.blockNumber });
}

async function claimDraw(contract, wagerId) {
  const att = await getDrawAttestation(wagerId);
  const signature = att.signature;
  const deadline = att.deadline;

  await ensureTxGuardrails(contract, wagerId, null, deadline, signature, true);

  log("tx", "Submitting claimDraw", { wagerId, deadline });
  const tx = await contract.claimDraw(BigInt(wagerId), BigInt(deadline), signature);
  const rcpt = await tx.wait();
  log("tx", "claimDraw confirmed", { wagerId, txHash: rcpt.hash, blockNumber: rcpt.blockNumber });
}

async function processWager(contract, wager) {
  const wagerId = wager.wagerId;
  const matchId = wager.matchIdText || wager.matchId;

  log("decision", "Processing open wager", {
    wagerId,
    matchId,
    player1: wager.player1,
    player2: wager.player2,
    amount: wager.amount,
  });

  const result = await getMatchResult(matchId);
  const wagerMatch = result?.wagerMatch;

  if (!wagerMatch) {
    log("decision", "No wagerMatch payload yet; skipping", { wagerId, matchId });
    return;
  }

  const status = wagerMatch.status;
  if (!isFinalStatus(status)) {
    log("decision", "Match not final yet; skipping", { wagerId, status });
    return;
  }

  if (isDrawStatus(status)) {
    await claimDraw(contract, wagerId);
    return;
  }

  const winner = wagerMatch.winnerAddress;
  if (!winner || !ethers.isAddress(winner)) {
    log("decision", "Finalized match has no valid winnerAddress; skipping", { wagerId, status, winner });
    return;
  }

  await claimWin(contract, wagerId, winner);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  if (!process.env.BASE_RPC_URL) throw new Error("Missing BASE_RPC_URL");
  if (!process.env.CONTRACT_ADDRESS) throw new Error("Missing CONTRACT_ADDRESS");

  const provider = getProvider();
  const signer = getSigner(provider);
  const contract = getContract(signer);

  const onchainAddress = await signer.getAddress();
  const gasBal = await provider.getBalance(onchainAddress);

  log("startup", "planet-agent booted", {
    wallet: onchainAddress,
    contract: process.env.CONTRACT_ADDRESS,
    pollMs: POLL_MS,
    maxIterations: MAX_ITERATIONS,
    gasBalanceWei: gasBal.toString(),
  });

  if (process.env.AGENT_WALLET_ADDRESS && ethers.isAddress(process.env.AGENT_WALLET_ADDRESS)) {
    if (onchainAddress.toLowerCase() !== process.env.AGENT_WALLET_ADDRESS.toLowerCase()) {
      log("warning", "AGENT_WALLET_ADDRESS does not match derived wallet address", {
        envAddress: process.env.AGENT_WALLET_ADDRESS,
        derivedAddress: onchainAddress,
      });
    }
  }

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    log("loop", `Iteration ${i}/${MAX_ITERATIONS} started`);

    try {
      const wagers = await getOpenWagers();
      log("loop", "Open wagers fetched", { count: wagers.length });

      for (const wager of wagers) {
        try {
          await processWager(contract, wager);
        } catch (err) {
          log("error", "Failed processing wager", {
            wagerId: wager?.wagerId,
            error: err.message,
          });
        }
      }
    } catch (err) {
      log("error", "Loop iteration failed", { error: err.message });
    }

    if (i < MAX_ITERATIONS) {
      await sleep(POLL_MS);
    }
  }

  log("shutdown", "Run complete");
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown", `Received ${signal}`);
  try {
    writeLogs();
  } catch (err) {
    console.error("Failed to write logs", err);
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  log("fatal", "uncaughtException", { error: err.message });
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (err) => {
  log("fatal", "unhandledRejection", { error: err?.message || String(err) });
  shutdown("unhandledRejection");
});

run()
  .then(() => {
    writeLogs();
  })
  .catch((err) => {
    log("fatal", "Agent crashed", { error: err.message });
    writeLogs();
    process.exit(1);
  });
