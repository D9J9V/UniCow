export const deploymentAddresses = {
  "eigenlayer": {
    // Ethereum Sepolia testnet addresses
    "avsDirectory": "0x055733000064333CaDDbC92763c58BF0192fFeBf",
    "delegation": "0xA44151489861Fe9e3055d95adC98FbD462B948e7",
    "strategyManager": "0xdfB5f6CE42aAA7830E94ECFCcAd411beF4d4D5b6",
    "eigenPodManager": "0x30770d7E3e71112d7A6b7259542D1f680a70e315",
    "eigenLayerProxyAdmin": "0xDB023566064246399b4AE851197a97729C93A6cf",
    // Other EigenLayer contracts not needed for operator
    "avsDirectoryImplementation": "",
    "baseStrategyImplementation": "",
    "delegationImplementation": "",
    "eigenLayerPauserReg": "",
    "eigenPodBeacon": "",
    "eigenPodImplementation": "",
    "eigenPodManagerImplementation": "",
    "emptyContract": "",
    "rewardsCoordinator": "",
    "rewardsCoordinatorImplementation": "",
    "slasher": "",
    "slasherImplementation": "",
    "strategies": "",
    "strategyManagerImplementation": ""
  },
  "avs": {
    // Our deployed AVS contracts on Ethereum Sepolia
    "serviceManagerProxy": "0x3333Bc77EdF180D81ff911d439F02Db9e34e8603",
    "serviceManagerImpl": "0xF12b7dd6E49FBF196A6398BEF6C7aD29C7818a7B",
    "stakeRegistryProxy": "0x3Df55660F015689174cd42F2FF7D2e36564404b5",
    "stakeRegistryImpl": "0x84FACEcBea30a44305c96d0727C814cBbeE9F9A3",
    "erc20Mock": "",
    "erc20MockStrategy": ""
  },
  "hook": {
    // Unichain Sepolia addresses
    "hook": "0x0C075a62FD69EA6Db1F65566911C4f1D221e40c8",
    "poolManager": "0x5b73C5498c1E3b4dbA84de0F1833c4a029d90519",
    "debtOrderBook": "0xDB8cFf278adCCF9E9b5da745B44E754fC4EE3C76",
    "token0": "0x0000000000000000000000000000000000000000", // ETH
    "token1": "0x7FA9385bE102ac3EAc297483Dd6233D62b3e1496", // USDC Mock
    // Not needed for operator
    "lpRouter": "",
    "quoter": "",
    "swapRouter": ""
  }
} as const;
