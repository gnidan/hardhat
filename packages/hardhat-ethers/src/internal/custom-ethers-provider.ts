import type { AddressLike } from "ethers/types/address";
import type {
  BlockTag,
  TransactionRequest,
  Filter,
  FilterByBlockHash,
  ProviderEvent,
  PerformActionTransaction,
  JsonRpcTransactionRequest,
  TransactionResponseParams,
  BlockParams,
  TransactionReceiptParams,
  LogParams,
  PerformActionFilter,
} from "ethers/types/providers";
import type { Listener } from "ethers/types/utils";

import {
  Block,
  FeeData,
  Log,
  Network as EthersNetwork,
  Transaction,
  TransactionReceipt,
  TransactionResponse,
  accessListify,
  ethers,
  getAddress,
  getBigInt,
  hexlify,
  isHexString,
  makeError,
  resolveAddress,
  toQuantity,
} from "ethers";
import { EthereumProvider } from "hardhat/types";
import { CustomEthersSigner } from "../signers";
import {
  copyRequest,
  formatBlock,
  formatLog,
  formatTransactionReceipt,
  formatTransactionResponse,
} from "./ethers-utils";

type Timer = ReturnType<typeof setTimeout>;

export class CustomEthersProvider implements ethers.Provider {
  constructor(
    private readonly _hardhatProvider: EthereumProvider,
    private readonly _networkName: string
  ) {}

  public get provider(): this {
    return this;
  }

  public destroy() {}

  public async send(method: string, params?: any[]): Promise<any> {
    return this._hardhatProvider.send(method, params);
  }

  public async getSigner(
    address?: number | string
  ): Promise<CustomEthersSigner> {
    if (address === null || address === undefined) {
      address = 0;
    }

    const accountsPromise = this.send("eth_accounts", []);

    // Account index
    if (typeof address === "number") {
      const accounts: string[] = await accountsPromise;
      if (address >= accounts.length) {
        // FVTODO improve this error message
        throw new Error("no such account");
      }
      return CustomEthersSigner.create(this, accounts[address]);
    }

    if (typeof address === "string") {
      const accounts: string[] = await accountsPromise;

      // Account address
      address = getAddress(address);
      for (const account of accounts) {
        if (getAddress(account) === address) {
          return CustomEthersSigner.create(this, account);
        }
      }
    }

    // FVTODO improve this error message
    throw new Error("invalid account");
  }

  public async getBlockNumber(): Promise<number> {
    const blockNumber = await this._hardhatProvider.send("eth_blockNumber");

    return Number(blockNumber);
  }

  public async getNetwork(): Promise<EthersNetwork> {
    const chainId = await this._hardhatProvider.send("eth_chainId");
    return new EthersNetwork(this._networkName, Number(chainId));
  }

  public async getFeeData(): Promise<ethers.FeeData> {
    let gasPrice: bigint | undefined;
    let maxFeePerGas: bigint | undefined;
    let maxPriorityFeePerGas: bigint | undefined;

    try {
      gasPrice = BigInt(await this._hardhatProvider.send("eth_gasPrice"));
    } catch {}

    const latestBlock = await this.getBlock("latest");
    const baseFeePerGas = latestBlock?.baseFeePerGas;
    if (baseFeePerGas !== undefined && baseFeePerGas !== null) {
      maxPriorityFeePerGas = 1_000_000_000n;
      maxFeePerGas = 2n * baseFeePerGas + maxPriorityFeePerGas;
    }

    return new FeeData(gasPrice, maxFeePerGas, maxPriorityFeePerGas);
  }

  public async getBalance(
    address: AddressLike,
    blockTag?: BlockTag | undefined
  ): Promise<bigint> {
    const resolvedAddress = await this._getAddress(address);
    const resolvedBlockTag = await this._getBlockTag(blockTag);
    const rpcBlockTag = this._getRpcBlockTag(resolvedBlockTag);

    const balance = await this._hardhatProvider.send("eth_getBalance", [
      resolvedAddress,
      rpcBlockTag,
    ]);

    return BigInt(balance);
  }

  public async getTransactionCount(
    address: AddressLike,
    blockTag?: BlockTag | undefined
  ): Promise<number> {
    const resolvedAddress = await this._getAddress(address);
    const resolvedBlockTag = await this._getBlockTag(blockTag);
    const rpcBlockTag = this._getRpcBlockTag(resolvedBlockTag);

    const transactionCount = await this._hardhatProvider.send(
      "eth_getTransactionCount",
      [resolvedAddress, rpcBlockTag]
    );

    return Number(transactionCount);
  }

  public async getCode(
    address: AddressLike,
    blockTag?: BlockTag | undefined
  ): Promise<string> {
    const resolvedAddress = await this._getAddress(address);
    const resolvedBlockTag = await this._getBlockTag(blockTag);
    const rpcBlockTag = this._getRpcBlockTag(resolvedBlockTag);

    return this._hardhatProvider.send("eth_getCode", [
      resolvedAddress,
      rpcBlockTag,
    ]);
  }

  public async getStorage(
    address: AddressLike,
    position: ethers.BigNumberish,
    blockTag?: BlockTag | undefined
  ): Promise<string> {
    const resolvedAddress = await this._getAddress(address);
    const resolvedPosition = getBigInt(position, "position");
    const resolvedBlockTag = await this._getBlockTag(blockTag);
    const rpcBlockTag = this._getRpcBlockTag(resolvedBlockTag);

    return this._hardhatProvider.send("eth_getStorageAt", [
      resolvedAddress,
      `0x${resolvedPosition.toString(16)}`,
      rpcBlockTag,
    ]);
  }

  public async estimateGas(tx: TransactionRequest): Promise<bigint> {
    const [resolvedTx, resolvedBlockTag] = await Promise.all([
      this._getTransactionRequest(tx),
      this._getBlockTag(tx.blockTag),
    ]);

    const rpcTransaction = this.getRpcTransaction(resolvedTx);
    const rpcBlockTag = this._getRpcBlockTag(resolvedBlockTag);

    const gasEstimation = await this._hardhatProvider.send("eth_estimateGas", [
      rpcTransaction,
      rpcBlockTag,
    ]);

    return BigInt(gasEstimation);
  }

  public async call(tx: TransactionRequest): Promise<string> {
    const [resolvedTx, resolvedBlockTag] = await Promise.all([
      this._getTransactionRequest(tx),
      this._getBlockTag(tx.blockTag),
    ]);
    const rpcTransaction = this.getRpcTransaction(resolvedTx);
    const rpcBlockTag = this._getRpcBlockTag(resolvedBlockTag);

    return this._hardhatProvider.send("eth_call", [
      rpcTransaction,
      rpcBlockTag,
    ]);
  }

  public async broadcastTransaction(
    signedTx: string
  ): Promise<ethers.TransactionResponse> {
    const hashPromise = this._hardhatProvider.send("eth_sendRawTransaction", [
      signedTx,
    ]);

    const [hash, blockNumber] = await Promise.all([
      hashPromise,
      this.getBlockNumber(),
    ]);

    const tx = Transaction.from(signedTx);
    if (tx.hash !== hash) {
      // FVTODO use plugin error
      throw new Error("The returned hash did not match");
    }

    return this._wrapTransactionResponse(tx as any).replaceableTransaction(
      blockNumber
    );
  }

  public async getBlock(
    blockHashOrBlockTag: BlockTag,
    prefetchTxs?: boolean | undefined
  ): Promise<ethers.Block | null> {
    const block = await this._getBlock(
      blockHashOrBlockTag,
      prefetchTxs ?? false
    );

    // eslint-disable-next-line eqeqeq
    if (block == null) {
      return null;
    }

    return this._wrapBlock(block);
  }

  public async getTransaction(
    hash: string
  ): Promise<ethers.TransactionResponse | null> {
    const transaction = await this._hardhatProvider.send(
      "eth_getTransactionByHash",
      [hash]
    );

    // eslint-disable-next-line eqeqeq
    if (transaction == null) {
      return null;
    }

    return this._wrapTransactionResponse(
      formatTransactionResponse(transaction)
    );
  }

  public async getTransactionReceipt(
    hash: string
  ): Promise<ethers.TransactionReceipt | null> {
    const receipt = await this._hardhatProvider.send(
      "eth_getTransactionReceipt",
      [hash]
    );

    // eslint-disable-next-line eqeqeq
    if (receipt == null) {
      return null;
    }

    return this._wrapTransactionReceipt(receipt);
  }

  public async getTransactionResult(_hash: string): Promise<string | null> {
    // FVTODO plugin error
    throw new Error("not implemented");
  }

  public async getLogs(
    filter: Filter | FilterByBlockHash
  ): Promise<ethers.Log[]> {
    const resolvedFilter = await this._getFilter(filter);

    const logs = await this._hardhatProvider.send("eth_getLogs", [
      resolvedFilter,
    ]);

    return logs.map((log: any) => this._wrapLog(formatLog(log)));
  }

  public async resolveName(_ensName: string): Promise<string | null> {
    // FVTODO plugin error
    throw new Error("not implemented");
  }

  public async lookupAddress(_address: string): Promise<string | null> {
    // FVTODO plugin error
    throw new Error("not implemented");
  }

  public async waitForTransaction(
    hash: string,
    confirms?: number | undefined,
    timeout?: number | undefined
  ): Promise<ethers.TransactionReceipt | null> {
    const resolvedConfirms =
      confirms !== null && confirms !== undefined ? confirms : 1;
    if (resolvedConfirms === 0) {
      return this.getTransactionReceipt(hash);
    }

    return new Promise(async (resolve, reject) => {
      let timer: null | Timer = null;

      const listener = async (blockNumber: number) => {
        try {
          const receipt = await this.getTransactionReceipt(hash);
          if (receipt !== null) {
            if (blockNumber - receipt.blockNumber + 1 >= resolvedConfirms) {
              resolve(receipt);
              if (timer !== null) {
                clearTimeout(timer);
                timer = null;
              }
              return;
            }
          }
        } catch (error) {
          console.log("EEE", error);
        }
        await this.once("block", listener);
      };

      if (timeout !== undefined) {
        timer = setTimeout(async () => {
          if (timer === null) {
            return;
          }
          timer = null;
          await this.off("block", listener);
          reject(makeError("timeout", "TIMEOUT", { reason: "timeout" }));
        }, timeout);
      }

      await listener(await this.getBlockNumber());
    });
  }

  public async waitForBlock(
    _blockTag?: BlockTag | undefined
  ): Promise<ethers.Block> {
    // FVTODO plugin error
    throw new Error("not implemented");
  }

  public async on(event: ProviderEvent, listener: Listener): Promise<this> {
    if (typeof event === "string") {
      this._hardhatProvider.on(event, listener);
    } else {
      // FVTODO improve error
      throw new Error("only basic events are supported");
    }

    return this;
  }

  public async once(event: ProviderEvent, listener: Listener): Promise<this> {
    if (typeof event === "string") {
      this._hardhatProvider.once(event, listener);
    } else {
      // FVTODO improve error
      throw new Error("only basic events are supported");
    }

    return this;
  }

  public async emit(event: ProviderEvent, ...args: any[]): Promise<boolean> {
    if (typeof event === "string") {
      return this._hardhatProvider.emit(event, ...args);
    } else {
      // FVTODO improve error
      throw new Error("only basic events are supported");
    }
  }

  public async listenerCount(
    event?: ProviderEvent | undefined
  ): Promise<number> {
    if (typeof event === "string") {
      return this._hardhatProvider.listenerCount(event);
    } else {
      // FVTODO improve error
      throw new Error("only basic events are supported");
    }
  }

  public async listeners(
    event?: ProviderEvent | undefined
  ): Promise<Listener[]> {
    if (typeof event === "string") {
      return this._hardhatProvider.listeners(event) as any;
    } else {
      // FVTODO improve error
      throw new Error("only basic events are supported");
    }
  }

  public async off(
    event: ProviderEvent,
    listener?: Listener | undefined
  ): Promise<this> {
    if (typeof event === "string" && listener !== undefined) {
      this._hardhatProvider.off(event, listener);
    } else {
      // FVTODO improve error
      throw new Error("only basic events are supported");
    }

    return this;
  }

  public async removeAllListeners(
    event?: ProviderEvent | undefined
  ): Promise<this> {
    if (event === undefined || typeof event === "string") {
      this._hardhatProvider.removeAllListeners(event);
    } else {
      // FVTODO improve error
      throw new Error("only basic events are supported");
    }

    return this;
  }

  public async addListener(
    event: ProviderEvent,
    listener: Listener
  ): Promise<this> {
    if (typeof event === "string") {
      this._hardhatProvider.addListener(event, listener);
    } else {
      // FVTODO improve error
      throw new Error("only basic events are supported");
    }

    return this;
  }

  public async removeListener(
    event: ProviderEvent,
    listener: Listener
  ): Promise<this> {
    if (typeof event === "string") {
      this._hardhatProvider.removeListener(event, listener);
    } else {
      // FVTODO improve error
      throw new Error("only basic events are supported");
    }

    return this;
  }

  public getRpcTransaction(tx: TransactionRequest): JsonRpcTransactionRequest {
    const result: JsonRpcTransactionRequest = {};

    // JSON-RPC now requires numeric values to be "quantity" values
    [
      "chainId",
      "gasLimit",
      "gasPrice",
      "type",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
      "nonce",
      "value",
    ].forEach((key) => {
      if ((tx as any)[key] === null || (tx as any)[key] === undefined) {
        return;
      }
      let dstKey = key;
      if (key === "gasLimit") {
        dstKey = "gas";
      }
      (result as any)[dstKey] = toQuantity(
        getBigInt((tx as any)[key], `tx.${key}`)
      );
    });

    // Make sure addresses and data are lowercase
    ["from", "to", "data"].forEach((key) => {
      if ((tx as any)[key] === null || (tx as any)[key] === undefined) {
        return;
      }
      (result as any)[key] = hexlify((tx as any)[key]);
    });

    // Normalize the access list object
    if (tx.accessList !== null && tx.accessList !== undefined) {
      result.accessList = accessListify(tx.accessList);
    }

    return result;
  }

  public toJSON() {
    return "<WrappedHardhatProvider>";
  }

  private _getAddress(address: AddressLike): string | Promise<string> {
    return resolveAddress(address, this);
  }

  private _getBlockTag(blockTag?: BlockTag): string | Promise<string> {
    // eslint-disable-next-line eqeqeq
    if (blockTag == null) {
      return "latest";
    }

    switch (blockTag) {
      case "earliest":
        return "0x0";
      case "latest":
      case "pending":
      case "safe":
      case "finalized":
        return blockTag;
    }

    if (isHexString(blockTag)) {
      if (isHexString(blockTag, 32)) {
        return blockTag;
      }
      return toQuantity(blockTag);
    }

    if (typeof blockTag === "number") {
      if (blockTag >= 0) {
        return toQuantity(blockTag);
      }
      return this.getBlockNumber().then((b) => toQuantity(b + blockTag));
    }

    // FVTODO plugin error
    throw new Error(`Invalid blockTag: ${blockTag}`);
  }

  private _getTransactionRequest(
    _request: TransactionRequest
  ): PerformActionTransaction | Promise<PerformActionTransaction> {
    const request = copyRequest(_request) as PerformActionTransaction;

    const promises: Array<Promise<void>> = [];
    ["to", "from"].forEach((key) => {
      if (
        (request as any)[key] === null ||
        (request as any)[key] === undefined
      ) {
        return;
      }

      const addr = resolveAddress((request as any)[key]);
      if (isPromise(addr)) {
        promises.push(
          (async function () {
            (request as any)[key] = await addr;
          })()
        );
      } else {
        (request as any)[key] = addr;
      }
    });

    if (request.blockTag !== null && request.blockTag !== undefined) {
      const blockTag = this._getBlockTag(request.blockTag);
      if (isPromise(blockTag)) {
        promises.push(
          (async function () {
            request.blockTag = await blockTag;
          })()
        );
      } else {
        request.blockTag = blockTag;
      }
    }

    if (promises.length > 0) {
      return (async function () {
        await Promise.all(promises);
        return request;
      })();
    }

    return request;
  }

  private _wrapTransactionResponse(
    tx: TransactionResponseParams
  ): TransactionResponse {
    return new TransactionResponse(tx, this);
  }

  private async _getBlock(
    block: BlockTag | string,
    includeTransactions: boolean
  ): Promise<any> {
    if (isHexString(block, 32)) {
      return this._hardhatProvider.send("eth_getBlockByHash", [
        block,
        includeTransactions,
      ]);
    }

    let blockTag = this._getBlockTag(block);
    if (typeof blockTag !== "string") {
      blockTag = await blockTag;
    }

    return this._hardhatProvider.send("eth_getBlockByNumber", [
      blockTag,
      includeTransactions,
    ]);
  }

  private _wrapBlock(value: BlockParams): Block {
    return new Block(formatBlock(value), this);
  }

  private _wrapTransactionReceipt(
    value: TransactionReceiptParams
  ): TransactionReceipt {
    return new TransactionReceipt(formatTransactionReceipt(value), this);
  }

  private _getFilter(
    filter: Filter | FilterByBlockHash
  ): PerformActionFilter | Promise<PerformActionFilter> {
    // Create a canonical representation of the topics
    const topics = (filter.topics ?? []).map((topic) => {
      // eslint-disable-next-line eqeqeq
      if (topic == null) {
        return null;
      }
      if (Array.isArray(topic)) {
        return concisify(topic.map((t) => t.toLowerCase()));
      }
      return topic.toLowerCase();
    });

    const blockHash = "blockHash" in filter ? filter.blockHash : undefined;

    const resolve = (
      _address: string[],
      fromBlock?: string,
      toBlock?: string
    ) => {
      let resolvedAddress: undefined | string | string[];
      switch (_address.length) {
        case 0:
          break;
        case 1:
          resolvedAddress = _address[0];
          break;
        default:
          _address.sort();
          resolvedAddress = _address;
      }

      if (blockHash !== undefined) {
        // eslint-disable-next-line eqeqeq
        if (fromBlock != null || toBlock != null) {
          throw new Error("invalid filter");
        }
      }

      const resolvedFilter: any = {};
      if (resolvedAddress !== undefined) {
        resolvedFilter.address = resolvedAddress;
      }
      if (topics.length > 0) {
        resolvedFilter.topics = topics;
      }
      if (fromBlock !== undefined) {
        resolvedFilter.fromBlock = fromBlock;
      }
      if (toBlock !== undefined) {
        resolvedFilter.toBlock = toBlock;
      }
      if (blockHash !== undefined) {
        resolvedFilter.blockHash = blockHash;
      }

      return resolvedFilter;
    };

    // Addresses could be async (ENS names or Addressables)
    const address: Array<string | Promise<string>> = [];
    if (filter.address !== undefined) {
      if (Array.isArray(filter.address)) {
        for (const addr of filter.address) {
          address.push(this._getAddress(addr));
        }
      } else {
        address.push(this._getAddress(filter.address));
      }
    }

    let resolvedFromBlock: undefined | string | Promise<string>;
    if ("fromBlock" in filter) {
      resolvedFromBlock = this._getBlockTag(filter.fromBlock);
    }

    let resolvedToBlock: undefined | string | Promise<string>;
    if ("toBlock" in filter) {
      resolvedToBlock = this._getBlockTag(filter.toBlock);
    }

    if (
      address.filter((a) => typeof a !== "string").length > 0 ||
      // eslint-disable-next-line eqeqeq
      (resolvedFromBlock != null && typeof resolvedFromBlock !== "string") ||
      // eslint-disable-next-line eqeqeq
      (resolvedToBlock != null && typeof resolvedToBlock !== "string")
    ) {
      return Promise.all([
        Promise.all(address),
        resolvedFromBlock,
        resolvedToBlock,
      ]).then((result) => {
        return resolve(result[0], result[1], result[2]);
      });
    }

    return resolve(address as string[], resolvedFromBlock, resolvedToBlock);
  }

  private _wrapLog(value: LogParams): Log {
    return new Log(formatLog(value), this);
  }

  private _getRpcBlockTag(blockTag: string): string | { blockHash: string } {
    if (isHexString(blockTag, 32)) {
      return { blockHash: blockTag };
    }

    return blockTag;
  }
}

function isPromise<T = any>(value: any): value is Promise<T> {
  return Boolean(value) && typeof value.then === "function";
}

function concisify(items: string[]): string[] {
  items = Array.from(new Set(items).values());
  items.sort();
  return items;
}
