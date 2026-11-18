import type { Logger } from 'homebridge';

type Params = Record<string, unknown>;
type SendFunction = (sn: string, params: Params) => void;

export interface CommandQueueOptions {
  // Minimum time between two commands to the same device (0 turns the queue off)
  commandIntervalMs: number;
  // How long a new batch waits for more writes before it is sent
  commandCoalesceMs: number;
  // How long to wait for the device to confirm a command before resending it once (0 turns resends off)
  commandConfirmTimeoutMs: number;
}

// Defaults and allowed ranges for the top-level platform config keys
const OPTION_LIMITS: Record<keyof CommandQueueOptions, {default: number; min: number; max: number}> = {
  commandIntervalMs: {default: 600, min: 0, max: 5000},
  commandCoalesceMs: {default: 100, min: 0, max: 1000},
  commandConfirmTimeoutMs: {default: 3000, min: 0, max: 15000},
};

// A device that keeps ignoring commands is warned about at most this often
const WARN_INTERVAL = 10 * 60 * 1000;

// Keys that control a fan's light. A device applies these separately from the fan itself.
const LIGHT_KEYS = new Set(['lighton', 'brightness', 'colortemp']);

type Part = 'main' | 'light' | 'mixed';

interface Batch {
  params: Params;
  part: Part;
  createdAt: number;
  // A resend is never merged with other writes and never resent again
  resend: boolean;
}

// A sent batch waiting for the device to report the new state
interface Sent {
  params: Params;
  resend: boolean;
  // Number of writes to the device when this batch was sent; any newer write cancels the resend
  writes: number;
  timer: NodeJS.Timeout;
}

interface DeviceQueue {
  // Unsent batches, oldest first
  batches: Batch[];
  lastSentAt: number;
  timer?: NodeJS.Timeout;
  // Number of writes enqueued so far, resends excluded
  writes: number;
  awaiting: Sent[];
  lastWarnAt: number;
}

// The fields of an incoming Dreo message that confirmation looks at
export interface DeviceMessage {
  devicesn: string;
  method?: unknown;
  reported?: unknown;
}

// Read the pacing options from the platform config. Missing values use the default; invalid ones
// use the default and say so.
export function validateCommandQueueOptions(config: Record<string, unknown> | undefined, log: Logger): CommandQueueOptions {
  const read = (key: keyof CommandQueueOptions) => {
    const limits = OPTION_LIMITS[key];
    const value = config?.[key];
    if (value === undefined || value === null) {
      return {value: limits.default, explicit: false};
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < limits.min || value > limits.max) {
      log.warn('Invalid %s (expected a whole number from %d to %d), using %d', key, limits.min, limits.max, limits.default);
      return {value: limits.default, explicit: false};
    }
    return {value: value, explicit: true};
  };

  const interval = read('commandIntervalMs');
  const coalesce = read('commandCoalesceMs');
  const confirm = read('commandConfirmTimeoutMs');

  // A batch can never wait longer than the interval, otherwise pacing would hold back an idle device
  if (coalesce.value > interval.value) {
    if (coalesce.explicit) {
      log.warn('commandCoalesceMs cannot be more than commandIntervalMs, using %d', interval.value);
    }
    coalesce.value = interval.value;
  }

  return {
    commandIntervalMs: interval.value,
    commandCoalesceMs: coalesce.value,
    commandConfirmTimeoutMs: confirm.value,
  };
}

/**
 * Per-device send queue for control commands.
 *
 * Dreo devices silently drop commands that arrive within a few hundred milliseconds of each other,
 * which is exactly what a HomeKit scene produces. Writes to the same device are merged into one
 * command where possible, and the remaining commands are spaced out so each one is applied.
 * Devices never wait on each other.
 */
export default class CommandQueue {
  private readonly devices = new Map<string, DeviceQueue>();
  private readonly intervalMs: number;
  private readonly coalesceMs: number;
  private readonly confirmTimeoutMs: number;
  private stopped = false;

  constructor(
    private readonly send: SendFunction,
    private readonly log: Logger,
    options: CommandQueueOptions,
  ) {
    this.intervalMs = options.commandIntervalMs;
    this.coalesceMs = options.commandCoalesceMs;
    this.confirmTimeoutMs = options.commandConfirmTimeoutMs;
  }

  // Accept commands again after stop()
  public start() {
    this.stopped = false;
  }

  public enqueue(sn: string, params: Params) {
    this.add(sn, params, false);
  }

  // Confirm sent commands from the device's own reports. A 'control-reply' only comes from the cloud
  // and is sent even when the device ignored the command, so it does not count.
  public handleMessage(msg: DeviceMessage) {
    if (msg.method !== 'control-report' && msg.method !== 'report') {
      return;
    }
    const device = this.devices.get(msg.devicesn);
    if (!device || device.awaiting.length === 0 || !msg.reported || typeof msg.reported !== 'object') {
      return;
    }
    const reported = msg.reported as Params;
    device.awaiting = device.awaiting.filter((sent) => {
      if (!Object.keys(sent.params).some((key) => key in reported)) {
        return true;
      }
      clearTimeout(sent.timer);
      return false;
    });
  }

  private add(sn: string, params: Params, resend: boolean) {
    // Queue off: send straight away, exactly as before pacing existed
    if (this.intervalMs === 0) {
      this.send(sn, params);
      return;
    }
    if (this.stopped) {
      this.log.debug('Command queue stopped, dropping command for %s', sn);
      return;
    }

    const device = this.getDevice(sn);
    if (!resend) {
      device.writes++;
    }
    const now = Date.now();
    const keys = Object.keys(params);
    const part = partOf(keys);
    const newest = device.batches[device.batches.length - 1];

    if (newest && !resend && !newest.resend && part !== 'mixed' && newest.part === part &&
      (now - newest.createdAt < this.coalesceMs || keys.every((key) => key in newest.params))) {
      Object.assign(newest.params, params);
      this.log.debug('Merged command for %s into pending batch (keys: %s)', sn, Object.keys(newest.params).join(', '));
    } else {
      device.batches.push({params: {...params}, part: part, createdAt: now, resend: resend});
    }
    this.schedule(sn, device);
  }

  // Clear every timer and drop anything still queued (called on Homebridge shutdown)
  public stop() {
    this.stopped = true;
    let dropped = 0;
    this.devices.forEach((device) => {
      if (device.timer) {
        clearTimeout(device.timer);
        device.timer = undefined;
      }
      dropped += device.batches.length;
      device.batches = [];
      device.awaiting.forEach((sent) => clearTimeout(sent.timer));
      device.awaiting = [];
    });
    this.log.debug('Command queue stopped, dropped %d queued command(s)', dropped);
  }

  private getDevice(sn: string) {
    let device = this.devices.get(sn);
    if (!device) {
      device = {batches: [], lastSentAt: -Infinity, writes: 0, awaiting: [], lastWarnAt: -Infinity};
      this.devices.set(sn, device);
    }
    return device;
  }

  // Time at which the oldest batch may be sent
  private dueAt(device: DeviceQueue, batch: Batch) {
    return Math.max(batch.createdAt + this.coalesceMs, device.lastSentAt + this.intervalMs);
  }

  // Arm the device's single timer for its oldest batch, unless it is already armed
  private schedule(sn: string, device: DeviceQueue) {
    if (device.timer || device.batches.length === 0 || this.stopped) {
      return;
    }
    const delay = Math.max(0, this.dueAt(device, device.batches[0]) - Date.now());
    device.timer = setTimeout(() => {
      device.timer = undefined;
      this.flush(sn, device);
    }, delay);
  }

  private flush(sn: string, device: DeviceQueue) {
    const batch = device.batches[0];
    if (!batch || this.stopped) {
      return;
    }
    const now = Date.now();
    if (now < this.dueAt(device, batch)) {
      // Timer fired a little early; try again
      this.schedule(sn, device);
      return;
    }

    device.batches.shift();
    device.lastSentAt = now;
    this.log.debug('Sending command to %s (keys: %s)', sn, Object.keys(batch.params).join(', '));
    try {
      this.send(sn, batch.params);
    } catch (error) {
      this.log.warn('Could not send command to Dreo device %s: %s', sn, (error as Error)?.message ?? error);
    }
    this.awaitConfirmation(sn, device, batch);
    this.schedule(sn, device);
  }

  // Resend a batch once if the device doesn't report the change in time
  private awaitConfirmation(sn: string, device: DeviceQueue, batch: Batch) {
    if (this.confirmTimeoutMs === 0) {
      return;
    }
    const sent: Sent = {
      params: batch.params,
      resend: batch.resend,
      writes: device.writes,
      timer: setTimeout(() => {
        device.awaiting = device.awaiting.filter((other) => other !== sent);
        this.unconfirmed(sn, device, sent);
      }, this.confirmTimeoutMs),
    };
    device.awaiting.push(sent);
  }

  private unconfirmed(sn: string, device: DeviceQueue, sent: Sent) {
    const keys = Object.keys(sent.params).join(', ');
    if (sent.resend) {
      const now = Date.now();
      if (now - device.lastWarnAt >= WARN_INTERVAL) {
        device.lastWarnAt = now;
        this.log.warn('Dreo device %s did not confirm %s after a resend', sn, keys);
      }
      return;
    }
    if (this.stopped || device.writes !== sent.writes) {
      // Stopped, or a newer write has replaced this one
      return;
    }
    this.log.debug('Dreo device %s did not confirm %s, resending', sn, keys);
    this.add(sn, sent.params, true);
  }
}

// Which part of the device a write controls
function partOf(keys: string[]): Part {
  const light = keys.filter((key) => LIGHT_KEYS.has(key)).length;
  if (light === 0) {
    return 'main';
  }
  return light === keys.length ? 'light' : 'mixed';
}
