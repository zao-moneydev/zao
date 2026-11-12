const TOKEN_KEY = "zao_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string") return error;
  }
  return fallback;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new Error("Cannot reach the Zao server. Start the backend on port 3001.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(errorMessage(body, res.statusText || "Request failed"));
  }
  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean; contracts: Record<string, string> }>("/api/health"),
  register: (name: string, email: string) =>
    request<{ user: User; token: string }>("/api/users/register", {
      method: "POST",
      body: JSON.stringify({ name, email }),
    }),
  login: (email: string) =>
    request<{ user: User; token: string }>("/api/users/login", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  demoStart: () =>
    request<{ token: string; leader: User; members: User[] }>("/api/demo/start", {
      method: "POST",
    }),
  me: () => request<{ user: User }>("/api/users/me"),
  users: () => request<{ users: User[] }>("/api/users"),
  createGroup: (memberIds: string[]) =>
    request<{ id: number; tx: Tx }>("/api/groups", {
      method: "POST",
      body: JSON.stringify({ memberIds }),
    }),
  groups: () => request<{ groups: Group[] }>("/api/groups"),
  requestLoan: (groupId: number, amount: string) =>
    request<{ id: number; tx: Tx }>("/api/loans", {
      method: "POST",
      body: JSON.stringify({ groupId, amount }),
    }),
  sign: (groupId: number) => request<{ tx: Tx }>(`/api/loans/${groupId}/sign`, { method: "POST" }),
  signAll: (groupId: number) =>
    request<{ signatures: string[]; txs: Tx[] }>(`/api/loans/${groupId}/sign-all`, {
      method: "POST",
    }),
  disburse: (groupId: number) =>
    request<{ tx: Tx; gate?: { reason: string }; kycOnchain?: { hash: string | null; expert: string | null } }>(
      `/api/loans/${groupId}/disburse`,
      { method: "POST" },
    ),
  gate: (groupId: number) =>
    request<{
      allowed: boolean;
      reason: string;
      code: string;
      kycStatus: string;
      onchainKyc: boolean;
      amlMaxAmount: string;
    }>(`/api/loans/${groupId}/gate`),
  repay: (groupId: number) => request<{ tx: Tx }>(`/api/loans/${groupId}/repay`, { method: "POST" }),
  kyc: (fields: Record<string, string>) =>
    request<{ status: string; kycOnchain?: { hash: string | null; expert: string | null } }>("/api/anchor/kyc", {
      method: "POST",
      body: JSON.stringify(fields),
    }),
  kycStatus: () => request<{ status: string }>("/api/anchor/kyc"),
  withdraw: (amount: string) =>
    request<{ url: string; id: string }>("/api/anchor/withdraw", {
      method: "POST",
      body: JSON.stringify({ amount }),
    }),
  reputation: (userId: string) =>
    request<{ score: number; record?: { repayments?: number; defaults?: number } }>(
      `/api/reputation/${userId}`,
    ),
  createEscrow: (sellerId: string, amount: string) =>
    request<{ id: number; tx: Tx }>("/api/escrow", {
      method: "POST",
      body: JSON.stringify({ sellerId, amount }),
    }),
  fundEscrow: (id: number) => request<{ tx: Tx }>(`/api/escrow/${id}/fund`, { method: "POST" }),
  confirmEscrow: (id: number) =>
    request<{ tx: Tx }>(`/api/escrow/${id}/confirm`, { method: "POST" }),
};

export type Tx = { hash: string; expert: string };

export type User = {
  id: string;
  email: string;
  name: string;
  publicKey: string;
  kycStatus: string;
};

export type Loan = {
  id: number;
  status: string;
  signatures: string;
  principal: string;
  due_amount: string;
};

export type Group = {
  id: number;
  onchain_id: number;
  leader_id: string;
  member_ids: string;
  memberIds?: string[];
  members?: User[];
  create_tx: string;
  loan?: Loan | null;
};
