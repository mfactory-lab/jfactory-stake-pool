import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { EPHEMERAL_STAKE_SEED_PREFIX, TRANSIENT_STAKE_SEED_PREFIX } from '../constants';
/**
 * Generates the withdraw authority program address for the stake pool
 */
export async function findWithdrawAuthorityProgramAddress(programId, stakePoolAddress) {
    const [publicKey] = await PublicKey.findProgramAddress([stakePoolAddress.toBuffer(), Buffer.from('withdraw')], programId);
    return publicKey;
}
/**
 * Generates the stake program address for a validator's vote account
 */
export async function findStakeProgramAddress(programId, voteAccountAddress, stakePoolAddress) {
    const [publicKey] = await PublicKey.findProgramAddress([voteAccountAddress.toBuffer(), stakePoolAddress.toBuffer()], programId);
    return publicKey;
}
/**
 * Generates the stake program address for a validator's vote account
 */
export async function findTransientStakeProgramAddress(programId, voteAccountAddress, stakePoolAddress, seed) {
    const [publicKey] = await PublicKey.findProgramAddress([
        TRANSIENT_STAKE_SEED_PREFIX,
        voteAccountAddress.toBuffer(),
        stakePoolAddress.toBuffer(),
        seed.toBuffer('le', 8),
    ], programId);
    return publicKey;
}
/**
 * Generates the ephemeral program address for stake pool redelegation
 */
export async function findEphemeralStakeProgramAddress(programId, stakePoolAddress, seed) {
    const [publicKey] = await PublicKey.findProgramAddress([EPHEMERAL_STAKE_SEED_PREFIX, stakePoolAddress.toBuffer(), seed.toBuffer('le', 8)], programId);
    return publicKey;
}
