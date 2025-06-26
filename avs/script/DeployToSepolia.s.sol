// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import "@eigenlayer/contracts/permissions/PauserRegistry.sol";
import {IDelegationManager} from "@eigenlayer/contracts/interfaces/IDelegationManager.sol";
import {IAVSDirectory} from "@eigenlayer/contracts/interfaces/IAVSDirectory.sol";
import {IStrategyManager, IStrategy} from "@eigenlayer/contracts/interfaces/IStrategyManager.sol";
import "@eigenlayer/test/mocks/EmptyContract.sol";

import {ECDSAStakeRegistry} from "@eigenlayer-middleware/src/unaudited/ECDSAStakeRegistry.sol";
import {Quorum, StrategyParams} from "@eigenlayer-middleware/src/interfaces/IECDSAStakeRegistryEventsAndErrors.sol";

import {DebtOrderServiceManager} from "../src/DebtOrderServiceManager.sol";
import {Utils} from "./utils/Utils.sol";

import "forge-std/Script.sol";
import "forge-std/StdJson.sol";
import "forge-std/console.sol";

contract DeployToSepolia is Script, Utils {
    // EigenLayer Ethereum Sepolia Testnet addresses
    address constant DELEGATION_MANAGER = 0xA44151489861Fe9e3055d95adC98FbD462B948e7;
    address constant AVS_DIRECTORY = 0x055733000064333CaDDbC92763c58BF0192fFeBf;
    address constant STRATEGY_MANAGER = 0xdfB5f6CE42aAA7830E94ECFCcAd411beF4d4D5b6;
    address constant EIGEN_POD_MANAGER = 0x30770d7E3e71112d7A6b7259542D1f680a70e315;
    address constant EIGEN_LAYER_PROXY_ADMIN = 0xDB023566064246399b4AE851197a97729C93A6cf;
    
    // Example strategy - you may want to use stETH or another LST strategy
    address constant WETH_STRATEGY = 0x7D704507b76571a51d9caE8AdDAbBFd0ba0e63d3;

    ProxyAdmin public avsProxyAdmin;
    PauserRegistry public avsPauserRegistry;

    ECDSAStakeRegistry public stakeRegistryProxy;
    ECDSAStakeRegistry public stakeRegistryImpl;

    DebtOrderServiceManager public serviceManagerProxy;
    DebtOrderServiceManager public serviceManagerImpl;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        vm.createSelectFork(vm.envString("ETHEREUM_SEPOLIA_RPC"));
        vm.startBroadcast(deployerPrivateKey);

        console.log("Deploying DebtOrderServiceManager to Ethereum Sepolia...");
        console.log("Deployer:", deployer);

        // Deploy AVS contracts
        _deployAvsContracts(
            IDelegationManager(DELEGATION_MANAGER),
            IAVSDirectory(AVS_DIRECTORY),
            IStrategy(WETH_STRATEGY),
            deployer, // multisig
            deployer  // pauser
        );

        console.log("Deployment complete!");
        console.log("ServiceManager Proxy:", address(serviceManagerProxy));
        console.log("ServiceManager Implementation:", address(serviceManagerImpl));
        console.log("StakeRegistry Proxy:", address(stakeRegistryProxy));
        console.log("StakeRegistry Implementation:", address(stakeRegistryImpl));

        vm.stopBroadcast();

        // Write deployment output
        _writeDeploymentOutput();
    }

    function _deployAvsContracts(
        IDelegationManager delegationManager,
        IAVSDirectory avsDirectory,
        IStrategy strategy,
        address avsCommunityMultisig,
        address avsPauser
    ) internal {
        // Deploy proxy admin
        avsProxyAdmin = new ProxyAdmin();

        // Deploy pauser registry
        address[] memory pausers = new address[](2);
        pausers[0] = avsPauser;
        pausers[1] = avsCommunityMultisig;
        avsPauserRegistry = new PauserRegistry(pausers, avsCommunityMultisig);

        EmptyContract emptyContract = new EmptyContract();

        // Deploy proxy contracts pointing to empty implementation initially
        serviceManagerProxy = DebtOrderServiceManager(
            address(
                new TransparentUpgradeableProxy(
                    address(emptyContract),
                    address(avsProxyAdmin),
                    ""
                )
            )
        );
        
        stakeRegistryProxy = ECDSAStakeRegistry(
            address(
                new TransparentUpgradeableProxy(
                    address(emptyContract),
                    address(avsProxyAdmin),
                    ""
                )
            )
        );

        // Deploy implementation contracts
        stakeRegistryImpl = new ECDSAStakeRegistry(delegationManager);

        // Upgrade stake registry proxy to implementation
        avsProxyAdmin.upgrade(
            TransparentUpgradeableProxy(payable(address(stakeRegistryProxy))),
            address(stakeRegistryImpl)
        );

        // Initialize stake registry with quorum
        StrategyParams[] memory quorumsStrategyParams = new StrategyParams[](1);
        quorumsStrategyParams[0] = StrategyParams({
            strategy: strategy,
            multiplier: 10_000 // 100% weight
        });

        Quorum memory quorum = Quorum(quorumsStrategyParams);

        avsProxyAdmin.upgradeAndCall(
            TransparentUpgradeableProxy(payable(address(stakeRegistryProxy))),
            address(stakeRegistryImpl),
            abi.encodeWithSelector(
                ECDSAStakeRegistry.initialize.selector,
                address(serviceManagerProxy),
                1, // Minimum weight of 1
                quorum
            )
        );

        // Deploy service manager implementation
        serviceManagerImpl = new DebtOrderServiceManager(
            address(avsDirectory),
            address(stakeRegistryProxy),
            address(delegationManager)
        );

        // Upgrade service manager proxy to implementation
        avsProxyAdmin.upgrade(
            TransparentUpgradeableProxy(payable(address(serviceManagerProxy))),
            address(serviceManagerImpl)
        );
    }

    function _writeDeploymentOutput() internal {
        string memory parent_object = "parent object";
        string memory deployed_addresses = "addresses";
        
        vm.serializeAddress(deployed_addresses, "serviceManagerProxy", address(serviceManagerProxy));
        vm.serializeAddress(deployed_addresses, "serviceManagerImpl", address(serviceManagerImpl));
        vm.serializeAddress(deployed_addresses, "stakeRegistryProxy", address(stakeRegistryProxy));
        vm.serializeAddress(deployed_addresses, "stakeRegistryImpl", address(stakeRegistryImpl));
        vm.serializeAddress(deployed_addresses, "avsProxyAdmin", address(avsProxyAdmin));
        
        string memory deployed_addresses_output = vm.serializeAddress(
            deployed_addresses,
            "avsPauserRegistry",
            address(avsPauserRegistry)
        );

        string memory chain_info = "chainInfo";
        vm.serializeUint(chain_info, "chainId", block.chainid);
        vm.serializeString(chain_info, "network", "ethereum-sepolia");
        string memory chain_info_output = vm.serializeUint(chain_info, "deploymentBlock", block.number);

        // Serialize all the data
        vm.serializeString(parent_object, deployed_addresses, deployed_addresses_output);
        string memory finalJson = vm.serializeString(parent_object, chain_info, chain_info_output);

        writeOutput(finalJson, "debt_order_service_manager_sepolia");
    }
}