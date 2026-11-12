#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
};

pub const ESCROW_TIMEOUT_SECONDS: u64 = 7 * 24 * 60 * 60;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InvalidAmount = 4,
    EscrowNotFound = 5,
    InvalidStatus = 6,
    AlreadyFunded = 7,
    TimeoutNotReached = 8,
    NotDisputed = 9,
    AlreadyShipped = 10,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum EscrowStatus {
    Created = 1,
    Funded = 2,
    Shipped = 3,
    Released = 4,
    Refunded = 5,
    Disputed = 6,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub amount: i128,
    pub status: EscrowStatus,
    pub funded_at: u64,
    pub timeout_at: u64,
}

#[contracttype]
enum DataKey {
    Admin,
    Usdc,
    Initialized,
    NextId,
    Escrow(u64),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Initialized {
    pub admin: Address,
    pub usdc: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowCreated {
    #[topic]
    pub escrow_id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowFunded {
    #[topic]
    pub escrow_id: u64,
    pub amount: i128,
    pub timeout_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowShipped {
    #[topic]
    pub escrow_id: u64,
    pub seller: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowReleased {
    #[topic]
    pub escrow_id: u64,
    pub seller: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowRefunded {
    #[topic]
    pub escrow_id: u64,
    pub buyer: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowDisputed {
    #[topic]
    pub escrow_id: u64,
    pub caller: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowArbitrated {
    #[topic]
    pub escrow_id: u64,
    pub release_to_seller: bool,
}

#[contract]
pub struct MarketplaceEscrow;

#[contractimpl]
impl MarketplaceEscrow {
    pub fn initialize(env: Env, admin: Address, usdc: Address) -> Result<(), Error> {
        admin.require_auth();
        if initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Usdc, &usdc);
        env.storage().instance().set(&DataKey::Initialized, &true);
        env.storage().instance().set(&DataKey::NextId, &1u64);
        env.storage().instance().extend_ttl(100_000, 100_000);
        Initialized { admin, usdc }.publish(&env);
        Ok(())
    }

    pub fn create_escrow(
        env: Env,
        buyer: Address,
        seller: Address,
        amount: i128,
    ) -> Result<u64, Error> {
        require_init(&env)?;
        buyer.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if buyer == seller {
            return Err(Error::Unauthorized);
        }
        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .ok_or(Error::NotInitialized)?;
        let escrow = Escrow {
            id,
            buyer: buyer.clone(),
            seller: seller.clone(),
            amount,
            status: EscrowStatus::Created,
            funded_at: 0,
            timeout_at: 0,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(id), &escrow);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        EscrowCreated {
            escrow_id: id,
            buyer,
            seller,
            amount,
        }
        .publish(&env);
        Ok(id)
    }

    pub fn fund(env: Env, escrow_id: u64) -> Result<(), Error> {
        require_init(&env)?;
        let mut escrow = load(&env, escrow_id)?;
        escrow.buyer.require_auth();
        if escrow.status != EscrowStatus::Created {
            return Err(Error::AlreadyFunded);
        }
        let usdc = usdc_client(&env)?;
        usdc.transfer(
            &escrow.buyer,
            &env.current_contract_address(),
            &escrow.amount,
        );
        let now = env.ledger().timestamp();
        escrow.status = EscrowStatus::Funded;
        escrow.funded_at = now;
        escrow.timeout_at = now.saturating_add(ESCROW_TIMEOUT_SECONDS);
        save(&env, &escrow);
        EscrowFunded {
            escrow_id: escrow.id,
            amount: escrow.amount,
            timeout_at: escrow.timeout_at,
        }
        .publish(&env);
        Ok(())
    }

    pub fn mark_shipped(env: Env, escrow_id: u64) -> Result<(), Error> {
        require_init(&env)?;
        let mut escrow = load(&env, escrow_id)?;
        escrow.seller.require_auth();
        match escrow.status {
            EscrowStatus::Shipped => return Err(Error::AlreadyShipped),
            EscrowStatus::Funded => {}
            _ => return Err(Error::InvalidStatus),
        }
        escrow.status = EscrowStatus::Shipped;
        save(&env, &escrow);
        EscrowShipped {
            escrow_id: escrow.id,
            seller: escrow.seller,
        }
        .publish(&env);
        Ok(())
    }

    pub fn confirm_delivery(env: Env, escrow_id: u64) -> Result<(), Error> {
        require_init(&env)?;
        let mut escrow = load(&env, escrow_id)?;
        escrow.buyer.require_auth();
        if escrow.status != EscrowStatus::Funded && escrow.status != EscrowStatus::Shipped {
            return Err(Error::InvalidStatus);
        }
        let usdc = usdc_client(&env)?;
        usdc.transfer(
            &env.current_contract_address(),
            &escrow.seller,
            &escrow.amount,
        );
        escrow.status = EscrowStatus::Released;
        save(&env, &escrow);
        EscrowReleased {
            escrow_id: escrow.id,
            seller: escrow.seller,
            amount: escrow.amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Buyer may refund after timeout while funded or shipped.
    /// Seller may cancel (refund buyer) only while funded and not yet shipped.
    pub fn refund(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error> {
        require_init(&env)?;
        caller.require_auth();
        let mut escrow = load(&env, escrow_id)?;
        let is_seller = caller == escrow.seller;
        let is_buyer = caller == escrow.buyer;
        if !is_seller && !is_buyer {
            return Err(Error::Unauthorized);
        }
        match escrow.status {
            EscrowStatus::Funded => {
                if is_buyer && env.ledger().timestamp() < escrow.timeout_at {
                    return Err(Error::TimeoutNotReached);
                }
            }
            EscrowStatus::Shipped => {
                if is_seller {
                    return Err(Error::InvalidStatus);
                }
                if env.ledger().timestamp() < escrow.timeout_at {
                    return Err(Error::TimeoutNotReached);
                }
            }
            _ => return Err(Error::InvalidStatus),
        }
        let usdc = usdc_client(&env)?;
        usdc.transfer(
            &env.current_contract_address(),
            &escrow.buyer,
            &escrow.amount,
        );
        escrow.status = EscrowStatus::Refunded;
        save(&env, &escrow);
        EscrowRefunded {
            escrow_id: escrow.id,
            buyer: escrow.buyer,
            amount: escrow.amount,
        }
        .publish(&env);
        Ok(())
    }

    pub fn dispute(env: Env, escrow_id: u64, caller: Address) -> Result<(), Error> {
        require_init(&env)?;
        caller.require_auth();
        let mut escrow = load(&env, escrow_id)?;
        if caller != escrow.buyer && caller != escrow.seller {
            return Err(Error::Unauthorized);
        }
        if escrow.status != EscrowStatus::Funded && escrow.status != EscrowStatus::Shipped {
            return Err(Error::InvalidStatus);
        }
        escrow.status = EscrowStatus::Disputed;
        save(&env, &escrow);
        EscrowDisputed {
            escrow_id: escrow.id,
            caller,
        }
        .publish(&env);
        Ok(())
    }

    pub fn arbitrate(env: Env, escrow_id: u64, release_to_seller: bool) -> Result<(), Error> {
        require_init(&env)?;
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        let mut escrow = load(&env, escrow_id)?;
        if escrow.status != EscrowStatus::Disputed {
            return Err(Error::NotDisputed);
        }
        let usdc = usdc_client(&env)?;
        let recipient = if release_to_seller {
            escrow.seller.clone()
        } else {
            escrow.buyer.clone()
        };
        usdc.transfer(&env.current_contract_address(), &recipient, &escrow.amount);
        escrow.status = if release_to_seller {
            EscrowStatus::Released
        } else {
            EscrowStatus::Refunded
        };
        save(&env, &escrow);
        EscrowArbitrated {
            escrow_id: escrow.id,
            release_to_seller,
        }
        .publish(&env);
        Ok(())
    }

    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<Escrow, Error> {
        load(&env, escrow_id)
    }

    pub fn get_admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
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

fn usdc_client(env: &Env) -> Result<token::TokenClient<'_>, Error> {
    let addr: Address = env
        .storage()
        .instance()
        .get(&DataKey::Usdc)
        .ok_or(Error::NotInitialized)?;
    Ok(token::TokenClient::new(env, &addr))
}

fn load(env: &Env, id: u64) -> Result<Escrow, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Escrow(id))
        .ok_or(Error::EscrowNotFound)
}

fn save(env: &Env, escrow: &Escrow) {
    env.storage()
        .persistent()
        .set(&DataKey::Escrow(escrow.id), escrow);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::Escrow(escrow.id), 100_000, 100_000);
}

mod test;
