import * as dotenv from "dotenv";
dotenv.config();

import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, holesky } from "viem/chains";
import { AvsDirectoryABI } from "./abis/AvsDirectory";
import { DelegationManagerABI } from "./abis/DelegationManager";
import { HookABI } from "./abis/Hook";
import { QuoterABI } from "./abis/Quoter";
import { ServiceManagerABI } from "./abis/ServiceManager";
import { StakeRegistryABI } from "./abis/StakeRegistry";
import { deploymentAddresses } from "./deployment_addresses";
import { PoolManagerABI } from "./abis/PoolManager";
import bigDecimal from "js-big-decimal";

// Changed from Task to LoanTask for debt order matching
export type LoanTask = {
  // Core loan parameters
  isLender: boolean;              // replaces zeroForOne - true for lenders, false for borrowers
  principalAmount: bigint;        // replaces amountSpecified - amount of USDC
  interestRateBips: bigint;       // replaces sqrtPriceLimitX96 - interest rate in basis points
  maturityTimestamp: bigint;      // new - when the loan matures
  collateralRequired?: bigint;    // new - ETH collateral for borrower orders
  
  // Order metadata
  sender: `0x${string}`;          // address of the order creator
  orderId: `0x${string}`;         // replaces poolId - unique order identifier
  orderData: LoanOrderData;       // replaces poolKey - full order parameters
  taskCreatedBlock: number;       // block when order was submitted
  taskId: number;                 // unique task ID in the system
  
  // Matching results (set after matching algorithm runs)
  matchedAmount: bigint | null;   // replaces poolOutputAmount - amount matched
  effectiveRate: bigint | null;   // replaces poolInputAmount - weighted average rate
};

// New type for loan order data structure
export type LoanOrderData = {
  token: `0x${string}`;           // USDC address
  minPrincipal: bigint;           // minimum amount willing to lend/borrow
  maxPrincipal: bigint;           // maximum amount willing to lend/borrow
  minRate: bigint;                // minimum acceptable rate (for lenders)
  maxRate: bigint;                // maximum acceptable rate (for borrowers)
  maturityOptions: bigint[];      // acceptable maturity timestamps
  collateralRatio: bigint;        // required collateral ratio (e.g., 150%)
  expiry: bigint;                 // when this order expires
  nonce: bigint;                  // for signature replay protection
};

// Updated feasibility enum for loan matching
export enum LoanFeasibility {
  NONE = "No compatible lenders and borrowers",
  FULL_MATCH = "All orders fully matched at optimal rates",
  PARTIAL_LENDER = "Lenders partially matched, borrowers fully matched",
  PARTIAL_BORROWER = "Borrowers partially matched, lenders fully matched",
  PARTIAL_BOTH = "Both sides partially matched",
  NO_RATE_OVERLAP = "No overlap between lender min and borrower max rates",
  MATURITY_MISMATCH = "No compatible maturity dates",
}

// Updated result type for loan matching
export type LoanMatchingResult = {
  matchings: LoanMatching[];
  
  // Average rates and totals
  averageLenderRate: bigDecimal;
  averageBorrowerRate: bigDecimal;
  totalLenderAmount: bigint;
  totalBorrowerAmount: bigint;
  
  // Matched amounts
  totalMatchedAmount: bigint;
  unmatchedLenderAmount: bigint;
  unmatchedBorrowerAmount: bigint;
  
  // Feasibility and optimization metrics
  feasible: boolean;
  feasibilityType: LoanFeasibility;
  rateSpread: bigDecimal;         // difference between avg lender and borrower rates
  matchingEfficiency: bigDecimal;  // percentage of orders matched
};

// Updated matching type for loan orders
export type LoanMatching = {
  loanTasks: LoanTask[];          // grouped loan orders
  feasibility: LoanFeasibility;
  
  // Matched amounts by side
  totalLenderAmount: bigint;
  totalBorrowerAmount: bigint;
  matchedAmount: bigint;
  
  // Rate information
  effectiveRate: bigint;          // weighted average rate for this matching
  maturityTimestamp: bigint;      // agreed maturity date
};

// Keep original PoolKey for potential future use with liquidations
export type PoolKey = {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
};

export const account = privateKeyToAccount(
  process.env.PRIVATE_KEY! as `0x${string}`
);

export const walletClient = createWalletClient({
  chain: process.env.IS_DEV === "true" ? anvil : holesky,
  transport: http(),
  account,
  pollingInterval: 2000,
});

export const publicClient = createPublicClient({
  chain: process.env.IS_DEV === "true" ? anvil : holesky,
  transport: http(),
  pollingInterval: 2000,
});

export const delegationManager = getContract({
  address: deploymentAddresses.eigenlayer.delegation,
  abi: DelegationManagerABI,
  client: { public: publicClient, wallet: walletClient },
});

export const registryContract = getContract({
  address: deploymentAddresses.avs.stakeRegistryProxy,
  abi: StakeRegistryABI,
  client: { public: publicClient, wallet: walletClient },
});

export const avsDirectory = getContract({
  address: deploymentAddresses.eigenlayer.avsDirectory,
  abi: AvsDirectoryABI,
  client: { public: publicClient, wallet: walletClient },
});

// Note: This will need to be updated to DebtOrderServiceManager
export const serviceManager = getContract({
  address: deploymentAddresses.avs.serviceManagerProxy,
  abi: ServiceManagerABI,
  client: { public: publicClient, wallet: walletClient },
});

// Quoter not needed for loan matching - remove or comment out
// export const quoterContract = getContract({
//   address: deploymentAddresses.hook.quoter,
//   abi: QuoterABI,
//   client: { public: publicClient, wallet: walletClient },
// });

// Update to point to DebtHook instead
export const debtHook = getContract({
  address: deploymentAddresses.hook.hook, // TODO: Update to DebtHook address
  abi: HookABI, // TODO: Update to DebtHook ABI
  client: { public: publicClient, wallet: walletClient },
});

// Keep poolManager for potential liquidation monitoring
export const poolManager = getContract({
  address: deploymentAddresses.hook.poolManager,
  abi: PoolManagerABI,
  client: { public: publicClient, wallet: walletClient },
});

// Add DebtOrderBook contract
export const debtOrderBook = getContract({
  address: deploymentAddresses.hook.orderBook || "0x0", // TODO: Add to deployment addresses
  abi: [], // TODO: Add DebtOrderBook ABI
  client: { public: publicClient, wallet: walletClient },
});