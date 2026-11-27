import React from "react";
import { Animated, AppState, type AppStateStatus } from "react-native";
import { TokenScreen } from "../src/screens/TokenScreen";
import { cashuAmount } from "../src/format";
import renderer, { act, type ReactTestRenderer } from "react-test-renderer";
import { WalletScreen } from "../src/screens/WalletScreen";
import { WalletRefreshed } from "../src/screens/WalletRefreshed";
import * as motion from "../src/ui/motion";
import { benchGate } from "../src/till/guarded";
import type { WalletReader, WalletBalance } from "../src/till/wallet";
import { allText, has, press, until, untilText } from "./helpers/render";

const mint = "https://mint.test";
const token = "cashuBfakePrivateBearer";
beforeEach(() => {
  AppState.currentState = "active";
  // Restoring a spy on the RN preset's mock also resets its listener implementation.
  jest.mocked(AppState.addEventListener).mockImplementation(() => ({ remove: jest.fn() }));
});

async function mount(
  allow: "allow" | "deny",
  initialPending = false,
  nativeShare = true,
) {
  let group: WalletBalance = {
    mint,
    unit: "sat",
    available: 0,
    withdrawal: { id: "opaque", amount: 12, pending: initialPending },
  };
  const service: WalletReader = {
    walletBalances: async () => (group.withdrawal ? [group] : []),
    prepareWithdrawal: jest.fn(),
    withdrawalToken: jest.fn(async () => token),
    checkWithdrawal: async () => {
      group = { ...group, withdrawal: null };
      return { amount: 0, pending: false };
    },
  };
  const share = jest.fn(async () => undefined);
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <WalletScreen
        service={service}
        gate={benchGate(allow)}
        share={nativeShare ? share : undefined}
        onBack={() => undefined}
      />,
    );
  });
  await until(tree, "wallet-check-opaque");
  return { tree, service, share };
}

it("requires a fresh owner check to share, with no bearer token in the screen tree", async () => {
  const { tree, service, share } = await mount("deny");
  await press(tree, "wallet-share-opaque");
  expect(service.withdrawalToken).not.toHaveBeenCalled();
  expect(share).not.toHaveBeenCalled();
  expect(JSON.stringify(tree.toJSON())).not.toContain(token);
});

it("shows pending after sharing and reports redeemed only after a separate mint check", async () => {
  const { tree, service, share } = await mount("allow");
  await press(tree, "wallet-share-opaque");
  const shown = tree.root.findByType(TokenScreen);
  expect(shown.props.title).toBe("12 sats withdrawal");
  await untilText(tree, "token-mint", mint);
  expect(shown.props.token).toBe(token);
  expect(shown.props.share).toBe(share);
  expect(share).not.toHaveBeenCalled();
  expect(has(tree, "token-qr")).toBe(true);
  expect(has(tree, "token-copy")).toBe(true);
  await press(tree, "token-share");
  expect(share).toHaveBeenCalledWith(shown.props.title, token);
  await press(tree, "token-done");

  await untilText(
    tree,
    "wallet-message",
    "Check redemption after your wallet receives the token.",
  );
  expect(service.withdrawalToken).toHaveBeenCalledWith("opaque");
  expect(tree.root.findAllByType(TokenScreen)).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).not.toContain(token);
  expect(has(tree, "wallet-check-opaque")).toBe(true);
  await press(tree, "wallet-check-opaque");
  await untilText(tree, "wallet-message", "The mint confirmed redemption.");
  expect(has(tree, "wallet-check-opaque")).toBe(false);
  expect(has(tree, "wallet-refreshed")).toBe(false);
});

it("offers QR and Copy when no native share action is available", async () => {
  const { tree } = await mount("allow", false, false);
  await press(tree, "wallet-share-opaque");
  expect(has(tree, "token-qr")).toBe(true);
  expect(has(tree, "token-copy")).toBe(true);
  expect(has(tree, "token-share")).toBe(false);
  await press(tree, "token-done");
  expect(has(tree, "wallet-check-opaque")).toBe(true);
});

it("keeps a mint-pending withdrawal visible without offering to resend it", async () => {
  const { tree } = await mount("allow", true);
  expect(has(tree, "wallet-share-opaque")).toBe(false);
  expect(has(tree, "wallet-check-opaque")).toBe(true);
});

it("denominates USD keysets in cents and sat keysets in sats", () => {
  expect(cashuAmount(100, "usd")).toBe("100 US cents");
  expect(cashuAmount(1, "usd")).toBe("1 US cent");
  expect(cashuAmount(100, "sat")).toBe("100 sats");
});

it("requires fresh authentication after backgrounding while a token is visible or still being read", async () => {
  const callbacks = new Set<(state: AppStateStatus) => void>();
  const listener = jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((kind, cb) => {
      const fn = cb as (state: AppStateStatus) => void;
      if (kind === "change") callbacks.add(fn);
      return {
        remove: () => {
          callbacks.delete(fn);
        },
      };
    });
  const change = (state: AppStateStatus) =>
    act(async () => {
      for (const f of callbacks) f(state);
    });
  try {
    const { tree, service, share } = await mount("allow");
    let complete!: (token: string) => void;
    service.withdrawalToken = jest.fn(
      async () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    await press(tree, "wallet-share-opaque");
    expect(service.withdrawalToken).toHaveBeenCalledTimes(1);
    await change("background");
    await change("active");
    await act(async () => complete(token));
    expect(tree.root.findAllByType(TokenScreen)).toHaveLength(0);
    service.withdrawalToken = jest.fn(async () => token);
    await press(tree, "wallet-share-opaque");
    expect(tree.root.findAllByType(TokenScreen)).toHaveLength(1);
    await change("background");
    await change("active");
    expect(tree.root.findAllByType(TokenScreen)).toHaveLength(0);
    expect(share).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  } finally {
    listener.mockRestore();
  }
});

it("reviews the exact mint before preparing and rechecks a changed balance", async () => {
  const first = { mint: "https://mint.test/a", unit: "sat", available: 12, withdrawal: null };
  const second = { mint: "https://mint.test/b", unit: "sat", available: 12, withdrawal: null };
  let groups = [first, second];
  const service: WalletReader = {
    walletBalances: async () => groups,
    prepareWithdrawal: jest.fn(async () => {}),
    withdrawalToken: jest.fn(),
    checkWithdrawal: jest.fn(),
  };
  let tree!: ReactTestRenderer;
  try {
    await act(async () => {
      tree = renderer.create(<WalletScreen service={service} gate={benchGate("allow")} onBack={() => {}} />);
    });
    const select = "wallet-prepare-" + second.mint + "/sat";
    await until(tree, select);
    await press(tree, select);
    expect(has(tree, "wallet-review-title")).toBe(true);
    expect(JSON.stringify(tree.toJSON())).toContain(second.mint);
    expect(JSON.stringify(tree.toJSON())).not.toContain(first.mint);
    expect(service.prepareWithdrawal).not.toHaveBeenCalled();
    groups = [first, { ...second, available: 16 }];
    await press(tree, "wallet-confirm-prepare");
    await untilText(tree, "wallet-message", "This balance changed. Review the current amount before withdrawing.");
    expect(service.prepareWithdrawal).not.toHaveBeenCalled();
    await press(tree, select);
    await press(tree, "wallet-confirm-prepare");
    expect(has(tree, "wallet-refreshed")).toBe(false);
    expect(service.prepareWithdrawal).toHaveBeenCalledTimes(1);
    expect(service.prepareWithdrawal).toHaveBeenCalledWith(second.mint, "sat");
  } finally {
    act(() => tree?.unmount());
  }
});

it("confirms only the merchant’s requested, successful read, including an empty wallet", async () => {
  const { tree, service } = await mount("allow");
  const read = jest.spyOn(service, "walletBalances");
  try {
    expect(has(tree, "wallet-refreshed")).toBe(false);
    let finish!: (groups: WalletBalance[]) => void;
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await press(tree, "wallet-refresh");
    expect(has(tree, "wallet-refreshed")).toBe(false);
    await act(async () => finish([]));
    await untilText(tree, "wallet-refreshed", "Wallet refreshed");
    expect(allText(tree)).toContain("No takings available");
    expect(read).toHaveBeenCalledTimes(1);

    read.mockRejectedValueOnce(new Error("unavailable"));
    await press(tree, "wallet-refresh");
    await untilText(tree, "wallet-message", "Could not read the wallet. Refresh to try again.");
    expect(has(tree, "wallet-refreshed")).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    act(() => tree.unmount());
  }
});

it("settles the wallet scan immediately on Reduced Motion and keeps the result readable", () => {
  const preference = jest.spyOn(motion, "useMotionAllowed").mockReturnValue(true);
  const scan = { start: jest.fn(), stop: jest.fn(), reset: jest.fn() };
  const timing = jest.spyOn(Animated, "timing").mockReturnValue(scan);
  let tree!: ReactTestRenderer;
  try {
    act(() => { tree = renderer.create(<WalletRefreshed />); });
    expect(scan.start).toHaveBeenCalledTimes(1);
    preference.mockReturnValue(false);
    act(() => { tree.update(<WalletRefreshed />); });
    expect(scan.stop).toHaveBeenCalledTimes(1);
    expect(allText(tree)).toContain("Wallet refreshed");
    preference.mockReturnValue(true);
    act(() => { tree.update(<WalletRefreshed />); });
    expect(scan.start).toHaveBeenCalledTimes(1);
  } finally {
    act(() => tree?.unmount());
    timing.mockRestore();
    preference.mockRestore();
  }
});
