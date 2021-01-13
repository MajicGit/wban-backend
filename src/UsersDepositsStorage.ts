import BigNumber from "@bananocoin/bananojs";

interface UsersDepositsStorage {
	getUserAvailableBalance(from: string): Promise<number>;
	storeUserDeposit(
		from: string,
		amount: BigNumber,
		hash: string
	): Promise<void>;
	storeUserSwap(from: string, amount: number): Promise<void>;
}

export { UsersDepositsStorage };
