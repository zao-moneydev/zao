# Deliverable 3 — 2–3 minute screen-recording script

Talk at a steady pace. The web demo is `http://localhost:5173` with `cd backend && npm run dev` and `cd client && npm run dev` already running. Create three wallets yourself: Thabo, Lerato, and Sipho.

**0:00–0:20 — Setup**  
“Zao is group micro-lending on Stellar testnet. Three traders share a loan. The pool only pays the leader after every member signs **and** KYC/AML passes — both in the API and in the `lending_pool` contract.”

**0:20–0:40 — Wallet and group**  
Create Thabo’s wallet, then sign out and create Lerato and Sipho. Sign back in as Thabo. **2. Group**. Tick Lerato and Sipho. Click **Create group**.  
“Each person got an invisible Stellar wallet. The group is now on-chain.”

**0:40–1:00 — Apply and sign**  
**3. Loan**. Amount `2`. **Request loan**, then **Everyone signs**.  
“All three wallets signed. Payout is still blocked — the leader has not passed KYC.”

**1:00–1:35 — Blocked path**  
**4. KYC & pay**. Point at the red banner and the disabled **Disburse** button.  
“Off-chain: the API refuses disburse while SEP-12 is `NEEDS_INFO`. On-chain: `disburse` returns contract error 22, `KycRequired`, until admin `set_kyc_approved`.”

**1:35–2:05 — KYC accepted**  
Fill first name, last name, email. **Submit KYC to the anchor**. Wait for **ACCEPTED**.  
“testanchor.stellar.org accepted the SEP-12 customer. The backend now calls `set_kyc_approved` so the contract agrees.”

**2:05–2:30 — Allowed disbursement**  
**Disburse to group leader**. Open the stellar.expert link.  
“This is the live testnet payout. Same gate that blocked us a minute ago now allows it.”

**2:30–2:50 — Cash out**  
**Continue to cash out**. **Open cash-out with the anchor**.  
“SEP-24 withdraw — the Deliverable 2 payout path — so the leader can take the loan off-chain.”

**End line**  
“KYC/AML gate: blocked without ACCEPTED, allowed after ACCEPTED, enforced in the API and on-chain.”
