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

    return {
      wagerId: wagerId.toString(),
      player1: wager[1],
      player2: wager[2].toString(),
      amount: ethers.formatUnits(wager[3], 6),
      amountRaw: wager[3],
      matchId: wager[4],
      claimed: wager[5],
      cancelled: wager[6],
      createdAt: wager[7]?.toString(),
    };
  } catch (err) {
    log("error", `Failed to read wager ${wagerId}`, { error: err.message });
    return null;
  }
}

function isOpen(wager) {
 if (!wager) return false;
 if (wager[5] === true) return false; // claimed
 if (wager[6] === true) return false; // cancelled
 if (!wager[2] || wager[2].toString() === '0') return false; // no player2
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
