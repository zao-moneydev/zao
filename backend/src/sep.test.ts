import assert from "node:assert/strict";
import test from "node:test";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  buildWithdrawPayment,
  clearTomlCache,
  isPendingUserTransferStart,
  parseStellarToml,
  pickAnchorAsset,
  pollSep24Transaction,
  sep10,
  sepHttp,
  signSep10Challenge,
  unwrapSep24Transaction,
} from "./sep.ts";
import { config } from "./config.ts";

const TOML = `
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
WEB_AUTH_ENDPOINT = "https://example.test/auth"
TRANSFER_SERVER_SEP0024 = "https://example.test/sep24"
SIGNING_KEY = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR"

[[CURRENCIES]]
code = "SRT"
issuer = "GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B"

[[CURRENCIES]]
code = "USDC"
issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
`;

test("parses stellar.toml endpoints and SRT/USDC currencies", () => {
  const toml = parseStellarToml(TOML);
  assert.equal(toml.WEB_AUTH_ENDPOINT, "https://example.test/auth");
  assert.equal(toml.TRANSFER_SERVER_SEP0024, "https://example.test/sep24");
  assert.equal(toml.currencies.length, 2);
  const srt = pickAnchorAsset(toml);
  assert.equal(srt.code, "SRT");
  assert.equal(srt.issuer, "GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B");
});

test("pickAnchorAsset honors ANCHOR_ASSET_CODE=USDC", () => {
  const prev = config.anchorAssetCode;
  config.anchorAssetCode = "USDC";
  try {
    const asset = pickAnchorAsset(parseStellarToml(TOML));
    assert.equal(asset.code, "USDC");
    assert.equal(asset.issuer.startsWith("GBBD"), true);
  } finally {
    config.anchorAssetCode = prev;
  }
});

test("signSep10Challenge adds the client signature to the challenge XDR", () => {
  const server = Keypair.random();
  const client = Keypair.random();
  const source = new Account(server.publicKey(), "0");
  const challenge = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.manageData({
        name: "testanchor.stellar.org auth",
        value: Buffer.from("nonce"),
        source: client.publicKey(),
      }),
    )
    .setTimeout(300)
    .build();
  challenge.sign(server);
  const signedXdr = signSep10Challenge(challenge.toXDR(), Networks.TESTNET, client);
  const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
  assert.equal(signed.signatures.length, 2);
  const restored = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
  assert.doesNotThrow(() => restored);
});

test("SEP-10 mock HTTP: signs the challenge and returns the JWT", async () => {
  const client = Keypair.random();
  const server = Keypair.random();
  const source = new Account(server.publicKey(), "0");
  const challenge = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.manageData({
        name: "example.test auth",
        value: Buffer.from("nonce"),
        source: client.publicKey(),
      }),
    )
    .setTimeout(300)
    .build();
  challenge.sign(server);

  const prev = sepHttp.fetch;
  config.anchorHomeDomain = "https://example.test";
  clearTomlCache();
  let postedXdr = "";
  sepHttp.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("stellar.toml")) {
      return new Response(TOML, { status: 200 });
    }
    if (url.includes("/auth") && (!init || !init.method || init.method === "GET")) {
      return Response.json({
        transaction: challenge.toXDR(),
        network_passphrase: Networks.TESTNET,
      });
    }
    if (url.includes("/auth") && init?.method === "POST") {
      postedXdr = JSON.parse(String(init.body)).transaction;
      return Response.json({ token: "sep10.test.jwt" });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const token = await sep10(client);
    assert.equal(token, "sep10.test.jwt");
    const signed = TransactionBuilder.fromXDR(postedXdr, Networks.TESTNET);
    assert.equal(signed.signatures.length, 2);
  } finally {
    sepHttp.fetch = prev;
    clearTomlCache();
  }
});

test("buildWithdrawPayment requires pending_user_transfer_start and memo fields", () => {
  assert.equal(isPendingUserTransferStart("pending_user_transfer_start"), true);
  assert.equal(isPendingUserTransferStart("incomplete"), false);

  assert.throws(
    () =>
      buildWithdrawPayment(
        { id: "1", status: "incomplete" },
        { amount: "1", assetCode: "SRT", assetIssuer: "GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B" },
      ),
    /pending_user_transfer_start/,
  );

  const payment = buildWithdrawPayment(
    {
      id: "abc",
      status: "pending_user_transfer_start",
      withdraw_anchor_account: "GCSGSR6KQQ5BP2FXVPWRL6SWPUSFWLVONLIBJZUKTVQB5FYJFVL6XOXE",
      withdraw_memo: "memo-42",
      withdraw_memo_type: "text",
      amount_in: "2.5000000",
      amount_in_asset:
        "stellar:SRT:GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B",
    },
    { amount: "1", assetCode: "USDC", assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
  );
  assert.equal(payment.destination, "GCSGSR6KQQ5BP2FXVPWRL6SWPUSFWLVONLIBJZUKTVQB5FYJFVL6XOXE");
  assert.equal(payment.amount, "2.5000000");
  assert.equal(payment.memo, "memo-42");
  assert.equal(payment.memoType, "text");
  assert.equal(payment.assetCode, "SRT");
});

test("pollSep24Transaction waits until pending_user_transfer_start", async () => {
  const prev = sepHttp.fetch;
  config.anchorHomeDomain = "https://example.test";
  clearTomlCache();
  let calls = 0;
  sepHttp.fetch = async (input) => {
    const url = String(input);
    if (url.includes("stellar.toml")) return new Response(TOML, { status: 200 });
    if (url.includes("/transaction")) {
      calls += 1;
      const status = calls < 3 ? "incomplete" : "pending_user_transfer_start";
      return Response.json({
        transaction: {
          id: "tx-1",
          status,
          withdraw_anchor_account:
            calls >= 3 ? "GCSGSR6KQQ5BP2FXVPWRL6SWPUSFWLVONLIBJZUKTVQB5FYJFVL6XOXE" : undefined,
          amount_in: "1",
        },
      });
    }
    return new Response("no", { status: 404 });
  };
  try {
    const tx = await pollSep24Transaction({
      token: "jwt",
      id: "tx-1",
      until: ["pending_user_transfer_start"],
      timeoutMs: 5_000,
      intervalMs: 10,
    });
    assert.equal(tx.status, "pending_user_transfer_start");
    assert.equal(calls >= 3, true);
    assert.equal(unwrapSep24Transaction({ transaction: tx }).id, "tx-1");
  } finally {
    sepHttp.fetch = prev;
    clearTomlCache();
  }
});

test("pollSep24Transaction fails fast on error status", async () => {
  const prev = sepHttp.fetch;
  config.anchorHomeDomain = "https://example.test";
  clearTomlCache();
  sepHttp.fetch = async (input) => {
    const url = String(input);
    if (url.includes("stellar.toml")) return new Response(TOML, { status: 200 });
    return Response.json({ transaction: { id: "x", status: "error", message: "rejected" } });
  };
  try {
    await assert.rejects(
      () =>
        pollSep24Transaction({
          token: "jwt",
          id: "x",
          until: ["completed"],
          timeoutMs: 1_000,
          intervalMs: 10,
        }),
      /ended with status error/,
    );
  } finally {
    sepHttp.fetch = prev;
    clearTomlCache();
  }
});
