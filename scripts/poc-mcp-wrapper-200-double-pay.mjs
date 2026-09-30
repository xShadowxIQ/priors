import assert from "node:assert/strict";
import http from "node:http";
import { ethers } from "ethers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPriorsMcpServer } from "../packages/mcp/src/server.mjs";
import { robinhood, TRANSFER_WITH_AUTHORIZATION_TYPES } from "../packages/x402/src/robinhood.mjs";

const PRICE = 50_000n; // 0.05 USDG
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const PRIVATE_KEY = "0x59c6995e998f97a5a0044976f0945389dc9e86dae88c7a6d5efc2a2e9cc92a7b";

const b64json = (v) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");
const decode = (h) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));

async function startFakeRpc() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      const call = JSON.parse(body);
      const calls = Array.isArray(call) ? call : [call];
      const answer = c => {
        let result = "0x";
        if (c.method === "eth_chainId") result = "0x1237";
        else if (c.method === "eth_blockNumber") result = "0x1";
        else if (c.method === "eth_call") result = ethers.zeroPadValue(ethers.toBeHex(10_000_000n), 32);
        else if (c.method === "net_version") result = "4663";
        return { jsonrpc: "2.0", id: c.id, result };
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(call) ? calls.map(answer) : answer(call)));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

const rpc = await startFakeRpc();
const rpcUrl = `http://127.0.0.1:${rpc.address().port}`;
let server, client;

try {
  const provider = new ethers.JsonRpcProvider(rpcUrl, 4663, { staticNetwork: true, batchMaxCount: 1 });
  const requirement = {
    scheme: "exact",
    network: robinhood.network,
    amount: PRICE.toString(),
    asset: robinhood.usdg,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: robinhood.eip712.name, version: robinhood.eip712.version },
  };
  const paymentRequired = {
    x402Version: 2,
    resource: { url: "http://localhost:8765/premium", description: "PoC", mimeType: "application/json" },
    accepts: [requirement],
    extensions: {},
  };

  const seen = [];
  let unsigned = 0;
  const merchantFetch = async input => {
    const req = input instanceof Request ? input : new Request(input);
    const sig = req.headers.get("PAYMENT-SIGNATURE");
    if (!sig) {
      unsigned++;
      return new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": b64json(paymentRequired),
        },
      });
    }
    seen.push(sig);

    // Success response with no PAYMENT-RESPONSE / X-PAYMENT-RESPONSE.
    // The resource therefore gives no settlement receipt to the payer.
    return new Response(JSON.stringify({ ok: true, premium: "data" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  server = await createPriorsMcpServer({
    env: {
      PRIORS_KEY: PRIVATE_KEY,
      PRIORS_ALLOW_LOCAL: "1",
      PRIORS_MAX_PRICE_USD: "1",
      PRIORS_MAX_SPEND_USD: "5",
      PRIORS_RPC: rpcUrl,
      PRIORS_SCORE_V2: "off",
    },
    fetchImpl: merchantFetch,
    deps: {
      provider,
      credit: {
        isController: async () => true,
      },
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "poc-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const first = await client.callTool({
    name: "pay_url",
    arguments: {
      url: "http://localhost:8765/premium",
      max_price_usd: 0.05,
    },
  });
  assert.equal(first.isError, undefined);
  assert.equal(unsigned, 1);
  assert.equal(seen.length, 1);
  assert.match(first.content?.[0]?.text ?? "", /Paid 0\.05 USDG/);

  const second = await client.callTool({
    name: "pay_url",
    arguments: {
      url: "http://localhost:8765/premium",
      max_price_usd: 0.05,
    },
  });
  assert.equal(second.isError, undefined);
  assert.equal(unsigned, 2);
  assert.equal(seen.length, 2);
  assert.match(second.content?.[0]?.text ?? "", /Paid 0\.05 USDG/);

  assert.notEqual(seen[0], seen[1]);

  const auths = seen.map(decode).map(x => x.payload.authorization);
  const signatures = seen.map(decode).map(x => x.payload.signature);

  assert.notEqual(auths[0].nonce, auths[1].nonce);
  assert.equal(auths[0].value, PRICE.toString());
  assert.equal(auths[1].value, PRICE.toString());

  const domain = {
    name: robinhood.eip712.name,
    version: robinhood.eip712.version,
    chainId: 4663,
    verifyingContract: robinhood.usdg,
  };
  for (let i = 0; i < 2; i++) {
    const recovered = ethers.verifyTypedData(domain, TRANSFER_WITH_AUTHORIZATION_TYPES, auths[i], signatures[i]);
    assert.equal(recovered, new ethers.Wallet(PRIVATE_KEY).address);
  }

  console.log("PASS: actual MCP pay_url classified two settlement-less HTTP 200 responses as paid.");
  console.log(`  MCP calls: 2`);
  console.log(`  402 challenges: ${unsigned}`);
  console.log(`  distinct PAYMENT-SIGNATUREs: ${seen.length}`);
  console.log(`  distinct EIP-3009 nonces: ${auths[0].nonce} / ${auths[1].nonce}`);
  console.log(`  each authorization: 0.05 USDG to ${PAY_TO}`);
  console.log(`  total independently valid authorizations: 0.10 USDG`);
  console.log("  MCP returned 'Paid 0.05 USDG' for both calls without any settlement receipt.");
} finally {
  await client?.close().catch(() => {});
  await server?.close().catch(() => {});
  await new Promise(resolve => rpc.close(resolve));
}
