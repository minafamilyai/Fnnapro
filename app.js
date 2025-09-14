// app.js — Full rewrite with room approval flow, preserving Fnn UI elements if present

// ===== Utilities & DOM =====
const $ = (s)=>document.querySelector(s);
const $$ = (s)=>Array.from(document.querySelectorAll(s));

// Toast (use pre-existing if provided)
let toast = window.toast || ((msg, actions=[])=>{
  console.log('[toast]', msg);
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  const wrap = $('#toasts') || document.body;
  wrap.appendChild(t);
  if(actions && actions.length){
    const aBar = document.createElement('div'); aBar.className='toast-actions';
    actions.forEach(a=>{
      const b = document.createElement('button'); b.textContent=a.label||'OK';
      b.onclick=()=>{ try{a.onClick?.();}catch(e){console.error(e);} t.remove(); };
      aBar.appendChild(b);
    });
    t.appendChild(aBar);
  }
  setTimeout(()=>t.remove(), 6000);
});

const messagesEl = $('#messages') || $('.messages') || $('#chatList') || document.body;
const msgInput   = $('#msgInput') || $('#messageInput') || $('textarea');
const sendBtn    = $('#sendBtn') || $('#send') || $('#sendCenter');
const attachBtn  = $('#attachBtn') || $('#attach');
const fileInput  = $('#fileInput') || $('#fileCenter');
const linkBtn    = $('#linkBtn');
const homeBtn    = $('#homeBtn') || $('#exitBtn');
const qrCanvas   = $('#qrCanvas'); // optional

function scrollBottom(){ try{ messagesEl.scrollTop = messagesEl.scrollHeight; }catch(_){} }

function addMsg(m){
  const d = document.createElement('div');
  d.className = 'msg ' + (m.type||'text');
  if(m.from){
    const h = document.createElement('div');
    h.className = 'from';
    h.textContent = m.from;
    d.appendChild(h);
  }
  const c = document.createElement('div');
  c.className = 'content';
  if(m.type === 'file' && m.url){
    const a = document.createElement('a');
    a.href = m.url; a.textContent = m.name || 'Tập tin'; a.target='_blank';
    c.appendChild(a);
  } else {
    c.textContent = m.text || '';
  }
  d.appendChild(c);
  messagesEl.appendChild(d);
  scrollBottom();
}

function info(text){
  addMsg({ type:'system', from:'SYSTEM', text });
}

// ===== Firebase =====
if(!window.firebaseConfig){ throw new Error('Thiếu config.js (firebaseConfig).'); }

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getDatabase, ref, child, set, get, push, onValue, onChildAdded, remove, update } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { getStorage, ref as sRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

const app = initializeApp(window.firebaseConfig);
const auth = getAuth(app);
const db   = getDatabase(app);
const st   = getStorage(app);

// ===== Identity & State =====
const LOCAL_UID_KEY = 'onechat_uid';
let MY_UID = localStorage.getItem(LOCAL_UID_KEY);
if(!MY_UID){
  MY_UID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem(LOCAL_UID_KEY, MY_UID);
}

let uid=null, currentCode='', isOwner=false, myName=null;
let roomRef=null, membersRef=null, requestsRef=null, messagesRef=null;

function isCode(t){ return /^[A-Z0-9]{4,10}$/.test((t||'').trim()); }
function randCode(){ const s='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let r=''; for(let i=0;i<6;i++) r+=s[Math.floor(Math.random()*s.length)]; return r; }
function roomLink(code){ return location.origin + location.pathname + '?room=' + code; }

// ===== UI helpers =====
function setTopbar(code){
  const codeEl = $('#codeTextTop'); if(codeEl) codeEl.textContent = code;
  if(linkBtn){
    linkBtn.onclick = ()=>{
      const l = roomLink(code);
      navigator.clipboard?.writeText(l);
      info('Đã copy LINK: ' + l);
    };
  }
  if(qrCanvas && window.QRCode){
    window.QRCode.toCanvas(qrCanvas, roomLink(code), { width: 220 }, (err)=>{
      if(err) console.error(err);
    });
  }
}

function renderMembersToChat(members){
  const arr = Object.values(members||{}).map(x => x.name + (x.uid===MY_UID?' (bạn)':'' ) + (x.isOwner?' (chủ)':''));
  info('Thành viên: ' + (arr.join(', ') || '—'));
}

// ===== Core approval flow =====
async function nextGuestName(code){
  const snap = await get(child(ref(db), `rooms/${code}/members`));
  const members = snap.val() || {};
  const names = Object.keys(members).filter(k=>/^chimse\d+$/.test(k)).map(k=>parseInt(k.replace('chimse',''),10));
  const next = (names.length?Math.max(...names):0)+1;
  return 'chimse' + next;
}

async function ensureRoom(code){
  roomRef     = ref(db, `rooms/${code}`);
  membersRef  = child(roomRef, 'members');
  requestsRef = child(roomRef, 'joinRequests');
  messagesRef = child(roomRef, 'messages');

  // Claim owner if not exists
  const ownSnap = await get(child(roomRef, 'ownerId'));
  let ownerId = ownSnap.exists() ? ownSnap.val() : null;
  if(!ownerId){
    await set(child(roomRef,'ownerId'), MY_UID);
    ownerId = MY_UID;
  }
  isOwner = ownerId === MY_UID;
  return ownerId;
}

async function ownerFlow(){
  // Create or reuse current code
  currentCode = (new URLSearchParams(location.search).get('room')||'').toUpperCase() || randCode();
  setTopbar(currentCode);

  await ensureRoom(currentCode);

  // Join self (owner) to members list
  await update(membersRef, { 'Daibang': { name:'Daibang', ts:Date.now(), uid: MY_UID, isOwner:true } });
  myName = 'Daibang';

  // Watch join requests
  onChildAdded(requestsRef, (s)=>{
    const req = s.val(); if(!req) return;
    const label = (req.proposed||'Khách') + ' (' + s.key.slice(-4) + ')';
    toast('Yêu cầu vào phòng: ' + label, [
      { label:'Chấp nhận', onClick: async ()=>{
          const name = await nextGuestName(currentCode);
          await update(membersRef, { [name]: { name, ts:Date.now(), uid:s.key } });
          await update(child(requestsRef, s.key), { status:'approved', name });
        } 
      },
      { label:'Từ chối', onClick: async ()=>{
          await update(child(requestsRef, s.key), { status:'denied' });
        } 
      },
    ]);
  });

  // Watch members & messages
  onValue(membersRef, s=> renderMembersToChat(s.val()));
  onChildAdded(messagesRef, s=> addMsg(s.val()));

  info('Bạn là chủ phòng. Người khác cần bạn duyệt để vào.');
  history.replaceState({}, '', roomLink(currentCode));
}

async function joinerFlow(code){
  currentCode = code.toUpperCase();
  setTopbar(currentCode);

  await ensureRoom(currentCode);

  // ✅ FIX: nếu bạn là người đầu tiên (đã thành chủ) thì KHÔNG gửi join request — chuyển sang owner mode
  if(isOwner){
    await update(membersRef, { 'Daibang': { name:'Daibang', ts:Date.now(), uid: MY_UID, isOwner:true } });
    myName = 'Daibang';
    onValue(membersRef, s=> renderMembersToChat(s.val()));
    onChildAdded(messagesRef, s=> addMsg(s.val()));
    info('Bạn là chủ phòng. Người khác cần bạn duyệt để vào.');
    return;
  }

  // Non-owner: gửi yêu cầu vào phòng và chờ duyệt
  const proposed = await nextGuestName(currentCode);
  await set(child(requestsRef, MY_UID), { uid:MY_UID, proposed, ts:Date.now(), status:'pending' });
  info('Đã gửi yêu cầu vào phòng. Vui lòng chờ chủ phòng chấp nhận…');

  onValue(child(requestsRef, MY_UID), (s)=>{
    const v = s.val(); if(!v) return;
    if(v.status === 'approved' && v.name){
      myName = v.name;
      info('Đã được chấp nhận. Bạn có thể nhắn tin.');
    } else if(v.status === 'denied'){
      info('Yêu cầu bị từ chối.');
    }
  });

  onValue(membersRef, s=> renderMembersToChat(s.val()));
  onChildAdded(messagesRef, s=> addMsg(s.val()));
}

// ===== Messaging & Files =====
function canSend(){
  if(isOwner) return true;
  return !!myName;
}

async function pushText(text){
  await push(messagesRef, { type:'text', from: myName || '—', text, ts: Date.now() });
}

async function pushFile(file){
  const path = `rooms/${currentCode}/uploads/${Date.now()}_${(file.name||'file').replace(/[^a-zA-Z0-9\.\-_]/g,'_')}`;
  const refS = sRef(st, path);
  const buf = await file.arrayBuffer();
  await uploadBytes(refS, new Blob([buf]), { contentType: file.type || 'application/octet-stream' });
  const url = await getDownloadURL(refS);
  await push(messagesRef, { type:'file', from: myName || '—', name: file.name, url, ts: Date.now() });
}

// ===== UI events =====
sendBtn && sendBtn.addEventListener('click', async ()=>{
  const t = (msgInput?.value||'').trim();
  if(!t) return;
  if(isCode(t)){
    if(currentCode && t.toUpperCase() !== currentCode){
      if(!confirm(`Vào phòng ${t.toUpperCase()}? Bạn sẽ rời phòng hiện tại.`)) return;
    }
    location.href = roomLink(t.toUpperCase());
    return;
  }
  if(!canSend()){ toast('Chưa được duyệt/vào phòng.'); return; }
  msgInput.value='';
  await pushText(t);
});

msgInput && msgInput.addEventListener('keydown', (e)=>{
  if(e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    sendBtn?.click();
  }
});

attachBtn && attachBtn.addEventListener('click', ()=> fileInput?.click());
fileInput && fileInput.addEventListener('change', async (e)=>{
  const files = Array.from(e.target.files||[]);
  if(!files.length) return;
  if(!canSend()){ toast('Chưa được duyệt/vào phòng.'); fileInput.value=''; return; }
  for(const f of files){
    try{ await pushFile(f); }catch(err){ console.error(err); toast('Upload lỗi: '+(err.message||err)); }
  }
  fileInput.value='';
});

homeBtn && homeBtn.addEventListener('click', (e)=>{
  e.preventDefault?.();
  location.href = location.origin + location.pathname;
});

// ===== Bootstrap =====
signInAnonymously(auth).catch(e=>{ console.error(e); toast('Bật Anonymous trong Firebase Auth'); });
onAuthStateChanged(auth, async (u)=>{
  if(!u) return;
  uid = u.uid;
  const qs = new URLSearchParams(location.search);
  const roomParam = (qs.get('room')||'').toUpperCase();
  try{
    if(roomParam) await joinerFlow(roomParam);
    else await ownerFlow();
  }catch(err){
    console.error(err);
    toast('Lỗi khởi tạo: '+(err.message||err));
  }
});
