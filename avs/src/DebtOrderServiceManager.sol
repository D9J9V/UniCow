// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@eigenlayer/contracts/libraries/BytesLib.sol";
import "@eigenlayer/contracts/core/DelegationManager.sol";
import {ECDSAServiceManagerBase} from "@eigenlayer-middleware/src/unaudited/ECDSAServiceManagerBase.sol";
import "@eigenlayer-middleware/src/unaudited/ECDSAStakeRegistry.sol";
import "@openzeppelin-upgrades/contracts/utils/cryptography/ECDSAUpgradeable.sol";
import "@eigenlayer/contracts/permissions/Pausable.sol";
import {IRegistryCoordinator} from "@eigenlayer-middleware/src/interfaces/IRegistryCoordinator.sol";

interface IDebtHook {
    struct LoanMatch {
        address lender;
        address borrower;
        uint256 principalAmount;
        uint256 interestRateBips;
        uint256 maturityTimestamp;
    }
    
    function createBatchLoans(
        LoanMatch[] calldata matches,
        bytes calldata operatorProof
    ) external;
}

interface IDebtOrderBook {
    struct LoanLimitOrder {
        address lender;
        address token;
        uint256 principalAmount;
        uint256 collateralRequired;
        uint32 interestRateBips;
        uint64 maturityTimestamp;
        uint64 expiry;
        uint256 nonce;
    }
}

contract DebtOrderServiceManager is ECDSAServiceManagerBase, Pausable {
    using BytesLib for bytes;
    using ECDSAUpgradeable for bytes32;

    uint32 public latestTaskNum;
    address public debtHook;
    address public debtOrderBook;
    
    // Track all loan order tasks
    mapping(uint32 => bytes32) public allTaskHashes;
    mapping(uint32 => bytes) public allTaskResponses;
    
    // Track batches for processing
    mapping(uint256 => LoanOrderBatch) public batches;
    uint256 public currentBatchId;
    
    event NewLoanOrderCreated(uint32 indexed taskIndex, LoanOrderTask task);
    event LoanBatchResponse(uint32[] indexed referenceTaskIndices, address operator);
    event BatchExecuted(uint256 indexed batchId, uint256 matchCount);
    
    modifier onlyOperator() {
        require(
            ECDSAStakeRegistry(stakeRegistry).operatorRegistered(msg.sender),
            "Only operator can call this function"
        );
        _;
    }
    
    modifier onlyAuthorized() {
        require(
            msg.sender == debtHook || msg.sender == debtOrderBook,
            "Only authorized contracts can call this function"
        );
        _;
    }
    
    struct LoanOrderTask {
        bool isLender;
        uint256 principalAmount;
        uint256 interestRateBips;
        uint256 maturityTimestamp;
        uint256 collateralRequired;
        address sender;
        bytes32 orderId;
        uint32 taskCreatedBlock;
        uint32 taskId;
        
        // Order constraints
        uint256 minPrincipal;
        uint256 maxPrincipal;
        uint256 minRate;
        uint256 maxRate;
        uint256 expiry;
    }
    
    struct LoanOrderBatch {
        uint256 blockNumber;
        bytes32 batchRoot;
        bool executed;
        address operator;
    }
    
    constructor(
        address _avsDirectory,
        address _stakeRegistry,
        address _delegationManager
    )
        ECDSAServiceManagerBase(
            _avsDirectory,
            _stakeRegistry,
            address(0), // No payment coordinator for now
            _delegationManager
        )
    {}
    
    /**
     * @notice Creates a new loan order task that operators will match
     * @dev Called by DebtOrderBook when users submit signed orders
     */
    function createLoanOrder(
        bool isLender,
        uint256 principalAmount,
        uint256 interestRateBips,
        uint256 maturityTimestamp,
        uint256 collateralRequired,
        address sender,
        uint256 minPrincipal,
        uint256 maxPrincipal,
        uint256 minRate,
        uint256 maxRate,
        uint256 expiry
    ) external onlyAuthorized {
        require(expiry > block.timestamp, "Order expired");
        require(principalAmount >= minPrincipal && principalAmount <= maxPrincipal, "Invalid principal amount");
        
        LoanOrderTask memory task = LoanOrderTask({
            isLender: isLender,
            principalAmount: principalAmount,
            interestRateBips: interestRateBips,
            maturityTimestamp: maturityTimestamp,
            collateralRequired: collateralRequired,
            sender: sender,
            orderId: keccak256(abi.encode(sender, latestTaskNum, block.timestamp)),
            taskCreatedBlock: uint32(block.number),
            taskId: latestTaskNum,
            minPrincipal: minPrincipal,
            maxPrincipal: maxPrincipal,
            minRate: minRate,
            maxRate: maxRate,
            expiry: expiry
        });
        
        allTaskHashes[latestTaskNum] = keccak256(abi.encode(task));
        emit NewLoanOrderCreated(latestTaskNum, task);
        latestTaskNum++;
    }
    
    /**
     * @notice Operators submit matched loan orders
     * @dev Validates matches and triggers batch loan creation in DebtHook
     */
    function respondToLoanBatch(
        LoanOrderTask[] calldata tasks,
        uint32[] memory referenceTaskIndices,
        IDebtHook.LoanMatch[] memory matches,
        bytes calldata signature
    ) external onlyOperator {
        require(
            operatorHasMinimumWeight(msg.sender),
            "Operator does not meet minimum weight"
        );
        
        // Validate all tasks exist and haven't been responded to
        for (uint256 i = 0; i < referenceTaskIndices.length; i++) {
            require(
                keccak256(abi.encode(tasks[i])) == allTaskHashes[referenceTaskIndices[i]],
                "Task not found"
            );
            require(
                allTaskResponses[referenceTaskIndices[i]].length == 0,
                "Task already responded"
            );
            require(
                tasks[i].expiry > block.timestamp,
                "Order expired"
            );
        }
        
        // Validate signature
        bytes32 messageHash = getLoanBatchHash(currentBatchId, matches);
        address signer = ECDSAUpgradeable.recover(messageHash, signature);
        require(signer == msg.sender, "Invalid signature");
        
        // Validate matches are valid
        validateMatches(tasks, matches);
        
        // Mark tasks as responded
        for (uint256 i = 0; i < referenceTaskIndices.length; i++) {
            allTaskResponses[referenceTaskIndices[i]] = signature;
        }
        
        // Store batch info
        batches[currentBatchId] = LoanOrderBatch({
            blockNumber: block.number,
            batchRoot: keccak256(abi.encode(matches)),
            executed: false,
            operator: msg.sender
        });
        
        // Execute batch loans in DebtHook
        IDebtHook(debtHook).createBatchLoans(matches, signature);
        
        batches[currentBatchId].executed = true;
        emit BatchExecuted(currentBatchId, matches.length);
        emit LoanBatchResponse(referenceTaskIndices, msg.sender);
        
        currentBatchId++;
    }
    
    /**
     * @notice Validates that loan matches are compatible
     */
    function validateMatches(
        LoanOrderTask[] calldata tasks,
        IDebtHook.LoanMatch[] memory matches
    ) internal pure {
        // Track matched amounts per task
        mapping(uint32 => uint256) memory matchedAmounts;
        
        for (uint256 i = 0; i < matches.length; i++) {
            IDebtHook.LoanMatch memory match = matches[i];
            
            // Find corresponding lender and borrower tasks
            bool foundLender = false;
            bool foundBorrower = false;
            
            for (uint256 j = 0; j < tasks.length; j++) {
                if (tasks[j].sender == match.lender && tasks[j].isLender) {
                    // Validate lender constraints
                    require(match.interestRateBips >= tasks[j].minRate, "Rate below lender minimum");
                    require(match.maturityTimestamp == tasks[j].maturityTimestamp, "Maturity mismatch");
                    matchedAmounts[tasks[j].taskId] += match.principalAmount;
                    require(matchedAmounts[tasks[j].taskId] <= tasks[j].maxPrincipal, "Exceeds lender max");
                    foundLender = true;
                }
                
                if (tasks[j].sender == match.borrower && !tasks[j].isLender) {
                    // Validate borrower constraints
                    require(match.interestRateBips <= tasks[j].maxRate, "Rate above borrower maximum");
                    require(match.maturityTimestamp == tasks[j].maturityTimestamp, "Maturity mismatch");
                    matchedAmounts[tasks[j].taskId] += match.principalAmount;
                    require(matchedAmounts[tasks[j].taskId] <= tasks[j].maxPrincipal, "Exceeds borrower max");
                    foundBorrower = true;
                }
            }
            
            require(foundLender && foundBorrower, "Invalid match participants");
        }
    }
    
    /**
     * @notice Get message hash for loan batch signing
     */
    function getLoanBatchHash(
        uint256 batchId,
        IDebtHook.LoanMatch[] memory matches
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(batchId, matches));
    }
    
    /**
     * @notice Check if operator meets minimum weight requirement
     */
    function operatorHasMinimumWeight(address operator) public view returns (bool) {
        return ECDSAStakeRegistry(stakeRegistry).getOperatorWeight(operator) >= 
               ECDSAStakeRegistry(stakeRegistry).minimumWeight();
    }
    
    /**
     * @notice Set DebtHook contract address
     */
    function setDebtHook(address _debtHook) external onlyOwner {
        require(_debtHook != address(0), "Invalid address");
        debtHook = _debtHook;
    }
    
    /**
     * @notice Set DebtOrderBook contract address
     */
    function setDebtOrderBook(address _debtOrderBook) external onlyOwner {
        require(_debtOrderBook != address(0), "Invalid address");
        debtOrderBook = _debtOrderBook;
    }
    
    /**
     * @notice Get task details by ID
     */
    function getTask(uint32 taskId) external view returns (bytes32) {
        return allTaskHashes[taskId];
    }
    
    /**
     * @notice Check if a task has been responded to
     */
    function isTaskResponded(uint32 taskId) external view returns (bool) {
        return allTaskResponses[taskId].length > 0;
    }
}