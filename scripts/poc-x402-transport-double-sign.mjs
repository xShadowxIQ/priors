import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ethers } from "ethers";
import { createPayer } from "../packages/x402/src/payer.mjs";
import { robinhood } from "../packages/x402/src/robinhood.mjs";
import { decodePaymentHeader } from "../sdk/x402.mjs";

const wallet = ethers.Wallet.createRandom();
const merchant = ethers.Wallet.createRandom().address;

function paymentRequiredBody() {
  return {
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
}

function json402() {
  return new Response(JSON.stringify(paymentRequiredBody()), {
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

const seenPayments = [];
let signedRequestCount = 0;
const fetchImpl = async (_input, init = {}) => {
  const payment = new Headers(init.headers || {}).get("X-PAYMENT");
  if (!payment) return json402();

  seenPayments.push(payment);
  signedRequestCount++;

  // The merchant has received the signed authorization, but the buyer's
  // transport fails before the buyer sees the result.
  if (signedRequestCount === 1) throw new TypeError("fetch failed after payment was sent");

  return new Response("paid", { status: 200 });
};

try {
  const payer = createPayer({
    signer,
    maxPrice: 10_000n,
    fetchImpl,
    pendingRetries: 0
  });

  await assert.rejects(
    () => payer.pay("https://merchant.example/paid"),
    /fetch failed after payment was sent/
  );

  // A caller that lost the first signed header retries the same logical purchase.
  const second = await payer.pay("https://merchant.example/paid");
  assert.equal(second.response.status, 200);

  assert.equal(signCount, 2, "retry caused a second signature");
  assert.equal(seenPayments.length, 2, "merchant received two signed authorizations");

  const first = decodePaymentHeader(seenPayments[0]);
  const secondDecoded = decodePaymentHeader(seenPayments[1]);

  assert.equal(first.payload.authorization.value, "10000");
  assert.equal(secondDecoded.payload.authorization.value, "10000");
  assert.equal(first.payload.authorization.to, merchant);
  assert.equal(secondDecoded.payload.authorization.to, merchant);
  assert.notEqual(
    first.payload.authorization.nonce,
    secondDecoded.payload.authorization.nonce,
    "the two authorizations have independent nonces and are independently settleable"
  );

  console.log("PASS: post-signing transport failure causes a retry to sign a second x402 authorization");
  console.log("signatures:", signCount);
  console.log("distinct nonces:",
    first.payload.authorization.nonce,
    secondDecoded.payload.authorization.nonce
  );
} finally {
  rpc.server.close();
}
