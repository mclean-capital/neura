/**
 * A2A multi-turn conversation test.
 * Run: node test-a2a.mjs
 */

import { createInterface } from "readline";

const A2A_URL = "http://localhost:3000/a2a";
const messages = [];
let rpcId = 0;

const rl = createInterface({ input: process.stdin, output: process.stdout });

function prompt(q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

async function sendTask(msgs) {
  const res = await fetch(A2A_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tasks/send",
      params: { messages: msgs },
      id: ++rpcId,
    }),
  });
  return res.json();
}

console.log("=== A2A Multi-Turn Conversation Test ===");
console.log('Type your messages. Type "quit" to exit.\n');

for (let turn = 1; turn <= 6; turn++) {
  const userInput = await prompt(`[Turn ${turn}/6] You: `);
  if (userInput.toLowerCase() === "quit") break;

  // Add user message
  messages.push({
    role: "user",
    parts: [{ type: "text", text: userInput }],
  });

  console.log("  ... thinking ...");
  const response = await sendTask(messages);

  if (response.error) {
    console.log(`  Error: ${response.error.message}`);
    continue;
  }

  // Extract the agent's reply (last message with role "agent")
  const resultMessages = response.result.messages;
  const agentMsg = resultMessages.filter((m) => m.role === "agent").pop();
  const agentText = agentMsg?.parts
    ?.filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");

  // Add agent message to history for next turn
  messages.push({
    role: "agent",
    parts: [{ type: "text", text: agentText }],
  });

  console.log(`\n  Neura: ${agentText}\n`);
}

console.log(`\n=== Conversation complete (${messages.length / 2} turns) ===`);
rl.close();
