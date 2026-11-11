#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env,
};

fn setup() -> (Env, ReputationClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let writer = Address::generate(&env);
    let contract_id = env.register(Reputation, ());
    let client = ReputationClient::new(&env, &contract_id);
    client.initialize(&admin);
    client.set_writer(&writer);
    (env, client, admin, writer)
}

#[test]
fn initialize_and_getters() {
    let (_env, client, admin, writer) = setup();
    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_writer(), writer);
}

#[test]
fn initialize_twice_fails() {
    let (_env, client, admin, _writer) = setup();
    let result = client.try_initialize(&admin);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn set_writer_requires_init() {
    let env = Env::default();
    env.mock_all_auths();
    let client = ReputationClient::new(&env, &env.register(Reputation, ()));
    let writer = Address::generate(&env);
    assert_eq!(client.try_set_writer(&writer), Err(Ok(Error::NotInitialized)));
}

#[test]
fn repayment_increases_score_and_history() {
    let (env, client, _admin, _writer) = setup();
    let member = Address::generate(&env);
    env.ledger().set_timestamp(1_700_000_000);

    client.record_repayment(&member, &7, &1_100i128);

    assert_eq!(client.get_score(&member), REPAY_DELTA);
    let record = client.get_record(&member);
    assert_eq!(record.repayments, 1);
    assert_eq!(record.defaults, 0);

    let history = client.get_history(&member);
    assert_eq!(history.len(), 1);
    let event = history.get(0).unwrap();
    assert_eq!(event.kind, EventKind::Repayment);
    assert_eq!(event.loan_id, 7);
    assert_eq!(event.amount, 1_100);
    assert_eq!(event.delta, REPAY_DELTA);
    assert_eq!(event.timestamp, 1_700_000_000);
}

#[test]
fn default_lowers_score() {
    let (env, client, _admin, _writer) = setup();
    let member = Address::generate(&env);
    client.record_repayment(&member, &1, &500);
    client.record_default(&member, &2);

    let record = client.get_record(&member);
    assert_eq!(record.score, REPAY_DELTA - DEFAULT_DELTA);
    assert_eq!(record.repayments, 1);
    assert_eq!(record.defaults, 1);
    assert_eq!(client.get_history(&member).len(), 2);
}

#[test]
fn repayment_rejects_non_positive_amount() {
    let (env, client, _admin, _writer) = setup();
    let member = Address::generate(&env);
    assert_eq!(
        client.try_record_repayment(&member, &1, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        client.try_record_repayment(&member, &1, &-5),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn record_without_writer_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = ReputationClient::new(&env, &env.register(Reputation, ()));
    client.initialize(&admin);
    let member = Address::generate(&env);
    assert_eq!(
        client.try_record_repayment(&member, &1, &100),
        Err(Ok(Error::WriterNotSet))
    );
}

#[test]
fn unauthorized_set_writer_fails() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let impostor = Address::generate(&env);
    let client = ReputationClient::new(&env, &env.register(Reputation, ()));

    env.mock_all_auths();
    client.initialize(&admin);

    // No auths mocked: require_auth on admin must fail.
    env.set_auths(&[]);
    let result = client.try_set_writer(&impostor);
    assert!(result.is_err());
}

#[test]
fn unauthorized_record_repayment_fails() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let writer = Address::generate(&env);
    let client = ReputationClient::new(&env, &env.register(Reputation, ()));

    env.mock_all_auths();
    client.initialize(&admin);
    client.set_writer(&writer);

    env.set_auths(&[]);
    let member = Address::generate(&env);
    let result = client.try_record_repayment(&member, &1, &100);
    assert!(result.is_err());
}

#[test]
fn unknown_member_has_zero_score() {
    let (env, client, _admin, _writer) = setup();
    let member = Address::generate(&env);
    assert_eq!(client.get_score(&member), 0);
    assert_eq!(client.get_history(&member).len(), 0);
}
