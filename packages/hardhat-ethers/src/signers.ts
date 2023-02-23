// FVTODO remove
/* eslint-disable @typescript-eslint/no-unused-vars */
import type { BlockTag, TransactionRequest } from "ethers/types/providers";
import {
  assertArgument,
  ethers,
  getAddress,
  hexlify,
  resolveAddress,
  toUtf8Bytes,
  TransactionLike,
  TypedDataEncoder,
} from "ethers";
import { CustomEthersProvider } from "./internal/custom-ethers-provider";
import { copyRequest, resolveProperties } from "./internal/ethers-utils";

export class CustomEthersSigner implements ethers.Signer {
  public readonly address: string;
  provider: CustomEthersProvider;

  public static async create(provider: CustomEthersProvider, address: string) {
    return new CustomEthersSigner(address, provider);
  }

  private constructor(address: string, _provider: CustomEthersProvider) {
    this.address = getAddress(address);
    this.provider = _provider;
  }

  public connect(provider: CustomEthersProvider): ethers.Signer {
    return new CustomEthersSigner(this.address, provider);
  }

  public getNonce(blockTag?: BlockTag | undefined): Promise<number> {
    return this.provider.getTransactionCount(this.address, blockTag);
  }

  public populateCall(
    tx: TransactionRequest
  ): Promise<ethers.TransactionLike<string>> {
    return populate(this, tx);
  }

  public populateTransaction(
    tx: TransactionRequest
  ): Promise<ethers.TransactionLike<string>> {
    return this.populateCall(tx);
  }

  public async estimateGas(tx: TransactionRequest): Promise<bigint> {
    return this.provider.estimateGas(await this.populateCall(tx));
  }

  public async call(tx: TransactionRequest): Promise<string> {
    return this.provider.call(await this.populateCall(tx));
  }

  public resolveName(name: string): Promise<string | null> {
    return this.provider.resolveName(name);
  }

  public async signTransaction(_tx: TransactionRequest): Promise<string> {
    const tx = deepCopy(_tx);

    // Make sure the from matches the sender
    if (tx.from !== null && tx.from !== undefined) {
      const from = await resolveAddress(tx.from, this.provider);
      assertArgument(
        from !== null &&
          from !== undefined &&
          from.toLowerCase() === this.address.toLowerCase(),
        "from address mismatch",
        "transaction",
        tx
      );
      tx.from = from;
    } else {
      tx.from = this.address;
    }

    const hexTx = this.provider.getRpcTransaction(tx);
    return this.provider.send("eth_signTransaction", [hexTx]);
  }

  public async sendTransaction(
    tx: TransactionRequest
  ): Promise<ethers.TransactionResponse> {
    // This cannot be mined any earlier than any recent block
    const blockNumber = await this.provider.getBlockNumber();

    // Send the transaction
    const hash = await this._sendUncheckedTransaction(tx);

    // Unfortunately, JSON-RPC only provides and opaque transaction hash
    // for a response, and we need the actual transaction, so we poll
    // for it; it should show up very quickly

    return new Promise((resolve) => {
      const timeouts = [1000, 100];
      const checkTx = async () => {
        // Try getting the transaction
        const txPolled = await this.provider.getTransaction(hash);
        if (txPolled !== null) {
          resolve(txPolled.replaceableTransaction(blockNumber));
          return;
        }

        // Wait another 4 seconds
        setTimeout(() => {
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          checkTx();
        }, timeouts.pop() ?? 4000);
      };
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      checkTx();
    });
  }

  public signMessage(message: string | Uint8Array): Promise<string> {
    const resolvedMessage =
      typeof message === "string" ? toUtf8Bytes(message) : message;
    return this.provider.send("personal_sign", [
      hexlify(resolvedMessage),
      this.address.toLowerCase(),
    ]);
  }

  public async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, any>
  ): Promise<string> {
    const copiedValue = deepCopy(value);

    // Populate any ENS names (in-place)
    const populated = await TypedDataEncoder.resolveNames(
      domain,
      types,
      copiedValue,
      async (v: string) => {
        const address = await resolveAddress(v);
        assertArgument(
          address !== null,
          "TypedData does not support null address",
          "value",
          v
        );
        return address;
      }
    );

    return this.provider.send("eth_signTypedData_v4", [
      this.address.toLowerCase(),
      JSON.stringify(
        TypedDataEncoder.getPayload(populated.domain, types, populated.value)
      ),
    ]);
  }

  public async getAddress(): Promise<string> {
    return this.address;
  }

  public toJSON() {
    return `<SignerWithAddress ${this.address}>`;
  }

  private async _sendUncheckedTransaction(
    _tx: TransactionRequest
  ): Promise<string> {
    const tx = deepCopy(_tx);

    const promises: Array<Promise<void>> = [];

    // Make sure the from matches the sender
    if (tx.from !== null && tx.from !== undefined) {
      const _from = tx.from;
      promises.push(
        (async () => {
          const from = await resolveAddress(_from, this.provider);
          assertArgument(
            from !== null &&
              from !== undefined &&
              from.toLowerCase() === this.address.toLowerCase(),
            "from address mismatch",
            "transaction",
            _tx
          );
          tx.from = from;
        })()
      );
    } else {
      tx.from = this.address;
    }

    // The JSON-RPC for eth_sendTransaction uses 90000 gas; if the user
    // wishes to use this, it is easy to specify explicitly, otherwise
    // we look it up for them.
    if (tx.gasLimit === null || tx.gasLimit === undefined) {
      promises.push(
        (async () => {
          tx.gasLimit = await this.provider.estimateGas({
            ...tx,
            from: this.address,
          });
        })()
      );
    }

    // The address may be an ENS name or Addressable
    if (tx.to !== null && tx.to !== undefined) {
      const _to = tx.to;
      promises.push(
        (async () => {
          tx.to = await resolveAddress(_to, this.provider);
        })()
      );
    }

    // Wait until all of our properties are filled in
    if (promises.length > 0) {
      await Promise.all(promises);
    }

    const hexTx = this.provider.getRpcTransaction(tx);

    return this.provider.send("eth_sendTransaction", [hexTx]);
  }
}

async function populate(
  signer: ethers.Signer,
  tx: TransactionRequest
): Promise<TransactionLike<string>> {
  const pop: any = copyRequest(tx);

  if (pop.to !== null && pop.to !== undefined) {
    pop.to = resolveAddress(pop.to, signer);
  }

  if (pop.from !== null && pop.from !== undefined) {
    const from = pop.from;
    pop.from = Promise.all([
      signer.getAddress(),
      resolveAddress(from, signer),
    ]).then(([address, resolvedFrom]) => {
      assertArgument(
        address.toLowerCase() === resolvedFrom.toLowerCase(),
        "transaction from mismatch",
        "tx.from",
        resolvedFrom
      );
      return address;
    });
  } else {
    pop.from = signer.getAddress();
  }

  return resolveProperties(pop);
}

const Primitive = "bigint,boolean,function,number,string,symbol".split(/,/g);
function deepCopy<T = any>(value: T): T {
  if (
    value === null ||
    value === undefined ||
    Primitive.indexOf(typeof value) >= 0
  ) {
    return value;
  }

  // Keep any Addressable
  if (typeof (value as any).getAddress === "function") {
    return value;
  }

  if (Array.isArray(value)) {
    return (value as any).map(deepCopy);
  }

  if (typeof value === "object") {
    return Object.keys(value).reduce((accum, key) => {
      accum[key] = (value as any)[key];
      return accum;
    }, {} as any);
  }

  throw new Error(`should not happen: ${value as any} (${typeof value})`);
}
