import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ethers } from "ethers";
import { createPayer } from "../packages/x402/src/payer.mjs";
import { robinhood } from "../packages/x402/src/robinhood.mjs";

const wallet = ethers.Wallet.createRandom();
const merchant = ethers.Wallet.createRandom().address;

function requirement() {
  return {
    scheme: "exact",
    network: robinhood.network,
    amount: "10000",
    payTo: merchant,
    asset: robinhood.usdg,
    maxTimeoutSeconds: 60,
    extra: { name: robinhood.eip712.name, version: robinhood.eip712.version }
  };
}

function paymentRequiredHeader() {
  const body = {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: { url: "https://merchant.example/paid", description: "PoC resource" },
    accepts: [requirement()]
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
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
  const payment = new Headers(init.headers || {}).get("PAYMENT-SIGNATURE");
  if (!payment) {
    return new Response("{}", {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": paymentRequiredHeader(),
        "content-type": "application/json"
      }
    });
  }

  seenPayments.push(payment);
  signedRequestCount++;

  // First signed authorization is received by the merchant, but the client loses
  // the transport connection before receiving the result.
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

  // The caller retries the same logical purchase because the first call did not
  // return the signed headers.
  const second = await payer.pay("https://merchant.example/paid");
  assert.equal(second.response.status, 200);

  assert.equal(signCount, 2, "retry caused a second signature");
  assert.equal(seenPayments.length, 2, "merchant received two signed authorizations");

  const first = JSON.parse(Buffer.from(seenPayments[0], "base64").toString("utf8"));
  const secondDecoded = JSON.parse(Buffer.from(seenPayments[1], "base64").toString("utf8"));

  assert.equal(first.payload.accepted.amount, "10000");
  assert.equal(secondDecoded.payload.accepted.amount, "10000");
  assert.equal(first.payload.payload.authorization.value, "10000");
  assert.equal(secondDecoded.payload.payload.authorization.value, "10000");
  assert.notEqual(
    first.payload.payload.authorization.nonce,
    secondDecoded.payload.payload.authorization.nonce,
    "the two authorizations are independently nonce-bound"
  );

  console.log("PASS: post-signing transport failure causes a retry to sign a second x402 authorization");
  console.log("signatures:", signCount);
  console.log("distinct nonces:",
    first.payload.payload.authorization.nonce,
    secondDecoded.payload.payload.authorization.nonce
  );
} finally {
  rpc.server.close();
}
