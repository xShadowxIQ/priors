import assert from "node:assert/strict";
import { createPayer } from "../packages/x402/src/payer.mjs";
import { robinhood } from "../packages/x402/src/robinhood.mjs";
import { JsonRpcProvider, Wallet } from "ethers";
import http from "node:http";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const PRICE = "100000"; // $0.10 USDG
const URL = "https://merchant.example/resource";

const requirement = {
  x402Version: 1,
  accepts: [{
    scheme: "exact",
    network: "robinhood",
    maxAmountRequired: PRICE,
    resource: URL,
    description: "restart PoC",
    mimeType: "application/json",
    payTo: PAY_TO,
    asset: robinhood.usdg
  }]
};

const rpc = http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => raw += c);
  req.on("end", () => {
    let j;
    try { j = JSON.parse(raw); } catch {
      res.writeHead(400); res.end(); return;
    }
    const calls = Array.isArray(j) ? j : [j];
    const out = calls.map(x => {
      if (x.method === "eth_chainId") return { jsonrpc: "2.0", id: x.id, result: "0x1237" };
      if (x.method === "eth_call") {
        return { jsonrpc: "2.0", id: x.id, result: "0x" + (100000000n).toString(16).padStart(64, "0") };
      }
      if (x.method === "net_version") return { jsonrpc: "2.0", id: x.id, result: "4663" };
      return { jsonrpc: "2.0", id: x.id, result: "0x0" };
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(j) ? out : out[0]));
  });
});

await new Promise(resolve => rpc.listen(0, "127.0.0.1", resolve));
const port = rpc.address().port;
const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 4663, { staticNetwork: true, batchMaxCount: 1 });
const wallet = new Wallet("0x" + "11".repeat(32), provider);

const sent = [];
let requestsWithoutPayment = 0;

const fetchImpl = async (input, init) => {
  const r = new Request(input, init);
  const payment = r.headers.get("X-PAYMENT");
  if (!payment) {
    requestsWithoutPayment++;
    return new Response(JSON.stringify(requirement), {
      status: 402,
      headers: { "content-type": "application/json" }
    });
  }
  sent.push(payment);
  throw new TypeError("simulated connection reset after payment was received");
};

const makePayer = () => createPayer({
  signer: wallet,
  maxPrice: 100000n,
  fetchImpl,
  timeoutMs: 5000,
  pendingRetries: 0
});

const payerA = makePayer();
const first = await payerA.pay(URL);
assert.equal(first.pending, true);
assert.equal(first.transportError, true);
assert.equal(sent.length, 1);

const sameProcessRetry = await payerA.pay(URL);
assert.equal(sameProcessRetry.resent, true);
assert.equal(sent.length, 2);
assert.equal(sent[0], sent[1]);

const payerB = makePayer();
const afterRestart = await payerB.pay(URL);
assert.equal(afterRestart.pending, true);
assert.equal(sent.length, 3);
assert.notEqual(sent[2], sent[0]);

const decodeV1 = h => JSON.parse(Buffer.from(h, "base64").toString("utf8"));
const a = decodeV1(sent[0]).payload.authorization;
const b = decodeV1(sent[2]).payload.authorization;

assert.equal(a.to, PAY_TO);
assert.equal(b.to, PAY_TO);
assert.equal(a.value, PRICE);
assert.equal(b.value, PRICE);
assert.notEqual(a.nonce, b.nonce, "restart caused a fresh EIP-3009 nonce");
assert.equal(requestsWithoutPayment, 2);

console.log("PASS: same payer instance reuses one payment, but a restarted payer signs a second distinct authorization.");
console.log(`first nonce : ${a.nonce}`);
console.log(`second nonce: ${b.nonce}`);
console.log("Both authorizations target the same payTo and amount, so a merchant that received the first can settle both.");

await new Promise(resolve => rpc.close(resolve));
await provider.destroy();
