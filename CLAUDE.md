# UniCow Integration with DebtHook Protocol - Developer Guide

## Overview

This guide provides implementation details for integrating UniCow's Coincidence of Wants (CoW) functionality into DebtHook's debt order matching system. UniCow serves as the foundation for Phase C of DebtHook development, enabling decentralized order matching secured by EigenLayer.

## Core Concept: Debt Order Matching

UniCow's CoW matching algorithm is adapted specifically for matching debt orders (NOT liquidations):

- **Lender Orders**: Users offering USDC to lend at specific interest rates
- **Borrower Orders**: Users seeking USDC loans at acceptable rates
- **Optimization Goal**: Find optimal matches that benefit both parties
- **Batch Execution**: Multiple matches execute in a single transaction

## Why Debt Orders, Not Liquidations?

**Important**: We focus on debt order matching because:
1. **Natural Fit**: Lenders and borrowers have opposing market desires
2. **Liquidations Already Efficient**: DebtHook's atomic liquidations via hooks are already optimal
3. **Clear Value Add**: Order matching provides better rates and gas savings

See `README.md` for detailed rationale.

## Technical Architecture

### 1. **Order Structure Adaptation**

Transform UniCow's swap tasks to loan tasks:

```typescript
// Original UniCow Task
interface Task {
  zeroForOne: boolean;
  amountSpecified: bigint;
  sqrtPriceLimitX96: bigint;
  sender: Address;
}

// DebtHook Loan Task
interface LoanTask {
  isLender: boolean;        // replaces zeroForOne
  principalAmount: bigint;  // replaces amountSpecified
  interestRateBips: bigint; // replaces sqrtPriceLimitX96
  maturityTimestamp: bigint;
  collateralRequired?: bigint; // for borrower orders
  sender: Address;
}
```

### 2. **Matching Algorithm Modifications**

Key changes to `operator/matching.ts`:

```typescript
// Feasibility check for loan matching
function isLoanCombinationPossible(combination: LoanTask[][]): boolean {
  for (const matching of combination) {
    if (matching.length == 1) continue;
    
    // Need at least one lender and one borrower
    const lenders = matching.filter(task => task.isLender);
    const borrowers = matching.filter(task => !task.isLender);
    
    if (lenders.length === 0 || borrowers.length === 0) {
      return false;
    }
    
    // Check rate compatibility
    const minLenderRate = Math.min(...lenders.map(l => l.interestRateBips));
    const maxBorrowerRate = Math.max(...borrowers.map(b => b.interestRateBips));
    
    if (minLenderRate > maxBorrowerRate) {
      return false; // No overlap in acceptable rates
    }
  }
  return true;
}

// Optimization goal: minimize average borrowing rate
function computeBestLoanResult(possibleResults: LoanResult[]): LoanResult {
  return possibleResults.reduce((best, current) => {
    if (current.averageBorrowingRate < best.averageBorrowingRate) {
      return current;
    }
    return best;
  });
}
```

### 3. **Service Manager Adaptation**

Modify `UniCowServiceManager.sol` for loan orders:

```solidity
contract DebtOrderServiceManager is UniCowServiceManager {
    struct LoanBatch {
        LoanTask[] tasks;
        uint256 blockNumber;
        bytes32 batchRoot;
    }
    
    mapping(uint256 => LoanBatch) public loanBatches;
    
    function createLoanTask(
        bool isLender,
        uint256 principalAmount,
        uint256 interestRateBips,
        uint256 maturityTimestamp,
        bytes calldata orderData
    ) external {
        // Validate order signature
        // Add to current batch
        // Emit event for operators
    }
    
    function respondToLoanBatch(
        uint256 batchId,
        LoanMatch[] calldata matches
    ) external onlyOperator {
        // Verify operator eligibility
        // Validate matching logic
        // Store results for execution
    }
}
```

### 4. **DebtHook Integration**

Add batch loan creation to `DebtHook.sol`:

```solidity
contract DebtHook is BaseHook {
    // Existing functions...
    
    function createBatchLoans(
        LoanMatch[] calldata matches,
        bytes calldata operatorProof
    ) external {
        // Verify proof from ServiceManager
        require(serviceManager.verifyBatch(matches, operatorProof));
        
        for (uint i = 0; i < matches.length; i++) {
            LoanMatch memory match = matches[i];
            
            // Transfer USDC from lenders
            for (uint j = 0; j < match.lenders.length; j++) {
                usdc.transferFrom(
                    match.lenders[j].address,
                    address(this),
                    match.lenders[j].amount
                );
            }
            
            // Create loans for borrowers
            for (uint k = 0; k < match.borrowers.length; k++) {
                _createLoan(
                    match.borrowers[k],
                    match.effectiveRate,
                    match.maturityTimestamp
                );
            }
        }
    }
}
```

## Implementation Steps

### Step 1: Fork and Modify UniCow

1. **Update Task Structure** (`operator/utils.ts`):
   - Replace swap-specific fields with loan fields
   - Add maturity and collateral parameters

2. **Adapt Matching Algorithm** (`operator/matching.ts`):
   - Change feasibility checks for loan compatibility
   - Optimize for interest rates instead of token output
   - Handle partial order fills

3. **Modify Operator Logic** (`operator/index.ts`):
   - Listen for loan order events
   - Process loan batches instead of swap batches
   - Submit loan matches to ServiceManager

### Step 2: Smart Contract Changes

1. **Create DebtOrderServiceManager**:
   - Inherit from UniCowServiceManager
   - Add loan-specific validation
   - Implement batch verification

2. **Update DebtHook**:
   - Add `createBatchLoans` function
   - Integrate with ServiceManager
   - Maintain existing liquidation logic

3. **Modify DebtOrderBook**:
   - Add EigenLayer order submission
   - Keep EIP-712 signatures
   - Route to ServiceManager

### Step 3: Operator Development

```typescript
// Example operator implementation
class DebtOrderOperator {
  async processLoanBatch(batchId: number) {
    // 1. Fetch loan orders from ServiceManager
    const orders = await this.fetchLoanOrders(batchId);
    
    // 2. Convert to LoanTask format
    const tasks = orders.map(order => ({
      isLender: order.isLender,
      principalAmount: order.amount,
      interestRateBips: order.rate,
      maturityTimestamp: order.maturity,
      sender: order.sender
    }));
    
    // 3. Run matching algorithm
    const combinations = generateLoanCombinations(tasks);
    const feasible = combinations.filter(isLoanCombinationPossible);
    const results = feasible.map(computeLoanResult);
    const best = computeBestLoanResult(results);
    
    // 4. Submit to ServiceManager
    await this.submitLoanMatches(batchId, best);
  }
}
```

## Security Considerations

### 1. **Order Validation**
- Verify EIP-712 signatures
- Check order expiry timestamps
- Validate rate bounds and amounts
- Prevent order replay attacks

### 2. **Matching Security**
- Operators must stake via EigenLayer
- Multiple operators verify each batch
- On-chain verification of matches
- Slashing for invalid matches

### 3. **Economic Attacks**
- Rate manipulation: Require minimum order sizes
- Griefing: Charge small fees for order placement
- Front-running: Batch processing prevents MEV

## Testing Strategy

1. **Unit Tests**:
   - Matching algorithm correctness
   - Edge cases (no matches, partial fills)
   - Rate optimization logic

2. **Integration Tests**:
   - End-to-end order flow
   - Multiple operator scenarios
   - Batch execution gas costs

3. **Fork Tests**:
   - Deploy on testnet
   - Run operator network
   - Simulate real order flow

## Key Differences from UniCow

| Component | UniCow | DebtHook Adaptation |
|-----------|--------|--------------------|
| **Task Type** | Swap (token exchange) | Loan (principal + interest) |
| **Matching Goal** | Maximize output tokens | Optimize interest rates |
| **Time Factor** | Immediate execution | Maturity dates matter |
| **Settlement** | Token transfers | Loan creation with collateral |
| **Constraints** | Price limits | Rate limits, collateral ratios |

## Development Checklist

- [ ] Fork UniCow repository
- [ ] Modify task structures for loans
- [ ] Adapt matching algorithm
- [ ] Create DebtOrderServiceManager
- [ ] Implement batch loan creation
- [ ] Deploy operator infrastructure
- [ ] Test with real order flow
- [ ] Security audit
- [ ] Production deployment

## Resources

- UniCow original code: `/hook`, `/avs`, `/operator`
- DebtHook contracts: `../blockchain/src/`
- Matching algorithm: `/operator/matching.ts`
- EigenLayer docs: [eigenlayer.xyz/docs](https://eigenlayer.xyz/docs)

## Summary

This integration creates a decentralized, efficient order matching system for DebtHook by:
1. Adapting UniCow's CoW algorithm for debt orders
2. Leveraging EigenLayer for security
3. Focusing on order matching (not liquidations)
4. Providing better rates through optimal matching

The result is a sophisticated lending protocol that combines the efficiency of order books with the security of decentralized validation.