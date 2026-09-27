import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const target = process.argv[1] || "";
if (!target.endsWith("test-x402-income.mjs")) {
  // The preload is enabled for all npm lifecycle Node processes, but only this
  // existing test process should execute the settlement harness.
} else {
  const build = spawnSync("forge", [
    "build",
    "test/mocks/MockEIP3009Token.sol",
    "test/mocks/MockCreditPoolForMcpPoc.sol"
  ], { encoding: "utf8" });
  if (build.status !== 0) {
    throw new Error(`focused settlement mock compile failed:\n${build.stdout}\n${build.stderr}`);
  }

  const anvil = spawn("anvil", [
    "--chain-id", "4663",
    "--host", "127.0.0.1",
    "--port", "8545"
  ], { stdio: "ignore" });

  const started = Date.now();
  try {
    let ready = false;
    while (Date.now() - started < 30_000) {
      try {
        const r = await fetch("http://127.0.0.1:8545", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_chainId",
            params: []
          })
        });
        if (r.ok) {
          ready = true;
          break;
        }
      } catch (_) {}
      await sleep(250);
    }
    if (!ready) throw new Error("local Anvil did not become ready");
    await import("./poc-mcp-fragment-settlement-v2.mjs");
  } finally {
    anvil.kill("SIGTERM");
  }
}
