import type * as ethers from "ethers";
import type { Artifact } from "hardhat/types";
import type { CustomEthersProvider } from "../internal/custom-ethers-provider";
import type { CustomEthersSigner } from "../signers";

export interface Libraries {
  [libraryName: string]: string;
}

export interface FactoryOptions {
  signer?: ethers.Signer;
  libraries?: Libraries;
}

export declare function getContractFactory(
  name: string,
  signerOrOptions?: ethers.Signer | FactoryOptions
): Promise<ethers.ContractFactory>;
export declare function getContractFactory(
  abi: any[],
  bytecode: ethers.BytesLike,
  signer?: ethers.Signer
): Promise<ethers.ContractFactory>;

export declare function deployContract(
  name: string,
  signerOrOptions?: ethers.Signer | FactoryOptions
): Promise<ethers.Contract>;

export declare function deployContract(
  name: string,
  args: any[],
  signerOrOptions?: ethers.Signer | FactoryOptions
): Promise<ethers.Contract>;

export interface HardhatEthersHelpers {
  provider: CustomEthersProvider;

  getContractFactory: typeof getContractFactory;
  getContractFactoryFromArtifact: (
    artifact: Artifact,
    signerOrOptions?: ethers.Signer | FactoryOptions
  ) => Promise<ethers.ContractFactory>;
  getContractAt: (
    nameOrAbi: string | any[],
    address: string,
    signer?: ethers.Signer
  ) => Promise<ethers.Contract>;
  getContractAtFromArtifact: (
    artifact: Artifact,
    address: string,
    signer?: ethers.Signer
  ) => Promise<ethers.Contract>;
  getSigner: (address: string) => Promise<CustomEthersSigner>;
  getSigners: () => Promise<CustomEthersSigner[]>;
  getImpersonatedSigner: (address: string) => Promise<CustomEthersSigner>;
  deployContract: typeof deployContract;
}
