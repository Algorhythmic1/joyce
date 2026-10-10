import { useEffect, useRef, useState } from "react";
import * as gh from "../integrations/github";
import type { Account, DeviceCode, GithubTarget, Link, PostFields } from "../integrations/github";

interface Props {
  localPath: string;
  /** Current text of the open document. */
  getText: () => string;
}

type Auth =
  | { state: "checking" }
  | { state: "signed-out"; error?: string }
  | { state: "device"; code: DeviceCode }
  | { state: "signed-in"; account: Account }
  | { state: "error"; error: string };

export function PublishPanel({ localPath, getText }: Props) {
  const [target, setTarget] = useState(gh.loadTarget);
  const [auth, setAuth] = useState<Auth>({ state: "checking" });
  const [editingTarget, setEditingTarget] = useState(false);

  const checkAccount = async (t = target) => {
    setAuth({ state: "checking" });
    try {
      if (!(await gh.signedIn())) return setAuth({ state: "signed-out" });
      setAuth({ state: "signed-in", account: await gh.account(t) });
    } catch (e) {
      setAuth({ state: "error", error: String(e instanceof Error ? e.message : e) });
    }
  };

  useEffect(() => {
    if (gh.available) checkAccount();
  }, []);

  const updateTarget = (t: GithubTarget) => {
    setTarget(t);
    gh.saveTarget(t);
  };

  if (!gh.available) {
    return (
      <Shell>
        <p className="hint">Publishing to GitHub is available in the desktop app.</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <TargetLine target={target} editing={editingTarget} onToggle={() => setEditingTarget((e) => !e)} />
      {editingTarget && (
        <TargetForm
          target={target}
          onDone={(t) => {
            updateTarget(t);
            setEditingTarget(false);
            checkAccount(t);
          }}
        />
      )}
      {auth.state === "checking" && <p className="hint">Checking your GitHub account…</p>}
      {(auth.state === "signed-out" || auth.state === "device") && (
        <SignIn
          target={target}
          onClientId={(clientId) => updateTarget({ ...target, clientId })}
          auth={auth}
          setAuth={setAuth}
          onSignedIn={() => checkAccount()}
        />
      )}
      {auth.state === "error" && (
        <>
          <p className="error-text">{auth.error}</p>
          <div className="row">
            <button className="secondary" onClick={() => checkAccount()}>Try again</button>
            <button className="secondary" onClick={() => gh.signOut().then(() => setAuth({ state: "signed-out" }))}>Sign out</button>
          </div>
        </>
      )}
      {auth.state === "signed-in" && (
        <>
          <p className="account">
            Signed in as <strong>@{auth.account.login}</strong>
            <button className="link-button" onClick={() => gh.signOut().then(() => setAuth({ state: "signed-out" }))}>
              Sign out
            </button>
          </p>
          {auth.account.canPush ? (
            <PostForm key={`${localPath}|${target.repo}|${target.branch}`} localPath={localPath} getText={getText} target={target} />
          ) : (
            <p className="error-text">@{auth.account.login} can't push to {target.repo}. Ask for write access.</p>
          )}
        </>
      )}
    </Shell>
  );
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="panel publish-panel" onMouseDown={(e) => e.stopPropagation()}>
    <h2>Save to GitHub</h2>
    {children}
  </div>
);

function TargetLine({ target, editing, onToggle }: { target: GithubTarget; editing: boolean; onToggle: () => void }) {
  return (
    <p className="target-line">
      <span title={`${target.repo} · ${target.branch} · ${target.folder}`}>
        {target.repo.split("/")[1]} <span className="muted">· {target.branch} · {target.folder}</span>
      </span>
      <button className="link-button" onClick={onToggle}>{editing ? "Cancel" : "Change"}</button>
    </p>
  );
}

function TargetForm({ target, onDone }: { target: GithubTarget; onDone: (t: GithubTarget) => void }) {
  const [t, setT] = useState(target);
  const field = (key: keyof GithubTarget, label: string, hint?: string) => (
    <label className="field">
      <span>{label}</span>
      <input value={t[key]} onChange={(e) => setT({ ...t, [key]: e.currentTarget.value })} placeholder={hint} spellCheck={false} />
    </label>
  );
  return (
    <section className="target-form">
      {field("repo", "Repository", "owner/name")}
      {field("branch", "Branch")}
      {field("folder", "Folder")}
      <label className="field">
        <span>Format</span>
        <select value={t.extension} onChange={(e) => setT({ ...t, extension: e.currentTarget.value as "md" | "mdx" })}>
          <option value="mdx">MDX (.mdx)</option>
          <option value="md">Markdown (.md)</option>
        </select>
      </label>
      {field("author", "Default author")}
      {field("clientId", "OAuth client ID", "for “Sign in with GitHub”")}
      <div className="row">
        <button className="primary small" onClick={() => onDone({ ...t, repo: t.repo.trim(), folder: t.folder.replace(/^\/+|\/+$/g, "") })}>
          Save
        </button>
        <button className="secondary" onClick={() => setT(gh.DEFAULT_TARGET)}>Reset to Bickerstaff</button>
      </div>
    </section>
  );
}

function SignIn(props: {
  target: GithubTarget;
  auth: Auth;
  setAuth: (a: Auth) => void;
  onClientId: (id: string) => void;
  onSignedIn: () => void;
}) {
  const { target, auth, setAuth, onSignedIn } = props;
  const [cliAvailable, setCliAvailable] = useState(false);
  const [clientId, setClientId] = useState(target.clientId);
  const [error, setError] = useState<string | null>(auth.state === "signed-out" ? auth.error ?? null : null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    gh.ghCliAvailable().then(setCliAvailable);
    return () => abort.current?.abort();
  }, []);

  const deviceSignIn = async () => {
    setError(null);
    const id = clientId.trim();
    props.onClientId(id);
    try {
      const code = await gh.startDeviceFlow(id);
      setAuth({ state: "device", code });
      await navigator.clipboard.writeText(code.userCode).catch(() => {});
      gh.openInBrowser(code.verificationUri);
      abort.current = new AbortController();
      await gh.waitForDeviceFlow(id, code, abort.current.signal);
      onSignedIn();
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      if (msg !== "cancelled") setAuth({ state: "signed-out", error: msg });
    }
  };

  const cliSignIn = async () => {
    setError(null);
    try {
      await gh.importGhCli();
      onSignedIn();
    } catch (e) {
      setError(String(e));
    }
  };

  if (auth.state === "device") {
    return (
      <section className="device">
        <p>Enter this code on GitHub. It's been copied to your clipboard.</p>
        <div className="device-code">{auth.code.userCode}</div>
        <div className="row">
          <button className="secondary" onClick={() => gh.openInBrowser(auth.code.verificationUri)}>Open GitHub</button>
          <button
            className="secondary"
            onClick={() => {
              abort.current?.abort();
              setAuth({ state: "signed-out" });
            }}
          >
            Cancel
          </button>
        </div>
        <p className="hint">Waiting for you to approve…</p>
      </section>
    );
  }

  return (
    <section className="sign-in">
      <p className="hint">
        Sign in with a GitHub account that can push to {target.repo}. The token is kept in your macOS Keychain.
      </p>
      {cliAvailable && (
        <button className="primary" onClick={cliSignIn}>Use my GitHub CLI account</button>
      )}
      <label className="field">
        <span>OAuth app client ID</span>
        <input value={clientId} onChange={(e) => setClientId(e.currentTarget.value)} placeholder="Ov23li…" spellCheck={false} />
      </label>
      <button className={cliAvailable ? "secondary" : "primary"} disabled={!clientId.trim()} onClick={deviceSignIn}>
        Sign in with GitHub
      </button>
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

function PostForm({ localPath, getText, target }: { localPath: string; getText: () => string; target: GithubTarget }) {
  const [link, setLinkState] = useState<Link | undefined>(() => gh.getLink(localPath));
  const linked = link?.path && link.repo === target.repo && link.branch === target.branch;
  const [fields, setFields] = useState<PostFields>(() => {
    const text = getText();
    const base = link?.fields ?? gh.defaultFields(localPath, text, target);
    // The document's own heading wins over a remembered title.
    const heading = gh.splitTitle(text).title;
    return heading ? { ...base, title: heading, slug: linked ? base.slug : gh.slugify(heading) } : base;
  });
  const [slugTouched, setSlugTouched] = useState(!!linked);
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "saved" | "error" | "conflict"; message?: string }>({ kind: "idle" });

  // Remember edits to the fields even before the first save.
  useEffect(() => {
    gh.setLink(localPath, { ...gh.getLink(localPath), fields });
  }, [fields, localPath]);

  const set = (patch: Partial<PostFields>) =>
    setFields((f) => {
      const next = { ...f, ...patch };
      if (patch.title !== undefined && !slugTouched) next.slug = gh.slugify(patch.title);
      return next;
    });

  const save = async (overwrite = false) => {
    if (!fields.title.trim() || !fields.slug) return setStatus({ kind: "error", message: "A title and a file name are required." });
    setStatus({ kind: "saving" });
    try {
      const saved = await gh.savePost(localPath, getText(), fields, target, { overwrite });
      setLinkState(saved);
      setStatus({ kind: "saved" });
    } catch (e) {
      if (e instanceof gh.SaveConflict) setStatus({ kind: "conflict", message: e.message });
      else setStatus({ kind: "error", message: String(e instanceof Error ? e.message : e) });
    }
  };

  return (
    <section className="post-form">
      <label className="field">
        <span>Title</span>
        <input value={fields.title} onChange={(e) => set({ title: e.currentTarget.value })} />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea
          rows={2}
          value={fields.description}
          placeholder="One or two sentences for previews, search and the newsletter."
          onChange={(e) => set({ description: e.currentTarget.value })}
        />
      </label>
      <label className="field">
        <span>Tags</span>
        <input
          defaultValue={fields.tags.join(", ")}
          placeholder="Comma-separated"
          onBlur={(e) => set({ tags: e.currentTarget.value.split(",").map((t) => t.trim()).filter(Boolean) })}
        />
      </label>
      <div className="field-pair">
        <label className="field">
          <span>Author</span>
          <input value={fields.author} onChange={(e) => set({ author: e.currentTarget.value })} />
        </label>
        <label className="field">
          <span>Publish date</span>
          <input type="date" value={fields.pubDate} onChange={(e) => e.currentTarget.value && set({ pubDate: e.currentTarget.value })} />
        </label>
      </div>
      <label className="field">
        <span>File name</span>
        {linked ? (
          <span className="readonly">{link!.path!.split("/").pop()}</span>
        ) : (
          <input
            value={fields.slug}
            spellCheck={false}
            onChange={(e) => {
              setSlugTouched(true);
              // Tidy up fully on blur, so typing a dash isn't immediately undone.
              set({ slug: e.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-") });
            }}
            onBlur={(e) => set({ slug: gh.slugify(e.currentTarget.value) })}
          />
        )}
      </label>
      <label className="check">
        <input type="checkbox" checked={fields.draft} onChange={(e) => set({ draft: e.currentTarget.checked })} />
        Draft <span className="muted">(saved to GitHub, hidden from the site)</span>
      </label>
      {!fields.draft && <p className="warning-text">Saving will publish this post on the live site.</p>}

      {status.kind === "conflict" ? (
        <div className="conflict">
          <p>{status.message}</p>
          <div className="row">
            <button className="danger" onClick={() => save(true)}>Overwrite on GitHub</button>
            <button className="secondary" onClick={() => setStatus({ kind: "idle" })}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="primary" disabled={status.kind === "saving"} onClick={() => save()}>
          {status.kind === "saving" ? "Saving…" : fields.draft ? "Save draft" : "Save & publish"}
        </button>
      )}

      {status.kind === "error" && <p className="error-text">{status.message}</p>}
      {linked && status.kind !== "error" && status.kind !== "conflict" && (
        <p className="hint">
          {status.kind === "saved" ? "Saved" : "Last saved"} {link!.savedAt ? relativeTime(link!.savedAt) : ""} ·{" "}
          <button className="link-button" onClick={() => gh.openInBrowser(gh.fileUrl(link!))}>View on GitHub</button>
          {link!.commitUrl && (
            <>
              {" · "}
              <button className="link-button" onClick={() => gh.openInBrowser(link!.commitUrl!)}>Commit</button>
            </>
          )}
        </p>
      )}
    </section>
  );
}

function relativeTime(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}
