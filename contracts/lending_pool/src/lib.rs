#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, token,
    Address, Env, Vec,
};

#[contractclient(name = "ReputationClient")]
pub trait ReputationTrait {
    fn record_repayment(env: Env, member: Address, loan_id: u64, amount: i128);
    fn record_default(env: Env, member: Address, loan_id: u64);
}

pub const MIN_MEMBERS: u32 = 3;
pub const MAX_MEMBERS: u32 = 5;
pub const INTEREST_BPS: u32 = 1_000; // 10%
pub const BPS_DENOMINATOR: i128 = 10_000;
pub const LOAN_TERM_SECONDS: u64 = 30 * 24 * 60 * 60;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InvalidGroupSize = 4,
    DuplicateMember = 5,
    LeaderNotMember = 6,
    GroupNotFound = 7,
    LoanNotFound = 8,
    InvalidAmount = 9,
    ActiveLoanExists = 10,
    NotGroupMember = 11,
    LoanNotRequested = 12,
    AlreadySigned = 13,
    MissingSignatures = 14,
    InsufficientPool = 15,
    LoanNotDisbursed = 16,
    LoanAlreadyClosed = 17,
    TooEarlyToDefault = 18,
    Overflow = 19,
    InsufficientDeposit = 20,
    InsufficientLiquidity = 21,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum LoanStatus {
    Requested = 1,
    Disbursed = 2,
    Repaid = 3,
    Defaulted = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Group {
    pub id: u64,
    pub leader: Address,
    pub members: Vec<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Loan {
    pub id: u64,
    pub group_id: u64,
    pub principal: i128,
    pub due_amount: i128,
    pub status: LoanStatus,
    pub signatures: Vec<Address>,
    pub disbursed_at: u64,
    pub due_at: u64,
    pub repaid_at: u64,
}

#[contracttype]
enum DataKey {
    Admin,
    Usdc,
    Reputation,
    Initialized,
    NextGroupId,
    NextLoanId,
    Group(u64),
    Loan(u64),
    GroupLoan(u64),
    LenderDeposit(Address),
}

#[contract]
pub struct LendingPool;

#[contractimpl]
impl LendingPool {
    pub fn initialize(
        env: Env,
        admin: Address,
        usdc: Address,
        reputation: Address,
    ) -> Result<(), Error> {
        admin.require_auth();
        if initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Usdc, &usdc);
        env.storage().instance().set(&DataKey::Reputation, &reputation);
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::NextGroupId, &1u64);
        env.storage().instance().set(&DataKey::NextLoanId, &1u64);
        env.storage().instance().extend_ttl(100_000, 100_000);
        Ok(())
    }

    pub fn create_group(
        env: Env,
        leader: Address,
        members: Vec<Address>,
    ) -> Result<u64, Error> {
        require_init(&env)?;
        leader.require_auth();
        validate_group(&leader, &members)?;

        let id: u64 = env.storage().instance().get(&DataKey::NextGroupId).unwrap();
        let group = Group {
            id,
            leader,
            members,
        };
        env.storage().persistent().set(&DataKey::Group(id), &group);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Group(id), 100_000, 100_000);
        env.storage().instance().set(&DataKey::NextGroupId, &(id + 1));
        env.events()
            .publish((symbol_short!("grp_new"), id), group.id);
        Ok(id)
    }

    pub fn request_loan(env: Env, group_id: u64, amount: i128) -> Result<u64, Error> {
        require_init(&env)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let group = load_group(&env, group_id)?;
        group.leader.require_auth();

        if let Some(loan_id) = current_loan_id(&env, group_id) {
            let existing = load_loan(&env, loan_id)?;
            if existing.status == LoanStatus::Requested || existing.status == LoanStatus::Disbursed
            {
                return Err(Error::ActiveLoanExists);
            }
        }

        let due = due_amount(amount)?;
        let id: u64 = env.storage().instance().get(&DataKey::NextLoanId).unwrap();
        let loan = Loan {
            id,
            group_id,
            principal: amount,
            due_amount: due,
            status: LoanStatus::Requested,
            signatures: Vec::new(&env),
            disbursed_at: 0,
            due_at: 0,
            repaid_at: 0,
        };
        env.storage().persistent().set(&DataKey::Loan(id), &loan);
        env.storage()
            .persistent()
            .set(&DataKey::GroupLoan(group_id), &id);
        env.storage().instance().set(&DataKey::NextLoanId, &(id + 1));
        env.events()
            .publish((symbol_short!("loan_req"), id), (group_id, amount));
        Ok(id)
    }

    pub fn sign(env: Env, group_id: u64, member: Address) -> Result<(), Error> {
        require_init(&env)?;
        member.require_auth();
        let group = load_group(&env, group_id)?;
        if !contains(&group.members, &member) {
            return Err(Error::NotGroupMember);
        }
        let loan_id = current_loan_id(&env, group_id).ok_or(Error::LoanNotFound)?;
        let mut loan = load_loan(&env, loan_id)?;
        if loan.status != LoanStatus::Requested {
            return Err(Error::LoanNotRequested);
        }
        if contains(&loan.signatures, &member) {
            return Err(Error::AlreadySigned);
        }
        loan.signatures.push_back(member);
        save_loan(&env, &loan);
        env.events()
            .publish((symbol_short!("signed"), loan_id), loan.signatures.len());
        Ok(())
    }

    pub fn disburse(env: Env, group_id: u64) -> Result<(), Error> {
        require_init(&env)?;
        let group = load_group(&env, group_id)?;
        let loan_id = current_loan_id(&env, group_id).ok_or(Error::LoanNotFound)?;
        let mut loan = load_loan(&env, loan_id)?;
        if loan.status != LoanStatus::Requested {
            return Err(Error::LoanNotRequested);
        }
        if !all_signed(&group.members, &loan.signatures) {
            return Err(Error::MissingSignatures);
        }

        let usdc = usdc_client(&env);
        let pool = env.current_contract_address();
        if usdc.balance(&pool) < loan.principal {
            return Err(Error::InsufficientPool);
        }
        usdc.transfer(&pool, &group.leader, &loan.principal);

        let now = env.ledger().timestamp();
        loan.status = LoanStatus::Disbursed;
        loan.disbursed_at = now;
        loan.due_at = now.saturating_add(LOAN_TERM_SECONDS);
        save_loan(&env, &loan);
        env.events()
            .publish((symbol_short!("disburse"), loan.id), loan.principal);
        Ok(())
    }

    pub fn repay(env: Env, group_id: u64, payer: Address) -> Result<(), Error> {
        require_init(&env)?;
        payer.require_auth();
        let group = load_group(&env, group_id)?;
        let loan_id = current_loan_id(&env, group_id).ok_or(Error::LoanNotFound)?;
        let mut loan = load_loan(&env, loan_id)?;
        if loan.status != LoanStatus::Disbursed {
            return Err(Error::LoanNotDisbursed);
        }

        let usdc = usdc_client(&env);
        let pool = env.current_contract_address();
        usdc.transfer(&payer, &pool, &loan.due_amount);

        loan.status = LoanStatus::Repaid;
        loan.repaid_at = env.ledger().timestamp();
        save_loan(&env, &loan);

        let reputation = ReputationClient::new(
            &env,
            &env.storage().instance().get(&DataKey::Reputation).unwrap(),
        );
        for member in group.members.iter() {
            reputation.record_repayment(&member, &loan.id, &loan.due_amount);
        }
        env.events()
            .publish((symbol_short!("repaid"), loan.id), loan.due_amount);
        Ok(())
    }

    pub fn mark_default(env: Env, group_id: u64) -> Result<(), Error> {
        require_init(&env)?;
        let group = load_group(&env, group_id)?;
        let loan_id = current_loan_id(&env, group_id).ok_or(Error::LoanNotFound)?;
        let mut loan = load_loan(&env, loan_id)?;
        match loan.status {
            LoanStatus::Repaid | LoanStatus::Defaulted => return Err(Error::LoanAlreadyClosed),
            LoanStatus::Requested => return Err(Error::LoanNotDisbursed),
            LoanStatus::Disbursed => {}
        }
        if env.ledger().timestamp() < loan.due_at {
            return Err(Error::TooEarlyToDefault);
        }

        loan.status = LoanStatus::Defaulted;
        save_loan(&env, &loan);

        let reputation = ReputationClient::new(
            &env,
            &env.storage().instance().get(&DataKey::Reputation).unwrap(),
        );
        for member in group.members.iter() {
            reputation.record_default(&member, &loan.id);
        }
        env.events()
            .publish((symbol_short!("default"), loan.id), loan.principal);
        Ok(())
    }

    pub fn deposit(env: Env, from: Address, amount: i128) -> Result<(), Error> {
        require_init(&env)?;
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let usdc = usdc_client(&env);
        usdc.transfer(&from, &env.current_contract_address(), &amount);
        let key = DataKey::LenderDeposit(from.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(current + amount));
        env.events()
            .publish((symbol_short!("deposit"), from), amount);
        Ok(())
    }

    pub fn withdraw(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        require_init(&env)?;
        to.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let key = DataKey::LenderDeposit(to.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if current < amount {
            return Err(Error::InsufficientDeposit);
        }
        let usdc = usdc_client(&env);
        let pool = env.current_contract_address();
        if usdc.balance(&pool) < amount {
            return Err(Error::InsufficientLiquidity);
        }
        env.storage().persistent().set(&key, &(current - amount));
        usdc.transfer(&pool, &to, &amount);
        env.events()
            .publish((symbol_short!("withdraw"), to), amount);
        Ok(())
    }

    pub fn get_group(env: Env, group_id: u64) -> Result<Group, Error> {
        load_group(&env, group_id)
    }

    pub fn get_loan(env: Env, loan_id: u64) -> Result<Loan, Error> {
        load_loan(&env, loan_id)
    }

    pub fn get_group_loan(env: Env, group_id: u64) -> Result<Loan, Error> {
        let loan_id = current_loan_id(&env, group_id).ok_or(Error::LoanNotFound)?;
        load_loan(&env, loan_id)
    }

    pub fn get_due_amount(_env: Env, principal: i128) -> Result<i128, Error> {
        due_amount(principal)
    }

    pub fn get_deposit(env: Env, lender: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::LenderDeposit(lender))
            .unwrap_or(0)
    }

    pub fn get_usdc(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Usdc)
            .ok_or(Error::NotInitialized)
    }

    pub fn get_reputation(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Reputation)
            .ok_or(Error::NotInitialized)
    }
}

fn initialized(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Initialized)
        .unwrap_or(false)
}

fn require_init(env: &Env) -> Result<(), Error> {
    if initialized(env) {
        Ok(())
    } else {
        Err(Error::NotInitialized)
    }
}

fn usdc_client(env: &Env) -> token::TokenClient<'_> {
    token::TokenClient::new(
        env,
        &env.storage().instance().get(&DataKey::Usdc).unwrap(),
    )
}

fn load_group(env: &Env, group_id: u64) -> Result<Group, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Group(group_id))
        .ok_or(Error::GroupNotFound)
}

fn load_loan(env: &Env, loan_id: u64) -> Result<Loan, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Loan(loan_id))
        .ok_or(Error::LoanNotFound)
}

fn save_loan(env: &Env, loan: &Loan) {
    env.storage().persistent().set(&DataKey::Loan(loan.id), loan);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::Loan(loan.id), 100_000, 100_000);
}

fn current_loan_id(env: &Env, group_id: u64) -> Option<u64> {
    env.storage().persistent().get(&DataKey::GroupLoan(group_id))
}

fn due_amount(principal: i128) -> Result<i128, Error> {
    let interest = principal
        .checked_mul(INTEREST_BPS as i128)
        .ok_or(Error::Overflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(Error::Overflow)?;
    principal.checked_add(interest).ok_or(Error::Overflow)
}

fn validate_group(leader: &Address, members: &Vec<Address>) -> Result<(), Error> {
    let n = members.len();
    if n < MIN_MEMBERS || n > MAX_MEMBERS {
        return Err(Error::InvalidGroupSize);
    }
    if !contains(members, leader) {
        return Err(Error::LeaderNotMember);
    }
    for i in 0..n {
        for j in (i + 1)..n {
            if members.get(i).unwrap() == members.get(j).unwrap() {
                return Err(Error::DuplicateMember);
            }
        }
    }
    Ok(())
}

fn contains(list: &Vec<Address>, item: &Address) -> bool {
    for value in list.iter() {
        if value == *item {
            return true;
        }
    }
    false
}

fn all_signed(members: &Vec<Address>, signatures: &Vec<Address>) -> bool {
    if signatures.len() != members.len() {
        return false;
    }
    for member in members.iter() {
        if !contains(signatures, &member) {
            return false;
        }
    }
    true
}

mod test;
