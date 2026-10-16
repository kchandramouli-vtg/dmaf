/* ============================================================
   IPFS library (PostgreSQL) — /library-api

   Every file a signed-in user puts on IPFS through DMAF is recorded in
   ipfs_files: browser uploads through the dev server's /ipfs-api proxy
   (tools/serve.mjs reads Kubo's answer) and server-side pins (the Studio's
   mix, IMAF package and descriptions, server/stems.mjs).

   GET  /library-api/files[?hidden=1]   the user's files + whether each CID is pinned on the node
   POST /library-api/pin    { cid }      pin on the local IPFS node (Kubo pin/add)
   POST /library-api/unpin  { cid }      unpin (the node may then garbage-collect it)
   POST /library-api/hide   { cid, hidden }  hide from / show in My Library (database only)
   POST /library-api/link   { assetId, cids[] }  mark files as belonging to an on-chain asset
   Only CIDs recorded for the signed-in user can be pinned, unpinned or hidden.
   ============================================================ */
export const KINDS = ["audio", "mix", "imaf", "imaf-description", "waveforms", "metadata", "agreement", "scm-token", "upload", "file"];

export function createLibrary({ db, auth, ipfsApi }) {
  const kubo = async (cmd, args = {}) => {
    const q = new URLSearchParams(args).toString();
    let r;
    try { r = await fetch(`${ipfsApi}/api/v0/${cmd}${q ? "?" + q : ""}`, { method: "POST", headers: { "user-agent": "dmaf-dev-server" }, signal: AbortSignal.timeout(120_000) }); }
    catch (e) { throw Object.assign(new Error(`Can't reach the IPFS node at ${ipfsApi} — is it running? (${e.cause?.code || e.message})`), { status: 502 }); }
    const text = await r.text();
    let j = {}; try { j = JSON.parse(text.trim().split("\n").pop() || "{}"); } catch {}
    if (!r.ok) throw Object.assign(new Error(j.Message || `IPFS ${cmd} failed (${r.status})`), { status: 502, ipfs: j });
    return j;
  };

  /** Record (or refresh) a file for a user. Never throws — the upload itself already succeeded. */
  async function record(userId, f) {
    if (!userId || !f?.cid || !db.ok) return;
    const kind = KINDS.includes(f.kind) ? f.kind : "file";
    try {
      await db.query(
        `insert into ipfs_files (user_id, cid, name, mime, size, kind, source, agreement_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (user_id, cid) do update set
           name = coalesce(excluded.name, ipfs_files.name), mime = coalesce(excluded.mime, ipfs_files.mime),
           size = coalesce(excluded.size, ipfs_files.size),
           kind = case when ipfs_files.kind in ('file', 'upload') then excluded.kind else ipfs_files.kind end,
           source = coalesce(ipfs_files.source, excluded.source), agreement_id = coalesce(excluded.agreement_id, ipfs_files.agreement_id),
           hidden = false, updated_at = now()`,
        [userId, String(f.cid), str(f.name, 255), str(f.mime, 100), Number.isFinite(+f.size) ? +f.size : null, kind, str(f.source, 40), str(f.agreementId, 80)]);
    } catch (e) { console.warn("library: couldn't record", f.cid, e.message); }
  }

  const send = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
  const readJson = req => new Promise((resolve, reject) => {
    const c = []; let n = 0;
    req.on("data", d => { n += d.length; if (n > 256 * 1024) { req.destroy(); reject(Object.assign(new Error("body too large"), { status: 413 })); } else c.push(d); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(c).toString() || "{}")); } catch { reject(Object.assign(new Error("invalid JSON"), { status: 400 })); } });
    req.on("error", reject);
  });
  const owned = async (me, cid) => {
    const r = await db.query("select * from ipfs_files where user_id = $1 and cid = $2", [me.id, String(cid || "")]);
    if (!r.rowCount) throw Object.assign(new Error("That CID isn't in your library"), { status: 404 });
    return r.rows[0];
  };
  const fileJson = (f, pins) => ({
    cid: f.cid, name: f.name, mime: f.mime, size: f.size == null ? null : Number(f.size), kind: f.kind, source: f.source,
    agreementId: f.agreement_id, assetId: f.asset_id, hidden: f.hidden, createdAt: f.created_at,
    pinned: pins ? pins.has(f.cid) : null,
  });

  async function handle(req, res, p) {
    try {
      if (!db.ok && !(await db.status()).ok) throw Object.assign(new Error(`My Library's IPFS files need PostgreSQL: ${db.error}`), { status: 503 });
      const me = await auth.userFromRequest(req);
      if (!me) throw Object.assign(new Error("Sign in to see your IPFS files"), { status: 401 });
      if (req.method !== "GET") {
        const o = req.headers.origin;
        if (o) { try { if (new URL(o).host !== req.headers.host) throw 0; } catch { throw Object.assign(new Error("cross-site request refused"), { status: 403 }); } }
      }
      if (p === "files" && req.method === "GET") {
        const hidden = new URL(req.url, "http://x").searchParams.get("hidden") === "1";
        const rows = (await db.query(
          `select * from ipfs_files where user_id = $1 ${hidden ? "" : "and not hidden"} order by created_at desc limit 2000`, [me.id])).rows;
        let pins = null, ipfsError = null;
        try { pins = new Set(Object.keys((await kubo("pin/ls", { type: "recursive" })).Keys || {})); }
        catch (e) { ipfsError = e.message; }
        const totals = (await db.query(
          `select count(*)::int as files, coalesce(sum(size), 0)::bigint as bytes, count(*) filter (where hidden)::int as hidden
           from ipfs_files where user_id = $1`, [me.id])).rows[0];
        return send(res, 200, { files: rows.map(f => fileJson(f, pins)), totals: { ...totals, bytes: Number(totals.bytes) }, ipfsError });
      }
      if ((p === "pin" || p === "unpin") && req.method === "POST") {
        const { cid } = await readJson(req);
        const f = await owned(me, cid);
        try { await kubo(p === "pin" ? "pin/add" : "pin/rm", { arg: f.cid }); }
        catch (e) { if (!(p === "unpin" && /not pinned/i.test(e.message))) throw e; }
        return send(res, 200, { file: fileJson(f, new Set(p === "pin" ? [f.cid] : [])) });
      }
      if (p === "hide" && req.method === "POST") {
        const b = await readJson(req);
        await owned(me, b.cid);
        const r = await db.query("update ipfs_files set hidden = $3, updated_at = now() where user_id = $1 and cid = $2 returning *", [me.id, b.cid, !!b.hidden]);
        return send(res, 200, { file: fileJson(r.rows[0]) });
      }
      if (p === "link" && req.method === "POST") {
        const b = await readJson(req);
        const cids = (Array.isArray(b.cids) ? b.cids : []).filter(Boolean).map(String).slice(0, 50);
        if (!Number.isInteger(+b.assetId) || +b.assetId < 1 || !cids.length) throw Object.assign(new Error("assetId and cids are required"), { status: 400 });
        const r = await db.query("update ipfs_files set asset_id = $2, updated_at = now() where user_id = $1 and cid = any($3) returning cid", [me.id, +b.assetId, cids]);
        return send(res, 200, { linked: r.rowCount });
      }
      throw Object.assign(new Error(`No route ${req.method} /library-api/${p}`), { status: 404 });
    } catch (e) {
      if (!e.status) console.error("library-api:", e);
      send(res, e.status || 500, { errorType: "LibraryError", message: e.status ? e.message : "Something went wrong — see the dev server log" });
    }
  }
  return { handle, record };
}
const str = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));
