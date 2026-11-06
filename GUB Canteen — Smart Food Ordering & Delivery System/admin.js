'use strict';
const $=(id)=>document.getElementById(id);
const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=(n)=>'৳'+Number(n||0).toLocaleString('en-BD');
const pretty=(s)=>({placed:'Placed',accepted:'Accepted',picked_up:'Picked up',delivered:'Delivered',cancelled:'Cancelled'})[s]||s;
const datefmt=(v)=>{if(!v)return 'Never';const d=new Date(v);return isNaN(d)?'—':d.toLocaleString('en-BD',{day:'2-digit',month:'short',year:'numeric',hour:'numeric',minute:'2-digit'});};
const categoryIcon=(cat)=>({'Beverages':'☕','Cakes':'🍰','Biscuits':'🍪','Meals':'🍚','Breakfast':'🥪','Chicken':'🍗','Snacks':'🥟'})[cat]||'🍽';
const imgURL=(item)=>item.image?(item.image.startsWith('/uploads/')?item.image:'images/'+item.image):'';
const imgHTML=(item,cls='no-photo')=>item.image?`<img src="${esc(imgURL(item))}" alt="${esc(item.name)}" loading="lazy">`:`<div class="${cls}">${categoryIcon(item.category)}</div>`;
const S={me:null,csrf:null,page:'overview',menu:[],orders:[],users:[],activity:[],summary:null,
  settings:null, modalItem:null, modalOrder:null, userCache:[], menuCategories:[],
  ordersOffset:0,usersOffset:0,activityOffset:0,ordersTotal:0,usersTotal:0,activityTotal:0,
  busy:false,searchTimer:null};
async function api(url,method='GET',payload){
  const options={method,credentials:'same-origin',headers:{Accept:'application/json'}};
  if(method!=='GET'){options.headers['Content-Type']='application/json';options.headers['X-CSRF-Token']=S.csrf||'';options.body=JSON.stringify(payload??{});}
  const res=await fetch(url,options);
  const data=await res.json().catch(()=>({error:'Unexpected response. Is the Python server running?'}));
  if(!res.ok)throw new Error(data.error||'Request failed');
  return data;
}
function toast(msg,error=false){const node=document.createElement('div');node.className='admin-toast'+(error?' error':'');node.textContent=msg;$('adminToasts').append(node);setTimeout(()=>node.remove(),4200);}
function setBusy(b){S.busy=b;document.querySelectorAll('.edit-modal button,.settings-panel button').forEach(el=>{if(el.dataset.keepEnabled!=='1')el.disabled=b;});}
function showDashboard(){
  $('loginView').hidden=true;$('appView').hidden=false;
  $('userDisplay').textContent=S.me.name;
  $('avatarInitial').textContent=S.me.name[0].toUpperCase();
  $('userRole').textContent=S.me.role==='owner'?'Owner':'Administrator';
  $('todayLabel').textContent=new Date().toLocaleDateString('en-BD',{weekday:'short',month:'short',day:'numeric'});
  navigate(S.page);
}
function showLogin(){S.me=null;S.csrf=null;$('loginView').hidden=false;$('appView').hidden=true;closeModal();}
async function login(form){
  const button=$('loginSubmit');button.disabled=true;button.innerText='Checking credentials...';
  try{const data=await api('/api/admin/login','POST',Object.fromEntries(new FormData(form)));
    S.me=data.user;S.csrf=data.csrf;showDashboard();toast('Welcome to the management console.');form.reset();
  }catch(e){toast(e.message,true);}
  finally{button.disabled=false;button.innerHTML='Enter dashboard <span>→</span>';}
}
async function logout(){try{await api('/api/logout','POST');showLogin();toast('Signed out.');}catch(e){toast(e.message,true);}}
const pageMeta={
 overview:['Overview','Dashboard overview','A live look at the people, food and deliveries that keep GUB moving.'],
 menu:['Menu manager','Food & menu management','Add new items, set canteen prices, upload photos and control availability.'],
 orders:['All orders','Order management','Track campus deliveries and handle order issues with an audit trail.'],
 users:['Students & staff','Student & staff accounts','Review registrations, delivery participation, login activity and access.'],
 activity:['Activity logs','Audit & system activity','A timeline of what students and staff are doing on the platform.'],
 settings:['Delivery pricing','Delivery fee settings','Keep quantity pricing and the delivery-fee commission fair and transparent.']
};
async function navigate(page){
  if(!pageMeta[page])return;
  S.page=page;
  document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===page));
  document.querySelectorAll('#sideNav .nav-link').forEach(el=>el.classList.toggle('active',el.dataset.page===page));
  const [bread,title,subtitle]=pageMeta[page];$('breadTitle').textContent=bread;$('pageTitle').textContent=title;$('pageSubtitle').textContent=subtitle;
  $('pageAction').innerHTML=page==='menu'?'<button class="primary-btn" id="addItemButton">＋ Add new food item</button>':page==='orders'?'<button class="outline-btn" id="refreshOrdersButton">↻ Refresh orders</button>':'';
  $('sidebar').classList.remove('show');$('mobileShade').hidden=true;
  try{
    if(page==='overview')await loadSummary();
    else if(page==='menu')await loadMenu();
    else if(page==='orders')await loadOrders();
    else if(page==='users')await loadUsers();
    else if(page==='activity')await loadActivity();
    else if(page==='settings')await loadSettings();
  }catch(e){toast(e.message,true);if(e.message.includes('sign in'))showLogin();}
}
function statsCard(title,value,note,symbol){return `<div class="stat-card"><div class="stat-top"><span class="stat-title">${title}</span><span class="stat-icon">${symbol}</span></div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></div>`;}
async function loadSummary(){
  const res=await api('/api/admin/summary');S.summary=res;
  const z=res.stats;
  $('overviewStats').innerHTML=[
    statsCard('Total orders',z.orders,'Across all statuses','▤'),
    statsCard('Active deliveries',z.live_orders,'Placed / accepted / picked up','↗'),
    statsCard('Registered students',z.users,`${z.online} recently online`,'♧'),
    statsCard('Platform share',money(z.platform_earned),'Calculated on delivered orders','৳'),
    statsCard('Delivered orders',z.delivered,'Completed deliveries','✓'),
    statsCard('Courier earnings',money(z.rider_earned),'Estimated, not settled','⌁'),
    statsCard('Live menu items',z.menu_active,`${z.menu_draft} hidden / drafts`,'▦'),
    statsCard('Sign-ins today',z.today_logins,'Recorded login events','◷')
  ].join('');
  $('navMenuCount').textContent=z.menu_active;
  $('navOrderCount').textContent=z.live_orders;
  const data=[];const now=new Date();
  for(let n=6;n>=0;n--){const d=new Date(now);d.setDate(now.getDate()-n);const key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');const hit=res.daily.find(x=>x.day===key);data.push({day:d.toLocaleDateString('en-BD',{weekday:'short'}),count:hit?.count||0});}
  const max=Math.max(1,...data.map(d=>d.count));
  $('trendChart').innerHTML=data.map(row=>`<div class="chart-col"><div class="chart-count">${row.count}</div><div class="chart-bar-wrap"><div class="chart-bar" title="${row.count} orders" style="height:${Math.max(3,Math.round(row.count/max*126))}px"></div></div><div class="chart-day">${row.day}</div></div>`).join('');
  const total=z.platform_earned+z.rider_earned;const percent=total>0?z.platform_earned/total*100:100/3;
  $('splitOverview').innerHTML=`<div class="donut-area"><div class="donut" style="background:conic-gradient(#2f815c 0 ${percent}%,#d6e8d7 ${percent}% 100%)"><div class="donut-label">${percent.toFixed(1)}%<small>Platform</small></div></div><div class="split-details"><div class="split-line"><i></i><div>Platform<strong>${money(z.platform_earned)}</strong></div></div><div class="split-line"><i class="alt"></i><div>Student couriers<strong>${money(z.rider_earned)}</strong></div></div></div></div><p class="data-note">Delivered-order fee split (calculated; not payment reconciliation).</p>`;
  $('recentOrders').innerHTML=res.recent_orders.length?res.recent_orders.map(o=>`<tr><td><strong>#${o.id}</strong></td><td>${esc(o.buyer_name)}</td><td><strong>${money(o.total)}</strong></td><td><span class="status ${esc(o.status)}">${pretty(o.status)}</span></td><td>${datefmt(o.created_at)}</td></tr>`).join(''):'<tr><td colspan="5" class="empty">No orders yet. Orders from the student website appear here.</td></tr>';
}
async function loadMenu(){
  const res=await api('/api/admin/menu');S.menu=res.menu;S.menuCategories=res.categories;
  const select=$('menuCategoryAdmin');const val=select.value;
  select.innerHTML='<option value="all">All categories</option>'+[...new Set([...res.categories,...res.menu.map(m=>m.category)])].map(cat=>`<option value="${esc(cat)}">${esc(cat)}</option>`).join('');
  select.value=[...select.options].some(o=>o.value===val)?val:'all';
  renderMenu();
}
function renderMenu(){
  const search=$('menuSearchAdmin').value.toLowerCase().trim();const category=$('menuCategoryAdmin').value;const status=$('menuStatusAdmin').value;
  const items=S.menu.filter(m=>(category==='all'||m.category===category)&&(status==='all'||(status==='live'&&m.available)||(status==='draft'&&!m.available))&&(m.name+' '+m.category+' '+m.tag).toLowerCase().includes(search));
  $('menuTotalLabel').textContent=`${items.length} of ${S.menu.length} items`;
  $('menuAdminGrid').innerHTML=items.length?items.map(m=>`<article class="admin-food-card"><div class="admin-food-picture">${imgHTML(m)}<span class="food-status status ${m.available?'live':'draft'}">${m.available?'Live':'Draft'}</span></div><div class="admin-food-content"><div class="admin-food-category">${esc(m.category)}</div><h3>${esc(m.name)}</h3><div class="admin-food-desc">${esc(m.tag||'No menu note')}</div><div class="admin-food-footer"><strong>${money(m.price)}</strong><button class="edit-button" data-edit-item="${esc(m.id)}">Edit item ↗</button></div></div></article>`).join(''):'<div class="panel empty">No items match these filters.</div>';
}
function openModal(title,kicker,html){$('modalHeading').textContent=title;$('modalKicker').textContent=kicker;$('modalContent').innerHTML=html;$('modalLayer').hidden=false;document.body.style.overflow='hidden';}
function closeModal(){$('modalLayer').hidden=true;document.body.style.overflow='';S.modalItem=null;S.modalOrder=null;}
function editItem(id){
  const item=id?S.menu.find(m=>m.id===id):null;S.modalItem=item||null;
  const selectedCat=item?.category||'Meals';const categories=[...new Set([...S.menuCategories,...S.menu.map(m=>m.category)])];
  const catOptions=categories.map(cat=>`<option value="${esc(cat)}" ${cat===selectedCat?'selected':''}>${esc(cat)}</option>`).join('');
  const initialPhoto=item?imgHTML(item):'<div class="no-photo">🍽</div>';
  const html=`<div class="modal-body"><form id="menuEditForm" class="editor-form"><label>Item name<input name="name" required maxlength="85" minlength="2" placeholder="e.g. Chocolate Muffin" value="${esc(item?.name||'')}"></label><div class="two-inputs"><label>Price (৳)<input name="price" type="number" required min="0" max="100000" step="1" value="${item?.price??''}" placeholder="Price in taka"></label><label>Category<select name="category" id="editCategory">${catOptions}<option value="__custom">+ New category</option></select></label></div><label id="customCategoryWrap" hidden>New category name<input name="custom_category" maxlength="35" placeholder="e.g. Ice cream"></label><label>Short description / tag<input name="tag" maxlength="65" placeholder="e.g. Student favorite" value="${esc(item?.tag||'')}"></label><label>Food photo (optional)<span class="image-upload-label"><span id="imagePreview">${initialPhoto}</span><span><strong>Click to choose a photo</strong>JPEG, PNG or WebP · Maximum 2 MB<br>Keep the existing photo if you don't select one.</span><input id="foodPhotoInput" type="file" accept="image/jpeg,image/png,image/webp"></span></label><div class="switch-row"><div><strong>Visible to students</strong><small>Disable until item prices/stock are confirmed.</small></div><input name="available" id="editAvailable" type="checkbox" ${item?.available?'checked':''}></div><div class="form-footer">${item?`<button type="button" class="danger-action" data-delete-item="${esc(item.id)}">Archive item</button>`:'<span class="muted" style="font-size:10px">New items start hidden.</span>'}<button type="button" class="outline-btn" data-close-modal>Cancel</button><button class="primary-btn" id="saveMenuItem" type="submit">${item?'Save changes':'Create item'} →</button></div></form></div>`;
  openModal(item?'Edit food item':'Add a food item','MENU MANAGER',html);
}
async function uploadImage(file){
  if(!file||file.size>2*1024*1024)throw new Error('Image must be less than 2MB.');
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Use JPEG, PNG or WebP photos.');
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Cannot read image file.'));reader.readAsDataURL(file);});
  return (await api('/api/admin/upload','POST',{data})).image;
}
async function saveItem(form){
  if(S.busy)return;setBusy(true);const current=S.modalItem;
  try{
    const data=Object.fromEntries(new FormData(form));
    const category=data.category==='__custom'?data.custom_category.trim():data.category;
    const file=$('foodPhotoInput').files[0];
    const image=file?await uploadImage(file):(current?.image||'');
    const body={name:data.name.trim(),price:Number(data.price),category,tag:data.tag.trim(),image,available:$('editAvailable').checked};
    await api(current?'/api/admin/menu/'+encodeURIComponent(current.id):'/api/admin/menu','POST',body);
    closeModal();toast(current?'Food item updated!':'New food item added.');await loadMenu();
  }catch(e){toast(e.message,true);}finally{setBusy(false);}
}
async function deleteItem(id){
  if(!confirm('Archive this menu item? It disappears from the student menu, but past orders stay unchanged.'))return;
  try{await api('/api/admin/menu/'+encodeURIComponent(id)+'/delete','POST',{});closeModal();toast('Item archived.');await loadMenu();}
  catch(e){toast(e.message,true);}
}
async function loadOrders(){
  const status=$('ordersStatusAdmin').value;const q=$('ordersSearchAdmin').value.trim();
  const res=await api(`/api/admin/orders?limit=40&offset=${S.ordersOffset}&status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`);
  S.orders=res.orders;S.ordersTotal=res.total;$('ordersCountLabel').textContent=`${res.total} orders`;
  $('ordersRows').innerHTML=res.orders.length?res.orders.map(o=>`<tr><td><strong>#${o.id}</strong><small>${o.quantity} item(s)</small></td><td><strong>${esc(o.buyer.name)}</strong><small>${esc(o.buyer.student_id)}</small></td><td>${o.courier?esc(o.courier.name):'<span class="muted">Waiting for rider</span>'}</td><td><strong>${money(o.total)}</strong><small>Fee ${money(o.delivery_fee)}</small></td><td><span class="status ${o.status}">${pretty(o.status)}</span></td><td>${datefmt(o.created_at)}</td><td><button class="table-action" data-order-details="${o.id}">Details →</button></td></tr>`).join(''):'<tr><td colspan="7" class="empty">No matching orders.</td></tr>';
  renderPager('orderPagination',S.ordersOffset,40,res.total,'orders');
}
function renderPager(element,offset,limit,total,prefix){
  $(element).innerHTML=`<span>Showing ${total?offset+1:0}–${Math.min(offset+limit,total)} of ${total}</span><div class="action-row"><button data-pager="${prefix}" data-dir="prev" ${offset===0?'disabled':''}>← Previous</button><button data-pager="${prefix}" data-dir="next" ${offset+limit>=total?'disabled':''}>Next →</button></div>`;
}
async function ensureUsers(){
  const res=await api('/api/admin/users?limit=200');S.userCache=res.users;
}
async function orderDetails(id){
  const o=S.orders.find(x=>x.id===id);if(!o)return;
  S.modalOrder=o;
  let riderChoices='';
  try{await ensureUsers();riderChoices=S.userCache.filter(u=>u.role==='student'&&u.active&&u.id!==o.buyer_id).map(u=>`<option value="${u.id}" ${o.courier_id===u.id?'selected':''}>${esc(u.name)} · ${esc(u.student_id)}</option>`).join('');}
  catch(e){riderChoices='';}
  const facts=[['Order status',`<span class="status ${o.status}">${pretty(o.status)}</span>`],['Buyer',esc(o.buyer.name)+' · '+esc(o.buyer.student_id)],['Contact',esc(o.buyer.phone)],['Delivery to',esc(o.building)+' · Floor '+esc(o.floor)+' · '+esc(o.room)],['Courier',o.courier?esc(o.courier.name)+' · '+esc(o.courier.phone):'Not assigned'],['Placed at',datefmt(o.created_at)]];
  const html=`<div class="modal-body"><div class="order-modal-meta">${facts.map(([name,value])=>`<div class="order-fact"><small>${name}</small><strong>${value}</strong></div>`).join('')}</div>${o.notes?`<p class="data-note">Delivery note: ${esc(o.notes)}</p>`:''}<h4 style="font-size:13px">Order items</h4>${o.items.map(i=>`<div class="order-item-line"><span>${esc(i.name)} × ${i.quantity}</span><strong>${money(i.price*i.quantity)}</strong></div>`).join('')}<div class="order-total"><div><span>Canteen food</span><strong>${money(o.food_total)}</strong></div><div><span>Delivery charge</span><strong>${money(o.delivery_fee)}</strong></div><div><span>Site share · courier share</span><strong>${money(o.platform_share)} · ${money(o.courier_share)}</strong></div><div class="grand"><span>Total</span><span>${money(o.total)}</span></div></div><div class="order-actions"><h4>Manage this order</h4>${['placed','accepted'].includes(o.status)?`<label style="font-size:11px;font-weight:700">Assign / reassign an active student courier<select id="courierChoice"><option value="">Choose courier...</option>${riderChoices}</select></label><div><button class="table-action" data-order-action="assign">Assign courier</button>${o.status==='accepted'?'<button class="warn-action" data-order-action="unassign">Unassign courier</button>':''}</div>`:''}${['placed','accepted','picked_up'].includes(o.status)?'<div><button class="danger-action" data-order-action="cancel">Cancel order</button></div>':''}${['accepted','picked_up'].includes(o.status)&&o.courier_id?'<div><button class="warn-action" data-order-action="complete">Mark delivered (override)</button></div>':''}${o.status==='cancelled'?'<div><button class="table-action" data-order-action="reopen">Reopen as placed</button></div>':''}<p class="data-note">Every management action is logged. This screen does not collect or verify payment.</p></div></div>`;
  openModal('Order #'+o.id,'ORDER MANAGEMENT',html);
}
async function orderAction(action){
  const o=S.modalOrder;if(!o)return;
  let reason='';let courier_id=null;
  if(action==='assign'){
    courier_id=Number($('courierChoice')?.value);
    if(!courier_id){toast('Choose a student courier first.',true);return;}
    if(!confirm(`Assign this delivery to selected student?`))return;
  }else if(action==='cancel'||action==='complete'){
    const question=action==='cancel'?'Reason for cancelling this order (required):':'Why are you overriding courier delivery confirmation? (required):';
    const result=prompt(question,'');if(result===null)return;reason=result.trim();
    if(reason.length<5){toast('Please enter a reason of at least 5 characters.',true);return;}
  }else if(!confirm('Confirm this order status change?'))return;
  if(S.busy)return;setBusy(true);
  try{await api(`/api/admin/orders/${o.id}/action`,'POST',{action,courier_id,reason});closeModal();toast('Order updated and action logged.');await loadOrders();}
  catch(e){toast(e.message,true);}finally{setBusy(false);}
}
async function loadUsers(){
  const q=$('usersSearchAdmin').value.trim();const res=await api(`/api/admin/users?limit=40&offset=${S.usersOffset}&q=${encodeURIComponent(q)}`);
  S.users=res.users;S.usersTotal=res.total;$('usersCountLabel').textContent=`${res.total} accounts`;
  $('usersRows').innerHTML=res.users.length?res.users.map(u=>{
    const canEdit=u.id!==S.me.id && u.role!=='owner';
    const canRole=canEdit&&S.me.role==='owner';const canToggle=canEdit&&(u.role==='student'||S.me.role==='owner');
    return `<tr><td><div class="person-cell"><span class="person-icon">${esc(u.name[0]?.toUpperCase()||'?')}</span><div><strong>${esc(u.name)}</strong><small>Joined ${datefmt(u.created_at)}</small></div></div></td><td>${esc(u.student_id)}<small>${esc(u.phone||'No phone')}</small></td><td><span class="tag-role ${u.role}">${esc(u.role)}</span></td><td>${u.orders_count} orders<small>${u.deliveries_count} completed deliveries</small></td><td>${datefmt(u.last_login_at)}</td><td><span class="status ${u.active?'live':'disabled'}">${u.active?'Active':'Disabled'}</span></td><td><div class="action-row">${canToggle?`<button class="${u.active?'warn-action':'table-action'}" data-toggle-user="${u.id}">${u.active?'Disable':'Enable'}</button>`:''}${canRole?`<button class="table-action" data-role-user="${u.id}" data-new-role="${u.role==='admin'?'student':'admin'}">${u.role==='admin'?'Demote':'Make admin'}</button>`:''}${!canEdit?'<span class="muted">Protected</span>':''}</div></td></tr>`;
  }).join(''):'<tr><td colspan="7" class="empty">No matching user accounts.</td></tr>';
  renderPager('usersPagination',S.usersOffset,40,res.total,'users');
}
async function changeUser(id,change,newRole){
  const u=S.users.find(x=>x.id===id);if(!u)return;
  const message=change==='toggle'?`${u.active?'Disable':'Enable'} account ${u.name}? Disabling will sign them out.`:`Change ${u.name}'s role to ${newRole}? They will be signed out.`;
  if(!confirm(message))return;
  try{await api(`/api/admin/users/${id}/${change}`,'POST',change==='role'?{role:newRole}:{});toast('Account access updated.');await loadUsers();}
  catch(e){toast(e.message,true);}
}
async function loadActivity(){
  const res=await api(`/api/admin/activity?limit=50&offset=${S.activityOffset}`);
  S.activity=res.logs;S.activityTotal=res.total;$('activityCount').textContent=`${res.total} events`;
  $('activityRows').innerHTML=res.logs.length?res.logs.map(l=>`<tr><td>${datefmt(l.created_at)}</td><td><strong>${esc(l.actor_name||'System')}</strong><small>${esc(l.actor_student_id||'')}</small></td><td><span class="tag-role">${esc(l.action.replaceAll('_',' '))}</span></td><td>${esc(l.target_type)} ${esc(l.target_id)}</td><td>${esc(l.detail||'—')}</td></tr>`).join(''):'<tr><td colspan="5" class="empty">No activity yet.</td></tr>';
  renderPager('activityPagination',S.activityOffset,50,res.total,'activity');
}
async function loadSettings(){
  const data=await api('/api/admin/settings');S.settings=data.config;
  for(const [key,value] of Object.entries(data.config)){$(`settingsForm`).elements[key].value=key==='platform_percent'?Number(value).toFixed(6):value;}
  const isOwner=S.me.role==='owner';
  for(const input of $('settingsForm').querySelectorAll('input'))input.disabled=!isOwner;
  $('settingsSave').disabled=!isOwner;$('settingsPermission').textContent=isOwner?'Applies to future orders only.':'Only the owner can edit fee settings.';
  updatePricingPreview();
}
function calculatePreview(){
  const form=$('settingsForm').elements;
  const base=Math.max(0,Number(form.base_fee.value)||0),step=Math.max(0,Number(form.step_fee.value)||0),items=Math.max(1,Number(form.items_per_tier.value)||1),percent=Math.max(0,Math.min(100,Number(form.platform_percent.value)||0));
  return {base,step,items,percent};
}
function updatePricingPreview(){
  const {base,step,items,percent}=calculatePreview();
  $('pricingPreview').innerHTML=[0,1,2,3,4].map(i=>{const qty=1+i*items,fee=base+step*i,platform=Math.round(fee*percent/100),rider=fee-platform;return `<div class="preview-row"><div><strong>${qty}–${qty+items-1} items</strong><small>Platform ${money(platform)} · Courier ${money(rider)}</small></div><strong>${money(fee)}</strong></div>`;}).join('');
}
async function saveSettings(form){
  if(S.me.role!=='owner')return;
  const config=calculatePreview();
  const body={base_fee:config.base,step_fee:config.step,items_per_tier:config.items,platform_percent:Number(form.elements.platform_percent.value)};
  if(![body.base_fee,body.step_fee,body.items_per_tier].every(Number.isInteger)){toast('Use whole taka amounts and a whole number of items per tier.',true);return;}
  try{const res=await api('/api/admin/settings','POST',body);S.settings=res.config;toast('Delivery pricing saved. New orders use the new rules.');await loadSettings();}
  catch(e){toast(e.message,true);}
}
async function exportCSV(which){
  try{
    const response=await fetch('/api/admin/export/'+which,{credentials:'same-origin'});
    if(!response.ok){const j=await response.json();throw new Error(j.error||'Export failed');}
    const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download='gub-'+which+'.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast('Export prepared for download.');
  }catch(e){toast(e.message,true);}
}
const debounce=(fn)=>{clearTimeout(S.searchTimer);S.searchTimer=setTimeout(fn,280);};
document.addEventListener('click',async(e)=>{
  const b=e.target.closest('button,[data-close-modal]');if(!b)return;
  if(b.dataset.closeModal!==undefined||b.id==='closeModal'){closeModal();return;}
  if(b.dataset.page){navigate(b.dataset.page);return;}
  if(b.id==='addItemButton'){editItem(null);return;}
  if(b.id==='refreshOrdersButton'){loadOrders();return;}
  if(b.dataset.editItem){editItem(b.dataset.editItem);return;}
  if(b.dataset.deleteItem){deleteItem(b.dataset.deleteItem);return;}
  if(b.dataset.orderDetails){await orderDetails(Number(b.dataset.orderDetails));return;}
  if(b.dataset.orderAction){orderAction(b.dataset.orderAction);return;}
  if(b.dataset.toggleUser){changeUser(Number(b.dataset.toggleUser),'toggle');return;}
  if(b.dataset.roleUser){changeUser(Number(b.dataset.roleUser),'role',b.dataset.newRole);return;}
  if(b.dataset.export){exportCSV(b.dataset.export);return;}
  if(b.dataset.pager){const key=b.dataset.pager+'Offset';const size=b.dataset.pager==='activity'?50:40;S[key]=Math.max(0,S[key]+(b.dataset.dir==='next'?size:-size));if(b.dataset.pager==='orders')loadOrders();else if(b.dataset.pager==='users')loadUsers();else loadActivity();return;}
});
$('loginForm').addEventListener('submit',e=>{e.preventDefault();login(e.target);});
$('logoutButton').addEventListener('click',logout);
$('settingsForm').addEventListener('submit',e=>{e.preventDefault();saveSettings(e.target);});
$('passwordForm').addEventListener('submit',async e=>{e.preventDefault();const f=e.target;const v=Object.fromEntries(new FormData(f));if(v.new_password!==v.confirm_password){toast('New passwords do not match.',true);return;}try{await api('/api/admin/change-password','POST',{current_password:v.current_password,new_password:v.new_password});f.reset();toast('Password changed. Other sessions were revoked.');}catch(err){toast(err.message,true);}});
$('settingsForm').addEventListener('input',updatePricingPreview);
$('menuSearchAdmin').addEventListener('input',renderMenu);
$('menuCategoryAdmin').addEventListener('change',renderMenu);
$('menuStatusAdmin').addEventListener('change',renderMenu);
$('ordersStatusAdmin').addEventListener('change',()=>{S.ordersOffset=0;loadOrders();});
$('ordersSearchAdmin').addEventListener('input',()=>debounce(()=>{S.ordersOffset=0;loadOrders();}));
$('usersSearchAdmin').addEventListener('input',()=>debounce(()=>{S.usersOffset=0;loadUsers();}));
$('modalContent').addEventListener('submit',e=>{if(e.target.id==='menuEditForm'){e.preventDefault();saveItem(e.target);}});
$('modalContent').addEventListener('change',e=>{
  if(e.target.id==='editCategory')$('customCategoryWrap').hidden=e.target.value!=='__custom';
  if(e.target.id==='foodPhotoInput'&&e.target.files[0]){
    const f=e.target.files[0];if(f.size>2*1024*1024){toast('Photo exceeds 2MB.',true);e.target.value='';return;}
    const url=URL.createObjectURL(f);$('imagePreview').innerHTML=`<img alt="New photo preview">`;
    const img=$('imagePreview').querySelector('img');img.src=url;img.onload=()=>URL.revokeObjectURL(url);
  }
});
$('mobileMenu').addEventListener('click',()=>{$('sidebar').classList.toggle('show');$('mobileShade').hidden=!$('sidebar').classList.contains('show');});
$('mobileShade').addEventListener('click',()=>{$('sidebar').classList.remove('show');$('mobileShade').hidden=true;});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal();$('sidebar').classList.remove('show');$('mobileShade').hidden=true;}});
(async()=>{try{const data=await api('/api/me');if(data.user&&['owner','admin'].includes(data.user.role)){S.me=data.user;S.csrf=data.csrf;showDashboard();}else showLogin();}catch(e){showLogin();}})();
setInterval(()=>{if(S.me&&!document.hidden&&S.page==='overview')loadSummary().catch(()=>{});},30000);
