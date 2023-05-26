import { struct, u32, u8 } from '@solana/buffer-layout';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import type { Infer } from 'superstruct';
import { coerce, enums, instance, nullable, number, optional, string, type } from 'superstruct';
import { option, publicKey, u64, vec } from './utils';
import type { Fee } from './index';

export interface Lockup {
  unixTimestamp: BN;
  epoch: BN;
  custodian: PublicKey;
}

const lockup = (property?: string) =>
  struct<Lockup>([u64('unixTimestamp'), u64('epoch'), publicKey('custodian')], property);

const fee = (property?: string) => struct<Fee>([u64('denominator'), u64('numerator')], property);

export enum AccountType {
  Uninitialized,
  StakePool,
  ValidatorList,
}

export const BigNumFromString = coerce(instance(BN), string(), (value) => {
  return new BN(value, 10);
});

export const PublicKeyFromString = coerce(
  instance(PublicKey),
  string(),
  (value) => new PublicKey(value),
);

export const StakeAccountType = enums(['uninitialized', 'initialized', 'delegated', 'rewardsPool']);
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type StakeAccountType = Infer<typeof StakeAccountType>;

export const StakeMeta = type({
  rentExemptReserve: BigNumFromString,
  authorized: type({
    staker: PublicKeyFromString,
    withdrawer: PublicKeyFromString,
  }),
  lockup: type({
    unixTimestamp: number(),
    epoch: number(),
    custodian: PublicKeyFromString,
  }),
});
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type StakeMeta = Infer<typeof StakeMeta>;

export const StakeAccountInfo = type({
  meta: StakeMeta,
  stake: nullable(
    type({
      delegation: type({
        voter: PublicKeyFromString,
        stake: BigNumFromString,
        activationEpoch: BigNumFromString,
        deactivationEpoch: BigNumFromString,
        warmupCooldownRate: number(),
      }),
      creditsObserved: number(),
    }),
  ),
});
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type StakeAccountInfo = Infer<typeof StakeAccountInfo>;

export const StakeAccount = type({
  type: StakeAccountType,
  info: optional(StakeAccountInfo),
});
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type StakeAccount = Infer<typeof StakeAccount>;

export interface StakePool {
  accountType: AccountType;
  manager: PublicKey;
  staker: PublicKey;
  stakeDepositAuthority: PublicKey;
  stakeWithdrawBumpSeed: number;
  validatorList: PublicKey;
  reserveStake: PublicKey;
  poolMint: PublicKey;
  managerFeeAccount: PublicKey;
  tokenProgramId: PublicKey;
  totalLamports: BN;
  poolTokenSupply: BN;
  lastUpdateEpoch: BN;
  lockup: Lockup;
  epochFee: Fee;
  nextEpochFee?: Fee | undefined;
  preferredDepositValidatorVoteAddress?: PublicKey | undefined;
  preferredWithdrawValidatorVoteAddress?: PublicKey | undefined;
  stakeDepositFee: Fee;
  stakeWithdrawalFee: Fee;
  nextStakeWithdrawalFee?: Fee | undefined;
  stakeReferralFee: number;
  solDepositAuthority?: PublicKey | undefined;
  solDepositFee: Fee;
  solReferralFee: number;
  solWithdrawAuthority?: PublicKey | undefined;
  solWithdrawalFee: Fee;
  nextSolWithdrawalFee?: Fee | undefined;
  lastEpochPoolTokenSupply: BN;
  lastEpochTotalLamports: BN;
}

export const StakePoolLayout = struct<StakePool>([
  u8('accountType'),
  publicKey('manager'),
  publicKey('staker'),
  publicKey('stakeDepositAuthority'),
  u8('stakeWithdrawBumpSeed'),
  publicKey('validatorList'),
  publicKey('reserveStake'),
  publicKey('poolMint'),
  publicKey('managerFeeAccount'),
  publicKey('tokenProgramId'),
  u64('totalLamports'),
  u64('poolTokenSupply'),
  u64('lastUpdateEpoch'),
  lockup('lockup'),
  fee('epochFee'),
  option(fee('nextEpochFee')),
  option(publicKey('preferredDepositValidatorVoteAddress')),
  option(publicKey('preferredWithdrawValidatorVoteAddress')),
  fee('stakeDepositFee'),
  fee('stakeWithdrawalFee'),
  option(fee('nextStakeWithdrawalFee')),
  u8('stakeReferralFee'),
  option(publicKey('solDepositAuthority')),
  fee('solDepositFee'),
  u8('solReferralFee'),
  option(publicKey('solWithdrawAuthority')),
  fee('solWithdrawalFee'),
  option(fee('nextSolWithdrawalFee')),
  u64('lastEpochPoolTokenSupply'),
  u64('lastEpochTotalLamports'),
]);

export enum ValidatorStakeInfoStatus {
  Active,
  DeactivatingTransient,
  ReadyForRemoval,
}

export interface ValidatorStakeInfo {
  status: ValidatorStakeInfoStatus;
  voteAccountAddress: PublicKey;
  activeStakeLamports: BN;
  transientStakeLamports: BN;
  transientSeedSuffixStart: BN;
  transientSeedSuffixEnd: BN;
  lastUpdateEpoch: BN;
}

export const ValidatorStakeInfoLayout = struct<ValidatorStakeInfo>([
  /// Amount of active stake delegated to this validator
  /// Note that if `last_update_epoch` does not match the current epoch then
  /// this field may not be accurate
  u64('activeStakeLamports'),
  /// Amount of transient stake delegated to this validator
  /// Note that if `last_update_epoch` does not match the current epoch then
  /// this field may not be accurate
  u64('transientStakeLamports'),
  /// Last epoch the active and transient stake lamports fields were updated
  u64('lastUpdateEpoch'),
  /// Start of the validator transient account seed suffixes
  u64('transientSeedSuffixStart'),
  /// End of the validator transient account seed suffixes
  u64('transientSeedSuffixEnd'),
  /// Status of the validator stake account
  u8('status'),
  /// Validator vote account address
  publicKey('voteAccountAddress'),
]);

export interface ValidatorList {
  /// Account type, must be ValidatorList currently
  accountType: number;
  /// Maximum allowable number of validators
  maxValidators: number;
  /// List of stake info for each validator in the pool
  validators: ValidatorStakeInfo[];
}

export const ValidatorListLayout = struct<ValidatorList>([
  u8('accountType'),
  u32('maxValidators'),
  vec(ValidatorStakeInfoLayout, 'validators'),
]);
