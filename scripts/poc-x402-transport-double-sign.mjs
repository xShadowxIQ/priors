import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ethers } from "ethers";
import { createPayer } from "../packages/x402/src/payer.mjs";
import { robinhood } from "../packages/x402/src/robinhood.mjs";
import { decodePaymentHeader } from "../sdk/x402.mjs";

function requirement(payTo) {
  return {
    scheme: "exact",
    network: "robinhood",
    maxAmountRequired: "10000",
    payTo,
    asset: robinhood.usdg,
    maxTimeoutSeconds: 60,
    resource: "https://merchant.example/paid"
  };
}

function json402(body) {
  return new Response(JSON.stringify(body), {
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

const wallet = ethers.Wallet.createRandom();
const providerStub = await stub(1_000_000n);
const signer = wallet.connect(new ethers.JsonRpcProvider(providerStub.url, 4663, { staticNetwork: true }));
const originalSignTypedData = signer.signTypedData.bind(signer);
let signCount = 0;
const signedHeaders = [];
signer.signTypedData = async (...args) => {
  signCount++;
  return originalSignTypedData(...args);
};

const merchant = ethers.Wallet.createRandom().address;
let signedRequests = 0;
const fetchImpl = async (_input, init = {}) => {
  const payment = new Headers(init.headers || {}).get("X-PAYMENT");
  if (!payment) return json402({ accepts: [requirement(merchant)] });

  signedRequests++;
  signedHeaders.push(payment);

  // The merchant received the signed authorization. Simulate the connection
  // disappearing after it may have been accepted/cashable.
  if (signedRequests === 1) throw new TypeError("fetch failed after payment was sent");

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

  // The caller retries because the first call lost the signed headers.
  const second = await payer.pay("https://merchant.example/paid");
  assert.equal(second.response.status, 200);

  assert.equal(signCount, 2, "the same failed purchase caused two signatures");
  assert.equal(signedHeaders.length, 2, "merchant saw both signed payment attempts");

  const first = decodePaymentHeader(signedHeaders[0]);
  const secondDecoded = decodePaymentHeader(signedHeaders[1]);

  assert.equal(first.payload.authorization.value, "10000");
  assert.equal(secondDecoded.payload.authorization.value, "10000");
  assert.equal(first.payload.authorization.to, merchant);
  assert.equal(secondDecoded.payload.authorization.to, merchant);
  assert.notEqual(
    first.payload.authorization.nonce,
    secondDecoded.payload.authorization.nonce,
    "the two signed authorizations use different nonces and can be independently settled"
  );

  console.log("PASS: transport drop after signing loses the pending payment and a retry signs a second valid authorization");
  console.log("signatures:", signCount);
  console.log("distinct nonces:", first.payload.authorization.nonce, secondDecoded.payload.authorization.nonce);
} finally {
  providerStub.server.close();
}
