#![cfg(test)]

use super::{Error, LendingPool, LendingPoolClient, LoanStatus, LOAN_TERM_SECONDS};
use reputation::{Reputation, ReputationClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env, Vec,
};

struct TestCtx {
    env: Env,
    pool: LendingPoolClient<'static>,
    reputation: ReputationClient<'static>,
    token: TokenClient<'static>,
    token_admin: StellarAssetClient<'static>,
    admin: Address,
    leader: Address,
    member_b: Address,
    member_c: Address,
    lender: Address,
}

fn members(ctx: &TestCtx) -> Vec<Address> {
    Vec::from_array(
        &ctx.env,
        [ctx.leader.clone(), ctx.member_b.clone(), ctx.member_c.clone()],
    )
}

fn setup() -> TestCtx {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let leader = Address::generate(&env);
    let member_b = Address::generate(&env);
    let member_c = Address::generate(&env);
    let lender = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token = TokenClient::new(&env, &token_addr);
    let token_admin = StellarAssetClient::new(&env, &token_addr);

    let reputation_id = env.register(Reputation, ());
    let reputation = ReputationClient::new(&env, &reputation_id);
    reputation.initialize(&admin);

    let pool_id = env.register(LendingPool, ());
    let pool = LendingPoolClient::new(&env, &pool_id);
    pool.initialize(&admin, &token_addr, &reputation_id);
    reputation.set_writer(&pool_id);
    pool.set_kyc_approved(&admin, &leader, &true);

    token_admin.mint(&lender, &1_000_000);
    pool.deposit(&lender, &500_000);

    TestCtx {
        env,
        pool,
        reputation,
        token,
        token_admin,
        admin,
        leader,
        member_b,
        member_c,
        lender,
    }
}

fn sign_all(ctx: &TestCtx, group_id: u64) {
    ctx.pool.sign(&group_id, &ctx.leader);
    ctx.pool.sign(&group_id, &ctx.member_b);
    ctx.pool.sign(&group_id, &ctx.member_c);
}

#[test]
fn create_group_and_happy_path_repay() {
    let ctx = setup();
    let group_id = ctx.pool.create_group(&ctx.leader, &members(&ctx));
    let loan_id = ctx.pool.request_loan(&group_id, &10_000);
    sign_all(&ctx, group_id);

    let leader_before = ctx.token.balance(&ctx.leader);
    ctx.pool.disburse(&group_id);
    assert_eq!(ctx.token.balance(&ctx.leader), leader_before + 10_000);

    let loan = ctx.pool.get_loan(&loan_id);
    assert_eq!(loan.status, LoanStatus::Disbursed);
    assert_eq!(loan.due_amount, 11_000);
    assert_eq!(loan.due_at, loan.disbursed_at + LOAN_TERM_SECONDS);

    ctx.token_admin.mint(&ctx.leader, &1_000);
    ctx.pool.repay(&group_id, &ctx.leader);

    let loan = ctx.pool.get_loan(&loan_id);
    assert_eq!(loan.status, LoanStatus::Repaid);
    assert_eq!(ctx.reputation.get_score(&ctx.leader), 10);
    assert_eq!(ctx.reputation.get_score(&ctx.member_b), 10);
    assert_eq!(ctx.reputation.get_score(&ctx.member_c), 10);
}

#[test]
fn create_group_rejects_too_few_and_too_many() {
    let ctx = setup();
    let two = Vec::from_array(&ctx.env, [ctx.leader.clone(), ctx.member_b.clone()]);
    assert_eq!(
        ctx.pool.try_create_group(&ctx.leader, &two),
        Err(Ok(Error::InvalidGroupSize))
    );

    let extra1 = Address::generate(&ctx.env);
    let extra2 = Address::generate(&ctx.env);
    let extra3 = Address::generate(&ctx.env);
    let six = Vec::from_array(
        &ctx.env,
        [
            ctx.leader.clone(),
            ctx.member_b.clone(),
            ctx.member_c.clone(),
            extra1,
            extra2,
            extra3,
        ],
    );
    assert_eq!(
        ctx.pool.try_create_group(&ctx.leader, &six),
        Err(Ok(Error::InvalidGroupSize))
    );
}

#[test]
fn create_group_rejects_duplicates_and_missing_leader() {
    let ctx = setup();
    let dup = Vec::from_array(
        &ctx.env,
        [ctx.leader.clone(), ctx.member_b.clone(), ctx.leader.clone()],
    );
    assert_eq!(
        ctx.pool.try_create_group(&ctx.leader, &dup),
        Err(Ok(Error::DuplicateMember))
    );

    let outsider = Address::generate(&ctx.env);
    let no_leader = Vec::from_array(
        &ctx.env,
        [outsider.clone(), ctx.member_b.clone(), ctx.member_c.clone()],
    );
    assert_eq!(
        ctx.pool.try_create_group(&ctx.leader, &no_leader),
        Err(Ok(Error::LeaderNotMember))
    );
}

#[test]
fn request_loan_rejects_non_positive_and_active_loan() {
    let ctx = setup();
    let group_id = ctx.pool.create_group(&ctx.leader, &members(&ctx));
    assert_eq!(
        ctx.pool.try_request_loan(&group_id, &0),
        Err(Ok(Error::InvalidAmount))
    );
    ctx.pool.request_loan(&group_id, &1_000);
    assert_eq!(
        ctx.pool.try_request_loan(&group_id, &1_000),
        Err(Ok(Error::ActiveLoanExists))
    );
}

#[test]
fn sign_rejects_non_member_and_double_sign() {
    let ctx = setup();
    let group_id = ctx.pool.create_group(&ctx.leader, &members(&ctx));
    ctx.pool.request_loan(&group_id, &1_000);

    let stranger = Address::generate(&ctx.env);
    assert_eq!(
        ctx.pool.try_sign(&group_id, &stranger),
        Err(Ok(Error::NotGroupMember))
    );

    ctx.pool.sign(&group_id, &ctx.leader);
    assert_eq!(
        ctx.pool.try_sign(&group_id, &ctx.leader),
        Err(Ok(Error::AlreadySigned))
    );
}

#[test]
fn disburse_fails_without_all_signatures() {
    let ctx = setup();
    let group_id = ctx.pool.create_group(&ctx.leader, &members(&ctx));
    ctx.pool.request_loan(&group_id, &1_000);
    ctx.pool.sign(&group_id, &ctx.leader);
    ctx.pool.sign(&group_id, &ctx.member_b);
    assert_eq!(
        ctx.pool.try_disburse(&group_id),
        Err(Ok(Error::MissingSignatures))
    );
}

#[test]
fn disburse_fails_if_pool_empty() {
    let ctx = setup();
    let group_id = ctx.pool.create_group(&ctx.leader, &members(&ctx));
    ctx.pool.request_loan(&group_id, &999_999);
    sign_all(&ctx, group_id);
    assert_eq!(
        ctx.pool.try_disburse(&group_id),
        Err(Ok(Error::InsufficientPool))
    );
}

#[test]
fn repay_fails_before_disburse() {
    let ctx = setup();
    let group_id = ctx.pool.create_group(&ctx.leader, &members(&ctx));
    ctx.pool.request_loan(&group_id, &1_000);
    sign_all(&ctx, group_id);
    assert_eq!(
        ctx.pool.try_repay(&group_id, &ctx.leader),
        Err(Ok(Error::LoanNotDisbursed))
    );
}

#[test]
fn repay_fails_without_full_110_percent() {
    let ctx = setup();
    let group_id = ctx.pool.create_group(&ctx.leader, &members(&ctx));
    ctx.pool.request_loan(&group_id, &1_000);
    sign_all(&ctx, group_id);
    ctx.pool.disburse(&group_id);
    // Leader holds principal only; contract pulls 1,100. Transfer must fail.
    let result = ctx.pool.try_repay(&group_id, &ctx.leader);
    assert!(result.is_err());
    assert_eq!(ctx.pool.get_group_loan(&group_id).status, LoanStatus::Disbursed);
}

#[test]
fn due_amount_is_principal_plus_ten_percent() {
    let ctx = setup();
    assert_eq!(ctx.pool.get_due_amount(&100), 110);
    assert_eq!(ctx.pool.get_due_amount(&10_000), 11_000);
}

#[test]
fn mark_default_too_early_fails() {
    let ctx = setup();
    let group_id = ctx.pool.create_group(&ctx.leader, &members(&ctx));
    ctx.pool.request_loan(&group_id, &1_000);
    sign_all(&ctx, group_id);
    ctx.pool.disburse(&group_id);
    assert_eq!(
        ctx.pool.try_mark_default(&group_id),
        Err(Ok(Error::TooEarlyToDefault))
    );
}

#[test]
fn mark_default_after_day_30_lowers_reputation() {
    let ctx = setup();
    let group_id = ctx.pool.create_group(&ctx.leader, &members(&ctx));
    let loan_id = ctx.pool.request_loan(&group_id, &1_000);
    sign_all(&ctx, group_id);
    ctx.pool.disburse(&group_id);

    let due_at = ctx.pool.get_loan(&loan_id).due_at;
    ctx.env.ledger().set_timestamp(due_at);
    ctx.pool.mark_default(&group_id);

    let loan = ctx.pool.get_loan(&loan_id);
    assert_eq!(loan.status, LoanStatus::Defaulted);
    assert_eq!(ctx.reputation.get_score(&ctx.leader), -20);
    assert_eq!(ctx.reputation.get_record(&ctx.member_b).defaults, 1);
}

#[test]
fn mark_default_after_repay_fails() {
    let ctx = setup();
    let group_id = ctx.pool.create_group(&ctx.leader, &members(&ctx));
    ctx.pool.request_loan(&group_id, &1_000);
    sign_all(&ctx, group_id);
    ctx.pool.disburse(&group_id);
    ctx.token_admin.mint(&ctx.leader, &100);
    ctx.pool.repay(&group_id, &ctx.leader);
    ctx.env.ledger().set_timestamp(ctx.env.ledger().timestamp() + LOAN_TERM_SECONDS);
    assert_eq!(
        ctx.pool.try_mark_default(&group_id),
        Err(Ok(Error::LoanAlreadyClosed))
    );
}

#[test]
fn withdraw_and_deposit_accounting() {
    let ctx = setup();
    assert_eq!(ctx.pool.get_deposit(&ctx.lender), 500_000);
    ctx.pool.withdraw(&ctx.lender, &100_000);
    assert_eq!(ctx.pool.get_deposit(&ctx.lender), 400_000);
    assert_eq!(
        ctx.pool.try_withdraw(&ctx.lender, &500_000),
        Err(Ok(Error::InsufficientDeposit))
    );
    assert_eq!(
        ctx.pool.try_deposit(&ctx.lender, &0),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn withdraw_fails_when_liquidity_locked_in_loan() {
    let ctx = setup();
    let group_id = ctx.pool.create_group(&ctx.leader, &members(&ctx));
    ctx.pool.request_loan(&group_id, &500_000);
    sign_all(&ctx, group_id);
    ctx.pool.disburse(&group_id);
    assert_eq!(
        ctx.pool.try_withdraw(&ctx.lender, &1),
        Err(Ok(Error::InsufficientLiquidity))
    );
}

#[test]
fn unauthorized_initialize_fails() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let reputation_id = env.register(Reputation, ());
    let pool = LendingPoolClient::new(&env, &env.register(LendingPool, ()));
    let result = pool.try_initialize(&admin, &sac.address(), &reputation_id);
    assert!(result.is_err());
}

#[test]
fn sign_without_auth_fails() {
    let ctx = setup();
    let group_id = ctx.pool.create_group(&ctx.leader, &members(&ctx));
    ctx.pool.request_loan(&group_id, &1_000);
    ctx.env.set_auths(&[]);
    let result = ctx.pool.try_sign(&group_id, &ctx.leader);
    assert!(result.is_err());
}

#[test]
fn unknown_group_and_loan_fail() {
    let ctx = setup();
    assert_eq!(ctx.pool.try_get_group(&99), Err(Ok(Error::GroupNotFound)));
    assert_eq!(ctx.pool.try_get_loan(&99), Err(Ok(Error::LoanNotFound)));
    assert_eq!(
        ctx.pool.try_sign(&99, &ctx.leader),
        Err(Ok(Error::GroupNotFound))
    );
}

#[test]
fn disburse_fails_without_leader_kyc() {
    let ctx = setup();
    ctx.pool.set_kyc_approved(&ctx.admin, &ctx.leader, &false);
    assert!(!ctx.pool.is_kyc_approved(&ctx.leader));

    let group_id = ctx.pool.create_group(&ctx.leader, &members(&ctx));
    ctx.pool.request_loan(&group_id, &1_000);
    sign_all(&ctx, group_id);
    assert_eq!(
        ctx.pool.try_disburse(&group_id),
        Err(Ok(Error::KycRequired))
    );
}

#[test]
fn set_kyc_rejected_for_non_admin() {
    let ctx = setup();
    let impostor = Address::generate(&ctx.env);
    assert_eq!(
        ctx.pool
            .try_set_kyc_approved(&impostor, &ctx.leader, &true),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn double_disburse_fails() {
    let ctx = setup();
    let group_id = ctx.pool.create_group(&ctx.leader, &members(&ctx));
    ctx.pool.request_loan(&group_id, &1_000);
    sign_all(&ctx, group_id);
    ctx.pool.disburse(&group_id);
    assert_eq!(
        ctx.pool.try_disburse(&group_id),
        Err(Ok(Error::AlreadyDisbursed))
    );
}

#[test]
fn repay_after_due_date_fails() {
    let ctx = setup();
    let group_id = ctx.pool.create_group(&ctx.leader, &members(&ctx));
    let loan_id = ctx.pool.request_loan(&group_id, &1_000);
    sign_all(&ctx, group_id);
    ctx.pool.disburse(&group_id);
    ctx.token_admin.mint(&ctx.leader, &100);
    let due_at = ctx.pool.get_loan(&loan_id).due_at;
    ctx.env.ledger().set_timestamp(due_at);
    assert_eq!(
        ctx.pool.try_repay(&group_id, &ctx.leader),
        Err(Ok(Error::TooLateToRepay))
    );
    assert_eq!(
        ctx.pool.get_group_loan(&group_id).status,
        LoanStatus::Disbursed
    );
}

#[test]
fn four_and_five_member_groups_can_borrow() {
    let ctx = setup();
    let extra_d = Address::generate(&ctx.env);
    let extra_e = Address::generate(&ctx.env);

    let four = Vec::from_array(
        &ctx.env,
        [
            ctx.leader.clone(),
            ctx.member_b.clone(),
            ctx.member_c.clone(),
            extra_d.clone(),
        ],
    );
    let group4 = ctx.pool.create_group(&ctx.leader, &four);
    ctx.pool.request_loan(&group4, &2_000);
    ctx.pool.sign(&group4, &ctx.leader);
    ctx.pool.sign(&group4, &ctx.member_b);
    ctx.pool.sign(&group4, &ctx.member_c);
    ctx.pool.sign(&group4, &extra_d);
    ctx.pool.disburse(&group4);
    ctx.token_admin.mint(&ctx.leader, &200);
    ctx.pool.repay(&group4, &ctx.leader);
    assert_eq!(ctx.pool.get_group_loan(&group4).status, LoanStatus::Repaid);

    let five = Vec::from_array(
        &ctx.env,
        [
            ctx.leader.clone(),
            ctx.member_b.clone(),
            ctx.member_c.clone(),
            extra_d.clone(),
            extra_e.clone(),
        ],
    );
    let group5 = ctx.pool.create_group(&ctx.leader, &five);
    ctx.pool.request_loan(&group5, &3_000);
    ctx.pool.sign(&group5, &ctx.leader);
    ctx.pool.sign(&group5, &ctx.member_b);
    ctx.pool.sign(&group5, &ctx.member_c);
    ctx.pool.sign(&group5, &extra_d);
    ctx.pool.sign(&group5, &extra_e);
    ctx.pool.disburse(&group5);
    assert_eq!(
        ctx.pool.get_group_loan(&group5).status,
        LoanStatus::Disbursed
    );
}
