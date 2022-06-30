import {
  $root,
  $computed,
  $observable,
  $peek,
  $effect,
  $tick,
  $readonly,
  $dispose,
  isObservable,
  onDispose,
  isSubject,
  type Observable,
  type ObservableSubject,
} from '../src';

afterEach(() => $tick());

describe('$root', () => {
  it('should dispose of inner computations', async () => {
    const computeB = vi.fn();

    let $a: ObservableSubject<number>;
    let $b: Observable<number>;

    $root((dispose) => {
      $a = $observable(10);

      $b = $computed(() => {
        computeB();
        return $a() + 10;
      });

      $b();
      dispose();
    });

    expect($b!()).toBe(20);
    expect(computeB).toHaveBeenCalledTimes(1);

    await $tick();

    $a!.set(50);
    await $tick();

    expect($b!()).toBe(20);
    expect(computeB).toHaveBeenCalledTimes(1);
  });

  it('should return result', () => {
    const result = $root((dispose) => {
      dispose();
      return 10;
    });

    expect(result).toBe(10);
  });
});

describe('$observable', () => {
  it('should store and return value on read', () => {
    const $a = $observable(10);
    expect($a).toBeInstanceOf(Function);
    expect($a()).toBe(10);
  });

  it('should update observable via `set()`', () => {
    const $a = $observable(10);
    $a.set(20);
    expect($a()).toBe(20);
  });

  it('should update observable via `next()`', () => {
    const $a = $observable(10);
    $a.next((n) => n + 10);
    expect($a()).toBe(20);
  });
});

describe('isObservable', () => {
  it('should return true if given observable', () => {
    [$observable(10), $readonly($observable(10)), $computed(() => 10)].forEach((type) => {
      expect(isObservable(type)).toBe(true);
    });
  });

  it('should return false if given non-observable', () => {
    ([false, null, undefined, () => {}, $effect(() => {})] as const).forEach((type) =>
      expect(isObservable(type)).toBe(false),
    );
  });
});

describe('$computed', () => {
  it('should store and return value on read', async () => {
    const $a = $observable(10);
    const $b = $observable(10);
    const $c = $computed(() => $a() + $b());

    expect($c()).toBe(20);
    await $tick();

    // Try again to ensure state is maintained.
    expect($c()).toBe(20);
  });

  it('should update when dependency is updated', () => {
    const $a = $observable(10);
    const $b = $observable(10);
    const $c = $computed(() => $a() + $b());

    $a.set(20);
    expect($c()).toBe(30);

    $b.set(20);
    expect($c()).toBe(40);
  });

  it('should update when deep dependency is updated', async () => {
    const $a = $observable(10);
    const $b = $observable(10);
    const $c = $computed(() => $a() + $b());
    const $d = $computed(() => $c());

    $a.set(20);
    expect($d()).toBe(30);
  });

  it('should update when deep computed dependency is updated', () => {
    const $a = $observable(10);
    const $b = $observable(10);
    const $c = $computed(() => $a() + $b());
    const $d = $computed(() => $c());
    const $e = $computed(() => $d());

    $a.set(20);
    expect($e()).toBe(30);
  });

  it('should only re-compute when needed', () => {
    const compute = vi.fn();

    const $a = $observable(10);
    const $b = $observable(10);
    const $c = $computed(() => compute($a() + $b()));

    expect(compute).not.toHaveBeenCalled();

    $c();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(compute).toHaveBeenCalledWith(20);

    $c();
    expect(compute).toHaveBeenCalledTimes(1);

    $a.set(20);
    $c();
    expect(compute).toHaveBeenCalledTimes(2);

    $b.set(20);
    $c();
    expect(compute).toHaveBeenCalledTimes(3);

    $c();
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it('should only re-compute whats needed', async () => {
    const computeC = vi.fn();
    const computeD = vi.fn();

    const $a = $observable(10);
    const $b = $observable(10);
    const $c = $computed(() => {
      const a = $a();
      computeC(a);
      return a;
    });
    const $d = $computed(() => {
      const b = $b();
      computeD(b);
      return b;
    });
    const $e = $computed(() => $c() + $d());

    expect(computeC).not.toHaveBeenCalled();
    expect(computeD).not.toHaveBeenCalled();

    $e();
    expect(computeC).toHaveBeenCalledTimes(1);
    expect(computeD).toHaveBeenCalledTimes(1);
    expect($e()).toBe(20);

    $a.set(20);
    await $tick();

    $e();
    expect(computeC).toHaveBeenCalledTimes(2);
    expect(computeD).toHaveBeenCalledTimes(1);
    expect($e()).toBe(30);

    $b.set(20);
    await $tick();

    $e();
    expect(computeC).toHaveBeenCalledTimes(2);
    expect(computeD).toHaveBeenCalledTimes(2);
    expect($e()).toBe(40);
  });

  it('should throw on cyclic computation', () => {
    expect(() => {
      const $a = $computed(() => $b(), '$a');
      const $b = $computed(() => $a(), '$b');
      $b();
    }).toThrow(/cyclic dependency detected/);
  });
});

describe('$effect', () => {
  it('should run effect on change', async () => {
    const effect = vi.fn();

    const $a = $observable(10);
    const $b = $observable(10);
    const $c = $computed(() => $a() + $b());
    const $d = $computed(() => $c());

    $effect(() => {
      effect();
      $d();
    });

    expect(effect).to.toHaveBeenCalledTimes(1);

    $a.set(20);
    await $tick();
    expect(effect).to.toHaveBeenCalledTimes(2);

    $b.set(20);
    await $tick();
    expect(effect).to.toHaveBeenCalledTimes(3);

    $a.set(20);
    $b.set(20);
    await $tick();
    expect(effect).to.toHaveBeenCalledTimes(3);
  });

  it('should stop effect', async () => {
    const effect = vi.fn();

    const $a = $observable(10);

    const stop = $effect(() => {
      effect();
      $a();
    });

    stop();

    $a.set(20);
    await $tick();
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('should stop effect (deep)', async () => {
    const effect = vi.fn();

    const $a = $observable(10);
    const $b = $computed(() => $a());

    const stop = $effect(() => {
      effect();
      $b();
    });

    stop(true);

    $a.set(20);
    await $tick();

    expect(effect).toHaveBeenCalledTimes(1);
    expect($b()).toBe(10);
  });

  it('should call returned dispose function', async () => {
    const dispose = vi.fn();

    const $a = $observable(10);

    const stop = $effect(() => {
      $a();
      return dispose;
    });

    expect(dispose).toHaveBeenCalledTimes(0);

    $a.set(20);
    await $tick();
    expect(dispose).toHaveBeenCalledTimes(1);

    $a.set(30);
    await $tick();
    expect(dispose).toHaveBeenCalledTimes(2);

    stop();
    await $tick();
    expect(dispose).toHaveBeenCalledTimes(3);
  });
});

describe('$peek', () => {
  it('should not create dependency', async () => {
    const effect = vi.fn();
    const computeC = vi.fn();

    const $a = $observable(10);
    const $b = $computed(() => $a() + 10);
    const $c = $computed(() => {
      computeC();
      return $peek($b) + 10;
    });

    $effect(() => {
      effect();
      expect($peek($a)).toBe(10);
      expect($peek($b)).toBe(20);
      expect($peek($c)).toBe(30);
    });

    expect(effect).toHaveBeenCalledTimes(1);
    expect(computeC).toHaveBeenCalledTimes(1);

    $a.set(20);
    await $tick();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(computeC).toHaveBeenCalledTimes(1);
  });

  it('should not affect deep dependency being created', async () => {
    const effect = vi.fn();
    const computeD = vi.fn();

    const $a = $observable(10);
    const $b = $observable(10);
    const $c = $observable(10);
    const $d = $computed(() => {
      computeD();
      return $a() + $peek($b) + $peek($c) + 10;
    });

    $effect(() => {
      effect();
      expect($peek($a)).toBe(10);
      expect($peek($d)).toBe(40);
    });

    expect(effect).toHaveBeenCalledTimes(1);
    expect(computeD).toHaveBeenCalledTimes(1);
    expect($d()).toBe(40);

    $a.set(20);
    await $tick();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(computeD).toHaveBeenCalledTimes(2);
    expect($d()).toBe(50);

    $b.set(20);
    await $tick();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(computeD).toHaveBeenCalledTimes(2);
    expect($d()).toBe(50);

    $c.set(20);
    await $tick();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(computeD).toHaveBeenCalledTimes(2);
    expect($d()).toBe(50);
  });

  it('should not affect deep `onDispose`', async () => {
    const effect = vi.fn();
    const dispose = vi.fn();

    function runEffect() {
      $effect(() => {
        effect();
        onDispose(dispose);
      }, 'b');
    }

    const stop = $effect(() => {
      $peek(() => runEffect());
    }, 'a');

    stop(true);
    await $tick();

    expect(effect).to.toHaveBeenCalledTimes(1);
    expect(dispose).to.toHaveBeenCalledTimes(1);
  });
});

describe('$tick', () => {
  it('should batch updates', async () => {
    const effect = vi.fn();

    const $a = $observable(10);

    $effect(() => {
      effect();
      $a();
    });

    $a.set(20);
    $a.set(30);
    $a.set(40);

    expect(effect).to.toHaveBeenCalledTimes(1);
    await $tick();
    expect(effect).to.toHaveBeenCalledTimes(2);
  });

  it('should wait for queue to flush', async () => {
    const effect = vi.fn();

    const $a = $observable(10);

    $effect(() => {
      effect();
      $a();
    });

    expect(effect).to.toHaveBeenCalledTimes(1);

    $a.set(20);
    await $tick();
    expect(effect).to.toHaveBeenCalledTimes(2);

    $a.set(30);
    await $tick();
    expect(effect).to.toHaveBeenCalledTimes(3);
  });
});

describe('$readonly', () => {
  it('should create readonly proxy', async () => {
    const $a = $observable(10);
    const $b = $readonly($a);

    expect(() => {
      // @ts-expect-error
      $b.set(10);
    }).toThrow();

    expect(() => {
      // @ts-expect-error
      $b.next((n) => n + 10);
    }).toThrow();

    await $tick();
    expect($b()).toBe(10);

    $a.set(20);
    await $tick();
    expect($b()).toBe(20);
  });
});

describe('$dispose', () => {
  it('should dispose', async () => {
    const $a = $observable(10);
    const $b = $computed(() => $a() + 10);
    const $c = $observable(10);
    const $d = $computed(() => $c() + 10);
    const $e = $computed(() => $a() + $b() + $d());

    expect($e()).toBe(50);

    $dispose($a);

    $a.set(20);
    await $tick();

    expect($b()).toBe(20);
    expect($e()).toBe(50);

    // $c/$d should keep working.
    $c.set(20);
    await $tick();
    expect($d()).toBe(30);
  });

  it('should dispose (deep)', async () => {
    const $a = $observable(10);
    const $_b = $observable(20);
    const $b = $computed(() => $_b());
    const $c = $computed(() => $a() + $b() + 10);
    const $d = $computed(() => $a() + $c() + 10);
    const $e = $computed(() => $a() + $c() + $d());

    $e();

    $dispose($e, true);

    $a.set(20);
    await $tick();

    expect($a()).toBe(10);
    expect($c()).toBe(40);
    expect($d()).toBe(60);
    expect($e()).toBe(110);

    $_b.set(100);
    expect($b()).to.equal(20);
  });
});

describe('isSubject', () => {
  it('should return true given subject', () => {
    expect(isSubject($observable(10))).toBe(true);
  });

  it('should return false if given non-subject', () => {
    (
      [false, () => {}, $computed(() => 10), $readonly($observable(10)), $effect(() => {})] as const
    ).forEach((type) => expect(isSubject(type)).toBe(false));
  });
});

describe('onDispose', () => {
  it('should be invoked when computation is disposed', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    const callback3 = vi.fn();

    const stop = $effect(() => {
      onDispose(callback1);
      onDispose(callback2);
      onDispose(callback3);
    });

    stop();

    expect(callback1).toHaveBeenCalled();
    expect(callback2).toHaveBeenCalled();
    expect(callback3).toHaveBeenCalled();
  });

  it('should clear dispose early', async () => {
    const dispose = vi.fn();

    const stop = $effect(() => {
      const early = onDispose(dispose);
      early();
    });

    expect(dispose).toHaveBeenCalledTimes(1);

    stop();
    await $tick();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
