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

  log("info", "Authorization received. Submitting payout to blockchain...", { wagerId, winnerAddress, deadline });
  const tx = await contract.claimWithAttestation(
    BigInt(wagerId),
    winnerAddress,
    BigInt(deadline),
    signature
  );
  const rcpt = await tx.wait();
  log("info", "✅ Payout confirmed on-chain. Winner has been paid.", { wagerId, txHash: rcpt.hash, blockNumber: rcpt.blockNumber });
}

async function claimDraw(contract, wagerId) {
  const att = await getDrawAttestation(wagerId);
  const signature = att.signature;
  const deadline = att.deadline;

  await ensureTxGuardrails(contract, wagerId, null, deadline, signature, true);

  log("info", "Authorization received for a draw. Submitting draw settlement to blockchain...", { wagerId, deadline });
  const tx = await contract.claimDraw(BigInt(wagerId), BigInt(deadline), signature);
  const rcpt = await tx.wait();
  log("info", "✅ Draw settlement confirmed on-chain.", { wagerId, txHash: rcpt.hash, blockNumber: rcpt.blockNumber });
}

async function processWager(contract, wager) {
  const wagerId = wager.wagerId;
  const matchId = wager.matchIdText || wager.matchId;

  log("info", `Wager #${wagerId} detected — players have both joined. Checking match outcome...`, {
    matchId,
    player1: wager.player1,
    player2: wager.player2,
    amount: wager.amount,
  });

  const result = await getMatchResult(matchId);
  const wagerMatch = result?.wagerMatch;

  if (!wagerMatch) {
    log("info", "No match result available yet from Planet Games. Will check again shortly.", { wagerId, matchId });
    return;
  }

  const status = wagerMatch.status;
  if (!isFinalStatus(status)) {
    log("info", "Match is still in progress. No payout action taken.", { wagerId, status });
    return;
  }

  if (isDrawStatus(status)) {
    log("info", "Match ended in a draw. Requesting draw settlement authorization from Planet Games...", { wagerId, status });
    await claimDraw(contract, wagerId);
    return;
  }

  const winner = wagerMatch.winnerAddress;
  if (!winner || !ethers.isAddress(winner)) {
    log("info", "Match is final but winner address is invalid. Skipping this wager safely.", { wagerId, status, winner });
    return;
  }

  log("info", "Match is over. Winner confirmed. Requesting payout authorization from Planet Games...", { wagerId, winner });
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
  const balanceAddress = (process.env.AGENT_WALLET_ADDRESS && ethers.isAddress(process.env.AGENT_WALLET_ADDRESS))
    ? process.env.AGENT_WALLET_ADDRESS
    : onchainAddress;
  const gasBal = await provider.getBalance(balanceAddress);

  log("info", "Planet Agent is online. Watching for open wagers on Base Mainnet...", {
    wallet: onchainAddress,
    balanceWallet: balanceAddress,
    contract: process.env.CONTRACT_ADDRESS,
    pollMs: POLL_MS,
    maxIterations: MAX_ITERATIONS,
    gasBalanceWei: gasBal.toString(),
  });

  if (gasBal === 0n) {
    log("info", "⚠️ Gas balance is zero. Claims cannot be submitted until wallet is funded with ETH for gas.", {
      balanceWallet: balanceAddress,
    });
  }

  if (process.env.AGENT_WALLET_ADDRESS && ethers.isAddress(process.env.AGENT_WALLET_ADDRESS)) {
    if (onchainAddress.toLowerCase() !== process.env.AGENT_WALLET_ADDRESS.toLowerCase()) {
      log("info", "Wallet safety check: configured wallet does not match derived signer wallet.", {
        envAddress: process.env.AGENT_WALLET_ADDRESS,
        derivedAddress: onchainAddress,
      });
    }
  }

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    log("info", `Monitoring cycle ${i}/${MAX_ITERATIONS} started.`);

    try {
      const wagers = await getOpenWagers();
      if (wagers.length === 0) {
        log("info", "Scanning blockchain for open wagers... none found yet.");
      } else {
        log("info", `Found ${wagers.length} wager(s) on-chain. Checking each one...`);
      }

      for (const wager of wagers) {
        try {
          await processWager(contract, wager);
        } catch (err) {
          log("info", "Encountered an issue while processing this wager. Will retry in the next cycle.", {
            wagerId: wager?.wagerId,
            error: err.message,
          });
        }
      }
    } catch (err) {
      log("info", "Monitoring cycle hit an RPC/backend issue. Continuing safely.", { error: err.message });
    }

    if (i < MAX_ITERATIONS) {
      await sleep(POLL_MS);
    }
  }

  log("info", "Planet Agent signing off. All wagers processed.");
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", `Shutdown signal received (${signal}). Writing final execution log...`);
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
  log("info", "Unexpected runtime exception detected. Performing safe shutdown.", { error: err.message });
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (err) => {
  log("info", "Unhandled promise rejection detected. Performing safe shutdown.", { error: err?.message || String(err) });
  shutdown("unhandledRejection");
});

run()
  .then(() => {
    writeLogs();
  })
  .catch((err) => {
    log("info", "Agent run crashed unexpectedly. Writing logs before exit.", { error: err.message });
    writeLogs();
    process.exit(1);
  });
