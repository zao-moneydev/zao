#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

struct TestCtx {
    env: Env,
    escrow: MarketplaceEscrowClient<'static>,
    token: TokenClient<'static>,
    _token_admin: StellarAssetClient<'static>,
    admin: Address,
    buyer: Address,
    seller: Address,
}

fn setup() -> TestCtx {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token = TokenClient::new(&env, &sac.address());
    let token_admin = StellarAssetClient::new(&env, &sac.address());
    token_admin.mint(&buyer, &50_000);

    let contract_id = env.register(MarketplaceEscrow, ());
    let escrow = MarketplaceEscrowClient::new(&env, &contract_id);
    escrow.initialize(&admin, &sac.address());

    TestCtx {
        env,
        escrow,
        token,
        _token_admin: token_admin,
        admin,
        buyer,
        seller,
    }
}

#[test]
fn fund_and_confirm_delivery_releases_to_seller() {
    let ctx = setup();
    let id = ctx.escrow.create_escrow(&ctx.buyer, &ctx.seller, &1_000);
    ctx.escrow.fund(&id);

    assert_eq!(ctx.token.balance(&ctx.buyer), 49_000);
    assert_eq!(ctx.token.balance(&ctx.escrow.address), 1_000);

    ctx.escrow.confirm_delivery(&id);
    assert_eq!(ctx.token.balance(&ctx.seller), 1_000);
    assert_eq!(ctx.escrow.get_escrow(&id).status, EscrowStatus::Released);
}

#[test]
fn create_rejects_invalid_amount_and_same_party() {
    let ctx = setup();
    assert_eq!(
        ctx.escrow.try_create_escrow(&ctx.buyer, &ctx.seller, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        ctx.escrow.try_create_escrow(&ctx.buyer, &ctx.buyer, &10),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn double_fund_fails() {
    let ctx = setup();
    let id = ctx.escrow.create_escrow(&ctx.buyer, &ctx.seller, &1_000);
    ctx.escrow.fund(&id);
    assert_eq!(ctx.escrow.try_fund(&id), Err(Ok(Error::AlreadyFunded)));
}

#[test]
fn confirm_before_fund_fails() {
    let ctx = setup();
    let id = ctx.escrow.create_escrow(&ctx.buyer, &ctx.seller, &1_000);
    assert_eq!(
        ctx.escrow.try_confirm_delivery(&id),
        Err(Ok(Error::InvalidStatus))
    );
}

#[test]
fn buyer_cannot_refund_before_timeout() {
    let ctx = setup();
    let id = ctx.escrow.create_escrow(&ctx.buyer, &ctx.seller, &1_000);
    ctx.escrow.fund(&id);
    assert_eq!(
        ctx.escrow.try_refund(&id, &ctx.buyer),
        Err(Ok(Error::TimeoutNotReached))
    );
}

#[test]
fn buyer_refund_after_timeout() {
    let ctx = setup();
    let id = ctx.escrow.create_escrow(&ctx.buyer, &ctx.seller, &1_000);
    ctx.escrow.fund(&id);
    let timeout_at = ctx.escrow.get_escrow(&id).timeout_at;
    ctx.env.ledger().set_timestamp(timeout_at);
    ctx.escrow.refund(&id, &ctx.buyer);
    assert_eq!(ctx.token.balance(&ctx.buyer), 50_000);
    assert_eq!(ctx.escrow.get_escrow(&id).status, EscrowStatus::Refunded);
}

#[test]
fn seller_can_refund_immediately() {
    let ctx = setup();
    let id = ctx.escrow.create_escrow(&ctx.buyer, &ctx.seller, &1_000);
    ctx.escrow.fund(&id);
    ctx.escrow.refund(&id, &ctx.seller);
    assert_eq!(ctx.token.balance(&ctx.buyer), 50_000);
}

#[test]
fn stranger_cannot_refund() {
    let ctx = setup();
    let id = ctx.escrow.create_escrow(&ctx.buyer, &ctx.seller, &1_000);
    ctx.escrow.fund(&id);
    let stranger = Address::generate(&ctx.env);
    assert_eq!(
        ctx.escrow.try_refund(&id, &stranger),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn dispute_and_admin_arbitration_to_seller() {
    let ctx = setup();
    let id = ctx.escrow.create_escrow(&ctx.buyer, &ctx.seller, &2_000);
    ctx.escrow.fund(&id);
    ctx.escrow.dispute(&id, &ctx.buyer);
    assert_eq!(ctx.escrow.get_escrow(&id).status, EscrowStatus::Disputed);
    ctx.escrow.arbitrate(&id, &true);
    assert_eq!(ctx.token.balance(&ctx.seller), 2_000);
    assert_eq!(ctx.escrow.get_escrow(&id).status, EscrowStatus::Released);
}

#[test]
fn admin_can_arbitrate_refund_to_buyer() {
    let ctx = setup();
    let id = ctx.escrow.create_escrow(&ctx.buyer, &ctx.seller, &2_000);
    ctx.escrow.fund(&id);
    ctx.escrow.dispute(&id, &ctx.seller);
    ctx.escrow.arbitrate(&id, &false);
    assert_eq!(ctx.token.balance(&ctx.buyer), 50_000);
    assert_eq!(ctx.escrow.get_escrow(&id).status, EscrowStatus::Refunded);
}

#[test]
fn arbitrate_without_dispute_fails() {
    let ctx = setup();
    let id = ctx.escrow.create_escrow(&ctx.buyer, &ctx.seller, &1_000);
    ctx.escrow.fund(&id);
    assert_eq!(
        ctx.escrow.try_arbitrate(&id, &true),
        Err(Ok(Error::NotDisputed))
    );
}

#[test]
fn unauthorized_arbitrate_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    StellarAssetClient::new(&env, &sac.address()).mint(&buyer, &5_000);
    let escrow = MarketplaceEscrowClient::new(&env, &env.register(MarketplaceEscrow, ()));
    escrow.initialize(&admin, &sac.address());
    let id = escrow.create_escrow(&buyer, &seller, &100);
    escrow.fund(&id);
    escrow.dispute(&id, &buyer);

    env.set_auths(&[]);
    let result = escrow.try_arbitrate(&id, &true);
    assert!(result.is_err());
}

#[test]
fn stranger_cannot_dispute() {
    let ctx = setup();
    let id = ctx.escrow.create_escrow(&ctx.buyer, &ctx.seller, &1_000);
    ctx.escrow.fund(&id);
    let stranger = Address::generate(&ctx.env);
    assert_eq!(
        ctx.escrow.try_dispute(&id, &stranger),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn unknown_escrow_fails() {
    let ctx = setup();
    assert_eq!(
        ctx.escrow.try_get_escrow(&42),
        Err(Ok(Error::EscrowNotFound))
    );
}

#[test]
fn initialize_twice_fails() {
    let ctx = setup();
    assert_eq!(
        ctx.escrow.try_initialize(&ctx.admin, &ctx.token.address),
        Err(Ok(Error::AlreadyInitialized))
    );
}
