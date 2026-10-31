/* VikingGOLD – Updates + Chat modul (az app.js tölti be: import('./community.js')) */
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const ROOMS = [
  { id: 'altalanos', name: 'általános', desc: 'Beszélgetés mindenről, ami a tippekkel kapcsolatos.' },
  { id: 'tippek', name: 'tipp-beszélgetés', desc: 'Egy-egy tipp megbeszélése, vélemények.' },
  { id: 'bejelentesek', name: 'bejelentések', desc: 'Fontos közlemények az adminoktól.', adminOnly: true },
  { id: 'offtopic', name: 'offtopic', desc: 'Minden más.' }
];
const ONLINE_MS = 11 * 60e3;
const EMOJIS = ['👍', '🔥', '😂', '😮', '❤️', '🎯', '💰', '😎', '🙏', '👏', '😢', '🤔', '✅', '❌', '⚽', '🏀'];
const COMPOSER_EMOJIS = ['😀', '😂', '😅', '😉', '😍', '😎', '🤔', '😮', '😢', '😡', '👍', '👎', '👏', '🙏', '🔥', '💯', '🎯', '💰', '⚽', '🏀', '🏒', '🎾', '🍀', '🏆', '✅', '❌', '⚠️', '❤️', '🎉', '💪', '🤝', '👀'];
const TAGS = { new: 'Újdonság', imp: 'Fejlesztés', fix: 'Javítás', ann: 'Bejelentés' };

const AV_COLORS = ['#0284c7', '#6366f1', '#0d9488', '#be123c', '#b45309', '#7c3aed', '#15803d', '#c2410c'];
const colorOf = s => { let h = 0; s = String(s || '?'); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return AV_COLORS[Math.abs(h) % AV_COLORS.length]; };
const picOf = p => (p && typeof p.avatar === 'string' && p.avatar.startsWith('data:image/')) ? p.avatar : '';

/* ---------- közös segédek ---------- */
function linkify(escaped) {
  return escaped.replace(/\bhttps?:\/\/[^\s<]+/g, u => {
    const clean = u.replace(/[.,;:!?)]+$/, ''), tail = u.slice(clean.length);
    return `<a href="${clean}" target="_blank" rel="noopener noreferrer nofollow">${clean}</a>${tail}`;
  });
}
function inline(escaped) {
  return linkify(escaped)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?]|$)/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
/* egyszerű markdown az update-ekhez: # cím, - lista, **félkövér**, üres sor */
function renderBody(text, esc) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let out = '', ul = false;
  const close = () => { if (ul) { out += '</ul>'; ul = false; } };
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^\s*[-*•]\s+/.test(l)) { if (!ul) { out += '<ul>'; ul = true; } out += '<li>' + inline(esc(l.replace(/^\s*[-*•]\s+/, ''))) + '</li>'; continue; }
    close();
    if (/^#{1,3}\s+/.test(l)) out += '<h3>' + inline(esc(l.replace(/^#{1,3}\s+/, ''))) + '</h3>';
    else if (!l.trim()) out += '<div class="gap"></div>';
    else out += '<p>' + inline(esc(l)) + '</p>';
  }
  close();
  return out;
}
const tsMs = x => (x && x.toMillis) ? x.toMillis() : (typeof x === 'number' ? x : 0);
const pad2 = n => String(n).padStart(2, '0');
const hhmm = ms => { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
const dayKey = ms => { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
const shortDT = ms => { const d = new Date(ms); return `${d.getFullYear()}. ${pad2(d.getMonth() + 1)}. ${pad2(d.getDate())}. ${hhmm(ms)}`; };

function gated(c) {
  const g = c.gate();
  if (!g) return false;
  c.$('#main').innerHTML = g;
  c.gateEvents();
  return true;
}
function markRead(key) { try { localStorage.setItem(key, String(Date.now())); } catch (e) { } window.dispatchEvent(new Event('vg-read')); }
function myName(c) { return (c.profile && c.profile.name) || c.user.displayName || (c.user.email || 'tag').split('@')[0]; }

/* =====================================================================
   UPDATES
   ===================================================================== */
export function updatesPage(c) {
  const { db, user, esc, $, toast } = c;
  if (gated(c)) return;
  const admin = !!c.isAdmin;
  const seenBefore = +localStorage.getItem('vg_upd_seen') || 0;
  let docs = [], filter = 'all', editing = null;

  $('#main').innerHTML = `<section class="wrap upd">
    <div class="upd-head"><div><span class="eyebrow">Újdonságok</span><h1 style="margin:0">Updates</h1><p class="small" style="margin:6px 0 0">Itt olvashatod, mi változott az oldalon.</p></div></div>
    <div class="upd-tags" id="uTags"></div>
    ${admin ? `<div class="card upd-form" id="uForm">
      <h2 style="margin:0 0 4px;font-size:1.1rem" id="uFormT">Új bejegyzés</h2>
      <label for="uTitle">Cím</label><input id="uTitle" maxlength="120" autocomplete="off">
      <div class="row" style="align-items:flex-start;gap:14px">
        <div style="flex:1;min-width:160px"><label for="uTag">Típus</label><select id="uTag">${Object.entries(TAGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        <div style="flex:1;min-width:160px"><label for="uVer">Verzió (nem kötelező)</label><input id="uVer" maxlength="20" placeholder="pl. 1.4" autocomplete="off"></div>
      </div>
      <label for="uBody">Szöveg</label><textarea id="uBody" maxlength="6000"></textarea>
      <p class="small" style="margin:8px 0 0">Formázás: <code># Alcím</code> <code>- lista</code> <code>**félkövér**</code> – üres sor = térköz.</p>
      <label class="chk"><input type="checkbox" id="uPin"> Kitűzés az oldal tetejére</label>
      <div class="row" style="margin-top:14px"><button class="btn" id="uSave">Közzététel</button><button class="btn ghost" id="uCancel" hidden>Mégse</button></div>
    </div>` : ''}
    <div class="upd-tl" id="uList"><div class="upd-empty">Betöltés…</div></div>
  </section>`;

  const drawTags = () => {
    $('#uTags').innerHTML = [['all', 'Mind'], ...Object.entries(TAGS)].map(([k, v]) => `<button class="utag ${filter === k ? 'on' : ''}" data-f="${k}">${v}</button>`).join('');
    $('#uTags').querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filter = b.dataset.f; drawTags(); drawList(); });
  };
  const drawList = () => {
    let list = docs.slice();
    if (filter !== 'all') list = list.filter(x => x.tag === filter);
    list.sort((a, b) => (!!b.pin - !!a.pin) || ((b.created || 0) - (a.created || 0)));
    if (!list.length) { $('#uList').innerHTML = '<div class="upd-empty">Még nincs bejegyzés.</div>'; return; }
    $('#uList').innerHTML = list.map(x => {
      const tag = TAGS[x.tag] ? x.tag : 'new';
      const isNew = (x.created || 0) > seenBefore && x.authorUid !== user.uid;
      return `<article class="upd-c ${x.pin ? 'pin' : ''}" id="u-${esc(x.id)}"><i class="upd-dot"></i>
        <div class="upd-meta"><span class="tag t-${tag}">${TAGS[tag]}</span>${x.ver ? `<span class="ver">v${esc(x.ver)}</span>` : ''}${x.pin ? '<span class="pinb">📌 Kitűzve</span>' : ''}${isNew ? '<em class="newb">ÚJ</em>' : ''}<time>${x.created ? shortDT(x.created) : ''}</time></div>
        <h2>${esc(x.title)}</h2>
        <div class="upd-b">${renderBody(x.body, esc)}</div>
        ${admin ? `<div class="upd-f"><small class="small">${esc(x.author || '')}</small><div class="upd-adm"><button class="btn sm ghost" data-pin="${esc(x.id)}">${x.pin ? 'Kitűzés levétele' : 'Kitűzés'}</button><button class="btn sm ghost" data-ed="${esc(x.id)}">Szerkesztés</button><button class="btn sm danger" data-del="${esc(x.id)}">Törlés</button></div></div>` : ''}
      </article>`;
    }).join('');
    if (!admin) return;
    const byId = id => docs.find(d => d.id === id);
    $('#uList').querySelectorAll('[data-pin]').forEach(b => b.onclick = async () => {
      const x = byId(b.dataset.pin); if (!x) return;
      try { await updateDoc(doc(db, 'updates', x.id), { pin: !x.pin }); } catch (e) { toast('Nem sikerült: ' + (e.code || e.message), 'err'); }
    });
    $('#uList').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const x = byId(b.dataset.del); if (!x || !confirm('Biztosan törlöd ezt a bejegyzést?\n' + x.title)) return;
      try { await deleteDoc(doc(db, 'updates', x.id)); toast('A bejegyzés törölve.'); } catch (e) { toast('Nem sikerült: ' + (e.code || e.message), 'err'); }
    });
    $('#uList').querySelectorAll('[data-ed]').forEach(b => b.onclick = () => {
      const x = byId(b.dataset.ed); if (!x) return;
      editing = x.id;
      $('#uFormT').textContent = 'Bejegyzés szerkesztése';
      $('#uTitle').value = x.title || ''; $('#uTag').value = TAGS[x.tag] ? x.tag : 'new'; $('#uVer').value = x.ver || '';
      $('#uBody').value = x.body || ''; $('#uPin').checked = !!x.pin;
      $('#uSave').textContent = 'Mentés'; $('#uCancel').hidden = false;
      $('#uForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  if (admin) {
    const reset = () => {
      editing = null; $('#uFormT').textContent = 'Új bejegyzés';
      $('#uTitle').value = ''; $('#uVer').value = ''; $('#uBody').value = ''; $('#uPin').checked = false; $('#uTag').value = 'new';
      $('#uSave').textContent = 'Közzététel'; $('#uCancel').hidden = true;
    };
    $('#uCancel').onclick = reset;
    $('#uSave').onclick = async () => {
      const title = $('#uTitle').value.trim(), body = $('#uBody').value.trim();
      if (!title || !body) { toast('A cím és a szöveg kötelező.', 'err'); return; }
      const data = { title, body, tag: $('#uTag').value, ver: $('#uVer').value.trim(), pin: $('#uPin').checked };
      const btn = $('#uSave'); btn.disabled = true;
      try {
        if (editing) { await updateDoc(doc(db, 'updates', editing), { ...data, edited: Date.now() }); toast('A bejegyzés mentve.'); }
        else { await addDoc(collection(db, 'updates'), { ...data, created: Date.now(), authorUid: user.uid, author: myName(c) }); toast('A bejegyzés közzétéve.'); }
        reset();
      } catch (e) { toast('Nem sikerült: ' + (e.code || e.message), 'err'); }
      btn.disabled = false;
    };
  }

  drawTags();
  onSnapshot(query(collection(db, 'updates'), orderBy('created', 'desc'), limit(100)), sn => {
    docs = sn.docs.map(d => ({ id: d.id, ...d.data() }));
    drawList();
    markRead('vg_upd_seen');
  }, e => { $('#uList').innerHTML = `<div class="upd-empty">Nem tölthető be: ${esc(e.code || e.message)}</div>`; });
}

/* =====================================================================
   CHAT
   ===================================================================== */
export function chatPage(c) {
  const { db, user, esc, $, toast } = c;
  if (gated(c)) return;
  const admin = !!c.isAdmin;
  const me = { uid: user.uid, name: myName(c) };
  const roomFromHash = () => { const h = decodeURIComponent(location.hash.replace('#', '')); return ROOMS.some(r => r.id === h) ? h : 'altalanos'; };

  let room = roomFromHash(), limitN = 60, msgs = [], users = {}, pres = {}, pinned = null;
  let unsubMsgs = null, unsubRoom = null, replyTo = null, editingId = null, stick = true, firstLoad = true;

  $('#main').innerHTML = `<section class="wrap chat-wrap"><div class="dc" id="dc">
    <aside class="dc-side">
      <div class="dc-h">💬 Chat</div>
      <div class="dc-ch" id="dcCh"></div>
      <div class="dc-me" id="dcMe"></div>
    </aside>
    <div class="dc-main">
      <div class="dc-top"><b id="dcName"></b><span class="dc-desc" id="dcDesc"></span><button class="dc-ic" id="dcMemBtn" aria-label="Tagok" title="Tagok">👥</button></div>
      <div class="dc-pin" id="dcPin" hidden></div>
      <div class="dc-msgs" id="dcMsgs" aria-live="polite"></div>
      <button class="dc-new" id="dcNew" hidden>Új üzenetek ↓</button>
      <div class="dc-reply" id="dcReply" hidden></div>
      <div class="dc-compw">
        <div class="dc-comp">
          <button class="dc-ic" id="dcEmoBtn" aria-label="Emoji" type="button">😊</button>
          <div class="dc-emo" id="dcEmo" hidden>${COMPOSER_EMOJIS.map(e => `<button type="button" data-e="${e}">${e}</button>`).join('')}</div>
          <textarea id="dcIn" rows="1" maxlength="1000" placeholder="Írj üzenetet…" aria-label="Üzenet"></textarea>
          <button class="dc-ic" id="dcSend" type="button" aria-label="Küldés">➤</button>
        </div>
      </div>
    </div>
    <aside class="dc-mem" id="dcMem"></aside>
  </div></section>`;

  const dc = $('#dc'), box = $('#dcMsgs'), input = $('#dcIn');
  const roomDef = () => ROOMS.find(r => r.id === room);
  const canPost = () => !roomDef().adminOnly || admin;
  const userOf = uid => users[uid] || null;
  const isAdm = (uid, name) => (uid && users[uid] && c.adminName(users[uid].name)) || c.adminName(name);

  const avatar = (uid, name) => {
    const u = userOf(uid), pic = picOf(u);
    return pic ? `<span class="av pic"><img src="${pic}" alt=""></span>` : `<span class="av" style="background:${colorOf(name)}">${esc(String(name || '?').replace(/^_+/, '').charAt(0).toUpperCase() || '?')}</span>`;
  };
  const isOnline = uid => (pres[uid] || 0) > Date.now() - ONLINE_MS;

  /* ---------- oldalsáv ---------- */
  const drawRooms = () => {
    $('#dcCh').innerHTML = ROOMS.map(r => `<button class="dc-chb ${r.id === room ? 'on' : ''}" data-r="${r.id}"><span>#</span>${esc(r.name)}</button>`).join('');
    $('#dcCh').querySelectorAll('[data-r]').forEach(b => b.onclick = () => { location.hash = b.dataset.r; });
    $('#dcName').textContent = '# ' + roomDef().name;
    $('#dcDesc').textContent = roomDef().desc;
    input.disabled = !canPost(); $('#dcSend').disabled = !canPost();
    input.placeholder = canPost() ? 'Írj üzenetet…' : 'Ide csak az adminok írhatnak.';
  };
  const drawMe = () => {
    $('#dcMe').innerHTML = `${avatar(me.uid, me.name)}<div><b>${esc(me.name)}</b><small>${admin ? 'Admin' : (c.profile && c.profile.vip ? 'VIP' : '')}</small></div>`;
  };
  const drawMembers = () => {
    const list = Object.entries(users).map(([id, u]) => ({ id, ...u })).filter(u => !u.disabled && u.name);
    const grp = (u) => c.adminName(u.name) ? 0 : (isOnline(u.id) ? 1 : 2);
    list.sort((a, b) => grp(a) - grp(b) || (!!b.vip - !!a.vip) || String(a.name).localeCompare(String(b.name), 'hu'));
    const titles = ['Adminok', 'Online', 'Offline'];
    let html = '', last = -1;
    list.forEach(u => {
      const g = grp(u);
      if (g !== last) { html += `<div class="mg">${titles[g]}</div>`; last = g; }
      const on = isOnline(u.id);
      html += `<div class="mb ${on || g === 0 ? '' : 'off'}" data-m="${esc(u.name)}" style="cursor:pointer"><span class="avw">${avatar(u.id, u.name)}<i class="st ${on ? 'on' : ''}"></i></span><span class="${g === 0 ? 'adm' : u.vip ? 'vip' : ''}">${esc(u.name)}</span></div>`;
    });
    $('#dcMem').innerHTML = html || '<div class="mg">Nincs tag</div>';
    $('#dcMem').querySelectorAll('[data-m]').forEach(el => el.onclick = () => insertAtCursor('@' + el.dataset.m + ' '));
  };

  /* ---------- üzenetek ---------- */
  function msgHtml(m, prev) {
    const dayNew = !prev || dayKey(prev.t) !== dayKey(m.t);
    const grp = prev && !dayNew && prev.uid === m.uid && !m.rp && (m.t - prev.t) < 5 * 60e3;
    const adm = isAdm(m.uid, m.name), u = userOf(m.uid), vip = !!(u && u.vip) && !adm;
    const lowText = String(m.text || '').toLowerCase(), ment = lowText.includes('@' + me.name.toLowerCase()) && m.uid !== me.uid;
    const mine = m.uid === me.uid;
    const canDel = mine || admin;
    let text = linkify(esc(m.text || '')).replace(/(^|[\s(])@([^\s@<.,!?;:)]{1,32})/g, (all, pre, nm) => {
      const self = nm.toLowerCase() === me.name.toLowerCase();
      return `${pre}<span class="mn ${self ? 'me' : ''}">@${nm}</span>`;
    });
    const rx = m.rx || {};
    const rxHtml = Object.keys(rx).filter(k => Array.isArray(rx[k]) && rx[k].length).map(k => `<button class="rx ${rx[k].includes(me.uid) ? 'on' : ''}" data-rx="${esc(k)}" data-id="${esc(m.id)}">${esc(k)} <b>${rx[k].length}</b></button>`).join('');
    const head = grp ? `<span class="dc-gt">${hhmm(m.t)}</span>` : avatar(m.uid, m.name);
    const body = editingId === m.id
      ? `<div class="dc-edit"><textarea id="edTx" maxlength="1000">${esc(m.text)}</textarea><div class="row"><button class="btn sm" data-edsave="${esc(m.id)}">Mentés</button><button class="btn sm ghost" data-edcancel="1">Mégse</button><small>Enter = mentés, Esc = mégse</small></div></div>`
      : `<div class="dc-tx">${text}${m.edited ? ' <span class="ed">(szerkesztve)</span>' : ''}</div>`;
    return `${dayNew ? `<div class="dc-day">${esc(c.huDate(dayKey(m.t)))}</div>` : ''}
    <div class="dc-m ${grp ? 'grp' : ''} ${ment ? 'ment' : ''} ${mine ? 'mine' : ''}" id="m-${esc(m.id)}" data-id="${esc(m.id)}">
      ${head}
      <div class="dc-b">
        ${grp ? '' : `<div class="dc-hd"><b class="nm ${adm ? 'adm' : vip ? 'vip' : ''}">${esc(m.name)}</b>${adm ? '<i class="bdg">ADMIN</i>' : vip ? '<i class="bdg vipb">VIP</i>' : ''}<time>${hhmm(m.t)}</time></div>`}
        ${m.rp ? `<a class="dc-rq" data-goto="${esc(m.rp.id || '')}"><b>↪ ${esc(m.rp.name)}</b> ${esc(String(m.rp.text || '').slice(0, 90))}</a>` : ''}
        ${body}
        ${rxHtml ? `<div class="dc-rx">${rxHtml}</div>` : ''}
      </div>
      <div class="dc-act">${EMOJIS.slice(0, 4).map(e => `<button data-react="${e}" data-id="${esc(m.id)}" title="Reakció">${e}</button>`).join('')}<i></i>
        <button data-reply="${esc(m.id)}" title="Válasz">↩</button>
        ${mine ? `<button data-edit="${esc(m.id)}" title="Szerkesztés">✏️</button>` : ''}
        ${admin ? `<button data-pinm="${esc(m.id)}" title="Kitűzés">📌</button>` : ''}
        ${canDel ? `<button data-del="${esc(m.id)}" title="Törlés">🗑</button>` : ''}</div>
    </div>`;
  }
  function drawMsgs(keepScroll) {
    const prevH = box.scrollHeight, prevT = box.scrollTop;
    let html = '';
    if (msgs.length >= limitN) html += '<button class="dc-more" id="dcMore">Korábbi üzenetek</button>';
    if (!msgs.length) html += `<div class="dc-empty"><div class="big">💬</div>Még nincs üzenet ebben a csatornában.<br>${canPost() ? 'Légy te az első!' : ''}</div>`;
    msgs.forEach((m, i) => { html += msgHtml(m, msgs[i - 1]); });
    box.innerHTML = html;
    if (keepScroll) box.scrollTop = prevT + (box.scrollHeight - prevH);
    else if (stick) box.scrollTop = box.scrollHeight;
    wire();
    if (editingId) { const t = $('#edTx'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
  }
  function wire() {
    const more = $('#dcMore'); if (more) more.onclick = () => { limitN += 60; subscribeMsgs(true); };
    const byId = id => msgs.find(m => m.id === id);
    box.querySelectorAll('[data-reply]').forEach(b => b.onclick = e => { e.stopPropagation(); const m = byId(b.dataset.reply); if (m) setReply(m); });
    box.querySelectorAll('[data-react]').forEach(b => b.onclick = e => { e.stopPropagation(); react(b.dataset.id, b.dataset.react); });
    box.querySelectorAll('[data-rx]').forEach(b => b.onclick = () => react(b.dataset.id, b.dataset.rx));
    box.querySelectorAll('[data-edit]').forEach(b => b.onclick = e => { e.stopPropagation(); editingId = b.dataset.edit; drawMsgs(); });
    box.querySelectorAll('[data-edcancel]').forEach(b => b.onclick = () => { editingId = null; drawMsgs(); });
    box.querySelectorAll('[data-edsave]').forEach(b => b.onclick = () => saveEdit(b.dataset.edsave));
    const ed = $('#edTx'); if (ed) ed.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(editingId); } if (e.key === 'Escape') { editingId = null; drawMsgs(); } };
    box.querySelectorAll('[data-del]').forEach(b => b.onclick = e => { e.stopPropagation(); delMsg(b.dataset.del); });
    box.querySelectorAll('[data-pinm]').forEach(b => b.onclick = e => { e.stopPropagation(); pinMsg(byId(b.dataset.pinm)); });
    box.querySelectorAll('[data-goto]').forEach(a => a.onclick = () => gotoMsg(a.dataset.goto));
    box.querySelectorAll('.dc-m').forEach(el => el.onclick = e => { if (e.target.closest('button,a,textarea')) return; const was = el.classList.contains('sel'); box.querySelectorAll('.dc-m.sel').forEach(x => x.classList.remove('sel')); if (!was) el.classList.add('sel'); });
  }
  function gotoMsg(id) {
    const el = id && document.getElementById('m-' + id); if (!el) { toast('Az eredeti üzenet már nem látható.', 'err'); return; }
    el.scrollIntoView({ block: 'center' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }

  /* ---------- műveletek ---------- */
  const msgDoc = id => doc(db, 'chatRooms', room, 'messages', id);
  async function react(id, emo) {
    const m = msgs.find(x => x.id === id); if (!m) return;
    const cur = (m.rx && Array.isArray(m.rx[emo])) ? m.rx[emo] : [];
    const next = cur.includes(me.uid) ? cur.filter(u => u !== me.uid) : cur.concat(me.uid);
    const rx = { ...(m.rx || {}) }; if (next.length) rx[emo] = next; else delete rx[emo];
    try { await updateDoc(msgDoc(id), { rx }); } catch (e) { toast('Nem sikerült: ' + (e.code || e.message), 'err'); }
  }
  async function saveEdit(id) {
    const t = $('#edTx'); if (!t) return;
    const text = t.value.trim(); const m = msgs.find(x => x.id === id);
    if (!text || !m) { editingId = null; drawMsgs(); return; }
    if (text !== m.text) { try { await updateDoc(msgDoc(id), { text, edited: true }); } catch (e) { toast('Nem sikerült: ' + (e.code || e.message), 'err'); } }
    editingId = null; drawMsgs();
  }
  async function delMsg(id) {
    if (!confirm('Biztosan törlöd ezt az üzenetet?')) return;
    try { await deleteDoc(msgDoc(id)); } catch (e) { toast('Nem sikerült: ' + (e.code || e.message), 'err'); }
  }
  async function pinMsg(m) {
    if (!m) return;
    const isPinned = pinned && pinned.id === m.id;
    try { await setDoc(doc(db, 'chatRooms', room), { pin: isPinned ? null : { id: m.id, name: m.name, text: String(m.text || '').slice(0, 300) } }, { merge: true }); }
    catch (e) { toast('Nem sikerült: ' + (e.code || e.message), 'err'); }
  }
  function setReply(m) {
    replyTo = { id: m.id, name: m.name, text: String(m.text || '').slice(0, 120) };
    const r = $('#dcReply'); r.hidden = false;
    r.innerHTML = `<span>Válasz neki: <b>${esc(m.name)}</b> – ${esc(replyTo.text)}</span><button type="button" id="dcRx" aria-label="Mégse">✕</button>`;
    $('#dcRx').onclick = clearReply; input.focus();
  }
  function clearReply() { replyTo = null; const r = $('#dcReply'); r.hidden = true; r.innerHTML = ''; }
  function insertAtCursor(t) {
    if (input.disabled) return;
    const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? s;
    input.value = input.value.slice(0, s) + t + input.value.slice(e);
    input.focus(); input.selectionStart = input.selectionEnd = s + t.length; autoGrow();
  }
  const autoGrow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; };
  let lastSend = 0;
  async function send() {
    if (!canPost()) return;
    const text = input.value.trim(); if (!text) return;
    if (Date.now() - lastSend < 900) { toast('Lassabban, kérlek.', 'err'); return; }
    lastSend = Date.now();
    const data = { uid: me.uid, name: me.name, text: text.slice(0, 1000), ts: serverTimestamp() };
    if (replyTo) data.rp = replyTo;
    input.value = ''; autoGrow(); const rp = replyTo; clearReply(); stick = true;
    try { await addDoc(collection(db, 'chatRooms', room, 'messages'), data); }
    catch (e) { input.value = text; if (rp) setReply({ id: rp.id, name: rp.name, text: rp.text }); toast('Nem sikerült elküldeni: ' + (e.code || e.message), 'err'); }
  }

  /* ---------- feliratkozások ---------- */
  function drawPin() {
    const p = $('#dcPin');
    if (!pinned || !pinned.id) { p.hidden = true; return; }
    p.hidden = false; p.innerHTML = `<span>📌</span><div><b>${esc(pinned.name || '')}</b>: ${esc(pinned.text || '')}</div>`;
    p.onclick = () => gotoMsg(pinned.id);
  }
  function subscribeRoom() {
    if (unsubRoom) unsubRoom();
    pinned = null; drawPin();
    unsubRoom = onSnapshot(doc(db, 'chatRooms', room), s => { pinned = (s.exists() && s.data().pin) || null; drawPin(); }, () => { });
  }
  function subscribeMsgs(keep) {
    if (unsubMsgs) unsubMsgs();
    const r = room;
    unsubMsgs = onSnapshot(query(collection(db, 'chatRooms', r, 'messages'), orderBy('ts', 'desc'), limit(limitN)), sn => {
      if (r !== room) return;
      const wasNear = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
      const prevCount = msgs.length;
      msgs = sn.docs.map(d => { const x = d.data({ serverTimestamps: 'estimate' }); return { id: d.id, ...x, t: tsMs(x.ts) || Date.now() }; }).reverse();
      if (firstLoad) { stick = true; firstLoad = false; }
      else if (!keep) stick = wasNear || (msgs.length && msgs[msgs.length - 1].uid === me.uid);
      drawMsgs(!!keep && !stick);
      if (!stick && msgs.length > prevCount && !keep) $('#dcNew').hidden = false;
      if (document.visibilityState === 'visible') markRead('vg_read_' + r);
    }, e => { box.innerHTML = `<div class="dc-empty">Nem tölthető be: ${esc(e.code || e.message)}</div>`; });
  }
  function switchRoom() {
    room = roomFromHash(); window.vgChatRoom = room;
    limitN = 60; msgs = []; editingId = null; firstLoad = true; stick = true; clearReply();
    $('#dcNew').hidden = true; dc.classList.remove('mem-open');
    drawRooms(); subscribeRoom(); subscribeMsgs(false);
    markRead('vg_read_' + room);
  }

  /* ---------- események ---------- */
  box.addEventListener('scroll', () => { const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120; stick = near; if (near) $('#dcNew').hidden = true; });
  $('#dcNew').onclick = () => { stick = true; box.scrollTop = box.scrollHeight; $('#dcNew').hidden = true; };
  $('#dcSend').onclick = send;
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  $('#dcEmoBtn').onclick = e => { e.stopPropagation(); const p = $('#dcEmo'); p.hidden = !p.hidden; };
  $('#dcEmo').querySelectorAll('[data-e]').forEach(b => b.onclick = e => { e.stopPropagation(); insertAtCursor(b.dataset.e); });
  document.addEventListener('click', e => { const p = $('#dcEmo'); if (p && !p.hidden && !e.target.closest('#dcEmo')) p.hidden = true; });
  $('#dcMemBtn').onclick = () => dc.classList.toggle('mem-open');
  window.addEventListener('hashchange', () => { if (roomFromHash() !== room) switchRoom(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') markRead('vg_read_' + room); });

  /* tagok + jelenlét (ritkán változik, a lista ezekből épül) */
  onSnapshot(collection(db, 'users'), sn => { users = {}; sn.docs.forEach(d => { users[d.id] = d.data(); }); drawMembers(); if (!editingId) drawMsgs(true); }, () => { });
  onSnapshot(query(collection(db, 'presence'), orderBy('t', 'desc'), limit(300)), sn => { pres = {}; sn.docs.forEach(d => { pres[d.id] = (d.data() || {}).t || 0; }); drawMembers(); }, () => { });
  setInterval(drawMembers, 60000);

  drawMe(); switchRoom();
}
