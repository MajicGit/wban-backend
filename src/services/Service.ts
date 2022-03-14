import { Logger } from "tslog";
import { BigNumber, ethers } from "ethers";
import { Processor } from "bullmq";
import { Banano } from "../Banano";
import config from "../config";
import { UsersDepositsService } from "./UsersDepositsService";
import InvalidSignatureError from "../errors/InvalidSignatureError";
import InvalidOwner from "../errors/InvalidOwner";
import InsufficientBalanceError from "../errors/InsufficientBalanceError";
import { ClaimResponse } from "../models/responses/ClaimResponse";
import { Blockchain } from "../Blockchain";
import ProcessingQueue from "./queuing/ProcessingQueue";
import { OperationsNames } from "../models/operations/Operation";
import BananoUserWithdrawal from "../models/operations/BananoUserWithdrawal";
import SwapBanToWBAN from "../models/operations/SwapBanToWBAN";
import SwapWBANToBan from "../models/operations/SwapWBANToBan";
import History from "../models/responses/History";
import BlockchainScanQueue from "./queuing/BlockchainScanQueue";
import { BananoWalletsBlacklist } from "./BananoWalletsBlacklist";

class Service {
	banano: Banano;

	public blockchain: Blockchain;

	private usersDepositsService: UsersDepositsService;

	private processingQueue: ProcessingQueue;

	private blockchainScanQueue: BlockchainScanQueue;

	private bananoWalletsBlacklist: BananoWalletsBlacklist;

	private log: Logger = config.Logger.getChildLogger();

	constructor(
		usersDepositsService: UsersDepositsService,
		processingQueue: ProcessingQueue,
		blockchainScanQueue: BlockchainScanQueue,
		bananoWalletsBlacklist: BananoWalletsBlacklist
	) {
		this.processingQueue = processingQueue;
		this.blockchainScanQueue = blockchainScanQueue;
		this.banano = new Banano(
			config.BananoUsersDepositsHotWallet,
			config.BananoUsersDepositsColdWallet,
			config.BananoSeed,
			config.BananoSeedIdx,
			config.BananoRepresentative,
			usersDepositsService,
			this.processingQueue
		);
		this.processingQueue.registerProcessor(
			OperationsNames.BananoWithdrawal,
			async (job) => {
				const withdrawal: BananoUserWithdrawal = job.data;
				const processor = this.withdrawalProcessor(withdrawal.signature);
				return processor(job);
			}
		);
		this.processingQueue.registerProcessor(
			OperationsNames.SwapToWBAN,
			async (job) => {
				const swap: SwapBanToWBAN = job.data;
				const { receipt, uuid, wbanBalance } = await this.processSwapToWBAN(
					swap
				);
				return {
					banWallet: swap.from,
					blockchainWallet: swap.blockchainWallet,
					swapped: swap.amount,
					receipt,
					uuid,
					balance: ethers.utils.formatEther(
						await this.usersDepositsService.getUserAvailableBalance(swap.from)
					),
					wbanBalance: ethers.utils.formatEther(wbanBalance),
				};
			}
		);
		this.processingQueue.registerProcessor(
			OperationsNames.SwapToBAN,
			async (job) => {
				const swap: SwapWBANToBan = job.data;
				const { hash, wbanBalance } = await this.processSwapToBAN(swap);
				return {
					banWallet: swap.banWallet,
					swapped: swap.amount,
					balance: ethers.utils.formatEther(
						await this.usersDepositsService.getUserAvailableBalance(
							swap.banWallet
						)
					),
					wbanBalance,
					transaction: hash,
					transactionLink: `${config.BlockchainBlockExplorerUrl}/tx/${hash}`,
				};
			}
		);
		this.blockchain = new Blockchain(
			usersDepositsService,
			this.blockchainScanQueue
		);
		this.blockchain.onSwapToBAN((swap: SwapWBANToBan) => this.swapToBAN(swap));
		this.usersDepositsService = usersDepositsService;
		this.bananoWalletsBlacklist = bananoWalletsBlacklist;
	}

	start(): void {
		this.processingQueue.start();
		this.blockchainScanQueue.start();
		this.banano.subscribeToBananoNotificationsForWallet();
	}

	async getUserAvailableBalance(from: string): Promise<BigNumber> {
		return this.usersDepositsService.getUserAvailableBalance(from);
	}

	// check if the user already claimed his addresses
	async claimAvailable(
		banWallet: string,
		blockchainWallet: string
	): Promise<boolean> {
		return this.usersDepositsService.hasClaim(banWallet, blockchainWallet);
	}

	async claim(
		banWallet: string,
		blockchainWallet: string,
		signature: string
	): Promise<ClaimResponse> {
		// verify signature
		if (
			!this.checkSignature(
				blockchainWallet,
				signature,
				`I hereby claim that the BAN address "${banWallet}" is mine`
			)
		) {
			return ClaimResponse.InvalidSignature;
		}
		// check if the address is blacklisted
		const blacklisted = await this.bananoWalletsBlacklist.isBlacklisted(
			banWallet
		);
		if (blacklisted !== undefined) {
			this.log.warn(
				`Can't claim "${banWallet}. This is a blacklisted wallet linked to ${blacklisted.alias}`
			);
			return ClaimResponse.Blacklisted;
		}
		// check if the user already did the claim process
		if (await this.usersDepositsService.hasClaim(banWallet, blockchainWallet)) {
			return ClaimResponse.AlreadyDone;
		}
		// check if there is a pending claim
		if (!(await this.usersDepositsService.hasPendingClaim(banWallet))) {
			return (await this.usersDepositsService.storePendingClaim(
				banWallet,
				blockchainWallet
			))
				? ClaimResponse.Ok
				: ClaimResponse.Error;
		}
		// assume this is another use who tried to do this
		return ClaimResponse.InvalidOwner;
	}

	async withdrawBAN(
		banWallet: string,
		amount: string,
		blockchainWallet: string,
		timestamp: number,
		signature: string
	): Promise<string> {
		return this.processingQueue.addBananoUserWithdrawal({
			banWallet,
			amount,
			blockchainWallet,
			signature,
			timestamp,
			attempt: 0,
		});
	}

	async processWithdrawBAN(
		withdrawal: BananoUserWithdrawal,
		signature?: string
	): Promise<string> {
		const { banWallet, amount, blockchainWallet, timestamp } = withdrawal;

		this.log.info(
			`Processing user withdrawal request of "${amount}" BAN from wallet "${banWallet}"`
		);

		// check if request was already processed
		if (
			await this.usersDepositsService.containsUserWithdrawalRequest(withdrawal)
		) {
			this.log.warn(
				`User withdrawal request to "${banWallet}" at ${timestamp} was already processed`
			);
			throw new Error(
				"Can't withdraw BAN as the transaction was already processed"
			);
		}

		// verify signature
		if (
			signature &&
			!this.checkSignature(
				blockchainWallet,
				signature,
				`Withdraw ${amount} BAN to my wallet "${banWallet}"`
			)
		) {
			throw new InvalidSignatureError();
		}

		// verify is the claim was previously done
		if (!this.usersDepositsService.isClaimed(banWallet)) {
			throw new Error(`Can't withdraw from unclaimed wallet ${banWallet}`);
		} else if (
			!this.usersDepositsService.hasClaim(banWallet, blockchainWallet)
		) {
			throw new Error("Can't withdraw from another Blockchain wallet");
		}

		const withdrawnAmount: BigNumber = ethers.utils.parseEther(amount);

		// check for positive amounts
		if (withdrawnAmount.isNegative()) {
			throw new Error("Can't withdraw negative amounts of BAN");
		}

		// check if deposits are greater than or equal to amount to withdraw
		const availableBalance: BigNumber = await this.usersDepositsService.getUserAvailableBalance(
			banWallet
		);
		if (!availableBalance.gte(withdrawnAmount)) {
			const message = `User "${banWallet}" has not deposited enough BAN for a withdrawal of ${amount} BAN. Deposited balance is: ${ethers.utils.formatEther(
				availableBalance
			)} BAN`;
			this.log.warn(message);
			throw new InsufficientBalanceError(message);
		}

		// send the BAN to the user
		const { pending, hash } = await this.eventuallySendBan(withdrawal);

		if (pending || !hash) {
			return "";
		}

		// decrease user deposits
		await this.usersDepositsService.storeUserWithdrawal(
			banWallet,
			withdrawnAmount,
			timestamp,
			hash
		);
		this.log.info(`Withdrew ${amount} BAN to "${banWallet} with txn ${hash}"`);
		return hash;
	}

	async swapToWBAN(
		from: string,
		amount: number,
		blockchainWallet: string,
		timestamp: number,
		signature: string
	): Promise<string> {
		return this.processingQueue.addSwapToWBan({
			from,
			amount,
			blockchainWallet,
			signature,
			timestamp,
		});
	}

	async processSwapToWBAN(swap: SwapBanToWBAN): Promise<any> {
		const { from, blockchainWallet, signature } = swap;
		const amountStr = swap.amount;
		// verify signature
		if (
			!this.checkSignature(
				blockchainWallet,
				signature,
				`Swap ${amountStr} BAN for wBAN with BAN I deposited from my wallet "${from}"`
			)
		) {
			throw new InvalidSignatureError();
		}
		// verify if there is a proper claim
		if (!(await this.usersDepositsService.hasClaim(from, blockchainWallet))) {
			throw new InvalidOwner();
		}

		const amount: BigNumber = ethers.utils.parseEther(amountStr.toString());

		// check for positive amounts
		if (amount.isNegative()) {
			throw new Error("Can't swap negative amounts of BAN");
		}

		// check if deposits are greater than or equal to amount to swap
		const availableBalance: BigNumber = await this.usersDepositsService.getUserAvailableBalance(
			from
		);
		if (!availableBalance.gte(amount)) {
			const message = `User "${from}" has not deposited enough BAN for a swap of ${amountStr} BAN. Deposited balance is: ${ethers.utils.formatEther(
				availableBalance
			)} BAN`;
			this.log.warn(message);
			throw new InsufficientBalanceError(message);
		}

		// create wBAN swap receipt
		const {
			receipt,
			uuid,
			wbanBalance,
		} = await this.blockchain.createMintReceipt(blockchainWallet, amount);
		// decrease user deposits
		// TODO: store signature?
		await this.usersDepositsService.storeUserSwapToWBan(
			from,
			blockchainWallet,
			amount,
			swap.timestamp,
			receipt,
			uuid
		);
		return { receipt, uuid, wbanBalance };
	}

	async swapToBAN(swap: SwapWBANToBan): Promise<string> {
		return this.processingQueue.addSwapToBan(swap);
	}

	async processSwapToBAN(swap: SwapWBANToBan): Promise<any> {
		this.log.info(
			`Swapping ${swap.amount} wBAN to BAN (txn: ${swap.hash}) into wallet "${swap.banWallet}"...`
		);
		// check if the BAN were already sent
		if (await this.usersDepositsService.containsUserSwapToBan(swap)) {
			this.log.warn(`Swap for transaction "${swap.hash}" was already done.`);
			return {
				hash: swap.hash,
				wbanBalance: swap.wbanBalance,
			};
		}
		// add the amount to user deposits and store user swap from wBAN to BAN
		await this.usersDepositsService.storeUserSwapToBan(swap);
		return {
			hash: swap.hash,
			wbanBalance: swap.wbanBalance,
		};
	}

	async getHistory(
		blockchainWallet: string,
		banWallet: string
	): Promise<History> {
		const history = new History();
		history.deposits = await this.usersDepositsService.getDeposits(banWallet);
		history.withdrawals = await this.usersDepositsService.getWithdrawals(
			banWallet
		);
		history.swaps = await this.usersDepositsService.getSwaps(
			blockchainWallet,
			banWallet
		);
		return history;
	}

	async getPendingWithdrawalsAmount(): Promise<BigNumber> {
		return this.processingQueue.getPendingWithdrawalsAmount();
	}

	checkSignature(
		blockchainWallet: string,
		signature: string,
		expected: string
	): boolean {
		this.log.trace(`Checking signature '${signature}'`);
		const author = ethers.utils.verifyMessage(expected, signature);
		const sanitizedAddress = ethers.utils.getAddress(blockchainWallet);
		if (author !== sanitizedAddress) {
			this.log.warn(
				`Signature is invalid. ${sanitizedAddress} sent a signed message pretending to be from ${author}`
			);
		}
		return author === sanitizedAddress;
	}

	private async eventuallySendBan(
		withdrawal: BananoUserWithdrawal
	): Promise<{ pending: boolean; hash?: string }> {
		const amountStr = withdrawal.amount;
		const amount: BigNumber = ethers.utils.parseEther(amountStr);
		// check if hot wallet balance is greater than or equal to amount to withdraw
		const hotWalletBalance: BigNumber = await this.banano.getBalance(
			config.BananoUsersDepositsHotWallet
		);
		if (hotWalletBalance.lt(amount)) {
			this.log.warn(
				`Hot wallet balance of ${ethers.utils.formatEther(
					hotWalletBalance
				)} BAN is not enough to proceed with a withdrawal of ${amountStr} BAN. Adding a pending withdrawal to queue.`
			);
			await this.processingQueue.addBananoUserPendingWithdrawal(withdrawal);
			return { pending: true };
		}
		// send the BAN to the user
		const hash = await this.banano.sendBan(withdrawal.banWallet, amount);
		return { pending: false, hash };
	}

	private withdrawalProcessor(
		signature?: string
	): Processor<BananoUserWithdrawal, any, string> {
		return async (job) => {
			const withdrawal: BananoUserWithdrawal = job.data;
			const hash = await this.processWithdrawBAN(withdrawal, signature);
			if (hash) {
				return {
					banWallet: withdrawal.banWallet,
					withdrawal: withdrawal.amount,
					balance: ethers.utils.formatEther(
						await this.usersDepositsService.getUserAvailableBalance(
							withdrawal.banWallet
						)
					),
					transaction: hash,
				};
			}
			if (withdrawal.attempt === 1) {
				return {
					banWallet: withdrawal.banWallet,
					withdrawal: withdrawal.amount,
					balance: ethers.utils.formatEther(
						await this.usersDepositsService.getUserAvailableBalance(
							withdrawal.banWallet
						)
					),
					transaction: "",
				};
			}
			// throw an error just to get the job as failed and removed as a new one was created instead
			throw new Error("Old pending withdrawal request replaced by a new one");
		};
	}
}

export { Service };
