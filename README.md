# planet-agent

Autonomous PvP wager escrow agent on Base Mainnet. Built for [The Synthesis Hackathon](https://synthesis.md).

## What it does

Planet Agent monitors open wagers on the PlanetWagerEscrow contract on Base, checks match outcomes from the Planet Games backend, and autonomously submits on-chain claim transactions when a winner is verified — no human needed, no middleman, no platform can reverse the outcome.

**Full autonomous loop:**
1. Scan WagerCreated events to discover open wagers
2. Check each wager's match result from Planet Games backend
3. Request a signed attestation from the backend
4. Validate the attestation (address check, deadline check)
5. Submit claimWithAttestation on-chain
6. Verify the receipt and log the result

## Why it matters

When agents move money on your behalf, you need transparency and guarantees. Planet Agent demonstrates:

- **Scoped execution** — agent only claims what the contract allows, nothing more
- **Trustless settlement** — funds release on-chain when conditions are met, not when a platform decides
- **Auditable history** — every decision and transaction is logged in agent_log.json
- **Safety guardrails** — agent validates every parameter before submitting irreversible transactions

## Contract

| Field | Value |
|-------|-------|
| Contract | PlanetWagerEscrow |
| Address | 0xb6Ed07efc068A6569e570D6E177693DB62Eb62Bd |
| Network | Base Mainnet (Chain ID 8453) |
| Token | USDC (0x833589fcd6edb6e08f4c7c32d4f71b54bda02913) |
| Explorer | [View on Basescan](https://basescan.org/address/0xb6Ed07efc068A6569e570D6E177693DB62Eb62Bd) |

## Agent Identity (ERC-8004)

- **Registration Tx:** [View on Basescan](https://basescan.org/tx/0x5d60ab841fc2b6614eca9c9c3efd0828a8464ea5e6794eed50abb2477d4b3462)
- **Operator:** [@mercury_0x](https://x.com/mercury_0x)

## Setup

bash
git clone https://github.com/biigmercury/planet-agent
cd planet-agent
npm install
cp .env.example .env
npm start

## Project structure

planet-agent/
├── agent/
│ ├── index.js # Main agent loop
│ ├── wager.js # On-chain wager discovery
│ ├── game.js # Planet Games backend integration
│ └── logger.js # Structured execution logger
├── contracts/
│ └── abi.json # PlanetWagerEscrow ABI
├── agent.json # Agent capability manifest
├── agent_log.json # Execution logs (generated on run)
├── .env.example # Environment variable template
└── package.json

## Tracks

- Agents With Receipts — ERC-8004
- Agent Services on Base
- Let the Agent Cook — No Humans Required

## Built with

- ethers.js v6
- Base Mainnet
- Planet Games (planetgames.live)
- OpenClaw + claude-sonnet-4-6