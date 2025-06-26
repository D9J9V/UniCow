#!/bin/bash

# Script to deploy DebtOrderServiceManager to Ethereum Sepolia

echo "Deploying DebtOrderServiceManager to Ethereum Sepolia..."

# Navigate to AVS directory
cd unicow/avs

# Install dependencies if needed
forge install

# Build contracts
forge build

# Deploy to Ethereum Sepolia
forge script script/DeployToSepolia.s.sol:DeployToSepolia \
  --rpc-url $ETHEREUM_SEPOLIA_RPC \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  -vvvv

echo "Deployment complete!"