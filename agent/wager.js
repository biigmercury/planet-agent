const { ethers } = require("ethers");
const { log } = require("./logger");

require("dotenv").config();

const WAGER_CREATED_TOPIC = ethers.id("WagerCreated(uint256,bytes32,address,uint256,bytes32)");
const ZERO_ADDRESS = ethers.ZeroAddress;

function getProvider() {
  return new ethers.JsonRpcProvider("https://mainnet.base.org");
}

function getContract(provider) {
  const abi = require("../contracts/abi.json");
  return new ethers.Contract(process.env.CONTRACT_ADDRESS, abi, provider);
}

function bytes32ToText(value) {
  try {
    return ethers.decodeBytes32String(value);
  } catch {
    return value;
  }
}

async function getWagerDetails(wagerId, contractInstance, eventMeta = {}) {
  try {
    const provider = getProvider();
    const contract = contractInstance || getContract(provider);
    const wager = await contract.wagers(wagerId);

    // Support both named and positional struct outputs
    const player1 = wager.player1 ?? wager[0];
    const player2 = wager.player2 ?? wager[1];
    const amountRaw = wager.amount ?? wager[2];
    const gameKey = wager.gameKey ?? wager[3];
    const matchIdOnchain = wager.matchId ?? wager[4];
    const claimed = wager.claimed ?? wager[5];
    const cancelled = wager.cancelled ?? wager[6];
    const createdAt = wager.createdAt ?? wager[7];

    const finalMatchId = eventMeta.matchId || matchIdOnchain;

    return {
      wagerId: wagerId.toString(),
      player1,
      player2,
      amount: ethers.formatUnits(amountRaw, 6),
      amountRaw: amountRaw.toString(),
      gameKey,
      gameKeyText: bytes32ToText(gameKey),
      matchId: finalMatchId,
      matchIdText: bytes32ToText(finalMatchId),
      claimed: Boolean(claimed),
      cancelled: Boolean(cancelled),
      createdAt: createdAt?.toString?.() || String(createdAt || ""),
      eventPlayer1: eventMeta.player1,
    };
  } catch (err) {
    log("error", `Failed to read wager ${wagerId}`, { error: err.message });
    return null;
  }
}

function isOpen(wager) {
  if (!wager) return false;
  if (wager.claimed) return false;
  if (wager.cancelled) return false;
  if (!wager.player1 || wager.player1 === ZERO_ADDRESS) return false;
  if (!wager.player2 || wager.player2 === ZERO_ADDRESS) return false;
  return true;
}

async function getOpenWagers() {
  const provider = getProvider();
  const contract = getContract(provider);

  const currentBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - 2000);

  log("scan", "Scanning WagerCreated events from block " + fromBlock + " to " + currentBlock);

  const filter = {
    address: process.env.CONTRACT_ADDRESS,
    topics: [WAGER_CREATED_TOPIC],
    fromBlock,
    toBlock: currentBlock,
  };

  const eventLogs = await provider.getLogs(filter);
  log("scan", `Found ${eventLogs.length} WagerCreated event(s)`);

  const openWagers = [];

  for (const eventLog of eventLogs) {
    try {
      // Decode manually using verified on-chain event signature
      // WagerCreated(uint256 indexed wagerId, bytes32 indexed matchId, address indexed player1, uint256 amount, bytes32 gameKey)
      const wagerId = BigInt(eventLog.topics[1]);
      const matchId = eventLog.topics[2];
      const player1 = "0x" + eventLog.topics[3].slice(26);

      const wager = await getWagerDetails(wagerId, contract, { matchId, player1 });
      if (isOpen(wager)) openWagers.push(wager);
    } catch (err) {
      log("error", "Failed to parse wager event", { error: err.message });
    }
  }

  return openWagers;
}

module.exports = { getOpenWagers, getWagerDetails, isOpen };
