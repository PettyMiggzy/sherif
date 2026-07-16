// The exact events the live contracts emit (see contracts/*.sol). We only need
// the four that drive the pad: a coin launching, a buy, a sell, a graduation.
import { ethers } from "ethers";

export const EVENTS = [
  // CurvePadFactory
  "event Launched(address indexed token, address indexed curve, address indexed pool, address dev, uint256 devBought)",
  // PadRouter
  "event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 fee, uint256 tokensOut)",
  "event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 fee, uint256 ethOut)",
  // CurvePool (emitted by each curve; matched back to its token by address)
  "event Graduated(address indexed bond, uint256 raisedWeth, uint256 leftoverToken)",
];

// Minimal read ABIs for enriching a coin at launch time (name / symbol).
export const ERC20 = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];

export const iface = new ethers.Interface(EVENTS);

// topic0 for each event, so we can filter getLogs cheaply.
export const TOPICS = {
  Launched: iface.getEvent("Launched").topicHash,
  Bought: iface.getEvent("Bought").topicHash,
  Sold: iface.getEvent("Sold").topicHash,
  Graduated: iface.getEvent("Graduated").topicHash,
};
