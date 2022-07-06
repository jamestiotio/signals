import { createScheduler, type Scheduler } from './scheduler';

export type Observable<T> = {
  id?: string;
  (): T;
};

export type ObservableSubject<T> = Observable<T> & {
  set: (value: T) => void;
  next: (next: (prevValue: T) => T) => void;
};

export type Dispose = () => void;
export type Effect = () => MaybeStopEffect;
export type StopEffect = () => void;

export type Maybe<T> = T | void | null | undefined | false;
export type MaybeFunction = Maybe<(...args: any) => any>;
export type MaybeDispose = Maybe<Dispose>;
export type MaybeStopEffect = Maybe<StopEffect>;
export type MaybeObservable<T> = MaybeFunction | Observable<T>;

const NOOP = () => {};

const OBSERVABLE = Symbol();
const COMPUTED = Symbol();
const DIRTY = Symbol();
const DISPOSED = Symbol();
const OBSERVERS = Symbol();
const CHILDREN = Symbol();
const DISPOSAL = Symbol();

const _scheduler = __DEV__
  ? createScheduler(() => {
      _callStack = [];
    })
  : createScheduler();

let _computation: Node | undefined;

// These are used only for debugging to determine how a cycle occurred.
let _callStack: Node[] = [];
let _computeStack: Node[] = [];

/**
 * Creates a computation root which is given a `dispose()` function to dispose of all inner
 * computations.
 *
 * @example
 * ```js
 * const result = $root((dispose) => {
 *   // ...
 *   dispose();
 *   return 10;
 * });
 *
 * console.log(result); // logs `10`
 * ```
 */
export function $root<T>(fn: (dispose: Dispose) => T): T {
  const $root = () => fn(dispose);
  const dispose = () => $dispose($root);
  return compute($root, $root);
}

/**
 * Returns the current value stored inside an observable without triggering a dependency.
 *
 * @example
 * ```js
 * const $a = $observable(10);
 *
 * $computed(() => {
 *  // `$a` will not be considered a dependency.
 *  const value = $peek($a);
 * });
 * ```
 */
export function $peek<T>(fn: () => T): T {
  const prev = _computation;

  _computation = undefined;
  const result = fn();
  _computation = prev;

  return result;
}

/**
 * Wraps the given value into an observable function. The observable function will return the
 * current value when invoked `fn()`, and provide a simple write API via `set()` and `next()`. The
 * value can now be observed when used inside other computations created with `$computed` and
 * `$effect`.
 *
 * @example
 * ```
 * const $a = $observable(10);
 *
 * $a(); // read
 * $a.set(20); // write (1)
 * $a.next(prev => prev + 10); // write (2)
 * ```
 */
export function $observable<T>(
  initialValue: T,
  opts?: { id?: string; dirty?: (prev: T, next: T) => boolean },
): ObservableSubject<T> {
  let currentValue = initialValue;

  const isDirty = opts?.dirty ?? notEqual;

  const $observable: ObservableSubject<T> = () => {
    if (__DEV__) _callStack.push($observable);
    if (_computation) addObserver($observable, _computation);
    return currentValue;
  };

  $observable.set = (nextValue: T) => {
    if (!$observable[DISPOSED] && isDirty(currentValue, nextValue)) {
      currentValue = nextValue!;
      dirtyNode($observable);
    }
  };

  $observable.next = (next: (prevValue: T) => T) => {
    $observable.set(next(currentValue));
  };

  if (__DEV__) $observable.id = opts?.id ?? '$observable';

  $observable[OBSERVABLE] = true;

  adoptChild($observable);

  return $observable;
}

/**
 * Whether the given value is an observable (readonly).
 *
 * @example
 * ```js
 * // True
 * isObservable($observable(10));
 * isObservable($computed(() => 10));
 * isObservable($readonly($observable(10)));
 * // False
 * isObservable(false);
 * isObservable(null);
 * isObservable(undefined);
 * isObservable(() => {});
 * ```
 */
export function isObservable<T>(fn: MaybeObservable<T>): fn is Observable<T> {
  return !!fn?.[OBSERVABLE];
}

/**
 * Creates a new observable whose value is computed and returned by the given function. The given
 * compute function is _only_ re-run when one of it's dependencies are updated. Dependencies are
 * are all observables that are read during execution.
 *
 * @example
 *
 * ```js
 * const $a = $observable(10);
 * const $b = $observable(10);
 * const $c = $computed(() => $a() + $b());
 *
 * console.log($c()); // logs 20
 *
 * $a.set(20);
 * await $tick();
 * console.log($c()); // logs 30
 *
 * $b.set(20);
 * await $tick();
 * console.log($c()); // logs 40
 * ```
 */
export function $computed<T>(fn: () => T, opts?: { id?: string }): Observable<T> {
  let currentValue;

  const $computed: Observable<T> = () => {
    if (__DEV__ && _computeStack.includes($computed)) {
      const calls = _callStack.map((c) => c.id ?? '?').join(' --> ');
      throw Error(`cyclic dependency detected\n\n${calls}\n`);
    }

    if (__DEV__) _callStack.push($computed);

    // Computed is observing another computed.
    if (_computation) addObserver($computed, _computation);

    if (!$computed[DISPOSED] && $computed[DIRTY]) {
      forEachChild($computed, $dispose);
      emptyDisposal($computed);
      currentValue = compute($computed, fn);
      $computed[DIRTY] = false;
      dirtyNode($computed);
    }

    return currentValue;
  };

  if (__DEV__) $computed.id = opts?.id ?? `$computed`;

  // Starts off dirty because it hasn't run yet.
  $computed[DIRTY] = true;
  $computed[OBSERVABLE] = true;
  $computed[COMPUTED] = true;

  adoptChild($computed);

  return $computed;
}

/**
 * Runs the given function when the parent computation is being disposed.
 *
 * @example
 * ```js
 * const listen = (type, callback) => {
 *   window.addEventListener(type, callback);
 *   onDispose(() => window.removeEventListener(type, callback));
 * };
 *
 * const stop = $effect(() => {
 *   // This will be disposed of when the effect is.
 *   // Also called when the effect is re-run.
 *   listen('click', () => {
 *     // ...
 *   });
 * });
 *
 * stop(); // `onDispose` is called
 * ```
 */
export function onDispose(fn?: MaybeDispose): Dispose {
  const valid = fn && _computation;

  if (valid) addNode(_computation!, DISPOSAL, fn as Dispose);

  return valid
    ? () => {
        (fn as Dispose)();
        _computation![DISPOSAL]?.delete(fn as Dispose);
      }
    : NOOP;
}

/**
 * Unsubscribes the given observable and all inner computations. Disposed functions will retain
 * their current value but are no longer reactive.
 *
 * @example
 * ```js
 * const $a = $observable(10);
 * const $b = $computed(() => $a());
 *
 * // `$b` will no longer update if `$a` is updated.
 * $dispose($a);
 *
 * $a.set(100);
 * console.log($b()); // still logs `10`
 * ```
 */
export function $dispose(fn: () => void) {
  forEachChild(fn, (child) => {
    $dispose(child);
    child[OBSERVERS]?.delete(fn);
  });

  emptyDisposal(fn);

  unrefSet(fn, CHILDREN);
  unrefSet(fn, DISPOSAL);
  unrefSet(fn, OBSERVERS);

  fn[DIRTY] = false;
  fn[DISPOSED] = true;
}

/**
 * Invokes the given function each time any of the observables that are read inside are updated
 * (i.e., their value changes). The effect is immediately invoked on initialization.
 *
 * @example
 * ```js
 * const $a = $observable(10);
 * const $b = $observable(20);
 * const $c = $computed(() => $a() + $b());
 *
 * // This effect will run each time `$a` or `$b` is updated.
 * const stop = $effect(() => console.log($c()));
 *
 * stop();
 * ```
 */
export function $effect(fn: Effect, opts?: { id?: string }): StopEffect {
  const $effect = $computed(() => onDispose(fn()), {
    id: __DEV__ ? opts?.id ?? '$effect' : opts?.id,
  });

  $effect();
  return () => $dispose($effect);
}

/**
 * Takes in the given observable and makes it read only by removing access to write
 * operations (i.e., `set()` and `next()`).
 *
 * @example
 * ```js
 * const $a = $observable(10);
 * const $b = $readonly($a);
 *
 * console.log($b()); // logs 10
 *
 * // We can still update value through `$a`.
 * $a.set(20);
 *
 * console.log($b()); // logs 20
 * ```
 */
export function $readonly<T>($observable: Observable<T>): Observable<T> {
  const $readonly = () => $observable();
  $readonly[OBSERVABLE] = true;
  return $readonly;
}

/**
 * Tasks are batched onto the microtask queue. This means only the last write of multiple write
 * actions performed in the same execution window is applied. You can wait for the microtask
 * queue to be flushed before writing a new value so it takes effect.
 *
 * @example
 * ```js
 * const $a = $observable(10);
 *
 * $a.set(10);
 * $a.set(20);
 * $a.set(30); // only this write is applied
 *
 * // ----
 *
 * // All writes are applied
 * $a.set(10);
 * await $tick();
 * $a.set(20);
 * await $tick();
 * $a.set(30);
 * ```
 */
export function $tick() {
  _scheduler.flush();
  return _scheduler.tick;
}

/**
 * Whether the given value is an observable subject (i.e., can produce new values via write API).
 *
 * @example
 * ```js
 * // True
 * isSubject($observable(10));
 * // False
 * isSubject(false);
 * isSubject(null);
 * isSubject(undefined);
 * isSubject(() => {});
 * isSubject($computed(() => 10));
 * isSubject($readonly($observable(10)));
 * ```
 */
export function isSubject<T>(fn: MaybeObservable<T>): fn is ObservableSubject<T> {
  return isObservable(fn) && !!(fn as ObservableSubject<T>).set;
}

/**
 * Returns the global scheduler.
 */
export function getScheduler(): Scheduler {
  return _scheduler;
}

type Node = {
  id?: string;
  (): any;
  [OBSERVABLE]?: boolean;
  [COMPUTED]?: boolean;
  [DIRTY]?: boolean;
  [DISPOSED]?: boolean;
  [OBSERVERS]?: Set<Node>;
  [CHILDREN]?: Set<Node>;
  [DISPOSAL]?: Set<Dispose>;
};

function compute<T>(parent: () => void, child: () => T): T {
  const prevComputation = _computation;
  _computation = parent;
  if (__DEV__) _computeStack.push(parent);

  const nextValue = child();

  _computation = prevComputation;
  if (__DEV__) _computeStack.pop();

  return nextValue;
}

function adoptChild(node: Node) {
  if (_computation) addChild(_computation, node);
}

function addChild(node: Node, child: Node) {
  addNode(node, CHILDREN, child);
}

function addObserver(node: Node, observer: Node) {
  addNode(node, OBSERVERS, observer);
}

function addNode(node: Node, key: symbol, item: () => void) {
  if (!node[DISPOSED]) (node[key] ??= new Set<() => void>()).add(item);
}

function dirtyNode(node: Node) {
  if (node[OBSERVERS] && !_scheduler.served(node)) {
    for (const observer of node[OBSERVERS]!) {
      if (observer[COMPUTED] && observer !== _computation) {
        observer[DIRTY] = true;
        _scheduler.enqueue(observer);
      }
    }
  }
}

function forEachChild(node: Node, callback: (node: Node) => void) {
  if (node[CHILDREN]) for (const child of node[CHILDREN]!) callback(child);
}

function emptyDisposal(node: Node) {
  if (node[DISPOSAL]) {
    for (const dispose of node[DISPOSAL]!) dispose();
    node[DISPOSAL]!.clear();
  }
}

function unrefSet(parent: any, key: symbol) {
  parent[key] = undefined;
}

function notEqual(a: unknown, b: unknown) {
  return a !== b;
}
