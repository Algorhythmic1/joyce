import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { isTauri } from "./fs";

/** Where Joyce's sync server is deployed (see sync-server/). Editable in the Sync panel. */
export const DEFAULT_SYNC_SERVER: string =
  import.meta.env.VITE_JOYCE_SYNC_SERVER ?? "https://joyce-sync.7vwvwnd56t.workers.dev";

export type SyncStatus =
  | { state: "syncing" }
  | { state: "idle"; lastSync: number }
  | { state: "offline"; message: string }
  | { state: "removed" }
  | { state: "error"; message: string };

export interface SyncInfo {
  enabled: boolean;
  server: string | null;
  root: string | null;
  deviceName: string;
  status: SyncStatus | null;
}

export interface SyncDevice {
  id: string;
  name: string;
  created: number;
  lastSeen: number;
  current: boolean;
}

export const syncAvailable = isTauri;

export const syncInfo = () => invoke<SyncInfo>("sync_info");
export const enableSync = (server: string, root: string) => invoke<void>("sync_enable", { server, root });
export const joinSync = (server: string, code: string, root: string) => invoke<void>("sync_join", { server, code, root });
export const pairingCode = () => invoke<{ code: string; expires: number }>("sync_pairing_code");
export const syncDevices = () => invoke<SyncDevice[]>("sync_devices");
export const removeDevice = (id: string) => invoke<void>("sync_remove_device", { id });
export const disableSync = () => invoke<void>("sync_disable");
export const syncNow = () => invoke<void>("sync_now");

/** Sync setup and live status, refreshed as the engine reports progress. */
export function useSync() {
  const [info, setInfo] = useState<SyncInfo | null>(null);
  const reload = () => {
    if (syncAvailable) syncInfo().then(setInfo).catch(() => {});
  };
  useEffect(() => {
    if (!syncAvailable) return;
    reload();
    const off = listen<SyncStatus>("sync://status", (e) => setInfo((i) => (i ? { ...i, status: e.payload } : i)));
    return () => void off.then((f) => f());
  }, []);
  return { info, reload };
}

/** Calls `fn` with paths (relative to the writing folder) that other computers changed. */
export function onRemoteChanges(fn: (paths: string[]) => void) {
  if (!syncAvailable) return () => {};
  const off = listen<string[]>("sync://changed", (e) => fn(e.payload));
  return () => void off.then((f) => f());
}
