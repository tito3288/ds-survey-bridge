import { describe, expect, it, vi } from 'vitest';
import type { DeliveryProviders } from './providers';
import type { DeliveryRepository } from './repository';
import { runDeliveryWorkerProcess } from './process';
import { DeliveryWorkerConfigurationError } from './worker';
import { DELIVERY_RUN_DEADLINE_MS } from './types';

const dependencies = {
  repository: {} as DeliveryRepository,
  providers: {} as DeliveryProviders,
};

function exitWith(code: number): never {
  throw new Error(`exit:${code}`);
}

describe('delivery worker process', () => {
  it('exits cleanly after one successful run and clears the hard stop', async () => {
    const clearHardTimeout = vi.fn();
    const run = vi.fn().mockResolvedValue({});

    await expect(
      runDeliveryWorkerProcess(dependencies, {
        runtime: {
          run,
          exit: exitWith,
          setHardTimeout: vi.fn().mockReturnValue('hard-stop'),
          clearHardTimeout,
        },
      }),
    ).rejects.toThrow('exit:0');
    expect(clearHardTimeout).toHaveBeenCalledWith('hard-stop');
  });

  it('installs a four-minute hard exit for hung provider sockets', () => {
    let hardStop: (() => void) | undefined;
    const exit = vi.fn(exitWith);
    const never = new Promise<never>(() => undefined);

    void runDeliveryWorkerProcess(dependencies, {
      runtime: {
        run: vi.fn(() => never),
        exit,
        setHardTimeout: (callback, milliseconds) => {
          expect(milliseconds).toBe(DELIVERY_RUN_DEADLINE_MS);
          hardStop = callback;
          return 'hard-stop';
        },
        clearHardTimeout: vi.fn(),
      },
    });

    expect(hardStop).toBeTypeOf('function');
    expect(() => hardStop?.()).toThrow('exit:1');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('logs only a sanitized configuration code before a disabled exit', async () => {
    const log = vi.fn();
    const exit = vi.fn(exitWith);

    await expect(
      runDeliveryWorkerProcess(
        { ...dependencies, logger: { log } },
        {
          runtime: {
            run: vi.fn().mockRejectedValue(
              new DeliveryWorkerConfigurationError(
                'delivery_worker_disabled',
                'raw environment detail',
              ),
            ),
            exit,
            setHardTimeout: vi.fn().mockReturnValue('hard-stop'),
            clearHardTimeout: vi.fn(),
          },
        },
      ),
    ).rejects.toThrow('exit:1');

    expect(log).toHaveBeenCalledWith({
      runId: 'worker-process',
      outcome: 'worker_failed',
      errorCode: 'delivery_worker_disabled',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      'raw environment detail',
    );
  });
});
