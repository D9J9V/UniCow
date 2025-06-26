import { parseEventLogs } from "viem";
import { ServiceManagerABI } from "./abis/ServiceManager";
import {
  computeLoanTransfers,
  computeBestLoanResult,
  computeLoanMatchingResult,
  generateLoanTaskCombinations,
  isLoanCombinationPossible,
} from "./matching";
import { registerOperator } from "./register";
import {
  LoanTask,
  LoanMatchingResult,
  account,
  debtHook,
  publicClient,
  serviceManager,
  debtOrderBook,
} from "./utils";

let latestBatchNumber: bigint = BigInt(0);
const MAX_BLOCKS_PER_BATCH = 10; // Process loan orders every 10 blocks
const batches: Record<string, LoanTask[]> = {};

// Group orders by maturity for better matching
const groupByMaturity = (tasks: LoanTask[]): Map<string, LoanTask[]> => {
  const groups = new Map<string, LoanTask[]>();
  
  for (const task of tasks) {
    const maturityKey = task.maturityTimestamp.toString();
    if (!groups.has(maturityKey)) {
      groups.set(maturityKey, []);
    }
    groups.get(maturityKey)!.push(task);
  }
  
  return groups;
};

const startMonitoring = async () => {
  // Watch for new loan orders created in the ServiceManager
  const unwatchTasks = serviceManager.watchEvent.NewLoanOrderCreated(
    {},
    {
      onLogs: async (logs) => {
        const parsedLogs = parseEventLogs({
          logs: logs,
          abi: ServiceManagerABI,
          eventName: "NewLoanOrderCreated", // TODO: Update event name in ABI
        });

        for (const event of parsedLogs) {
          const orderData = event.args.order;
          
          // Create LoanTask from event data
          const task: LoanTask = {
            isLender: orderData.isLender,
            principalAmount: orderData.principalAmount,
            interestRateBips: orderData.interestRateBips,
            maturityTimestamp: orderData.maturityTimestamp,
            collateralRequired: orderData.collateralRequired,
            sender: orderData.sender,
            orderId: orderData.orderId,
            orderData: {
              token: orderData.token,
              minPrincipal: orderData.minPrincipal,
              maxPrincipal: orderData.maxPrincipal,
              minRate: orderData.minRate,
              maxRate: orderData.maxRate,
              maturityOptions: [orderData.maturityTimestamp], // Simplified for now
              collateralRatio: orderData.collateralRatio || BigInt(15000), // 150%
              expiry: orderData.expiry,
              nonce: orderData.nonce,
            },
            taskCreatedBlock: Number(event.blockNumber),
            taskId: Number(orderData.taskId),
            matchedAmount: null,
            effectiveRate: null,
          };

          // Add to current batch
          if (!batches[latestBatchNumber.toString()]) {
            batches[latestBatchNumber.toString()] = [];
          }
          batches[latestBatchNumber.toString()].push(task);
          
          console.log("Loan order added to batch:", {
            taskId: task.taskId,
            isLender: task.isLender,
            amount: task.principalAmount.toString(),
            rate: Number(task.interestRateBips) / 100 + "%",
            maturity: new Date(Number(task.maturityTimestamp) * 1000).toISOString(),
          });
        }
      },
    }
  );

  // Process batches every N blocks
  const unwatchBlocks = publicClient.watchBlockNumber({
    onBlockNumber: (blockNumber) => {
      console.log("Block number:", blockNumber);
      
      if (latestBatchNumber === BigInt(0)) {
        console.log("First batch created at block:", blockNumber);
        latestBatchNumber = blockNumber;
      } else if (blockNumber - latestBatchNumber >= MAX_BLOCKS_PER_BATCH) {
        // Process the batch
        processBatch(latestBatchNumber);
        // Create a new batch
        latestBatchNumber = blockNumber;
        console.log("New batch created at block:", latestBatchNumber);
      }
    },
  });

  return { unwatchTasks, unwatchBlocks };
};

const processBatch = async (batchNumber: bigint) => {
  const tasks = batches[batchNumber.toString()];
  if (!tasks || tasks.length === 0) {
    console.log("No tasks in batch", batchNumber);
    return;
  }

  console.log(`Processing batch ${batchNumber} with ${tasks.length} loan orders`);

  // Group tasks by maturity for better matching
  const maturityGroups = groupByMaturity(tasks);
  
  let allTransfers: any[] = [];
  let allMatchedTasks: LoanTask[] = [];

  // Process each maturity group separately
  for (const [maturity, groupTasks] of maturityGroups) {
    console.log(`Processing ${groupTasks.length} orders for maturity ${new Date(Number(maturity) * 1000).toISOString()}`);
    
    // Generate all possible combinations for this maturity group
    const allCombinations = generateLoanTaskCombinations(groupTasks);
    const possibleCombinations = allCombinations.filter(isLoanCombinationPossible);
    
    if (possibleCombinations.length === 0) {
      console.log("No valid combinations found for maturity", maturity);
      continue;
    }

    // Compute results for all possible combinations
    const allResults: LoanMatchingResult[] = [];
    for (const combination of possibleCombinations) {
      const result = computeLoanMatchingResult(combination);
      if (result.feasible) {
        allResults.push(result);
      }
    }

    if (allResults.length === 0) {
      console.log("No feasible matches found for maturity", maturity);
      continue;
    }

    // Find the best matching result
    const bestResult = computeBestLoanResult(allResults);
    console.log("Best result for maturity", maturity, {
      totalMatched: bestResult.totalMatchedAmount.toString(),
      avgRate: bestResult.averageBorrowerRate.getValue() + "%",
      efficiency: bestResult.matchingEfficiency.getValue(),
    });

    // Compute the actual transfers needed
    const { transfers, analysis } = computeLoanTransfers(bestResult);
    console.log("Matching analysis:", analysis);
    
    // Collect transfers and matched tasks
    allTransfers.push(...transfers);
    for (const matching of bestResult.matchings) {
      allMatchedTasks.push(...matching.loanTasks);
    }
  }

  // If we have matches, submit them to the ServiceManager
  if (allTransfers.length > 0) {
    try {
      // Get reference task IDs for the response
      const referenceTaskIds = allMatchedTasks.map(t => t.taskId);
      
      // Create loan match data structure for on-chain submission
      const loanMatches = allTransfers.map(transfer => ({
        lender: transfer.lender,
        borrower: transfer.borrower,
        principalAmount: transfer.amount,
        interestRateBips: transfer.rate,
        maturityTimestamp: transfer.maturityTimestamp,
      }));

      // Get message hash for signing
      const messageHash = await serviceManager.read.getLoanBatchHash([
        batchNumber,
        loanMatches,
      ]);

      // Sign the message
      const signature = await account.sign({
        hash: messageHash,
      });

      console.log("Submitting loan matches to ServiceManager...");
      
      // Submit the batch response
      const txHash = await serviceManager.write.respondToLoanBatch([
        allMatchedTasks,
        referenceTaskIds,
        loanMatches,
        signature,
      ]);

      // Wait for confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });
      
      console.log("Loan batch successfully submitted!", {
        txHash,
        gasUsed: receipt.gasUsed.toString(),
        matchCount: allTransfers.length,
      });

    } catch (error) {
      console.error("Error submitting loan batch:", error);
    }
  } else {
    console.log("No matches found in batch", batchNumber);
  }

  // Clean up processed batch
  delete batches[batchNumber.toString()];
};

// Main operator function
async function main() {
  console.log("Starting DebtHook loan matching operator...");
  console.log("Operator address:", account.address);
  
  // Register as an operator if not already registered
  await registerOperator();
  
  // Start monitoring for loan orders
  const { unwatchTasks, unwatchBlocks } = await startMonitoring();
  
  console.log("Operator is now monitoring for loan orders...");
  
  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("Shutting down operator...");
    unwatchTasks();
    unwatchBlocks();
    process.exit(0);
  });
}

// Error handling
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exitCode = 1;
});