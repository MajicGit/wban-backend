import { Logger } from "tslog";
import IORedis, { Redis } from "ioredis";
import Redlock from "redlock";
import { BigNumber, ethers } from "ethers";
import { UsersDepositsStorage } from "./UsersDepositsStorage";
import SwapWBANToBan from "../models/operations/SwapWBANToBan";
import config from "../config";
import { match } from "assert";

/**
 * Redis storage explanations:
 * - `ban-balance`: map whose key is the BAN address and whose value is the BAN balance as a big number
 * - `deposits:${ban_address}`: sorted set (by timestamp) of all BAN deposits transactions hash
 * - `withdrawals:${ban_address}`: sorted set (by timestamp) of all BAN withdrawals TODO: date vs hash issue
 * - `swaps:ban-to-wban:${ban_address}`: sorted set (by timestamp) of all BAN -> wBAN receipts generated
 * - `swaps:wban-to-ban:${blockchain_address}`: sorted set (by timestamp) of all wBAN -> BAN transactions hash
 * - `swaps:gasless`: map whose key is the BAN address and whose value is the relayed txn id
 * - `audit:${hash|receipt}`: map of all the data associated to the event (deposit/withdrawal/swap)
 * - `claims:pending:${ban_address}:${blockchain_address}`: value of 1 means a pending claim -- expires after 5 minutes (TTL)
 * - `claims:${ban_address}:${blockchain_address}`: value of 1 means a valid claim
 */
class RedisUsersDepositsStorage implements UsersDepositsStorage {
	private redis: Redis;

	private redlock: Redlock;

	private log: Logger = config.Logger.getChildLogger();

	private static LIMIT = 1000;

	constructor() {
		this.redis = new IORedis({ host: config.RedisHost });
		this.redlock = new Redlock([this.redis], {
			// the expected clock drift; for more details
			// see http://redis.io/topics/distlock
			driftFactor: 0.01, // multiplied by lock ttl to determine drift time
			// the max number of times Redlock will attempt
			// to lock a resource before erroring
			retryCount: 10,
			// the time in ms between attempts
			retryDelay: 200, // time in ms
			// the max time in ms randomly added to retries
			// to improve performance under high contention
			// see https://www.awsarchitectureblog.com/2015/03/backoff.html
			retryJitter: 200, // time in ms
		});
	}

	async getUserAvailableBalance(from: string): Promise<BigNumber> {
		const lock = await this.redlock.acquire(
			[`locks:ban-balance:${from}`],
			1_000
		);
		try {
			const rawAmount: string | null = await this.redis.get(
				`ban-balance:${from.toLowerCase()}`
			);
			if (rawAmount === null) {
				return BigNumber.from(0);
			}
			return BigNumber.from(rawAmount);
		} finally {
			await lock.release();
		}
	}

	/*
	async lockBalance(from: string): Promise<void> {
		this.redis.set(`locks:ban-balance:${from.toLowerCase()}`, "1");
	}

	async unlockBalance(from: string): Promise<void> {
		this.redis.del(`locks:ban-balance:${from.toLowerCase()}`);
	}

	async isBalanceLocked(from: string): Promise<boolean> {
		return (
			(await this.redis.exists(`locks:ban-balance:${from.toLowerCase()}`)) === 1
		);
	}
	*/

	async hasPendingClaim(banAddress: string): Promise<boolean> {
		const pendingClaims = await this.redis.keys(
			`claims:pending:${banAddress.toLowerCase()}:*`
		);
		const exists = pendingClaims.length > 0;
		this.log.debug(
			`Checked if there is already a pending claim for ${banAddress.toLowerCase()}: ${exists}`
		);
		return exists;
	}

	async storePendingClaim(
		banAddress: string,
		blockchainAddress: string
	): Promise<boolean> {
		try {
			const key = `claims:pending:${banAddress.toLowerCase()}:${blockchainAddress.toLowerCase()}`;
			await this.redis
				.multi()
				.set(key, "1")
				.expire(key, 5 * 60) // 5 minutes
				.exec();
			this.log.info(
				`Stored pending claim for ${
					banAddress.toLowerCase
				} and ${blockchainAddress.toLowerCase()}`
			);
			return true;
		} catch (err) {
			this.log.error(err);
			return false;
		}
	}

	async isClaimed(banAddress: string): Promise<boolean> {
		const claims = await this.redis.keys(
			`claims:${banAddress.toLowerCase()}:*`
		);
		const exists = claims.length > 0;
		this.log.trace(
			`Checked if there is a claim for ${banAddress.toLowerCase()}: ${exists}`
		);
		return exists;
	}

	async isClaimedFromETH(blockchainAddress: string): Promise<boolean> {
		const claims = await this.redis.keys(
			`claims:*:${blockchainAddress.toLowerCase()}`
		);
		return claims.length > 0;
	}

	async hasClaim(
		banAddress: string,
		blockchainAddress: string
	): Promise<boolean> {
		const claims = await this.redis.keys(
			`claims:${banAddress.toLowerCase()}:${blockchainAddress.toLowerCase()}`
		);
		const exists = claims.length > 0;
		this.log.trace(
			`Checked if there is a claim for ${banAddress.toLowerCase()}: ${exists}`
		);
		return exists;
	}

	async confirmClaim(banAddress: string): Promise<boolean> {
		const pendingClaims = await this.redis.keys(
			`claims:pending:${banAddress.toLowerCase()}:*`
		);
		const key = pendingClaims[0].replace(":pending", "");
		await this.redis.set(key, 1);
		this.log.info(`Stored claim for ${banAddress} with ${key}`);
		return true;
	}

	async getBanAddressesForBlockchainAddress(
		blockchainAddress: string
	): Promise<Array<string>> {
		const claims = await this.redis.keys(
			`claims:*:${blockchainAddress.toLowerCase()}`
		);
		const regexp = new RegExp(
			`claims:(?<banAddress>.*):${blockchainAddress.toLowerCase()}`,
			"g"
		);
		return claims
			.map((claim) => {
				const matches = regexp.exec(claim);
				const banAddress = matches?.groups?.banAddress;
				return banAddress ?? "";
			})
			.filter((banAddress) => banAddress !== "");
	}

	async storeUserDeposit(
		_banAddress: string,
		amount: BigNumber,
		timestamp: number,
		hash: string
	): Promise<void> {
		const banAddress = _banAddress.toLowerCase();
		this.log.info(
			`Storing user deposit from: ${banAddress}, amount: ${amount} BAN, hash: ${hash}`
		);
		const lock = await this.redlock.acquire(
			[`locks:ban-balance:${banAddress}`],
			30_000
		);
		try {
			const rawBalance: string | null = await this.redis.get(
				`ban-balance:${banAddress}`
			);
			let balance: BigNumber;
			if (rawBalance) {
				balance = BigNumber.from(rawBalance);
			} else {
				balance = BigNumber.from(0);
			}
			balance = balance.add(amount);

			await this.redis
				.multi()
				.set(`ban-balance:${banAddress}`, balance.toString())
				.zadd(`deposits:${banAddress}`, timestamp, hash)
				.hset(`audit:${hash}`, { type: "deposit", hash, amount, timestamp })
				.exec();
			this.log.info(
				`Stored user deposit from: ${banAddress}, amount: ${ethers.utils.formatEther(
					amount
				)} BAN, hash: ${hash}`
			);
		} catch (err) {
			this.log.error(
				`Couldn't store user deposit from: ${banAddress}, amount: ${ethers.utils.formatEther(
					amount
				)} BAN, hash: ${hash}`
			);
			throw err;
		} finally {
			await lock.release();
		}
	}

	async containsUserDepositTransaction(
		banAddress: string,
		hash: string
	): Promise<boolean> {
		this.log.info(
			`Checking if user deposit transaction from ${banAddress.toLowerCase()} with hash ${hash} was already processed...`
		);
		const isAlreadyStored: number | null = await this.redis.zrank(
			`deposits:${banAddress.toLowerCase()}`,
			hash
		);
		return isAlreadyStored != null;
	}

	async storeUserWithdrawal(
		_banAddress: string,
		amount: BigNumber,
		timestamp: number,
		hash: string
	): Promise<void> {
		const banAddress = _banAddress.toLowerCase();
		this.log.info(
			`Storing user withdrawal to: ${banAddress}, amount: ${ethers.utils.formatEther(
				amount
			)} BAN, hash: ${hash}`
		);
		const lock = await this.redlock.acquire(
			[`locks:ban-balance:${banAddress}`],
			1_000
		);
		try {
			const rawBalance: string | null = await this.redis.get(
				`ban-balance:${banAddress}`
			);
			let balance: BigNumber;
			if (rawBalance) {
				balance = BigNumber.from(rawBalance);
			} else {
				balance = BigNumber.from(0);
			}
			balance = balance.sub(amount);

			await this.redis
				.multi()
				.set(`ban-balance:${banAddress}`, balance.toString())
				.zadd(`withdrawals:${banAddress}`, timestamp, hash)
				.hset(`audit:${hash}`, {
					type: "withdrawal",
					hash,
					amount,
					timestamp,
				})
				.exec();
			this.log.info(
				`Stored user withdrawal from: ${banAddress}, amount: ${ethers.utils.formatEther(
					amount
				)} BAN`
			);
		} finally {
			lock.release();
		}
	}

	async containsUserWithdrawalRequest(
		banAddress: string,
		timestamp: number
	): Promise<boolean> {
		this.log.info(
			`Checking if user withdrawal request from ${banAddress.toLowerCase()} at ${timestamp} was already processed...`
		);
		const isAlreadyStored = await this.redis.zcount(
			`withdrawals:${banAddress.toLowerCase()}`,
			timestamp,
			timestamp
		);
		return isAlreadyStored === 1;
	}

	async storeUserSwapToWBan(
		_banAddress: string,
		_blockchainAddress: string,
		amount: BigNumber,
		timestamp: number,
		receipt: string,
		uuid: string
	): Promise<void> {
		if (!_banAddress) {
			throw new Error("Missing BAN address");
		}
		const banAddress = _banAddress.toLowerCase();
		this.log.info(
			`Storing swap of ${ethers.utils.formatEther(
				amount
			)} BAN for user ${banAddress}`
		);
		const lock = await this.redlock.acquire(
			[`locks:swaps:ban-to-wban:${banAddress}`],
			1_000
		);
		try {
			const balance = (await this.getUserAvailableBalance(banAddress)).sub(
				amount
			);
			await this.redis
				.multi()
				.set(`ban-balance:${banAddress}`, balance.toString())
				.zadd(`swaps:ban-to-wban:${banAddress}`, timestamp, receipt)
				.hset(`audit:${receipt}`, {
					type: "swap-to-wban",
					blockchainAddress: _blockchainAddress.toLowerCase(),
					receipt,
					uuid,
					amount,
					timestamp,
				})
				.exec();
			this.log.info(
				`Stored user swap from: ${banAddress}, amount: ${ethers.utils.formatEther(
					amount
				)} BAN, receipt: ${receipt}`
			);
		} finally {
			lock.release();
		}
	}

	async storeUserSwapToBan(swap: SwapWBANToBan): Promise<void> {
		if (!swap.banWallet) {
			throw new Error("Missing BAN address");
		}
		const lock = await this.redlock.acquire(
			[`locks:ban-balance:${swap.banWallet}`],
			1_000
		);
		try {
			// check "again" if the txn wasn't already processed
			if (await this.swapToBanWasAlreadyDone(swap)) {
				this.log.warn(`Swap for transaction "${swap.hash}" was already done.`);
			} else {
				const rawBalance: string | null = await this.redis.get(
					`ban-balance:${swap.banWallet.toLowerCase()}`
				);
				let balance: BigNumber;
				if (rawBalance) {
					balance = BigNumber.from(rawBalance);
				} else {
					balance = BigNumber.from(0);
				}
				balance = balance.add(ethers.utils.parseEther(swap.amount));

				await this.redis
					.multi()
					.set(
						`ban-balance:${swap.banWallet.toLowerCase()}`,
						balance.toString()
					)
					.zadd(
						`swaps:wban-to-ban:${swap.blockchainWallet.toLowerCase()}`,
						swap.timestamp * 1_000,
						swap.hash
					)
					.hset(`audit:${swap.hash}`, {
						type: "swap-to-ban",
						hash: swap.hash,
						banAddress: swap.banWallet.toLowerCase(),
						amount: ethers.utils.parseEther(swap.amount).toString(),
						timestamp: swap.timestamp * 1_000,
					})
					.exec();
				this.log.info(
					`Stored user swap from wBAN of ${
						swap.amount
					} BAN from ${swap.blockchainWallet.toLowerCase()} to ${swap.banWallet.toLowerCase()} with hash: ${
						swap.hash
					}`
				);
			}
		} finally {
			lock.release();
		}
	}

	async swapToBanWasAlreadyDone(swap: SwapWBANToBan): Promise<boolean> {
		this.log.info(
			`Checking if swap from ${swap.blockchainWallet.toLowerCase()} with hash ${
				swap.hash
			} was already processed...`
		);
		const isAlreadyProcessed: number | null = await this.redis.zrank(
			`swaps:wban-to-ban:${swap.blockchainWallet.toLowerCase()}`,
			swap.hash
		);
		return isAlreadyProcessed != null;
	}

	async getLastBlockchainBlockProcessed(): Promise<number> {
		const rawBlockValue = await this.redis.get("blockchain:blocks:latest");
		if (rawBlockValue === null) {
			return config.BlockchainWalletPendingTransactionsStartFromBlock;
		}
		return Number.parseInt(rawBlockValue, 10);
	}

	async setLastBlockchainBlockProcessed(block: number): Promise<void> {
		const lastBlockProcessed = await this.getLastBlockchainBlockProcessed();
		if (block > lastBlockProcessed) {
			this.redis.set("blockchain:blocks:latest", block.toString());
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async getDeposits(banAddress: string): Promise<Array<any>> {
		const hashes: string[] = await this.redis.zrevrangebyscore(
			`deposits:${banAddress.toLowerCase()}`,
			"+inf",
			"-inf",
			"LIMIT",
			0,
			RedisUsersDepositsStorage.LIMIT
		);
		return Promise.all(
			hashes.map(async (hash) => {
				const results = await this.redis.hgetall(`audit:${hash}`);
				results.link = `https://creeper.banano.cc/explorer/block/${hash}`;
				return results;
			})
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async getWithdrawals(banAddress: string): Promise<Array<any>> {
		const hashes: string[] = await this.redis.zrevrangebyscore(
			`withdrawals:${banAddress.toLowerCase()}`,
			"+inf",
			"-inf",
			"LIMIT",
			0,
			RedisUsersDepositsStorage.LIMIT
		);
		return Promise.all(
			hashes.map(async (hash) => {
				const results = await this.redis.hgetall(`audit:${hash}`);
				results.link = `https://creeper.banano.cc/explorer/block/${hash}`;
				return results;
			})
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async getSwaps(
		blockchainAddress: string,
		banAddress: string
	): Promise<Array<any>> {
		const banToWBAN: string[] = await this.redis.zrevrangebyscore(
			`swaps:ban-to-wban:${banAddress.toLowerCase()}`,
			"+inf",
			"-inf",
			"LIMIT",
			0,
			RedisUsersDepositsStorage.LIMIT
		);
		const wbanToBAN: string[] = await this.redis.zrevrangebyscore(
			`swaps:wban-to-ban:${blockchainAddress.toLowerCase()}`,
			"+inf",
			"-inf",
			"LIMIT",
			0,
			RedisUsersDepositsStorage.LIMIT
		);
		return Promise.all(
			banToWBAN.concat(wbanToBAN).map(async (hash) => {
				const results = await this.redis.hgetall(`audit:${hash}`);
				if (results.type === "swap-to-ban") {
					results.link = `${config.BlockchainBlockExplorerUrl}/tx/${hash}`;
				}
				return results;
			})
		);
	}

	async isFreeSwapAlreadyDone(from: string): Promise<boolean> {
		const txnId: string | null = await this.redis.get(
			`swaps:gasless:${from.toLowerCase()}`
		);
		return txnId !== null;
	}

	async storeFreeSwap(from: string, txnId: string): Promise<void> {
		await this.redis.set(`swaps:gasless:${from.toLowerCase()}`, txnId);
		this.log.info(`Stored gasless swap from ${from.toLowerCase()}`);
	}
}

export { RedisUsersDepositsStorage };
