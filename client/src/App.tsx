import { useEffect, useMemo, useState } from "react";
import { api, getToken, setToken, type Group, type User } from "./api";

type Step = "wallet" | "group" | "loan" | "kyc" | "cash" | "shop";

function fromErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function splitName(name: string): { first_name: string; last_name: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] || "Trader";
  const rest = parts.slice(1).join(" ");
  return {
    first_name: first,
    last_name: rest || (first === "Thabo" ? "Mokoena" : ""),
  };
}

function memberIdsOf(group: Group): string[] {
  if (Array.isArray(group.memberIds)) return group.memberIds;
  try {
    const parsed = JSON.parse(group.member_ids || "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Demo accounts share a timestamp in the email. Show only that trio, not every past run. */
function demoPeers(me: User, users: User[]): User[] {
  const others = users.filter((user) => user.id !== me.id);
  const stamp = me.email.match(/\.(\d+)@zao\.local$/)?.[1];
  if (!stamp) return others;
  const cohort = others.filter((user) => user.email.endsWith(`.${stamp}@zao.local`));
  return cohort.length >= 2 ? cohort : others;
}

function loanStatus(group?: Group): string {
  return group?.loan?.status ?? "NONE";
}

function signedCount(group?: Group): number {
  if (!group?.loan?.signatures) return 0;
  try {
    return (JSON.parse(group.loan.signatures) as string[]).length;
  } catch {
    return 0;
  }
}

export default function App() {
  const [step, setStep] = useState<Step>("wallet");
  const [me, setMe] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [apiUp, setApiUp] = useState<boolean | null>(null);

  const myGroups = useMemo(
    () => (me ? groups.filter((g) => memberIdsOf(g).includes(me.id)) : []),
    [groups, me],
  );

  async function refresh() {
    try {
      await api.health();
      setApiUp(true);
    } catch {
      setApiUp(false);
      return;
    }
    const token = getToken();
    if (token) {
      try {
        setMe((await api.me()).user);
      } catch {
        setToken(null);
        setMe(null);
      }
    }
    try {
      setUsers((await api.users()).users);
    } catch {
      setUsers([]);
    }
    try {
      setGroups((await api.groups()).groups);
    } catch {
      setGroups([]);
    }
  }

  useEffect(() => {
    refresh().catch((err) => setError(fromErr(err)));
  }, []);

  function note(message: string) {
    setError("");
    setStatus(message);
  }

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await work();
    } catch (err) {
      setError(fromErr(err));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Stellar testnet · South Africa</p>
          <h1>Zao</h1>
          <p>Borrow together. Pay back in 30 days. 10% flat. No bank account needed.</p>
        </div>
        {me ? (
          <div className="who">
            <strong>{me.name}</strong>
            <span data-testid="kyc-badge">KYC {me.kycStatus === "ACCEPTED" ? "ACCEPTED" : me.kycStatus}</span>
            <button
              className="link"
              onClick={() => {
                setToken(null);
                setMe(null);
                note("Signed out.");
                setStep("wallet");
              }}
            >
              Sign out
            </button>
          </div>
        ) : (
          <p className="muted">Start with a wallet. We keep the secret for you.</p>
        )}
      </header>

      {apiUp === false && (
        <div className="banner error">The API is not running. In another terminal: <code>cd backend && npm run dev</code></div>
      )}
      {error && <div className="banner error">{error}</div>}
      {status && <div className="banner ok">{status}</div>}
      {busy && <div className="banner muted">Working: {busy}… this can take a few seconds on testnet.</div>}

      <nav>
        {(
          [
            ["wallet", "1. Wallet"],
            ["group", "2. Group"],
            ["loan", "3. Loan"],
            ["kyc", "4. KYC & pay"],
            ["cash", "5. Cash out"],
            ["shop", "6. Shop"],
          ] as [Step, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            data-testid={`nav-${id}`}
            className={step === id ? "active" : ""}
            onClick={() => setStep(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {step === "wallet" && (
        <WalletStep
          me={me}
          users={users}
          busy={Boolean(busy)}
          onAuth={async (user, token) => {
            setToken(token);
            setMe(user);
            await refresh();
            note(`Hi ${user.name}. Your testnet wallet is ready.`);
            setStep("group");
          }}
          run={run}
        />
      )}
      {step === "group" && (
        <GroupStep
          me={me}
          users={users}
          groups={myGroups}
          busy={Boolean(busy)}
          run={run}
          onDone={async (message) => {
            await refresh();
            note(message);
            setStep("loan");
          }}
        />
      )}
      {step === "loan" && (
        <LoanStep
          me={me}
          groups={myGroups}
          busy={Boolean(busy)}
          run={run}
          refresh={refresh}
          note={note}
          onSigned={() => setStep("kyc")}
        />
      )}
      {step === "kyc" && (
        <KycStep
          me={me}
          groups={myGroups}
          busy={Boolean(busy)}
          run={run}
          refresh={refresh}
          note={note}
          onPaid={() => setStep("cash")}
        />
      )}
      {step === "cash" && (
        <CashStep
          me={me}
          groups={myGroups}
          busy={Boolean(busy)}
          run={run}
          refresh={refresh}
          note={note}
        />
      )}
      {step === "shop" && (
        <ShopStep me={me} users={users} busy={Boolean(busy)} run={run} note={note} />
      )}
    </div>
  );
}

function WalletStep({
  me,
  users,
  busy,
  onAuth,
  run,
}: {
  me: User | null;
  users: User[];
  busy: boolean;
  onAuth: (user: User, token: string) => Promise<void>;
  run: (label: string, work: () => Promise<void>) => Promise<void>;
}) {
  const [name, setName] = useState("Thabo");
  const [email, setEmail] = useState("thabo@zao.local");
  return (
    <div className="card">
      <h2>Get a wallet</h2>
      <p className="muted">
        We create a Stellar account for you and fund it on testnet. You never see the secret key.
      </p>
      <button
        className="primary"
        data-testid="demo-start"
        disabled={busy}
        onClick={() =>
          run("creating 3 demo traders", async () => {
            const res = await api.demoStart();
            await onAuth(res.leader, res.token);
          })
        }
      >
        Try the demo (creates Thabo, Lerato and Sipho)
      </button>
      <p className="divider">or create your own</p>
      <div className="row">
        <div>
          <label htmlFor="name">Your name</label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>
      <div className="actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run("creating wallet", async () => {
              const res = await api.register(name, email);
              await onAuth(res.user, res.token);
            })
          }
        >
          Create wallet
        </button>
        <button
          className="ghost"
          disabled={busy}
          onClick={() =>
            run("signing in", async () => {
              const res = await api.login(email);
              await onAuth(res.user, res.token);
            })
          }
        >
          I already have one
        </button>
      </div>
      {me && (
        <p className="mono quiet">
          {me.publicKey}
        </p>
      )}
      {users.length > 0 && (
        <>
          <label htmlFor="switch">Switch person</label>
          <select
            id="switch"
            value={me?.email ?? ""}
            disabled={busy}
            onChange={(e) => {
              const emailValue = e.target.value;
              if (!emailValue) return;
              void run("switching", async () => {
                const res = await api.login(emailValue);
                await onAuth(res.user, res.token);
              });
            }}
          >
            <option value="">Choose someone…</option>
            {users.map((u) => (
              <option key={u.id} value={u.email}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}

function GroupStep({
  me,
  users,
  groups,
  busy,
  run,
  onDone,
}: {
  me: User | null;
  users: User[];
  groups: Group[];
  busy: boolean;
  run: (label: string, work: () => Promise<void>) => Promise<void>;
  onDone: (message: string) => Promise<void>;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  if (!me) {
    return (
      <div className="card">
        <h2>Form a group</h2>
        <p className="muted">Create a wallet first. Groups are 3–5 people who trust each other.</p>
      </div>
    );
  }
  const others = demoPeers(me, users);
  return (
    <div className="card">
      <h2>Form a group of 3–5</h2>
      <p className="muted">You are the leader. Tick at least two friends. If you used the demo, pick Lerato and Sipho.</p>
      {others.length === 0 && (
        <p className="muted">No other wallets yet. Go back and tap “Try the demo”, or create two more wallets.</p>
      )}
      <div className="members">
        {others.map((user) => (
          <label key={user.id}>
            <input
              type="checkbox"
              data-testid={`pick-${user.name.toLowerCase()}`}
              checked={picked.includes(user.id)}
              onChange={(e) =>
                setPicked((cur) =>
                  e.target.checked ? [...cur, user.id] : cur.filter((id) => id !== user.id),
                )
              }
            />
            {user.name}
            <span className="quiet">{user.email}</span>
          </label>
        ))}
      </div>
      <button
        className="primary"
        data-testid="create-group"
        disabled={busy || picked.length < 2}
        onClick={() =>
          run("creating group", async () => {
            const res = await api.createGroup(picked);
            await onDone(`Group #${res.id} is on-chain. Next: ask for a loan.`);
          })
        }
      >
        Create group
      </button>
      {groups.length > 0 && (
        <ul className="list">
          {groups.map((g) => (
            <li key={g.id}>
              Group #{g.id} · {(g.members ?? []).map((m) => m.name).join(", ") || "members"} ·{" "}
              {loanStatus(g)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LoanStep({
  me,
  groups,
  busy,
  run,
  refresh,
  note,
  onSigned,
}: {
  me: User | null;
  groups: Group[];
  busy: boolean;
  run: (label: string, work: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
  note: (msg: string) => void;
  onSigned: () => void;
}) {
  const [groupId, setGroupId] = useState(groups[0]?.id ?? 0);
  const [amount, setAmount] = useState("2");
  useEffect(() => {
    if (groups[0] && !groups.some((g) => g.id === groupId)) {
      setGroupId(groups[0].id);
    }
  }, [groups, groupId]);
  const group = groups.find((g) => g.id === groupId);
  const members = group?.members ?? [];
  const need = members.length || 3;
  const have = signedCount(group);
  const status = loanStatus(group);

  if (!me) {
    return (
      <div className="card">
        <h2>Loan</h2>
        <p className="muted">Sign in first.</p>
      </div>
    );
  }
  if (groups.length === 0) {
    return (
      <div className="card">
        <h2>Loan</h2>
        <p className="muted">Create a group first. You need 3–5 people.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Ask, sign, get paid</h2>
      <label htmlFor="group">Your group</label>
      <select id="group" value={groupId} onChange={(e) => setGroupId(Number(e.target.value))}>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            Group #{g.id} · {loanStatus(g)}
          </option>
        ))}
      </select>
      <p className="muted">
        Status: {status === "NONE" ? "no loan yet" : status}. Signatures: {have}/{need}.
        You repay <strong>{amount || "0"} USDC + 10%</strong> in 30 days.
      </p>
      <label htmlFor="amount">How much USDC?</label>
      <input id="amount" data-testid="loan-amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <div className="actions">
        <button
          className="primary"
          data-testid="request-loan"
          disabled={busy}
          onClick={() =>
            run("requesting loan", async () => {
              const res = await api.requestLoan(groupId, amount);
              await refresh();
              note(`Loan requested. ${res.tx.expert}`);
            })
          }
        >
          1. Request loan
        </button>
        <button
          className="ghost"
          data-testid="sign-all"
          disabled={busy || status === "NONE"}
          onClick={() =>
            run("collecting signatures", async () => {
              const res = await api.signAll(groupId);
              await refresh();
              note(`Everyone signed (${res.signatures.length} wallets). Next: KYC.`);
              onSigned();
            })
          }
        >
          2. Everyone signs
        </button>
      </div>
      <p className="muted">After every member signs, the KYC/AML gate must pass before payout.</p>
    </div>
  );
}

function KycStep({
  me,
  groups,
  busy,
  run,
  refresh,
  note,
  onPaid,
}: {
  me: User | null;
  groups: Group[];
  busy: boolean;
  run: (label: string, work: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
  note: (msg: string) => void;
  onPaid: () => void;
}) {
  const [groupId, setGroupId] = useState(groups[0]?.id ?? 0);
  const [first, setFirst] = useState(() => (me ? splitName(me.name).first_name : "Thabo"));
  const [last, setLast] = useState(() => (me ? splitName(me.name).last_name : "Mokoena"));
  const [email, setEmail] = useState(me?.email ?? "");
  const [gate, setGate] = useState<{
    allowed: boolean;
    reason: string;
    kycStatus: string;
    onchainKyc: boolean;
  } | null>(null);
  const [paid, setPaid] = useState<{ expert: string; hash: string } | null>(null);

  useEffect(() => {
    if (groups[0] && !groups.some((g) => g.id === groupId)) setGroupId(groups[0].id);
  }, [groups, groupId]);

  useEffect(() => {
    if (!groupId) return;
    api
      .gate(groupId)
      .then(setGate)
      .catch(() => setGate(null));
  }, [groupId, me?.kycStatus]);

  const group = groups.find((g) => g.id === groupId);
  const have = signedCount(group);
  const need = (group?.members ?? []).length || 3;
  const signed = have >= need && loanStatus(group) !== "NONE";

  if (!me) {
    return (
      <div className="card">
        <h2>KYC / AML gate</h2>
        <p className="muted">Sign in first.</p>
      </div>
    );
  }

  const blockedReason =
    gate && !gate.allowed
      ? gate.reason
      : !signed
        ? "Everyone in the group must sign first."
        : me.kycStatus !== "ACCEPTED"
          ? `KYC/AML gate: disbursement blocked until ACCEPTED (current: ${me.kycStatus})`
          : null;
  const canPay = Boolean(signed && gate?.allowed && me.kycStatus === "ACCEPTED" && !paid);

  return (
    <div className="card" data-testid="kyc-card">
      <h2>KYC check, then payout</h2>
      <p className="muted">
        The API and the lending_pool contract both require the leader to be KYC-approved. AML also
        blocks oversized amounts and denylisted addresses.
      </p>
      {groups.length > 0 && (
        <>
          <label htmlFor="kyc-group">Group</label>
          <select
            id="kyc-group"
            data-testid="kyc-group"
            value={groupId}
            onChange={(e) => setGroupId(Number(e.target.value))}
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                Group #{g.id} · {loanStatus(g)}
              </option>
            ))}
          </select>
        </>
      )}
      <p className="status-pill" data-testid="kyc-status">
        Anchor KYC: <strong>{me.kycStatus}</strong>
        {gate ? ` · on-chain: ${gate.onchainKyc ? "approved" : "not approved"}` : ""}
      </p>
      <div className="row">
        <div>
          <label htmlFor="kyc-first">First name</label>
          <input id="kyc-first" data-testid="kyc-first" value={first} onChange={(e) => setFirst(e.target.value)} />
        </div>
        <div>
          <label htmlFor="kyc-last">Last name</label>
          <input id="kyc-last" data-testid="kyc-last" value={last} onChange={(e) => setLast(e.target.value)} />
        </div>
      </div>
      <label htmlFor="kyc-email">Email</label>
      <input id="kyc-email" data-testid="kyc-email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <div className="actions">
        <button
          className="primary"
          data-testid="kyc-submit"
          disabled={busy}
          onClick={() =>
            run("submitting KYC", async () => {
              const res = await api.kyc({
                first_name: first,
                last_name: last,
                email_address: email || me.email,
              });
              await refresh();
              if (groupId) setGate(await api.gate(groupId));
              note(`KYC status: ${res.status}${res.kycOnchain?.expert ? `. On-chain ${res.kycOnchain.expert}` : ""}`);
            })
          }
        >
          Submit KYC to the anchor
        </button>
        <button
          className="ghost"
          data-testid="kyc-refresh"
          disabled={busy}
          onClick={() =>
            run("checking KYC", async () => {
              const res = await api.kycStatus();
              await refresh();
              if (groupId) setGate(await api.gate(groupId));
              note(`KYC status: ${res.status}`);
            })
          }
        >
          Refresh status
        </button>
      </div>
      {blockedReason && (
        <div className="banner error gate-block" data-testid="gate-reason">
          Disburse blocked: {blockedReason}
        </div>
      )}
      <button
        className="primary"
        data-testid="disburse"
        disabled={busy || !canPay}
        title={blockedReason ?? "Pay the group leader"}
        onClick={() =>
          run("paying out", async () => {
            const res = await api.disburse(groupId);
            await refresh();
            setPaid({ hash: res.tx.hash, expert: res.tx.expert });
            note(`Paid to the leader. ${res.tx.expert}`);
          })
        }
      >
        Disburse to group leader
      </button>
      {paid && (
        <>
          <p className="ok" data-testid="disburse-success">
            Disbursed.{" "}
            <a className="expert-link" href={paid.expert} target="_blank" rel="noreferrer">
              {paid.expert}
            </a>
          </p>
          <button className="ghost" data-testid="goto-cash" onClick={onPaid}>
            Continue to cash out
          </button>
        </>
      )}
    </div>
  );
}

function CashStep({
  me,
  groups,
  busy,
  run,
  refresh,
  note,
}: {
  me: User | null;
  groups: Group[];
  busy: boolean;
  run: (label: string, work: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
  note: (msg: string) => void;
}) {
  const [amount, setAmount] = useState("1");
  const [groupId, setGroupId] = useState(groups[0]?.id ?? 0);
  const [score, setScore] = useState<number | null>(null);
  useEffect(() => {
    if (groups[0] && !groups.some((g) => g.id === groupId)) setGroupId(groups[0].id);
  }, [groups, groupId]);

  if (!me) {
    return (
      <div className="card">
        <h2>Cash out and repay</h2>
        <p className="muted">Sign in first.</p>
      </div>
    );
  }
  const names = splitName(me.name);

  return (
    <div className="card">
      <h2>Cash out and repay</h2>
      <p className="muted">
        KYC is required before cash-out and payout. Then repay 110% from the leader’s wallet.
      </p>
      <div className="actions">
        <button
          className="primary"
          data-testid="cash-kyc"
          disabled={busy}
          onClick={() =>
            run("submitting KYC", async () => {
              const res = await api.kyc({
                first_name: names.first_name,
                last_name: names.last_name,
                email_address: me.email,
              });
              await refresh();
              note(`KYC status: ${res.status}`);
            })
          }
        >
          Submit KYC as {me.name}
        </button>
      </div>
      <label htmlFor="withdraw">Cash-out amount (USDC)</label>
      <input id="withdraw" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <button
        className="primary"
        data-testid="cash-out"
        disabled={busy}
        onClick={() =>
          run("opening cash-out", async () => {
            const res = await api.withdraw(amount);
            note("Complete cash-out in the new tab. We do not fake settlement.");
            window.open(res.url, "_blank", "noopener,noreferrer");
          })
        }
      >
        Open cash-out with the anchor
      </button>
      {groups.length > 0 && (
        <>
          <label htmlFor="repay-group">Repay this group</label>
          <select id="repay-group" value={groupId} onChange={(e) => setGroupId(Number(e.target.value))}>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                Group #{g.id} · {loanStatus(g)}
              </option>
            ))}
          </select>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              run("repaying 110%", async () => {
                const res = await api.repay(groupId);
                await refresh();
                note(`Repaid. ${res.tx.expert}`);
              })
            }
          >
            Repay principal + 10%
          </button>
        </>
      )}
      <button
        className="ghost"
        disabled={busy}
        onClick={() =>
          run("reading reputation", async () => {
            const res = await api.reputation(me.id);
            setScore(res.score);
            note(`${me.name} score: ${res.score}`);
          })
        }
      >
        Show my reputation
      </button>
      {score !== null && <p className="ok">On-chain score: {score}</p>}
    </div>
  );
}

function ShopStep({
  me,
  users,
  busy,
  run,
  note,
}: {
  me: User | null;
  users: User[];
  busy: boolean;
  run: (label: string, work: () => Promise<void>) => Promise<void>;
  note: (msg: string) => void;
}) {
  const sellers = users.filter((u) => u.id !== me?.id);
  const [sellerId, setSellerId] = useState(sellers[0]?.id ?? "");
  const [amount, setAmount] = useState("2");
  const [escrowId, setEscrowId] = useState<number | null>(null);
  useEffect(() => {
    if (sellers[0] && !sellers.some((s) => s.id === sellerId)) {
      setSellerId(sellers[0].id);
    }
  }, [sellers, sellerId]);

  if (!me) {
    return (
      <div className="card">
        <h2>Shop with escrow</h2>
        <p className="muted">Sign in first.</p>
      </div>
    );
  }
  if (sellers.length === 0) {
    return (
      <div className="card">
        <h2>Shop with escrow</h2>
        <p className="muted">Create another wallet to act as the seller.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Shop with escrow</h2>
      <p className="muted">Pay USDC into escrow. Confirm delivery to release it to the seller.</p>
      <label htmlFor="seller">Seller</label>
      <select id="seller" value={sellerId} onChange={(e) => setSellerId(e.target.value)}>
        {sellers.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      <label htmlFor="escrow-amount">Amount (USDC)</label>
      <input id="escrow-amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <div className="actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            run("creating escrow", async () => {
              const res = await api.createEscrow(sellerId, amount);
              setEscrowId(res.id);
              note(`Escrow #${res.id} created.`);
            })
          }
        >
          1. Create
        </button>
        <button
          className="ghost"
          disabled={busy || !escrowId}
          onClick={() =>
            run("funding escrow", async () => {
              if (!escrowId) throw new Error("Create an escrow first.");
              await api.fundEscrow(escrowId);
              note(`Escrow #${escrowId} funded.`);
            })
          }
        >
          2. Fund
        </button>
        <button
          className="ghost"
          disabled={busy || !escrowId}
          onClick={() =>
            run("releasing to seller", async () => {
              if (!escrowId) throw new Error("Create an escrow first.");
              await api.confirmEscrow(escrowId);
              note("Released to the seller.");
            })
          }
        >
          3. Confirm delivery
        </button>
      </div>
    </div>
  );
}
