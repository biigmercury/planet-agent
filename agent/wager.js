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

async function getWagerDetails(wagerId, contractInstance) {
  try {
    const provider = getProvider();
    const contract = contractInstance || getContract(provider);
    const wager = await contract.wagers(wagerId);

    return {
      wagerId: wagerId.toString(),
      player1: wager.player1,
      player2: wager.player2,
      amount: ethers.formatUnits(wager.amount, 6),
      amountRaw: wager.amount.toString(),
      gameKey: wager.gameKey,
      gameKeyText: bytes32ToText(wager.gameKey),
      matchId: wager.matchId,
      matchIdText: bytes32ToText(wager.matchId),
      claimed: wager.claimed,
      cancelled: wager.cancelled,
      createdAt: wager.createdAt?.toString?.() || String(wager.createdAt || ""),
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
      const parsed = contract.interface.parseLog(eventLog);
      const wagerId = parsed.args[0];
      const matchId = parsed.args[1];
      const wager = await getWagerDetails(wagerId, contract);

      if (wager) {
        wager.matchId = matchId.toString();
        wager.matchIdText = wager.matchId;
      }

      if (isOpen(wager)) openWagers.push(wager);
    } catch (err) {
      log("error", "Failed to parse wager event", { error: err.message });
    }
  }

  return openWagers;
}

module.exports = { getOpenWagers, getWagerDetails, isOpen };
