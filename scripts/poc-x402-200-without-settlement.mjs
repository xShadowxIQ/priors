import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ethers } from "ethers";
import { createPayer } from "../packages/x402/src/payer.mjs";
import { robinhood } from "../packages/x402/src/robinhood.mjs";
import { decodePaymentHeader } from "../sdk/x402.mjs";

const wallet = ethers.Wallet.createRandom();
const merchant = ethers.Wallet.createRandom().address;

const requirement = {
  x402Version: 1,
  error: "X-PAYMENT header is required",
  accepts: [{
    scheme: "exact",
    network: robinhood.legacyNetwork,
    maxAmountRequired: "10000",
    payTo: merchant,
    asset: robinhood.usdg,
    resource: "https://merchant.example/paid",
    description: "PoC resource",
    maxTimeoutSeconds: 60,
    extra: { name: robinhood.eip712.name, version: robinhood.eip712.version }
  }]
};

function json402() {
  return new Response(JSON.stringify(requirement), {
    status: 402,
    headers: { "content-type": "application/json" }
  });
}

function stub(balance) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reqs = [].concat(JSON.parse(body));
      const out = reqs.map((r) => {
        if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: "0x1237" };
        if (r.method === "eth_call") return { jsonrpc: "2.0", id: r.id, result: ethers.toBeHex(balance, 32) };
        return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "unexpected rpc method " + r.method } };
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server,
    url: `http://127.0.0.1:${server.address().port}`
  })));
}

const rpc = await stub(1_000_000n);
const signer = wallet.connect(new ethers.JsonRpcProvider(rpc.url, 4663, { staticNetwork: true }));

let signCount = 0;
const originalSignTypedData = signer.signTypedData.bind(signer);
signer.signTypedData = async (...args) => {
  signCount++;
  return originalSignTypedData(...args);
};

const signed = [];
let phase = 0;

const fetchImpl = async (input, init = {}) => {
  const payment = new Headers(input?.headers || init.headers || {}).get("X-PAYMENT");
  if (!payment) {
    // The merchant says no payment is currently attached.
    return json402();
  }

  signed.push(decodePaymentHeader(payment));

  if (phase === 0) {
    phase = 1;
    // Deliberately return HTTP 200 without PAYMENT-RESPONSE / settlement proof.
    // The exact authorization has not been settled in this mock.
    return new Response("success-without-settlement", { status: 200 });
  }

  phase = 2;
  return new Response("second-success", { status: 200 });
};

try {
  const payer = createPayer({
    signer,
    maxPrice: 10_000n,
    fetchImpl,
    pendingRetries: 0
  });

  const first = await payer.pay("https://merchant.example/paid");
  assert.equal(first.response.status, 200);
  assert.equal(first.paid, 10_000n);
  assert.equal(first.settlement, undefined);

  // The first authorization remains valid/cashable in the mock because no
  // settlement occurred. A normal caller now invokes pay() again.
  const second = await payer.pay("https://merchant.example/paid");
  assert.equal(second.response.status, 200);

  assert.equal(signCount, 2, "a second authorization was signed after an unconfirmed 200");
  assert.equal(signed.length, 2);

  const a = signed[0].payload.authorization;
  const b = signed[1].payload.authorization;

  assert.equal(a.value, "10000");
  assert.equal(b.value, "10000");
  assert.equal(a.to, merchant);
  assert.equal(b.to, merchant);
  assert.notEqual(a.nonce, b.nonce);

  console.log("PASS: payer treats HTTP 200 as paid without settlement proof, allowing a later retry to sign a second authorization");
  console.log("first settlement:", first.settlement);
  console.log("signatures:", signCount);
  console.log("first nonce:", a.nonce);
  console.log("second nonce:", b.nonce);
} finally {
  rpc.server.close();
}
