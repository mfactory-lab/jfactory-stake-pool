'use strict';

var web3_js = require('@solana/web3.js');
var splToken = require('@solana/spl-token');
var BN = require('bn.js');
var borsh = require('@coral-xyz/borsh');
var buffer = require('buffer');

/**
 * A `StructFailure` represents a single specific failure in validation.
 */
/**
 * `StructError` objects are thrown (or returned) when validation fails.
 *
 * Validation logic is design to exit early for maximum performance. The error
 * represents the first error encountered during validation. For more detail,
 * the `error.failures` property is a generator function that can be run to
 * continue validation and receive all the failures in the data.
 */
class StructError extends TypeError {
    constructor(failure, failures) {
        let cached;
        const { message, explanation, ...rest } = failure;
        const { path } = failure;
        const msg = path.length === 0 ? message : `At path: ${path.join('.')} -- ${message}`;
        super(explanation ?? msg);
        if (explanation != null)
            this.cause = msg;
        Object.assign(this, rest);
        this.name = this.constructor.name;
        this.failures = () => {
            return (cached ?? (cached = [failure, ...failures()]));
        };
    }
}

/**
 * Check if a value is an iterator.
 */
function isIterable(x) {
    return isObject(x) && typeof x[Symbol.iterator] === 'function';
}
/**
 * Check if a value is a plain object.
 */
function isObject(x) {
    return typeof x === 'object' && x != null;
}
/**
 * Return a value as a printable string.
 */
function print(value) {
    if (typeof value === 'symbol') {
        return value.toString();
    }
    return typeof value === 'string' ? JSON.stringify(value) : `${value}`;
}
/**
 * Shifts (removes and returns) the first value from the `input` iterator.
 * Like `Array.prototype.shift()` but for an `Iterator`.
 */
function shiftIterator(input) {
    const { done, value } = input.next();
    return done ? undefined : value;
}
/**
 * Convert a single validation result to a failure.
 */
function toFailure(result, context, struct, value) {
    if (result === true) {
        return;
    }
    else if (result === false) {
        result = {};
    }
    else if (typeof result === 'string') {
        result = { message: result };
    }
    const { path, branch } = context;
    const { type } = struct;
    const { refinement, message = `Expected a value of type \`${type}\`${refinement ? ` with refinement \`${refinement}\`` : ''}, but received: \`${print(value)}\``, } = result;
    return {
        value,
        type,
        refinement,
        key: path[path.length - 1],
        path,
        branch,
        ...result,
        message,
    };
}
/**
 * Convert a validation result to an iterable of failures.
 */
function* toFailures(result, context, struct, value) {
    if (!isIterable(result)) {
        result = [result];
    }
    for (const r of result) {
        const failure = toFailure(r, context, struct, value);
        if (failure) {
            yield failure;
        }
    }
}
/**
 * Check a value against a struct, traversing deeply into nested values, and
 * returning an iterator of failures or success.
 */
function* run(value, struct, options = {}) {
    const { path = [], branch = [value], coerce = false, mask = false } = options;
    const ctx = { path, branch };
    if (coerce) {
        value = struct.coercer(value, ctx);
        if (mask &&
            struct.type !== 'type' &&
            isObject(struct.schema) &&
            isObject(value) &&
            !Array.isArray(value)) {
            for (const key in value) {
                if (struct.schema[key] === undefined) {
                    delete value[key];
                }
            }
        }
    }
    let status = 'valid';
    for (const failure of struct.validator(value, ctx)) {
        failure.explanation = options.message;
        status = 'not_valid';
        yield [failure, undefined];
    }
    for (let [k, v, s] of struct.entries(value, ctx)) {
        const ts = run(v, s, {
            path: k === undefined ? path : [...path, k],
            branch: k === undefined ? branch : [...branch, v],
            coerce,
            mask,
            message: options.message,
        });
        for (const t of ts) {
            if (t[0]) {
                status = t[0].refinement != null ? 'not_refined' : 'not_valid';
                yield [t[0], undefined];
            }
            else if (coerce) {
                v = t[1];
                if (k === undefined) {
                    value = v;
                }
                else if (value instanceof Map) {
                    value.set(k, v);
                }
                else if (value instanceof Set) {
                    value.add(v);
                }
                else if (isObject(value)) {
                    if (v !== undefined || k in value)
                        value[k] = v;
                }
            }
        }
    }
    if (status !== 'not_valid') {
        for (const failure of struct.refiner(value, ctx)) {
            failure.explanation = options.message;
            status = 'not_refined';
            yield [failure, undefined];
        }
    }
    if (status === 'valid') {
        yield [undefined, value];
    }
}

/**
 * `Struct` objects encapsulate the validation logic for a specific type of
 * values. Once constructed, you use the `assert`, `is` or `validate` helpers to
 * validate unknown input data against the struct.
 */
class Struct {
    constructor(props) {
        const { type, schema, validator, refiner, coercer = (value) => value, entries = function* () { }, } = props;
        this.type = type;
        this.schema = schema;
        this.entries = entries;
        this.coercer = coercer;
        if (validator) {
            this.validator = (value, context) => {
                const result = validator(value, context);
                return toFailures(result, context, this, value);
            };
        }
        else {
            this.validator = () => [];
        }
        if (refiner) {
            this.refiner = (value, context) => {
                const result = refiner(value, context);
                return toFailures(result, context, this, value);
            };
        }
        else {
            this.refiner = () => [];
        }
    }
    /**
     * Assert that a value passes the struct's validation, throwing if it doesn't.
     */
    assert(value, message) {
        return assert(value, this, message);
    }
    /**
     * Create a value with the struct's coercion logic, then validate it.
     */
    create(value, message) {
        return create(value, this, message);
    }
    /**
     * Check if a value passes the struct's validation.
     */
    is(value) {
        return is(value, this);
    }
    /**
     * Mask a value, coercing and validating it, but returning only the subset of
     * properties defined by the struct's schema.
     */
    mask(value, message) {
        return mask(value, this, message);
    }
    /**
     * Validate a value with the struct's validation logic, returning a tuple
     * representing the result.
     *
     * You may optionally pass `true` for the `withCoercion` argument to coerce
     * the value before attempting to validate it. If you do, the result will
     * contain the coerced result when successful.
     */
    validate(value, options = {}) {
        return validate(value, this, options);
    }
}
/**
 * Assert that a value passes a struct, throwing if it doesn't.
 */
function assert(value, struct, message) {
    const result = validate(value, struct, { message });
    if (result[0]) {
        throw result[0];
    }
}
/**
 * Create a value with the coercion logic of struct and validate it.
 */
function create(value, struct, message) {
    const result = validate(value, struct, { coerce: true, message });
    if (result[0]) {
        throw result[0];
    }
    else {
        return result[1];
    }
}
/**
 * Mask a value, returning only the subset of properties defined by a struct.
 */
function mask(value, struct, message) {
    const result = validate(value, struct, { coerce: true, mask: true, message });
    if (result[0]) {
        throw result[0];
    }
    else {
        return result[1];
    }
}
/**
 * Check if a value passes a struct.
 */
function is(value, struct) {
    const result = validate(value, struct);
    return !result[0];
}
/**
 * Validate a value against a struct, returning an error if invalid, or the
 * value (with potential coercion) if valid.
 */
function validate(value, struct, options = {}) {
    const tuples = run(value, struct, options);
    const tuple = shiftIterator(tuples);
    if (tuple[0]) {
        const error = new StructError(tuple[0], function* () {
            for (const t of tuples) {
                if (t[0]) {
                    yield t[0];
                }
            }
        });
        return [error, undefined];
    }
    else {
        const v = tuple[1];
        return [undefined, v];
    }
}
/**
 * Define a new struct type with a custom validation function.
 */
function define(name, validator) {
    return new Struct({ type: name, schema: null, validator });
}
function enums(values) {
    const schema = {};
    const description = values.map((v) => print(v)).join();
    for (const key of values) {
        schema[key] = key;
    }
    return new Struct({
        type: 'enums',
        schema,
        validator(value) {
            return (values.includes(value) ||
                `Expected one of \`${description}\`, but received: ${print(value)}`);
        },
    });
}
/**
 * Ensure that a value is an instance of a specific class.
 */
function instance(Class) {
    return define('instance', (value) => {
        return (value instanceof Class ||
            `Expected a \`${Class.name}\` instance, but received: ${print(value)}`);
    });
}
/**
 * Augment an existing struct to allow `null` values.
 */
function nullable(struct) {
    return new Struct({
        ...struct,
        validator: (value, ctx) => value === null || struct.validator(value, ctx),
        refiner: (value, ctx) => value === null || struct.refiner(value, ctx),
    });
}
/**
 * Ensure that a value is a number.
 */
function number() {
    return define('number', (value) => {
        return ((typeof value === 'number' && !isNaN(value)) ||
            `Expected a number, but received: ${print(value)}`);
    });
}
/**
 * Augment a struct to allow `undefined` values.
 */
function optional(struct) {
    return new Struct({
        ...struct,
        validator: (value, ctx) => value === undefined || struct.validator(value, ctx),
        refiner: (value, ctx) => value === undefined || struct.refiner(value, ctx),
    });
}
/**
 * Ensure that a value is a string.
 */
function string() {
    return define('string', (value) => {
        return (typeof value === 'string' ||
            `Expected a string, but received: ${print(value)}`);
    });
}
/**
 * Ensure that a value has a set of known properties of specific types.
 *
 * Note: Unrecognized properties are allowed and untouched. This is similar to
 * how TypeScript's structural typing works.
 */
function type(schema) {
    const keys = Object.keys(schema);
    return new Struct({
        type: 'type',
        schema,
        *entries(value) {
            if (isObject(value)) {
                for (const k of keys) {
                    yield [k, value[k], schema[k]];
                }
            }
        },
        validator(value) {
            return (isObject(value) || `Expected an object, but received: ${print(value)}`);
        },
        coercer(value) {
            return isObject(value) ? { ...value } : value;
        },
    });
}

/**
 * Augment a `Struct` to add an additional coercion step to its input.
 *
 * This allows you to transform input data before validating it, to increase the
 * likelihood that it passes validation—for example for default values, parsing
 * different formats, etc.
 *
 * Note: You must use `create(value, Struct)` on the value to have the coercion
 * take effect! Using simply `assert()` or `is()` will not use coercion.
 */
function coerce(struct, condition, coercer) {
    return new Struct({
        ...struct,
        coercer: (value, ctx) => {
            return is(value, condition)
                ? struct.coercer(coercer(value, ctx), ctx)
                : struct.coercer(value, ctx);
        },
    });
}

function solToLamports(amount) {
    if (isNaN(amount))
        return Number(0);
    return Number(amount * web3_js.LAMPORTS_PER_SOL);
}
function lamportsToSol(lamports) {
    if (typeof lamports === 'number') {
        return Math.abs(lamports) / web3_js.LAMPORTS_PER_SOL;
    }
    if (typeof lamports === 'bigint') {
        return Math.abs(Number(lamports)) / web3_js.LAMPORTS_PER_SOL;
    }
    let signMultiplier = 1;
    if (lamports.isNeg()) {
        signMultiplier = -1;
    }
    const absLamports = lamports.abs();
    const lamportsString = absLamports.toString(10).padStart(10, '0');
    const splitIndex = lamportsString.length - 9;
    const solString = lamportsString.slice(0, splitIndex) + '.' + lamportsString.slice(splitIndex);
    return signMultiplier * parseFloat(solString);
}

// Public key that identifies the metadata program.
const METADATA_PROGRAM_ID = new web3_js.PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const METADATA_MAX_NAME_LENGTH = 32;
const METADATA_MAX_SYMBOL_LENGTH = 10;
const METADATA_MAX_URI_LENGTH = 200;
// Public key that identifies the SPL Stake Pool program.
const STAKE_POOL_PROGRAM_ID = new web3_js.PublicKey('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy');
// Maximum number of validators to update during UpdateValidatorListBalance.
const MAX_VALIDATORS_TO_UPDATE = 5;
// Seed for ephemeral stake account
const EPHEMERAL_STAKE_SEED_PREFIX = buffer.Buffer.from('ephemeral');
// Seed used to derive transient stake accounts.
const TRANSIENT_STAKE_SEED_PREFIX = buffer.Buffer.from('transient');
// Minimum amount of staked SOL required in a validator stake account to allow
// for merges without a mismatch on credits observed
const MINIMUM_ACTIVE_STAKE = 1000000;
/// Current supported max by the program
const DEFAULT_MAX_VALIDATORS = 2950;

/**
 * Generates the withdraw authority program address for the stake pool
 */
function findWithdrawAuthorityProgramAddress(programId, stakePoolAddress) {
    const [publicKey] = web3_js.PublicKey.findProgramAddressSync([stakePoolAddress.toBuffer(), buffer.Buffer.from('withdraw')], programId);
    return publicKey;
}
/**
 * Generates the stake program address for a validator's vote account
 */
function findStakeProgramAddress(programId, voteAccountAddress, stakePoolAddress) {
    const [publicKey] = web3_js.PublicKey.findProgramAddressSync([voteAccountAddress.toBuffer(), stakePoolAddress.toBuffer()], programId);
    return publicKey;
}
/**
 * Generates the stake program address for a validator's vote account
 */
function findTransientStakeProgramAddress(programId, voteAccountAddress, stakePoolAddress, seed) {
    const [publicKey] = web3_js.PublicKey.findProgramAddressSync([
        TRANSIENT_STAKE_SEED_PREFIX,
        voteAccountAddress.toBuffer(),
        stakePoolAddress.toBuffer(),
        seed.toArrayLike(buffer.Buffer, 'le', 8),
    ], programId);
    return publicKey;
}
/**
 * Generates the ephemeral program address for stake pool re-delegation
 */
function findEphemeralStakeProgramAddress(programId, stakePoolAddress, seed) {
    const [publicKey] = web3_js.PublicKey.findProgramAddressSync([EPHEMERAL_STAKE_SEED_PREFIX, stakePoolAddress.toBuffer(), seed.toArrayLike(buffer.Buffer, 'le', 8)], programId);
    return publicKey;
}
/**
 * Generates the token metadata address by {@link mint}
 */
function findMetadataAddress(mint) {
    const [publicKey] = web3_js.PublicKey.findProgramAddressSync([buffer.Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()], METADATA_PROGRAM_ID);
    return publicKey;
}

const lockup = (property) => borsh.struct([borsh.u64('unixTimestamp'), borsh.u64('epoch'), borsh.publicKey('custodian')], property);
const fee = (property) => borsh.struct([borsh.u64('denominator'), borsh.u64('numerator')], property);
var AccountType;
(function (AccountType) {
    AccountType[AccountType["Uninitialized"] = 0] = "Uninitialized";
    AccountType[AccountType["StakePool"] = 1] = "StakePool";
    AccountType[AccountType["ValidatorList"] = 2] = "ValidatorList";
})(AccountType || (AccountType = {}));
const BigNumFromString = coerce(instance(BN), string(), (value) => {
    return new BN(value, 10);
});
const PublicKeyFromString = coerce(instance(web3_js.PublicKey), string(), (value) => new web3_js.PublicKey(value));
const StakeAccountType = enums(['uninitialized', 'initialized', 'delegated', 'rewardsPool']);
const StakeMeta = type({
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
const StakeAccountInfo = type({
    meta: StakeMeta,
    stake: nullable(type({
        delegation: type({
            voter: PublicKeyFromString,
            stake: BigNumFromString,
            activationEpoch: BigNumFromString,
            deactivationEpoch: BigNumFromString,
            warmupCooldownRate: number(),
        }),
        creditsObserved: number(),
    })),
});
const StakeAccount = type({
    type: StakeAccountType,
    info: optional(StakeAccountInfo),
});
const StakePoolLayout = borsh.struct([
    borsh.u8('accountType'),
    borsh.publicKey('manager'),
    borsh.publicKey('staker'),
    borsh.publicKey('stakeDepositAuthority'),
    borsh.u8('stakeWithdrawBumpSeed'),
    borsh.publicKey('validatorList'),
    borsh.publicKey('reserveStake'),
    borsh.publicKey('poolMint'),
    borsh.publicKey('managerFeeAccount'),
    borsh.publicKey('tokenProgramId'),
    borsh.u64('totalLamports'),
    borsh.u64('poolTokenSupply'),
    borsh.u64('lastUpdateEpoch'),
    lockup('lockup'),
    fee('epochFee'),
    futureEpoch(fee(), 'nextEpochFee'),
    borsh.option(borsh.publicKey(), 'preferredDepositValidatorVoteAddress'),
    borsh.option(borsh.publicKey(), 'preferredWithdrawValidatorVoteAddress'),
    fee('stakeDepositFee'),
    fee('stakeWithdrawalFee'),
    fee('nextStakeWithdrawalFee'),
    futureEpoch(fee(), 'nextStakeWithdrawalFee'),
    borsh.u8('stakeReferralFee'),
    borsh.option(borsh.publicKey(), 'solDepositAuthority'),
    fee('solDepositFee'),
    borsh.u8('solReferralFee'),
    borsh.option(borsh.publicKey(), 'solWithdrawAuthority'),
    fee('solWithdrawalFee'),
    futureEpoch(fee(), 'nextSolWithdrawalFee'),
    borsh.u64('lastEpochPoolTokenSupply'),
    borsh.u64('lastEpochTotalLamports'),
]);
// 1 + 32*3 + 1 + 32*5 + 8*3 + (8+8+32) + 16 + 17  + 33*2 + 16*3 + 17 + 1 + 33 + 16 + 1 + 33 + 16 + 17 + 8 + 8
StakePoolLayout.span = 627;
var ValidatorStakeInfoStatus;
(function (ValidatorStakeInfoStatus) {
    ValidatorStakeInfoStatus[ValidatorStakeInfoStatus["Active"] = 0] = "Active";
    ValidatorStakeInfoStatus[ValidatorStakeInfoStatus["DeactivatingTransient"] = 1] = "DeactivatingTransient";
    ValidatorStakeInfoStatus[ValidatorStakeInfoStatus["ReadyForRemoval"] = 2] = "ReadyForRemoval";
})(ValidatorStakeInfoStatus || (ValidatorStakeInfoStatus = {}));
const ValidatorStakeInfoLayout = borsh.struct([
    /// Amount of active stake delegated to this validator
    /// Note that if `last_update_epoch` does not match the current epoch then
    /// this field may not be accurate
    borsh.u64('activeStakeLamports'),
    /// Amount of transient stake delegated to this validator
    /// Note that if `last_update_epoch` does not match the current epoch then
    /// this field may not be accurate
    borsh.u64('transientStakeLamports'),
    /// Last epoch the active and transient stake lamports fields were updated
    borsh.u64('lastUpdateEpoch'),
    /// Start of the validator transient account seed suffixes
    borsh.u64('transientSeedSuffixStart'),
    /// End of the validator transient account seed suffixes
    borsh.u64('transientSeedSuffixEnd'),
    /// Status of the validator stake account
    borsh.u8('status'),
    /// Validator vote account address
    borsh.publicKey('voteAccountAddress'),
]);
const ValidatorListLayout = borsh.struct([
    borsh.u8('accountType'),
    borsh.u32('maxValidators'),
    borsh.vec(ValidatorStakeInfoLayout, 'validators'),
]);
// 1 + 4 + 4
ValidatorListLayout.span = 9;

async function getValidatorListAccount(connection, pubkey) {
    const account = await connection.getAccountInfo(pubkey);
    if (!account) {
        throw new Error('Invalid validator list account');
    }
    return {
        pubkey,
        account: {
            data: ValidatorListLayout.decode(account === null || account === void 0 ? void 0 : account.data),
            executable: account.executable,
            lamports: account.lamports,
            owner: account.owner,
        },
    };
}
async function prepareWithdrawAccounts(connection, stakePool, stakePoolAddress, amount, compareFn, skipFee) {
    var _a, _b, _c;
    const validatorListAcc = await connection.getAccountInfo(stakePool.validatorList);
    const validatorList = ValidatorListLayout.decode(Buffer.from((_a = validatorListAcc === null || validatorListAcc === void 0 ? void 0 : validatorListAcc.data) !== null && _a !== void 0 ? _a : []));
    if (!(validatorList === null || validatorList === void 0 ? void 0 : validatorList.validators) || (validatorList === null || validatorList === void 0 ? void 0 : validatorList.validators.length) === 0) {
        throw new Error('No accounts found');
    }
    const minBalanceForRentExemption = await connection.getMinimumBalanceForRentExemption(web3_js.StakeProgram.space);
    const minBalance = minBalanceForRentExemption + MINIMUM_ACTIVE_STAKE;
    const types = ['preferred', 'active', 'transient', 'reserve'];
    let accounts = [];
    // Prepare accounts
    for (const validator of validatorList.validators) {
        if (validator.status !== ValidatorStakeInfoStatus.Active) {
            continue;
        }
        const stakeAccountAddress = findStakeProgramAddress(STAKE_POOL_PROGRAM_ID, validator.voteAccountAddress, stakePoolAddress);
        if (!validator.activeStakeLamports.isZero()) {
            const isPreferred = (_b = stakePool === null || stakePool === void 0 ? void 0 : stakePool.preferredWithdrawValidatorVoteAddress) === null || _b === void 0 ? void 0 : _b.equals(validator.voteAccountAddress);
            accounts.push({
                type: isPreferred ? 'preferred' : 'active',
                voteAddress: validator.voteAccountAddress,
                stakeAddress: stakeAccountAddress,
                lamports: validator.activeStakeLamports.toNumber(),
            });
        }
        const transientStakeLamports = validator.transientStakeLamports.toNumber() - minBalance;
        if (transientStakeLamports > 0) {
            const transientStakeAccountAddress = findTransientStakeProgramAddress(STAKE_POOL_PROGRAM_ID, validator.voteAccountAddress, stakePoolAddress, validator.transientSeedSuffixStart);
            accounts.push({
                type: 'transient',
                voteAddress: validator.voteAccountAddress,
                stakeAddress: transientStakeAccountAddress,
                lamports: transientStakeLamports,
            });
        }
    }
    // Sort from highest to lowest balance
    accounts = accounts.sort(compareFn || ((a, b) => b.lamports - a.lamports));
    const reserveStake = await connection.getAccountInfo(stakePool.reserveStake);
    const reserveStakeBalance = ((_c = reserveStake === null || reserveStake === void 0 ? void 0 : reserveStake.lamports) !== null && _c !== void 0 ? _c : 0) - minBalanceForRentExemption - 1;
    if (reserveStakeBalance > 0) {
        accounts.push({
            type: 'reserve',
            stakeAddress: stakePool.reserveStake,
            lamports: reserveStakeBalance,
        });
    }
    // Prepare the list of accounts to withdraw from
    const withdrawFrom = [];
    let remainingAmount = amount;
    const fee = stakePool.stakeWithdrawalFee;
    const inverseFee = {
        numerator: fee.denominator.sub(fee.numerator),
        denominator: fee.denominator,
    };
    for (const type of types) {
        const filteredAccounts = accounts.filter((a) => a.type === type);
        for (const { stakeAddress, voteAddress, lamports } of filteredAccounts) {
            if (lamports <= minBalance && type === 'transient') {
                continue;
            }
            let availableForWithdrawal = calcPoolTokensForDeposit(stakePool, lamports);
            if (!skipFee && !inverseFee.numerator.isZero()) {
                availableForWithdrawal = divideBnToNumber(new BN(availableForWithdrawal).mul(inverseFee.denominator), inverseFee.numerator);
            }
            const poolAmount = Math.min(availableForWithdrawal, remainingAmount);
            if (poolAmount <= 0) {
                continue;
            }
            // Those accounts will be withdrawn completely with `claim` instruction
            withdrawFrom.push({ stakeAddress, voteAddress, poolAmount });
            remainingAmount -= poolAmount;
            if (remainingAmount === 0) {
                break;
            }
        }
        if (remainingAmount === 0) {
            break;
        }
    }
    // Not enough stake to withdraw the specified amount
    if (remainingAmount > 0) {
        throw new Error(`No stake accounts found in this pool with enough balance to withdraw ${lamportsToSol(amount)} pool tokens.`);
    }
    return withdrawFrom;
}
/**
 * Calculate the pool tokens that should be minted for a deposit of `stakeLamports`
 */
function calcPoolTokensForDeposit(stakePool, stakeLamports) {
    if (stakePool.poolTokenSupply.isZero() || stakePool.totalLamports.isZero()) {
        return stakeLamports;
    }
    return Math.floor(divideBnToNumber(new BN(stakeLamports).mul(stakePool.poolTokenSupply), stakePool.totalLamports));
}
/**
 * Calculate lamports amount on withdrawal
 */
function calcLamportsWithdrawAmount(stakePool, poolTokens) {
    const numerator = new BN(poolTokens).mul(stakePool.totalLamports);
    const denominator = stakePool.poolTokenSupply;
    if (numerator.lt(denominator)) {
        return 0;
    }
    return divideBnToNumber(numerator, denominator);
}
function divideBnToNumber(numerator, denominator) {
    if (denominator.isZero()) {
        return 0;
    }
    const quotient = numerator.div(denominator).toNumber();
    const rem = numerator.umod(denominator);
    const gcd = rem.gcd(denominator);
    return quotient + rem.div(gcd).toNumber() / denominator.div(gcd).toNumber();
}
function newStakeAccount(feePayer, instructions, lamports) {
    // Account for tokens not specified, creating one
    const stakeReceiverKeypair = web3_js.Keypair.generate();
    console.log(`Creating account to receive stake ${stakeReceiverKeypair.publicKey}`);
    instructions.push(
    // Creating new account
    web3_js.SystemProgram.createAccount({
        fromPubkey: feePayer,
        newAccountPubkey: stakeReceiverKeypair.publicKey,
        lamports,
        space: web3_js.StakeProgram.space,
        programId: web3_js.StakeProgram.programId,
    }));
    return stakeReceiverKeypair;
}

/**
 * Populate a buffer of instruction data using an InstructionType
 * @internal
 */
function encodeData(type, fields) {
    const allocLength = type.layout.span;
    const data = buffer.Buffer.alloc(allocLength < 0 ? 1024 : allocLength);
    const layoutFields = Object.assign({ instruction: type.index }, fields);
    const offset = type.layout.encode(layoutFields, data);
    return buffer.Buffer.from(new Uint8Array(data.buffer).slice(0, offset));
}

/* The MIT License (MIT)
 *
 * Copyright 2015-2018 Peter A. Bigot
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

/**
 * Base class for layout objects.
 *
 * **NOTE** This is an abstract base class; you can create instances
 * if it amuses you, but they won't support the {@link
 * Layout#encode|encode} or {@link Layout#decode|decode} functions.
 *
 * @param {Number} span - Initializer for {@link Layout#span|span}.  The
 * parameter must be an integer; a negative value signifies that the
 * span is {@link Layout#getSpan|value-specific}.
 *
 * @param {string} [property] - Initializer for {@link
 * Layout#property|property}.
 *
 * @abstract
 */
class Layout {
  constructor(span, property) {
    if (!Number.isInteger(span)) {
      throw new TypeError('span must be an integer');
    }

    /** The span of the layout in bytes.
     *
     * Positive values are generally expected.
     *
     * Zero will only appear in {@link Constant}s and in {@link
     * Sequence}s where the {@link Sequence#count|count} is zero.
     *
     * A negative value indicates that the span is value-specific, and
     * must be obtained using {@link Layout#getSpan|getSpan}. */
    this.span = span;

    /** The property name used when this layout is represented in an
     * Object.
     *
     * Used only for layouts that {@link Layout#decode|decode} to Object
     * instances.  If left undefined the span of the unnamed layout will
     * be treated as padding: it will not be mutated by {@link
     * Layout#encode|encode} nor represented as a property in the
     * decoded Object. */
    this.property = property;
  }

  /** Function to create an Object into which decoded properties will
   * be written.
   *
   * Used only for layouts that {@link Layout#decode|decode} to Object
   * instances, which means:
   * * {@link Structure}
   * * {@link Union}
   * * {@link VariantLayout}
   * * {@link BitStructure}
   *
   * If left undefined the JavaScript representation of these layouts
   * will be Object instances.
   *
   * See {@link bindConstructorLayout}.
   */
  makeDestinationObject() {
    return {};
  }

  /**
   * Decode from a Buffer into an JavaScript value.
   *
   * @param {Buffer} b - the buffer from which encoded data is read.
   *
   * @param {Number} [offset] - the offset at which the encoded data
   * starts.  If absent a zero offset is inferred.
   *
   * @returns {(Number|Array|Object)} - the value of the decoded data.
   *
   * @abstract
   */
  decode(b, offset) {
    throw new Error('Layout is abstract');
  }

  /**
   * Encode a JavaScript value into a Buffer.
   *
   * @param {(Number|Array|Object)} src - the value to be encoded into
   * the buffer.  The type accepted depends on the (sub-)type of {@link
   * Layout}.
   *
   * @param {Buffer} b - the buffer into which encoded data will be
   * written.
   *
   * @param {Number} [offset] - the offset at which the encoded data
   * starts.  If absent a zero offset is inferred.
   *
   * @returns {Number} - the number of bytes encoded, including the
   * space skipped for internal padding, but excluding data such as
   * {@link Sequence#count|lengths} when stored {@link
   * ExternalLayout|externally}.  This is the adjustment to `offset`
   * producing the offset where data for the next layout would be
   * written.
   *
   * @abstract
   */
  encode(src, b, offset) {
    throw new Error('Layout is abstract');
  }

  /**
   * Calculate the span of a specific instance of a layout.
   *
   * @param {Buffer} b - the buffer that contains an encoded instance.
   *
   * @param {Number} [offset] - the offset at which the encoded instance
   * starts.  If absent a zero offset is inferred.
   *
   * @return {Number} - the number of bytes covered by the layout
   * instance.  If this method is not overridden in a subclass the
   * definition-time constant {@link Layout#span|span} will be
   * returned.
   *
   * @throws {RangeError} - if the length of the value cannot be
   * determined.
   */
  getSpan(b, offset) {
    if (0 > this.span) {
      throw new RangeError('indeterminate span');
    }
    return this.span;
  }

  /**
   * Replicate the layout using a new property.
   *
   * This function must be used to get a structurally-equivalent layout
   * with a different name since all {@link Layout} instances are
   * immutable.
   *
   * **NOTE** This is a shallow copy.  All fields except {@link
   * Layout#property|property} are strictly equal to the origin layout.
   *
   * @param {String} property - the value for {@link
   * Layout#property|property} in the replica.
   *
   * @returns {Layout} - the copy with {@link Layout#property|property}
   * set to `property`.
   */
  replicate(property) {
    const rv = Object.create(this.constructor.prototype);
    Object.assign(rv, this);
    rv.property = property;
    return rv;
  }

  /**
   * Create an object from layout properties and an array of values.
   *
   * **NOTE** This function returns `undefined` if invoked on a layout
   * that does not return its value as an Object.  Objects are
   * returned for things that are a {@link Structure}, which includes
   * {@link VariantLayout|variant layouts} if they are structures, and
   * excludes {@link Union}s.  If you want this feature for a union
   * you must use {@link Union.getVariant|getVariant} to select the
   * desired layout.
   *
   * @param {Array} values - an array of values that correspond to the
   * default order for properties.  As with {@link Layout#decode|decode}
   * layout elements that have no property name are skipped when
   * iterating over the array values.  Only the top-level properties are
   * assigned; arguments are not assigned to properties of contained
   * layouts.  Any unused values are ignored.
   *
   * @return {(Object|undefined)}
   */
  fromArray(values) {
    return undefined;
  }
}
var Layout_2 = Layout;

/* Provide text that carries a name (such as for a function that will
 * be throwing an error) annotated with the property of a given layout
 * (such as one for which the value was unacceptable).
 *
 * @ignore */
function nameWithProperty(name, lo) {
  if (lo.property) {
    return name + '[' + lo.property + ']';
  }
  return name;
}

/**
 * An object that behaves like a layout but does not consume space
 * within its containing layout.
 *
 * This is primarily used to obtain metadata about a member, such as a
 * {@link OffsetLayout} that can provide data about a {@link
 * Layout#getSpan|value-specific span}.
 *
 * **NOTE** This is an abstract base class; you can create instances
 * if it amuses you, but they won't support {@link
 * ExternalLayout#isCount|isCount} or other {@link Layout} functions.
 *
 * @param {Number} span - initializer for {@link Layout#span|span}.
 * The parameter can range from 1 through 6.
 *
 * @param {string} [property] - initializer for {@link
 * Layout#property|property}.
 *
 * @abstract
 * @augments {Layout}
 */
class ExternalLayout extends Layout {
  /**
   * Return `true` iff the external layout decodes to an unsigned
   * integer layout.
   *
   * In that case it can be used as the source of {@link
   * Sequence#count|Sequence counts}, {@link Blob#length|Blob lengths},
   * or as {@link UnionLayoutDiscriminator#layout|external union
   * discriminators}.
   *
   * @abstract
   */
  isCount() {
    throw new Error('ExternalLayout is abstract');
  }
}

/**
 * Represent an unsigned integer in little-endian format.
 *
 * *Factory*: {@link module:Layout.u8|u8}, {@link
 *  module:Layout.u16|u16}, {@link module:Layout.u24|u24}, {@link
 *  module:Layout.u32|u32}, {@link module:Layout.u40|u40}, {@link
 *  module:Layout.u48|u48}
 *
 * @param {Number} span - initializer for {@link Layout#span|span}.
 * The parameter can range from 1 through 6.
 *
 * @param {string} [property] - initializer for {@link
 * Layout#property|property}.
 *
 * @augments {Layout}
 */
class UInt extends Layout {
  constructor(span, property) {
    super(span, property);
    if (6 < this.span) {
      throw new RangeError('span must not exceed 6 bytes');
    }
  }

  /** @override */
  decode(b, offset) {
    if (undefined === offset) {
      offset = 0;
    }
    return b.readUIntLE(offset, this.span);
  }

  /** @override */
  encode(src, b, offset) {
    if (undefined === offset) {
      offset = 0;
    }
    b.writeUIntLE(src, offset, this.span);
    return this.span;
  }
}
/* eslint-enable no-extend-native */

/**
 * Contain a fixed-length block of arbitrary data, represented as a
 * Buffer.
 *
 * *Factory*: {@link module:Layout.blob|blob}
 *
 * @param {(Number|ExternalLayout)} length - initializes {@link
 * Blob#length|length}.
 *
 * @param {String} [property] - initializer for {@link
 * Layout#property|property}.
 *
 * @augments {Layout}
 */
class Blob extends Layout {
  constructor(length, property) {
    if (!(((length instanceof ExternalLayout) && length.isCount())
          || (Number.isInteger(length) && (0 <= length)))) {
      throw new TypeError('length must be positive integer '
                          + 'or an unsigned integer ExternalLayout');
    }

    let span = -1;
    if (!(length instanceof ExternalLayout)) {
      span = length;
    }
    super(span, property);

    /** The number of bytes in the blob.
     *
     * This may be a non-negative integer, or an instance of {@link
     * ExternalLayout} that satisfies {@link
     * ExternalLayout#isCount|isCount()}. */
    this.length = length;
  }

  /** @override */
  getSpan(b, offset) {
    let span = this.span;
    if (0 > span) {
      span = this.length.decode(b, offset);
    }
    return span;
  }

  /** @override */
  decode(b, offset) {
    if (undefined === offset) {
      offset = 0;
    }
    let span = this.span;
    if (0 > span) {
      span = this.length.decode(b, offset);
    }
    return b.slice(offset, offset + span);
  }

  /** Implement {@link Layout#encode|encode} for {@link Blob}.
   *
   * **NOTE** If {@link Layout#count|count} is an instance of {@link
   * ExternalLayout} then the length of `src` will be encoded as the
   * count after `src` is encoded. */
  encode(src, b, offset) {
    let span = this.length;
    if (this.length instanceof ExternalLayout) {
      span = src.length;
    }
    if (!(Buffer.isBuffer(src)
          && (span === src.length))) {
      throw new TypeError(nameWithProperty('Blob.encode', this)
                          + ' requires (length ' + span + ') Buffer as src');
    }
    if ((offset + span) > b.length) {
      throw new RangeError('encoding overruns Buffer');
    }
    b.write(src.toString('hex'), offset, span, 'hex');
    if (this.length instanceof ExternalLayout) {
      this.length.encode(span, b, offset);
    }
    return span;
  }
}

/** Factory for {@link UInt|unsigned int layouts} spanning one
 * byte. */
var u8 = (property => new UInt(1, property));

/** Factory for {@link Blob} values. */
var blob = ((length, property) => new Blob(length, property));

class FutureEpochLayout extends Layout_2 {
    constructor(layout, property) {
        super(-1, property);
        this.layout = layout;
        this.discriminator = u8();
    }
    encode(src, b, offset = 0) {
        if (src === null || src === undefined) {
            return this.discriminator.encode(0, b, offset);
        }
        this.discriminator.encode(1, b, offset);
        return this.layout.encode(src, b, offset + 1) + 1;
    }
    decode(b, offset = 0) {
        const discriminator = this.discriminator.decode(b, offset);
        if (discriminator === 0) {
            return null;
        }
        return this.layout.decode(b, offset + 1);
    }
    getSpan(b, offset = 0) {
        const discriminator = this.discriminator.decode(b, offset);
        if (discriminator === 0) {
            return 1;
        }
        return this.layout.getSpan(b, offset + 1) + 1;
    }
}
function futureEpoch(layout, property) {
    return new FutureEpochLayout(layout, property);
}

function arrayChunk(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

// 'UpdateTokenMetadata' and 'CreateTokenMetadata' have dynamic layouts
const MOVE_STAKE_LAYOUT = borsh.struct([borsh.u8('instruction'), borsh.u64('lamports'), borsh.u64('transientStakeSeed')]);
function feeLayout(property) {
    return borsh.struct([borsh.u64('denominator'), borsh.u64('numerator')], property);
}
function tokenMetadataLayout(instruction, nameLength, symbolLength, uriLength) {
    if (nameLength > METADATA_MAX_NAME_LENGTH) {
        throw new Error(`maximum token name length is ${METADATA_MAX_NAME_LENGTH} characters`);
    }
    if (symbolLength > METADATA_MAX_SYMBOL_LENGTH) {
        throw new Error(`maximum token symbol length is ${METADATA_MAX_SYMBOL_LENGTH} characters`);
    }
    if (uriLength > METADATA_MAX_URI_LENGTH) {
        throw new Error(`maximum token uri length is ${METADATA_MAX_URI_LENGTH} characters`);
    }
    return {
        index: instruction,
        layout: borsh.struct([
            borsh.u8('instruction'),
            borsh.u32('nameLen'),
            blob(nameLength, 'name'),
            borsh.u32('symbolLen'),
            blob(symbolLength, 'symbol'),
            borsh.u32('uriLen'),
            blob(uriLength, 'uri'),
        ]),
    };
}
/**
 * An enumeration of valid stake InstructionType's
 * @internal
 */
const STAKE_POOL_INSTRUCTION_LAYOUTS = Object.freeze({
    /// Initializes a new StakePool.
    Initialize: {
        index: 0,
        layout: borsh.struct([
            borsh.u8('instruction'),
            feeLayout('fee'),
            feeLayout('withdrawalFee'),
            feeLayout('depositFee'),
            borsh.u8('referralFee'),
            borsh.u32('maxValidators'),
        ]),
    },
    /// (Staker only) Adds stake account delegated to validator to the pool's list of managed validators.
    AddValidatorToPool: {
        index: 1,
        layout: borsh.struct([
            borsh.u8('instruction'),
            // Optional non-zero u32 seed used for generating the validator stake address
            borsh.u32('seed'),
        ]),
    },
    /// (Staker only) Removes validator from the pool, deactivating its stake.
    RemoveValidatorFromPool: {
        index: 2,
        layout: borsh.struct([borsh.u8('instruction')]),
    },
    /// (Staker only) Decrease active stake on a validator, eventually moving it to the reserve.
    DecreaseValidatorStake: {
        index: 3,
        layout: MOVE_STAKE_LAYOUT,
    },
    /// (Staker only) Increase stake on a validator from the reserve account.
    IncreaseValidatorStake: {
        index: 4,
        layout: MOVE_STAKE_LAYOUT,
    },
    /// (Staker only) Set the preferred deposit or withdraw stake account for the stake pool.
    SetPreferredValidator: {
        index: 5,
        layout: borsh.struct([
            borsh.u8('instruction'),
            borsh.u8('validatorType'),
            borsh.option(borsh.publicKey(), 'validatorVoteAddress'),
        ]),
    },
    /// Updates balances of validator and transient stake accounts in the pool.
    UpdateValidatorListBalance: {
        index: 6,
        layout: borsh.struct([borsh.u8('instruction'), borsh.u32('startIndex'), borsh.u8('noMerge')]),
    },
    /// Updates total pool balance based on balances in the reserve and validator list.
    UpdateStakePoolBalance: {
        index: 7,
        layout: borsh.struct([borsh.u8('instruction')]),
    },
    /// Cleans up validator stake account entries marked as `ReadyForRemoval`.
    CleanupRemovedValidatorEntries: {
        index: 8,
        layout: borsh.struct([borsh.u8('instruction')]),
    },
    /// Deposit some stake into the pool. The output is a "pool" token
    /// representing ownership into the pool. Inputs are converted to the
    /// current ratio.
    DepositStake: {
        index: 9,
        layout: borsh.struct([borsh.u8('instruction')]),
    },
    /// Withdraw the token from the pool at the current ratio.
    WithdrawStake: {
        index: 10,
        layout: borsh.struct([borsh.u8('instruction'), borsh.u64('poolTokens')]),
    },
    /// (Manager only) Update manager.
    SetManager: {
        index: 11,
        layout: borsh.struct([borsh.u8('instruction')]),
    },
    /// (Manager only) Update fee.
    SetFee: {
        index: 12,
        layout: borsh.struct([
            borsh.u8('instruction'),
            // Type of fee to update and value to update it to
            borsh.u64('fee'),
        ]),
    },
    /// (Manager or staker only) Update staker.
    SetStaker: {
        index: 13,
        layout: borsh.struct([borsh.u8('instruction')]),
    },
    /// Deposit SOL directly into the pool's reserve account. The output is a "pool" token
    /// representing ownership into the pool. Inputs are converted to the current ratio.
    DepositSol: {
        index: 14,
        layout: borsh.struct([borsh.u8('instruction'), borsh.u64('lamports')]),
    },
    /// (Manager only) Update SOL deposit, stake deposit, or SOL withdrawal authority.
    SetFundingAuthority: {
        index: 15,
        layout: borsh.struct([borsh.u8('instruction'), borsh.u8('fundingType')]),
    },
    /// Withdraw SOL directly from the pool's reserve account. Fails if the
    /// reserve does not have enough SOL.
    WithdrawSol: {
        index: 16,
        layout: borsh.struct([borsh.u8('instruction'), borsh.u64('poolTokens')]),
    },
    /// (Staker only) Increase stake on a validator again in an epoch.
    IncreaseAdditionalValidatorStake: {
        index: 19,
        layout: borsh.struct([
            borsh.u8('instruction'),
            borsh.u64('lamports'),
            borsh.u64('transientStakeSeed'),
            borsh.u64('ephemeralStakeSeed'),
        ]),
    },
    /// (Staker only) Decrease active stake again from a validator, eventually
    /// moving it to the reserve.
    DecreaseAdditionalValidatorStake: {
        index: 20,
        layout: borsh.struct([
            borsh.u8('instruction'),
            borsh.u64('lamports'),
            borsh.u64('transientStakeSeed'),
            borsh.u64('ephemeralStakeSeed'),
        ]),
    },
    /// (Staker only) Decrease active stake on a validator, eventually moving it
    /// to the reserve.
    DecreaseValidatorStakeWithReserve: {
        index: 21,
        layout: MOVE_STAKE_LAYOUT,
    },
    /// (Staker only) Redelegate active stake on a validator, eventually moving
    /// it to another.
    Redelegate: {
        index: 22,
        layout: borsh.struct([
            borsh.u8('instruction'),
            /// Amount of lamports to redelegate
            borsh.u64('lamports'),
            /// Seed used to create source transient stake account
            borsh.u64('sourceTransientStakeSeed'),
            /// Seed used to create destination ephemeral account.
            borsh.u64('ephemeralStakeSeed'),
            /// Seed used to create destination transient stake account. If there is
            /// already transient stake, this must match the current seed, otherwise
            /// it can be anything
            borsh.u64('destinationTransientStakeSeed'),
        ]),
    },
    /// Deposit some stake into the pool, with a specified slippage
    /// constraint. The output is a "pool" token representing ownership
    /// into the pool. Inputs are converted at the current ratio.
    DepositStakeWithSlippage: {
        index: 23,
        layout: borsh.struct([
            borsh.u8('instruction'),
            /// Minimum amount of pool tokens that must be received
            borsh.u64('minimumPoolTokensOut'),
        ]),
    },
    /// Withdraw the token from the pool at the current ratio, specifying a
    /// minimum expected output lamport amount.
    WithdrawStakeWithSlippage: {
        index: 24,
        layout: borsh.struct([
            borsh.u8('instruction'),
            /// Pool tokens to burn in exchange for lamports
            borsh.u64('poolTokensIn'),
            /// Minimum amount of lamports that must be received
            borsh.u64('minimumLamportsOut'),
        ]),
    },
    /// Deposit SOL directly into the pool's reserve account, with a
    /// specified slippage constraint. The output is a "pool" token
    /// representing ownership into the pool. Inputs are converted at the
    /// current ratio.
    DepositSolWithSlippage: {
        index: 25,
        layout: borsh.struct([
            borsh.u8('instruction'),
            /// Amount of lamports to deposit into the reserve
            borsh.u64('lamportsIn'),
            /// Minimum amount of pool tokens that must be received
            borsh.u64('minimumPoolTokensOut'),
        ]),
    },
    /// Withdraw SOL directly from the pool's reserve account. Fails if the
    /// reserve does not have enough SOL or if the slippage constraint is not
    /// met.
    WithdrawSolWithSlippage: {
        index: 26,
        layout: borsh.struct([
            borsh.u8('instruction'),
            /// Pool tokens to burn in exchange for lamports
            borsh.u64('poolTokensIn'),
            /// Minimum amount of lamports that must be received
            borsh.u64('minimumLamportsOut'),
        ]),
    },
});
/**
 * Stake Pool Instruction class
 */
class StakePoolInstruction {
    /**
     * Creates an 'initialize' instruction.
     */
    static initialize(params) {
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.Initialize, {
            fee: params.fee,
            withdrawalFee: params.withdrawalFee,
            depositFee: params.depositFee,
            referralFee: params.referralFee,
            maxValidators: params.maxValidators,
        });
        const keys = [
            { pubkey: params.stakePool, isSigner: false, isWritable: true },
            { pubkey: params.manager, isSigner: true, isWritable: false },
            { pubkey: params.staker, isSigner: false, isWritable: false },
            { pubkey: params.stakePoolWithdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: params.validatorList, isSigner: false, isWritable: true },
            { pubkey: params.reserveStake, isSigner: false, isWritable: false },
            { pubkey: params.poolMint, isSigner: false, isWritable: true },
            { pubkey: params.managerPoolAccount, isSigner: false, isWritable: true },
            { pubkey: splToken.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ];
        if (params.depositAuthority) {
            keys.push({ pubkey: params.depositAuthority, isSigner: true, isWritable: false });
        }
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates instruction to add a validator to the pool.
     */
    static addValidatorToPool(params) {
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.AddValidatorToPool, {
            seed: params.seed,
        });
        const keys = [
            { pubkey: params.stakePool, isSigner: false, isWritable: true },
            { pubkey: params.staker, isSigner: true, isWritable: false },
            { pubkey: params.reserveStake, isSigner: false, isWritable: true },
            { pubkey: params.withdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: params.validatorList, isSigner: false, isWritable: true },
            { pubkey: params.validatorStake, isSigner: false, isWritable: true },
            { pubkey: params.validatorVote, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.STAKE_CONFIG_ID, isSigner: false, isWritable: false },
            { pubkey: web3_js.SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: web3_js.StakeProgram.programId, isSigner: false, isWritable: false },
        ];
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates instruction to remove a validator from the pool.
     */
    static removeValidatorFromPool(params) {
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.RemoveValidatorFromPool);
        const keys = [
            { pubkey: params.stakePool, isSigner: false, isWritable: true },
            { pubkey: params.staker, isSigner: true, isWritable: false },
            { pubkey: params.withdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: params.validatorList, isSigner: false, isWritable: true },
            { pubkey: params.validatorStake, isSigner: false, isWritable: true },
            { pubkey: params.transientStake, isSigner: false, isWritable: true },
            { pubkey: web3_js.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.StakeProgram.programId, isSigner: false, isWritable: false },
        ];
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates instruction to update a set of validators in the stake pool.
     */
    static updateValidatorListBalance(params) {
        const { stakePool, withdrawAuthority, validatorList, reserveStake, startIndex, noMerge, validatorAndTransientStakePairs, } = params;
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.UpdateValidatorListBalance, {
            startIndex,
            noMerge: noMerge ? 1 : 0,
        });
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: false },
            { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: validatorList, isSigner: false, isWritable: true },
            { pubkey: reserveStake, isSigner: false, isWritable: true },
            { pubkey: web3_js.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.StakeProgram.programId, isSigner: false, isWritable: false },
            ...validatorAndTransientStakePairs.map((pubkey) => ({
                pubkey,
                isSigner: false,
                // https://github.com/solana-labs/solana-program-library/blob/f36c2fb5a24bd87e04c60a509aec94304798c1a3/stake-pool/program/src/instruction.rs#L238C22-L238C22
                isWritable: true, // TODO: false ?
            })),
        ];
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates instruction to update the overall stake pool balance.
     */
    static updateStakePoolBalance(params) {
        const { stakePool, withdrawAuthority, validatorList, reserveStake, managerFeeAccount, poolMint, } = params;
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.UpdateStakePoolBalance);
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: true },
            { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: validatorList, isSigner: false, isWritable: true },
            { pubkey: reserveStake, isSigner: false, isWritable: false },
            { pubkey: managerFeeAccount, isSigner: false, isWritable: true },
            { pubkey: poolMint, isSigner: false, isWritable: true },
            { pubkey: splToken.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ];
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates instruction to clean up removed validator entries.
     */
    static cleanupRemovedValidatorEntries(params) {
        const { stakePool, validatorList } = params;
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.CleanupRemovedValidatorEntries);
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: false },
            { pubkey: validatorList, isSigner: false, isWritable: true },
        ];
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates `IncreaseValidatorStake` instruction (rebalance from reserve account to
     * transient account)
     */
    static increaseValidatorStake(params) {
        const { stakePool, staker, withdrawAuthority, validatorList, reserveStake, transientStake, validatorStake, validatorVote, lamports, transientStakeSeed, } = params;
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.IncreaseValidatorStake, {
            lamports: new BN(lamports),
            transientStakeSeed: new BN(transientStakeSeed),
        });
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: false },
            { pubkey: staker, isSigner: true, isWritable: false },
            { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: validatorList, isSigner: false, isWritable: true },
            { pubkey: reserveStake, isSigner: false, isWritable: true },
            { pubkey: transientStake, isSigner: false, isWritable: true },
            { pubkey: validatorStake, isSigner: false, isWritable: false },
            { pubkey: validatorVote, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.STAKE_CONFIG_ID, isSigner: false, isWritable: false },
            { pubkey: web3_js.SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: web3_js.StakeProgram.programId, isSigner: false, isWritable: false },
        ];
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates `IncreaseAdditionalValidatorStake` instruction (rebalance from reserve account to
     * transient account)
     */
    static increaseAdditionalValidatorStake(params) {
        const { stakePool, staker, withdrawAuthority, validatorList, reserveStake, transientStake, validatorStake, validatorVote, lamports, transientStakeSeed, ephemeralStake, ephemeralStakeSeed, } = params;
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.IncreaseAdditionalValidatorStake, {
            lamports: new BN(lamports),
            transientStakeSeed: new BN(transientStakeSeed),
            ephemeralStakeSeed: new BN(ephemeralStakeSeed),
        });
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: false },
            { pubkey: staker, isSigner: true, isWritable: false },
            { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: validatorList, isSigner: false, isWritable: true },
            { pubkey: reserveStake, isSigner: false, isWritable: true },
            { pubkey: ephemeralStake, isSigner: false, isWritable: true },
            { pubkey: transientStake, isSigner: false, isWritable: true },
            { pubkey: validatorStake, isSigner: false, isWritable: false },
            { pubkey: validatorVote, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.STAKE_CONFIG_ID, isSigner: false, isWritable: false },
            { pubkey: web3_js.SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: web3_js.StakeProgram.programId, isSigner: false, isWritable: false },
        ];
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates `DecreaseValidatorStake` instruction (rebalance from validator account to
     * transient account)
     */
    static decreaseValidatorStake(params) {
        const { stakePool, staker, withdrawAuthority, validatorList, validatorStake, transientStake, lamports, transientStakeSeed, } = params;
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.DecreaseValidatorStake, {
            lamports: new BN(lamports),
            transientStakeSeed: new BN(transientStakeSeed),
        });
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: false },
            { pubkey: staker, isSigner: true, isWritable: false },
            { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: validatorList, isSigner: false, isWritable: true },
            { pubkey: validatorStake, isSigner: false, isWritable: true },
            { pubkey: transientStake, isSigner: false, isWritable: true },
            { pubkey: web3_js.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: web3_js.StakeProgram.programId, isSigner: false, isWritable: false },
        ];
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates `DecreaseValidatorStakeWithReserve` instruction (rebalance from
     * validator account to transient account)
     */
    static decreaseValidatorStakeWithReserve(params) {
        const { stakePool, staker, withdrawAuthority, validatorList, reserveStake, validatorStake, transientStake, lamports, transientStakeSeed, } = params;
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.DecreaseValidatorStakeWithReserve, {
            lamports: new BN(lamports),
            transientStakeSeed: new BN(transientStakeSeed),
        });
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: false },
            { pubkey: staker, isSigner: true, isWritable: false },
            { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: validatorList, isSigner: false, isWritable: true },
            { pubkey: reserveStake, isSigner: false, isWritable: true },
            { pubkey: validatorStake, isSigner: false, isWritable: true },
            { pubkey: transientStake, isSigner: false, isWritable: true },
            { pubkey: web3_js.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: web3_js.StakeProgram.programId, isSigner: false, isWritable: false },
        ];
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates `DecreaseAdditionalValidatorStake` instruction (rebalance from
     * validator account to transient account)
     */
    static decreaseAdditionalValidatorStake(params) {
        const { stakePool, staker, withdrawAuthority, validatorList, validatorStake, transientStake, lamports, transientStakeSeed, ephemeralStakeSeed, ephemeralStake, } = params;
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.DecreaseAdditionalValidatorStake, {
            lamports: new BN(lamports),
            transientStakeSeed: new BN(transientStakeSeed),
            ephemeralStakeSeed: new BN(ephemeralStakeSeed),
        });
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: false },
            { pubkey: staker, isSigner: true, isWritable: false },
            { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: validatorList, isSigner: false, isWritable: true },
            { pubkey: validatorStake, isSigner: false, isWritable: true },
            { pubkey: ephemeralStake, isSigner: false, isWritable: true },
            { pubkey: transientStake, isSigner: false, isWritable: true },
            { pubkey: web3_js.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: web3_js.StakeProgram.programId, isSigner: false, isWritable: false },
        ];
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates a transaction instruction to deposit a stake account into a stake pool.
     */
    static depositStake(params) {
        const { stakePool, validatorList, depositAuthority, withdrawAuthority, depositStake, validatorStake, reserveStake, destinationPoolAccount, managerFeeAccount, referralPoolAccount, poolMint, } = params;
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.DepositStake);
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: true },
            { pubkey: validatorList, isSigner: false, isWritable: true },
            { pubkey: depositAuthority, isSigner: false, isWritable: false },
            { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: depositStake, isSigner: false, isWritable: true },
            { pubkey: validatorStake, isSigner: false, isWritable: true },
            { pubkey: reserveStake, isSigner: false, isWritable: true },
            { pubkey: destinationPoolAccount, isSigner: false, isWritable: true },
            { pubkey: managerFeeAccount, isSigner: false, isWritable: true },
            { pubkey: referralPoolAccount, isSigner: false, isWritable: true },
            { pubkey: poolMint, isSigner: false, isWritable: true },
            { pubkey: web3_js.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: splToken.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: web3_js.StakeProgram.programId, isSigner: false, isWritable: false },
        ];
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates a transaction instruction to deposit SOL into a stake pool.
     */
    static depositSol(params) {
        const { stakePool, withdrawAuthority, depositAuthority, reserveStake, fundingAccount, destinationPoolAccount, managerFeeAccount, referralPoolAccount, poolMint, lamports, minimumPoolTokensOut, } = params;
        const data = minimumPoolTokensOut !== undefined
            ? encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.DepositSolWithSlippage, {
                lamports: new BN(lamports),
                minimumPoolTokensOut: new BN(minimumPoolTokensOut),
            })
            : encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.DepositSol, {
                lamports: new BN(lamports),
            });
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: true },
            { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: reserveStake, isSigner: false, isWritable: true },
            { pubkey: fundingAccount, isSigner: true, isWritable: true },
            { pubkey: destinationPoolAccount, isSigner: false, isWritable: true },
            { pubkey: managerFeeAccount, isSigner: false, isWritable: true },
            { pubkey: referralPoolAccount, isSigner: false, isWritable: true },
            { pubkey: poolMint, isSigner: false, isWritable: true },
            { pubkey: web3_js.SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: splToken.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ];
        if (depositAuthority) {
            keys.push({
                pubkey: depositAuthority,
                isSigner: true,
                isWritable: false,
            });
        }
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates a transaction instruction to withdraw active stake from a stake pool.
     */
    static withdrawStake(params) {
        const { stakePool, validatorList, withdrawAuthority, validatorStake, destinationStake, destinationStakeAuthority, sourceTransferAuthority, sourcePoolAccount, managerFeeAccount, poolMint, poolTokens, minimumLamportsOut, } = params;
        const data = minimumLamportsOut !== undefined
            ? encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.WithdrawStakeWithSlippage, {
                poolTokens: new BN(poolTokens),
                minimumLamportsOut: new BN(minimumLamportsOut),
            })
            : encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.WithdrawStake, {
                poolTokens: new BN(poolTokens),
            });
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: true },
            { pubkey: validatorList, isSigner: false, isWritable: true },
            { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: validatorStake, isSigner: false, isWritable: true },
            { pubkey: destinationStake, isSigner: false, isWritable: true },
            { pubkey: destinationStakeAuthority, isSigner: false, isWritable: false },
            { pubkey: sourceTransferAuthority, isSigner: true, isWritable: false },
            { pubkey: sourcePoolAccount, isSigner: false, isWritable: true },
            { pubkey: managerFeeAccount, isSigner: false, isWritable: true },
            { pubkey: poolMint, isSigner: false, isWritable: true },
            { pubkey: web3_js.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: splToken.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: web3_js.StakeProgram.programId, isSigner: false, isWritable: false },
        ];
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates a transaction instruction to withdraw SOL from a stake pool.
     */
    static withdrawSol(params) {
        const { stakePool, withdrawAuthority, sourceTransferAuthority, sourcePoolAccount, reserveStake, destinationSystemAccount, managerFeeAccount, solWithdrawAuthority, poolMint, poolTokens, minimumLamportsOut, } = params;
        const data = minimumLamportsOut !== undefined
            ? encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.WithdrawSolWithSlippage, {
                poolTokens: new BN(poolTokens),
                minimumPoolTokensOut: new BN(minimumLamportsOut),
            })
            : encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.WithdrawSol, {
                poolTokens: new BN(poolTokens),
            });
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: true },
            { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: sourceTransferAuthority, isSigner: true, isWritable: false },
            { pubkey: sourcePoolAccount, isSigner: false, isWritable: true },
            { pubkey: reserveStake, isSigner: false, isWritable: true },
            { pubkey: destinationSystemAccount, isSigner: false, isWritable: true },
            { pubkey: managerFeeAccount, isSigner: false, isWritable: true },
            { pubkey: poolMint, isSigner: false, isWritable: true },
            { pubkey: web3_js.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.StakeProgram.programId, isSigner: false, isWritable: false },
            { pubkey: splToken.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ];
        if (solWithdrawAuthority) {
            keys.push({
                pubkey: solWithdrawAuthority,
                isSigner: true,
                isWritable: false,
            });
        }
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates an instruction to create metadata
     * using the mpl token metadata program for the pool token
     */
    static createTokenMetadata(params) {
        const { stakePool, withdrawAuthority, tokenMetadata, manager, payer, poolMint, name, symbol, uri, } = params;
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: false },
            { pubkey: manager, isSigner: true, isWritable: false },
            { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: poolMint, isSigner: false, isWritable: false },
            { pubkey: payer, isSigner: true, isWritable: true },
            { pubkey: tokenMetadata, isSigner: false, isWritable: true },
            { pubkey: METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: web3_js.SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ];
        const type = tokenMetadataLayout(17, name.length, symbol.length, uri.length);
        const data = encodeData(type, {
            nameLen: name.length,
            name: buffer.Buffer.from(name),
            symbolLen: symbol.length,
            symbol: buffer.Buffer.from(symbol),
            uriLen: uri.length,
            uri: buffer.Buffer.from(uri),
        });
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates an instruction to update metadata
     * in the mpl token metadata program account for the pool token
     */
    static updateTokenMetadata(params) {
        const { stakePool, withdrawAuthority, tokenMetadata, manager, name, symbol, uri } = params;
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: false },
            { pubkey: manager, isSigner: true, isWritable: false },
            { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: tokenMetadata, isSigner: false, isWritable: true },
            { pubkey: METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
        ];
        const type = tokenMetadataLayout(18, name.length, symbol.length, uri.length);
        const data = encodeData(type, {
            nameLen: name.length,
            name: buffer.Buffer.from(name),
            symbolLen: symbol.length,
            symbol: buffer.Buffer.from(symbol),
            uriLen: uri.length,
            uri: buffer.Buffer.from(uri),
        });
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates `Redelegate` instruction (rebalance from one validator account to another)
     * @param params
     */
    static redelegate(params) {
        const { stakePool, staker, stakePoolWithdrawAuthority, validatorList, reserveStake, sourceValidatorStake, sourceTransientStake, ephemeralStake, destinationTransientStake, destinationValidatorStake, validator, lamports, sourceTransientStakeSeed, ephemeralStakeSeed, destinationTransientStakeSeed, } = params;
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: false },
            { pubkey: staker, isSigner: true, isWritable: false },
            { pubkey: stakePoolWithdrawAuthority, isSigner: false, isWritable: false },
            { pubkey: validatorList, isSigner: false, isWritable: true },
            { pubkey: reserveStake, isSigner: false, isWritable: true },
            { pubkey: sourceValidatorStake, isSigner: false, isWritable: true },
            { pubkey: sourceTransientStake, isSigner: false, isWritable: true },
            { pubkey: ephemeralStake, isSigner: false, isWritable: true },
            { pubkey: destinationTransientStake, isSigner: false, isWritable: true },
            { pubkey: destinationValidatorStake, isSigner: false, isWritable: false },
            { pubkey: validator, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: web3_js.STAKE_CONFIG_ID, isSigner: false, isWritable: false },
            { pubkey: web3_js.SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: web3_js.StakeProgram.programId, isSigner: false, isWritable: false },
        ];
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.Redelegate, {
            lamports: new BN(lamports),
            sourceTransientStakeSeed: new BN(sourceTransientStakeSeed),
            ephemeralStakeSeed: new BN(ephemeralStakeSeed),
            destinationTransientStakeSeed: new BN(destinationTransientStakeSeed),
        });
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates a 'SetManager' instruction.
     * @param params
     */
    static setManager(params) {
        const { stakePool, manager, newManager, newFeeReceiver } = params;
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: true },
            { pubkey: manager, isSigner: true, isWritable: false },
            { pubkey: newManager, isSigner: true, isWritable: false },
            { pubkey: newFeeReceiver, isSigner: false, isWritable: false },
        ];
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.SetManager);
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates a 'SetFee' instruction.
     * @param params
     */
    static setFee(params) {
        const { stakePool, manager, fee } = params;
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: true },
            { pubkey: manager, isSigner: true, isWritable: false },
        ];
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.SetFee, {
            fee: new BN(fee),
        });
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates a 'SetStaker' instruction.
     * @param params
     */
    static setStaker(params) {
        const { stakePool, setStakerAuthority, newStaker } = params;
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: true },
            { pubkey: setStakerAuthority, isSigner: true, isWritable: false },
            { pubkey: newStaker, isSigner: false, isWritable: false },
        ];
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.SetStaker);
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates a 'SetFundingAuthority' instruction.
     * @param params
     */
    static setFundingAuthority(params) {
        const { stakePool, manager, newSolDepositAuthority, fundingType } = params;
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: true },
            { pubkey: manager, isSigner: true, isWritable: false },
        ];
        if (newSolDepositAuthority) {
            keys.push({ pubkey: newSolDepositAuthority, isSigner: false, isWritable: false });
        }
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.SetFundingAuthority, {
            fundingType,
        });
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
    /**
     * Creates a 'SetPreferredValidator' instruction.
     * @param params
     */
    static setPreferredValidator(params) {
        const { stakePool, staker, validatorList, validatorVote, validatorType } = params;
        const keys = [
            { pubkey: stakePool, isSigner: false, isWritable: true },
            { pubkey: staker, isSigner: true, isWritable: false },
            { pubkey: validatorList, isSigner: false, isWritable: false },
        ];
        const data = encodeData(STAKE_POOL_INSTRUCTION_LAYOUTS.SetPreferredValidator, {
            validatorVoteAddress: validatorVote,
            validatorType,
        });
        return new web3_js.TransactionInstruction({
            programId: STAKE_POOL_PROGRAM_ID,
            keys,
            data,
        });
    }
}

/**
 * Retrieves and deserializes a StakePool account using a web3js connection and the stake pool address.
 * @param connection An active web3js connection.
 * @param stakePoolAddress The public key (address) of the stake pool account.
 */
async function getStakePoolAccount(connection, stakePoolAddress) {
    const account = await connection.getAccountInfo(stakePoolAddress);
    if (!account) {
        throw new Error('Invalid stake pool account');
    }
    return {
        pubkey: stakePoolAddress,
        account: {
            data: StakePoolLayout.decode(account.data),
            executable: account.executable,
            lamports: account.lamports,
            owner: account.owner,
        },
    };
}
/**
 * Retrieves and deserializes a Stake account using a web3js connection and the stake address.
 * @param connection An active web3js connection.
 * @param stakeAccount The public key (address) of the stake account.
 */
async function getStakeAccount(connection, stakeAccount) {
    const result = (await connection.getParsedAccountInfo(stakeAccount)).value;
    if (!result || !('parsed' in result.data)) {
        throw new Error('Invalid stake account');
    }
    const program = result.data.program;
    if (program !== 'stake') {
        throw new Error('Not a stake account');
    }
    return create(result.data.parsed, StakeAccount);
}
/**
 * Retrieves all StakePool and ValidatorList accounts that are running a particular StakePool program.
 * @param connection An active web3js connection.
 * @param stakePoolProgramAddress The public key (address) of the StakePool program.
 */
async function getStakePoolAccounts(connection, stakePoolProgramAddress) {
    const response = await connection.getProgramAccounts(stakePoolProgramAddress);
    return response.map((a) => {
        let decodedData;
        if (a.account.data.readUInt8() === 1) {
            try {
                decodedData = StakePoolLayout.decode(a.account.data);
            }
            catch (error) {
                console.log('Could not decode StakeAccount. Error:', error);
                decodedData = undefined;
            }
        }
        else if (a.account.data.readUInt8() === 2) {
            try {
                decodedData = ValidatorListLayout.decode(a.account.data);
            }
            catch (error) {
                console.log('Could not decode ValidatorList. Error:', error);
                decodedData = undefined;
            }
        }
        else {
            console.error(`Could not decode. StakePoolAccount Enum is ${a.account.data.readUInt8()}, expected 1 or 2!`);
            decodedData = undefined;
        }
        return {
            pubkey: a.pubkey,
            account: {
                data: decodedData,
                executable: a.account.executable,
                lamports: a.account.lamports,
                owner: a.account.owner,
            },
        };
    });
}
/**
 * Creates instructions required to deposit stake to stake pool.
 */
async function depositStake(connection, stakePoolAddress, authorizedPubkey, validatorVote, depositStake, poolTokenReceiverAccount) {
    const stakePool = await getStakePoolAccount(connection, stakePoolAddress);
    const withdrawAuthority = findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM_ID, stakePoolAddress);
    const validatorStake = findStakeProgramAddress(STAKE_POOL_PROGRAM_ID, validatorVote, stakePoolAddress);
    const instructions = [];
    const signers = [];
    const poolMint = stakePool.account.data.poolMint;
    // Create token account if not specified
    if (!poolTokenReceiverAccount) {
        const associatedAddress = splToken.getAssociatedTokenAddressSync(poolMint, authorizedPubkey);
        instructions.push(splToken.createAssociatedTokenAccountIdempotentInstruction(authorizedPubkey, associatedAddress, authorizedPubkey, poolMint));
        poolTokenReceiverAccount = associatedAddress;
    }
    instructions.push(...web3_js.StakeProgram.authorize({
        stakePubkey: depositStake,
        authorizedPubkey,
        newAuthorizedPubkey: stakePool.account.data.stakeDepositAuthority,
        stakeAuthorizationType: web3_js.StakeAuthorizationLayout.Staker,
    }).instructions);
    instructions.push(...web3_js.StakeProgram.authorize({
        stakePubkey: depositStake,
        authorizedPubkey,
        newAuthorizedPubkey: stakePool.account.data.stakeDepositAuthority,
        stakeAuthorizationType: web3_js.StakeAuthorizationLayout.Withdrawer,
    }).instructions);
    instructions.push(StakePoolInstruction.depositStake({
        stakePool: stakePoolAddress,
        validatorList: stakePool.account.data.validatorList,
        depositAuthority: stakePool.account.data.stakeDepositAuthority,
        reserveStake: stakePool.account.data.reserveStake,
        managerFeeAccount: stakePool.account.data.managerFeeAccount,
        referralPoolAccount: poolTokenReceiverAccount,
        destinationPoolAccount: poolTokenReceiverAccount,
        withdrawAuthority,
        depositStake,
        validatorStake,
        poolMint,
    }));
    return {
        instructions,
        signers,
    };
}
/**
 * Creates instructions required to deposit sol to stake pool.
 */
async function depositSol(connection, stakePoolAddress, from, lamports, destinationTokenAccount, referrerTokenAccount, depositAuthority) {
    const fromBalance = await connection.getBalance(from, 'confirmed');
    if (fromBalance < lamports) {
        throw new Error(`Not enough SOL to deposit into pool. Maximum deposit amount is ${lamportsToSol(fromBalance)} SOL.`);
    }
    const stakePoolAccount = await getStakePoolAccount(connection, stakePoolAddress);
    const stakePool = stakePoolAccount.account.data;
    // Ephemeral SOL account just to do the transfer
    const userSolTransfer = new web3_js.Keypair();
    const signers = [userSolTransfer];
    const instructions = [];
    // Create the ephemeral SOL account
    instructions.push(web3_js.SystemProgram.transfer({
        fromPubkey: from,
        toPubkey: userSolTransfer.publicKey,
        lamports,
    }));
    // Create token account if not specified
    if (!destinationTokenAccount) {
        const associatedAddress = splToken.getAssociatedTokenAddressSync(stakePool.poolMint, from);
        instructions.push(splToken.createAssociatedTokenAccountIdempotentInstruction(from, associatedAddress, from, stakePool.poolMint));
        destinationTokenAccount = associatedAddress;
    }
    const withdrawAuthority = findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM_ID, stakePoolAddress);
    instructions.push(StakePoolInstruction.depositSol({
        stakePool: stakePoolAddress,
        reserveStake: stakePool.reserveStake,
        fundingAccount: userSolTransfer.publicKey,
        destinationPoolAccount: destinationTokenAccount,
        managerFeeAccount: stakePool.managerFeeAccount,
        referralPoolAccount: referrerTokenAccount !== null && referrerTokenAccount !== void 0 ? referrerTokenAccount : destinationTokenAccount,
        poolMint: stakePool.poolMint,
        lamports,
        withdrawAuthority,
        depositAuthority,
    }));
    return {
        instructions,
        signers,
    };
}
/**
 * Creates instructions required to withdraw stake from a stake pool.
 */
async function withdrawStake(connection, stakePoolAddress, tokenOwner, amount, useReserve = false, voteAccountAddress, stakeReceiver, poolTokenAccount, validatorComparator) {
    var _c, _d, _e, _f, _g;
    const stakePool = await getStakePoolAccount(connection, stakePoolAddress);
    const poolAmount = solToLamports(amount);
    if (!poolTokenAccount) {
        poolTokenAccount = splToken.getAssociatedTokenAddressSync(stakePool.account.data.poolMint, tokenOwner);
    }
    const tokenAccount = await splToken.getAccount(connection, poolTokenAccount);
    // Check withdrawFrom balance
    if (tokenAccount.amount < poolAmount) {
        throw new Error(`Not enough token balance to withdraw ${lamportsToSol(poolAmount)} pool tokens.
        Maximum withdraw amount is ${lamportsToSol(tokenAccount.amount)} pool tokens.`);
    }
    const stakeAccountRentExemption = await connection.getMinimumBalanceForRentExemption(web3_js.StakeProgram.space);
    const withdrawAuthority = findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM_ID, stakePoolAddress);
    let stakeReceiverAccount = null;
    if (stakeReceiver) {
        stakeReceiverAccount = await getStakeAccount(connection, stakeReceiver);
    }
    const withdrawAccounts = [];
    if (useReserve) {
        withdrawAccounts.push({
            stakeAddress: stakePool.account.data.reserveStake,
            voteAddress: undefined,
            poolAmount,
        });
    }
    else if ((stakeReceiverAccount === null || stakeReceiverAccount === void 0 ? void 0 : stakeReceiverAccount.type) === 'delegated') {
        const voteAccount = (_d = (_c = stakeReceiverAccount === null || stakeReceiverAccount === void 0 ? void 0 : stakeReceiverAccount.info) === null || _c === void 0 ? void 0 : _c.stake) === null || _d === void 0 ? void 0 : _d.delegation.voter;
        if (!voteAccount) {
            throw new Error(`Invalid stake receiver ${stakeReceiver} delegation`);
        }
        const validatorListAccount = await connection.getAccountInfo(stakePool.account.data.validatorList);
        const validatorList = ValidatorListLayout.decode(Buffer.from((_e = validatorListAccount === null || validatorListAccount === void 0 ? void 0 : validatorListAccount.data) !== null && _e !== void 0 ? _e : []));
        const isValidVoter = validatorList.validators.find((val) => val.voteAccountAddress.equals(voteAccount));
        if (voteAccountAddress && voteAccountAddress !== voteAccount) {
            throw new Error(`Provided withdrawal vote account ${voteAccountAddress} does not match delegation on stake receiver account ${voteAccount},
      remove this flag or provide a different stake account delegated to ${voteAccountAddress}`);
        }
        if (isValidVoter) {
            const stakeAccountAddress = findStakeProgramAddress(STAKE_POOL_PROGRAM_ID, voteAccount, stakePoolAddress);
            const stakeAccount = await connection.getAccountInfo(stakeAccountAddress);
            if (!stakeAccount) {
                throw new Error("Preferred withdraw validator's stake account is invalid");
            }
            const availableForWithdrawal = calcLamportsWithdrawAmount(stakePool.account.data, stakeAccount.lamports - MINIMUM_ACTIVE_STAKE - stakeAccountRentExemption);
            if (availableForWithdrawal < poolAmount) {
                throw new Error(`Not enough lamports available for withdrawal from ${stakeAccountAddress},
            ${poolAmount} asked, ${availableForWithdrawal} available.`);
            }
            withdrawAccounts.push({
                stakeAddress: stakeAccountAddress,
                voteAddress: voteAccount,
                poolAmount,
            });
        }
        else {
            throw new Error(`Provided stake account is delegated to a vote account ${voteAccount} which does not exist in the stake pool`);
        }
    }
    else if (voteAccountAddress) {
        const stakeAccountAddress = findStakeProgramAddress(STAKE_POOL_PROGRAM_ID, voteAccountAddress, stakePoolAddress);
        const stakeAccount = await connection.getAccountInfo(stakeAccountAddress);
        if (!stakeAccount) {
            throw new Error('Invalid Stake Account');
        }
        const availableForWithdrawal = calcLamportsWithdrawAmount(stakePool.account.data, stakeAccount.lamports - MINIMUM_ACTIVE_STAKE - stakeAccountRentExemption);
        if (availableForWithdrawal < poolAmount) {
            // noinspection ExceptionCaughtLocallyJS
            throw new Error(`Not enough lamports available for withdrawal from ${stakeAccountAddress},
          ${poolAmount} asked, ${availableForWithdrawal} available.`);
        }
        withdrawAccounts.push({
            stakeAddress: stakeAccountAddress,
            voteAddress: voteAccountAddress,
            poolAmount,
        });
    }
    else {
        // Get the list of accounts to withdraw from
        withdrawAccounts.push(...(await prepareWithdrawAccounts(connection, stakePool.account.data, stakePoolAddress, poolAmount, validatorComparator, poolTokenAccount.equals(stakePool.account.data.managerFeeAccount))));
    }
    // Construct transaction to withdraw from withdrawAccounts account list
    const instructions = [];
    const userTransferAuthority = web3_js.Keypair.generate();
    const signers = [userTransferAuthority];
    instructions.push(splToken.createApproveInstruction(poolTokenAccount, userTransferAuthority.publicKey, tokenOwner, poolAmount));
    let totalRentFreeBalances = 0;
    // Max 5 accounts to prevent an error: "Transaction too large"
    const maxWithdrawAccounts = 5;
    let i = 0;
    // Go through prepared accounts and withdraw/claim them
    for (const withdrawAccount of withdrawAccounts) {
        if (i > maxWithdrawAccounts) {
            break;
        }
        // Convert pool tokens amount to lamports
        const solWithdrawAmount = Math.ceil(calcLamportsWithdrawAmount(stakePool.account.data, withdrawAccount.poolAmount));
        let infoMsg = `Withdrawing ◎${solWithdrawAmount},
      from stake account ${(_f = withdrawAccount.stakeAddress) === null || _f === void 0 ? void 0 : _f.toBase58()}`;
        if (withdrawAccount.voteAddress) {
            infoMsg = `${infoMsg}, delegated to ${(_g = withdrawAccount.voteAddress) === null || _g === void 0 ? void 0 : _g.toBase58()}`;
        }
        console.info(infoMsg);
        let stakeToReceive;
        if (!stakeReceiver || (stakeReceiverAccount && stakeReceiverAccount.type === 'delegated')) {
            const stakeKeypair = newStakeAccount(tokenOwner, instructions, stakeAccountRentExemption);
            signers.push(stakeKeypair);
            totalRentFreeBalances += stakeAccountRentExemption;
            stakeToReceive = stakeKeypair.publicKey;
        }
        else {
            stakeToReceive = stakeReceiver;
        }
        instructions.push(StakePoolInstruction.withdrawStake({
            stakePool: stakePoolAddress,
            validatorList: stakePool.account.data.validatorList,
            validatorStake: withdrawAccount.stakeAddress,
            destinationStake: stakeToReceive,
            destinationStakeAuthority: tokenOwner,
            sourceTransferAuthority: userTransferAuthority.publicKey,
            sourcePoolAccount: poolTokenAccount,
            managerFeeAccount: stakePool.account.data.managerFeeAccount,
            poolMint: stakePool.account.data.poolMint,
            poolTokens: withdrawAccount.poolAmount,
            withdrawAuthority,
        }));
        i++;
    }
    if (stakeReceiver && (stakeReceiverAccount === null || stakeReceiverAccount === void 0 ? void 0 : stakeReceiverAccount.type) === 'delegated') {
        signers.forEach((newStakeKeypair) => {
            instructions.concat(web3_js.StakeProgram.merge({
                stakePubkey: stakeReceiver,
                sourceStakePubKey: newStakeKeypair.publicKey,
                authorizedPubkey: tokenOwner,
            }).instructions);
        });
    }
    return {
        instructions,
        signers,
        stakeReceiver,
        totalRentFreeBalances,
    };
}
/**
 * Creates instructions required to withdraw SOL directly from a stake pool.
 */
async function withdrawSol(connection, stakePoolAddress, tokenOwner, solReceiver, amount, solWithdrawAuthority) {
    const stakePool = await getStakePoolAccount(connection, stakePoolAddress);
    const poolAmount = solToLamports(amount);
    const poolTokenAccount = splToken.getAssociatedTokenAddressSync(stakePool.account.data.poolMint, tokenOwner);
    const tokenAccount = await splToken.getAccount(connection, poolTokenAccount);
    // Check withdrawFrom balance
    if (tokenAccount.amount < poolAmount) {
        throw new Error(`Not enough token balance to withdraw ${lamportsToSol(poolAmount)} pool tokens.
          Maximum withdraw amount is ${lamportsToSol(tokenAccount.amount)} pool tokens.`);
    }
    // Construct transaction to withdraw from withdrawAccounts account list
    const instructions = [];
    const userTransferAuthority = web3_js.Keypair.generate();
    const signers = [userTransferAuthority];
    instructions.push(splToken.createApproveInstruction(poolTokenAccount, userTransferAuthority.publicKey, tokenOwner, poolAmount));
    const poolWithdrawAuthority = findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM_ID, stakePoolAddress);
    if (solWithdrawAuthority) {
        const expectedSolWithdrawAuthority = stakePool.account.data.solWithdrawAuthority;
        if (!expectedSolWithdrawAuthority) {
            throw new Error('SOL withdraw authority specified in arguments but stake pool has none');
        }
        if (solWithdrawAuthority.toBase58() !== expectedSolWithdrawAuthority.toBase58()) {
            throw new Error(`Invalid deposit withdraw specified, expected ${expectedSolWithdrawAuthority.toBase58()}, received ${solWithdrawAuthority.toBase58()}`);
        }
    }
    const withdrawTransaction = StakePoolInstruction.withdrawSol({
        stakePool: stakePoolAddress,
        withdrawAuthority: poolWithdrawAuthority,
        reserveStake: stakePool.account.data.reserveStake,
        sourcePoolAccount: poolTokenAccount,
        sourceTransferAuthority: userTransferAuthority.publicKey,
        destinationSystemAccount: solReceiver,
        managerFeeAccount: stakePool.account.data.managerFeeAccount,
        poolMint: stakePool.account.data.poolMint,
        poolTokens: poolAmount,
        solWithdrawAuthority,
    });
    instructions.push(withdrawTransaction);
    return {
        instructions,
        signers,
    };
}
/**
 * Creates instructions required to increase validator stake.
 */
async function increaseValidatorStake(connection, stakePoolAddress, validatorVote, lamports, ephemeralStakeSeed) {
    const stakePool = await getStakePoolAccount(connection, stakePoolAddress);
    const validatorList = await getValidatorListAccount(connection, stakePool.account.data.validatorList);
    const validatorInfo = validatorList.account.data.validators.find((v) => v.voteAccountAddress.toBase58() === validatorVote.toBase58());
    if (!validatorInfo) {
        throw new Error('Vote account not found in validator list');
    }
    const withdrawAuthority = findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM_ID, stakePoolAddress);
    // Bump transient seed suffix by one to avoid reuse when not using the increaseAdditionalStake instruction
    const transientStakeSeed = ephemeralStakeSeed === undefined
        ? validatorInfo.transientSeedSuffixStart.addn(1)
        : validatorInfo.transientSeedSuffixStart;
    const transientStake = findTransientStakeProgramAddress(STAKE_POOL_PROGRAM_ID, validatorInfo.voteAccountAddress, stakePoolAddress, transientStakeSeed);
    const validatorStake = findStakeProgramAddress(STAKE_POOL_PROGRAM_ID, validatorInfo.voteAccountAddress, stakePoolAddress);
    const instructions = [];
    if (ephemeralStakeSeed !== undefined) {
        const ephemeralStake = findEphemeralStakeProgramAddress(STAKE_POOL_PROGRAM_ID, stakePoolAddress, new BN(ephemeralStakeSeed));
        StakePoolInstruction.increaseAdditionalValidatorStake({
            stakePool: stakePoolAddress,
            staker: stakePool.account.data.staker,
            validatorList: stakePool.account.data.validatorList,
            reserveStake: stakePool.account.data.reserveStake,
            transientStakeSeed: transientStakeSeed.toNumber(),
            withdrawAuthority,
            transientStake,
            validatorStake,
            validatorVote,
            lamports,
            ephemeralStake,
            ephemeralStakeSeed,
        });
    }
    else {
        instructions.push(StakePoolInstruction.increaseValidatorStake({
            stakePool: stakePoolAddress,
            staker: stakePool.account.data.staker,
            validatorList: stakePool.account.data.validatorList,
            reserveStake: stakePool.account.data.reserveStake,
            transientStakeSeed: transientStakeSeed.toNumber(),
            withdrawAuthority,
            transientStake,
            validatorStake,
            validatorVote,
            lamports,
        }));
    }
    return {
        instructions,
    };
}
/**
 * Creates instructions required to decrease validator stake.
 */
async function decreaseValidatorStake(connection, stakePoolAddress, validatorVote, lamports, ephemeralStakeSeed) {
    const stakePool = await getStakePoolAccount(connection, stakePoolAddress);
    const validatorList = await getValidatorListAccount(connection, stakePool.account.data.validatorList);
    const validatorInfo = validatorList.account.data.validators.find((v) => v.voteAccountAddress.toBase58() === validatorVote.toBase58());
    if (!validatorInfo) {
        throw new Error('Vote account not found in validator list');
    }
    const withdrawAuthority = findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM_ID, stakePoolAddress);
    const validatorStake = findStakeProgramAddress(STAKE_POOL_PROGRAM_ID, validatorInfo.voteAccountAddress, stakePoolAddress);
    // Bump transient seed suffix by one to avoid reuse when not using the decreaseAdditionalStake instruction
    const transientStakeSeed = ephemeralStakeSeed === undefined
        ? validatorInfo.transientSeedSuffixStart.addn(1)
        : validatorInfo.transientSeedSuffixStart;
    const transientStake = findTransientStakeProgramAddress(STAKE_POOL_PROGRAM_ID, validatorInfo.voteAccountAddress, stakePoolAddress, transientStakeSeed);
    const instructions = [];
    if (ephemeralStakeSeed !== undefined) {
        const ephemeralStake = findEphemeralStakeProgramAddress(STAKE_POOL_PROGRAM_ID, stakePoolAddress, new BN(ephemeralStakeSeed));
        instructions.push(StakePoolInstruction.decreaseAdditionalValidatorStake({
            stakePool: stakePoolAddress,
            staker: stakePool.account.data.staker,
            validatorList: stakePool.account.data.validatorList,
            transientStakeSeed: transientStakeSeed.toNumber(),
            withdrawAuthority,
            validatorStake,
            transientStake,
            lamports,
            ephemeralStake,
            ephemeralStakeSeed,
        }));
    }
    else {
        instructions.push(StakePoolInstruction.decreaseValidatorStake({
            stakePool: stakePoolAddress,
            staker: stakePool.account.data.staker,
            validatorList: stakePool.account.data.validatorList,
            transientStakeSeed: transientStakeSeed.toNumber(),
            withdrawAuthority,
            validatorStake,
            transientStake,
            lamports,
        }));
    }
    return {
        instructions,
    };
}
/**
 * Creates instructions required to completely update a stake pool after epoch change.
 */
async function updateStakePool(connection, stakePool, noMerge = false) {
    const stakePoolAddress = stakePool.pubkey;
    const validatorList = await getValidatorListAccount(connection, stakePool.account.data.validatorList);
    const withdrawAuthority = findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM_ID, stakePoolAddress);
    const updateListInstructions = [];
    const instructions = [];
    let startIndex = 0;
    const validatorChunks = arrayChunk(validatorList.account.data.validators, MAX_VALIDATORS_TO_UPDATE);
    for (const validatorChunk of validatorChunks) {
        const validatorAndTransientStakePairs = [];
        for (const validator of validatorChunk) {
            const validatorStake = findStakeProgramAddress(STAKE_POOL_PROGRAM_ID, validator.voteAccountAddress, stakePoolAddress);
            validatorAndTransientStakePairs.push(validatorStake);
            const transientStake = findTransientStakeProgramAddress(STAKE_POOL_PROGRAM_ID, validator.voteAccountAddress, stakePoolAddress, validator.transientSeedSuffixStart);
            validatorAndTransientStakePairs.push(transientStake);
        }
        updateListInstructions.push(StakePoolInstruction.updateValidatorListBalance({
            stakePool: stakePoolAddress,
            validatorList: stakePool.account.data.validatorList,
            reserveStake: stakePool.account.data.reserveStake,
            validatorAndTransientStakePairs,
            withdrawAuthority,
            startIndex,
            noMerge,
        }));
        startIndex += MAX_VALIDATORS_TO_UPDATE;
    }
    instructions.push(StakePoolInstruction.updateStakePoolBalance({
        stakePool: stakePoolAddress,
        validatorList: stakePool.account.data.validatorList,
        reserveStake: stakePool.account.data.reserveStake,
        managerFeeAccount: stakePool.account.data.managerFeeAccount,
        poolMint: stakePool.account.data.poolMint,
        withdrawAuthority,
    }));
    instructions.push(StakePoolInstruction.cleanupRemovedValidatorEntries({
        stakePool: stakePoolAddress,
        validatorList: stakePool.account.data.validatorList,
    }));
    return {
        updateListInstructions,
        finalInstructions: instructions,
    };
}
/**
 * Retrieves detailed information about the StakePool.
 */
async function stakePoolInfo(connection, stakePoolAddress) {
    var _c, _d;
    const stakePool = await getStakePoolAccount(connection, stakePoolAddress);
    const reserveAccountStakeAddress = stakePool.account.data.reserveStake;
    const totalLamports = stakePool.account.data.totalLamports;
    const lastUpdateEpoch = stakePool.account.data.lastUpdateEpoch;
    const validatorList = await getValidatorListAccount(connection, stakePool.account.data.validatorList);
    const maxNumberOfValidators = validatorList.account.data.maxValidators;
    const currentNumberOfValidators = validatorList.account.data.validators.length;
    const epochInfo = await connection.getEpochInfo();
    const reserveStake = await connection.getAccountInfo(reserveAccountStakeAddress);
    const withdrawAuthority = findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM_ID, stakePoolAddress);
    const minimumReserveStakeBalance = await connection.getMinimumBalanceForRentExemption(web3_js.StakeProgram.space);
    const stakeAccounts = await Promise.all(validatorList.account.data.validators.map(async (validator) => {
        const stakeAccountAddress = findStakeProgramAddress(STAKE_POOL_PROGRAM_ID, validator.voteAccountAddress, stakePoolAddress);
        const transientStakeAccountAddress = findTransientStakeProgramAddress(STAKE_POOL_PROGRAM_ID, validator.voteAccountAddress, stakePoolAddress, validator.transientSeedSuffixStart);
        const updateRequired = !validator.lastUpdateEpoch.eqn(epochInfo.epoch);
        return {
            voteAccountAddress: validator.voteAccountAddress.toBase58(),
            stakeAccountAddress: stakeAccountAddress.toBase58(),
            validatorActiveStakeLamports: validator.activeStakeLamports.toString(),
            validatorLastUpdateEpoch: validator.lastUpdateEpoch.toString(),
            validatorLamports: validator.activeStakeLamports
                .add(validator.transientStakeLamports)
                .toString(),
            validatorTransientStakeAccountAddress: transientStakeAccountAddress.toBase58(),
            validatorTransientStakeLamports: validator.transientStakeLamports.toString(),
            updateRequired,
        };
    }));
    const totalPoolTokens = lamportsToSol(stakePool.account.data.poolTokenSupply);
    const updateRequired = !lastUpdateEpoch.eqn(epochInfo.epoch);
    return {
        address: stakePoolAddress.toBase58(),
        poolWithdrawAuthority: withdrawAuthority.toBase58(),
        manager: stakePool.account.data.manager.toBase58(),
        staker: stakePool.account.data.staker.toBase58(),
        stakeDepositAuthority: stakePool.account.data.stakeDepositAuthority.toBase58(),
        stakeWithdrawBumpSeed: stakePool.account.data.stakeWithdrawBumpSeed,
        maxValidators: maxNumberOfValidators,
        validatorList: validatorList.account.data.validators.map((validator) => {
            return {
                activeStakeLamports: validator.activeStakeLamports.toString(),
                transientStakeLamports: validator.transientStakeLamports.toString(),
                lastUpdateEpoch: validator.lastUpdateEpoch.toString(),
                transientSeedSuffixStart: validator.transientSeedSuffixStart.toString(),
                transientSeedSuffixEnd: validator.transientSeedSuffixEnd.toString(),
                status: validator.status.toString(),
                voteAccountAddress: validator.voteAccountAddress.toString(),
            };
        }), // CliStakePoolValidator
        validatorListStorageAccount: stakePool.account.data.validatorList.toBase58(),
        reserveStake: stakePool.account.data.reserveStake.toBase58(),
        poolMint: stakePool.account.data.poolMint.toBase58(),
        managerFeeAccount: stakePool.account.data.managerFeeAccount.toBase58(),
        tokenProgramId: stakePool.account.data.tokenProgramId.toBase58(),
        totalLamports: stakePool.account.data.totalLamports.toString(),
        poolTokenSupply: stakePool.account.data.poolTokenSupply.toString(),
        lastUpdateEpoch: stakePool.account.data.lastUpdateEpoch.toString(),
        lockup: stakePool.account.data.lockup, // pub lockup: CliStakePoolLockup
        epochFee: stakePool.account.data.epochFee,
        nextEpochFee: stakePool.account.data.nextEpochFee,
        preferredDepositValidatorVoteAddress: stakePool.account.data.preferredDepositValidatorVoteAddress,
        preferredWithdrawValidatorVoteAddress: stakePool.account.data.preferredWithdrawValidatorVoteAddress,
        stakeDepositFee: stakePool.account.data.stakeDepositFee,
        stakeWithdrawalFee: stakePool.account.data.stakeWithdrawalFee,
        // CliStakePool the same
        nextStakeWithdrawalFee: stakePool.account.data.nextStakeWithdrawalFee,
        stakeReferralFee: stakePool.account.data.stakeReferralFee,
        solDepositAuthority: (_c = stakePool.account.data.solDepositAuthority) === null || _c === void 0 ? void 0 : _c.toBase58(),
        solDepositFee: stakePool.account.data.solDepositFee,
        solReferralFee: stakePool.account.data.solReferralFee,
        solWithdrawAuthority: (_d = stakePool.account.data.solWithdrawAuthority) === null || _d === void 0 ? void 0 : _d.toBase58(),
        solWithdrawalFee: stakePool.account.data.solWithdrawalFee,
        nextSolWithdrawalFee: stakePool.account.data.nextSolWithdrawalFee,
        lastEpochPoolTokenSupply: stakePool.account.data.lastEpochPoolTokenSupply.toString(),
        lastEpochTotalLamports: stakePool.account.data.lastEpochTotalLamports.toString(),
        details: {
            reserveStakeLamports: reserveStake === null || reserveStake === void 0 ? void 0 : reserveStake.lamports,
            reserveAccountStakeAddress: reserveAccountStakeAddress.toBase58(),
            minimumReserveStakeBalance,
            stakeAccounts,
            totalLamports,
            totalPoolTokens,
            currentNumberOfValidators,
            maxNumberOfValidators,
            updateRequired,
        }, // CliStakePoolDetails
    };
}
/**
 * Creates instructions required to redelegate stake.
 */
async function redelegate(props) {
    const { connection, stakePoolAddress, sourceVoteAccount, sourceTransientStakeSeed, destinationVoteAccount, destinationTransientStakeSeed, ephemeralStakeSeed, lamports, } = props;
    const stakePool = await getStakePoolAccount(connection, stakePoolAddress);
    const stakePoolWithdrawAuthority = findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM_ID, stakePoolAddress);
    const sourceValidatorStake = findStakeProgramAddress(STAKE_POOL_PROGRAM_ID, sourceVoteAccount, stakePoolAddress);
    const sourceTransientStake = findTransientStakeProgramAddress(STAKE_POOL_PROGRAM_ID, sourceVoteAccount, stakePoolAddress, new BN(sourceTransientStakeSeed));
    const destinationValidatorStake = findStakeProgramAddress(STAKE_POOL_PROGRAM_ID, destinationVoteAccount, stakePoolAddress);
    const destinationTransientStake = findTransientStakeProgramAddress(STAKE_POOL_PROGRAM_ID, destinationVoteAccount, stakePoolAddress, new BN(destinationTransientStakeSeed));
    const ephemeralStake = findEphemeralStakeProgramAddress(STAKE_POOL_PROGRAM_ID, stakePoolAddress, new BN(ephemeralStakeSeed));
    const instructions = [];
    instructions.push(StakePoolInstruction.redelegate({
        stakePool: stakePool.pubkey,
        staker: stakePool.account.data.staker,
        validatorList: stakePool.account.data.validatorList,
        reserveStake: stakePool.account.data.reserveStake,
        stakePoolWithdrawAuthority,
        ephemeralStake,
        ephemeralStakeSeed,
        sourceValidatorStake,
        sourceTransientStake,
        sourceTransientStakeSeed,
        destinationValidatorStake,
        destinationTransientStake,
        destinationTransientStakeSeed,
        validator: destinationVoteAccount,
        lamports,
    }));
    return {
        instructions,
    };
}
/**
 * Initializes a new StakePool.
 */
async function initialize(props) {
    var _c, _d, _e;
    const { connection, poolMint, reserveStake, manager, managerPoolAccount, fee, depositFee, withdrawalFee, referralFee, } = props;
    const poolBalance = await connection.getMinimumBalanceForRentExemption(StakePoolLayout.span);
    const stakePool = (_c = props.stakePool) !== null && _c !== void 0 ? _c : web3_js.Keypair.generate();
    const validatorList = (_d = props.validatorList) !== null && _d !== void 0 ? _d : web3_js.Keypair.generate();
    const instructions = [];
    const signers = [manager, stakePool, validatorList];
    instructions.push(web3_js.SystemProgram.createAccount({
        fromPubkey: manager.publicKey,
        newAccountPubkey: stakePool.publicKey,
        lamports: poolBalance,
        space: StakePoolLayout.span,
        programId: STAKE_POOL_PROGRAM_ID,
    }));
    const maxValidators = (_e = props.maxValidators) !== null && _e !== void 0 ? _e : DEFAULT_MAX_VALIDATORS;
    const validatorListSpace = ValidatorListLayout.span + ValidatorStakeInfoLayout.span * maxValidators;
    const validatorListBalance = await connection.getMinimumBalanceForRentExemption(validatorListSpace);
    instructions.push(web3_js.SystemProgram.createAccount({
        fromPubkey: manager.publicKey,
        newAccountPubkey: validatorList.publicKey,
        lamports: validatorListBalance,
        space: validatorListSpace,
        programId: STAKE_POOL_PROGRAM_ID,
    }));
    const withdrawAuthority = findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM_ID, stakePool.publicKey);
    instructions.push(StakePoolInstruction.initialize({
        stakePool: stakePool.publicKey,
        manager: manager.publicKey,
        staker: manager.publicKey,
        stakePoolWithdrawAuthority: withdrawAuthority,
        validatorList: validatorList.publicKey,
        poolMint,
        managerPoolAccount,
        reserveStake,
        fee: fee !== null && fee !== void 0 ? fee : { denominator: new BN(0), numerator: new BN(0) },
        withdrawalFee: withdrawalFee !== null && withdrawalFee !== void 0 ? withdrawalFee : { denominator: new BN(0), numerator: new BN(0) },
        depositFee: depositFee !== null && depositFee !== void 0 ? depositFee : { denominator: new BN(0), numerator: new BN(0) },
        referralFee: referralFee !== null && referralFee !== void 0 ? referralFee : 0,
        maxValidators,
    }));
    return {
        instructions,
        signers,
    };
}
/**
 * Creates instructions required to create pool token metadata.
 */
async function createPoolTokenMetadata(props) {
    var _c;
    const { connection, name, symbol, uri, payer } = props;
    const stakePool = props.stakePool instanceof web3_js.PublicKey
        ? await getStakePoolAccount(connection, props.stakePool)
        : props.stakePool;
    const tokenMetadata = (_c = props.tokenMetadata) !== null && _c !== void 0 ? _c : findMetadataAddress(stakePool.account.data.poolMint);
    const withdrawAuthority = findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM_ID, stakePool.pubkey);
    const manager = stakePool.account.data.manager;
    const instructions = [];
    instructions.push(StakePoolInstruction.createTokenMetadata({
        stakePool: stakePool.pubkey,
        poolMint: stakePool.account.data.poolMint,
        payer,
        manager,
        tokenMetadata,
        withdrawAuthority,
        name,
        symbol,
        uri,
    }));
    return {
        instructions,
    };
}
/**
 * Creates instructions required to update pool token metadata.
 */
async function updatePoolTokenMetadata(props) {
    var _c;
    const { connection, name, symbol, uri } = props;
    const stakePool = props.stakePool instanceof web3_js.PublicKey
        ? await getStakePoolAccount(connection, props.stakePool)
        : props.stakePool;
    const tokenMetadata = (_c = props.tokenMetadata) !== null && _c !== void 0 ? _c : findMetadataAddress(stakePool.account.data.poolMint);
    const withdrawAuthority = findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM_ID, stakePool.pubkey);
    const instructions = [];
    instructions.push(StakePoolInstruction.updateTokenMetadata({
        stakePool: stakePool.pubkey,
        manager: stakePool.account.data.manager,
        tokenMetadata,
        withdrawAuthority,
        name,
        symbol,
        uri,
    }));
    return {
        instructions,
    };
}
/**
 * Creates instructions required to add a validator to the pool.
 */
async function addValidatorToPool(connection, stakePoolAddress, validatorVote, seed) {
    const stakePool = await getStakePoolAccount(connection, stakePoolAddress);
    const validatorList = await getValidatorListAccount(connection, stakePool.account.data.validatorList);
    const validatorInfo = validatorList.account.data.validators.find((v) => v.voteAccountAddress.toBase58() === validatorVote.toBase58());
    if (validatorInfo) {
        throw new Error(`Stake pool already contains validator ${validatorInfo.voteAccountAddress.toBase58()}, ignoring`);
    }
    const withdrawAuthority = findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM_ID, stakePoolAddress);
    const validatorStake = findStakeProgramAddress(STAKE_POOL_PROGRAM_ID, validatorVote, stakePoolAddress);
    const instructions = [];
    instructions.push(StakePoolInstruction.addValidatorToPool({
        stakePool: stakePoolAddress,
        staker: stakePool.account.data.staker,
        reserveStake: stakePool.account.data.reserveStake,
        validatorList: stakePool.account.data.validatorList,
        validatorStake,
        withdrawAuthority,
        validatorVote,
        seed,
    }));
    return {
        instructions,
    };
}
/**
 * Creates instructions required to add a validator to the pool.
 */
async function removeValidatorFromPool(connection, stakePoolAddress, validatorVote, staker) {
    const stakePool = await getStakePoolAccount(connection, stakePoolAddress);
    const validatorList = await getValidatorListAccount(connection, stakePool.account.data.validatorList);
    const validatorInfo = validatorList.account.data.validators.find((v) => v.voteAccountAddress.toBase58() === validatorVote.toBase58());
    if (!validatorInfo) {
        throw new Error('Vote account not found in validator list');
    }
    const withdrawAuthority = findWithdrawAuthorityProgramAddress(STAKE_POOL_PROGRAM_ID, stakePoolAddress);
    const transientStake = findTransientStakeProgramAddress(STAKE_POOL_PROGRAM_ID, validatorInfo.voteAccountAddress, stakePoolAddress, validatorInfo.transientSeedSuffixStart);
    const validatorStake = findStakeProgramAddress(STAKE_POOL_PROGRAM_ID, validatorInfo.voteAccountAddress, stakePoolAddress);
    const destinationStake = web3_js.Keypair.generate();
    const signers = [destinationStake];
    const instructions = [];
    instructions.push(web3_js.SystemProgram.createAccount({
        fromPubkey: staker,
        newAccountPubkey: destinationStake.publicKey,
        lamports: 0,
        space: web3_js.StakeProgram.space,
        programId: web3_js.StakeProgram.programId,
    }));
    instructions.push(StakePoolInstruction.removeValidatorFromPool({
        stakePool: stakePoolAddress,
        staker: stakePool.account.data.staker,
        withdrawAuthority,
        validatorList: stakePool.account.data.validatorList,
        validatorStake,
        transientStake,
    }));
    return {
        instructions,
        signers,
    };
}

exports.STAKE_POOL_INSTRUCTION_LAYOUTS = STAKE_POOL_INSTRUCTION_LAYOUTS;
exports.STAKE_POOL_PROGRAM_ID = STAKE_POOL_PROGRAM_ID;
exports.StakePoolInstruction = StakePoolInstruction;
exports.addValidatorToPool = addValidatorToPool;
exports.createPoolTokenMetadata = createPoolTokenMetadata;
exports.decreaseValidatorStake = decreaseValidatorStake;
exports.depositSol = depositSol;
exports.depositStake = depositStake;
exports.getStakeAccount = getStakeAccount;
exports.getStakePoolAccount = getStakePoolAccount;
exports.getStakePoolAccounts = getStakePoolAccounts;
exports.increaseValidatorStake = increaseValidatorStake;
exports.initialize = initialize;
exports.redelegate = redelegate;
exports.removeValidatorFromPool = removeValidatorFromPool;
exports.stakePoolInfo = stakePoolInfo;
exports.tokenMetadataLayout = tokenMetadataLayout;
exports.updatePoolTokenMetadata = updatePoolTokenMetadata;
exports.updateStakePool = updateStakePool;
exports.withdrawSol = withdrawSol;
exports.withdrawStake = withdrawStake;
//# sourceMappingURL=index.browser.cjs.js.map
