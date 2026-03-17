import test from "node:test";
import assert from "node:assert/strict";

import {
  formatReceiverJobSource,
  inferReceiverJobSource,
  routeMachineId,
  routeMatchesMachineId,
} from "./receiver-contract.ts";

test("photozone jobs use explicit source instead of legacy wink heuristics", () => {
  const job = {
    source: "photozone",
    orderId: "PX1256150326",
    deliveryMethod: "Royal Mail Tracked 24",
  };

  assert.equal(inferReceiverJobSource(job), "photozone");
  assert.equal(formatReceiverJobSource(job), "Photo Zone");
});

test("store-based route options resolve machine ids for solihull and stratford", () => {
  const solihull = {
    source: "solihull",
    storeId: "002",
    defaultMachineId: "002",
    location: "Solihull",
    label: "Solihull (002)",
  };
  const stratford = {
    source: "stratford",
    storeId: "003",
    defaultMachineId: "003",
    location: "Stratford-Upon-Avon",
    label: "Stratford-Upon-Avon (003)",
  };

  assert.equal(routeMachineId(solihull), "002");
  assert.equal(routeMachineId(stratford), "003");
  assert.equal(routeMatchesMachineId(solihull, "002"), true);
  assert.equal(routeMatchesMachineId(stratford, "003"), true);
  assert.equal(routeMatchesMachineId(solihull, "003"), false);
});
