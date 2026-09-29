// Deterministic PoC: @priors/mcp drops an unsettled payment at local validBefore,
// while @priors/x402 deliberately keeps it cashable for an additional 60s clock-skew buffer.
//
// Run: node scripts/test-mcp-validbefore-skew.mjs
// Merchant and RPC are mocked. No real funds or mainnet calls are used.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ethers } from "ethers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPriorsMcpServer } from "../packages/mcp/src/server.mjs";
import { robinhood } from "../packages/x402/src/robinhood.mjs";

const DEV_MNEMONIC = "test test test test test test test test test test test junk";
const KEY = ethers.HDNodeWallet.fromPhrase(DEV_MNEMONIC, undefined, "m/44'/60'/0'/0/0").privateKey;
const PAY_TO = "0x" + "22".repeat(20);
const PRICE = "100000"; // $0.10 USDG
const RESOURCE = "http://localhost/poc-paid-resource";
const CHAIN_ID = 4663;

let fakeNow = 1_900_000_000;
const realDateNow = Date.now;
Date.now = () => fakeNow * 1000;

let merchantCalls = 0;
const signed = [];

const rpc = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const msg = JSON.parse(raw);
  const reply = { jsonrpc: "2.0", id: msg.id };

  if (msg.method === "eth_chainId") reply.result = "0x1237";
  else if (msg.method === "net_version") reply.result = String(CHAIN_ID);
  else if (msg.method === "eth_call") reply.result = ethers.zeroPadValue(ethers.toBeHex(1_000_000), 32); // $1 mock USDG
  else if (msg.method === "eth_blockNumber") reply.result = "0x1";
  else reply.result = "0x";

  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(reply));
});

const fetchImpl = async (input, init) => {
  merchantCalls++;
  const req = input instanceof Request ? input : new Request(input, init);
  const header = req.headers.get("PAYMENT-SIGNATURE") || req.headers.get("X-PAYMENT");

  if (!header) {
    return new Response(JSON.stringify({
      x402Version: 2,
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

  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  const a = decoded.payload.authorization;
  signed.push({
    nonce: a.nonce,
    validAfter: Number(a.validAfter),
    validBefore: Number(a.validBefore),
    value: String(a.value),
  });

  return new Response(JSON.stringify({ pending: true, errorReason: "settlement_pending" }), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ errorReason: "settlement_pending" })).toString("base64"),
      "retry-after": "0",
    },
  });
};

const uniqByNonce = (items) => [...new Map(items.map((x) => [x.nonce, x])).values()];

const rpcPort = await new Promise((resolve, reject) => {
  rpc.once("error", reject);
  rpc.listen(0, "127.0.0.1", () => resolve(rpc.address().port));
});

try {
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
    arguments: { url: RESOURCE, max_price_usd: 0.10 },
  });

  const first = await call();
  assert.equal(!!first.isError, false, JSON.stringify(first));
  const firstAuths = uniqByNonce(signed);
  assert.equal(firstAuths.length, 1, "first call must use one authorization nonce");
  const old = firstAuths[0];

  // The chain can still be one second behind the payer's wall clock.
  const chainNow = old.validBefore - 1;
  assert.ok(old.validAfter <= chainNow && chainNow < old.validBefore);

  // This is the boundary at which MCP deletes its outstanding entry.
  // @priors/x402 itself uses a +60s skew buffer, so it would retain the old authorization.
  fakeNow = old.validBefore + 1;

  const second = await call();
  assert.equal(!!second.isError, false, JSON.stringify(second));

  const all = uniqByNonce(signed);
  assert.equal(all.length, 2, `expected two distinct authorizations, got ${all.length}`);
  const newer = all.find((x) => x.nonce !== old.nonce);
  assert.ok(newer, "second call must sign a fresh authorization");

  // Both signed authorizations are simultaneously valid at the simulated chain timestamp.
  assert.ok(newer.validAfter <= chainNow && chainNow < newer.validBefore);
  assert.equal(newer.value, PRICE);
  assert.ok(newer.validBefore > old.validBefore);

  console.log("PASS first nonce:       ", old.nonce);
  console.log("PASS first validBefore:  ", old.validBefore);
  console.log("PASS chain timestamp:    ", chainNow);
  console.log("PASS second nonce:       ", newer.nonce);
  console.log("PASS second validBefore: ", newer.validBefore);
  console.log("PASS both auths are valid at the same chain time");
  console.log("PASS same purchase caused two distinct signatures");
  console.log("merchant signed requests:", signed.length);
  console.log("merchant total calls:    ", merchantCalls);
} finally {
  Date.now = realDateNow;
  await new Promise((resolve) => rpc.close(resolve));
}
