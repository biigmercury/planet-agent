const fs = require("fs");
const path = require("path");

const logs = [];

function log(type, message, data = {}) {
 const entry = {
 timestamp: new Date().toISOString(),
 type,
 message,
 ...( Object.keys(data).length > 0 ? { data } : {} ),
 };
 logs.push(entry);
 console.log([${entry.timestamp}] [${type.toUpperCase()}] ${message}, Object.keys(data).length > 0 ? data : "");
}

function writeLogs() {
 const outputPath = path.join(__dirname, "../agent_log.json");
 fs.writeFileSync(outputPath, JSON.stringify({ agent: "planet-agent", logs }, null, 2));
 console.log([LOGGER] agent_log.json written to ${outputPath});
}

module.exports = { log, writeLogs };
