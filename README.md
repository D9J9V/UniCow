# UniCow Integration with DebtHook Protocol

## ✅ DEPLOYED (June 26, 2025)

The EigenLayer AVS for decentralized order matching is now live:
- **ServiceManager**: `0x3333Bc77EdF180D81ff911d439F02Db9e34e8603` (Ethereum Sepolia)
- **Operator**: `0x2f131a86C5CB54685f0E940B920c54E152a44B02` (Authorized on DebtHook)

## Overview

This repository serves as the foundation for DebtHook's Phase C implementation: a decentralized, EigenLayer-secured order matching system. We've chosen UniCow as our base because it provides a sophisticated Coincidence of Wants (CoW) matching algorithm that can be adapted from swap matching to debt order matching.

## Why UniCow for DebtHook?

### The Problem We're Solving

Currently, DebtHook uses Supabase for off-chain order management, which has several limitations:
- **Centralization Risk**: Single point of failure
- **No Optimization**: Orders are matched first-come, first-served
- **Trust Issues**: Users must trust the centralized database
- **Inefficiency**: Each order executes separately, increasing gas costs

### Why CoW for Debt Orders (Not Liquidations)

We specifically chose to implement CoW for **debt order matching** rather than liquidations because:

1. **Natural Market Making Opportunity**
   - Lenders want to lend USDC at the highest rate
   - Borrowers want to borrow USDC at the lowest rate
   - These opposing desires create perfect matching opportunities

2. **Liquidations Are Already Efficient**
   - DebtHook's liquidations execute atomically within Uniswap v4 swaps
   - The beforeSwap/afterSwap hook pattern provides MEV protection
   - Adding CoW to liquidations would complicate without clear benefit

3. **Order Matching Benefits from Batching**
   - Users expect some delay when placing limit orders
   - Batching multiple orders reduces gas costs significantly
   - Better rates can be achieved through optimal matching

## What We're Building

### From UniCow's Swap Matching...
```typescript
// UniCow matches opposite swap directions
Task {
  zeroForOne: true,    // Swap token0 for token1
  amountSpecified: 1000,
  sqrtPriceLimitX96: ...,
}
```

### ...To DebtHook's Loan Matching
```typescript
// We match lenders with borrowers
LoanTask {
  isLender: true,      // Offering USDC to lend
  principalAmount: 10000,
  interestRateBips: 500,  // 5% APR
  maturityTimestamp: ...,
}
```

## How It Differs from Original UniCow

| Feature | UniCow (Original) | DebtHook Integration |
|---------|-------------------|---------------------|
| **Matching Type** | Token swaps | Loan orders |
| **Optimization Goal** | Maximize output tokens | Optimize interest rates |
| **Constraints** | Price limits (sqrtPriceLimitX96) | Rate limits, collateral ratios |
| **Settlement** | Immediate token transfers | Loan creation with collateral |
| **Time Dimension** | Instant execution | Maturity dates consideration |

## Integration Architecture

### 1. **Order Creation Flow**
```
User → Signs EIP-712 Order → EigenLayer Operators → Order Validation → Order Pool
```

### 2. **Matching Process**
```
Operators → Fetch Pending Orders → Run CoW Algorithm → Submit Matches → On-chain Verification
```

### 3. **Execution Flow**
```
Verified Matches → Batch Transaction → Create Multiple Loans → Update DebtHook State
```

## Benefits of This Approach

### For the Protocol
1. **Decentralization**: No single point of failure
2. **Efficiency**: Batch execution saves gas
3. **Transparency**: All matching logic is verifiable
4. **Security**: EigenLayer operators stake assets

### For Users
1. **Better Rates**: Optimal matching improves rates for everyone
2. **Lower Costs**: Gas costs shared across batch
3. **Trust**: Cryptographic proofs ensure fair matching
4. **Flexibility**: Partial order fills possible

## Example Matching Scenario

### Input Orders
```
Lenders:
- Alice: 10,000 USDC @ 5% APR
- Bob: 20,000 USDC @ 6% APR
- Carol: 5,000 USDC @ 4% APR

Borrowers:
- Dave: wants 15,000 USDC (max 5.5% APR)
- Eve: wants 20,000 USDC (max 6% APR)
```

### CoW Matching Result
```
Dave receives:
- 5,000 from Carol @ 4%
- 10,000 from Alice @ 5%
- Average rate: 4.67% APR ✓

Eve receives:
- 20,000 from Bob @ 6% ✓

Result: Everyone gets optimal rates!
```

## Technical Implementation Plan

### Phase 1: Adapt Core Matching Logic
- Modify task structure for loan parameters
- Update feasibility checks for lending constraints
- Implement rate-based optimization

### Phase 2: EigenLayer Integration
- Deploy ServiceManager for loan orders
- Implement operator submission logic
- Add slashing conditions for malicious behavior

### Phase 3: Smart Contract Integration
- Create batch loan creation function
- Implement order verification on-chain
- Add settlement mechanics

### Phase 4: Production Deployment
- Security audits
- Operator onboarding
- Mainnet deployment

## Why This Makes Sense

1. **Leverages Existing Innovation**: UniCow's matching algorithm is sophisticated and battle-tested
2. **Natural Fit**: Debt orders have opposing market sides just like token swaps
3. **Clear Value Add**: Users get better rates, protocol gets decentralization
4. **Maintains Simplicity**: Liquidations stay atomic and efficient through existing hooks

## Getting Started

To understand the codebase:
1. Review `/hook` - The Uniswap v4 hook implementation
2. Study `/operator/matching.ts` - The CoW matching algorithm
3. Examine `/avs` - The EigenLayer service manager

To adapt for DebtHook:
1. Replace swap tasks with loan tasks
2. Modify optimization goals from token output to interest rates
3. Add loan-specific constraints (collateral ratios, maturity dates)
4. Implement batch loan creation in DebtHook contract

## Conclusion

UniCow provides the perfect foundation for creating a decentralized, efficient order matching system for DebtHook. By focusing on debt order matching rather than liquidations, we leverage CoW where it provides the most value while maintaining the protocol's existing efficient liquidation mechanism.