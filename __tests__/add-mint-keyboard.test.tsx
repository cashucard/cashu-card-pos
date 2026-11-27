/* Add a mint: pressing Check this mint puts the keyboard away (ENG-911). On the owner's iPhone the keyboard stayed up
 * after the press and covered Add this mint until it was dismissed by hand. */

import React from 'react';
import { Keyboard } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AddMintScreen } from '../src/screens/AddMintScreen';
import { benchGate } from '../src/till/guarded';
import type { MintCheckReport } from '../src/till/mint-check';
import { has, press, typeInto } from './helpers/render';

it('Check this mint puts the keyboard away, once, before the check runs; typing never does', async () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  const order: string[] = [];
  dismiss.mockImplementation(() => {
    order.push('dismiss');
  });
  const service = {
    checkMint: jest.fn((_text: string): Promise<MintCheckReport> => {
      order.push('check');
      return new Promise<MintCheckReport>(() => undefined);
    }),
    addMint: jest.fn(async (_r: MintCheckReport): Promise<void> => undefined),
  };
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <AddMintScreen service={service} gate={benchGate('allow')} preset={null} onDone={jest.fn()} onBack={jest.fn()} />,
    );
  });
  await typeInto(tree, 'addmint-url', 'https://mint.test');
  expect(dismiss).not.toHaveBeenCalled();
  await press(tree, 'addmint-check');
  expect(has(tree, 'addmint-checking')).toBe(true);
  expect(order).toEqual(['dismiss', 'check']);
  act(() => {
    tree.unmount();
  });
  dismiss.mockRestore();
});
