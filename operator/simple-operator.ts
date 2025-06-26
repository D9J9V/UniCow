import { createPublicClient, createWalletClient, http, parseEventLogs, getContract } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import * as dotenv from "dotenv";

dotenv.config();

// Custom Unichain Sepolia chain
const unichainSepolia = {
  id: 1301,
  name: "Unichain Sepolia",
  network: "unichain-sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://sepolia.unichain.org"] },
    public: { http: ["https://sepolia.unichain.org"] },
  },
  blockExplorers: {
    default: { name: "Uniscan", url: "https://sepolia.uniscan.xyz" },
  },
};

// ABIs (simplified)
const SERVICE_MANAGER_ABI = [
  {
    name: "NewLoanOrderCreated",
    type: "event",
    inputs: [
      { indexed: true, name: "taskIndex", type: "uint32" },
      { name: "task", type: "tuple", components: [
        { name: "isLender", type: "bool" },
        { name: "principalAmount", type: "uint256" },
        { name: "interestRateBips", type: "uint256" },
        { name: "maturityTimestamp", type: "uint256" },
        { name: "sender", type: "address" },
      ]}
    ]
  },
  {
    name: "respondToLoanBatch",
    type: "function",
    inputs: [
      { name: "tasks", type: "tuple[]" },
      { name: "referenceTaskIndices", type: "uint32[]" },
      { name: "matches", type: "tuple[]" },
      { name: "signature", type: "bytes" }
    ],
  }
];

async function main() {
  console.log("🚀 Starting Simple DebtHook Operator...");
  
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  console.log("Operator address:", account.address);

  // Client for Ethereum Sepolia (ServiceManager)
  const ethereumClient = createPublicClient({
    chain: sepolia,
    transport: http(process.env.ETHEREUM_RPC_URL),
  });

  // Client for Unichain Sepolia (DebtHook execution)
  const unichainClient = createPublicClient({
    chain: unichainSepolia,
    transport: http(process.env.UNICHAIN_RPC_URL),
  });

  const serviceManagerAddress = process.env.SERVICE_MANAGER_ADDRESS as `0x${string}`;
  console.log("Monitoring ServiceManager at:", serviceManagerAddress);

  // Simple order storage
  const pendingOrders: any[] = [];
  let currentBlock = await ethereumClient.getBlockNumber();

  // Watch for new loan orders
  console.log("👀 Watching for new loan orders...");
  
  // Poll for events every 5 seconds
  setInterval(async () => {
    try {
      const latestBlock = await ethereumClient.getBlockNumber();
      
      if (latestBlock > currentBlock) {
        console.log(`Checking blocks ${currentBlock} to ${latestBlock}...`);
        
        // Get events (simplified - in production use proper event filtering)
        const logs = await ethereumClient.getLogs({
          address: serviceManagerAddress,
          fromBlock: currentBlock + 1n,
          toBlock: latestBlock,
        });

        if (logs.length > 0) {
          console.log(`Found ${logs.length} new events!`);
          // Process events here
          pendingOrders.push(...logs);
        }

        // Simple matching every 10 blocks
        if (latestBlock - currentBlock >= 10n) {
          console.log("🔄 Processing batch...");
          
          if (pendingOrders.length >= 2) {
            // Find a simple match (lender + borrower)
            const lenderOrder = pendingOrders.find(o => o.isLender);
            const borrowerOrder = pendingOrders.find(o => !o.isLender);
            
            if (lenderOrder && borrowerOrder) {
              console.log("✅ Found match! Lender and borrower orders");
              console.log("TODO: Submit to ServiceManager.respondToLoanBatch()");
              
              // Clear processed orders
              pendingOrders.length = 0;
            }
          }
        }
        
        currentBlock = latestBlock;
      }
    } catch (error) {
      console.error("Error in monitoring loop:", error);
    }
  }, 5000);

  console.log("Operator is running! Submit orders to see matching in action.");
}

main().catch(console.error);