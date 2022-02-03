/*
 * This file is part of Solana Reference Stake Pool code.
 *
 * Copyright © 2021, mFactory GmbH
 *
 * Solana Reference Stake Pool is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License
 * as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 *
 * Solana Reference Stake Pool is distributed in the hope that it
 * will be useful, but WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.
 * If not, see <https://www.gnu.org/licenses/agpl-3.0.html>.
 *
 * You can be released from the requirements of the Affero GNU General Public License
 * by purchasing a commercial license. The purchase of such a license is
 * mandatory as soon as you develop commercial activities using the
 * Solana Reference Stake Pool code without disclosing the source code of
 * your own applications.
 *
 * The developer of this program can be contacted at <info@mfactory.ch>.
 */

import { AccountInfo, Connection, PublicKey, Signer, TransactionInstruction } from '@solana/web3.js';
import { ValidatorAccount } from './utils';
import { StakePool, ValidatorList } from './layouts';
export type { StakePool, AccountType, ValidatorList, ValidatorStakeInfo } from './layouts';
export { STAKE_POOL_PROGRAM_ID } from './constants';
export * from './instructions';
export interface ValidatorListAccount {
    pubkey: PublicKey;
    account: AccountInfo<ValidatorList>;
}
export interface StakePoolAccount {
    pubkey: PublicKey;
    account: AccountInfo<StakePool>;
}
export interface WithdrawAccount {
    stakeAddress: PublicKey;
    voteAddress?: PublicKey;
    poolAmount: number;
}
/**
 * Wrapper class for a stake pool.
 * Each stake pool has a stake pool account and a validator list account.
 */
export interface StakePoolAccounts {
    stakePool: StakePoolAccount | undefined;
    validatorList: ValidatorListAccount | undefined;
}
/**
 * Retrieves and deserializes a StakePool account using a web3js connection and the stake pool address.
 * @param connection: An active web3js connection.
 * @param stakePoolAddress: The public key (address) of the stake pool account.
 */
export declare function getStakePoolAccount(connection: Connection, stakePoolAddress: PublicKey): Promise<StakePoolAccount>;
/**
 * Retrieves all StakePool and ValidatorList accounts that are running a particular StakePool program.
 * @param connection: An active web3js connection.
 * @param stakePoolAddress: The public key (address) of the StakePool program.
 */
export declare function getStakePoolAccounts(connection: Connection, stakePoolAddress: PublicKey): Promise<(StakePoolAccount | ValidatorListAccount)[] | undefined>;
/**
 * Creates instructions required to deposit stake to stake pool.
 */
export declare function depositStake(connection: Connection, stakePoolAddress: PublicKey, authorizedPubkey: PublicKey, validatorVote: PublicKey, depositStake: PublicKey, poolTokenReceiverAccount?: PublicKey | undefined): Promise<{
    instructions: TransactionInstruction[];
    signers: Signer[];
    rentFee: number;
}>;
/**
 * Creates instructions required to deposit sol to stake pool.
 */
export declare function depositSol(connection: Connection, stakePoolAddress: PublicKey, from: PublicKey, lamports: number, destinationTokenAccount?: PublicKey, referrerTokenAccount?: PublicKey, depositAuthority?: PublicKey): Promise<{
    instructions: TransactionInstruction[];
    signers: Signer[];
    rentFee: number;
}>;
/**
 * Creates instructions required to withdraw stake from a stake pool.
 */
export declare function withdrawStake(connection: Connection, stakePoolAddress: PublicKey, tokenOwner: PublicKey, amount: number, useReserve?: boolean, voteAccountAddress?: PublicKey, stakeReceiver?: PublicKey, poolTokenAccount?: PublicKey, validatorComparator?: (_a: ValidatorAccount, _b: ValidatorAccount) => number): Promise<{
    instructions: TransactionInstruction[];
    signers: Signer[];
    stakeReceiver: PublicKey | undefined;
    totalRentFreeBalances: number;
}>;
/**
 * Creates instructions required to withdraw SOL directly from a stake pool.
 */
export declare function withdrawSol(connection: Connection, stakePoolAddress: PublicKey, tokenOwner: PublicKey, solReceiver: PublicKey, amount: number, solWithdrawAuthority?: PublicKey): Promise<{
    instructions: TransactionInstruction[];
    signers: Signer[];
}>;
/**
 * Creates instructions required to increase validator stake.
 */
export declare function increaseValidatorStake(connection: Connection, stakePoolAddress: PublicKey, validatorVote: PublicKey, lamports: number): Promise<{
    instructions: TransactionInstruction[];
}>;
/**
 * Creates instructions required to decrease validator stake.
 */
export declare function decreaseValidatorStake(connection: Connection, stakePoolAddress: PublicKey, validatorVote: PublicKey, lamports: number): Promise<{
    instructions: TransactionInstruction[];
}>;
/**
 * Creates instructions required to completely update a stake pool after epoch change.
 */
export declare function updateStakePool(connection: Connection, stakePool: StakePoolAccount, noMerge?: boolean): Promise<{
    updateListInstructions: TransactionInstruction[];
    finalInstructions: TransactionInstruction[];
}>;
/**
 * Retrieves detailed information about the StakePool.
 */
export declare function stakePoolInfo(connection: Connection, stakePoolAddress: PublicKey): Promise<{
    address: string;
    poolWithdrawAuthority: string;
    manager: string;
    staker: string;
    stakeDepositAuthority: string;
    stakeWithdrawBumpSeed: number;
    maxValidators: number;
    validatorList: {
        activeStakeLamports: string;
        transientStakeLamports: string;
        lastUpdateEpoch: string;
        transientSeedSuffixStart: string;
        transientSeedSuffixEnd: string;
        status: string;
        voteAccountAddress: string;
    }[];
    validatorListStorageAccount: string;
    reserveStake: string;
    poolMint: string;
    managerFeeAccount: string;
    tokenProgramId: string;
    totalLamports: string;
    poolTokenSupply: string;
    lastUpdateEpoch: string;
    lockup: import("@solana/web3.js").Lockup;
    epochFee: import("./layouts").Fee;
    nextEpochFee: import("./layouts").Fee | undefined;
    preferredDepositValidatorVoteAddress: PublicKey | undefined;
    preferredWithdrawValidatorVoteAddress: PublicKey | undefined;
    stakeDepositFee: import("./layouts").Fee;
    stakeWithdrawalFee: import("./layouts").Fee;
    nextStakeWithdrawalFee: import("./layouts").Fee | undefined;
    stakeReferralFee: number;
    solDepositAuthority: string | undefined;
    solDepositFee: import("./layouts").Fee;
    solReferralFee: number;
    solWithdrawAuthority: string | undefined;
    solWithdrawalFee: import("./layouts").Fee;
    nextSolWithdrawalFee: import("./layouts").Fee | undefined;
    lastEpochPoolTokenSupply: string;
    lastEpochTotalLamports: string;
    details: {
        reserveStakeLamports: number | undefined;
        reserveAccountStakeAddress: string;
        minimumReserveStakeBalance: number;
        stakeAccounts: {
            voteAccountAddress: string;
            stakeAccountAddress: string;
            validatorActiveStakeLamports: string;
            validatorLastUpdateEpoch: string;
            validatorLamports: string;
            validatorTransientStakeAccountAddress: string;
            validatorTransientStakeLamports: string;
            updateRequired: boolean;
        }[];
        totalLamports: number;
        totalPoolTokens: number;
        currentNumberOfValidators: number;
        maxNumberOfValidators: number;
        updateRequired: boolean;
    };
}>;
