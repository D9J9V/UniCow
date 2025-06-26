import { formatEther } from "viem";
import { Mathb } from "./math";
import { LoanTask, LoanFeasibility, LoanMatching, LoanMatchingResult, LoanOrderData } from "./utils";
import bigDecimal from "js-big-decimal";

const RoundingModes = bigDecimal.RoundingModes;

interface LoanTransfer {
  lender: `0x${string}`;
  borrower: `0x${string}`;
  amount: bigint;
  rate: bigint;
  maturityTimestamp: bigint;
}

// Generate all possible combinations of loan tasks for matching
export function generateLoanTaskCombinations(tasks: LoanTask[]): LoanTask[][][] {
  if (tasks.length === 0) return [];
  if (tasks.length === 1) return [[[tasks[0]]]];

  const result: LoanTask[][][] = [];
  const firstTask = tasks[0];
  const restTasks = tasks.slice(1);
  const subCombinations = generateLoanTaskCombinations(restTasks);

  // Add the combination where the first task is separate from the rest
  result.push([[firstTask], restTasks]);

  // Add combinations where the first task is separate
  for (const subComb of subCombinations) {
    result.push([[firstTask], ...subComb]);
  }

  // Add combinations where the first task is combined with others
  for (const subComb of subCombinations) {
    // Combine with the first group
    result.push([
      [firstTask, ...(Array.isArray(subComb[0]) ? subComb[0] : [subComb[0]])],
      ...subComb.slice(1),
    ]);

    // Combine with each subsequent group
    for (let i = 1; i < subComb.length; i++) {
      // @ts-ignore
      result.push([
        ...subComb.slice(0, i),
        [firstTask, ...(Array.isArray(subComb[i]) ? subComb[i] : [subComb[i]])],
        ...subComb.slice(i + 1),
      ]);
    }
  }

  // Remove duplicates
  return removeDuplicates(result);
}

// Check if a combination of loan tasks can be matched
export function isLoanCombinationPossible(combination: LoanTask[][]): boolean {
  for (const matching of combination) {
    if (matching.length == 1) continue;

    // Need at least one lender and one borrower in a matching group
    const lenders = matching.filter(task => task.isLender);
    const borrowers = matching.filter(task => !task.isLender);
    
    if (lenders.length === 0 || borrowers.length === 0) {
      return false;
    }

    // Check if there's rate overlap
    const minLenderRate = Math.min(...lenders.map(l => Number(l.interestRateBips)));
    const maxBorrowerRate = Math.max(...borrowers.map(b => Number(b.interestRateBips)));
    
    if (minLenderRate > maxBorrowerRate) {
      return false; // No rate overlap
    }

    // Check maturity compatibility
    const lenderMaturities = new Set(lenders.map(l => l.maturityTimestamp.toString()));
    const borrowerMaturities = new Set(borrowers.map(b => b.maturityTimestamp.toString()));
    
    const hasCommonMaturity = [...lenderMaturities].some(m => borrowerMaturities.has(m));
    if (!hasCommonMaturity) {
      return false; // No common maturity dates
    }
  }

  return true;
}

// Compute the result of a loan matching combination
export function computeLoanMatchingResult(
  combination: LoanTask[][]
): LoanMatchingResult {
  const result: Partial<LoanMatchingResult> = {};
  const matchings: LoanMatching[] = [];

  // Initialize totals
  let totalLenderAmount = BigInt(0);
  let totalBorrowerAmount = BigInt(0);
  let totalMatchedAmount = BigInt(0);
  let weightedLenderRate = BigInt(0);
  let weightedBorrowerRate = BigInt(0);

  // Process each matching group
  for (const matching of combination) {
    const lenders = matching.filter(task => task.isLender);
    const borrowers = matching.filter(task => !task.isLender);

    // Single task - no matching possible
    if (matching.length === 1) {
      const task = matching[0];
      if (task.isLender) {
        totalLenderAmount += task.principalAmount;
      } else {
        totalBorrowerAmount += task.principalAmount;
      }
      
      matchings.push({
        loanTasks: [task],
        feasibility: LoanFeasibility.NONE,
        totalLenderAmount: task.isLender ? task.principalAmount : BigInt(0),
        totalBorrowerAmount: !task.isLender ? task.principalAmount : BigInt(0),
        matchedAmount: BigInt(0),
        effectiveRate: BigInt(0),
        maturityTimestamp: task.maturityTimestamp,
      });
      continue;
    }

    // Multi-task matching
    let matchingResult: LoanMatching = {
      loanTasks: matching,
      feasibility: LoanFeasibility.NONE,
      totalLenderAmount: BigInt(0),
      totalBorrowerAmount: BigInt(0),
      matchedAmount: BigInt(0),
      effectiveRate: BigInt(0),
      maturityTimestamp: BigInt(0),
    };

    // Calculate available amounts
    let availableLenderAmount = BigInt(0);
    let availableBorrowerAmount = BigInt(0);
    let minLenderRate = BigInt(Number.MAX_SAFE_INTEGER);
    let maxBorrowerRate = BigInt(0);

    for (const lender of lenders) {
      availableLenderAmount += lender.principalAmount;
      minLenderRate = Mathb.min(minLenderRate, lender.interestRateBips);
      matchingResult.totalLenderAmount += lender.principalAmount;
    }

    for (const borrower of borrowers) {
      availableBorrowerAmount += borrower.principalAmount;
      maxBorrowerRate = Mathb.max(maxBorrowerRate, borrower.interestRateBips);
      matchingResult.totalBorrowerAmount += borrower.principalAmount;
    }

    // Check rate compatibility
    if (minLenderRate > maxBorrowerRate) {
      matchingResult.feasibility = LoanFeasibility.NO_RATE_OVERLAP;
      matchings.push(matchingResult);
      continue;
    }

    // Find common maturity
    const commonMaturities = findCommonMaturities(lenders, borrowers);
    if (commonMaturities.length === 0) {
      matchingResult.feasibility = LoanFeasibility.MATURITY_MISMATCH;
      matchings.push(matchingResult);
      continue;
    }

    // Use the earliest common maturity
    matchingResult.maturityTimestamp = commonMaturities[0];

    // Calculate matched amount and effective rate
    const matchedAmountLocal = Mathb.min(availableLenderAmount, availableBorrowerAmount);
    matchingResult.matchedAmount = matchedAmountLocal;

    // Calculate effective rate (weighted average between min lender and max borrower rates)
    // This ensures both sides get a fair rate
    const effectiveRate = (minLenderRate + maxBorrowerRate) / BigInt(2);
    matchingResult.effectiveRate = effectiveRate;

    // Update totals
    totalMatchedAmount += matchedAmountLocal;
    weightedLenderRate += effectiveRate * matchedAmountLocal;
    weightedBorrowerRate += effectiveRate * matchedAmountLocal;

    // Determine feasibility type
    if (availableLenderAmount === availableBorrowerAmount) {
      matchingResult.feasibility = LoanFeasibility.FULL_MATCH;
    } else if (availableLenderAmount > availableBorrowerAmount) {
      matchingResult.feasibility = LoanFeasibility.PARTIAL_LENDER;
    } else {
      matchingResult.feasibility = LoanFeasibility.PARTIAL_BORROWER;
    }

    matchings.push(matchingResult);

    // Update global totals
    totalLenderAmount += matchingResult.totalLenderAmount;
    totalBorrowerAmount += matchingResult.totalBorrowerAmount;
  }

  // Calculate final metrics
  const isResultFeasible = totalMatchedAmount > BigInt(0);
  
  result.matchings = matchings;
  result.totalLenderAmount = totalLenderAmount;
  result.totalBorrowerAmount = totalBorrowerAmount;
  result.totalMatchedAmount = totalMatchedAmount;
  result.unmatchedLenderAmount = totalLenderAmount - totalMatchedAmount;
  result.unmatchedBorrowerAmount = totalBorrowerAmount - totalMatchedAmount;
  
  // Calculate average rates
  if (totalMatchedAmount > BigInt(0)) {
    result.averageLenderRate = new bigDecimal(weightedLenderRate.toString())
      .divide(new bigDecimal(totalMatchedAmount.toString()), 4, RoundingModes.FLOOR);
    result.averageBorrowerRate = result.averageLenderRate; // Same rate for both sides
  } else {
    result.averageLenderRate = new bigDecimal(0);
    result.averageBorrowerRate = new bigDecimal(0);
  }

  result.feasible = isResultFeasible;
  result.feasibilityType = determineFeasibilityType(matchings);
  
  // Calculate rate spread (should be 0 for matched orders)
  result.rateSpread = new bigDecimal(0);
  
  // Calculate matching efficiency
  const totalAmount = totalLenderAmount + totalBorrowerAmount;
  if (totalAmount > BigInt(0)) {
    result.matchingEfficiency = new bigDecimal(totalMatchedAmount.toString())
      .multiply(new bigDecimal("2")) // Multiply by 2 because matched amount counts for both sides
      .divide(new bigDecimal(totalAmount.toString()), 4, RoundingModes.FLOOR);
  } else {
    result.matchingEfficiency = new bigDecimal(0);
  }

  return result as LoanMatchingResult;
}

// Find the best result from multiple possible combinations
export function computeBestLoanResult(possibleResults: LoanMatchingResult[]): LoanMatchingResult {
  let bestResult: LoanMatchingResult | null = null;

  for (const result of possibleResults) {
    if (!result.feasible) continue;

    if (bestResult === null) {
      bestResult = result;
      continue;
    }

    // Optimize for:
    // 1. Maximum matched amount
    // 2. Best matching efficiency
    // 3. Lowest average borrower rate
    
    if (result.totalMatchedAmount > bestResult.totalMatchedAmount) {
      bestResult = result;
    } else if (result.totalMatchedAmount === bestResult.totalMatchedAmount) {
      // If matched amounts are equal, prefer better efficiency
      if (result.matchingEfficiency.compareTo(bestResult.matchingEfficiency) > 0) {
        bestResult = result;
      } else if (result.matchingEfficiency.compareTo(bestResult.matchingEfficiency) === 0) {
        // If efficiency is also equal, prefer lower borrower rate
        if (result.averageBorrowerRate.compareTo(bestResult.averageBorrowerRate) < 0) {
          bestResult = result;
        }
      }
    }
  }

  return bestResult || possibleResults[0];
}

// Compute the loan transfers that need to happen
export function computeLoanTransfers(result: LoanMatchingResult): {
  transfers: LoanTransfer[];
  analysis: Record<string, string>;
} {
  const transfers: LoanTransfer[] = [];
  const analysis: Record<string, string> = {};

  for (const matching of result.matchings) {
    if (matching.feasibility === LoanFeasibility.NONE || 
        matching.feasibility === LoanFeasibility.NO_RATE_OVERLAP ||
        matching.feasibility === LoanFeasibility.MATURITY_MISMATCH) {
      
      for (const task of matching.loanTasks) {
        analysis[task.taskId.toString()] = `Task ${task.taskId} could not be matched: ${matching.feasibility}`;
      }
      continue;
    }

    const lenders = matching.loanTasks.filter(t => t.isLender);
    const borrowers = matching.loanTasks.filter(t => !t.isLender);
    
    // Distribute matched amount proportionally
    let remainingAmount = matching.matchedAmount;
    
    for (const borrower of borrowers) {
      const borrowerShare = matching.totalBorrowerAmount > BigInt(0)
        ? (borrower.principalAmount * matching.matchedAmount) / matching.totalBorrowerAmount
        : BigInt(0);
      
      let borrowerRemaining = borrowerShare;
      
      for (const lender of lenders) {
        if (borrowerRemaining === BigInt(0)) break;
        
        const lenderShare = matching.totalLenderAmount > BigInt(0)
          ? (lender.principalAmount * matching.matchedAmount) / matching.totalLenderAmount
          : BigInt(0);
        
        const transferAmount = Mathb.min(borrowerRemaining, lenderShare);
        
        if (transferAmount > BigInt(0)) {
          transfers.push({
            lender: lender.sender,
            borrower: borrower.sender,
            amount: transferAmount,
            rate: matching.effectiveRate,
            maturityTimestamp: matching.maturityTimestamp,
          });
          
          borrowerRemaining -= transferAmount;
        }
      }
      
      analysis[borrower.taskId.toString()] = `Borrower ${borrower.taskId} matched ${formatEther(borrowerShare)} USDC at ${Number(matching.effectiveRate) / 100}% APR`;
    }
    
    for (const lender of lenders) {
      const lenderShare = matching.totalLenderAmount > BigInt(0)
        ? (lender.principalAmount * matching.matchedAmount) / matching.totalLenderAmount
        : BigInt(0);
      
      analysis[lender.taskId.toString()] = `Lender ${lender.taskId} matched ${formatEther(lenderShare)} USDC at ${Number(matching.effectiveRate) / 100}% APR`;
    }
  }

  return { transfers, analysis };
}

// Helper function to find common maturity dates
function findCommonMaturities(lenders: LoanTask[], borrowers: LoanTask[]): bigint[] {
  const lenderMaturities = new Set(lenders.map(l => l.maturityTimestamp.toString()));
  const borrowerMaturities = new Set(borrowers.map(b => b.maturityTimestamp.toString()));
  
  const common: bigint[] = [];
  for (const maturity of lenderMaturities) {
    if (borrowerMaturities.has(maturity)) {
      common.push(BigInt(maturity));
    }
  }
  
  return common.sort((a, b) => Number(a - b));
}

// Helper function to determine overall feasibility type
function determineFeasibilityType(matchings: LoanMatching[]): LoanFeasibility {
  const hasMatches = matchings.some(m => 
    m.feasibility === LoanFeasibility.FULL_MATCH ||
    m.feasibility === LoanFeasibility.PARTIAL_LENDER ||
    m.feasibility === LoanFeasibility.PARTIAL_BORROWER
  );
  
  if (!hasMatches) {
    return LoanFeasibility.NONE;
  }
  
  const allFull = matchings.every(m => 
    m.feasibility === LoanFeasibility.FULL_MATCH || 
    m.feasibility === LoanFeasibility.NONE
  );
  
  if (allFull) {
    return LoanFeasibility.FULL_MATCH;
  }
  
  const hasPartialLender = matchings.some(m => m.feasibility === LoanFeasibility.PARTIAL_LENDER);
  const hasPartialBorrower = matchings.some(m => m.feasibility === LoanFeasibility.PARTIAL_BORROWER);
  
  if (hasPartialLender && hasPartialBorrower) {
    return LoanFeasibility.PARTIAL_BOTH;
  } else if (hasPartialLender) {
    return LoanFeasibility.PARTIAL_LENDER;
  } else {
    return LoanFeasibility.PARTIAL_BORROWER;
  }
}

// Helper function to remove duplicate combinations
function removeDuplicates(combinations: LoanTask[][][]): LoanTask[][][] {
  const uniqueCombinations = new Set<string>();

  return combinations.filter((combination) => {
    const key = JSON.stringify(
      combination.map((group) => group.map((t) => t.taskId).sort())
    );
    if (!uniqueCombinations.has(key)) {
      uniqueCombinations.add(key);
      return true;
    }
    return false;
  });
}