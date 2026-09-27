import fs from "node:fs";
import http from "node:http";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { createPriorsMcpServer } from "../packages/mcp/src/server.mjs";

const RPC = "http://127.0.0.1:8545";
const CHAIN = 4663;
const PRICE = 50_000n; // $0.05
const TWO = PRICE * 2n;

function keysFromAnvilLog() {
  const s = fs.readFileSync("/tmp/anvil.log", "utf8");
  const section = s.split("Private Keys")[1] || "";
  const keys = [...section.matchAll(/\(\d+\) (0x[a-fA-F0-9]{64})/g)].map((m) => m[1]);
  assert.ok(keys.length >= 3, "could not read Anvil private keys");
  return keys;
}

function decodePayment(header) {
  const padded = String(header).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(header).length / 4) * 4, "=");
  const p = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  assert.equal(p.x402Version, 2);
  assert.equal(p.payload?.authorization?.value, String(PRICE));
  return p;
}

function settlementHeader(txHashes) {
  return Buffer.from(JSON.stringify({
    success: true,
    transaction: txHashes[txHashes.length - 1]
  }), "utf8").toString("base64");
}

const provider = new ethers.JsonRpcProvider(RPC, ethers.Network.from(CHAIN), { staticNetwork: true, cacheTimeout: -1 });
const [deployerKey, payerKey, merchantKey] = keysFromAnvilLog();
const deployer = new ethers.Wallet(deployerKey, provider);
const payer = new ethers.Wallet(payerKey, provider);
const merchant = new ethers.Wallet(merchantKey, provider);

function artifact(name) {
  return JSON.parse(fs.readFileSync(`out/${name}.sol/${name}.json`, "utf8"));
}

const tokenArtifact = artifact("MockEIP3009Token");
const Token = new ethers.ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode.object, deployer);
const token = await Token.deploy();
await token.waitForDeployment();
const tokenAddress = await token.getAddress();

const poolArtifact = artifact("MockCreditPoolForMcpPoc");
const Pool = new ethers.ContractFactory(poolArtifact.abi, poolArtifact.bytecode.object, deployer);
const pool = await Pool.deploy(tokenAddress);
await pool.waitForDeployment();
const poolAddress = await pool.getAddress();

await (await token.mint(payer.address, TWO)).wait();
assert.equal(await token.balanceOf(payer.address), TWO);

const seenPaths = [];
const seenPayments = new Map();
const settled = [];

const merchantServer = http.createServer(async (req, res) => {
  seenPaths.push(req.url);

  const payment = req.headers["payment-signature"];
  if (!payment) {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({
      x402Version: 2,
      accepts: [{
        scheme: "exact",
        network: "eip155:4663",
        asset: tokenAddress,
        amount: String(PRICE),
        payTo: merchant.address,
        maxTimeoutSeconds: 60,
        extra: { name: "Global Dollar", version: "1" }
      }]
    }));
    return;
  }

  const p = decodePayment(payment);
  const a = p.payload.authorization;
  const sig = ethers.Signature.from(p.payload.signature);
  const nonce = String(a.nonce).toLowerCase();

  if (!seenPayments.has(nonce)) {
    seenPayments.set(nonce, { authorization: a, sig });
  }

  if (seenPayments.size === 1) {
    res.writeHead(402, { "content-type": "application/json", "retry-after": "1" });
    res.end(JSON.stringify({ pending: true, errorReason: "settlement_pending" }));
    return;
  }

  if (settled.length === 0) {
    for (const entry of seenPayments.values()) {
      const tx = await token.transferWithAuthorization(
        entry.authorization.from,
        entry.authorization.to,
        BigInt(entry.authorization.value),
        BigInt(entry.authorization.validAfter),
        BigInt(entry.authorization.validBefore),
        entry.authorization.nonce,
        entry.sig.v,
        entry.sig.r,
        entry.sig.s
      );
      const receipt = await tx.wait();
      assert.equal(receipt.status, 1);
      settled.push(tx.hash);
    }
  }

  res.writeHead(200, {
    "content-type": "application/json",
    "PAYMENT-RESPONSE": settlementHeader(settled)
  });
  res.end(JSON.stringify({ ok: true, settled: settled.length }));
});

await new Promise((resolve) => merchantServer.listen(0, "127.0.0.1", resolve));
const { port } = merchantServer.address();

const env = {
  ...process.env,
  PRIORS_KEY: payerKey,
  PRIORS_RPC: RPC,
  PRIORS_AGENT_ID: "1",
  PRIORS_ALLOW_LOCAL: "1",
  PRIORS_MAX_PRICE_USD: "1",
  PRIORS_MAX_SPEND_USD: "5",
  PRIORS_MAX_BORROW_USD: "0.01"
};

const mcp = await createPriorsMcpServer({
  env,
  deps: {
    provider,
    addresses: { pool: poolAddress },
    credit: {
      isController: async () => true
    }
  }
});

assert.ok(mcp._registeredTools?.pay_url?.handler, "MCP SDK internals changed: pay_url handler not reachable");

async function pay(url) {
  return mcp._registeredTools.pay_url.handler({
    url,
    method: "POST",
    max_price_usd: 0.05,
    max_borrow_usd: 0.01
  }, {});
}

const base = `http://127.0.0.1:${port}/paid`;

const first = await pay(base + "#first");
assert.match(first.content?.[0]?.text || "", /signed and sent|do NOT call pay_url/i);
assert.equal(seenPayments.size, 1, "first call should create exactly one authorization");
const firstNonce = [...seenPayments.keys()][0];

const second = await pay(base + "#second");
assert.match(second.content?.[0]?.text || "", /Paid 0\.05 USDG/i);

assert.equal(seenPayments.size, 2, "different fragments caused a second authorization");
const entries = [...seenPayments.values()];
assert.notEqual(entries[0].authorization.nonce, entries[1].authorization.nonce);

for (const e of entries) {
  assert.equal(e.authorization.from.toLowerCase(), payer.address.toLowerCase());
  assert.equal(e.authorization.to.toLowerCase(), merchant.address.toLowerCase());
  assert.equal(e.authorization.value, String(PRICE));
  assert.equal(await token.authorizationState(payer.address, e.authorization.nonce), true);
}

assert.deepEqual(seenPaths.slice(0, 3), ["/paid", "/paid", "/paid"]);
assert.equal(settled.length, 2);

const payerAfter = await token.balanceOf(payer.address);
const merchantAfter = await token.balanceOf(merchant.address);
assert.equal(payerAfter, 0n);
assert.equal(merchantAfter, TWO);

console.log("PASS: actual EIP-3009 settlement reproduced");
console.log("same HTTP resource:", base);
console.log("network paths:", JSON.stringify(seenPaths.slice(0, 3)));
console.log("distinct signed authorizations:", seenPayments.size);
console.log("distinct settled transactions:", settled.length);
console.log("payer balance before:", TWO.toString());
console.log("payer balance after :", payerAfter.toString());
console.log("merchant received    :", merchantAfter.toString());
console.log("settlement txs:", settled.join(", "));

await new Promise((resolve) => merchantServer.close(resolve));
await provider.destroy?.();
