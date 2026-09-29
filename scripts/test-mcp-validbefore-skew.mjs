// Deterministic PoC: @priors/mcp drops an unsettled payment exactly at the local validBefore,
// while @priors/x402 intentionally keeps the same authorization cashable for an additional 60 seconds of clock skew.
//
// Run:
//   node scripts/test-mcp-validbefore-skew.mjs
//
// The merchant is mocked. No real funds, RPC, or mainnet calls are used.
// The RPC stub only supplies chainId and a zero USDG balance so the real x402 signer path executes.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ethers } from "ethers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPriorsMcpServer } from "../packages/mcp/src/server.mjs";
import { robinhood } from "../packages/x402/src/robinhood.mjs";

const KEY = "0x" + "11".repeat(32);
const PAY_TO = "0x" + "22".repeat(20);
const PRICE = "100000"; // $0.10 USDG
const RESOURCE = "http://localhost/poc-paid-resource";
const CHAIN_ID = 4663;

let fakeNow = 1_900_000_000;
const realDateNow = Date.now;
Date.now = () => fakeNow * 1000;

let rpc;
let merchantCalls = 0;
const signed = [];

/** Minimal JSON-RPC endpoint used only by ethers' balanceOf call and network detection. */
rpc = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const msg = JSON.parse(raw);
  const reply = { jsonrpc: "2.0", id: msg.id };

  if (msg.method === "eth_chainId") reply.result = "0x1237";
  else if (msg.method === "net_version") reply.result = String(CHAIN_ID);
  else if (msg.method === "eth_call") reply.result = "0x" + "00".repeat(32); // zero USDG balance
  else if (msg.method === "eth_blockNumber") reply.result = "0x1";
  else reply.result = "0x";

  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(reply));
});

/**
 * Mock merchant:
 *   no payment header -> x402 402 response
 *   payment header -> settlement_pending forever
 *
 * This is the exact state in which the MCP stores an outstanding authorization.
 */
const fetchImpl = async (input, init) => {
  merchantCalls++;
  const req = input instanceof Request ? input : new Request(input, init);
  const header = req.headers.get("PAYMENT-SIGNATURE") || req.headers.get("X-PAYMENT");

  if (!header) {
    return new Response(JSON.stringify({
      x402Version: 2,
      error: "payment required",
      accepts: [{
        scheme: "exact",
        network: "eip155:4663",
        amount: PRICE,
        asset: robinhood.usdg,
        payTo: PAY_TO,
        maxTimeoutSeconds: 600,
        resource: RESOURCE,
        extra: {
          name: robinhood.eip712.name,
          version: robinhood.eip712.version,
          assetTransferMethod: "eip3009",
        },
      }],
    }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  }

  // x402 v2 encodes PAYMENT-SIGNATURE as base64 JSON.
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  signed.push({
    nonce: decoded.payload.authorization.nonce,
    validAfter: Number(decoded.payload.authorization.validAfter),
    validBefore: Number(decoded.payload.authorization.validBefore),
    value: String(decoded.payload.authorization.value),
  });

  return new Response(JSON.stringify({
    pending: true,
    errorReason: "settlement_pending",
  }), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({
        errorReason: "settlement_pending",
      })).toString("base64"),
      "retry-after": "0",
    },
  });
};

function uniqByNonce(items) {
  return [...new Map(items.map((x) => [x.nonce, x])).values()];
}

const rpcPort = await new Promise((resolve, reject) => {
  rpc.once("error", reject);
  rpc.listen(0, "127.0.0.1", () => resolve(rpc.address().port));
});

try {
  const wallet = new ethers.Wallet(KEY);
  const server = await createPriorsMcpServer({
    env: {
      PRIORS_KEY: KEY,
      PRIORS_RPC: `http://127.0.0.1:${rpcPort}`,
      PRIORS_ALLOW_LOCAL: "1",
      PRIORS_MAX_PRICE_USD: "1",
      PRIORS_MAX_SPEND_USD: "5",
    },
    fetchImpl,
    deps: { sleep: async () => {} },
  });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "mcp-validbefore-skew-poc", version: "1" });
  await client.connect(clientTransport);

  const call = () => client.callTool({
    name: "pay_url",
    arguments: {
      url: RESOURCE,
      max_price_usd: 0.10,
    },
  });

  // First call signs one authorization and gets only "pending" from the merchant.
  const first = await call();
  assert.equal(!!first.isError, false, JSON.stringify(first));
  assert.equal(signed.length, 3, `expected the pending resend loop to use one signature 3 times, got ${signed.length}`);
  const firstAuth = uniqByNonce(signed);
  assert.equal(firstAuth.length, 1, "first call must use exactly one authorization nonce");
  const old = firstAuth[0];

  // Reproduce a tiny local-clock lead: local time is 1s after validBefore,
  // while the chain can still be 1s before it.
  const chainNow = old.validBefore - 1;
  assert.ok(old.validAfter <= chainNow && chainNow < old.validBefore, "old authorization must still be chain-cashable");
  fakeNow = old.validBefore + 1;

  // MCP purges outstanding at validBefore. The embedded x402 payer intentionally has a 60s skew buffer,
  // but that buffer is lost because the outer MCP map has already discarded the authorization.
  const second = await call();
  assert.equal(!!second.isError, false, JSON.stringify(second));

  const all = uniqByNonce(signed);
  assert.equal(all.length, 2, `expected two distinct authorization nonces, got ${all.length}`);
  const newer = all.find((x) => x.nonce !== old.nonce);
  assert.ok(newer, "second call must sign a fresh authorization");
  assert.equal(newer.value, PRICE);

  // At chainNow, BOTH authorizations are valid. A merchant holding the first and second
  // can submit both before the old one actually expires.
  assert.ok(newer.validAfter <= chainNow && chainNow < newer.validBefore, "second authorization must also be chain-cashable");
  assert.notEqual(old.nonce, newer.nonce);
  assert.ok(newer.validBefore > old.validBefore);

  console.log("PASS: first call nonce      =", old.nonce);
  console.log("PASS: first validBefore      =", old.validBefore);
  console.log("PASS: simulated chain time  =", chainNow);
  console.log("PASS: second call nonce     =", newer.nonce);
  console.log("PASS: second validBefore    =", newer.validBefore);
  console.log("PASS: both signatures valid at simulated chain time");
  console.log("PASS: MCP signed twice for the same purchase after its local expiry");
  console.log("merchant requests carrying signatures:", signed.length);
  console.log("wallet used in PoC:", wallet.address);

  await client.close();
} finally {
  Date.now = realDateNow;
  await new Promise((resolve) => rpc.close(resolve));
}
