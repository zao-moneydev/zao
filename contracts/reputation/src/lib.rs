#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Vec};

pub const REPAY_DELTA: i32 = 10;
pub const DEFAULT_DELTA: i32 = 20;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    WriterNotSet = 4,
    InvalidAmount = 5,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum EventKind {
    Repayment = 1,
    Default = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReputationEvent {
    pub kind: EventKind,
    pub loan_id: u64,
    pub amount: i128,
    pub timestamp: u64,
    pub delta: i32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReputationRecord {
    pub score: i32,
    pub repayments: u32,
    pub defaults: u32,
}

#[contracttype]
enum DataKey {
    Admin,
    Writer,
    Initialized,
    Record(Address),
    History(Address),
}

#[contract]
pub struct Reputation;

#[contractimpl]
impl Reputation {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        if is_initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().extend_ttl(100_000, 100_000);
        Ok(())
    }

    /// Only the lending pool (or current admin, once) may write scores.
    pub fn set_writer(env: Env, writer: Address) -> Result<(), Error> {
        require_admin(&env)?;
        env.storage().instance().set(&DataKey::Writer, &writer);
        Ok(())
    }

    pub fn record_repayment(
        env: Env,
        member: Address,
        loan_id: u64,
        amount: i128,
    ) -> Result<(), Error> {
        require_writer(&env)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        apply_event(
            &env,
            &member,
            ReputationEvent {
                kind: EventKind::Repayment,
                loan_id,
                amount,
                timestamp: env.ledger().timestamp(),
                delta: REPAY_DELTA,
            },
        );
        Ok(())
    }

    pub fn record_default(env: Env, member: Address, loan_id: u64) -> Result<(), Error> {
        require_writer(&env)?;
        apply_event(
            &env,
            &member,
            ReputationEvent {
                kind: EventKind::Default,
                loan_id,
                amount: 0,
                timestamp: env.ledger().timestamp(),
                delta: -DEFAULT_DELTA,
            },
        );
        Ok(())
    }

    pub fn get_score(env: Env, member: Address) -> i32 {
        load_record(&env, &member).score
    }

    pub fn get_record(env: Env, member: Address) -> ReputationRecord {
        load_record(&env, &member)
    }

    pub fn get_history(env: Env, member: Address) -> Vec<ReputationEvent> {
        env.storage()
            .persistent()
            .get(&DataKey::History(member))
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn get_admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    pub fn get_writer(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Writer)
            .ok_or(Error::WriterNotSet)
    }
}

fn is_initialized(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Initialized)
        .unwrap_or(false)
}

fn require_admin(env: &Env) -> Result<(), Error> {
    if !is_initialized(env) {
        return Err(Error::NotInitialized);
    }
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)?;
    admin.require_auth();
    Ok(())
}

fn require_writer(env: &Env) -> Result<(), Error> {
    if !is_initialized(env) {
        return Err(Error::NotInitialized);
    }
    let writer: Address = env
        .storage()
        .instance()
        .get(&DataKey::Writer)
        .ok_or(Error::WriterNotSet)?;
    writer.require_auth();
    Ok(())
}

fn load_record(env: &Env, member: &Address) -> ReputationRecord {
    env.storage()
        .persistent()
        .get(&DataKey::Record(member.clone()))
        .unwrap_or(ReputationRecord {
            score: 0,
            repayments: 0,
            defaults: 0,
        })
}

fn apply_event(env: &Env, member: &Address, event: ReputationEvent) {
    let mut record = load_record(env, member);
    if event.delta >= 0 {
        record.score = record.score.saturating_add(event.delta);
        record.repayments = record.repayments.saturating_add(1);
    } else {
        record.score = record.score.saturating_add(event.delta);
        record.defaults = record.defaults.saturating_add(1);
    }
    env.storage()
        .persistent()
        .set(&DataKey::Record(member.clone()), &record);

    let mut history: Vec<ReputationEvent> = env
        .storage()
        .persistent()
        .get(&DataKey::History(member.clone()))
        .unwrap_or_else(|| Vec::new(env));
    history.push_back(event);
    env.storage()
        .persistent()
        .set(&DataKey::History(member.clone()), &history);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::Record(member.clone()), 100_000, 100_000);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::History(member.clone()), 100_000, 100_000);
}

mod test;
