/* ============================================================
   Accounts — sign in / register / MetaMask sign-in / profile

   With PostgreSQL configured on the dev server (DATABASE_URL, see
   docs/DATABASE.md) this talks to /auth-api (server/auth.mjs): real
   accounts, scrypt passwords, an HttpOnly session cookie, and "Sign in
   with MetaMask" (an EIP-4361 message signed in MetaMask — no gas).
   Without it, the demo sign-in in js/api.js is used and nothing is stored.

   window.DMAF_ACCOUNT → { mode, user, db, ready(), signIn(), register(),
   signOut(), signInWithWallet(), linkWallet(), unlinkWallet(), updateProfile() }
   Fires "dmaf:account" on window whenever the signed-in user changes.
   ============================================================ */
(() => {
const A = { mode: null, user: null, db: null };
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = a => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const emit = () => window.dispatchEvent(new CustomEvent("dmaf:account", { detail: A.user }));

async function call(method, path, body) {
  let r;
  try {
    r = await fetch("/auth-api" + path, { method, credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error("Can't reach the dev server — open the app through `npm run serve`"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || `${path} failed (${r.status})`), { status: r.status });
  return j;
}

let readyP = null;
A.ready = () => (readyP ||= (async () => {
  try {
    const s = await call("GET", "/status");
    A.db = s.db; A.mode = s.db?.ok ? "postgres" : "demo"; A.user = s.user || null;
  } catch (e) { A.mode = "demo"; A.db = { ok: false, error: e.message }; }
  if (A.mode === "demo" && localStorage.getItem("dmaf_token")) A.user = await api.me().catch(() => null);
  A.settled = true;                                    // js/app.js gates pages on this
  render(); emit();
  return A;
})());
const setUser = u => { A.user = u; render(); emit(); };

A.signIn = async (email, password) => {
  await A.ready();
  if (A.mode !== "postgres") { await api.login(email, password); return setUser(await api.me()); }
  if (!email || !password) throw new Error("Enter your email and password");
  setUser((await call("POST", "/login", { email, password })).user);
};
A.register = async data => {
  await A.ready();
  if (A.mode !== "postgres") { await api.register(data); await api.login(data.email, data.password); return setUser(await api.me()); }
  setUser((await call("POST", "/register", data)).user);
};
A.signOut = async () => {
  if (A.mode === "postgres") await call("POST", "/logout", {});
  else localStorage.removeItem("dmaf_token");
  setUser(null);
};
/* A dev-server API answered 401 (PostgreSQL mode): the session expired or was signed out
   elsewhere. Forget the user, so js/app.js sends you to Sign in and back to this page. */
A.sessionEnded = () => {
  if (A.mode !== "postgres" || !A.user) return;
  setUser(null);
  toast("Your session has ended — sign in again to continue");
};
A.updateProfile = async patch => setUser((await call("PATCH", "/me", patch)).user);
A.unlinkWallet = async () => setUser((await call("POST", "/wallet/unlink", {})).user);

/* EIP-4361 "Sign in with Ethereum": MetaMask signs a plain-text message, the
   server checks the signature, the domain and a one-time nonce. */
async function signedMessage() {
  if (!window.ethereum) throw new Error("MetaMask not found — install the extension and open the app at http://localhost:5173");
  const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
  const chainId = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
  const { nonce } = await call("GET", "/nonce");
  const addr = window.ethers.getAddress(address);
  const message = `${location.host} wants you to sign in with your Ethereum account:\n${addr}\n\n`
    + `Sign in to DMAF. This proves you own this wallet; it doesn't send a transaction or cost gas.\n\n`
    + `URI: ${location.origin}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  const hex = window.ethers.hexlify(window.ethers.toUtf8Bytes(message));
  const signature = await window.ethereum.request({ method: "personal_sign", params: [hex, addr] });
  return { message, signature };
}
A.signInWithWallet = async () => {
  await A.ready();
  if (A.mode !== "postgres") throw new Error("MetaMask sign-in needs PostgreSQL on the dev server (see docs/DATABASE.md)");
  const r = await call("POST", "/siwe", await signedMessage());
  setUser(r.user);
  return r;
};
A.linkWallet = async () => setUser((await call("POST", "/siwe", { ...(await signedMessage()), link: true })).user);

window.DMAF_ACCOUNT = A;

/* ---------------- sign-in view + header ---------------- */
const $ = s => document.querySelector(s);
const nameOf = u => u ? (u.artistName || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || short(u.wallet)) : "";
const errText = e => (e?.code === 4001 || /reject|denied/i.test(e?.message || "") ? "Cancelled in MetaMask" : e.message);

function render() {
  const u = A.user;
  $("#authlink").textContent = u ? nameOf(u) || "Account" : "Sign in";
  const mode = $("#auth-mode");
  mode.hidden = A.mode !== "demo";
  if (A.mode === "demo") mode.innerHTML = `<b>Demo sign-in.</b> PostgreSQL isn't configured on the dev server${A.db?.error ? ` (${esc(A.db.error)})` : ""}, so any email works and nothing is stored — and My Library can't list your IPFS files. Set <code>DATABASE_URL</code> and restart <code>npm run serve</code> to use real accounts: see <code>docs/DATABASE.md</code>.`;
  $("#btn-siwe").disabled = A.mode !== "postgres";
  $("#btn-siwe").title = A.mode === "postgres" ? "" : "Needs PostgreSQL on the dev server";
  $("#rg-link-row").hidden = A.mode !== "postgres";
  $("#auth-forms").hidden = !!u;
  const card = $("#account-card");
  card.hidden = !u;
  if (!u) return;
  const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  $("#account-details").innerHTML = [
    row("Name", esc([u.firstName, u.lastName].filter(Boolean).join(" ") || "—")),
    row("Artist name", esc(u.artistName || "—")),
    row("Email", esc(u.email || "— (signs in with MetaMask)")),
    row("Payout wallet", u.wallet ? `<span class="mono">${esc(u.wallet)}</span>` : "None linked yet"),
    row("Account", A.mode === "postgres" ? `PostgreSQL · member since ${new Date(u.createdAt).toLocaleDateString()}` : "Demo (not stored)"),
  ].join("");
  $("#acc-artist").value = u.artistName || "";
  $("#acc-link").hidden = A.mode !== "postgres";
  $("#acc-link").textContent = u.wallet ? "Link a different MetaMask wallet" : "Link my MetaMask wallet";
  $("#acc-unlink").hidden = A.mode !== "postgres" || !u.wallet;
  $("#acc-save").disabled = A.mode !== "postgres";
}

const next = () => window.DMAF_AFTER_SIGNIN?.() || "#/library";   // the page you tried to open, if any (js/app.js)
const busy = async (btn, label, fn) => {
  const old = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { await fn(); } catch (e) { toast(errText(e)); } finally { btn.disabled = false; btn.textContent = old; render(); }
};
$("#btn-login").addEventListener("click", e => busy(e.currentTarget, "Signing in…", async () => {
  await A.signIn($("#li-email").value.trim(), $("#li-pw").value);
  $("#li-pw").value = "";
  toast(`Signed in as ${nameOf(A.user)}`); location.hash = next();
}));
$("#li-pw").addEventListener("keydown", e => { if (e.key === "Enter") $("#btn-login").click(); });
$("#btn-siwe").addEventListener("click", e => busy(e.currentTarget, "Check MetaMask…", async () => {
  const r = await A.signInWithWallet();
  toast(r.created ? `Account created for ${short(r.user.wallet)} — add your artist name below` : `Signed in as ${nameOf(r.user)}`);
  if (!r.created) location.hash = next();          // a new wallet account stays here to add its artist name
}));
$("#btn-register").addEventListener("click", e => busy(e.currentTarget, "Creating…", async () => {
  await A.register({ firstName: $("#rg-fn").value.trim(), lastName: $("#rg-ln").value.trim(), artistName: $("#rg-artist").value.trim(),
    email: $("#rg-email").value.trim(), password: $("#rg-pw").value });
  $("#rg-pw").value = "";
  if (A.mode === "postgres" && $("#rg-link").checked) {
    try { await A.linkWallet(); } catch (err) { toast(`Account created — wallet not linked: ${errText(err)}`); location.hash = "#/login"; return; }
  }
  toast("Account created"); location.hash = next();
}));
$("#acc-signout").addEventListener("click", e => busy(e.currentTarget, "Signing out…", async () => { await A.signOut(); toast("Signed out"); }));
$("#acc-link").addEventListener("click", e => busy(e.currentTarget, "Check MetaMask…", async () => { await A.linkWallet(); toast(`Wallet ${short(A.user.wallet)} linked`); }));
$("#acc-unlink").addEventListener("click", e => busy(e.currentTarget, "Unlinking…", async () => { await A.unlinkWallet(); toast("Wallet unlinked"); }));
$("#acc-save").addEventListener("click", e => busy(e.currentTarget, "Saving…", async () => { await A.updateProfile({ artistName: $("#acc-artist").value.trim() }); toast("Saved"); }));

A.ready();
})();
