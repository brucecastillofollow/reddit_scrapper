import { config } from '../config.js';

export function shortenInterval(seconds) {
  return Math.max(config.intervalMinSeconds, Math.floor(seconds * config.intervalShrinkFactor));
}

export function lengthenInterval(seconds) {
  return Math.min(config.intervalMaxSeconds, Math.floor(seconds * config.intervalGrowFactor));
}

export function shouldAdjustInterval(existingCount, newCount, total) {
  const allNew = total > 0 && existingCount === 0;
  const mostlyExisting = existingCount > config.existingThreshold;
  return { allNew, mostlyExisting };
}
