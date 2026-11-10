/* GitHub 저장소 연결 — 서버 없이 GitHub Pages 에서 돌아가는 판
   · 신원: 이 PC(브라우저)에 저장되는 닉네임. GitHub 계정과는 무관합니다.
   · 저장: 문서는 data 브랜치, 첨부는 assets 브랜치 (Pages 브랜치를 건드리지 않아 사이트가 다시 빌드되지 않음)
           실시간 편집 중인 파일 내용은 live 브랜치 — data 브랜치를 건드리지 않아 다른 화면이 목록을 다시 받지 않음
   · 실시간: data 브랜치의 파일 목록을 ETag 로 4초마다 확인 (바뀐 게 없으면 304 라서 사용량에 안 잡힘,
             바뀌었으면 그 응답이 곧 새 목록 → 변경 한 번에 요청 1회)
             실시간 창이 열려 있는 동안은 1.5초마다, 탭을 안 보고 있을 때는 15초마다
   · 토큰: 저장소에 쓰기 위한 열쇠. 코드가 아니라 각자 브라우저에만 저장됩니다.
   · 로그아웃: 이 PC 에 저장된 이름·토큰을 지워, 다음 사람이 토큰 없이 들어오지 못하게 합니다.
     '공용 PC' 로 들어오면 브라우저를 닫을 때 저절로 지워집니다 (sessionStorage). */
(function () {
  'use strict';
  const IDKEY = 'board.gh.identity.v1';
  const BYEKEY = 'board.gh.loggedOut';             // 방금 로그아웃함 (다음 첫 화면 안내용, 이 탭에만)
  const CFGKEY = 'board.gh.config.v1';
  const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  const API_VER = '2022-11-28';
  const DATA_BRANCH = 'data', ASSET_BRANCH = 'assets', LIVE_BRANCH = 'live';
  const POLL_MS = 4000;
  const FAST_POLL_MS = 1500;
  const HIDDEN_POLL_MS = 15000;                    // 탭을 안 보고 있을 때 (그 사이 변경은 한 번에 모아서 받음)
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
  const ssGet = (k, d) => { try { const v = sessionStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const ssSet = (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const lsDel = k => { try { localStorage.removeItem(k); } catch {} };
  const ssDel = k => { try { sessionStorage.removeItem(k); } catch {} };
  let cfg = null;      // { owner, repo, api }
  // { uid, name, token, temp }  temp = 공용 PC → 브라우저를 닫으면 사라지는 곳(sessionStorage)에만 둠
  let ident = lsGet(IDKEY, null) || ssGet(IDKEY, null);
  const saveIdent = () => {
    if (!ident) return;
    if (ident.temp) { ssSet(IDKEY, ident); lsDel(IDKEY); }
    else            { lsSet(IDKEY, ident); ssDel(IDKEY); }
  };
  // 다른 탭에서 로그아웃하면 이 탭도 따라서 첫 화면으로
  window.addEventListener('storage', e => {
    if ((e.key === IDKEY || e.key === null) && e.storageArea === localStorage && !e.newValue
        && ident && !ident.temp) location.reload();
  });

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
          if (branch === DATA_BRANCH) noteOwnCommit(r.data.commit);
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
          const r = await gh('DELETE', `${R()}/contents/${encPath(path)}`, { body: { message: 'delete ' + path, sha, branch } });
          setTreeSha(branch, path, null);
          if (branch === DATA_BRANCH) noteOwnCommit(r.data && r.data.commit);
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

  // ── 파일 목록(트리) ──
  const trees = { [DATA_BRANCH]: new Map(), [ASSET_BRANCH]: new Map(), [LIVE_BRANCH]: new Map() };
  const treeSha = (b, p) => (trees[b] || new Map()).get(p) || null;
  // 방금 내가 쓴 것 [브랜치, 경로, 새 sha, 이전 sha, 시각] — 조금 늦은 목록이 와도 내 것이 사라지지 않게
  let recentWrites = [];
  const setTreeSha = (b, p, sha) => {
    const t = trees[b]; if (!t) return;
    const prev = t.get(p) || null;
    if (sha) t.set(p, sha); else t.delete(p);
    if (b === DATA_BRANCH) recentWrites.push([p, sha || null, prev, Date.now()]);
  };
  function applyTree(list) {                     // data 브랜치의 새 목록을 받아 바꿔 끼움
    const map = new Map();
    for (const n of list || []) if (n.type === 'blob') map.set(n.path, n.sha);
    const now = Date.now();
    recentWrites = recentWrites.filter(w => now - w[3] < 10000);
    for (const [p, sha, prev] of recentWrites) {
      // 받은 목록이 아직 '내가 쓰기 전' 모습이면 내 것이 더 새것. 다른 값이면 누가 그 뒤에 또 쓴 것이라 그대로 둠
      if ((map.get(p) || null) === prev) { if (sha) map.set(p, sha); else map.delete(p); }
    }
    trees[DATA_BRANCH] = map;
  }
  async function loadTree(ref, etag, quiet) {    // ref = 브랜치 이름 또는 커밋 sha
    const r = await gh('GET', `${R()}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { etag, quiet, cache: 'no-store' });
    if (r.notModified) return r;
    applyTree(r.data.tree);
    if (r.data.truncated) console.warn('tree truncated');
    return r;
  }

  // ── 내용 캐시 ──
  // 크기 한도가 있고, 넘치면 오래 안 쓴 것부터 버립니다 (한꺼번에 비우면 전부 다시 받느라 요청이 몰림)
  function lru(maxBytes) {
    const m = new Map();
    let total = 0;
    return {
      get(k) { const e = m.get(k); if (!e) return undefined; m.delete(k); m.set(k, e); return e.v; },
      set(k, v, size) {
        const old = m.get(k);
        if (old) { total -= old.size; m.delete(k); }
        m.set(k, { v, size }); total += size;
        while (total > maxBytes && m.size > 1) { const [ok, oe] = m.entries().next().value; m.delete(ok); total -= oe.size; }
      },
    };
  }
  const BAD = Symbol('bad json');
  const docCache  = lru(24 * 1048576);    // blob sha → 풀어 놓은 JSON (sha 는 내용 해시라 내용이 바뀌지 않음)
  const partCache = lru(64 * 1048576);    // 첨부 id → 바이트 (id 마다 내용이 정해져 있음)
  const inflight  = new Map();            // 같은 것을 동시에 두 번 받지 않게
  function once(key, fn) {
    let pr = inflight.get(key);
    if (!pr) { pr = fn().finally(() => inflight.delete(key)); inflight.set(key, pr); }
    return pr;
  }
  async function pool(items, n, fn) {     // 한 번에 n 개씩 나란히
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; await fn(items[k], k); }
    }));
  }
  // 문서 하나의 내용. 받다가 끊기면 예외(→ 호출한 쪽이 다시 시도), 내용이 깨졌으면 null
  async function readJson(sha) {
    const hit = docCache.get(sha);
    if (hit !== undefined) return hit === BAD ? null : hit;
    return once('d:' + sha, async () => {
      const r = await gh('GET', `${R()}/git/blobs/${sha}`, { accept: 'application/vnd.github.raw', raw: 'text' });
      let v;
      try { v = JSON.parse(r.text); } catch { v = BAD; }
      docCache.set(sha, v, r.text.length * 2 + 64);
      return v === BAD ? null : v;
    });
  }
  // 문서 쓰기: 방금 올린 내용을 캐시에 넣어 두어, 내가 쓴 것을 다시 내려받지 않음
  async function putDoc(path, data, message) {
    const text = JSON.stringify(data);
    const r = await putFile(docPath(path), b64txt(text), DATA_BRANCH, message);
    if (r && r.content && r.content.sha) docCache.set(r.content.sha, JSON.parse(text), text.length * 2 + 64);
    return r;
  }
  async function ensureBranch(branch) {
    const repo = await gh('GET', R());
    const base = await gh('GET', `${R()}/git/ref/heads/${encodeURIComponent(repo.data.default_branch)}`);
    try {
      await gh('POST', `${R()}/git/refs`, { body: { ref: 'refs/heads/' + branch, sha: base.data.object.sha } });
    } catch (e) { if (e.code !== 'conflict') throw e; }
    trees[branch] = new Map();
    if (branch === DATA_BRANCH) { treeEtag = rootSha = headEtag = headSha = null; }
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

  async function readDoc(path) {                 // 없으면 null. 받다가 끊기면 예외 (없는 것으로 착각해 덮어쓰지 않게)
    const sha = treeSha(DATA_BRANCH, docPath(path));
    return sha ? readJson(sha) : null;
  }
  function children(coll) {                      // 이 묶음 바로 아래 문서들 [id, sha] — 내용은 읽지 않음
    const prefix = DOC_DIR + coll + '/', out = [];
    for (const [p, sha] of trees[DATA_BRANCH]) {
      if (!p.startsWith(prefix) || !p.endsWith('.json')) continue;
      const rest = p.slice(prefix.length, -5);
      if (!rest.includes('/')) out.push([rest, sha]);
    }
    return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  async function listColl(coll, kids) {
    kids = kids || children(coll);
    const got = new Array(kids.length);
    let partial = false;
    await pool(kids, 6, async ([id, sha], k) => {
      try { const data = await readJson(sha); if (data && typeof data === 'object') got[k] = { id, sha, data }; }
      catch { partial = true; }                  // 못 받은 문서는 빼고, 조금 뒤 다시 시도
    });
    const out = got.filter(Boolean);
    out.partial = partial;
    return out;
  }

  const listeners = new Set();
  async function runQuery(coll, where, kids) {
    const all = await listColl(coll, kids);
    let rows = all;
    if (coll === 'rooms') rows = rows.filter(r => Array.isArray(r.data.members) && r.data.members.includes(ident.uid));
    rows = rows.filter(r => (where || []).every(([f, op, v]) => {
      const cur = r.data[f];
      if (op === '==') return cur === v;
      if (op === 'array-contains') return Array.isArray(cur) && cur.includes(v);
      return true;
    }));
    const docs = rows.map(r => snapDoc(r.id, r.data));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false },
             _sig: rows.map(r => r.id + ':' + r.sha).join('|'), _partial: all.partial };
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
        // 묶음 구독: 그 아래 파일들의 sha 가 그대로면 내용을 읽지도, 비교하지도 않고 끝
        const kids = children(l.coll);
        const collSig = kids.map(k => k[0] + ':' + k[1]).join('|');
        if (collSig === l.collSig) continue;
        let snap;
        try { snap = await runQuery(l.coll, l.where, kids); }
        catch (e) { if (l.sig === null && l.err) l.err(e); break; }
        if (snap._partial) setTimeout(() => { if (listeners.has(l)) refresh(l); }, 3000);
        else l.collSig = collSig;
        if (snap._sig !== l.sig) { l.sig = snap._sig; if (listeners.has(l)) l.next(snap); }
      } while (l.again);
    } finally { l.busy = false; }
  }
  const refreshAll = () => { for (const l of [...listeners]) refresh(l); };

  // 문서 하나: 파일 목록의 sha 가 바뀔 때만 다시 읽음 (sha 는 내용 해시)
  async function runDoc(l) {
    const sha = treeSha(DATA_BRANCH, docPath(l.doc));
    const sig = sha || '-';
    if (sig === l.sig) return;
    const data = sha ? await readJson(sha) : null;      // 네트워크 오류는 위로 던져 다음에 다시 시도
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
        const l = { coll: path, where, next, err, sig: null, collSig: null, busy: false, again: false };
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
      await putDoc(path, data);
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
  const branchOk = {};                           // 브랜치 → 있는 것을 확인함 (처음 올릴 때 한 번만 물어봄)
  async function branchReady(branch) {
    if (branchOk[branch]) return;
    try { await gh('GET', `${R()}/branches/${branch}`, { quiet: true }); }
    catch (e) { if (e.code !== 'not_found') throw e; await ensureBranch(branch); }
    branchOk[branch] = true;
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
      await branchReady(LIVE_BRANCH);
      await putFile(docPath(path), b64txt(JSON.stringify(obj)), LIVE_BRANCH, 'live ' + path);
    },
    async delete(path) {
      assertPath(path, true);
      liveCache.delete(path);
      try { await delFile(docPath(path), LIVE_BRANCH); }
      catch (e) { if (e.code !== 'not_found') throw e; }
    },
  });

  // ── 변경 확인 ──
  // 'tree'  : data 브랜치의 파일 목록을 ETag 로 물어봄. 그대로면 304(무료), 바뀌었으면 그 응답이 새 목록 → 변경당 요청 1회
  // 'branch': 예전 방식. 브랜치 머리글(1회) → 목록(1회). ETag 가 통하지 않는 환경이면 저절로 이쪽으로 바뀜
  let pollMode = 'tree';
  let treeEtag = null, rootSha = null, sameRoot = 0;
  let headEtag = null, headSha = null;
  let polling = false, fastRefs = 0, wakePoll = null;

  // 내가 올린 커밋이 '알고 있던 머리' 바로 다음이면 목록을 다시 받을 필요가 없음 ('branch' 방식에서만 쓰임)
  function noteOwnCommit(c) {
    if (pollMode === 'branch' && headSha && c && c.sha && c.parents && c.parents.length === 1 && c.parents[0].sha === headSha) headSha = c.sha;
  }
  async function pollOnce(quiet = true) {        // → 바뀌었으면 true
    if (pollMode === 'tree') {
      const sent = treeEtag;
      const r = await loadTree(DATA_BRANCH, sent, quiet);
      if (r.notModified) { sameRoot = 0; return false; }
      treeEtag = r.etag || null;
      const same = r.data.sha === rootSha;
      rootSha = r.data.sha;
      // 바뀐 게 없는데 304 대신 목록이 통째로 오기를 되풀이하거나 ETag 가 아예 없으면, 4초마다 요청을 쓰게 되므로 예전 방식으로
      if (!treeEtag || (same && sent && ++sameRoot >= 3)) { pollMode = 'branch'; headEtag = headSha = null; }
      if (!same) sameRoot = 0;
      return !same;
    }
    const r = await gh('GET', `${R()}/branches/${DATA_BRANCH}`, { etag: headEtag, quiet, cache: 'no-store' });
    if (r.notModified) return false;
    headEtag = r.etag;
    const sha = r.data.commit.sha;
    if (sha === headSha) return false;
    await loadTree(sha, null, quiet);
    headSha = sha;
    return true;
  }

  function napPoll(ms) {                         // 기다리다가 빠른 확인으로 바뀌거나 탭으로 돌아오면 바로 깨어남
    return new Promise(r => {
      const t = setTimeout(() => { wakePoll = null; r(); }, ms);
      wakePoll = () => { clearTimeout(t); wakePoll = null; r(); };
    });
  }
  const pollDelay = () => (document.hidden ? HIDDEN_POLL_MS : fastRefs > 0 ? FAST_POLL_MS : POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && wakePoll) wakePoll(); });
  async function startPolling() {
    if (polling) return;
    polling = true;
    let delay = pollDelay();
    for (;;) {
      await napPoll(delay);
      if (!ident) return;                          // 로그아웃함
      try {
        if (await pollOnce()) refreshAll();
        if (onlineCb) onlineCb(true);
        delay = pollDelay();
      } catch (e) {
        if (onlineCb) onlineCb(false, e);
        delay = Math.min(delay * 2, 60000);
      }
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
    acceptsText: true,                                  // base64 문자열을 Blob 으로 싸지 않고 바로 받을 수 있음
    upload: async blob => {
      const text = (typeof blob === 'string' ? blob : await blob.text()).trim();   // 이미 base64 (앱이 조각내어 보냄)
      if (!text) throw { code: 'invalid_request' };
      const id = rand(16);
      try {
        await branchReady(ASSET_BRANCH);
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

  // 앱이 첨부 조각을 읽을 때 쓰는 통로.
  // 조각은 id 마다 내용이 정해져 있어 목록(트리) 없이 경로로 바로 받고, id 로 캐시합니다.
  const ASSET_ID = /^[A-Za-z0-9_-]{8,80}$/;
  function assetBytes(id) {
    const hit = partCache.get(id);
    if (hit) return Promise.resolve(hit);
    return once('a:' + id, async () => {
      const r = await gh('GET', `${R()}/contents/${encPath(assetPath(id))}?ref=${ASSET_BRANCH}`,
                         { accept: 'application/vnd.github.raw+json', raw: 'bytes' });
      partCache.set(id, r.bytes, r.bytes.length);
      return r.bytes;
    });
  }
  // 바이트 그대로 (없으면 null, 받다가 끊기면 예외). 받은 배열은 캐시와 같이 쓰므로 고치지 말 것
  window.assetFetchBytes = async id => {
    if (!ASSET_ID.test(String(id))) return null;
    try { return await assetBytes(String(id)); }
    catch (e) { if (e && e.code === 'not_found') return null; throw e; }
  };
  // 방금 올린 조각을 캐시에 넣어 두어, 올린 사람이 자기 파일을 다시 내려받지 않게
  window.assetSeed = (id, bytes) => { if (ASSET_ID.test(String(id)) && bytes && bytes.length) partCache.set(String(id), bytes, bytes.length); };
  // 예전 통로 (base64 문자열)
  window.assetFetch = async id => {
    try {
      const bytes = await window.assetFetchBytes(id);
      return bytes ? { ok: true, text: async () => b64enc(bytes) } : { ok: false, text: async () => '' };
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
      .idgate .err{color:var(--danger);font-size:12px;margin-top:10px;min-height:1em}
      .idgate details{margin:-4px 0 14px;font-size:13px}
      .idgate summary{cursor:pointer;color:var(--accent-ink);font-size:12px;margin-bottom:8px}
      .idgate .chk{display:flex;gap:8px;align-items:flex-start;font-size:13px;margin:0 0 16px;cursor:pointer;line-height:1.5}
      .idgate .chk input{margin-top:3px;accent-color:var(--accent-ink);width:15px;height:15px;flex-shrink:0}
      .idgate .bye{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;
        font-size:13px;line-height:1.6;margin-bottom:16px}`;
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

  // 내 접속 코드 = { uid, name } 를 base64 로. 코드만으로는 못 들어오고 토큰이 함께 있어야 함
  const b64e = s => btoa(unescape(encodeURIComponent(s)));
  const b64d = s => decodeURIComponent(escape(atob(s)));
  function readCode(code) {
    let v;
    try { v = JSON.parse(b64d(String(code).trim())); } catch { throw new Error('bad'); }
    if (!v || typeof v.uid !== 'string' || !/^[A-Za-z0-9_-]{3,80}$/.test(v.uid)) throw new Error('bad');
    return { uid: v.uid, name: String(v.name || '').slice(0, 20) };
  }

  // 시작할 때 data 브랜치의 목록을 한 번 받음 (없으면 만듦).
  // assets · live 브랜치는 처음 올릴 때 만들어지고, 조각은 id 로 바로 받으므로 목록이 필요 없음
  async function ensureBranches() {
    try { await pollOnce(false); }
    catch (e) { if (e.code === 'not_found') await ensureBranch(DATA_BRANCH); else throw e; }
  }

  // 토큰이 실제로 쓸 수 있는지 '진짜 쓰기'로 확인합니다.
  // (권한 표시만 보고 판단하면 정상 토큰을 잘못 막을 수 있어, 어차피 필요한 등록 작업으로 확인)
  async function verifyAndJoin(name, token, opts = {}) {
    const prev = ident;
    const from = opts.code ? readCode(opts.code) : null;      // 전에 쓰던 사람으로
    const uid = from ? from.uid : ((prev && prev.uid) || ('u_' + rand(10)));
    ident = { uid, name: name || (from && from.name) || '', token, temp: !!opts.temp };
    try {
      await gh('GET', R(), { quiet: true });
      await ensureBranches();
      if (from && !name) {                                    // 이름을 비워 두면 저장소에 있는 지금 이름을 따름
        const doc = await readDoc('people/' + uid);
        if (doc && doc.name) ident.name = String(doc.name).slice(0, 20);
      }
      if (!ident.name) ident.name = '이름 없음';
      await putDoc('people/' + ident.uid, peopleDoc(), 'join');
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

  async function askJoin() {                      // 닉네임 + 토큰 (+ 전에 쓰던 사람의 접속 코드)
    await domReady; style();
    const bye = ssGet(BYEKEY, null);
    ssDel(BYEKEY);
    return new Promise(resolve => {
      const w = gate(`<h2>Board</h2>
        ${bye ? `<div class="bye">✓ 로그아웃했습니다. 이 PC 에는 이름·토큰·방 비밀번호가 남아 있지 않습니다.
                 ${bye === 'temp' ? '' : '<br>공용 PC 였다면 브라우저 창도 닫아 주세요.'}</div>` : ''}
        <p class="lead">${bye ? '다시 들어오려면' : '처음 오셨네요.'} 이름과 접근 토큰만 넣으면 바로 들어갑니다.<br>
        이 PC 에 저장되어, 다음부터는 주소만 열면 자동으로 들어옵니다.</p>
        <div class="form-group"><label class="form-label" for="g-name">이름 (닉네임)</label>
          <input class="form-input" id="g-name" maxlength="20" autocomplete="nickname" placeholder="예: 준형"></div>
        <div class="form-group"><label class="form-label" for="g-token">접근 토큰</label>
          <input class="form-input" id="g-token" type="password" autocomplete="off" placeholder="github_pat_…">
          ${tokenHelp()}</div>
        <details${bye ? ' open' : ''}><summary>전에 쓰던 사람으로 들어오기 (내 접속 코드)</summary>
          <input class="form-input" id="g-code" autocomplete="off" spellcheck="false" placeholder="로그아웃할 때 보관한 코드를 붙여넣으세요">
          <p class="hint">코드를 넣으면 이름은 비워 둬도 됩니다. 전에 쓰던 이름·참여한 방·올린 파일이 그대로 이어집니다.</p>
        </details>
        <label class="chk"><input type="checkbox" id="g-temp"${bye === 'temp' ? ' checked' : ''}>
          <span><b>공용 PC예요</b> — 브라우저를 닫으면 자동으로 로그아웃됩니다.</span></label>
        <p class="hint" id="g-temp-hint" style="margin:-10px 0 16px"${bye === 'temp' ? '' : ' hidden'}>
          브라우저가 비밀번호(토큰)를 저장할지 물으면 꼭 <b>저장 안 함</b>을 눌러 주세요.</p>
        <button class="btn btn-primary go" style="width:100%">들어가기</button>
        <div class="err"></div>`,
        async (wrap, err) => {
          const name = wrap.querySelector('#g-name').value.trim();
          const token = wrap.querySelector('#g-token').value.trim();
          const code = wrap.querySelector('#g-code').value.trim();
          const temp = wrap.querySelector('#g-temp').checked;
          if (!name && !code) { err.textContent = '이름을 입력해 주세요.'; return; }
          if (!token) { err.textContent = '토큰을 붙여넣어 주세요.'; return; }
          if (code) { try { readCode(code); } catch { err.textContent = '접속 코드가 올바르지 않습니다. 보관한 코드를 그대로 붙여넣어 주세요.'; return; } }
          try { await verifyAndJoin(name, token, { code, temp }); }
          catch (e) { err.textContent = joinErrorText(e); return; }
          w.remove(); resolve();
        });
      const tc = w.querySelector('#g-temp');
      tc.addEventListener('change', () => { w.querySelector('#g-temp-hint').hidden = !tc.checked; });
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
      let p = null, known = true;
      try { p = await readDoc('people/' + ident.uid); } catch { known = false; }     // 못 읽었으면 건드리지 않음
      if (known && (!p || p.name !== ident.name)) {
        try { await putDoc('people/' + ident.uid, peopleDoc(), 'join'); } catch {}
      }
      startPolling();
    })();
    return readyP;
  }

  const caps = { db: dbCap, user: userCap, room: null, assets: assetsCap, downloads: downloadsCap, live: liveCap };
  window.platform = Object.freeze({ use: async name => { await ready(); return caps[name] || null; } });

  // ── 내 정보 (⚙) ──
  window.__board = {
    name: () => (ident && ident.name) || '',
    exportCode: () => b64e(JSON.stringify({ uid: ident.uid, name: ident.name })),
    async importCode(code) {
      const v = readCode(code);
      ident.uid = v.uid;
      ident.name = String(v.name || ident.name).slice(0, 20);
      try {                                   // 저장소에 있는 현재 이름을 따름 (그 사이 바꿨을 수 있음)
        await pollOnce(false);
        const doc = await readDoc('people/' + ident.uid);
        if (doc && doc.name) ident.name = String(doc.name).slice(0, 20);
      } catch {}
      saveIdent();
    },
    async rename(name) {
      ident.name = String(name).slice(0, 20); saveIdent();
      await putDoc('people/' + ident.uid, peopleDoc(), 'rename');
      refreshAll();
    },
    async setToken(token) {
      const keep = ident.token;
      ident.token = token;
      try { await gh('GET', R(), { quiet: true }); } catch (e) { ident.token = keep; throw new Error(joinErrorText(e)); }
      saveIdent(); tokenBad = false; refreshAll();
    },
    repo: () => `${cfg.owner}/${cfg.repo}`,
    temp: () => !!(ident && ident.temp),         // 공용 PC 로 들어왔는지
    // 이 PC 에서 로그아웃: 올리는 중이던 것을 마저 보낸 뒤 이름·토큰을 지움 (방 비밀번호는 화면 쪽에서 지움)
    async logout() {
      try { await Promise.race([wq, sleep(10000)]); } catch {}
      const wasTemp = !!(ident && ident.temp);
      lsDel(IDKEY); ssDel(IDKEY);
      ident = null;
      ssSet(BYEKEY, wasTemp ? 'temp' : '1');
    },
    livePoll(on) {                                // 실시간 보기 창을 여닫을 때
      fastRefs = Math.max(0, fastRefs + (on ? 1 : -1));
      if (on && wakePoll) wakePoll();
    },
  };
})();
