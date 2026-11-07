/* GitHub 저장소 연결 — 서버 없이 GitHub Pages 에서 돌아가는 판
   · 신원: 이 PC(브라우저)에 저장되는 닉네임. GitHub 계정과는 무관합니다.
   · 저장: 문서는 data 브랜치, 첨부는 assets 브랜치 (Pages 브랜치를 건드리지 않아 사이트가 다시 빌드되지 않음)
           실시간 편집 중인 파일 내용은 live 브랜치 — data 브랜치를 건드리지 않아 다른 화면이 목록을 다시 받지 않음
   · 실시간: 브랜치 머리글을 ETag 로 4초마다 확인 (바뀐 게 없으면 304 라서 사용량에 안 잡힘)
             실시간 보기 창이 열려 있는 동안은 1.5초마다
   · 토큰: 저장소에 쓰기 위한 열쇠. 코드가 아니라 각자 브라우저에만 저장됩니다. */
(function () {
  'use strict';
  const IDKEY = 'board.gh.identity.v1';
  const CFGKEY = 'board.gh.config.v1';
  const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  const API_VER = '2022-11-28';
  const DATA_BRANCH = 'data', ASSET_BRANCH = 'assets', LIVE_BRANCH = 'live';
  const POLL_MS = 4000;
  const FAST_POLL_MS = 1500;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = n => Array.from(crypto.getRandomValues(new Uint8Array(n || 8)), b => b.toString(16).padStart(2, '0')).join('');
  const enc = new TextEncoder();

  window.FREE_DOWNLOAD = true;

  // ── base64 ──
  function b64enc(u8) {
    const CH = 3 * 16384, out = [];
    for (let i = 0; i < u8.length; i += CH) out.push(btoa(String.fromCharCode.apply(null, u8.subarray(i, i + CH))));
    return out.join('');
  }
  const b64txt = s => b64enc(enc.encode(s));

  // ── 설정 / 신원 ──
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  let cfg = null;      // { owner, repo, api }
  let ident = lsGet(IDKEY, null);   // { uid, name, token }
  const saveIdent = () => lsSet(IDKEY, ident);

  async function loadConfig() {
    let file = null;
    try {
      const r = await fetch('config.json?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) file = await r.json();
    } catch {}
    const saved = lsGet(CFGKEY, null) || {};
    const repoStr = String((file && file.repo) || saved.repo || '').trim();
    const m = repoStr.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
    cfg = {
      owner: m ? m[1] : '', repo: m ? m[2] : '',
      api: String((file && file.api) || saved.api || 'https://api.github.com').replace(/\/$/, ''),
      fromFile: !!(file && file.repo),
    };
  }

  // ── GitHub 호출 ──
  const ERR = { 401: 'unauthenticated', 403: 'permission_denied', 404: 'not_found', 409: 'conflict', 422: 'conflict', 429: 'rate_limited' };
  let tokenBad = false;

  async function gh(method, path, opts = {}) {
    const headers = {
      'Accept': opts.accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VER,
    };
    const tok = opts.token || (ident && ident.token);
    if (tok) headers.Authorization = 'Bearer ' + tok;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.etag) headers['If-None-Match'] = opts.etag;
    let res;
    try {
      res = await fetch(cfg.api + path, { method, headers, cache: opts.cache || 'default',
                                          body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    } catch { throw { code: 'unavailable', message: 'network' }; }
    if (res.status === 304) return { notModified: true, etag: opts.etag };
    if (res.status === 401 && !opts.quiet) { tokenBad = true; askToken(); }
    if (!res.ok) {
      const secondary = (res.status === 403 || res.status === 429) && !res.headers.get('x-ratelimit-remaining')?.match(/^[1-9]/);
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch {}
      throw {
        code: secondary && /rate limit|abuse|secondary/i.test(detail) ? 'rate_limited' : (ERR[res.status] || 'unavailable'),
        status: res.status, message: detail,
        retryAfter: Number(res.headers.get('retry-after') || 0),
      };
    }
    const etag = res.headers.get('etag');
    if (opts.raw === 'bytes') return { bytes: new Uint8Array(await res.arrayBuffer()), etag };
    if (opts.raw === 'text') return { text: await res.text(), etag };
    const data = await res.json();
    return { data, etag };
  }

  const R = () => `/repos/${cfg.owner}/${cfg.repo}`;
  const encPath = p => p.split('/').map(encodeURIComponent).join('/');

  // ── 쓰기 큐 (한 번에 하나씩, 충돌·사용량 제한 시 다시 시도) ──
  let wq = Promise.resolve();
  function queued(fn) {
    const p = wq.then(fn, fn);
    wq = p.catch(() => {});
    return p;
  }
  async function shaOf(path, branch) {
    try {
      const r = await gh('GET', `${R()}/contents/${encPath(path)}?ref=${branch}`, { accept: 'application/vnd.github.object+json', cache: 'no-store' });
      return r.data && r.data.sha || null;
    } catch (e) { if (e.code === 'not_found') return null; throw e; }
  }
  async function putFile(path, contentB64, branch, message) {
    return queued(async () => {
      let sha = treeSha(branch, path);
      for (let i = 0; i < 6; i++) {
        try {
          const body = { message: message || ('update ' + path), content: contentB64, branch };
          if (sha) body.sha = sha;
          const r = await gh('PUT', `${R()}/contents/${encPath(path)}`, { body });
          setTreeSha(branch, path, r.data.content.sha);
          return r.data;
        } catch (e) {
          if (e.code === 'conflict') { sha = await shaOf(path, branch); await sleep(250 + i * 400); continue; }
          if (e.code === 'rate_limited') { await sleep(Math.max((e.retryAfter || 0) * 1000, 2000 * (i + 1))); continue; }
          if (e.code === 'unauthenticated') { await askToken(); continue; }
          throw e;
        }
      }
      throw { code: 'unavailable', message: 'write failed' };
    });
  }
  async function delFile(path, branch) {
    return queued(async () => {
      for (let i = 0; i < 5; i++) {
        const sha = treeSha(branch, path) || await shaOf(path, branch);
        if (!sha) return;
        try {
          await gh('DELETE', `${R()}/contents/${encPath(path)}`, { body: { message: 'delete ' + path, sha, branch } });
          setTreeSha(branch, path, null);
          return;
        } catch (e) {
          if (e.code === 'not_found') { setTreeSha(branch, path, null); return; }   // 이미 지워짐 (목록이 잠깐 옛것이었을 때)
          if (e.code === 'conflict') { setTreeSha(branch, path, null); await sleep(250 + i * 400); continue; }
          if (e.code === 'rate_limited') { await sleep(Math.max((e.retryAfter || 0) * 1000, 2000 * (i + 1))); continue; }
          if (e.code === 'unauthenticated') { await askToken(); continue; }
          throw e;
        }
      }
      throw { code: 'unavailable', message: 'delete failed' };
    });
  }

  // ── 트리(파일 목록) 캐시 ──
  const trees = { [DATA_BRANCH]: new Map(), [ASSET_BRANCH]: new Map(), [LIVE_BRANCH]: new Map() };
  const blobCache = new Map();            // blob sha → 내용 (sha 는 내용 해시라 영구 캐시 가능)
  const treeSha = (b, p) => (trees[b] || new Map()).get(p) || null;
  const setTreeSha = (b, p, sha) => { const t = trees[b]; if (!t) return; if (sha) t.set(p, sha); else t.delete(p); };

  async function refreshTree(branch) {
    let head;
    try {
      head = await gh('GET', `${R()}/branches/${encodeURIComponent(branch)}`);
    } catch (e) { if (e.code === 'not_found') { await ensureBranch(branch); return; } throw e; }
    const sha = head.data.commit.sha;
    const t = await gh('GET', `${R()}/git/trees/${sha}?recursive=1`);
    const map = new Map();
    for (const n of t.data.tree || []) if (n.type === 'blob') map.set(n.path, n.sha);
    trees[branch] = map;
    if (t.data.truncated) console.warn('tree truncated');
  }
  async function readBlob(sha, as) {
    const key = sha + ':' + as;
    if (blobCache.has(key)) return blobCache.get(key);
    const r = await gh('GET', `${R()}/git/blobs/${sha}`, { accept: 'application/vnd.github.raw', raw: as === 'bytes' ? 'bytes' : 'text' });
    const v = as === 'bytes' ? r.bytes : r.text;
    if (blobCache.size > 400) blobCache.clear();
    blobCache.set(key, v);
    return v;
  }
  async function ensureBranch(branch) {
    const repo = await gh('GET', R());
    const base = await gh('GET', `${R()}/git/ref/heads/${encodeURIComponent(repo.data.default_branch)}`);
    try {
      await gh('POST', `${R()}/git/refs`, { body: { ref: 'refs/heads/' + branch, sha: base.data.object.sha } });
    } catch (e) { if (e.code !== 'conflict') throw e; }
    trees[branch] = new Map();
  }

  // ── 문서 저장소 (앱이 쓰는 형태) ──
  const DOC_DIR = 'docs/';
  const docPath = p => DOC_DIR + p + '.json';
  function assertPath(path, wantDoc) {
    const segs = String(path).split('/');
    for (const s of segs) if (!SEG.test(s) || s === '.' || s === '..') throw new TypeError('bad path: ' + path);
    if ((segs.length % 2 === 0) !== wantDoc) throw new TypeError('bad path: ' + path);
  }
  const snapDoc = (id, data) => ({
    id, exists: data != null,
    data: () => (data == null ? undefined : JSON.parse(JSON.stringify(data))),
    metadata: { fromCache: false, hasPendingWrites: false },
  });

  async function readDoc(path) {
    const sha = treeSha(DATA_BRANCH, docPath(path));
    if (!sha) return null;
    try { return JSON.parse(await readBlob(sha, 'text')); } catch { return null; }
  }
  async function listColl(coll) {
    const prefix = DOC_DIR + coll + '/';
    const out = [];
    for (const [p, sha] of trees[DATA_BRANCH]) {
      if (!p.startsWith(prefix) || !p.endsWith('.json')) continue;
      const rest = p.slice(prefix.length, -5);
      if (rest.includes('/')) continue;
      let data = null;
      try { data = JSON.parse(await readBlob(sha, 'text')); } catch { continue; }
      out.push({ id: rest, data });
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  const listeners = new Set();
  async function runQuery(coll, where) {
    let rows = await listColl(coll);
    if (coll === 'rooms') rows = rows.filter(r => (r.data.members || []).includes(ident.uid));
    const docs = rows.filter(r => (where || []).every(([f, op, v]) => {
      const cur = r.data ? r.data[f] : undefined;
      if (op === '==') return cur === v;
      if (op === 'array-contains') return Array.isArray(cur) && cur.includes(v);
      return true;
    })).map(r => snapDoc(r.id, r.data));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  }
  async function refresh(l) {
    if (l.busy) { l.again = true; return; }
    l.busy = true;
    try {
      do {
        l.again = false;
        if (l.doc) {                                     // 문서 하나만 지켜보는 구독
          try { await runDoc(l); }
          catch (e) {
            if (l.sig === null && l.err) l.err(e);
            setTimeout(() => { if (listeners.has(l)) refresh(l); }, 3000);   // 받다가 끊기면 잠시 뒤 다시
            break;
          }
          continue;
        }
        let snap;
        try { snap = await runQuery(l.coll, l.where); }
        catch (e) { if (l.sig === null && l.err) l.err(e); break; }
        const sig = JSON.stringify(snap.docs.map(d => [d.id, d.data()]));
        if (sig !== l.sig) { l.sig = sig; if (listeners.has(l)) l.next(snap); }
      } while (l.again);
    } finally { l.busy = false; }
  }
  const refreshAll = () => { for (const l of [...listeners]) refresh(l); };

  // 문서 하나: 파일 목록의 sha 가 바뀔 때만 다시 읽음 (sha 는 내용 해시)
  async function runDoc(l) {
    const sha = treeSha(DATA_BRANCH, docPath(l.doc));
    const sig = sha || '-';
    if (sig === l.sig) return;
    let data = null;
    if (sha) {
      const text = await readBlob(sha, 'text');        // 네트워크 오류는 위로 던져 다음에 다시 시도
      try { data = JSON.parse(text); } catch { data = null; }
    }
    l.sig = sig;
    if (listeners.has(l)) l.next(snapDoc(l.id, data));
  }

  function collRef(path, where = []) {
    assertPath(path, false);
    return {
      path,
      where: (f, op, v) => collRef(path, [...where, [f, op, v]]),
      get: () => runQuery(path, where),
      onSnapshot(next, err) {
        const l = { coll: path, where, next, err, sig: null, busy: false, again: false };
        listeners.add(l);
        refresh(l);
        return () => listeners.delete(l);
      },
      doc: id => docRef(path + '/' + (id || ('R' + rand(6)))),
    };
  }
  function docRef(path) {
    assertPath(path, true);
    const segs = path.split('/'), id = segs[segs.length - 1];
    const write = async data => {
      await putFile(docPath(path), b64txt(JSON.stringify(data)), DATA_BRANCH);
      refreshAll();
    };
    return {
      id, path,
      get: async () => snapDoc(id, await readDoc(path)),
      onSnapshot(next, err) {
        const l = { doc: path, id, next, err, sig: null, busy: false, again: false };
        listeners.add(l);
        refresh(l);
        return () => listeners.delete(l);
      },
      set: data => write(data),
      update: async data => {
        const old = await readDoc(path);
        if (old == null) throw { code: 'not_found' };
        await write(Object.assign({}, old, data));
      },
      delete: async () => {
        await delFile(docPath(path), DATA_BRANCH);
        if (segs[0] === 'rooms' && segs.length === 2) {       // 방 삭제 → 하위 대화 문서도 정리
          const prefix = DOC_DIR + path + '/';
          for (const p of [...trees[DATA_BRANCH].keys()]) if (p.startsWith(prefix)) await delFile(p, DATA_BRANCH);
        }
        refreshAll();
      },
      collection: sub => collRef(path + '/' + sub),
    };
  }
  const dbCap = Object.freeze({ doc: docRef, collection: collRef });

  // ── 실시간 편집 채널 (live 브랜치) ──
  // 내용이 자주 바뀌는 문서를 data 브랜치와 따로 둡니다. data 브랜치에 쓰면 열려 있는 모든 화면이
  // 파일 목록을 다시 받아(요청 2~3회) 공유 토큰의 사용량이 금방 바닥나기 때문입니다.
  // 읽기는 파일 하나를 ETag 로 확인 → 그대로면 304 라서 사용량에 잡히지 않습니다.
  const liveCache = new Map();                   // 경로 → { etag, data }
  let liveBranchOk = false;
  async function liveBranch() {
    if (liveBranchOk) return;
    try { await gh('GET', `${R()}/branches/${LIVE_BRANCH}`, { quiet: true }); }
    catch (e) { if (e.code !== 'not_found') throw e; await ensureBranch(LIVE_BRANCH); }
    liveBranchOk = true;
  }
  const liveCap = Object.freeze({
    async read(path) {                           // → { data, changed }   (없으면 data: null)
      assertPath(path, true);
      const c = liveCache.get(path);
      let r;
      try {
        r = await gh('GET', `${R()}/contents/${encPath(docPath(path))}?ref=${LIVE_BRANCH}`,
                     { accept: 'application/vnd.github.raw+json', raw: 'text', etag: c && c.etag, quiet: true, cache: 'no-store' });
      } catch (e) {
        if (e.code !== 'not_found') throw e;
        liveCache.delete(path);
        return { data: null, changed: !!c };
      }
      if (r.notModified && c) return { data: c.data, changed: false };
      let data = null;
      try { data = JSON.parse(r.text); } catch {}
      liveCache.set(path, { etag: r.etag, data });
      if (liveCache.size > 300) liveCache.delete(liveCache.keys().next().value);
      return { data, changed: true };
    },
    async write(path, obj) {
      assertPath(path, true);
      await liveBranch();
      await putFile(docPath(path), b64txt(JSON.stringify(obj)), LIVE_BRANCH, 'live ' + path);
    },
    async delete(path) {
      assertPath(path, true);
      liveCache.delete(path);
      try { await delFile(docPath(path), LIVE_BRANCH); }
      catch (e) { if (e.code !== 'not_found') throw e; }
    },
  });

  // ── 변경 확인 (ETag 롱폴링 대신 가벼운 주기 확인) ──
  let polling = false, headEtag = null, headSha = null, assetEtag = null;
  let fastRefs = 0, wakePoll = null;
  function napPoll(ms) {                         // 기다리다가 빠른 확인으로 바뀌면 바로 깨어남
    return new Promise(r => {
      const t = setTimeout(() => { wakePoll = null; r(); }, ms);
      wakePoll = () => { clearTimeout(t); wakePoll = null; r(); };
    });
  }
  const pollDelay = () => (fastRefs > 0 && !document.hidden ? FAST_POLL_MS : POLL_MS);
  async function pollOnce() {
    const r = await gh('GET', `${R()}/branches/${DATA_BRANCH}`, { etag: headEtag, quiet: true });
    if (r.notModified) return false;
    headEtag = r.etag;
    const sha = r.data.commit.sha;
    if (sha === headSha) return false;
    headSha = sha;
    await refreshTree(DATA_BRANCH);
    return true;
  }
  async function startPolling() {
    if (polling) return;
    polling = true;
    let delay = POLL_MS;
    for (;;) {
      try {
        if (await pollOnce()) refreshAll();
        if (onlineCb) onlineCb(true);
        delay = pollDelay();
      } catch (e) {
        if (onlineCb) onlineCb(false, e);
        delay = Math.min(delay * 2, 60000);
      }
      await napPoll(delay);
    }
  }
  let onlineCb = null;
  window.onStoreState = cb => { onlineCb = cb; };

  // ── 사람 ──
  const profs = new Map();
  function avatarFor(name, id) {
    let h = 0; for (const c of String(id || name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const ch = (Array.from(String(name || '?'))[0] || '?').toUpperCase().replace(/[<>&"']/g, '?');
    return 'data:image/svg+xml,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="hsl(${h % 360} 45% 42%)"/>` +
      `<text x="20" y="27" font-size="18" font-family="sans-serif" font-weight="600" text-anchor="middle" fill="#fff">${ch}</text></svg>`);
  }
  const profile = (id, name) => ({ id, name, avatarUrl: avatarFor(name, id), color: '#888', email: null, isMe: id === ident.uid, guest: false });
  async function peopleMap() {
    const rows = await listColl('people');
    const m = new Map();
    for (const r of rows) if (r.data && typeof r.data.uid === 'string') m.set(r.data.uid, String(r.data.name || '이름 없음').slice(0, 20));
    if (ident) m.set(ident.uid, ident.name);
    return m;
  }
  const userCap = Object.freeze({
    me: async () => profile(ident.uid, ident.name),
    id: async () => ident.uid,
    can: async () => { if (tokenBad) await askToken(); return true; },
    isOwner: async () => false,
    canEdit: async () => true,
    profiles: async ids => {
      const want = [...new Set([].concat(ids || []).filter(Boolean))];
      const m = await peopleMap();
      const out = {};
      for (const i of want) if (m.has(i)) { const p = profile(i, m.get(i)); profs.set(i, p); out[i] = p; }
      return out;
    },
    search: async q => {
      const m = await peopleMap(), s = String(q || '').toLowerCase();
      return [...m].filter(([, n]) => n.toLowerCase().includes(s)).slice(0, 30).map(([i, n]) => profile(i, n));
    },
  });

  // ── 첨부 ──
  const assetPath = id => 'assets/' + id;
  const assetsCap = Object.freeze({
    upload: async blob => {
      const text = (await blob.text()).trim();          // 이미 base64 (앱이 조각내어 보냄)
      if (!text) throw { code: 'invalid_request' };
      const id = rand(16);
      try {
        await putFile(assetPath(id), text, ASSET_BRANCH, 'upload ' + id);
      } catch (e) {
        if (e.code === 'not_found') { await ensureBranch(ASSET_BRANCH); await putFile(assetPath(id), text, ASSET_BRANCH, 'upload ' + id); }
        else throw Object.assign(e, { code: e.code === 'conflict' ? 'store_unavailable' : e.code });
      }
      return { id, url: assetPath(id), sizeBytes: text.length };
    },
    list: async () => ({ assets: [], usage: {} }),
    delete: async id => { await delFile(assetPath(String(id)), ASSET_BRANCH); return { deleted: true }; },
  });

  // 앱이 첨부 조각을 읽을 때 쓰는 통로 (내용은 base64 문자열)
  window.assetFetch = async id => {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(String(id))) return { ok: false, text: async () => '' };
    try {
      let sha = treeSha(ASSET_BRANCH, assetPath(id));
      if (!sha) {                                        // 방금 올라온 파일이면 목록을 새로 받아옴
        await refreshTree(ASSET_BRANCH);
        sha = treeSha(ASSET_BRANCH, assetPath(id));
      }
      if (!sha) return { ok: false, text: async () => '' };
      const bytes = await readBlob(sha, 'bytes');
      return { ok: true, text: async () => b64enc(bytes) };
    } catch { return { ok: false, text: async () => '' }; }
  };

  // ── 내려받기 ──
  const downloadsCap = Object.freeze({
    save: async ({ filename, data }) => {
      const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { status: 'saved' };
    },
  });

  // ── 첫 화면 (닉네임 · 토큰 · 저장소) ──
  const domReady = new Promise(r => document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', r, { once: true }) : r());

  function style() {
    const st = document.createElement('style');
    st.textContent = `.idgate{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;
      background:var(--bg);padding:20px;overflow:auto}
      .idgate .card{width:100%;max-width:440px;background:var(--surface);border:1px solid var(--border);
      border-radius:var(--card-r);padding:28px;box-shadow:var(--shadow);margin:auto}
      .idgate h2{font-family:'DM Serif Display',Georgia,serif;font-size:28px;color:var(--accent-ink);margin-bottom:6px}
      .idgate p.lead{color:var(--muted);font-size:13px;margin-bottom:18px;line-height:1.7}
      .idgate .hint{color:var(--muted);font-size:11px;margin-top:6px;line-height:1.6}
      .idgate .hint a{color:var(--accent-ink)}
      .idgate .err{color:var(--danger);font-size:12px;margin-top:10px;min-height:1em}`;
    document.head.appendChild(st);
  }

  const tokenHelp = () =>
    `<p class="hint">토큰은 저장소에 글을 쓰기 위한 열쇠입니다. 이 PC 에만 저장되고 저장소에는 올라가지 않습니다.
     방을 만든 사람에게 받아서 붙여넣으세요.</p>`;

  function gate(html, onSubmit) {
    const wrap = document.createElement('div');
    wrap.className = 'idgate';
    wrap.innerHTML = `<div class="card" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(wrap);
    const err = wrap.querySelector('.err'), go = wrap.querySelector('.go');
    const submit = async () => {
      go.disabled = true; err.textContent = '';
      try { await onSubmit(wrap, err); } catch (e) { err.textContent = e && e.message || '실패했습니다.'; }
      go.disabled = false;
    };
    go.addEventListener('click', submit);
    wrap.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) submit(); });
    setTimeout(() => { const f = wrap.querySelector('input'); if (f) f.focus(); }, 50);
    return wrap;
  }

  const peopleDoc = () => ({ uid: ident.uid, name: ident.name, joinedAt: Date.now() });

  async function ensureBranches() {
    for (const br of [DATA_BRANCH, ASSET_BRANCH]) {
      try { await refreshTree(br); }
      catch (e) { if (e.code === 'not_found') await ensureBranch(br); else throw e; }
    }
  }

  // 토큰이 실제로 쓸 수 있는지 '진짜 쓰기'로 확인합니다.
  // (권한 표시만 보고 판단하면 정상 토큰을 잘못 막을 수 있어, 어차피 필요한 등록 작업으로 확인)
  async function verifyAndJoin(name, token) {
    const prev = ident;
    ident = { uid: (prev && prev.uid) || ('u_' + rand(10)), name, token };
    try {
      await gh('GET', R(), { quiet: true });
      await ensureBranches();
      await putFile(docPath('people/' + ident.uid), b64txt(JSON.stringify(peopleDoc())), DATA_BRANCH, 'join');
    } catch (e) {
      ident = prev;
      throw e;
    }
    saveIdent();
    tokenBad = false;
    return true;
  }

  function joinErrorText(e) {
    switch (e && e.code) {
      case 'unauthenticated':    return '토큰이 올바르지 않거나 만료되었습니다.';
      case 'permission_denied':  return '이 토큰에는 쓰기 권한이 없습니다. Contents 를 "Read and write" 로 만들어 주세요.';
      case 'not_found':          return '저장소를 찾을 수 없습니다. 저장소 이름과, 토큰이 그 저장소를 포함하는지 확인해 주세요. 저장소가 완전히 비어 있다면 README 파일을 하나 먼저 만들어 주세요.';
      case 'rate_limited':       return 'GitHub 사용량 제한에 걸렸습니다. 잠시 후 다시 해 주세요.';
      case 'unavailable':        return '연결하지 못했습니다. 잠시 후 다시 해 주세요.';
      default:                   return (e && e.message) || '확인하지 못했습니다.';
    }
  }

  async function askSetup() {                     // config.json 이 없을 때 (방을 만든 사람)
    await domReady; style();
    return new Promise(resolve => {
      const w = gate(`<h2>Board 설정</h2>
        <p class="lead">데이터를 저장할 GitHub 저장소를 알려 주세요. 한 번만 하면 됩니다.</p>
        <div class="form-group"><label class="form-label" for="g-repo">저장소 (계정/저장소이름)</label>
          <input class="form-input" id="g-repo" placeholder="예: junhyung/board-data" autocomplete="off"></div>
        <button class="btn btn-primary go" style="width:100%">확인</button>
        <div class="err"></div>
        <p class="hint">여기서 넣은 값은 이 PC 에만 저장됩니다. 다른 사람도 쓰게 하려면
        사이트 폴더에 <code>config.json</code> 파일을 만들어 <code>{"repo":"계정/저장소이름"}</code> 을 넣어 두세요.</p>`,
        async (wrap, err) => {
          const v = wrap.querySelector('#g-repo').value.trim();
          const m = v.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
          if (!m) { err.textContent = '계정/저장소이름 형식으로 입력해 주세요.'; return; }
          cfg.owner = m[1]; cfg.repo = m[2];
          lsSet(CFGKEY, { repo: v, api: cfg.api });
          w.remove(); resolve();
        });
    });
  }

  async function askJoin() {                      // 닉네임 + 토큰
    await domReady; style();
    return new Promise(resolve => {
      const w = gate(`<h2>Board</h2>
        <p class="lead">처음 오셨네요. 이름과 접근 토큰만 넣으면 바로 들어갑니다.<br>
        이 PC 에 저장되어, 다음부터는 주소만 열면 자동으로 들어옵니다.</p>
        <div class="form-group"><label class="form-label" for="g-name">이름 (닉네임)</label>
          <input class="form-input" id="g-name" maxlength="20" autocomplete="nickname" placeholder="예: 준형"></div>
        <div class="form-group"><label class="form-label" for="g-token">접근 토큰</label>
          <input class="form-input" id="g-token" type="password" autocomplete="off" placeholder="github_pat_…">
          ${tokenHelp()}</div>
        <button class="btn btn-primary go" style="width:100%">들어가기</button>
        <div class="err"></div>`,
        async (wrap, err) => {
          const name = wrap.querySelector('#g-name').value.trim();
          const token = wrap.querySelector('#g-token').value.trim();
          if (!name) { err.textContent = '이름을 입력해 주세요.'; return; }
          if (!token) { err.textContent = '토큰을 붙여넣어 주세요.'; return; }
          try { await verifyAndJoin(name, token); }
          catch (e) { err.textContent = joinErrorText(e); return; }
          w.remove(); resolve();
        });
    });
  }

  let tokenPromise = null;
  function askToken() {                           // 토큰이 만료되었을 때 (여러 곳에서 불러도 창은 하나)
    if (tokenPromise) return tokenPromise;
    tokenPromise = (async () => {
      await domReady; style();
      await new Promise(resolve => {
        const w = gate(`<h2>토큰 다시 입력</h2>
      <p class="lead">저장소 토큰이 만료되었거나 바뀌었습니다. 새 토큰을 붙여넣어 주세요.</p>
      <div class="form-group"><input class="form-input" id="g-token2" type="password" autocomplete="off" placeholder="github_pat_…">${tokenHelp()}</div>
      <button class="btn btn-primary go" style="width:100%">확인</button><div class="err"></div>`,
        async (wrap, err) => {
          const token = wrap.querySelector('#g-token2').value.trim();
          if (!token) return;
          const keep = ident.token;
          ident.token = token;
          try { await gh('GET', R(), { quiet: true }); }
          catch (e) { ident.token = keep; err.textContent = joinErrorText(e); return; }
          saveIdent(); tokenBad = false;
          w.remove();
          resolve();
        });
      });
      tokenPromise = null;
      refreshAll();
    })();
    return tokenPromise;
  }

  async function withToken(fn) {                  // 토큰이 풀렸으면 다시 받고 이어서
    for (let i = 0; i < 4; i++) {
      try { return await fn(); }
      catch (e) { if (e.code === 'unauthenticated') { await askToken(); continue; } throw e; }
    }
    throw { code: 'unauthenticated' };
  }

  // ── 시작 ──
  let readyP = null;
  function ready() {
    if (!readyP) readyP = (async () => {
      await loadConfig();
      if (!cfg.owner) await askSetup();
      if (!ident || !ident.uid || !ident.token) await askJoin();
      await withToken(ensureBranches);
      // 이름을 저장소에 올려 두면 다른 사람 초대 목록에 보입니다
      const p = await readDoc('people/' + ident.uid);
      if (!p || p.name !== ident.name) {
        try { await putFile(docPath('people/' + ident.uid), b64txt(JSON.stringify(peopleDoc())), DATA_BRANCH, 'join'); } catch {}
      }
      startPolling();
    })();
    return readyP;
  }

  const caps = { db: dbCap, user: userCap, room: null, assets: assetsCap, downloads: downloadsCap, live: liveCap };
  window.platform = Object.freeze({ use: async name => { await ready(); return caps[name] || null; } });

  // ── 내 정보 (⚙) ──
  const b64e = s => btoa(unescape(encodeURIComponent(s)));
  const b64d = s => decodeURIComponent(escape(atob(s)));
  window.__board = {
    name: () => (ident && ident.name) || '',
    exportCode: () => b64e(JSON.stringify({ uid: ident.uid, name: ident.name })),
    async importCode(code) {
      let v; try { v = JSON.parse(b64d(String(code).trim())); } catch { throw new Error('bad'); }
      if (!v || typeof v.uid !== 'string') throw new Error('bad');
      ident.uid = v.uid;
      ident.name = String(v.name || ident.name).slice(0, 20);
      try {                                   // 저장소에 있는 현재 이름을 따름 (그 사이 바꿨을 수 있음)
        await refreshTree(DATA_BRANCH);
        const doc = await readDoc('people/' + ident.uid);
        if (doc && doc.name) ident.name = String(doc.name).slice(0, 20);
      } catch {}
      saveIdent();
    },
    async rename(name) {
      ident.name = String(name).slice(0, 20); saveIdent();
      await putFile(docPath('people/' + ident.uid), b64txt(JSON.stringify(peopleDoc())), DATA_BRANCH, 'rename');
      refreshAll();
    },
    async setToken(token) {
      const keep = ident.token;
      ident.token = token;
      try { await gh('GET', R(), { quiet: true }); } catch (e) { ident.token = keep; throw new Error(joinErrorText(e)); }
      saveIdent(); tokenBad = false; refreshAll();
    },
    repo: () => `${cfg.owner}/${cfg.repo}`,
    livePoll(on) {                                // 실시간 보기 창을 여닫을 때
      fastRefs = Math.max(0, fastRefs + (on ? 1 : -1));
      if (on && wakePoll) wakePoll();
    },
  };
})();
