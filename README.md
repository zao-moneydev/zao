# zao
Zao is a decentralized micro-lending protocol on Stellar that gives unbanked individuals and informal traders access to fair, fast, and affordable credit through group-backed loans, USDC disbursement, and anchor cash-out. Currently seeking funding to build the MVP.


# Zao

**Community-based lending on Stellar.**

Zao is a decentralized micro-lending protocol built on Stellar that gives unbanked individuals and informal traders in South Africa access to fair, fast, and affordable credit. Using Soroban smart contracts and USDC, Zao enables trusted groups of 3–5 people to access 30-day micro-loans at 10% flat interest with no bank account required.

---

## The Problem

Unbanked individuals and informal traders in South Africa are locked out of affordable credit. Banks require paperwork, collateral, or bank accounts they do not have. This forces them to borrow from Amashonisa at interest rates of up to 50% per month, trapping them in cycles of debt.

Even community lending schemes still rely on manual cash and bank transfers: slow, risky, and impossible for the unbanked.

The problem is not a lack of demand. It is a lack of access to fair, fast, low-cost credit.

## The Solution

Zao bridges the gap using Stellar:

- **Group-backed loans:** 3–5 trusted individuals apply together and hold each other accountable.
- **30-day terms:** Full repayment of principal + 10% flat interest as a lump sum.
- **Instant USDC disbursement:** Funds settle in seconds on Stellar.
- **Anchor cash-out:** Users convert USDC to local currency via SEP-24 anchors with no bank account needed.
- **Transparent on-chain repayment:** Every loan and repayment is recorded on Soroban smart contracts.

## How It Works

1. A group of 3–5 creates a loan request
2. All members sign the agreement via their Stellar wallets
3. Zao issues a USDC loan to the group leader
4. The group leader cashes out to local fiat via an anchor
5. At day 30, the group repays principal + 10% interest
6. Repayment is recorded on-chain and reputation increases

## Architecture

| Layer | Technology | Purpose |
|-------|------------|---------|
| Blockchain | Stellar + Soroban (Rust) | Trustless lending pools, escrow, reputation |
| Backend | Node.js + TypeScript + Stellar SDK | API, invisible wallets, anchor integration |
| Mobile App | Flutter (iOS + Android) | User-facing app for borrowers and traders |
| Anchor Layer | SEP-24 / SEP-31 | Fiat on/off-ramps for ZAR and SADC currencies |

## Smart Contracts

- **Lending Pool Contract:** Group creation, USDC disbursement, 10% repayment logic.
- **Marketplace Escrow Contract:** Buyer funds held in escrow until delivery confirmation.
- **Reputation Contract:** On-chain credit history for each participant.

## Tech Stack

- **Blockchain:** Stellar, Soroban
- **Smart Contracts:** Rust
- **Backend:** Node.js, TypeScript, Stellar SDK
- **Mobile:** Flutter, `stellar_flutter_sdk`
- **Stablecoin:** USDC on Stellar
- **Anchors:** SEP-24 compliant (Paychant, Yellow Card, etc.)

## Roadmap

### Phase 1: MVP (Planned)

- [ ] Soroban lending pool contract
- [ ] Marketplace escrow contract
- [ ] Testnet anchor integration
- [ ] KYC/AML gate demo
- [ ] End-to-end testnet demo video

### Phase 2: Pilot

- [ ] Mainnet deployment
- [ ] Flutter mobile app (beta)
- [ ] Onboard 50 users in South Africa
- [ ] Anchor partnership for ZAR cash-out

### Phase 3: Scale

- [ ] Marketplace launch
- [ ] U-Send courier integration
- [ ] Expand to SADC regions
- [ ] On-chain reputation scoring

## Project Status

Zao is currently seeking funding to build an MVP that delivers two Soroban smart contracts (lending pool + escrow), testnet anchor payout integration, and a KYC/AML gate demo. Once funded, development will begin immediately.

## Contributing

We welcome contributions from developers, designers, and community builders.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Contact

**Project Lead:** Natasha Mumba
[sintraworktools@gmail.com](mailto:sintraworktools@gmail.com)

