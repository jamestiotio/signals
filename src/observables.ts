import { createScheduler, type Scheduler } from './scheduler';
import {
  CHILDREN,
  CONTEXT,
  DIRTY,
  DISPOSAL,
  DISPOSED,
  ERROR,
  OBSERVABLE,
  OBSERVERS,
  SCOPE,
} from './symbols';
import type {
  ComputedOptions,
  ContextRecord,
  Dispose,
  Effect,
  MaybeDispose,
  MaybeObservable,
  Observable,
  ObservableOptions,
  ObservableSubject,
  StopEffect,
} from './types';

interface Node {
  id?: string;
  (): any;
  [SCOPE]?: Node | null;
  [OBSERVABLE]?: boolean;
  [DIRTY]?: boolean;
  [DISPOSED]?: boolean;
  [CHILDREN]?: Set<Node> | null;
  [CONTEXT]?: ContextRecord | null;
  [DISPOSAL]?: Set<Dispose> | null;
}

let scheduler = createScheduler(),
  currentScope: Node | null = null,
  currentObserver: Node | null = null,
  NOOP = () => {};

// These are used only for debugging to determine how a cycle occurred.
let callStack: Node[], computeStack: Node[];

if (__DEV__) {
  callStack = [];
  computeStack = [];
  scheduler.onFlush(() => {
    callStack.length = 0;
  });
}

/**
 * Creates a computation root which is given a `dispose()` function to dispose of all inner
 * computations.
 *
 * @see {@link https://github.com/maverick-js/observables#root}
 */
export function root<T>(init: (dispose: Dispose) => T): T {
  const $root = { [SCOPE]: currentScope, [CHILDREN]: null } as unknown as Node;
  return compute($root, () => init(() => dispose($root)), null);
}

/**
 * Returns the current value stored inside a compute function without triggering a dependency.
 *
 * @see {@link https://github.com/maverick-js/observables#peek}
 */
export function peek<T>(compute: () => T): T {
  const prev = currentObserver;

  currentObserver = null;
  const result = compute();
  currentObserver = prev;

  return result;
}

/**
 * Returns the current value inside an observable whilst disabling both scope _and_ observer
 * tracking. Use `peek` if only observer tracking should be disabled.
 */
export function untrack<T>(compute: () => T): T {
  const prev = currentScope;

  currentScope = null;
  const result = peek(compute);
  currentScope = prev;

  return result;
}

/**
 * Wraps the given value into an observable function. The observable function will return the
 * current value when invoked `fn()`, and provide a simple write API via `set()` and `next()`. The
 * value can now be observed when used inside other computations created with `computed` and
 * `effect`.
 *
 * @see {@link https://github.com/maverick-js/observables#observable}
 */
export function observable<T>(
  initialValue: T,
  options?: ObservableOptions<T>,
): ObservableSubject<T> {
  let currentValue = initialValue,
    isDirty = options?.dirty ?? notEqual;

  const $observable: ObservableSubject<T> & Node = () => {
    if (__DEV__) callStack.push($observable);

    if (currentObserver) {
      if (!$observable[OBSERVERS]) $observable[OBSERVERS] = new Set();
      $observable[OBSERVERS].add(currentObserver);
    }

    return currentValue;
  };

  $observable.set = (nextValue: T) => {
    if (!$observable[DISPOSED] && isDirty(currentValue, nextValue)) {
      currentValue = nextValue!;
      if ($observable[OBSERVERS]?.size) notify($observable[OBSERVERS]);
    }
  };

  $observable.next = (next: (prevValue: T) => T) => {
    $observable.set(next(currentValue));
  };

  if (__DEV__) $observable.id = options?.id ?? 'observable';

  $observable[SCOPE] = currentScope;
  $observable[OBSERVABLE] = true;
  $observable[OBSERVERS] = null;

  if (currentScope) adopt($observable);

  return $observable;
}

/**
 * Whether the given value is an observable (readonly).
 *
 * @see {@link https://github.com/maverick-js/observables#isobservable}
 */
export function isObservable<T>(fn: MaybeObservable<T>): fn is Observable<T> {
  return !!fn?.[OBSERVABLE];
}

/**
 * Creates a new observable whose value is computed and returned by the given function. The given
 * compute function is _only_ re-run when one of it's dependencies are updated. Dependencies are
 * are all observables that are read during execution.
 *
 * @see {@link https://github.com/maverick-js/observables#computed}
 */
export function computed<T, R = never>(
  fn: () => T,
  options?: ComputedOptions<T, R>,
): Observable<T | R> {
  let currentValue,
    init = false,
    isDirty = options?.dirty ?? notEqual;

  const $computed: Observable<T> & Node = () => {
    if (__DEV__ && computeStack.includes($computed)) {
      const calls = callStack.map((c) => c.id ?? '?').join(' --> ');
      throw Error(`cyclic dependency detected\n\n${calls}\n`);
    }

    if (__DEV__) callStack.push($computed);

    // Computed is observing another computed.
    if (currentObserver) {
      if (!$computed[OBSERVERS]) $computed[OBSERVERS] = new Set();
      $computed[OBSERVERS].add(currentObserver);
    }

    if ($computed[DIRTY] && !$computed[DISPOSED]) {
      try {
        if ($computed[CHILDREN]?.size) {
          const children = $computed[CHILDREN];
          for (const child of children) dispose(child);
          children.clear();
        }

        if ($computed[DISPOSAL]?.size) {
          for (const dispose of $computed[DISPOSAL]) dispose();
          $computed[DISPOSAL].clear();
        }

        if (($computed[CONTEXT]?.[ERROR] as Set<any>)?.size) {
          ($computed[CONTEXT]![ERROR] as Set<any>).clear();
        }

        const nextValue = compute($computed, fn, $computed);
        if (isDirty(currentValue, nextValue)) {
          currentValue = nextValue;
          if ($computed[OBSERVERS]?.size) notify($computed[OBSERVERS]);
        }
      } catch (error) {
        if (__DEV__ && !__TEST__ && !init && (!options || !('fallback' in options))) {
          console.error(
            `computed \`${$computed.id}\` threw error during first run, this can be fatal.` +
              '\n\nSolutions:\n\n' +
              '1. Set the `fallback` option to silence this error',
            '\n2. Or, use an `effect` if the return value is not being used.',
            '\n\n',
            error,
          );
        }

        handleError($computed, error);
        return !init ? options?.fallback : currentValue;
      }

      init = true;
      $computed[DIRTY] = false;
    }

    return currentValue;
  };

  if (__DEV__) $computed.id = options?.id ?? `computed`;

  $computed[SCOPE] = currentScope;
  $computed[OBSERVABLE] = true;
  $computed[DIRTY] = true;
  $computed[CHILDREN] = null;
  $computed[OBSERVERS] = null;
  $computed[CONTEXT] = null;
  $computed[DISPOSAL] = null;

  if (currentScope) adopt($computed);
  return $computed;
}

let effectResult: any;

/**
 * Invokes the given function each time any of the observables that are read inside are updated
 * (i.e., their value changes). The effect is immediately invoked on initialization.
 *
 * @see {@link https://github.com/maverick-js/observables#effect}
 */
export function effect(fn: Effect, options?: { id?: string }): StopEffect {
  const $effect = computed(
    () => {
      effectResult = fn();
      effectResult && currentScope && onDispose(effectResult);
    },
    __DEV__ ? { id: options?.id ?? 'effect', fallback: null } : undefined,
  );

  $effect();
  return () => dispose($effect);
}

/**
 * Takes in the given observable and makes it read only by removing access to write
 * operations (i.e., `set()` and `next()`).
 *
 * @see {@link https://github.com/maverick-js/observables#readonly}
 */
export function readonly<T>(observable: Observable<T>): Observable<T> {
  const $readonly = () => observable();
  $readonly[OBSERVABLE] = true;
  return $readonly;
}

/**
 * Tasks are batched onto the microtask queue. This means only the last write of multiple write
 * actions performed in the same execution window is applied. You can wait for the microtask
 * queue to be flushed before writing a new value so it takes effect.
 *
 * @see {@link https://github.com/maverick-js/observables#tick}
 */
export function tick() {
  scheduler.flush();
  return scheduler.tick;
}

/**
 * Whether the given value is an observable subject (i.e., can produce new values via write API).
 *
 * @see {@link https://github.com/maverick-js/observables#issubject}
 */
export function isSubject<T>(fn: MaybeObservable<T>): fn is ObservableSubject<T> {
  return isObservable(fn) && 'set' in fn;
}

/**
 * Returns the owning scope of the given function. If no function is given it'll return the
 * currently executing parent scope. You can use this to walk up the computation tree.
 *
 * @see {@link https://github.com/maverick-js/observables#getscope}
 */
export function getScope(fn?: Observable<unknown>): Observable<unknown> | undefined {
  return !arguments.length ? currentScope : fn?.[SCOPE];
}

/**
 * Returns the global scheduler.
 *
 * @see {@link https://github.com/maverick-js/observables#getscheduler}
 */
export function getScheduler(): Scheduler {
  return scheduler;
}

/**
 * Scopes the given function to the current parent scope so context and error handling continue to
 * work as expected. Generally this should be called on non-observable functions. A scoped
 * function will return `undefined` if an error is thrown.
 *
 * This is more compute and memory efficient than the alternative `effect(() => peek(callback))`
 * because it doesn't require creating and tracking a `computed` observable.
 */
export function scope<T>(fn: () => T): () => T | undefined {
  fn[SCOPE] = currentScope;
  if (currentScope) adopt(fn);

  return () => {
    try {
      return compute(fn[SCOPE], fn, currentObserver);
    } catch (error) {
      handleError(fn, error);
    }
    return; // make TS happy -_-
  };
}

/**
 * Attempts to get a context value for the given key. It will start from the parent scope and
 * walk up the computation tree trying to find a context record and matching key. If no value can
 * be found `undefined` will be returned.
 *
 * @see {@link https://github.com/maverick-js/observables#getcontext}
 */
export function getContext<T>(key: string | symbol): T | undefined {
  return lookup(currentScope, key);
}

/**
 * Attempts to set a context value on the parent scope with the given key. This will be a no-op if
 * no parent is defined.
 *
 * @see {@link https://github.com/maverick-js/observables#setcontext}
 */
export function setContext<T>(key: string | symbol, value: T) {
  if (currentScope) (currentScope[CONTEXT] ??= {})[key] = value;
}

/**
 * Runs the given function when an error is thrown in a child scope. If the error is thrown again
 * inside the error handler, it will trigger the next available parent scope handler.
 *
 * @see {@link https://github.com/maverick-js/observables#onerror}
 */
export function onError<T = Error>(handler: (error: T) => void): void {
  if (!currentScope) return;
  (((currentScope[CONTEXT] ??= {})[ERROR] as Set<any>) ??= new Set()).add(handler);
}

/**
 * Runs the given function when the parent scope computation is being disposed.
 *
 * @see {@link https://github.com/maverick-js/observables#ondispose}
 */
export function onDispose(dispose: MaybeDispose): Dispose {
  if (!dispose || !currentScope) return dispose || NOOP;

  const scope = currentScope;

  if (!scope[DISPOSAL]) scope[DISPOSAL] = new Set();
  scope[DISPOSAL].add(dispose);

  return () => {
    (dispose as Dispose)();
    scope[DISPOSAL]?.delete(dispose as Dispose);
  };
}

/**
 * Unsubscribes the given observable and all inner computations. Disposed functions will retain
 * their current value but are no longer reactive.
 *
 * @see {@link https://github.com/maverick-js/observables#dispose}
 */
export function dispose(fn: () => void) {
  if (fn[CHILDREN]) {
    const children = fn[CHILDREN];
    // set to null first so children don't attempt removing themselves.
    fn[CHILDREN] = null;
    for (const child of children) dispose(child);
  }

  if (fn[DISPOSAL]) {
    for (const dispose of fn[DISPOSAL]) dispose();
    fn[DISPOSAL] = null;
  }

  if (fn[SCOPE]) {
    fn[SCOPE][CHILDREN]?.delete(fn);
    fn[SCOPE] = null;
  }

  fn[OBSERVERS] = null;
  fn[CONTEXT] = null;
  fn[DISPOSED] = true;
}

let prevScope: Node | null, prevObserver: Node | null;

function compute<T>(scope: Node, node: () => T, observer: Node | null): T {
  prevScope = currentScope;
  prevObserver = currentObserver;

  currentScope = scope;
  currentObserver = observer;
  if (__DEV__ && scope) computeStack.push(scope);

  try {
    return node();
  } finally {
    currentScope = prevScope;
    currentObserver = prevObserver;
    prevScope = null;
    prevObserver = null;
    if (__DEV__) computeStack.pop();
  }
}

function lookup(node: Node | null, key: string | symbol): any {
  let current: Node | null | undefined = node,
    value;

  while (current) {
    value = current[CONTEXT]?.[key];
    if (value !== undefined) return value;
    current = current[SCOPE];
  }
}

function adopt(node: Node) {
  if (!currentScope![CHILDREN]) currentScope![CHILDREN] = new Set();
  currentScope![CHILDREN]!.add(node);
}

function notify(observers: Set<Node>) {
  for (const observer of observers) {
    if (observer[DISPOSED]) {
      observers.delete(observer);
      continue;
    }

    observer[DIRTY] = true;
    scheduler.enqueue(observer);
  }
}

function handleError(node: Node | null, error: unknown) {
  const handlers = lookup(node, ERROR);
  if (!handlers) throw error;
  try {
    const coercedError = error instanceof Error ? error : Error(JSON.stringify(error));
    for (const handler of handlers) handler(coercedError);
  } catch (error) {
    handleError(node![SCOPE]!, error);
  }
}

function notEqual(a: unknown, b: unknown) {
  return a !== b;
}
