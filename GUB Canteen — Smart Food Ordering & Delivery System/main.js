'use strict';

const $ = (selector) => document.querySelector(selector);
const byId = (id) => document.getElementById(id);
const money = (n) => `৳${Number(n).toLocaleString('en-BD')}`;
const escapeHTML = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const loadJSON = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const state = {
  mode: 'loading', me: null, csrf: null, menu: [], cart: loadJSON('gub_cart_v2', {}),
  category: 'All', search: '', orders: [], jobs: [],
  demoRole: localStorage.getItem('gub_demo_role_v2') === 'rider' ? 'rider' : 'customer',
  authTab: 'login', jobTab: 'open', active: '', pending: false, returnToCheckout: false,
  config: {base_fee:15,step_fee:5,items_per_tier:2,platform_percent:100/3}, categories: ['Meals','Breakfast','Chicken','Snacks','Beverages','Cakes','Biscuits']
};
const demoUsers = {
  customer: {id:'demo-customer', name:'Demo Customer', student_id:'DEMO-1001', phone:'01000000001'},
  rider: {id:'demo-rider', name:'Demo Courier', student_id:'DEMO-2002', phone:'01000000002'}
};
function renderPricing(){
  const cfg=state.config;const el=byId('pricingTiers');if(!el)return;
  el.innerHTML=[0,1,2,3].map(i=>{const a=i*cfg.items_per_tier+1,b=(i+1)*cfg.items_per_tier;const fee=deliveryFee(a),cut=platformShare(fee);return `<div class="tier-row"><div><strong>${a}–${b} items</strong><small>Platform ${money(cut)} · Rider ${money(fee-cut)}</small></div><b>${money(fee)}</b></div>`;}).join('');
  byId('pricingSplit').textContent=`Every delivery: ${cfg.platform_percent.toFixed(2)}% of delivery fee to platform, remaining to student courier (rounded to whole taka).`;
  byId('pricingFooter').textContent='The same commission percentage applies when delivery fees increase. Demo figures; owner can edit the fee rules. Actual payments are not collected by this site.';
}
const itemById = (id) => state.menu.find((m) => m.id === id);
const countItems = () => Object.values(state.cart).reduce((a,b)=>a+b, 0);
const deliveryFee = (qty) => qty ? state.config.base_fee + state.config.step_fee * Math.floor((qty - 1) / state.config.items_per_tier) : 0;
const platformShare = (fee) => Math.round(fee * state.config.platform_percent / 100);
const foodImage = (m) => m.image ? `<img src="${escapeHTML(m.image.startsWith('/uploads/')?m.image:'images/'+m.image)}" alt="${escapeHTML(m.name)}" loading="lazy">` : `<div class="menu-no-photo">${({'Beverages':'☕','Cakes':'🍰','Biscuits':'🍪'})[m.category]||'🍽'}</div>`;
function renderCategories(){const node=byId('categoryFilters');if(!node)return; const available=[...new Set([...state.categories,...state.menu.map(m=>m.category)])];node.innerHTML=['All',...available].map(cat=>`<button class="category-chip ${state.category===cat?'active':''}" data-category="${escapeHTML(cat)}">${cat==='All'?'All items':escapeHTML(cat)}</button>`).join('');}
const foodTotal = () => Object.entries(state.cart).reduce((n,[id,q])=>n+(itemById(id)?.price || 0)*q,0);
const orderCost = () => foodTotal() + deliveryFee(countItems());
const savedCart = () => localStorage.setItem('gub_cart_v2', JSON.stringify(state.cart));

function toast(message, isError=false) {
  const div=document.createElement('div'); div.className='toast'+(isError?' error':''); div.textContent=message;
  byId('toastStack').append(div); setTimeout(()=>div.remove(),3950);
}
function emptyState(icon,title,description,buttonText='',click='') {
  return `<div class="empty-state"><div class="empty-illustration">${icon}</div><h3>${escapeHTML(title)}</h3><p>${escapeHTML(description)}</p>${buttonText?`<button data-empty-action="${click}">${escapeHTML(buttonText)}</button>`:''}</div>`;
}
function refreshAccountLabel() {
  byId('accountLabel').textContent = state.mode === 'demo' ? `Demo: ${state.demoRole === 'rider'?'Rider':'Buyer'}` : state.me ? state.me.name.split(' ')[0] : 'Sign in';
}
function updateBag() {
  const qty=countItems(); byId('cartCount').textContent=qty; byId('drawerCount').textContent=`(${qty})`;
}
function renderMenu() {
  const grid=byId('foodGrid');
  const entries=state.menu.filter((m)=>(state.category==='All'||m.category===state.category) && m.name.toLowerCase().includes(state.search.toLowerCase()));
  if (!entries.length) { grid.innerHTML='<div class="no-results">No dishes match your search. Try another category or food name.</div>'; return; }
  grid.innerHTML=entries.map((item,i)=>`<article class="food-card" style="--delay:${Math.min(i,9)*30}ms">
    <div class="food-photo">${foodImage(item)}<span class="food-badge">${escapeHTML(item.tag)}</span></div>
    <div class="food-details"><div class="food-category">${escapeHTML(item.category)}</div><h3 class="food-name">${escapeHTML(item.name)}</h3><div class="food-card-bottom"><span class="food-price">${money(item.price)}</span><button class="food-add" data-add="${item.id}" aria-label="Add ${escapeHTML(item.name)} to cart"><svg class="icon"><use href="#i-plus"/></svg></button></div></div></article>`).join('');
}
function addItem(id,delta=1) {
  if(!itemById(id)) return;
  const qty=Math.max(0,Math.min(20,(state.cart[id]||0)+delta));
  if(qty) state.cart[id]=qty; else delete state.cart[id];
  savedCart(); updateBag(); if(state.active==='cartDrawer') renderCart();
  if(delta>0) { byId('cartBtn').classList.remove('bump'); void byId('cartBtn').offsetWidth; byId('cartBtn').classList.add('bump'); toast(`${itemById(id).name} added to your bag`); }
}
function billHTML() {
  return `<div class="bill-row"><span>Food subtotal (${countItems()} item${countItems()===1?'':'s'})</span><strong>${money(foodTotal())}</strong></div><div class="bill-row"><span>Quantity-based delivery</span><strong>${money(deliveryFee(countItems()))}</strong></div><div class="bill-row total"><span>Total to pay</span><strong>${money(orderCost())}</strong></div>`;
}
function renderCart() {
  const entries=Object.entries(state.cart).filter(([id,q])=>q>0 && itemById(id));
  if(!entries.length){byId('cartBody').innerHTML=emptyState('🛍','Your bag is waiting','Browse the menu and add something delicious.','Explore menu','menu');byId('cartSummary').innerHTML='';return;}
  byId('cartBody').innerHTML=entries.map(([id,quantity])=>{
    const m=itemById(id);
    return `<article class="cart-line">${foodImage(m)}<div><h3 class="cart-line-name">${escapeHTML(m.name)}</h3><span class="cart-line-price">${money(m.price)} each</span><div class="qty-controls"><button data-qty="${id}" data-delta="-1" aria-label="Remove one ${escapeHTML(m.name)}"><svg class="icon"><use href="#i-minus"/></svg></button><span>${quantity}</span><button data-qty="${id}" data-delta="1" aria-label="Add one ${escapeHTML(m.name)}"><svg class="icon"><use href="#i-plus"/></svg></button></div></div><strong class="cart-line-total">${money(m.price*quantity)}</strong></article>`;
  }).join('');
  byId('cartSummary').innerHTML=billHTML()+`<p class="bill-hint">Includes ${money(platformShare(deliveryFee(countItems())))} platform share and ${money(deliveryFee(countItems())-platformShare(deliveryFee(countItems())))} student-delivery earnings. Pay on delivery (demo).</p><button class="btn btn-primary full-btn" id="checkoutBtn">Continue to checkout <svg class="icon"><use href="#i-arrow"/></svg></button>`;
}
function setOpen(panelName) {
  closeAll(); const panel=byId(panelName); if(!panel)return;
  state.active=panelName; byId('backdrop').hidden=false; panel.classList.add('open');panel.setAttribute('aria-hidden','false');document.body.classList.add('no-scroll');
  if(panelName==='cartDrawer') renderCart();
  if(panelName==='ordersDrawer') {renderOrders();refreshData();}
  if(panelName==='jobsDrawer') {renderJobs();refreshData();}
  if(panelName==='authModal') renderAuth();
  if(panelName==='checkoutModal') byId('checkoutTotal').innerHTML=billHTML();
  setTimeout(()=>{const el=panel.querySelector('button, input, select');if(el)el.focus({preventScroll:true});},120);
}
function closeAll() {
  document.querySelectorAll('.drawer,.modal-shell').forEach(el=>{el.classList.remove('open');el.setAttribute('aria-hidden','true');});
  byId('backdrop').hidden=true;document.body.classList.remove('no-scroll');state.active='';
}
async function request(url,method='GET',body=null) {
  const headers={'Accept':'application/json'};
  if(method!=='GET'){headers['Content-Type']='application/json';if(state.csrf)headers['X-CSRF-Token']=state.csrf;}
  const res=await fetch(url,{method,headers,credentials:'same-origin',body:body?JSON.stringify(body):undefined});
  const payload=await res.json().catch(()=>({error:'Server returned an invalid response.'}));
  if(!res.ok)throw new Error(payload.error||`Request failed (${res.status})`);
  return payload;
}
function demoOrders() {return loadJSON('gub_demo_orders_v2',[]);}
function writeDemoOrders(orders) {localStorage.setItem('gub_demo_orders_v2',JSON.stringify(orders));}
function roleSwitch(role) { state.demoRole=role; localStorage.setItem('gub_demo_role_v2',role);state.me=demoUsers[role];refreshAccountLabel();refreshData();toast(role==='rider'?'Now viewing as demo rider':'Now viewing as demo buyer'); }
async function refreshData() {
  if(state.mode==='demo') {
    const all=demoOrders();state.orders=all.filter(o=>o.buyer_id===state.me.id||o.courier_id===state.me.id).slice().reverse();
    state.jobs=all.filter(o=>o.status==='placed'&&o.buyer_id!==state.me.id); rerenderOpen();return;
  }
  if(state.mode!=='server' || !state.me){state.orders=[];state.jobs=[];rerenderOpen();return;}
  try {
    const [orders,jobs]=await Promise.all([request('/api/orders'),request('/api/jobs')]);
    state.orders=orders.orders||[];state.jobs=jobs.jobs||[];rerenderOpen();
  } catch(error){if(state.active==='ordersDrawer'||state.active==='jobsDrawer')toast(error.message,true);}
}
function rerenderOpen() {if(state.active==='ordersDrawer')renderOrders();if(state.active==='jobsDrawer')renderJobs();}
function statusStep(status){return ({placed:1,accepted:2,picked_up:3,delivered:4,cancelled:0})[status]??0;}
function prettyStatus(status){return ({placed:'Order placed',accepted:'Rider accepted',picked_up:'Picked up',delivered:'Delivered',cancelled:'Cancelled'})[status]||status;}
function niceDate(date){const d=new Date(date);return isNaN(d)?'Recently':d.toLocaleString('en-BD',{dateStyle:'medium',timeStyle:'short'});}
function demoSwitchMarkup(){return state.mode==='demo'?`<div class="demo-switch"><span><strong>LOCAL DEMO MODE</strong><br>Orders stay in this browser only.</span><button data-switch-role="${state.demoRole==='rider'?'customer':'rider'}">Switch to ${state.demoRole==='rider'?'buyer':'rider'}</button></div>`:'';}
function orderCard(o){
  const isBuyer=String(o.buyer_id)===String(state.me?.id);const isCourier=String(o.courier_id)===String(state.me?.id);
  const buyerName=o.buyer?.name?escapeHTML(o.buyer.name):'Student';const courierName=o.courier?.name?escapeHTML(o.courier.name):'Not assigned yet';
  const nextAction=isCourier&&o.status==='accepted'?'pickup':isCourier&&o.status==='picked_up'?'deliver':null;
  return `<article class="order-card"><div class="order-card-head"><strong class="order-number">Order #${o.id}</strong><span class="status-pill ${o.status}">${prettyStatus(o.status)}</span></div>
    <p class="order-meta"><strong>${isBuyer?"You're the customer":"You're delivering"}</strong> • ${niceDate(o.created_at)}<br><svg class="icon" style="height:13px;width:13px;vertical-align:-3px"><use href="#i-pin"/></svg> ${escapeHTML(o.building)}, Floor ${escapeHTML(o.floor)}, ${escapeHTML(o.room)}<br>${isBuyer?'Courier: '+courierName:'Customer: '+buyerName}${isCourier&&o.buyer?.phone?' • '+escapeHTML(o.buyer.phone):''}</p>
    <div class="order-items">${(o.items||[]).map(i=>escapeHTML(i.name)+' ×'+i.quantity).join(' · ')}</div>
    <div class="order-steps">${[1,2,3,4].map(n=>`<span class="${statusStep(o.status)>=n?'done':''}"></span>`).join('')}</div>
    <div class="order-summary-line"><div><small>${isCourier?'Your delivery earnings':'Total (food + delivery)'}</small><br><strong>${money(isCourier?o.courier_share:o.total)}</strong></div><div class="order-actions">${isBuyer&&o.status==='placed'?`<button class="cancel" data-order-act="cancel" data-id="${o.id}">Cancel</button>`:''}${nextAction?`<button data-job-act="${nextAction}" data-id="${o.id}">${nextAction==='pickup'?'Mark as picked up':'Mark as delivered'}</button>`:''}</div></div></article>`;
}
function renderOrders() {
  if(!state.me){byId('ordersBody').innerHTML=`<div class="login-required"><strong>Sign in to track your orders</strong><p>Use your GUB student account to see order progress.</p><button class="btn btn-primary" data-empty-action="auth">Sign in</button></div>`;return;}
  byId('ordersBody').innerHTML=demoSwitchMarkup()+(state.orders.length?state.orders.map(orderCard).join(''):emptyState('📦','No orders just yet','Your orders and deliveries will show up here.','Browse food','menu'));
}
function jobCard(o) {
  return `<article class="job-card"><div class="job-card-head"><strong class="order-number">Pickup #${o.id}</strong><span class="status-pill">Open delivery</span></div><p class="job-meta"><svg class="icon" style="height:13px;width:13px;vertical-align:-3px"><use href="#i-pin"/></svg> <strong>${escapeHTML(o.building)}</strong>, Floor ${escapeHTML(o.floor)}, ${escapeHTML(o.room)}<br>${o.quantity} food items • ${niceDate(o.created_at)}</p><div class="job-earn"><strong>${money(o.courier_share)}</strong><span>you earn from this delivery</span></div><div class="order-summary-line"><small>Pick up at the GUB canteen, deliver to the campus meeting point</small><div class="order-actions"><button data-job-act="accept" data-id="${o.id}">Accept job</button></div></div></article>`;
}
function renderJobs() {
  if(!state.me){byId('jobsBody').innerHTML=`<div class="login-required"><strong>Be a student delivery partner</strong><p>Sign in or register to accept an available campus delivery.</p><button class="btn btn-primary" data-empty-action="auth">Sign in / Join</button></div>`;return;}
  const assigned=state.orders.filter(o=>String(o.courier_id)===String(state.me.id));
  const list=state.jobTab==='open'?state.jobs:assigned;
  byId('jobsBody').innerHTML=demoSwitchMarkup()+`<div class="job-callout">Any registered student can accept an open delivery. Once accepted, only that student can mark pickup and delivery. Arrange canteen payment separately in this prototype.</div><div class="drawer-tabbar"><button data-job-tab="open" class="${state.jobTab==='open'?'active':''}">Open jobs (${state.jobs.length})</button><button data-job-tab="mine" class="${state.jobTab==='mine'?'active':''}">My deliveries (${assigned.length})</button></div>`+(list.length ? list.map(o=>state.jobTab==='open'?jobCard(o):orderCard(o)).join('') : emptyState('🚲',state.jobTab==='open'?'No open deliveries right now':'No deliveries assigned','When a student places an order, it appears here for other students to accept.','View food menu','menu'));
}
function renderAuth() {
  if(state.mode==='demo') {
    byId('authTitle').textContent='Explore demo accounts';
    byId('authBody').innerHTML=`<div class="auth-content">${demoSwitchMarkup()}<div class="profile-head"><div class="profile-avatar">${state.demoRole==='rider'?'R':'B'}</div><div><strong>${state.me.name}</strong><small>${state.me.student_id} · browser-only demo</small></div></div><div class="profile-actions"><button data-empty-action="orders">My orders</button><button data-empty-action="jobs">Delivery jobs</button></div><p class="auth-help">For real student-to-student orders across devices, run <code>python server.py</code> instead of Live Server. Demo orders are not sent to the canteen.</p></div>`;
    return;
  }
  if(state.me && state.me.role !== 'student'){byId('authTitle').textContent='Staff account';byId('authBody').innerHTML=`<div class="auth-content"><p>You are signed in as <strong>${escapeHTML(state.me.name)}</strong>.</p><a href="admin.html" class="btn btn-primary full-btn">Open Admin Dashboard</a><button class="secondary-action" style="width:100%;margin-top:12px" id="logoutBtn">Sign out</button></div>`;return;}
  if(state.me){
    byId('authTitle').textContent='My student account';
    byId('authBody').innerHTML=`<div class="auth-content"><div class="profile-head"><div class="profile-avatar">${escapeHTML(state.me.name[0]).toUpperCase()}</div><div><strong>${escapeHTML(state.me.name)}</strong><small>ID: ${escapeHTML(state.me.student_id)}</small></div></div><div class="profile-actions"><button data-empty-action="orders">My orders</button><button data-empty-action="jobs">Delivery jobs</button></div><button class="secondary-action" style="width:100%;margin-top:11px" id="logoutBtn">Sign out</button><p class="auth-help">Both ordering and delivery are available with one account. Student ID is self-reported in this prototype.</p></div>`;return;
  }
  byId('authTitle').textContent=state.authTab==='login'?'Welcome back':'Join the GUB community';
  byId('authBody').innerHTML=`<div class="auth-content"><div class="auth-tabs"><button data-auth-tab="login" class="${state.authTab==='login'?'active':''}">Sign in</button><button data-auth-tab="register" class="${state.authTab==='register'?'active':''}">Create account</button></div>
  <form id="authForm">
  ${state.authTab==='register'?`<div class="field-group"><label>Full name<input name="name" autocomplete="name" placeholder="Your name" minlength="2" maxlength="70" required></label></div>`:''}
  <div class="field-group"><label>GUB student ID<input name="student_id" inputmode="numeric" pattern="[0-9]{6,15}" maxlength="15" placeholder="e.g. 223002026" required autocomplete="username"></label></div>
  ${state.authTab==='register'?`<div class="field-group"><label>Mobile number<input name="phone" type="tel" placeholder="01XXXXXXXXX" required autocomplete="tel"></label></div>`:''}
  <div class="field-group"><label>Password<input name="password" type="password" minlength="8" maxlength="128" placeholder="8 characters or more" autocomplete="${state.authTab==='login'?'current-password':'new-password'}" required></label></div>
  <button type="submit" class="btn btn-primary full-btn" id="submitAuth">${state.authTab==='login'?'Sign in':'Create my account'} <svg class="icon"><use href="#i-arrow"/></svg></button></form><p class="auth-help">Student IDs are not yet verified against university records. Never use your university account password here.</p></div>`;
}
async function submitAuth(form) {
  if(state.pending) return;
  state.pending=true;const button=byId('submitAuth');button.disabled=true;button.textContent='Please wait...';
  const data=Object.fromEntries(new FormData(form));
  try {
    const response=await request(state.authTab==='login'?'/api/login':'/api/register','POST',data);
    state.me=response.user;state.csrf=response.csrf;refreshAccountLabel();const resume=state.returnToCheckout;state.returnToCheckout=false;closeAll();toast(`Welcome, ${state.me.name.split(' ')[0]}!`);await refreshData();if(resume&&countItems())setOpen('checkoutModal');
  } catch(error){toast(error.message,true);button.disabled=false;button.textContent=state.authTab==='login'?'Sign in':'Create my account';}
  finally{state.pending=false;}
}
async function logout() {
  try {await request('/api/logout','POST');state.me=null;state.csrf=null;state.orders=[];state.jobs=[];refreshAccountLabel();closeAll();toast('Signed out successfully.');}
  catch(e){toast(e.message,true);}
}
function openCheckout() {
  if(!countItems())return;
  if(state.mode==='server' && state.me?.role !== 'student'){if(state.me){toast('Admin accounts cannot order. Use a student account.',true);return;} state.authTab='login';state.returnToCheckout=true;setOpen('authModal');toast('Sign in to place your order.');return;}
  setOpen('checkoutModal');
}
async function placeOrder(form) {
  if(state.pending)return;
  state.pending=true;const button=byId('placeOrderBtn');button.disabled=true;button.textContent='Placing order...';
  const data=Object.fromEntries(new FormData(form));
  data.items=Object.entries(state.cart).map(([id,quantity])=>({id,quantity}));
  try{
    let o;
    if(state.mode==='demo'){
      const all=demoOrders(); const id=(Math.max(1000,...all.map(x=>Number(x.id)||1000))+1);
      const now=new Date().toISOString();o={id,buyer_id:state.me.id,courier_id:null,status:'placed',...data,
        food_total:foodTotal(),delivery_fee:deliveryFee(countItems()),platform_share:platformShare(deliveryFee(countItems())),courier_share:deliveryFee(countItems())-platformShare(deliveryFee(countItems())),
        total:orderCost(),quantity:countItems(),created_at:now,updated_at:now, buyer:state.me,
        items:data.items.map(i=>({item_id:i.id,name:itemById(i.id).name,price:itemById(i.id).price,quantity:i.quantity}))};
      all.push(o);writeDemoOrders(all);
    } else {const response=await request('/api/orders','POST',data);o=response.order;}
    state.cart={};savedCart();updateBag();closeAll();await refreshData();setOpen('ordersDrawer');toast(`Order #${o.id} placed! Waiting for a student courier.`);form.reset();
  } catch(error){toast(error.message,true);}
  finally {state.pending=false;button.disabled=false;button.innerHTML='Place order <svg class="icon"><use href="#i-arrow"/></svg>';}
}
async function actionOnOrder(action,id) {
  if(state.pending)return;
  state.pending=true;
  try{
    if(state.mode==='demo'){
      const all=demoOrders();const o=all.find(x=>String(x.id)===String(id));
      if(!o)throw new Error('Order not found.');
      if(action==='cancel'&&o.buyer_id===state.me.id&&o.status==='placed')o.status='cancelled';
      else if(action==='accept'&&o.buyer_id!==state.me.id&&o.status==='placed'){o.status='accepted';o.courier_id=state.me.id;o.courier=state.me;}
      else if(action==='pickup'&&o.courier_id===state.me.id&&o.status==='accepted')o.status='picked_up';
      else if(action==='deliver'&&o.courier_id===state.me.id&&o.status==='picked_up')o.status='delivered';
      else throw new Error('This action is not available.');
      o.updated_at=new Date().toISOString();writeDemoOrders(all);
    } else {
      await request(action==='cancel'?`/api/orders/${id}/cancel`:`/api/jobs/${id}/${action}`,'POST',{});
    }
    await refreshData();toast(({cancel:'Order cancelled.',accept:'Job accepted! Head to the canteen.',pickup:'Pickup confirmed. Head to the drop-off point.',deliver:'Delivery complete. Great work!'})[action]);
    if(action==='accept'){state.jobTab='mine';renderJobs();}
  } catch(e){toast(e.message,true);}
  finally{state.pending=false;}
}
async function init() {
  byId('year').textContent=new Date().getFullYear();
  try {
    const [me, menu, cfg]=await Promise.all([request('/api/me'),request('/api/menu'),request('/api/config')]);
    if(me.mode!=='server')throw new Error('No backend');
    state.mode='server';state.me=me.user;state.csrf=me.csrf;
    state.menu=menu.menu||[];state.categories=menu.categories||state.categories;
    state.config=cfg.config||state.config;
  }catch(e){
    state.mode='demo';state.me=demoUsers[state.demoRole];
    try{const response=await fetch('menu.json'); if(!response.ok)throw new Error('Missing menu');state.menu=await response.json();}
    catch(err){byId('foodGrid').innerHTML='<div class="no-results">Menu unavailable. Run from a local server.</div>';}
  }
  const freshCart={};for(const [id,qty] of Object.entries(state.cart))if(itemById(id))freshCart[id]=qty;
  state.cart=freshCart;savedCart();
  refreshAccountLabel();renderCategories();renderMenu();updateBag();refreshData();renderPricing();
  const observer=('IntersectionObserver' in window)?new IntersectionObserver((entries)=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target);}}, {threshold:.12}):null;
  document.querySelectorAll('.reveal').forEach(el=>observer?observer.observe(el):el.classList.add('visible'));
  setInterval(()=>{if(state.mode==='server'&&state.me&&!document.hidden&&state.me.role==='student')refreshData();},12000);
  setInterval(async()=>{if(state.mode!=='server'||document.hidden)return;try{const [res,pricing]=await Promise.all([request('/api/menu'),request('/api/config')]);if(JSON.stringify(res.menu)!==JSON.stringify(state.menu)){state.menu=res.menu;state.categories=res.categories||state.categories;renderCategories();renderMenu();}if(JSON.stringify(pricing.config)!==JSON.stringify(state.config)){state.config=pricing.config;renderPricing();}if(state.active==='cartDrawer')renderCart();if(state.active==='checkoutModal')byId('checkoutTotal').innerHTML=billHTML();}catch(e){}},30000);
}

byId('cartBtn').addEventListener('click',()=>setOpen('cartDrawer'));
byId('accountBtn').addEventListener('click',()=>setOpen('authModal'));
byId('heroEarn').addEventListener('click',()=>setOpen('jobsDrawer'));
byId('openJobsBtn').addEventListener('click',()=>setOpen('jobsDrawer'));
byId('footerJobs').addEventListener('click',()=>setOpen('jobsDrawer'));
byId('footerOrders').addEventListener('click',()=>setOpen('ordersDrawer'));
byId('navOrders').addEventListener('click',()=>setOpen('ordersDrawer'));
byId('footerAccount').addEventListener('click',()=>setOpen('authModal'));
byId('mobileOrders').addEventListener('click',()=>{byId('mobileNav').hidden=true;setOpen('ordersDrawer')});
byId('menuToggle').addEventListener('click',()=>{byId('mobileNav').hidden=!byId('mobileNav').hidden;byId('menuToggle').setAttribute('aria-expanded',String(!byId('mobileNav').hidden));});
document.querySelectorAll('#mobileNav a').forEach(a=>a.addEventListener('click',()=>{byId('mobileNav').hidden=true;byId('menuToggle').setAttribute('aria-expanded','false');}));
byId('backdrop').addEventListener('click',closeAll);
document.addEventListener('keydown',(e)=>{if(e.key==='Escape')closeAll();});
byId('categoryFilters').addEventListener('click',(e)=>{const button=e.target.closest('[data-category]');if(!button)return;state.category=button.dataset.category;document.querySelectorAll('.category-chip').forEach(b=>b.classList.toggle('active',b===button));renderMenu();});
byId('menuSearch').addEventListener('input',(e)=>{state.search=e.target.value.trim();renderMenu();});
document.addEventListener('click',(e)=>{
  const button=e.target.closest('button');if(!button)return;
  if(button.matches('[data-close]')){closeAll();return;}
  if(button.dataset.add){addItem(button.dataset.add);return;}
  if(button.dataset.qty){addItem(button.dataset.qty,Number(button.dataset.delta));return;}
  if(button.id==='checkoutBtn'){openCheckout();return;}
  if(button.dataset.emptyAction){const act=button.dataset.emptyAction;
    if(act==='menu'){closeAll();byId('menu').scrollIntoView({behavior:'smooth'});}
    else if(act==='auth'){setOpen('authModal');}
    else if(act==='orders'){setOpen('ordersDrawer');}
    else if(act==='jobs'){setOpen('jobsDrawer');}return;}
  if(button.dataset.switchRole){roleSwitch(button.dataset.switchRole);if(state.active==='authModal')renderAuth();return;}
  if(button.dataset.authTab){state.authTab=button.dataset.authTab;renderAuth();return;}
  if(button.dataset.jobTab){state.jobTab=button.dataset.jobTab;renderJobs();return;}
  if(button.dataset.jobAct){actionOnOrder(button.dataset.jobAct,button.dataset.id);return;}
  if(button.dataset.orderAct){actionOnOrder(button.dataset.orderAct,button.dataset.id);return;}
  if(button.id==='logoutBtn'){logout();return;}
});
document.addEventListener('submit',(e)=>{
  if(e.target.id==='authForm'){e.preventDefault();submitAuth(e.target);}
});
byId('checkoutForm').addEventListener('submit',(e)=>{e.preventDefault();placeOrder(e.target);});
window.addEventListener('storage',(e)=>{if(e.key==='gub_demo_orders_v2'&&state.mode==='demo')refreshData();if(e.key==='gub_cart_v2'){state.cart=loadJSON('gub_cart_v2',{});updateBag();if(state.active==='cartDrawer')renderCart();}});
init();
