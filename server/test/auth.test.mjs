/* Passwords and "Sign in with MetaMask" messages (server/auth.mjs). No database needed.
   Run: node --test server/test/auth.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, parseSiwe } from "../auth.mjs";

test("scrypt password hashes verify, reject wrong passwords, and are salted", async () => {
  const h = await hashPassword("night signals 2026");
  assert.match(h, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword("night signals 2026", h), true);
  assert.equal(await verifyPassword("night signals 2027", h), false);
  assert.notEqual(await hashPassword("night signals 2026"), h);
  assert.equal(await verifyPassword("x", "md5$whatever"), false);
});

test("EIP-4361 message fields", () => {
  const m = "localhost:5173 wants you to sign in with your Ethereum account:\n0x70997970C51812dc3A010C7d01b50e0d17dc79C8\n\nSign in to DMAF.\n\n"
    + "URI: http://localhost:5173\nVersion: 1\nChain ID: 31337\nNonce: abc123\nIssued At: 2026-10-14T12:00:00.000Z";
  assert.deepEqual(parseSiwe(m), { domain: "localhost:5173", address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", uri: "http://localhost:5173",
    version: "1", chainId: "31337", nonce: "abc123", issuedAt: "2026-10-14T12:00:00.000Z" });
  assert.equal(parseSiwe("hello").domain, undefined);
});
