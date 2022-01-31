// SPDX-License-Identifier: MIT

pragma solidity 0.8.10;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import "../interfaces/IGrassHouse.sol";
import "../interfaces/IxALPACA.sol";
import "../SafeToken.sol";
import "./pancake/IPancakeRouter02.sol";

/// @title GrassMaxi
/// @notice GrassMaxi is an auto-compounding xALPACA yield aggregator. Maximum APY by swapping all the reward tokens to ALPACAs and lock back to xALPACA vault weekly.
contract GrassMaxi is Initializable, ERC20Upgradeable, ReentrancyGuardUpgradeable, OwnableUpgradeable {
    using SafeToken for address;

    event LogDeposit(address user, uint256 lockedAmount, uint256 mintedShare);
    event LogReinvest(uint256 reward, uint256 bounty);
    event LogWithdraw(address user, uint256 amount, uint256 burnedAmount);
    event LogCollectBounty(uint256 bountyAmount);

    /// @dev Constants
    uint256 public constant WEEK = 7 days;
    /// @dev MAX_LOCK 53 weeks - 1 seconds
    uint256 public constant MAX_LOCK = (53 * WEEK) - 1;
    /// @dev init deposit when create lock
    uint256 private constant INIT_DEPOSIT = 1;

    /// @dev xALPACA address
    address public xALPACA;
    /// @dev ALPACA token address
    address public ALPACA;
    /// @dev PancakeRouter v2
    address public pcsRouterV2;

    /// @dev reinvest bounty percent in bps
    uint256 public treasuryBountyBps;
    /// @dev bounty amount
    uint256 public bountyAmount;

    function initialize(
        address _xALPACA,
        address _ALPACA,
        address _pcsRouterV2,
        uint256 _treasuryBountyBps
    ) external initializer {
        ERC20Upgradeable.__ERC20_init("Alpaca Mate xALPACA", "mxALPACA");
        OwnableUpgradeable.__Ownable_init();
        ReentrancyGuardUpgradeable.__ReentrancyGuard_init();

        xALPACA = _xALPACA;
        ALPACA = _ALPACA;
        pcsRouterV2 = _pcsRouterV2;
        treasuryBountyBps = _treasuryBountyBps;
        ALPACA.safeApprove(xALPACA, type(uint256).max);
    }

    modifier lockIsLive() {
        require(totalLockedAmount() > 0, "lock not created yet");
        _;
    }

    /// @notice creates a lock for this vault. should be called before any deposits. Require whitelisted by xALPACA.
    function createLock() external onlyOwner {
        require(totalLockedAmount() == 0, "already has a lock");
        // createLock requires amount > 0
        ALPACA.safeTransferFrom(msg.sender, address(this), INIT_DEPOSIT);
        IxALPACA(xALPACA).createLock(INIT_DEPOSIT, block.timestamp + MAX_LOCK);
    }

    /// @notice claim and swap all rewards to ALPACA and reinvest to xALPACA, will increase total amount of this vault.
    /// @param _grassHouses The addresses of grass houses to be collected
    /// @param _paths the swap path to swap grass token to alpaca token, one address[] for one grass house
    function claimAndReinvest(address[] calldata _grassHouses, address[][] calldata _paths) external lockIsLive {
        require(_grassHouses.length == _paths.length, "bad params");
        uint256 alpacaBalanceBefore = ALPACA.myBalance();
        // claim and swap reward token to ALPACA
        for (uint256 i = 0; i < _grassHouses.length; i++) {
            IGrassHouse(_grassHouses[i]).claim(address(this));
            _swapRewardToken(IGrassHouse(_grassHouses[i]).rewardToken(), _paths[i]);
        }
        uint256 alpacaBalanceAfter = ALPACA.myBalance();
        uint256 earned = alpacaBalanceAfter - alpacaBalanceBefore;
        if (earned > 0) {
            uint256 bounty = earned * treasuryBountyBps / 10000;
            bountyAmount += bounty;
            // reinvest earned - bounty
            IxALPACA(xALPACA).depositFor(address(this), earned - bounty);
            emit LogReinvest(earned, bounty);
        }
    }

    /// @notice deposit _amount of ALPACA token to vault. Letting vault to increase the APY.
    function deposit(uint256 _amount) external lockIsLive nonReentrant {
        require(_amount > 0, "bad _amount");
        ALPACA.safeTransferFrom(msg.sender, address(this), _amount);
        // mintShare is the share of _amount, while totalSupply() is the total share
        // as the totalLockedAmount() increase, each share will worth more ALPACAs
        uint256 mintShare = _amount;
        uint256 totalShare = ERC20Upgradeable.totalSupply();
        if (totalShare != 0) {
            // totalLockedAmount always > 0 because of the lockIsLive modifier;
            mintShare = _amount * (totalLockedAmount() - INIT_DEPOSIT) / totalShare;
        }
        // if totalShare = 0, mintShare = _amount
        _mint(msg.sender, mintShare);
        // xALPACA.#increaseLockAmount requires EOA
        IxALPACA(xALPACA).depositFor(address(this), _amount);
        emit LogDeposit(msg.sender, _amount, mintShare);
    }

    function withdraw() external nonReentrant {
        // if not withdrawn from xALPACA
        if (totalLockedAmount() > 0) {
            // success only when lock is expired or xALPACA breaker is on
            IxALPACA(xALPACA).withdraw();
        }
        // burn all the mxALPACA token to get back ALPACA
        uint256 amountToBurn = ERC20Upgradeable.balanceOf(msg.sender);
        if (amountToBurn != 0) {
            // totalSupply() will never be 0 if userBalance != 0
            uint256 userAmount = amountToBurn * (ALPACA.myBalance() - bountyAmount) / ERC20Upgradeable.totalSupply();
            _burn(msg.sender, amountToBurn);
            ALPACA.safeTransfer(msg.sender, userAmount);
            emit LogWithdraw(msg.sender, userAmount, amountToBurn);
        }
    }

    /// @dev Return the total locked amount of this vault
    function totalLockedAmount() public view returns (uint256) {
        return SafeCastUpgradeable.toUint256(IxALPACA(xALPACA).locks(address(this)).amount);
    }

    /// @dev helper function to swap token
    function _swapRewardToken(address rewardToken, address[] memory path) internal {
        // no need to swap ALPACA token
        if (rewardToken != ALPACA) {
            uint256 rewardBalance = rewardToken.myBalance();
            if (rewardBalance > 0) {
                rewardToken.safeApprove(pcsRouterV2, rewardBalance);
                IPancakeRouter02(pcsRouterV2).swapExactTokensForTokens(rewardBalance, 0, path, address(this), block.timestamp);
                rewardToken.safeApprove(pcsRouterV2, 0);
            }
        }
    }

    // owner functions

    /// @notice owner collects vault bounty
    function collectBounty(address _to) external onlyOwner {
        uint256 transferAmount = bountyAmount;
        bountyAmount = 0;
        ALPACA.safeTransfer(_to, transferAmount);
        emit LogCollectBounty(transferAmount);
    }

    /// @notice in-case anyone transfer tokens into by mistake
    function withdrawToken(address _token, address _to, uint256 _amount) external onlyOwner {
        require(_token != ALPACA, "bad _token");
        _token.safeTransfer(_to, _amount);
    }

}
