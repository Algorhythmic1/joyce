import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as gh from "../integrations/github";
import type { DeviceCode, Link, Site } from "../integrations/github";
import { cmsForPath, cmsName, type CmsKind } from "../integrations/cms";
import {
  defaultValues, draftField, editable, entryName, entryPath, missingRequired, titleField, unfillable, valuesFrom,
  type Collection, type Field, type SiteConfig, type Values,
} from "../integrations/sveltia";

interface Props {
  localPath: string;
  /** Current text of the open document. */
  getText: () => string;
}

type Auth =
  | { state: "checking" }
  | { state: "signed-out"; error?: string }
  | { state: "device"; code: DeviceCode }
  | { state: "signed-in"; login: string }
  | { state: "error"; error: string };

const LAST_SITE = "joyce:last-site";

export function PublishPanel({ localPath, getText }: Props) {
  const [auth, setAuth] = useState<Auth>({ state: "checking" });

  const checkAccount = async () => {
    setAuth({ state: "checking" });
    try {
      if (!(await gh.signedIn())) return setAuth({ state: "signed-out" });
      setAuth({ state: "signed-in", login: await gh.signedInLogin() });
    } catch (e) {
      setAuth({ state: "error", error: String(e instanceof Error ? e.message : e) });
    }
  };

  useEffect(() => {
    if (gh.available) checkAccount();
  }, []);

  if (!gh.available) {
    return (
      <Shell>
        <p className="hint">Publishing to a site is available in the desktop app.</p>
      </Shell>
    );
  }

  const signOut = () => gh.signOut().then(() => setAuth({ state: "signed-out" }));

  return (
    <Shell>
      {auth.state === "checking" && <p className="hint">Checking your GitHub account…</p>}
      {(auth.state === "signed-out" || auth.state === "device") && (
        <SignIn auth={auth} setAuth={setAuth} onSignedIn={checkAccount} />
      )}
      {auth.state === "error" && (
        <>
          <p className="error-text">{auth.error}</p>
          <div className="row">
            <button className="secondary" onClick={checkAccount}>Try again</button>
            <button className="secondary" onClick={signOut}>Sign out</button>
          </div>
        </>
      )}
      {auth.state === "signed-in" && (
        <>
          <p className="account">
            Signed in to GitHub as <strong>@{auth.login}</strong>
            <button className="link-button" onClick={signOut}>Sign out</button>
          </p>
          <Sites localPath={localPath} getText={getText} />
        </>
      )}
    </Shell>
  );
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="panel publish-panel" onMouseDown={(e) => e.stopPropagation()}>
    <h2>Publish</h2>
    {children}
  </div>
);

/** Choose a site (or add one), then a collection on it. */
function Sites({ localPath, getText }: Props) {
  const sites = useSyncExternalStore(gh.subscribeSites, gh.getSites);
  const link = gh.getLink(localPath);
  const [siteId, setSiteId] = useState<string | null>(() => link?.site ?? localStorage.getItem(LAST_SITE) ?? null);
  const [adding, setAdding] = useState(false);
  const site = sites.find((s) => s.id === siteId) ?? sites[0];

  const choose = (id: string) => {
    setSiteId(id);
    localStorage.setItem(LAST_SITE, id);
  };

  if (!sites.length || adding) {
    return (
      <AddSite
        onAdded={(s) => {
          choose(s.id);
          setAdding(false);
        }}
        onCancel={sites.length ? () => setAdding(false) : undefined}
      />
    );
  }

  return (
    <>
      <div className="site-row">
        <label className="field">
          <span>Site</span>
          <select value={site.id} onChange={(e) => (e.currentTarget.value === "+" ? setAdding(true) : choose(e.currentTarget.value))}>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="+">Add a site…</option>
          </select>
        </label>
      </div>
      <SiteEntry key={`${site.id}|${localPath}`} site={site} localPath={localPath} getText={getText} link={link} />
    </>
  );
}

function AddSite({ onAdded, onCancel }: { onAdded: (s: Site) => void; onCancel?: () => void }) {
  const [input, setInput] = useState("");
  const [cms, setCms] = useState<CmsKind | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      onAdded(await gh.addSite(input, cms || undefined));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <p className="hint">
        Publish to a site managed with <strong>Pages CMS</strong>, <strong>Sveltia CMS</strong>, or Decap/Netlify CMS. Joyce reads the site's CMS config to
        learn its content types and fields.
      </p>
      <label className="field">
        <span>The site's GitHub repository</span>
        <input
          value={input}
          autoFocus
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && input.trim() && add()}
          placeholder="owner/name or https://github.com/owner/name"
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span>CMS</span>
        <select value={cms} onChange={(e) => setCms(e.currentTarget.value as CmsKind | "")}>
          <option value="">Detect automatically</option>
          <option value="pages">Pages CMS</option>
          <option value="sveltia">Sveltia / Decap / Netlify CMS</option>
        </select>
      </label>
      <div className="row">
        <button className="primary small" disabled={busy || !input.trim()} onClick={add}>
          {busy ? "Looking…" : "Add site"}
        </button>
        {onCancel && <button className="secondary" onClick={onCancel}>Cancel</button>}
      </div>
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

/** Loads a site's config and access, then shows the form for one of its collections. */
function SiteEntry({ site, localPath, getText, link }: { site: Site; localPath: string; getText: () => string; link?: Link }) {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [canPush, setCanPush] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const linkedHere = link?.site === site.id ? link : undefined;
  const [collectionName, setCollectionName] = useState<string | null>(linkedHere?.collection ?? null);

  useEffect(() => {
    let live = true;
    Promise.all([gh.loadSiteConfig(site), gh.account(site.repo)])
      .then(([c, a]) => {
        if (!live) return;
        setConfig(c);
        setCanPush(a.canPush);
      })
      .catch((e) => live && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      live = false;
    };
  }, [site.id]);

  if (error) {
    return (
      <>
        <p className="error-text">{error}</p>
        <button className="link-button" onClick={() => gh.removeSite(site.id)}>Remove this site from Joyce</button>
      </>
    );
  }
  if (!config) return <p className="hint">Reading {site.name}'s CMS config…</p>;
  if (canPush === false) return <p className="error-text">Your GitHub account can't push to {site.repo}. Ask for write access.</p>;

  const usable = config.collections.filter((c) => !c.unsupported);
  const collection = usable.find((c) => c.name === collectionName) ?? usable[0];
  if (!collection) {
    return <>
      <p className="hint">{site.name} has no collections Joyce can publish Markdown into.</p>
      {config.collections.map((c) => <p className="hint" key={c.name}>{c.label}: {c.unsupported}</p>)}
      <button className="link-button" onClick={() => gh.removeSite(site.id)}>Remove this site from Joyce</button>
    </>;
  }
  const others = config.collections.filter((c) => c.unsupported);

  return (
    <>
      <label className="field">
        <span>Content type</span>
        <select value={collection.name} onChange={(e) => setCollectionName(e.currentTarget.value)}>
          {usable.map((c) => (
            <option key={c.name} value={c.name}>
              {c.label}
            </option>
          ))}
          {others.map((c) => (
            <option key={c.name} value={c.name} disabled title={c.unsupported}>
              {c.label} (not supported)
            </option>
          ))}
        </select>
      </label>
      <EntryForm
        key={collection.name}
        site={site}
        collection={collection}
        localPath={localPath}
        getText={getText}
        link={linkedHere?.collection === collection.name ? linkedHere : undefined}
      />
      <p className="hint site-footer">
        {cmsName(site.cms ?? cmsForPath(site.configPath))} · {site.repo} · {site.branch}
        {" · "}
        <button className="link-button" onClick={() => gh.removeSite(site.id)}>Remove site</button>
      </p>
    </>
  );
}

function EntryForm(props: { site: Site; collection: Collection; localPath: string; getText: () => string; link?: Link }) {
  const { site, collection, localPath, getText } = props;
  const [link, setLinkState] = useState<Link | undefined>(props.link);
  const saved = !!link?.path && !!link.sha;
  const title = gh.splitTitle(getText()).title;

  const [values, setValues] = useState<Values>(() => {
    const base = defaultValues(collection, title ?? "");
    const v = link ? { ...base, ...link.values } : base;
    // The document's own heading wins over a remembered title.
    return title && titleField(collection) ? { ...v, [collection.identifier]: title } : v;
  });
  const [name, setName] = useState(() => entryName(collection, values));
  const [nameTouched, setNameTouched] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "saved" | "error" | "conflict"; message?: string }>({ kind: "idle" });

  // An entry saved before may have been edited in the CMS since: start from what's there now.
  useEffect(() => {
    if (!link?.path) return;
    let live = true;
    gh.remoteEntry(link, site)
      .then((entry) => {
        if (!live || !entry) return;
        const fromSite = valuesFrom(collection, entry.data);
        setValues((v) => ({ ...v, ...fromSite, ...(title && titleField(collection) ? { [collection.identifier]: title } : {}) }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Remember edits even before the first save.
  useEffect(() => {
    gh.setLink(localPath, { ...(link ?? {}), site: site.id, collection: collection.name, values });
  }, [values]);

  const set = (field: string, value: unknown) =>
    setValues((v) => {
      const next = { ...v, [field]: value };
      if (!nameTouched && !saved) setName(entryName(collection, next));
      return next;
    });

  const draft = draftField(collection);
  const missing = missingRequired(collection, values);
  const kept = collection.fields.filter((f) => f.kind === "other");
  // A new entry would be missing these, which can break the site's build.
  const blocking = saved ? [] : unfillable(collection);

  const save = async (overwrite = false) => {
    if (missing.length) return setStatus({ kind: "error", message: `Still needed: ${missing.join(", ")}.` });
    if (!saved && !name) return setStatus({ kind: "error", message: "The file name is empty." });
    setStatus({ kind: "saving" });
    try {
      const result = await gh.saveEntry(
        localPath,
        getText(),
        { site, collection, values, name, title: String(values[collection.identifier] ?? title ?? name) },
        { overwrite },
      );
      setLinkState(result);
      setStatus({ kind: "saved" });
    } catch (e) {
      if (e instanceof gh.SaveConflict) setStatus({ kind: "conflict", message: e.message });
      else setStatus({ kind: "error", message: String(e instanceof Error ? e.message : e) });
    }
  };

  const publishing = draft && values[draft.name] === false;

  return (
    <section className="post-form">
      {collection.fields.filter(editable).map((f) => (
        <FieldInput key={f.name} field={f} value={values[f.name]} onChange={(v) => set(f.name, v)} />
      ))}

      <label className="field">
        <span>File</span>
        {saved ? (
          <span className="readonly">{link!.path}</span>
        ) : (
          <span className="file-name">
            <span className="muted">{collection.folder}/</span>
            <input
              value={name}
              spellCheck={false}
              onChange={(e) => {
                setNameTouched(true);
                setName(e.currentTarget.value.replace(/[^A-Za-z0-9/_.-]+/g, "-"));
              }}
            />
            <span className="muted">.{collection.extension}</span>
          </span>
        )}
      </label>

      {kept.length > 0 && (
        <p className="hint">
          Left as they are on the site: {kept.map((f) => f.label).join(", ")}. Edit those in the CMS.
        </p>
      )}
      {publishing && <p className="warning-text">Saving will publish this on the live site.</p>}
      {blocking.length > 0 && (
        <p className="warning-text">
          New {collection.label.toLowerCase()} entries need {blocking.map((f) => f.label).join(", ")}, which Joyce can't set. Create
          the entry in the CMS first; then Joyce can update its text.
        </p>
      )}

      {status.kind === "conflict" ? (
        <div className="conflict">
          <p>{status.message}</p>
          <div className="row">
            <button className="danger" onClick={() => save(true)}>Overwrite on GitHub</button>
            <button className="secondary" onClick={() => setStatus({ kind: "idle" })}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="primary" disabled={status.kind === "saving" || blocking.length > 0} onClick={() => save()}>
          {status.kind === "saving" ? "Saving…" : draft ? (publishing ? "Save & publish" : "Save draft") : `Save to ${props.site.name}`}
        </button>
      )}

      {status.kind === "error" && <p className="error-text">{status.message}</p>}
      {saved && status.kind !== "error" && status.kind !== "conflict" && (
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
      {!saved && <p className="hint">Will be saved as {entryPath(collection, name || "…")}.</p>}
    </section>
  );
}

/** One form control, chosen by the field's CMS widget. */
function FieldInput({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  const label = (
    <span>
      {field.label}
      {!field.required && field.kind !== "boolean" && <span className="muted"> (optional)</span>}
    </span>
  );
  const hint = field.hint && <span className="field-hint">{field.hint}</span>;

  switch (field.kind) {
    case "boolean":
      return (
        <label className="check" title={field.hint}>
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.currentTarget.checked)} />
          {field.label}
          {field.name === "draft" && <span className="muted">(saved to GitHub, hidden from the site)</span>}
        </label>
      );
    case "text":
      return (
        <label className="field">
          {label}
          <textarea rows={2} value={String(value ?? "")} onChange={(e) => onChange(e.currentTarget.value)} />
          {hint}
        </label>
      );
    case "date":
    case "datetime":
      return (
        <label className="field">
          {label}
          <input
            type={field.kind === "date" ? "date" : "datetime-local"}
            value={String(value ?? "")}
            onChange={(e) => onChange(e.currentTarget.value)}
          />
          {hint}
        </label>
      );
    case "number":
      return (
        <label className="field">
          {label}
          <input type="number" step={field.valueType === "float" ? "any" : 1} value={String(value ?? "")} onChange={(e) => onChange(e.currentTarget.value)} />
          {hint}
        </label>
      );
    case "select":
      if (field.multiple) {
        const chosen = Array.isArray(value) ? (value as string[]) : [];
        return (
          <fieldset className="field multi">
            {label}
            <div className="chips">
              {field.options!.map((o) => (
                <label key={o.value} className={`chip${chosen.includes(o.value) ? " selected" : ""}`}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(o.value)}
                    onChange={(e) => onChange(e.currentTarget.checked ? [...chosen, o.value] : chosen.filter((x) => x !== o.value))}
                  />
                  {o.label}
                </label>
              ))}
            </div>
            {hint}
          </fieldset>
        );
      }
      return (
        <label className="field">
          {label}
          <select value={String(value ?? "")} onChange={(e) => onChange(e.currentTarget.value)}>
            {!field.required && <option value="">None</option>}
            {field.options!.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {hint}
        </label>
      );
    case "list":
      return (
        <label className="field">
          {label}
          <input
            defaultValue={Array.isArray(value) ? (value as string[]).join(", ") : ""}
            placeholder="Comma-separated"
            onBlur={(e) => onChange(e.currentTarget.value.split(",").map((t) => t.trim()).filter(Boolean))}
          />
          {hint}
        </label>
      );
    default:
      return (
        <label className="field">
          {label}
          <input value={String(value ?? "")} onChange={(e) => onChange(e.currentTarget.value)} />
          {hint}
        </label>
      );
  }
}

function SignIn(props: { auth: Auth; setAuth: (a: Auth) => void; onSignedIn: () => void }) {
  const { auth, setAuth, onSignedIn } = props;
  const [cliAvailable, setCliAvailable] = useState(false);
  const [clientId, setClientId] = useState(gh.getClientId);
  const [error, setError] = useState<string | null>(auth.state === "signed-out" ? auth.error ?? null : null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    gh.ghCliAvailable().then(setCliAvailable);
    return () => abort.current?.abort();
  }, []);

  const deviceSignIn = async () => {
    setError(null);
    const id = clientId.trim();
    gh.setClientId(id);
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
        Sites managed with Pages CMS, Sveltia, or Decap keep their content on GitHub. Sign in with an account that can push to the site's
        repository. The token is kept in your system's secure storage.
      </p>
      {cliAvailable && <button className="primary" onClick={cliSignIn}>Use my GitHub CLI account</button>}
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

function relativeTime(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}
