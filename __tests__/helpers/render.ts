import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

/** every node whose testID is id, outermost first */
export function nodes(tree: ReactTestRenderer, id: string): ReactTestInstance[] {
  return tree.root.findAll((n) => n.props.testID === id);
}

export function has(tree: ReactTestRenderer, id: string): boolean {
  return nodes(tree, id).length > 0;
}

/** the first such node's children joined into one string; throws when there is none */
export function textOf(tree: ReactTestRenderer, id: string): string {
  const found = nodes(tree, id);
  if (found.length === 0) {
    throw new Error('no node ' + id);
  }
  return ([] as unknown[]).concat(found[0].props.children).join('');
}

/** every testID in the tree, once each, in the order met */
export function ids(tree: ReactTestRenderer): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of tree.root.findAll((x) => typeof x.props.testID === 'string')) {
    const id = n.props.testID as string;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** every string child of every Text in the tree */
export function allText(tree: ReactTestRenderer): string[] {
  const out: string[] = [];
  for (const n of tree.root.findAll((x) => x.type === Text)) {
    const children = n.props.children;
    if (typeof children === 'string') {
      out.push(children);
    } else if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child === 'string') {
          out.push(child);
        }
      }
    }
  }
  return out;
}

/** the first node's props.disabled === true */
export function isDisabled(tree: ReactTestRenderer, id: string): boolean {
  const found = nodes(tree, id);
  return found.length > 0 && found[0].props.disabled === true;
}

/** inside act: calls the first node's onPress; throws when there is none, or when it is disabled */
export async function press(tree: ReactTestRenderer, id: string): Promise<void> {
  const found = nodes(tree, id);
  if (found.length === 0) {
    throw new Error('no node ' + id);
  }
  const node = found[0];
  if (node.props.disabled === true) {
    throw new Error('disabled: ' + id);
  }
  const onPress = node.props.onPress;
  if (typeof onPress !== 'function') {
    throw new Error('no onPress on ' + id);
  }
  await act(async () => {
    onPress();
  });
}

/** inside act: calls the first node's onChangeText(text) */
export async function typeInto(
  tree: ReactTestRenderer,
  id: string,
  text: string,
): Promise<void> {
  const found = nodes(tree, id);
  if (found.length === 0) {
    throw new Error('no node ' + id);
  }
  const onChangeText = found[0].props.onChangeText;
  if (typeof onChangeText !== 'function') {
    throw new Error('no onChangeText on ' + id);
  }
  await act(async () => {
    onChangeText(text);
  });
}

/** five rounds of: await act(async () => { await new Promise((r) => setTimeout(r, 0)); }) */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
    });
  }
}

/** flushes until a node with that testID shows, at most `rounds` flushes; else throws */
export async function until(
  tree: ReactTestRenderer,
  id: string,
  rounds = 60,
): Promise<void> {
  if (has(tree, id)) {
    return;
  }
  for (let i = 0; i < rounds; i += 1) {
    await flush();
    if (has(tree, id)) {
      return;
    }
  }
  throw new Error('never showed ' + id + '; showing ' + ids(tree).join(', '));
}

/** as until, for a node with that testID whose text is exactly `text` */
export async function untilText(
  tree: ReactTestRenderer,
  id: string,
  text: string,
  rounds = 60,
): Promise<void> {
  const shows = (): boolean => {
    const found = nodes(tree, id);
    if (found.length === 0) {
      return false;
    }
    return ([] as unknown[]).concat(found[0].props.children).join('') === text;
  };
  if (shows()) {
    return;
  }
  for (let i = 0; i < rounds; i += 1) {
    await flush();
    if (shows()) {
      return;
    }
  }
  throw new Error('never showed ' + id + ' as ' + text + '; showing ' + ids(tree).join(', '));
}
