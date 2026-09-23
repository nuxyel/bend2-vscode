export interface TestRunSelection<T> {
  key: string;
  item: T;
  children?: Iterable<T>;
}

/** Groups selected test items that share one executable proof target. */
export function groupTestCases<T>(selections: Iterable<TestRunSelection<T>>): Map<string, Set<T>> {
  const groups = new Map<string, Set<T>>();
  for (const selection of selections) {
    const cases = groups.get(selection.key) ?? new Set<T>();
    cases.add(selection.item);
    for (const child of selection.children ?? []) cases.add(child);
    groups.set(selection.key, cases);
  }
  return groups;
}
