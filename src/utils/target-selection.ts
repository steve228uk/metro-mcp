import {
  classifyMetroTarget,
  selectBestTarget,
  type MetroServerInfo,
  type MetroTarget,
} from 'metro-bridge';

export interface MetroTargetPin {
  host: string;
  port: number;
  appId?: string;
  logicalDeviceId?: string;
  deviceName?: string;
  targetId: string;
}

export interface SelectedMetroTarget {
  server: MetroServerInfo;
  target: MetroTarget;
}

export function createMetroTargetPin(
  server: Pick<MetroServerInfo, 'host' | 'port'>,
  target: MetroTarget,
): MetroTargetPin {
  return {
    host: server.host,
    port: server.port,
    appId: target.appId,
    logicalDeviceId: target.reactNative?.logicalDeviceId,
    deviceName: target.deviceName,
    targetId: target.id,
  };
}

export function selectPinnedTarget(
  targets: MetroTarget[],
  pin: MetroTargetPin,
): MetroTarget | null {
  const attachable = targets.filter(
    (target) => classifyMetroTarget(target).attachable,
  );

  if (pin.appId && pin.logicalDeviceId) {
    const logicalMatch = attachable.find(
      (target) =>
        target.appId === pin.appId &&
        target.reactNative?.logicalDeviceId === pin.logicalDeviceId,
    );
    if (logicalMatch) return logicalMatch;
  }

  if (pin.appId && pin.deviceName) {
    const deviceMatch = attachable.find(
      (target) => {
        const logicalDeviceId = target.reactNative?.logicalDeviceId;
        return (
          target.appId === pin.appId &&
          target.deviceName === pin.deviceName &&
          (!pin.logicalDeviceId ||
            !logicalDeviceId ||
            logicalDeviceId === pin.logicalDeviceId)
        );
      },
    );
    if (deviceMatch) return deviceMatch;
  }

  const idMatch = attachable.find((target) => target.id === pin.targetId);
  if (!idMatch) return null;
  if (pin.appId && idMatch.appId !== pin.appId) return null;
  if (
    pin.logicalDeviceId &&
    idMatch.reactNative?.logicalDeviceId !== pin.logicalDeviceId
  ) {
    return null;
  }
  if (pin.deviceName && idMatch.deviceName !== pin.deviceName) return null;
  return idMatch;
}

export function selectMetroTarget(
  servers: MetroServerInfo[],
  pin: MetroTargetPin | null,
): SelectedMetroTarget | null {
  if (pin) {
    const server = servers.find(
      (candidate) =>
        candidate.host === pin.host && candidate.port === pin.port,
    );
    if (!server) return null;
    const target = selectPinnedTarget(server.targets, pin);
    return target ? { server, target } : null;
  }

  for (const server of servers) {
    const target = selectBestTarget(server.targets);
    if (target) return { server, target };
  }
  return null;
}
