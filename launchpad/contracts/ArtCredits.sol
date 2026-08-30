// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev The ERC-1271 magic value, for smart-contract wallets.
interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/// @title ArtCredits — prepaid credits for the pad's image generator
/// @notice Buy credits, spend them generating coin art. One credit is one image. The generator itself runs
/// off-chain (an image model behind our own endpoint); this contract is only the ledger that says who has
/// paid for how many.
///
/// CREDITS ARE NOT A DEPOSIT AND ARE NOT REFUNDABLE. Buying credits buys compute, the same way buying an
/// arcade token buys a game. There is no function that converts a credit back into ETH — not for the buyer,
/// not for the owner, not for anyone — and that is deliberate rather than an oversight. A contract that
/// takes money and promises it back on demand is a very different thing, legally and operationally, from
/// one that sells a service, and this is the second. `withdraw` moves the SALE PROCEEDS, which are already
/// the platform's; it can never reach into a balance a buyer has not spent, because there is no such pool
/// of ETH — a spent or unspent credit is just a number, and the ETH stopped being the buyer's at purchase.
///
/// THE OPERATOR CANNOT SPEND ANYTHING ON ITS OWN. The server that runs the generator holds an operator key,
/// and that key is online, on a box, exposed to the internet, so it is assumed to be stealable. An operator
/// that could simply decrement balances would let whoever stole it burn every credit every customer had ever
/// bought — not theft, but a way to destroy the ledger from a compromised web server, which is not a thing
/// worth being one break-in away from.
///
/// So a spend needs the CUSTOMER'S signature. The operator only relays it. That signature costs nothing to
/// produce and the server needs one anyway — it has to prove which address is asking before it will generate
/// anything — so one signature does both jobs and the operator key on its own is inert: it cannot mint
/// credits, spend them, move ETH, change the price, or appoint another operator. It can pay gas to submit
/// something a customer already agreed to, and that is all.
///
/// WHY `buy` TAKES A PRICE CEILING. The owner can retune `weiPerCredit`, which means a raise could land in
/// the same block as somebody's purchase and take more than they agreed to. `maxWeiPerCredit` is the buyer's
/// own guard against that, and it is required rather than optional: an interface that lets you omit your
/// slippage limit is an interface most people omit it on.
contract ArtCredits is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice ETH price of one credit. Set to roughly 3x the per-image cost of the model behind the
    /// endpoint; at $0.01 an image and a 3x markup that is $0.03, converted to wei at the ETH price of the
    /// day. It is a plain owner-set number rather than an oracle read on purpose — an oracle here would add
    /// a live external dependency to a purchase flow, and the thing being priced moves in cents.
    uint256 public weiPerCredit;

    /// @notice Optional second payment rail: buy credits with an ERC-20 (the pad's own token). Zero address
    /// disables it. Priced separately because the two assets have nothing to do with each other.
    IERC20 public payToken;
    uint256 public tokenPerCredit;
    /// @notice Where ERC-20 payments land. Set to the $ROBIN staking pool and buying art with $ROBIN pays
    /// the stakers; set to a treasury and it does not. Either is one setter away, which is the point.
    address public tokenSink;

    mapping(address => uint256) public credits;
    mapping(address => bool) public isOperator;
    /// @notice Spend authorisations already used, per address. Arbitrary nonces rather than a counter, so
    /// concurrent requests do not serialise.
    mapping(address => mapping(uint256 => bool)) public usedNonce;

    /// @notice Lifetime counters, for a dashboard that does not need an indexer.
    uint256 public totalSold;
    uint256 public totalSpent;

    error Zero();
    /// @notice A plain ETH send cannot name a price ceiling, so it is refused — see `receive`.
    error UseBuy();
    error BadPrice();
    error NotOperator();
    error PriceMoved(uint256 actual, uint256 max);
    error Underpaid(uint256 sent, uint256 need);
    error NotEnoughCredits(uint256 has, uint256 need);
    error PayTokenOff();
    error PayoutFailed();
    error SigExpired(uint256 deadline);
    error NonceUsed(uint256 nonce);
    error BadSignature();

    event Bought(address indexed buyer, uint256 credits, uint256 paid, address asset);
    event Spent(address indexed user, uint256 credits, address indexed operator);
    event Granted(address indexed user, uint256 credits);
    event PriceSet(uint256 weiPerCredit);
    event PayTokenSet(address token, uint256 tokenPerCredit, address sink);
    event OperatorSet(address indexed who, bool allowed);
    event Withdrawn(address indexed to, uint256 amount);

    constructor(address owner_, uint256 weiPerCredit_) Ownable(owner_) {
        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN = _buildDomainSeparator();
        if (weiPerCredit_ == 0) revert BadPrice();
        weiPerCredit = weiPerCredit_;
        emit PriceSet(weiPerCredit_);
    }

    // ──────────────────────────────────────────────────────────────── buy ──

    /// @notice Buy `n` credits with ETH. Send at least `n * weiPerCredit`; anything above that is kept as a
    /// tip rather than refunded — a refund would mean an external call back into an unknown address on the
    /// buy path, which is a re-entrancy surface bought for nothing, since the client already knows the exact
    /// price. `maxWeiPerCredit` is your guard against the price changing under you.
    function buy(uint256 n, uint256 maxWeiPerCredit) external payable nonReentrant {
        if (n == 0) revert Zero();
        uint256 price = weiPerCredit;
        if (price > maxWeiPerCredit) revert PriceMoved(price, maxWeiPerCredit);
        uint256 need = n * price;
        if (msg.value < need) revert Underpaid(msg.value, need);
        credits[msg.sender] += n;
        totalSold += n;
        emit Bought(msg.sender, n, msg.value, address(0));
    }

    /// @notice Buy `n` credits with `payToken`. The payment goes straight to `tokenSink` and never rests
    /// here, so this contract never custodies anyone's ERC-20 and there is nothing to sweep or strand.
    function buyWithToken(uint256 n, uint256 maxTokenPerCredit) external nonReentrant {
        if (n == 0) revert Zero();
        IERC20 t = payToken;
        uint256 price = tokenPerCredit;
        if (address(t) == address(0) || price == 0) revert PayTokenOff();
        if (price > maxTokenPerCredit) revert PriceMoved(price, maxTokenPerCredit);
        address sink = tokenSink;
        if (sink == address(0)) revert PayTokenOff();
        credits[msg.sender] += n;
        totalSold += n;
        t.safeTransferFrom(msg.sender, sink, n * price);
        emit Bought(msg.sender, n, n * price, address(t));
    }

    // ──────────────────────────────────────────────────────────────── spend ──

    // ── EIP-712, written out rather than inherited ──────────────────────────
    // OpenZeppelin's EIP712 reaches ShortStrings -> Strings -> Bytes, which compiles to `mcopy`: a Cancun
    // opcode this chain does not have, which is why the whole project targets paris. The domain separator is
    // fully specified by the standard, so it is built here instead of pulling in a dependency that cannot run.
    // Rebuilt rather than cached if the chain id ever changes under us (a fork), so a signature can never be
    // replayed across chains.
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant HASHED_NAME = keccak256("RobinArtCredits");
    bytes32 private constant HASHED_VERSION = keccak256("1");
    uint256 private immutable _CACHED_CHAIN_ID;
    bytes32 private immutable _CACHED_DOMAIN;

    bytes32 private constant SPEND_TYPEHASH =
        keccak256("Spend(address user,uint256 amount,uint256 nonce,uint256 deadline)");

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, HASHED_NAME, HASHED_VERSION, block.chainid, address(this)));
    }

    /// @notice The EIP-712 domain separator, for a client that builds the digest itself.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _CACHED_CHAIN_ID ? _CACHED_DOMAIN : _buildDomainSeparator();
    }

    function _hashTypedDataV4(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    /// @notice Burn `amount` of `user`'s credits, authorised by `user`'s own signature and relayed by an
    /// operator. The server calls this AFTER a generation has actually succeeded, never before: charging
    /// first would need a refund path for a failed generation, and the whole design here is that there is no
    /// refund path.
    ///
    /// The nonce is an arbitrary number the server picks, not a counter, so several requests can be in
    /// flight at once without serialising — a counter would make two concurrent generations race and one of
    /// them fail for no reason the customer could understand. Each nonce is single-use per address.
    ///
    /// Smart-contract wallets are accepted as well as EOAs — see `_isValidSig`. OpenZeppelin's
    /// SignatureChecker would have done it, but it compiles to `mcopy`, a Cancun opcode this chain does not
    /// have (hence the paris target), so the check is written out below instead.
    function spendWithSig(address user, uint256 amount, uint256 nonce, uint256 deadline, bytes calldata signature)
        external
    {
        if (!isOperator[msg.sender]) revert NotOperator();
        if (amount == 0) revert Zero();
        if (block.timestamp > deadline) revert SigExpired(deadline);
        if (usedNonce[user][nonce]) revert NonceUsed(nonce);

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(SPEND_TYPEHASH, user, amount, nonce, deadline)));
        if (!_isValidSig(user, digest, signature)) revert BadSignature();

        uint256 have = credits[user];
        if (have < amount) revert NotEnoughCredits(have, amount);

        // Marked used BEFORE the balance moves, so even a future refactor that made this call something
        // re-enterable could not replay the same authorisation twice.
        usedNonce[user][nonce] = true;
        unchecked { credits[user] = have - amount; }
        totalSpent += amount;
        emit Spent(user, amount, msg.sender);
    }

    /// @notice Spend your OWN credits directly, no operator and no signature. Here so the ledger is never
    /// hostage to our server being up: if the platform disappears tomorrow, this is not needed to recover
    /// anything (credits are compute, not money), but a customer can still settle their own balance.
    function spendSelf(uint256 amount) external {
        if (amount == 0) revert Zero();
        uint256 have = credits[msg.sender];
        if (have < amount) revert NotEnoughCredits(have, amount);
        unchecked { credits[msg.sender] = have - amount; }
        totalSpent += amount;
        emit Spent(msg.sender, amount, msg.sender);
    }

    /// @dev Signature check that accepts both an EOA and an ERC-1271 smart-contract wallet.
    ///
    /// THE GAS CAP IS NOT DECORATION. The operator pays for this transaction, and `user` is an address the
    /// caller chose — so without a cap, anyone could deploy a "wallet" whose `isValidSignature` loops
    /// forever, name it as the user, and burn the operator's gas on every attempt. `staticcall` stops it
    /// writing; only the cap stops it spending. 60k is far more than a real 1271 wallet needs.
    function _isValidSig(address user, bytes32 digest, bytes calldata signature) internal view returns (bool) {
        if (user.code.length == 0) {
            (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
            return err == ECDSA.RecoverError.NoError && rec == user;
        }
        (bool ok, bytes memory ret) = user.staticcall{gas: 60_000}(
            abi.encodeCall(IERC1271.isValidSignature, (digest, signature))
        );
        return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == IERC1271.isValidSignature.selector;
    }

    /// @notice The EIP-712 digest a client must sign for `spendWithSig`. Exposed so a front end never has to
    /// reconstruct the domain separator by hand, which is the usual place this goes wrong.
    function spendDigest(address user, uint256 amount, uint256 nonce, uint256 deadline)
        external view returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(SPEND_TYPEHASH, user, amount, nonce, deadline)));
    }

    // ─────────────────────────────────────────────────────────── governance ──

    /// @notice Hand out credits for nothing — promos, support, making someone whole when a generation broke
    /// on our side. Owner only: an operator that could mint credits could mint itself infinite free compute.
    function grant(address user, uint256 n) external onlyOwner {
        if (user == address(0) || n == 0) revert Zero();
        credits[user] += n;
        emit Granted(user, n);
    }

    function setPrice(uint256 weiPerCredit_) external onlyOwner {
        if (weiPerCredit_ == 0) revert BadPrice();
        weiPerCredit = weiPerCredit_;
        emit PriceSet(weiPerCredit_);
    }

    function setPayToken(address token, uint256 tokenPerCredit_, address sink) external onlyOwner {
        payToken = IERC20(token);
        tokenPerCredit = tokenPerCredit_;
        tokenSink = sink;
        emit PayTokenSet(token, tokenPerCredit_, sink);
    }

    function setOperator(address who, bool allowed) external onlyOwner {
        if (who == address(0)) revert Zero();
        isOperator[who] = allowed;
        emit OperatorSet(who, allowed);
    }

    /// @notice Move sale proceeds out. These are revenue from a completed sale, not a balance held for
    /// anyone — see the note at the top of this file about why credits are not refundable.
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert Zero();
        uint256 amt = amount == 0 ? address(this).balance : amount;
        (bool ok,) = to.call{value: amt}("");
        if (!ok) revert PayoutFailed();
        emit Withdrawn(to, amt);
    }

    /// @notice What `n` credits cost right now, for a client that wants to show a price before asking for a
    /// signature. Returns both rails; `tokenCost` is 0 when the token rail is off.
    function quote(uint256 n) external view returns (uint256 ethCost, uint256 tokenCost) {
        ethCost = n * weiPerCredit;
        tokenCost = address(payToken) == address(0) ? 0 : n * tokenPerCredit;
    }

    /// @dev A plain send is treated as a purchase at the current price rather than refused, because a wallet
    /// that "sends ETH to the address" is a thing people do and silently keeping it would be theft. Dust
    /// below one credit adds nothing and is kept, same as an overpayment on `buy`.
    /// @notice A plain ETH send is REFUSED. Buy through `buy(n, maxWeiPerCredit)`.
    ///
    /// This used to mint at whatever `weiPerCredit` happened to be at that instant — which is exactly the
    /// race `buy`'s `maxWeiPerCredit` exists to stop, skipped on the one path that cannot carry the argument.
    /// A `setPrice` landing first turned a plain send into one credit for one ETH, with no refund, on a
    /// contract whose credits are explicitly non-refundable.
    ///
    /// Reverting costs the sender nothing: the ETH never leaves their wallet. Minting at a raced price would
    /// have. There is no path that needs a bare transfer here — the site calls `buy` with a ceiling — so the
    /// convenience was worth strictly less than the exposure.
    receive() external payable {
        revert UseBuy();
    }
}
