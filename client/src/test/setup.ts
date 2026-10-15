/**
 * Vitest global setup.
 *
 * Registers the jest-dom matchers (`toBeInTheDocument`, `toHaveTextContent`, …)
 * so component tests read cleanly. Everything else stays in the individual
 * test files.
 */
import '@testing-library/jest-dom/vitest';

/**
 * Node >= 22 installs its own `localStorage` global, which returns `undefined`
 * unless the process was started with `--localstorage-file`. That accessor wins
 * over the jsdom one, so `localStorage` is `undefined` under Vitest and any
 * assertion about persistent storage would fail for the wrong reason.
 *
 * This installs a spec-shaped in-memory Storage **only** when the environment
 * did not provide a usable one, so the suite behaves identically on Node 20,
 * 22, and 24+. It is test scaffolding: nothing in `src/` depends on it.
 */
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.map.get(String(key)) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.map.delete(String(key));
  }

  clear(): void {
    this.map.clear();
  }
}

function isUsableStorage(candidate: unknown): boolean {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as Storage).getItem === 'function' &&
    typeof (candidate as Storage).length === 'number'
  );
}

if (!isUsableStorage(window.localStorage)) {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
}

if (!isUsableStorage(window.sessionStorage)) {
  const storage = new MemoryStorage();
  Object.defineProperty(window, 'sessionStorage', { value: storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true, writable: true });
}