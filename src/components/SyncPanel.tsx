import { useEffect, useState } from "react";
import { basename } from "../fs";
import {
  DEFAULT_SYNC_SERVER, disableSync, enableSync, joinSync, pairingCode, removeDevice, syncAvailable, syncDevices, syncNow,
  type SyncDevice, type SyncInfo, type SyncStatus,
} from "../sync";

interface Props {
  info: SyncInfo | null;
  reload: () => void;
  /** The writing folder open now. */
  root: string;
}

const SERVER_KEY = "joyce:sync-server";

function ago(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function statusText(status: SyncStatus | null | undefined) {
  switch (status?.state) {
    case "syncing":
      return "Syncing…";
    case "idle":
      return `Up to date · ${ago(status.lastSync)}`;
    case "offline":
      return "Offline. Will sync when the connection's back.";
    case "removed":
      return "This computer was removed from sync.";
    case "error":
      return status.message;
    default:
      return "Starting…";
  }
}

export function SyncPanel({ info, reload, root }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (!syncAvailable) {
    body = <p className="hint">Sync is available in the desktop app.</p>;
  } else if (!info) {
    body = <p className="hint">Checking…</p>;
  } else if (!info.enabled) {
    body = <SetUp root={root} busy={busy} run={run} />;
  } else if (info.root !== root) {
    body = (
      <>
        <p>
          Sync is set up for <strong>{basename(info.root ?? "")}</strong>. Open that folder to work on synced writing.
        </p>
        <button className="secondary" disabled={busy} onClick={() => run(disableSync)}>
          Turn off sync on this computer
        </button>
      </>
    );
  } else {
    body = <Syncing info={info} busy={busy} run={run} />;
  }

  return (
    <div className="panel sync-panel" onMouseDown={(e) => e.stopPropagation()}>
      <h2>Sync</h2>
      {body}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function SetUp({ root, busy, run }: { root: string; busy: boolean; run: (fn: () => Promise<unknown>) => void }) {
  const [server, setServer] = useState(() => localStorage.getItem(SERVER_KEY) ?? DEFAULT_SYNC_SERVER);
  const [mode, setMode] = useState<"start" | "join">("start");
  const [code, setCode] = useState("");
  const remember = () => localStorage.setItem(SERVER_KEY, server.trim());

  return (
    <>
      <p className="hint">
        Keeps <strong>{basename(root)}</strong> the same on all your computers. Everything is encrypted on this
        computer before it's sent; the server can't read your writing, or even its file names.
      </p>
      <div className="segmented small two">
        <button className={mode === "start" ? "selected" : ""} onClick={() => setMode("start")}>First computer</button>
        <button className={mode === "join" ? "selected" : ""} onClick={() => setMode("join")}>Join with a code</button>
      </div>
      <label className="field">
        <span>Sync server</span>
        <input value={server} onChange={(e) => setServer(e.currentTarget.value)} placeholder="https://joyce-sync.…workers.dev" spellCheck={false} />
      </label>
      {mode === "start" ? (
        <button
          className="primary"
          disabled={busy || !server.trim()}
          onClick={() => {
            remember();
            run(() => enableSync(server.trim(), root));
          }}
        >
          {busy ? "Setting up…" : "Start syncing this folder"}
        </button>
      ) : (
        <>
          <label className="field">
            <span>Pairing code from another computer</span>
            <input
              className="code-input"
              value={code}
              onChange={(e) => setCode(e.currentTarget.value)}
              placeholder="K7Q2-9XMB-4TRW"
              spellCheck={false}
              autoCapitalize="characters"
            />
          </label>
          <p className="hint">
            Files from the other computers are added to <strong>{basename(root)}</strong>. If something here has the same
            name but different contents, both versions are kept.
          </p>
          <button
            className="primary"
            disabled={busy || !server.trim() || code.replace(/[^a-z0-9]/gi, "").length < 12}
            onClick={() => {
              remember();
              run(() => joinSync(server.trim(), code, root));
            }}
          >
            {busy ? "Joining…" : "Join"}
          </button>
        </>
      )}
    </>
  );
}

function Syncing({ info, busy, run }: { info: SyncInfo; busy: boolean; run: (fn: () => Promise<unknown>) => void }) {
  const [code, setCode] = useState<{ code: string; expires: number } | null>(null);
  const [devices, setDevices] = useState<SyncDevice[] | null>(null);
  const [, tick] = useState(0);

  const loadDevices = () => syncDevices().then(setDevices).catch(() => setDevices(null));
  useEffect(() => {
    loadDevices();
    // Keeps "x min ago" and the code's countdown current.
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  const removed = info.status?.state === "removed";
  const minutesLeft = code ? Math.max(0, Math.round((code.expires - Date.now()) / 60_000)) : 0;

  return (
    <>
      <p className={`sync-status ${info.status?.state ?? ""}`}>
        <span className="sync-dot" />
        {statusText(info.status)}
        {!removed && (
          <button className="link-button" disabled={busy} onClick={() => syncNow()}>
            Sync now
          </button>
        )}
      </p>

      {!removed && (
        <section>
          <h3>Add a computer</h3>
          {code && minutesLeft > 0 ? (
            <div className="pairing">
              <div className="device-code">{code.code}</div>
              <p className="hint">
                On the other computer, open Joyce, choose a folder, then <strong>Sync → Join with a code</strong>. This code
                works once, for the next {minutesLeft} {minutesLeft === 1 ? "minute" : "minutes"}.
              </p>
            </div>
          ) : (
            <button className="secondary" disabled={busy} onClick={() => run(async () => setCode(await pairingCode()))}>
              Show a pairing code
            </button>
          )}
        </section>
      )}

      <section>
        <h3>Computers</h3>
        {devices === null ? (
          <p className="hint">Couldn't load the list right now.</p>
        ) : (
          <ul className="device-list">
            {devices.map((d) => (
              <li key={d.id}>
                <span>
                  {d.name}
                  {d.current && <span className="muted"> (this computer)</span>}
                </span>
                {!d.current && (
                  <button
                    className="link-button"
                    title="Stop this computer syncing, e.g. if it's lost or sold"
                    onClick={() => run(async () => {
                      await removeDevice(d.id);
                      await loadDevices();
                    })}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <button className="secondary" disabled={busy} onClick={() => run(disableSync)}>
        Turn off sync on this computer
      </button>
      <p className="hint">Your files stay here; the other computers keep syncing with each other.</p>
    </>
  );
}
