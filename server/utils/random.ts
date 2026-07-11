/**
 * Fisher-Yates shuffle - unbiased, unlike a comparator-based
 * `.sort(() => Math.random() - 0.5)` shuffle which skews results.
 * Does not mutate the input array.
 */
export function shuffleArray<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Picks up to `count` random items from `items` without repeats. If
 * `items.length <= count`, returns a shuffled copy of the whole array.
 */
export function pickRandom<T>(items: T[], count: number): T[] {
  return shuffleArray(items).slice(0, count);
}
