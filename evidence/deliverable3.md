# Deliverable 3 evidence — KYC/AML gate demo

Anchor: `https://testanchor.stellar.org`
Asset: `SRT:GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B`
Generated: 2026-11-12T19:32:35.171Z

## Contract IDs

| Contract | ID | Explorer |
|---|---|---|
| SRT SAC | `CBZVLMD5DBKIFSVU23WAVMJD25IRUBWCVAXGURPUPMB2CUNFBQN742UV` | https://stellar.expert/explorer/testnet/contract/CBZVLMD5DBKIFSVU23WAVMJD25IRUBWCVAXGURPUPMB2CUNFBQN742UV |
| reputation | `CCIIUDB47LYE6HJCRURMFJ4XOU7XARE2LSSPZOJNQA2IEZMY7E6DW2RE` | https://stellar.expert/explorer/testnet/contract/CCIIUDB47LYE6HJCRURMFJ4XOU7XARE2LSSPZOJNQA2IEZMY7E6DW2RE |
| lending_pool | `CBZGLCLXSEEYN44RKFIW5KDGTSCV4X5TW5DRJKRF5UXV5VPKPD4UZAEX` | https://stellar.expert/explorer/testnet/contract/CBZGLCLXSEEYN44RKFIW5KDGTSCV4X5TW5DRJKRF5UXV5VPKPD4UZAEX |
| marketplace_escrow | `CDOASBD2VSNG3SO6SF4OQHVGLY3EAA57JQHF34U4DW3MAMJB6UNUZMMQ` | https://stellar.expert/explorer/testnet/contract/CDOASBD2VSNG3SO6SF4OQHVGLY3EAA57JQHF34U4DW3MAMJB6UNUZMMQ |

## Gate results (live testnet)

- **Blocked (off-chain):** API `POST /loans/:id/disburse` returned **403** — KYC/AML gate: disbursement blocked until the anchor reports ACCEPTED (current: NEEDS_INFO)
- **Blocked (on-chain):** `disburse` simulation against live `lending_pool` — **Contract error #22 (KycRequired)**
- **Allowed:** disbursement tx [`6bac3ff00e516b453992d99cbfebdd3134d99f0312ee273f8a887f9332989a95`](https://stellar.expert/explorer/testnet/tx/6bac3ff00e516b453992d99cbfebdd3134d99f0312ee273f8a887f9332989a95)

## Transaction hashes

- **create_group (3 members)**: [`b782cb0c98f0a2d6fa5a9e784c008bd774943f74b4ffe00e1b068b87df063f0f`](https://stellar.expert/explorer/testnet/tx/b782cb0c98f0a2d6fa5a9e784c008bd774943f74b4ffe00e1b068b87df063f0f)
- **request_loan 2 SRT**: [`d7fa2abde7a223bab8013635bb1adbef5c3e027ed1268564b510a7e05ddc2b71`](https://stellar.expert/explorer/testnet/tx/d7fa2abde7a223bab8013635bb1adbef5c3e027ed1268564b510a7e05ddc2b71)
- **sign**: [`e705a638682bd6fe223e63197b4de2a3c747213ab4dfef4115a78d8a6952e6f6`](https://stellar.expert/explorer/testnet/tx/e705a638682bd6fe223e63197b4de2a3c747213ab4dfef4115a78d8a6952e6f6)
- **sign**: [`55538e3c4ff2e9d1ca88561a0f019d87b0a9292f7579a68004abcbc2aa8cd479`](https://stellar.expert/explorer/testnet/tx/55538e3c4ff2e9d1ca88561a0f019d87b0a9292f7579a68004abcbc2aa8cd479)
- **sign**: [`7d33f006878c0574b748518beffdba28863462c4e6d57257c20628559701004c`](https://stellar.expert/explorer/testnet/tx/7d33f006878c0574b748518beffdba28863462c4e6d57257c20628559701004c)
- **disburse to group leader (allowed, API)**: [`6bac3ff00e516b453992d99cbfebdd3134d99f0312ee273f8a887f9332989a95`](https://stellar.expert/explorer/testnet/tx/6bac3ff00e516b453992d99cbfebdd3134d99f0312ee273f8a887f9332989a95)
- **set_kyc_approved (admin)**: [`2926351161c958950ac8bdead0d6e5c61538d3c3e7c8f2f177aadcd7613847ab`](https://stellar.expert/explorer/testnet/tx/2926351161c958950ac8bdead0d6e5c61538d3c3e7c8f2f177aadcd7613847ab)
- **disburse tx from API**: [`6bac3ff00e516b453992d99cbfebdd3134d99f0312ee273f8a887f9332989a95`](https://stellar.expert/explorer/testnet/tx/6bac3ff00e516b453992d99cbfebdd3134d99f0312ee273f8a887f9332989a95)
- **payment to withdraw_anchor_account**: [`2e527501757cd8fbaa42561f453ab27691231fa1f60ee7b12647b0c1e01e25cd`](https://stellar.expert/explorer/testnet/tx/2e527501757cd8fbaa42561f453ab27691231fa1f60ee7b12647b0c1e01e25cd)

## SEP-24 cash-out

- Transaction id: `e0b284e7-ae5c-483f-b263-fae154e19d61`
- Final status: **completed**
- Payment: [`2e527501757cd8fbaa42561f453ab27691231fa1f60ee7b12647b0c1e01e25cd`](https://stellar.expert/explorer/testnet/tx/2e527501757cd8fbaa42561f453ab27691231fa1f60ee7b12647b0c1e01e25cd)
- On-chain KYC flag tx: [`2926351161c958950ac8bdead0d6e5c61538d3c3e7c8f2f177aadcd7613847ab`](https://stellar.expert/explorer/testnet/tx/2926351161c958950ac8bdead0d6e5c61538d3c3e7c8f2f177aadcd7613847ab)

## Screenshots

| File | Caption |
|---|---|
| `evidence/screenshots/d3-01-wallet.png` | Leader wallet is ready (invisible key, funded on testnet). |
| `evidence/screenshots/d3-02-group.png` | Apply as a group of 3: Thabo (leader), Lerato and Sipho. |
| `evidence/screenshots/d3-03-loan-apply.png` | Request a 2 SRT group loan (30 days, 10% flat). |
| `evidence/screenshots/d3-04-sign.png` | Every member signed the loan with their invisible wallet. |
| `evidence/screenshots/d3-05-kyc-form.png` | KYC form (SEP-12). Disburse stays blocked until ACCEPTED. |
| `evidence/screenshots/d3-06-disburse-blocked.png` | Disburse disabled: KYC is NEEDS_INFO. Off-chain gate blocks payout. |
| `evidence/screenshots/d3-07-kyc-accepted.png` | Anchor KYC is ACCEPTED. |
| `evidence/screenshots/d3-08-disburse-success.png` | Disbursement succeeded; stellar.expert link on screen. |
| `evidence/screenshots/d3-09-cashout.png` | Cash out via the SEP-24 anchor. |
| `evidence/screenshots/d3-10-anchor-withdraw.png` | Hosted SEP-24 withdraw page. |

Demo script: [`evidence/demo-script.md`](demo-script.md)

## Tests

- Backend `npm test`: 19 passed, including KYC `NEEDS_INFO` / `PROCESSING` / `REJECTED`, AML amount, AML denylist, and ACCEPTED allow.
- On-chain contract: `disburse_fails_without_leader_kyc` in `contracts/lending_pool/src/test.rs` (error `#22 KycRequired`).

Nothing here is mocked. The blocked on-chain path is a live Soroban RPC simulation of `lending_pool.disburse` before `set_kyc_approved`. The allowed path is a submitted testnet transaction.
