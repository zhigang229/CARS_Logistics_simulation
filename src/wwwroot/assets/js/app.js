/* 场内物流 3D 仿真台 · 界面与三维渲染 */
"use strict";
/* ===================== App ===================== */
const {createApp,reactive,computed,watch,nextTick,toRaw}=Vue;
const clone=o=>JSON.parse(JSON.stringify(o));
let _uid=Date.now()%1e6; const uid=p=>p+(++_uid).toString(36);
const snap=(v,g=0.5)=>Math.round(v/g)*g;
const r2=v=>Math.round(v*100)/100;
const fmtT=s=>{s=Math.max(0,Math.floor(s||0));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(x).padStart(2,'0')}`;};
const fmtMS=s=>{if(s==null||!isFinite(s))return '—';const neg=s<0;s=Math.abs(Math.round(s));return (neg?'−':'')+Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
const pct=x=>x==null?'—':(x*100).toFixed(x<0.1&&x>0?1:0)+'%';
const MODES=[{id:'layout',no:'1',label:'车间场地'},{id:'network',no:'2',label:'路网规划'},{id:'stations',no:'3',label:'站点与停留'},{id:'routes',no:'4',label:'车辆与路线'},{id:'analysis',no:'5',label:'仿真分析'}];
const STATE={move:{l:'行驶',d:'正常运行',v:'--good'},dwell:{l:'作业',d:'站点装卸停留',v:'--blue'},wait:{l:'等待',d:'被前车或路口阻挡',v:'--warn'},charge:{l:'充电',d:'在充电点',v:'--violet'},idle:{l:'待发',d:'未投入或等节拍',v:'--idle'}};
const STATE_KEYS=['move','dwell','wait','charge','idle'];
const SPEEDS=[1,5,20,60,200];
const ATABS=[{id:'overview',l:'总览'},{id:'routes',l:'路线'},{id:'stations',l:'站点与路段'},{id:'events',l:'事件'},{id:'compare',l:'方案对比'}];
const EVT={start:{l:'投入',c:'var(--good)'},late:{l:'晚点',c:'var(--warn)'},charge:{l:'充电',c:'var(--violet)'},deadlock:{l:'放行',c:'var(--bad)'},warn:{l:'警告',c:'var(--bad)'},done:{l:'结束',c:'var(--muted)'}};
const cssVar=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim()||'#888888';

/* ---------- storage：优先使用 IIS 服务器存储，不可用时回退到本机浏览器 ---------- */
const APP_VERSION='1.1.0';
const API_URL='api/scenarios.ashx';
const LS_KEY='logisim.v1', CUR_KEY='logisim.current';
const lsGet=()=>{try{return JSON.parse(localStorage.getItem(LS_KEY)||'null');}catch(e){return null;}};
const lsSet=(k,v)=>{try{localStorage.setItem(k,v);return true;}catch(e){return false;}};
const newId=()=>'sc'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
let DB={list:[],results:{}};   // list 项：{id,name,data,rev,serverRev,updated,updatedBy}
const Store={mode:'local',lastSaved:{},saving:null,again:false,timer:null,lastRefresh:0};
let quotaWarned=false;

const s=reactive({
  sc:sampleScenario(), currentId:'', scenarios:[],
  store:{mode:'local',storage:'',user:'',status:'connecting',error:'',ready:false},
  mode:'layout', tool:'select', sel:null, view:'3d', newDir:'fwd', newLimit:null, angleSnap:true,
  sim:{status:'idle',t:0}, speed:20, fast:false, kpi:null, atab:'overview', selVeh:null, follow:false, legEdit:null,
  heat:false, labels:true, cursor:'X — · Z —', dialog:null, importText:'', renameText:'', validation:[], toast:'', undoN:0, redoN:0, resultsRev:0,
});
let toastTimer=null;
function toast(msg){ s.toast=msg; clearTimeout(toastTimer); toastTimer=setTimeout(()=>s.toast='',3600); }

/* ---------- history ---------- */
const undoStack=[], redoStack=[];
function snapshotSc(){ const raw=toRaw(s.sc); const bg=raw.bg; const o=JSON.stringify({...raw,bg:bg?{...bg,data:'__BG__'}:null}); return {json:o,bgData:bg?bg.data:null}; }
function restoreSc(snp){ const o=JSON.parse(snp.json); if(o.bg) o.bg.data=snp.bgData; s.sc=o; }
let lastPush=0;
function pushHistory(){ const now=performance.now(); if(now-lastPush<120) return; lastPush=now; undoStack.push(snapshotSc()); if(undoStack.length>60) undoStack.shift(); redoStack.length=0; s.undoN=undoStack.length; s.redoN=0; }
function undo(){ if(!undoStack.length||locked.value) return; redoStack.push(snapshotSc()); restoreSc(undoStack.pop()); s.undoN=undoStack.length; s.redoN=redoStack.length; validateSel(); }
function redo(){ if(!redoStack.length||locked.value) return; undoStack.push(snapshotSc()); restoreSc(redoStack.pop()); s.undoN=undoStack.length; s.redoN=redoStack.length; validateSel(); }
function validateSel(){ const x=s.sel; if(!x) return; const map={obj:'objects',node:'nodes',edge:'edges',station:'stations',route:'routes',vtype:'vtypes'}; if(!s.sc[map[x.kind]].some(o=>o.id===x.id)) s.sel=null; }

/* ---------- simulation runtime (non-reactive) ---------- */
let SIM=null, simAcc=0, kpiTimer=0;
const locked=computed(()=>s.sim.status!=='idle');

/* ===================== THREE ===================== */
const T={};
let suppress=false, rebuildQueued=false, chain=null, drag=null, rDown=null, curText='', curRaf=0;
function scheduleRebuild(){ if(rebuildQueued) return; rebuildQueued=true; requestAnimationFrame(()=>{rebuildQueued=false; rebuildAll();}); }

function initThree(el){
  let renderer;
  try{ renderer=new THREE.WebGLRenderer({antialias:true,alpha:false}); }
  catch(e){ el.innerHTML='<div class="nogl"><b>无法启动三维显示</b><span>这台电脑的浏览器不支持 WebGL，或已关闭硬件加速。请使用新版 Chrome 或 Edge，并在浏览器设置中开启「使用图形加速」。</span></div>'; return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
  el.appendChild(renderer.domElement);
  const scene=new THREE.Scene();
  const camP=new THREE.PerspectiveCamera(45,1,0.1,3000);
  const camO=new THREE.OrthographicCamera(-50,50,50,-50,0.1,3000); camO.up.set(0,0,-1);
  scene.add(new THREE.HemisphereLight(0xffffff,0x8a97a6,0.9));
  const sun=new THREE.DirectionalLight(0xffffff,0.55); sun.position.set(-40,80,30); scene.add(sun);
  const groups={}; for(const k of ['floor','objs','net','stations','veh','ui']){ groups[k]=new THREE.Group(); scene.add(groups[k]); }
  Object.assign(T,{renderer,scene,camP,camO,cam:camP,groups,ray:new THREE.Raycaster(),plane:new THREE.Plane(new THREE.Vector3(0,1,0),0),objMeshes:new Map(),vehMeshes:new Map(),clock:new THREE.Clock(),el});
  makeControls();
  const ro=new ResizeObserver(resize); ro.observe(el); resize();
  const dom=renderer.domElement;
  dom.addEventListener('pointerdown',onDown); window.addEventListener('pointermove',onMove); window.addEventListener('pointerup',onUp);
  dom.addEventListener('dblclick',()=>{ if(s.tool==='draw') chain=null, updatePreview(null); });
  fitView(); rebuildAll(); animate();
}
function makeControls(){
  if(T.controls) T.controls.dispose();
  const c=new THREE.OrbitControls(T.cam,T.renderer.domElement);
  c.enableDamping=true; c.dampingFactor=0.12; c.screenSpacePanning=true; c.maxPolarAngle=s.view==='top'?Math.PI:Math.PI*0.48;
  T.controls=c; applyControlButtons();
  if(T.target) c.target.copy(T.target);
  c.update();
}
function applyControlButtons(){
  const c=T.controls; if(!c) return; const top=s.view==='top';
  c.enableRotate=!top;
  c.mouseButtons={LEFT:s.tool==='orbit'?(top?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE):-1, MIDDLE:THREE.MOUSE.PAN, RIGHT:top?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE};
}
function resize(){ if(!T.renderer) return; const w=T.el.clientWidth||1,h=T.el.clientHeight||1; T.renderer.setSize(w,h,false); T.camP.aspect=w/h; T.camP.updateProjectionMatrix(); setOrthoFrustum(); }
function setOrthoFrustum(){ if(!T.el) return; const w=T.el.clientWidth||1,h=T.el.clientHeight||1,a=w/h; const L=s.sc.layout; const hh=Math.max(L.d/2,(L.w/2)/a)*1.08;
  Object.assign(T.camO,{left:-hh*a,right:hh*a,top:hh,bottom:-hh}); T.camO.updateProjectionMatrix(); }
function fitView(){
  if(!T.renderer) return; const L=s.sc.layout, cx=L.w/2, cz=L.d/2;
  T.target=new THREE.Vector3(cx,0,cz);
  if(s.view==='top'){ T.cam=T.camO; T.camO.position.set(cx,200,cz); T.camO.zoom=1; setOrthoFrustum(); T.camO.lookAt(cx,0,cz); }
  else { T.cam=T.camP; const m=Math.max(L.w,L.d); T.camP.position.set(cx-m*0.18,m*0.72,cz+m*0.88); T.camP.lookAt(cx,0,cz); }
  makeControls(); T.controls.target.set(cx,0,cz); T.controls.update(); s.follow=false; buildHandles();
}
function setView(v){ s.view=v; fitView(); }

/* ---------- builders ---------- */
function disposeGroup(g){ while(g.children.length){ const c=g.children.pop(); c.traverse(o=>{ if(o.geometry) o.geometry.dispose(); const ms=o.material?(Array.isArray(o.material)?o.material:[o.material]):[]; ms.forEach(m=>{ if(m.userData&&m.userData.shared) return; if(m.map) m.map.dispose(); m.dispose(); }); }); } }
const matCache=new Map();
function mat(color,opts={}){ const k=color+JSON.stringify(opts); if(matCache.has(k)) return matCache.get(k); const m=new THREE.MeshStandardMaterial({color,roughness:0.75,metalness:0.08,...opts}); m.userData.shared=true; matCache.set(k,m); return m; }
function box(w,h,d,color,opts){ const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat(color,opts)); return m; }
function label(text,{size=0.6,color,bg,bold=true}={}){
  const fs=44,pad=14,cv=document.createElement('canvas'),ctx=cv.getContext('2d');
  const font=`${bold?600:400} ${fs}px "Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif`; ctx.font=font;
  const tw=Math.ceil(ctx.measureText(text).width); cv.width=tw+pad*2; cv.height=Math.round(fs*1.5);
  ctx.font=font; ctx.fillStyle=bg||cssVar('--label-bg'); const r=10,W=cv.width,H=cv.height;
  ctx.beginPath(); ctx.moveTo(r,0); ctx.lineTo(W-r,0); ctx.quadraticCurveTo(W,0,W,r); ctx.lineTo(W,H-r); ctx.quadraticCurveTo(W,H,W-r,H); ctx.lineTo(r,H); ctx.quadraticCurveTo(0,H,0,H-r); ctx.lineTo(0,r); ctx.quadraticCurveTo(0,0,r,0); ctx.fill();
  ctx.fillStyle=color||cssVar('--label-ink'); ctx.textBaseline='middle'; ctx.fillText(text,pad,H/2+2);
  const tex=new THREE.CanvasTexture(cv); tex.minFilter=THREE.LinearFilter; tex.anisotropy=4;
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,depthTest:false,transparent:true})); sp.renderOrder=10; sp.scale.set(size*W/H,size,1); return sp;
}
function rebuildAll(){ if(!T.renderer) return; buildFloor(); buildObjs(); buildNet(); buildStations(); refreshSel(); }

function buildFloor(){
  const g=T.groups.floor; disposeGroup(g); const L=s.sc.layout, w=Math.max(1,L.w||1), d=Math.max(1,L.d||1);
  T.scene.background=new THREE.Color(cssVar('--scene-bg'));
  const fl=new THREE.Mesh(new THREE.PlaneGeometry(w,d),new THREE.MeshStandardMaterial({color:cssVar('--floor'),roughness:0.95})); fl.rotation.x=-Math.PI/2; fl.position.set(w/2,0,d/2); g.add(fl);
  const minor=[],major=[];
  for(let x=0;x<=w+1e-6;x+=1){ (x%5===0?major:minor).push(x,0.003,0,x,0.003,d); }
  for(let z=0;z<=d+1e-6;z+=1){ (z%5===0?major:minor).push(0,0.003,z,w,0.003,z); }
  const mkL=(arr,col,op)=>{const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(arr,3));return new THREE.LineSegments(geo,new THREE.LineBasicMaterial({color:col,transparent:true,opacity:op}));};
  g.add(mkL(minor,cssVar('--grid-minor'),0.7)); g.add(mkL(major,cssVar('--grid-major'),0.9));
  if(s.labels) for(let x=0;x<=w;x+=10){ const sp=label(`${x} m`,{size:1.0,bold:false}); sp.position.set(x,0.05,-1.4); g.add(sp); }
  if(s.labels) for(let z=10;z<=d;z+=10){ const sp=label(`${z} m`,{size:1.0,bold:false}); sp.position.set(-2.2,0.05,z); g.add(sp); }
  const bg=s.sc.bg;
  if(bg&&bg.data){ const tex=new THREE.TextureLoader().load(bg.data,()=>T.dirty=true); const bw=bg.width||w, bh=bw*(bg.aspect||1);
    const m=new THREE.Mesh(new THREE.PlaneGeometry(bw,bh),new THREE.MeshBasicMaterial({map:tex,transparent:true,opacity:bg.opacity??0.6,depthWrite:false}));
    m.rotation.x=-Math.PI/2; m.position.set((bg.x||0)+bw/2,0.002,(bg.z||0)+bh/2); g.add(m); }
}
function objMesh(o){
  const t=o.type, grp=new THREE.Group(), c=o.color||OBJ_TYPES[t].color, w=Math.max(0.05,o.w||1), d=Math.max(0.05,o.d||1), h=Math.max(0.02,o.h||0.1);
  if(t==='zone'){
    const pl=new THREE.Mesh(new THREE.PlaneGeometry(w,d),new THREE.MeshBasicMaterial({color:c,transparent:true,opacity:0.14,depthWrite:false})); pl.rotation.x=-Math.PI/2; pl.position.y=0.004; grp.add(pl);
    const pts=[[-w/2,-d/2],[w/2,-d/2],[w/2,d/2],[-w/2,d/2],[-w/2,-d/2]].map(([x,z])=>new THREE.Vector3(x,0.006,z));
    grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({color:c})));
    if(s.labels){ const sp=label(o.name||o.zoneKind,{size:1.25,color:c}); sp.position.set(0,0.3,-d/2+0.6); sp.center.set(0.5,0.5); grp.add(sp); }
  } else if(t==='rack'){
    const beam='#e07a1f';
    for(const sx of [-1,1]) for(const sz of [-1,1]){ const p=box(0.08,h,0.08,c); p.position.set(sx*(w/2-0.04),h/2,sz*(d/2-0.04)); grp.add(p); }
    const lv=[0.12,h*0.45,h*0.8];
    lv.forEach((y,i)=>{ const b=box(w,0.06,d*0.96,beam); b.position.y=y; grp.add(b);
      if(i<2) for(let k=0;k<3;k++){ const cr=box(w/3-0.12,0.32,d*0.7,'#b98a55'); cr.position.set(-w/3+k*w/3,y+0.19,0); grp.add(cr);} });
  } else if(t==='line'){
    const b=box(w,h-0.05,d,c); b.position.y=(h-0.05)/2; grp.add(b);
    const belt=box(w,0.05,d*0.78,'#2b3238'); belt.position.y=h-0.025; grp.add(belt);
  } else if(t==='bench'){
    const top=box(w,0.06,d,c); top.position.y=h-0.03; grp.add(top);
    for(const sx of [-1,1]){ const lg=box(0.06,h-0.06,d*0.9,'#59636c'); lg.position.set(sx*(w/2-0.05),(h-0.06)/2,0); grp.add(lg); }
  } else if(t==='buffer'){
    const pal=box(w,0.14,d,'#9a7b4f'); pal.position.y=0.07; grp.add(pal);
    const crate=box(w*0.92,h-0.16,d*0.9,c); crate.position.y=0.14+(h-0.16)/2; grp.add(crate);
  } else if(t==='charger'){
    const b=box(w,h,d,'#5d6872'); b.position.y=h/2; grp.add(b);
    const panel=box(w*0.7,h*0.35,0.02,c,{emissive:c,emissiveIntensity:0.6}); panel.position.set(0,h*0.65,-d/2-0.011); grp.add(panel);
  } else if(t==='column'){
    const b=box(w,h,d,c); b.position.y=h/2; grp.add(b);
    const band=box(w+0.02,1.2,d+0.02,'#e1a200'); band.position.y=0.6; grp.add(band);
  } else { const b=box(w,h,d,c); b.position.y=h/2; grp.add(b); }
  grp.position.set(o.x,0,o.z); grp.rotation.y=-(o.rot||0)*Math.PI/180; grp.userData.id=o.id; return grp;
}
function buildObjs(){ const g=T.groups.objs; disposeGroup(g); T.objMeshes.clear();
  for(const o of s.sc.objects){ const m=objMesh(o); g.add(m); T.objMeshes.set(o.id,m); } }

function nodeMap(){ return new Map(s.sc.nodes.map(n=>[n.id,n])); }
function heatColor(t){ const a=new THREE.Color(cssVar('--lane')), b=new THREE.Color(cssVar('--bad')); return a.lerp(b,Math.min(1,Math.max(0,t))); }
function buildNet(){
  const g=T.groups.net; disposeGroup(g); const N=nodeMap(); const lane=cssVar('--lane'), acc=cssVar('--accent');
  const showNodes=['network','stations'].includes(s.mode)||s.tool==='pickVia';
  let maxW=0; const ew=(SIM&&s.heat&&s.mode==='analysis')?SIM.edgeWait:null; if(ew) for(const k in ew) maxW=Math.max(maxW,ew[k]);
  const arrowGeo=new THREE.BufferGeometry(); arrowGeo.setAttribute('position',new THREE.Float32BufferAttribute([0.38,0,0,-0.24,0,0.26,-0.24,0,-0.26],3));
  for(const e of s.sc.edges){
    const a=N.get(e.a),b=N.get(e.b); if(!a||!b) continue; const dx=b.x-a.x,dz=b.z-a.z,len=Math.hypot(dx,dz); if(len<0.01) continue;
    const ang=Math.atan2(-dz,dx), two=e.dir==='both', W=two?1.6:1.0, sel=s.sel&&s.sel.kind==='edge'&&s.sel.id===e.id;
    const col=sel?new THREE.Color(acc):(ew&&maxW>0?heatColor((ew[e.id]||0)/maxW):new THREE.Color(lane));
    const rib=new THREE.Mesh(new THREE.BoxGeometry(len,0.01,W),new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:sel?0.5:(ew?0.62:0.26),depthWrite:false}));
    rib.position.set((a.x+b.x)/2,0.007,(a.z+b.z)/2); rib.rotation.y=ang; g.add(rib);
    for(const side of [-1,1]){ const tp=new THREE.Mesh(new THREE.BoxGeometry(len,0.012,0.05),new THREE.MeshBasicMaterial({color:col})); tp.position.set(0,0.003,side*(W/2-0.025)); rib.add(tp); }
    const am=new THREE.MeshBasicMaterial({color:col,side:THREE.DoubleSide});
    if(!two){ const n=Math.max(1,Math.floor(len/2.6)); for(let i=0;i<n;i++){ const t=(i+0.5)/n; const ar=new THREE.Mesh(arrowGeo,am); ar.position.set(a.x+dx*t,0.012,a.z+dz*t); ar.rotation.y=ang; g.add(ar);} }
    else { const n=Math.floor(len/1.2); for(let i=0;i<n;i++){ const t=(i+0.5)/n; const ds=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.012,0.06),am); ds.position.set(a.x+dx*t,0.012,a.z+dz*t); ds.rotation.y=ang; g.add(ds);} }
  }
  if(showNodes){ const ink=cssVar('--ink');
    for(const n of s.sc.nodes){ const sel=s.sel&&s.sel.kind==='node'&&s.sel.id===n.id; const c=new THREE.Mesh(new THREE.CircleGeometry(sel?0.34:0.22,20),new THREE.MeshBasicMaterial({color:sel?acc:ink}));
      c.rotation.x=-Math.PI/2; c.position.set(n.x,0.016,n.z); g.add(c); } }
  if(s.mode==='routes'){ const sc=toRaw(s.sc), gr=buildGraph(sc), stm=new Map(sc.stations.map(x=>[x.id,x])); const anySel=s.sel&&s.sel.kind==='route';
    const le=s.legEdit, Nm=new Map(sc.nodes.map(n=>[n.id,n]));
    sc.routes.forEach((r,ri)=>{ const vt=sc.vtypes.find(v=>v.id===r.vtype); const stops=r.stops.filter(id=>stm.has(id)); if(stops.length<2) return;
      const on=anySel&&s.sel.id===r.id, off=((ri%4)-1.5)*0.2+0.35, faded=anySel&&!on;
      const m=new THREE.MeshBasicMaterial({color:r.color,transparent:true,opacity:faded?0.22:(le&&on?0.4:0.95),depthWrite:false,side:THREE.DoubleSide});
      const mHot=new THREE.MeshBasicMaterial({color:r.color,transparent:true,opacity:1,depthWrite:false,side:THREE.DoubleSide});
      for(let i=0;i<stops.length;i++){ const A=stm.get(stops[i]), B=stm.get(stops[(i+1)%stops.length]); const hot=le&&on&&le.key===legKey(A.id,B.id);
        const p=routeLegPath(gr,r,A,B,vt?vt.vmax:1)||[]; const mm=hot?mHot:m, w=hot?0.42:(on?0.26:0.14);
        for(const a of p){ const cx=(a.ax+a.bx)/2-a.uz*off, cz=(a.az+a.bz)/2+a.ux*off, ang=Math.atan2(-a.uz,a.ux);
          const seg=new THREE.Mesh(new THREE.BoxGeometry(a.len,0.02,w),mm); seg.position.set(cx,0.03+ri*0.003+(hot?0.01:0),cz); seg.rotation.y=ang; g.add(seg);
          if(!faded){ const n=Math.max(1,Math.floor(a.len/3.2)); for(let k=0;k<n;k++){ const t=(k+0.5)/n; const ar=new THREE.Mesh(arrowGeo,mm); ar.scale.setScalar(hot?1.1:0.75);
            ar.position.set(a.ax+(a.bx-a.ax)*t-a.uz*off,0.045+ri*0.003,a.az+(a.bz-a.az)*t+a.ux*off); ar.rotation.y=ang; ar.renderOrder=3; g.add(ar); } } }
        if(hot){ legVia(r,A.id,B.id).forEach((nid,vi)=>{ const n=Nm.get(nid); if(!n) return; const ring=new THREE.Mesh(new THREE.RingGeometry(0.42,0.62,28),new THREE.MeshBasicMaterial({color:r.color,side:THREE.DoubleSide}));
          ring.rotation.x=-Math.PI/2; ring.position.set(n.x,0.06,n.z); g.add(ring); const lb=label(`途经 ${vi+1}`,{size:0.7,bg:r.color,color:'#ffffff'}); lb.center.set(0.5,0); lb.position.set(n.x,0.9,n.z); g.add(lb); }); } } }); }
  const pv=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]),new THREE.LineDashedMaterial({color:acc,dashSize:0.4,gapSize:0.25}));
  pv.visible=false; g.add(pv); T.preview=pv;
}
function buildStations(){
  const g=T.groups.stations; disposeGroup(g); const N=nodeMap();
  for(const st of s.sc.stations){ const n=N.get(st.node); if(!n) continue; const col=STATION_TYPES[st.type]?.color||'#888'; const sel=s.sel&&s.sel.kind==='station'&&s.sel.id===st.id;
    const ring=new THREE.Mesh(new THREE.RingGeometry(sel?0.62:0.55,sel?0.92:0.78,36),new THREE.MeshBasicMaterial({color:sel?cssVar('--accent'):col,side:THREE.DoubleSide})); ring.rotation.x=-Math.PI/2; ring.position.set(n.x,0.02,n.z); g.add(ring);
    const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.025,0.025,1.9,6),mat(col)); pole.position.set(n.x,0.95,n.z); g.add(pole);
    if(s.labels){ const sp=label(`${st.name} · ${dwellText(st)}`,{size:1.0,color:'#ffffff',bg:col}); sp.center.set(0.5,0); sp.position.set(n.x,1.95,n.z); g.add(sp); } }
}
function updateSelectionBox(){
  if(T.selBox){ T.groups.ui.remove(T.selBox); T.selBox.geometry.dispose(); T.selBox=null; }
  const o=selObjRaw(); if(!o) return;
  const geo=new THREE.EdgesGeometry(new THREE.BoxGeometry((o.w||1)+0.16,Math.max(0.1,o.type==='zone'?0.1:o.h)+0.1,(o.d||1)+0.16));
  const l=new THREE.LineSegments(geo,new THREE.LineBasicMaterial({color:cssVar('--accent')}));
  l.position.set(o.x,(o.type==='zone'?0.1:o.h)/2,o.z); l.rotation.y=-(o.rot||0)*Math.PI/180; T.groups.ui.add(l); T.selBox=l;
}
function refreshSel(){ updateSelectionBox(); buildHandles(); }
function selObjRaw(){ return s.sel&&s.sel.kind==='obj'? s.sc.objects.find(o=>o.id===s.sel.id):null; }

/* ---------- transform handles (stretch / rotate / height) ---------- */
function psAt(pos){ const H=T.el.clientHeight||1; if(s.view==='top') return (T.camO.top-T.camO.bottom)/T.camO.zoom/H; return T.cam.position.distanceTo(pos)*Math.tan(T.camP.fov*Math.PI/360)*2/H; }
function toScreen(v){ const p=v.clone().project(T.cam); const r=T.renderer.domElement.getBoundingClientRect(); return {x:r.left+(p.x+1)/2*r.width,y:r.top+(1-p.y)/2*r.height}; }
function buildHandles(){
  if(!T.renderer) return;
  if(T.handles){ T.groups.ui.remove(T.handles.group); disposeGroup(T.handles.group); T.handles=null; }
  const o=selObjRaw(); if(!o||s.mode!=='layout'||locked.value||s.tool!=='select') return;
  const grp=new THREE.Group(), acc=cssVar('--accent');
  const mA=new THREE.MeshBasicMaterial({color:acc,depthTest:false,transparent:true}), mF=new THREE.MeshBasicMaterial({color:cssVar('--panel-2'),depthTest:false,transparent:true});
  const items=[], add=(kind,sx,sz,obj)=>{ obj.traverse(m=>m.renderOrder=20); grp.add(obj); items.push({kind,sx,sz,mesh:obj}); };
  for(const sx of [-1,0,1]) for(const sz of [-1,0,1]){ if(!sx&&!sz) continue; const g=new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1,0.2,1),mA)); if(!(sx&&sz)){ const inner=new THREE.Mesh(new THREE.BoxGeometry(0.55,0.22,0.55),mF); g.add(inner); }
    add(sx&&sz?'corner':'edge',sx,sz,g); }
  add('rot',0,0,new THREE.Mesh(new THREE.SphereGeometry(0.5,16,12),mA));
  const stem=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]),new THREE.LineBasicMaterial({color:acc,depthTest:false,transparent:true})); stem.renderOrder=19; grp.add(stem);
  if(o.type!=='zone'&&s.view!=='top') add('height',0,0,new THREE.Mesh(new THREE.ConeGeometry(0.5,1.2,16),mA));
  T.groups.ui.add(grp); T.handles={group:grp,items,stem,id:o.id}; positionHandles();
}
function positionHandles(){
  const H=T.handles; if(!H) return; const o=s.sc.objects.find(x=>x.id===H.id); if(!o){ buildHandles(); return; }
  const th=(o.rot||0)*Math.PI/180,c=Math.cos(th),sn=Math.sin(th), W=(lx,lz,y)=>new THREE.Vector3(o.x+lx*c-lz*sn,y,o.z+lx*sn+lz*c);
  const ps=psAt(new THREE.Vector3(o.x,0,o.z));
  for(const it of H.items){ let p,sz;
    if(it.kind==='corner'){ p=W(it.sx*o.w/2,it.sz*o.d/2,0.06); sz=11*ps; }
    else if(it.kind==='edge'){ p=W(it.sx*o.w/2,it.sz*o.d/2,0.06); sz=10*ps; }
    else if(it.kind==='rot'){ p=W(0,-(o.d/2+34*ps),0.06); sz=12*ps; H.stem.geometry.setFromPoints([W(0,-o.d/2,0.06),p]); }
    else { p=new THREE.Vector3(o.x,(o.h||0)+18*ps,o.z); sz=11*ps; }
    it.mesh.position.copy(p); it.mesh.scale.setScalar(sz); }
}
function pickHandle(ev){ const H=T.handles; if(!H) return null; let best=null,bd=14;
  for(const it of H.items){ const q=toScreen(it.mesh.position); const d=Math.hypot(q.x-ev.clientX,q.y-ev.clientY); if(d<bd){bd=d;best=it;} } return best; }
function replaceObjMesh(o){ const g=T.groups.objs, old=T.objMeshes.get(o.id);
  if(old){ g.remove(old); const tmp=new THREE.Group(); tmp.add(old); disposeGroup(tmp); }
  const m=objMesh(o); g.add(m); T.objMeshes.set(o.id,m); }
const fmtD=v=>String(+(+v).toFixed(2));
function showTip(ev,text){ const el=document.getElementById('dimTip'); if(!el||!T.el) return; const r=T.el.getBoundingClientRect(); el.textContent=text; el.hidden=false;
  el.style.left=Math.min(r.width-170,Math.max(4,ev.clientX-r.left+16))+'px'; el.style.top=Math.max(4,ev.clientY-r.top+16)+'px'; }
function hideTip(){ const el=document.getElementById('dimTip'); if(el) el.hidden=true; }
function newObj(type,x,z){ const d=OBJ_TYPES[type]; return {id:uid('o'),type,name:type==='zone'?ZONE_KINDS[0]:d.label,x,z,w:d.w,d:d.d,h:d.h,rot:0,color:d.color,zoneKind:type==='zone'?ZONE_KINDS[0]:''}; }

/* ---------- vehicles ---------- */
function vehMesh(v){
  const vt=v.vt, c=vt.color||'#e1a200', root=new THREE.Group(), parts=[]; const L=vt.length,W=vt.width,H=vt.height;
  const tr=new THREE.Group();
  if(vt.kind==='agv'){ const b=box(L,H*0.8,W,c); b.position.y=0.06+H*0.4; tr.add(b); const top=box(L*0.92,0.03,W*0.9,'#3a434c'); top.position.y=0.06+H*0.8+0.015; tr.add(top);
    const li=new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.07,0.08,12),mat('#1e252b')); li.position.set(L/2-0.12,0.06+H*0.8+0.07,0); tr.add(li); }
  else if(vt.kind==='tug'){ const b=box(L,0.45,W,c); b.position.y=0.3; tr.add(b); const cab=box(L*0.45,H-0.45,W*0.9,'#2a3036'); cab.position.set(-L*0.18,0.52+(H-0.45)/2,0); tr.add(cab);
    const seat=box(L*0.3,0.06,W*0.7,'#14191d'); seat.position.set(L*0.2,0.56,0); tr.add(seat); }
  else if(vt.kind==='fork'){ const b=box(L*0.62,H*0.45,W,c); b.position.set(-L*0.19,H*0.225+0.05,0); tr.add(b); const mast=box(0.08,H,W*0.8,'#2a3036'); mast.position.set(L*0.13,H/2,0); tr.add(mast);
    for(const sz of [-1,1]){ const f=box(L*0.36,0.04,0.1,'#2a3036'); f.position.set(L*0.32,0.08,sz*W*0.25); tr.add(f);} }
  else { const p=box(L,0.06,W,c); p.position.y=0.25; tr.add(p); const bins=box(L*0.85,0.42,W*0.85,'#5b8cc0'); bins.position.y=0.5; tr.add(bins);
    const h=box(0.04,0.55,W,'#3a434c'); h.position.set(-L/2,0.55,0); tr.add(h);
    const body=new THREE.Mesh(new THREE.CylinderGeometry(0.18,0.2,1.1,10),mat('#2f4f6f')); body.position.set(-L/2-0.42,0.75,0); tr.add(body);
    const head=new THREE.Mesh(new THREE.SphereGeometry(0.13,12,10),mat('#f0c27a')); head.position.set(-L/2-0.42,1.45,0); tr.add(head);
    const hat=new THREE.Mesh(new THREE.SphereGeometry(0.14,12,8,0,Math.PI*2,0,Math.PI/2),mat('#e1a200')); hat.position.set(-L/2-0.42,1.48,0); tr.add(hat); }
  const lamp=new THREE.Mesh(new THREE.SphereGeometry(0.09,10,8),new THREE.MeshBasicMaterial({color:'#2b8a57'})); lamp.position.set(0,(vt.kind==='agv'?0.06+H*0.8+0.12:H+0.12),0); tr.add(lamp);
  root.add(tr); parts.push({g:tr,back:L/2});
  if(vt.kind==='tug') for(let k=0;k<(vt.carts||0);k++){ const cl=vt.cartLen||1.2, cg=new THREE.Group();
    const p=box(cl,0.06,W*0.95,'#59636c'); p.position.y=0.3; cg.add(p);
    const load=box(cl*0.86,0.5,W*0.8,v.route.color||'#5b8cc0'); load.position.y=0.6; cg.add(load);
    root.add(cg); parts.push({g:cg,back:L+0.3+k*(cl+0.3)+cl/2}); }
  const tag=label(v.id,{size:0.9,bg:v.route.color||c,color:'#ffffff'}); tag.center.set(0.5,0); root.add(tag);
  return {root,parts,lamp,tag};
}
function syncVehicles(){
  if(!T.renderer) return; const g=T.groups.veh;
  if(!SIM){ if(T.vehMeshes.size){ disposeGroup(g); T.vehMeshes.clear(); } return; }
  const colors={}; for(const k of STATE_KEYS) colors[k]=cssVar(STATE[k].v);
  for(const v of SIM.vehicles){
    let m=T.vehMeshes.get(v.id); if(!m){ m=vehMesh(v); g.add(m.root); T.vehMeshes.set(v.id,m); }
    m.root.visible=v.active; if(!v.active) continue;
    for(const p of m.parts){ const a=posAlong(v,p.back-0.3), b=posAlong(v,p.back+0.3); const cx=(a.x+b.x)/2, cz=(a.z+b.z)/2;
      p.g.position.set(cx,0,cz); const dx=a.x-b.x, dz=a.z-b.z; if(dx*dx+dz*dz>1e-6) p.g.rotation.y=Math.atan2(-dz,dx); }
    m.lamp.material.color.set(colors[v.state]||'#888');
    const p0=m.parts[0].g.position; m.tag.position.set(p0.x,(v.vt.kind==='cart'?1.9:v.vt.height+0.6),p0.z); m.tag.visible=s.labels;
    m.tag.material.opacity=(s.selVeh===v.id||!s.selVeh)?1:0.5;
  }
}

/* ---------- loop ---------- */
function animate(){
  requestAnimationFrame(animate);
  const dtReal=Math.min(0.1,T.clock.getDelta());
  if(SIM && s.sim.status==='running' && !s.fast){
    simAcc+=dtReal*s.speed; let n=Math.floor(simAcc/SIM_DT); if(n>4000){n=4000;simAcc=0;} else simAcc-=n*SIM_DT;
    for(let i=0;i<n&&!SIM.done;i++) SIM.step(SIM_DT);
    if(SIM.done) finishSim();
  }
  if(SIM){ syncVehicles(); kpiTimer+=dtReal; if(kpiTimer>0.3){ kpiTimer=0; refreshKPI(); }
    if(s.follow&&s.selVeh){ const v=SIM.vehicles.find(x=>x.id===s.selVeh); if(v&&v.active){ const p=posAlong(v,v.vt.length/2); const tg=T.controls.target; const dx=p.x-tg.x, dz=p.z-tg.z; tg.x+=dx*0.12; tg.z+=dz*0.12; T.cam.position.x+=dx*0.12; T.cam.position.z+=dz*0.12; } } }
  else if(T.vehMeshes.size) syncVehicles();
  T.controls.update(); if(T.handles) positionHandles(); T.renderer.render(T.scene,T.cam);
}

/* ---------- picking ---------- */
const ndc=new THREE.Vector2();
function setRay(ev){ const r=T.renderer.domElement.getBoundingClientRect(); ndc.set(((ev.clientX-r.left)/r.width)*2-1,-((ev.clientY-r.top)/r.height)*2+1); T.ray.setFromCamera(ndc,T.cam); }
function groundAt(ev){ setRay(ev); const p=new THREE.Vector3(); return T.ray.ray.intersectPlane(T.plane,p)?{x:p.x,z:p.z}:null; }
function heightAt(ev,o){ setRay(ev); const n=new THREE.Vector3(T.cam.position.x-o.x,0,T.cam.position.z-o.z); if(n.lengthSq()<1e-6) return null; n.normalize();
  const pl=new THREE.Plane().setFromNormalAndCoplanarPoint(n,new THREE.Vector3(o.x,0,o.z)); const q=new THREE.Vector3(); return T.ray.ray.intersectPlane(pl,q)?q.y:null; }
function pixelScale(){ if(s.view==='top'){ const h=T.el.clientHeight||1; return (T.camO.top-T.camO.bottom)/T.camO.zoom/h; } const d=T.cam.position.distanceTo(T.controls.target); return d*Math.tan(T.camP.fov*Math.PI/360)*2/(T.el.clientHeight||1); }
function tol(px){ return Math.max(0.35,Math.min(2.5,px*pixelScale())); }
function inObj(o,x,z,pad=0){ const th=(o.rot||0)*Math.PI/180, dx=x-o.x, dz=z-o.z; const lx=dx*Math.cos(th)+dz*Math.sin(th), lz=-dx*Math.sin(th)+dz*Math.cos(th); return Math.abs(lx)<=o.w/2+pad && Math.abs(lz)<=o.d/2+pad; }
function hitObj(x,z){ const objs=s.sc.objects; for(let i=objs.length-1;i>=0;i--){ if(objs[i].type!=='zone'&&inObj(objs[i],x,z,0.1)) return objs[i]; } for(let i=objs.length-1;i>=0;i--){ if(objs[i].type==='zone'&&inObj(objs[i],x,z)) return objs[i]; } return null; }
function hitNode(x,z,r){ let best=null,bd=r; for(const n of s.sc.nodes){ const d=Math.hypot(n.x-x,n.z-z); if(d<bd){bd=d;best=n;} } return best; }
function hitEdge(x,z,r){ const N=nodeMap(); let best=null,bd=r;
  for(const e of s.sc.edges){ const a=N.get(e.a),b=N.get(e.b); if(!a||!b) continue; const dx=b.x-a.x,dz=b.z-a.z,l2=dx*dx+dz*dz; if(l2<1e-6) continue;
    let t=((x-a.x)*dx+(z-a.z)*dz)/l2; t=Math.max(0,Math.min(1,t)); const px=a.x+dx*t,pz=a.z+dz*t,d=Math.hypot(px-x,pz-z); if(d<bd){bd=d;best={e,t,px,pz};} } return best; }
function hitStation(x,z,r){ const N=nodeMap(); let best=null,bd=r; for(const st of s.sc.stations){ const n=N.get(st.node); if(!n) continue; const d=Math.hypot(n.x-x,n.z-z); if(d<bd){bd=d;best=st;} } return best; }
function hitVehicle(x,z){ if(!SIM) return null; let best=null,bd=1.6; for(const v of SIM.vehicles){ if(!v.active) continue; const p=posAlong(v,v.vt.length/2); const d=Math.hypot(p.x-x,p.z-z); if(d<bd){bd=d;best=v;} } return best; }

/* ---------- pointer ---------- */
function onDown(ev){
  if(ev.button===2){ rDown={x:ev.clientX,y:ev.clientY}; return; }
  if(ev.button!==0||s.tool==='orbit') return;
  const p=groundAt(ev); if(!p) return;
  const vh=hitVehicle(p.x,p.z); if(vh&&(locked.value||s.mode==='analysis')){ pickVeh(vh.id); return; }
  if(locked.value){ if(s.mode!=='analysis') toast('仿真进行中，点「重置」后可编辑'); return; }
  const t=s.tool;
  if(s.mode==='layout'){
    if(t.startsWith('place:')){ drag={kind:'place',type:t.slice(6),x0:snap(p.x),z0:snap(p.z),id:null,moved:false}; return; }
    const hd=pickHandle(ev);
    if(hd){ const so=selObjRaw(); drag={kind:'handle',h:hd,id:so.id,o0:{x:so.x,z:so.z,w:so.w,d:so.d,h:so.h,rot:so.rot||0},moved:false,dy0:0};
      if(hd.kind==='height'){ const y=heightAt(ev,so); drag.dy0=(y==null?so.h:y)-so.h; } return; }
    const o=hitObj(p.x,p.z); if(o){ s.sel={kind:'obj',id:o.id}; drag={kind:'obj',id:o.id,ox:p.x-o.x,oz:p.z-o.z,moved:false}; } else s.sel=null; return;
  }
  if(s.mode==='network'){
    if(t==='draw'){ drawClick(p,ev.shiftKey); return; }
    const n=hitNode(p.x,p.z,tol(12)); if(n){ s.sel={kind:'node',id:n.id}; drag={kind:'node',id:n.id,moved:false}; return; }
    const he=hitEdge(p.x,p.z,tol(10)); s.sel=he?{kind:'edge',id:he.e.id}:null; return;
  }
  if(s.mode==='stations'){
    const st=hitStation(p.x,p.z,tol(14)); if(st){ s.sel={kind:'station',id:st.id}; return; }
    if(t==='station'){ const n=hitNode(p.x,p.z,tol(12)); if(n){ makeStation(n.id); return; }
      const he=hitEdge(p.x,p.z,tol(10)); if(he){ pushHistory(); const nid=splitEdge(he.e,snap(he.px,0.1),snap(he.pz,0.1)); makeStation(nid,true); return; }
      toast('请点击路网节点或路段来添加站点'); return; }
    s.sel=null; return;
  }
  if(s.mode==='routes'&&t==='pickVia'){ const st=hitStation(p.x,p.z,tol(14)); const n=st?{id:st.node}:hitNode(p.x,p.z,tol(14));
    if(n) addVia(n.id); else if(hitEdge(p.x,p.z,tol(10))) toast('请点击路段两端的节点（圆点）。需要经过路段中间某点时，先在「路网规划」中插入节点'); else toast('请点击路网节点（圆点）'); return; }
  if(s.mode==='routes'&&t==='pickStop'){ const st=hitStation(p.x,p.z,tol(16)); if(st) addStop(st.id); else toast('请点击站点（彩色圆环）'); return; }
  if(s.mode==='analysis'){ s.selVeh=null; s.follow=false; }
}
function onMove(ev){
  if(!T.renderer) return;
  const r=T.renderer.domElement.getBoundingClientRect(); const inside=ev.clientX>=r.left&&ev.clientX<=r.right&&ev.clientY>=r.top&&ev.clientY<=r.bottom;
  const p=inside||drag?groundAt(ev):null;
  if(p&&inside){ curText=`X ${p.x.toFixed(1)} m · Z ${p.z.toFixed(1)} m`; if(!curRaf) curRaf=requestAnimationFrame(()=>{curRaf=0;s.cursor=curText;}); }
  if(drag&&drag.kind==='place'){ if(!p) return; const dx=snap(p.x)-drag.x0, dz=snap(p.z)-drag.z0;
    if(!drag.id&&Math.hypot(dx,dz)<0.5) return;
    if(!drag.id){ pushHistory(); suppress=true; const o=newObj(drag.type,drag.x0,drag.z0); s.sc.objects.push(o); drag.id=o.id; s.sel={kind:'obj',id:o.id}; }
    const o=s.sc.objects.find(x=>x.id===drag.id); if(!o) return;
    if(o.type==='wall'){ if(Math.abs(dx)>=Math.abs(dz)){ o.w=Math.max(0.5,Math.abs(dx)); o.rot=0; o.x=r2(drag.x0+dx/2); o.z=drag.z0; } else { o.w=Math.max(0.5,Math.abs(dz)); o.rot=90; o.x=drag.x0; o.z=r2(drag.z0+dz/2); } showTip(ev,`长 ${fmtD(o.w)} m`); }
    else { o.w=Math.max(0.5,Math.abs(dx)); o.d=Math.max(0.5,Math.abs(dz)); o.x=r2(drag.x0+dx/2); o.z=r2(drag.z0+dz/2); showTip(ev,`长 ${fmtD(o.w)} m × 宽 ${fmtD(o.d)} m`); }
    replaceObjMesh(o); updateSelectionBox(); return; }
  if(drag&&drag.kind==='handle'){ const o=s.sc.objects.find(x=>x.id===drag.id); if(!o) return; const o0=drag.o0, k=drag.h.kind;
    if(!drag.moved){ pushHistory(); drag.moved=true; suppress=true; }
    if(k==='height'){ const y=heightAt(ev,o); if(y==null) return; o.h=Math.max(0.05,Math.round((y-drag.dy0)*10)/10); showTip(ev,`高 ${fmtD(o.h)} m`); }
    else { if(!p) return; const dx=p.x-o0.x, dz=p.z-o0.z, th=o0.rot*Math.PI/180, c=Math.cos(th), sn=Math.sin(th);
      if(k==='rot'){ let a=Math.atan2(dx,-dz)*180/Math.PI; a=ev.shiftKey?Math.round(a):Math.round(a/15)*15; o.rot=((a%360)+360)%360; showTip(ev,`角度 ${o.rot}°`); }
      else { const lx=dx*c+dz*sn, lz=-dx*sn+dz*c, sx=drag.h.sx, sz=drag.h.sz, sym=ev.altKey, mn=o.type==='zone'?0.5:0.1, sd=v=>Math.max(mn,Math.round(v*10)/10);
        let w=o0.w,d=o0.d,cx=0,cz=0;
        if(sx){ w=sd(sym?2*Math.abs(lx):sx*lx+o0.w/2); cx=sym?0:sx*(w-o0.w)/2; }
        if(sz){ d=sd(sym?2*Math.abs(lz):sz*lz+o0.d/2); cz=sym?0:sz*(d-o0.d)/2; }
        o.w=w; o.d=d; o.x=r2(o0.x+cx*c-cz*sn); o.z=r2(o0.z+cx*sn+cz*c);
        showTip(ev,o.type==='wall'?`长 ${fmtD(w)} m · 厚 ${fmtD(d)} m`:`长 ${fmtD(w)} m × 宽 ${fmtD(d)} m`); } }
    replaceObjMesh(o); updateSelectionBox(); return; }
  if(!drag&&inside&&s.mode==='layout'&&!locked.value){ const dom=T.renderer.domElement, hd=s.tool==='select'?pickHandle(ev):null;
    dom.style.cursor=hd?(hd.kind==='rot'?'grab':hd.kind==='height'?'ns-resize':hd.kind==='corner'?'nwse-resize':(hd.sx?'ew-resize':'ns-resize'))
      :s.tool.startsWith('place:')?'crosshair':(s.tool==='select'&&p&&hitObj(p.x,p.z)?'move':''); }
  else if(inside&&!drag) T.renderer.domElement.style.cursor=s.tool==='draw'||s.tool==='station'?'crosshair':'';
  if(drag&&p){
    if(!drag.moved){ pushHistory(); drag.moved=true; suppress=true; }
    if(drag.kind==='obj'){ const o=s.sc.objects.find(x=>x.id===drag.id); if(!o) return; o.x=snap(p.x-drag.ox); o.z=snap(p.z-drag.oz); const m=T.objMeshes.get(o.id); if(m) m.position.set(o.x,0,o.z); updateSelectionBox(); showTip(ev,`X ${fmtD(o.x)} · Z ${fmtD(o.z)} m`); }
    else if(drag.kind==='node'){ const n=s.sc.nodes.find(x=>x.id===drag.id); if(!n) return; n.x=snap(p.x); n.z=snap(p.z); buildNet(); buildStations(); }
    return;
  }
  if(s.tool==='draw'&&chain&&p&&s.mode==='network'){ const q=drawTarget(p,ev.shiftKey); updatePreview(q); }
}
function onUp(ev){
  if(ev.button===2&&rDown){ const moved=Math.hypot(ev.clientX-rDown.x,ev.clientY-rDown.y)>4; rDown=null; if(!moved&&s.tool==='draw'){ chain=null; updatePreview(null); } return; }
  if(drag){ const d=drag; drag=null; hideTip();
    if(d.kind==='place'&&!d.id){ if(ev.button!==0) return; pushHistory(); const o=newObj(d.type,d.x0,d.z0); s.sc.objects.push(o); s.sel={kind:'obj',id:o.id}; return; }
    if(d.moved||d.id){ suppress=false; if(d.kind==='node') tidyNetwork(false); scheduleRebuild(); scheduleSave(); } }
}
function drawTarget(p,shift){
  const from=chain?s.sc.nodes.find(n=>n.id===chain):null;
  const n=hitNode(p.x,p.z,tol(12)); if(n) return {x:n.x,z:n.z,node:n};
  let x=snap(p.x),z=snap(p.z);
  if(from&&s.angleSnap&&!shift){ const dx=p.x-from.x,dz=p.z-from.z; const L=snap(Math.hypot(dx,dz)); const a=Math.round(Math.atan2(dz,dx)/(Math.PI/4))*(Math.PI/4); x=r2(from.x+Math.cos(a)*L); z=r2(from.z+Math.sin(a)*L); if(Math.abs(Math.cos(a))<1e-6) x=from.x; if(Math.abs(Math.sin(a))<1e-6) z=from.z; }
  const he=hitEdge(p.x,p.z,tol(8)); if(he&&!(from&&(he.e.a===from.id||he.e.b===from.id))) return {x:r2(he.px),z:r2(he.pz),edge:he.e};
  return {x,z};
}
function drawClick(p,shift){
  const q=drawTarget(p,shift); pushHistory();
  let nid; if(q.node) nid=q.node.id; else if(q.edge) nid=splitEdge(q.edge,q.x,q.z); else { nid=uid('n'); s.sc.nodes.push({id:nid,x:q.x,z:q.z}); }
  if(chain&&chain!==nid){ const ex=s.sc.edges.find(e=>(e.a===chain&&e.b===nid)||(e.a===nid&&e.b===chain));
    if(!ex) s.sc.edges.push({id:uid('e'),a:chain,b:nid,dir:s.newDir,limit:s.newLimit>0?s.newLimit:null});
    else if(ex.dir==='fwd'&&(s.newDir==='both'||ex.a===nid)){ ex.dir='both'; toast('与已有路段重合，已合并为双向路段'); } }
  chain=nid; s.sel={kind:'node',id:nid};
  tidyNetwork(false);
}
function updatePreview(q){ const pv=T.preview; if(!pv) return; const from=chain&&s.sc.nodes.find(n=>n.id===chain);
  if(!q||!from){ pv.visible=false; return; } pv.geometry.setFromPoints([new THREE.Vector3(from.x,0.05,from.z),new THREE.Vector3(q.x,0.05,q.z)]); pv.computeLineDistances(); pv.visible=true; }
function splitEdge(e,x,z){ const nid=uid('n'); s.sc.nodes.push({id:nid,x,z}); const b=e.b; e.b=nid; s.sc.edges.push({id:uid('e'),a:nid,b,dir:e.dir,limit:e.limit}); return nid; }
/* 路网整理：交叉生成路口、重叠合并、相近节点合并。绘制、拖动节点后自动执行；manual=true 时由按钮触发 */
function tidyNetwork(manual){
  const r=normalizeNetwork(toRaw(s.sc),{uid});
  if(!r.changed){ if(manual) toast('路网已是整理好的状态，没有重叠或交叉需要合并'); return null; }
  if(manual) pushHistory();
  s.sc.nodes=r.nodes; s.sc.edges=r.edges; s.sc.stations=r.stations; s.sc.routes=r.routes;
  if(chain&&r.remap.has(chain)) chain=r.remap.get(chain);
  if(s.sel&&s.sel.kind==='node'&&r.remap.has(s.sel.id)) s.sel={kind:'node',id:r.remap.get(s.sel.id)};
  validateSel();
  const st=r.stats, parts=[];
  if(st.crossings) parts.push(`${st.crossings} 处交叉生成路口`); if(st.edges) parts.push(`合并重叠路段 ${st.edges} 段`);
  if(st.nodes) parts.push(`合并相近节点 ${st.nodes} 个`); if(st.splits) parts.push(`在节点处拆分路段 ${st.splits} 处`);
  toast((manual?'路网已整理：':'已自动整理路网：')+parts.join('，'));
  return r;
}
/* 路线分段的途经点编辑 */
function legOf(i){ const r=selRouteRaw(); if(!r) return null; const n=r.stops.length; if(n<2) return null; const from=r.stops[i], to=r.stops[(i+1)%n]; return {r,i,from,to,key:legKey(from,to)}; }
function editLeg(i){ const L=legOf(i); if(!L) return; if(s.legEdit&&s.legEdit.key===L.key){ finishLeg(); return; }
  s.legEdit={routeId:L.r.id,key:L.key,i,from:L.from,to:L.to}; setTool('pickVia'); scheduleRebuild();
  const A=stationById(L.from), B=stationById(L.to); toast(`依次点击「${A?A.name:''}」→「${B?B.name:''}」要经过的路网节点`); }
function finishLeg(){ s.legEdit=null; if(s.tool==='pickVia') setTool('select'); scheduleRebuild(); }
function clearLeg(i){ const L=legOf(i); if(!L||!L.r.via||!L.r.via[L.key]) return; pushHistory(); delete L.r.via[L.key]; L.r.via={...L.r.via}; scheduleRebuild(); }
function addVia(nodeId){ const le=s.legEdit, r=le&&s.sc.routes.find(x=>x.id===le.routeId); if(!r) return;
  const vias=(r.via&&r.via[le.key])||[], A=stationById(le.from), B=stationById(le.to);
  const prev=vias.length?vias[vias.length-1]:(A&&A.node); if(nodeId===prev){ toast('与上一个点相同'); return; }
  const vt=s.sc.vtypes.find(v=>v.id===r.vtype), g=buildGraph(toRaw(s.sc));
  if(!shortestPath(g,prev,nodeId,vt?vt.vmax:1)){ toast('从上一个点无法到达这个节点，请检查路段方向'); return; }
  if(B&&!shortestPath(g,nodeId,B.node,vt?vt.vmax:1)) toast('提示：从这个节点暂时到不了终点站，请继续添加途经点');
  pushHistory(); r.via={...(r.via||{}),[le.key]:[...vias,nodeId]}; }
function undoVia(){ const le=s.legEdit, r=le&&s.sc.routes.find(x=>x.id===le.routeId); if(!r||!r.via||!r.via[le.key]||!r.via[le.key].length) return;
  pushHistory(); const v=r.via[le.key].slice(0,-1); const nv={...r.via}; if(v.length) nv[le.key]=v; else delete nv[le.key]; r.via=nv; }
function stationById(id){ return s.sc.stations.find(x=>x.id===id); }

/* ---------- keyboard ---------- */
window.addEventListener('keydown',ev=>{
  const tag=(ev.target.tagName||'').toLowerCase(); if(['input','textarea','select'].includes(tag)) return;
  if((ev.ctrlKey||ev.metaKey)&&ev.key.toLowerCase()==='z'){ ev.preventDefault(); ev.shiftKey?redo():undo(); return; }
  if((ev.ctrlKey||ev.metaKey)&&ev.key.toLowerCase()==='y'){ ev.preventDefault(); redo(); return; }
  if((ev.ctrlKey||ev.metaKey)&&ev.key.toLowerCase()==='d'){ ev.preventDefault(); dupSel(); return; }
  if(s.tool==='pickVia'&&(ev.key==='Backspace'||ev.key==='Delete')){ ev.preventDefault(); undoVia(); return; }
  if(ev.key==='Escape'&&s.tool==='pickVia'){ finishLeg(); return; }
  if(ev.key==='Escape'){ if(s.dialog){s.dialog=null;return;} if(chain){chain=null;updatePreview(null);return;} if(s.tool!=='select'){setTool('select');return;} s.sel=null; return; }
  if(ev.key==='Delete'||ev.key==='Backspace'){ if(s.sel){ ev.preventDefault(); deleteSel(); } return; }
  if(ev.key==='r'||ev.key==='R'){ rotateSel(); }
  if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(ev.key)){ const o=selObjRaw(); if(!o||locked.value) return; ev.preventDefault(); pushHistory(); const st=ev.shiftKey?0.1:0.5;
    if(ev.key==='ArrowLeft') o.x=r2(o.x-st); if(ev.key==='ArrowRight') o.x=r2(o.x+st); if(ev.key==='ArrowUp') o.z=r2(o.z-st); if(ev.key==='ArrowDown') o.z=r2(o.z+st); }
  if(ev.key===' '&&!ev.repeat&&tag!=='button'){ ev.preventDefault(); togglePlay(); }
});

/* ---------- edit actions ---------- */
function select(kind,id){ if(s.legEdit&&!(kind==='route'&&id===s.legEdit.routeId)) finishLeg(); s.sel={kind,id}; if(kind!=='route'&&s.tool==='pickStop') s.tool='select'; }
function setTool(t){ if(t!=='pickVia'&&s.legEdit){ s.legEdit=null; scheduleRebuild(); } s.tool=t; chain=null; updatePreview(null); applyControlButtons(); buildHandles(); }
function setMode(m){ s.legEdit=null; s.mode=m; s.sel=null; chain=null; updatePreview(null);
  s.tool='select'; applyControlButtons(); scheduleRebuild(); if(m==='analysis') nextTick(drawGantt); }
function rotateSel(){ const o=selObjRaw(); if(!o||locked.value) return; pushHistory(); o.rot=((o.rot||0)+90)%360; }
function dupSel(){ if(locked.value) return; const o=selObjRaw(); if(!o) return; pushHistory(); const c={...clone(o),id:uid('o'),x:o.x+1,z:o.z+1}; s.sc.objects.push(c); s.sel={kind:'obj',id:c.id}; }
function deleteSel(){ const x=s.sel; if(!x||locked.value) return; pushHistory(); const sc=s.sc;
  if(x.kind==='obj') sc.objects=sc.objects.filter(o=>o.id!==x.id);
  else if(x.kind==='node'){ const gone=new Set(sc.stations.filter(st=>st.node===x.id).map(st=>st.id)); sc.edges=sc.edges.filter(e=>e.a!==x.id&&e.b!==x.id); sc.nodes=sc.nodes.filter(n=>n.id!==x.id); sc.stations=sc.stations.filter(st=>!gone.has(st.id)); sc.routes.forEach(r=>r.stops=r.stops.filter(id=>!gone.has(id))); }
  else if(x.kind==='edge') sc.edges=sc.edges.filter(e=>e.id!==x.id);
  else if(x.kind==='station'){ sc.stations=sc.stations.filter(st=>st.id!==x.id); sc.routes.forEach(r=>r.stops=r.stops.filter(id=>id!==x.id)); }
  else if(x.kind==='route') sc.routes=sc.routes.filter(r=>r.id!==x.id);
  else if(x.kind==='vtype'){ if(sc.routes.some(r=>r.vtype===x.id)){ toast('有路线在使用该车型，请先为路线更换车型'); undoStack.pop(); s.undoN=undoStack.length; return; } sc.vtypes=sc.vtypes.filter(v=>v.id!==x.id); }
  s.sel=null; }
function reverseEdge(){ const e=selEdgeRaw(); if(!e) return; pushHistory(); const a=e.a; e.a=e.b; e.b=a; }
function splitSelEdge(){ const e=selEdgeRaw(); if(!e) return; const N=nodeMap(),a=N.get(e.a),b=N.get(e.b); pushHistory(); const id=splitEdge(e,snap((a.x+b.x)/2,0.1),snap((a.z+b.z)/2,0.1)); s.sel={kind:'node',id}; }
function selEdgeRaw(){ return s.sel&&s.sel.kind==='edge'?s.sc.edges.find(e=>e.id===s.sel.id):null; }
function makeStation(nodeId,noPush){ if(s.sc.stations.some(st=>st.node===nodeId)){ toast('该节点已经是站点'); return; } if(!noPush) pushHistory();
  const k=s.sc.stations.length+1; const st={id:uid('s'),name:`站点 ${k}`,node:nodeId,type:'drop',dwellMode:'fixed',d1:60,d2:0,note:''}; s.sc.stations.push(st); s.mode='stations'; s.sel={kind:'station',id:st.id}; }
function addRoute(){ pushHistory(); const vt=s.sc.vtypes[0]; const r={id:uid('r'),name:`路线 ${s.sc.routes.length+1}`,color:['#2f6fb0','#d48a00','#2b8a57','#7b55b8','#c23d2b','#3a8f8a'][s.sc.routes.length%6],vtype:vt?vt.id:'',count:1,period:0,gap:60,stops:[]}; s.sc.routes.push(r); s.sel={kind:'route',id:r.id}; }
function addVtype(){ pushHistory(); const v={id:uid('vt'),name:'新车型',kind:'agv',length:1.2,width:0.8,height:0.35,vmax:1.0,acc:0.5,carts:0,cartLen:1.2,runtimeH:6,chargeH:1.5,lowPct:25,color:'#3a8f8a'}; s.sc.vtypes.push(v); s.sel={kind:'vtype',id:v.id}; }
function addStop(id){ const r=s.sel&&s.sel.kind==='route'&&s.sc.routes.find(x=>x.id===s.sel.id); if(!r||!id) return; const st=s.sc.stations.find(x=>x.id===id); if(st&&st.type==='charge'){ toast('充电点无需加入路线，低电量车辆会自动前往'); return; }
  if(r.stops[r.stops.length-1]===id){ toast('与上一站相同'); return; } pushHistory(); r.stops.push(id); }
function moveStop(i,d){ const r=selRouteRaw(); if(!r) return; if(s.legEdit) finishLeg(); const j=i+d; if(j<0||j>=r.stops.length) return; pushHistory(); const t=r.stops[i]; r.stops[i]=r.stops[j]; r.stops[j]=t; }
function removeStop(i){ const r=selRouteRaw(); if(!r) return; if(s.legEdit) finishLeg(); pushHistory(); r.stops.splice(i,1); }
function selRouteRaw(){ return s.sel&&s.sel.kind==='route'?s.sc.routes.find(x=>x.id===s.sel.id):null; }
function clearNet(){ pushHistory(); s.sc.nodes=[]; s.sc.edges=[]; s.sc.stations=[]; s.sc.routes.forEach(r=>r.stops=[]); s.sel=null; s.dialog=null; }
function loadBg(ev){ const f=ev.target.files&&ev.target.files[0]; ev.target.value=''; if(!f) return;
  const rd=new FileReader(); rd.onload=()=>{ const img=new Image(); img.onload=()=>{
    let data=rd.result; const maxPx=2400; if(img.width>maxPx||img.height>maxPx){ const k=maxPx/Math.max(img.width,img.height); const cv=document.createElement('canvas'); cv.width=Math.round(img.width*k); cv.height=Math.round(img.height*k); cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height); data=cv.toDataURL('image/jpeg',0.82); }
    pushHistory(); s.sc.bg={data,aspect:img.height/img.width,width:s.sc.layout.w,x:0,z:0,opacity:0.6}; toast('底图已导入，请输入图片对应的实际宽度（m）对齐比例'); };
    img.src=rd.result; }; rd.readAsDataURL(f); }
function clearBg(){ pushHistory(); s.sc.bg=null; }
function runValidate(){ s.validation=validateScenario(clone(toRaw(s.sc))); s.dialog='validate'; }

/* ---------- scenarios ---------- */
async function api(action,{id,params,body,timeout=20000}={}){
  const q=new URLSearchParams({action}); if(id) q.set('id',id); if(params) for(const k in params) q.set(k,params[k]);
  const ctl=new AbortController(); const tm=setTimeout(()=>ctl.abort(),timeout); const post=body!==undefined;
  try{
    const r=await fetch(API_URL+'?'+q.toString(),{method:post?'POST':'GET',cache:'no-store',credentials:'same-origin',signal:ctl.signal,
      headers:post?{'Content-Type':'application/json; charset=utf-8','X-LogiSim-Client':APP_VERSION}:{},body:post?body:undefined});
    let j=null; try{ j=await r.json(); }catch(e){}
    if(!r.ok||!j||j.ok===false){ const err=new Error((j&&j.error)||`服务器返回 ${r.status}`); err.status=r.status; err.body=j; throw err; }
    return j;
  }catch(e){ if(e.name==='AbortError'){ const err=new Error('连接服务器超时'); err.status=0; throw err; } throw e; }
  finally{ clearTimeout(tm); }
}
function normalizeScenario(d){ d=d||{}; d.name=String(d.name||'未命名方案'); d.layout=d.layout||{w:40,d:24}; d.bg=d.bg||null;
  for(const k of ['objects','nodes','edges','stations','routes']) if(!Array.isArray(d[k])) d[k]=[];
  if(!Array.isArray(d.vtypes)||!d.vtypes.length) d.vtypes=sampleScenario().vtypes; d.sim=d.sim||{duration:28800,seed:1}; return d; }
function persistLocal(){ if(Store.mode!=='local') return;
  const o={currentId:s.currentId,list:DB.list.map(x=>({id:x.id,name:x.name,data:x.data})),results:DB.results};
  if(!lsSet(LS_KEY,JSON.stringify(o))&&!quotaWarned){ quotaWarned=true; toast('浏览器存储空间不足，方案未能自动保存。底图过大时请压缩图片，或用「导入 / 导出」备份。'); } }
function syncScenarioList(){ s.scenarios=DB.list.map(x=>({id:x.id,name:x.name})); s.resultsRev++; }
function initLocal(){ let d=lsGet();
  if(!d||!Array.isArray(d.list)||!d.list.length){ const sc=sampleScenario(); d={currentId:'sc1',list:[{id:'sc1',name:sc.name,data:sc}],results:{}}; }
  DB={list:d.list.map(x=>({id:x.id,name:x.name,data:x.data,rev:0})),results:d.results||{}}; if(d.currentId) lsSet(CUR_KEY,d.currentId); syncScenarioList(); }
async function refreshList(){
  const j=await api('list'); const old=new Map(DB.list.map(x=>[x.id,x]));
  DB.list=j.items.map(i=>{ const o=old.get(i.id); const keep=o&&i.id===s.currentId;
    return {id:i.id,name:keep?o.name:i.name,rev:keep?o.rev:i.rev,serverRev:i.rev,updated:i.updated,updatedBy:i.updatedBy,data:o&&o.rev===i.rev?o.data:null}; });
  DB.results={}; for(const i of j.items) if(i.result) DB.results[i.id]=i.result;
  syncScenarioList(); Store.lastRefresh=Date.now(); return j.items; }
async function boot(){
  let h=null, why='';
  if(/^https?:$/.test(location.protocol)){ try{ h=await api('health',{timeout:4000}); }catch(e){ if(e.status&&e.status!==404) why=e.message; } }
  if(h){ Store.mode='server'; Object.assign(s.store,{mode:'server',storage:h.storage||'File',user:h.user||''});
    try{ await refreshList(); if(!DB.list.length){ const sc=sampleScenario(); const id=newId(); await api('save',{id,params:{rev:-1,name:sc.name},body:JSON.stringify(sc)}); await refreshList(); } }
    catch(e){ Store.mode='local'; why=e.message; } }
  if(Store.mode==='local'){ s.store.mode='local'; initLocal(); if(why) toast(`服务器存储不可用（${why}），已改用本机浏览器存储`); }
  let id=null; try{ id=localStorage.getItem(CUR_KEY); }catch(e){}
  if(!DB.list.some(x=>x.id===id)) id=DB.list[0].id;
  await loadScenario(id); s.store.status='saved'; s.store.ready=true;
}
async function loadScenario(id){
  const e=DB.list.find(x=>x.id===id); if(!e) return false; let data=e.data;
  if(Store.mode==='server'){ try{ const j=await api('get',{id}); data=j.data; Object.assign(e,{rev:j.rev,serverRev:j.rev,name:j.name,updated:j.updated,updatedBy:j.updatedBy,data}); if(j.result) DB.results[id]=j.result; }
    catch(err){ toast('读取方案失败：'+err.message); return false; } }
  if(!data) return false;
  data=normalizeScenario(clone(data)); data.name=e.name||data.name;
  clearTimeout(Store.timer); s.currentId=id; s.sc=data; Store.lastSaved[id]=JSON.stringify(data);
  undoStack.length=0; redoStack.length=0; s.undoN=0; s.redoN=0; s.sel=null; s.kpi=null; s.store.status='saved';
  lsSet(CUR_KEY,id); persistLocal(); syncScenarioList();
  nextTick(()=>{ setOrthoFrustum(); fitView(); }); return true; }
function scheduleSave(){ if(!s.store.ready) return; if(s.store.status!=='error') s.store.status='pending'; clearTimeout(Store.timer); Store.timer=setTimeout(saveNow,Store.mode==='server'?1200:500); }
async function saveNow(){
  clearTimeout(Store.timer); if(!s.store.ready) return;
  const id=s.currentId, e=DB.list.find(x=>x.id===id); if(!e) return;
  const json=JSON.stringify(toRaw(s.sc));
  if(Store.lastSaved[id]===json){ if(s.store.status!=='error') s.store.status='saved'; return; }
  if(Store.mode==='local'){ e.data=JSON.parse(json); e.name=s.sc.name; Store.lastSaved[id]=json; persistLocal(); syncScenarioList(); s.store.status='saved'; return; }
  if(Store.saving){ Store.again=true; return Store.saving; }
  s.store.status='saving';
  Store.saving=(async()=>{
    try{ const j=await api('save',{id,params:{rev:e.rev??-1,name:s.sc.name},body:json});
      Object.assign(e,{rev:j.rev,serverRev:j.rev,updated:j.updated,updatedBy:j.updatedBy,name:JSON.parse(json).name,data:null}); Store.lastSaved[id]=json; syncScenarioList(); s.store.status='saved'; s.store.error=''; }
    catch(err){
      if(err.status===409) await saveConflictCopy(json,err.body);
      else { s.store.status='error'; s.store.error=err.message; toast(`保存到服务器失败：${err.message}。修改仍在页面中，15 秒后自动重试。`); clearTimeout(Store.timer); Store.timer=setTimeout(saveNow,15000); } }
    finally{ Store.saving=null; if(Store.again){ Store.again=false; saveNow(); } }
  })();
  return Store.saving; }
async function saveConflictCopy(json,info){
  const d=JSON.parse(json), orig=d.name, by=(info&&info.updatedBy)||'其他人';
  d.name=`${orig}（我的修改 ${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}）`;
  delete Store.lastSaved[s.currentId];
  const nid=await createScenario(d,true);
  if(nid) toast(`「${orig}」已被 ${by} 修改。你的修改已另存为「${d.name}」，原方案保留对方的版本。`); }
async function createScenario(data,silent){
  data=normalizeScenario(data); const id=newId();
  if(Store.mode==='server'){ try{ const j=await api('save',{id,params:{rev:-1,name:data.name},body:JSON.stringify(data)});
      DB.list.unshift({id,name:data.name,rev:j.rev,serverRev:j.rev,data,updated:j.updated,updatedBy:j.updatedBy}); }
    catch(err){ toast('在服务器上创建方案失败：'+err.message); return null; } }
  else DB.list.push({id,name:data.name,data,rev:0});
  syncScenarioList(); await loadScenario(id); return id; }
async function switchScenario(id){ if(locked.value||id===s.currentId) return; await saveNow(); await loadScenario(id); }
async function newScenario(){ await saveNow(); if(await createScenario(blankScenario(`新方案 ${DB.list.length+1}`))){ s.mode='layout'; toast('已新建空白方案：先在「车间场地」设置尺寸并摆放设施'); } }
async function dupScenario(){ await saveNow(); const d=clone(toRaw(s.sc)); d.name=s.sc.name+' 副本'; if(await createScenario(d)) toast('已复制为新方案，可修改后对比结果'); }
function doRename(){ const n=s.renameText.trim(); if(!n) return; s.sc.name=n; s.dialog=null; saveNow(); }
async function doDelete(){ const id=s.currentId, e=DB.list.find(x=>x.id===id); s.dialog=null;
  if(Store.mode==='server'){ try{ await api('delete',{id,params:{rev:e?e.rev:-1},body:'{}'}); }catch(err){ toast('删除失败：'+err.message); return; } }
  clearTimeout(Store.timer); DB.list=DB.list.filter(x=>x.id!==id); delete DB.results[id]; delete Store.lastSaved[id]; syncScenarioList();
  if(!DB.list.length){ await createScenario(sampleScenario()); return; }
  persistLocal(); await loadScenario(DB.list[0].id); }
async function importScenario(text){ let d; try{ d=JSON.parse(text); if(!d||!Array.isArray(d.nodes)||!Array.isArray(d.objects)||!d.layout) throw new Error('格式不对'); }
  catch(e){ toast('导入失败：不是有效的方案 JSON。请确认复制完整。'); return; }
  await saveNow(); if(await createScenario(d)){ s.importText=''; s.dialog=null; toast(`已导入「${d.name||'导入方案'}」`); } }
function importFile(ev){ const f=ev.target.files&&ev.target.files[0]; ev.target.value=''; if(!f) return; const rd=new FileReader(); rd.onload=()=>importScenario(rd.result); rd.readAsText(f,'utf-8'); }
async function restoreSample(){ await saveNow(); if(await createScenario(sampleScenario())){ s.dialog=null; toast('已新增示例车间方案'); } }
function downloadExport(){ const blob=new Blob([JSON.stringify(toRaw(s.sc),null,1)],{type:'application/json'}); const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=(s.sc.name||'方案').replace(/[\\/:*?"<>|]/g,'_')+'.json'; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },1500); }
function localCount(){ const d=lsGet(); return d&&Array.isArray(d.list)?d.list.length:0; }
async function uploadLocal(){ const d=lsGet(); if(!d||!Array.isArray(d.list)) return; let n=0;
  for(const x of d.list){ try{ const data=normalizeScenario(clone(x.data)); data.name=(x.name||data.name)+'（本机上传）'; await api('save',{id:newId(),params:{rev:-1,name:data.name},body:JSON.stringify(data)}); n++; }catch(e){ toast(`上传「${x.name}」失败：${e.message}`); } }
  await refreshList(); toast(`已上传 ${n} 个方案到服务器`); }
async function refreshFromServer(){
  if(Store.mode!=='server'||!s.store.ready||Date.now()-Store.lastRefresh<5000) return;
  try{ await refreshList(); const e=DB.list.find(x=>x.id===s.currentId);
    if(!e){ toast('当前方案已被其他人删除。页面中的内容仍保留，可点「复制方案」另存。'); return; }
    const clean=Store.lastSaved[s.currentId]===JSON.stringify(toRaw(s.sc));
    if(e.serverRev!==e.rev && clean && !locked.value && !Store.saving){ await loadScenario(s.currentId); toast(`已载入 ${e.updatedBy||'其他人'} 的最新修改`); } }
  catch(e){} }
async function copyExport(){ const ta=document.getElementById('expTxt'); try{ await navigator.clipboard.writeText(ta.value); toast('已复制方案 JSON'); }catch(e){ ta.focus(); ta.select(); toast('已选中全部文本，请按 Ctrl+C 复制'); } }
function openDialog(d){ if(d==='rename') s.renameText=s.sc.name; s.dialog=d; }

/* ---------- simulation control ---------- */
function startSim(){
  const sc=clone(toRaw(s.sc)); SIM=createSim(sc,{seed:s.sc.sim.seed,duration:s.sc.sim.duration}); simAcc=0;
  if(SIM.problems.length) toast(SIM.problems[0]);
  if(!SIM.vehicles.length){ SIM=null; if(!SIM) toast(s.sc.routes.length?'没有可运行的车辆：请检查路线的车型、车辆数和停靠站点':'请先在「4 车辆与路线」中新建路线并设置停靠站点'); return false; }
  s.sim.status='paused'; s.sim.t=0; s.sel=null; chain=null; updatePreview(null); refreshKPI(); return true;
}
function togglePlay(){ if(s.fast) return; if(s.sim.status==='idle'){ if(!startSim()) return; if(s.mode!=='analysis') setMode('analysis'); }
  if(s.sim.status==='running') s.sim.status='paused'; else if(s.sim.status==='paused') { s.sim.status='running'; T.clock.getDelta(); } }
function stepOnce(){ if(s.sim.status==='idle'&&!startSim()) return; for(let i=0;i<100&&!SIM.done;i++) SIM.step(SIM_DT); if(SIM.done) finishSim(); refreshKPI(); }
function fastRun(){ if(s.sim.status==='idle'){ if(!startSim()) return; if(s.mode!=='analysis') setMode('analysis'); } s.fast=true; s.sim.status='paused';
  const chunk=()=>{ if(!SIM){s.fast=false;return;} const t0=performance.now(); while(!SIM.done&&performance.now()-t0<40) for(let i=0;i<200&&!SIM.done;i++) SIM.step(SIM_DT);
    s.sim.t=SIM.t; if(SIM.done){ s.fast=false; finishSim(); } else setTimeout(chunk,0); }; chunk(); }
function finishSim(){ if(s.sim.status==='done') return; s.sim.status='done'; refreshKPI(); const k=s.kpi;
  const r={name:s.sc.name,t:k.t,util:k.util,deliveries:k.deliveries,ontime:k.ontime,waitShare:k.waitShare,overrides:k.overrides,at:Date.now()};
  DB.results[s.currentId]=r; s.resultsRev++;
  if(Store.mode==='server') api('result',{id:s.currentId,body:JSON.stringify(r)}).catch(e=>toast('仿真结果未能保存到服务器：'+e.message)); else persistLocal();
  toast(`仿真完成：平均利用率 ${pct(k.util)}，送料 ${k.deliveries} 次`); }
function resetSim(){ SIM=null; s.sim.status='idle'; s.sim.t=0; s.fast=false; s.selVeh=null; s.follow=false; s.kpi=null; syncVehicles(); scheduleRebuild(); }
function refreshKPI(){ if(!SIM) return; s.sim.t=SIM.t; s.kpi=computeKPI(SIM,toRaw(s.sc)); if(s.mode==='analysis'&&s.atab==='overview') nextTick(drawGantt); if(s.heat&&s.mode==='analysis') buildNet(); }
function pickVeh(id){ s.selVeh=id; if(s.mode!=='analysis') setMode('analysis'); }

function drawGantt(){
  const cv=app&&app.$refs&&app.$refs.gantt; if(!cv||!SIM) return; const vs=SIM.vehicles; const dpr=Math.min(window.devicePixelRatio||1,2);
  const W=cv.clientWidth||380, rowH=16, top=18, H=top+vs.length*rowH+4; cv.style.height=H+'px'; cv.width=W*dpr; cv.height=H*dpr;
  const c=cv.getContext('2d'); c.setTransform(dpr,0,0,dpr,0,0); c.clearRect(0,0,W,H);
  const lx=56, span=Math.max(SIM.duration,1), X=t=>lx+(W-lx-6)*t/span; const muted=cssVar('--muted'), line=cssVar('--line');
  c.font='11px "JetBrains Mono", monospace'; c.fillStyle=muted; c.strokeStyle=line; c.lineWidth=1;
  const stepH=span>14400?7200:span>7200?3600:1800;
  for(let t=0;t<=span+1;t+=stepH){ const x=Math.round(X(t))+0.5; c.beginPath(); c.moveTo(x,top-3); c.lineTo(x,H); c.stroke(); c.textAlign=t===0?'left':'center'; c.fillText(`${Math.round(t/3600*10)/10}h`,x,11); }
  const col={}; for(const k of STATE_KEYS) col[k]=cssVar(STATE[k].v);
  vs.forEach((v,i)=>{ const y=top+i*rowH; c.fillStyle=s.selVeh===v.id?cssVar('--ink'):muted; c.textAlign='left'; c.fillText(v.id,0,y+11);
    const sg=v.segs; for(let j=0;j<sg.length;j++){ const t0=sg[j].t, t1=j+1<sg.length?sg[j+1].t:SIM.t; if(t1<=t0) continue; c.fillStyle=col[sg[j].s]; const x0=X(t0), x1=X(t1); c.fillRect(x0,y+3,Math.max(0.6,x1-x0),rowH-6); } });
  const xn=Math.round(X(SIM.t))+0.5; c.strokeStyle=cssVar('--ink'); c.beginPath(); c.moveTo(xn,top-3); c.lineTo(xn,H); c.stroke();
}

/* ---------- helpers for template ---------- */
function dwellText(st){ if(!st) return ''; if(st.type==='charge') return '充电'; if(st.dwellMode==='uniform') return `${st.d1}–${st.d2} s`; if(st.dwellMode==='normal') return `μ${st.d1} σ${st.d2} s`; return `${st.d1} s`; }
function stateColor(k){ return `var(${STATE[k].v})`; }

/* ---------- Vue ---------- */
let app=null;
const vueApp=createApp({
  setup(){
    const selObj=computed(()=>s.sel&&s.sel.kind==='obj'?s.sc.objects.find(o=>o.id===s.sel.id):null);
    const selNode=computed(()=>s.sel&&s.sel.kind==='node'?s.sc.nodes.find(o=>o.id===s.sel.id):null);
    const selEdge=computed(()=>s.sel&&s.sel.kind==='edge'?s.sc.edges.find(o=>o.id===s.sel.id):null);
    const selStation=computed(()=>s.sel&&s.sel.kind==='station'?s.sc.stations.find(o=>o.id===s.sel.id):null);
    const selRoute=computed(()=>s.sel&&s.sel.kind==='route'?s.sc.routes.find(o=>o.id===s.sel.id):null);
    const selVtype=computed(()=>s.sel&&s.sel.kind==='vtype'?s.sc.vtypes.find(o=>o.id===s.sel.id):null);
    const selVeh=computed(()=>s.kpi&&s.selVeh?s.kpi.vehicles.find(v=>v.id===s.selVeh):null);
    const netLength=computed(()=>{const N=new Map(s.sc.nodes.map(n=>[n.id,n]));return s.sc.edges.reduce((a,e)=>{const p=N.get(e.a),q=N.get(e.b);return a+(p&&q?Math.hypot(p.x-q.x,p.z-q.z):0);},0);});
    const currentName=computed(()=>s.sc.name);
    const storeLabel=computed(()=>s.store.mode==='server'?(s.store.storage==='SqlServer'?'服务器 · SQL Server':'服务器 · 文件存储'):(s.store.ready?'本机浏览器':'连接中…'));
    const storeTitle=computed(()=>s.store.mode==='server'?`方案保存在服务器，所有人共享。当前用户：${s.store.user||'—'}`:'方案只保存在这台电脑的浏览器中，换电脑或清理浏览器数据会丢失，请定期导出备份。');
    const saveLabel=computed(()=>({connecting:'',saved:'已保存',pending:'待保存',saving:'保存中…',error:'保存失败'})[s.store.status]||'');
    const exportText=computed(()=>s.dialog==='io'?JSON.stringify(toRaw(s.sc)):'');
    const compareRows=computed(()=>{ s.resultsRev; return DB.list.filter(x=>DB.results[x.id]).map(x=>({id:x.id,name:x.name,...DB.results[x.id]})); });
    const routeEst=computed(()=>{ const r=selRoute.value; if(!r) return null; const sc=JSON.parse(JSON.stringify(s.sc.nodes&&{nodes:s.sc.nodes,edges:s.sc.edges}));
      const vt=s.sc.vtypes.find(v=>v.id===r.vtype); const st=new Map(s.sc.stations.map(x=>[x.id,x])); const stops=r.stops.filter(id=>st.has(id));
      if(!vt) return {err:'请选择车型'}; if(stops.length<2) return {err:'至少需要 2 个停靠站点才能形成闭环'};
      const g=buildGraph(sc); let len=0,drive=0;
      for(let i=0;i<stops.length;i++){ const A=st.get(stops[i]),B=st.get(stops[(i+1)%stops.length]); const p=routeLegPath(g,r,A,B,vt.vmax);
        if(!p) return {err:`「${A.name}」→「${B.name}」没有可达路径，请检查路段方向${legVia(r,A.id,B.id).length?'或指定的途经点':''}`}; for(const x of p){len+=x.len;drive+=x.len/Math.min(vt.vmax,x.limit);} }
      const dwell=stops.reduce((a,id)=>a+dwellMean(st.get(id)),0); return {len,drive,dwell,cycle:drive+dwell}; });
    const legInfos=computed(()=>{ const r=selRoute.value; if(!r||r.stops.length<2) return [];
      const g=buildGraph(s.sc), vt=s.sc.vtypes.find(v=>v.id===r.vtype), st=new Map(s.sc.stations.map(x=>[x.id,x])), n=r.stops.length;
      return r.stops.map((sid,i)=>{ const to=r.stops[(i+1)%n], key=legKey(sid,to), via=legVia(r,sid,to).length, A=st.get(sid), B=st.get(to), ret=i===n-1;
        if(!A||!B) return {key,via,ret,err:true,label:'站点已删除'};
        const p=routeLegPath(g,r,A,B,vt?vt.vmax:1); const len=p?p.reduce((a,x)=>a+x.len,0):0;
        return {key,via,ret,err:!p,label:!p?(via?'按途经点走不通，请调整':'不可达，检查路段方向'):(via?`指定路径 · 途经 ${via} 点 · ${len.toFixed(0)} m`:`自动最短路径 · ${len.toFixed(0)} m`)}; }); });
    const legEditName=computed(()=>{ const le=s.legEdit; if(!le) return ''; const A=s.sc.stations.find(x=>x.id===le.from), B=s.sc.stations.find(x=>x.id===le.to); return `${A?A.name:'?'} → ${B?B.name:'?'}`; });
    const hint=computed(()=>{ const t=s.tool, nav=s.view==='top'?'右键拖动平移 · 滚轮缩放':'右键拖动旋转 · Shift+右键平移 · 滚轮缩放';
      if(locked.value) return '点击车辆查看状态 · '+nav;
      if(t==='orbit') return (s.view==='top'?'左键拖动平移':'左键拖动旋转')+' · 滚轮缩放';
      if(t.startsWith('place:')) return `点击放置「${OBJ_TYPES[t.slice(6)].label}」，或按住拖出尺寸 · 可连续放置 · Esc 退出`;
      if(t==='draw') return '依次点击生成路径，自动吸附节点与路段 · 右键或 Esc 结束本段 · 按住 Shift 取消角度吸附';
      if(t==='station') return '点击节点设为站点，点在路段上会自动插入节点 · '+nav;
      if(t==='pickStop') return '依次点击站点追加到路线停靠顺序 · Esc 完成';
      if(t==='pickVia') return '依次点击要经过的路网节点（圆点），相邻两点之间自动连通 · Backspace 撤销上一点 · Esc 完成';
      if(s.mode==='layout') return s.sel&&s.sel.kind==='obj'?'拖拽移动 · 拖方块拉伸（Alt 对称）· 拖圆点旋转 · 拖箭头调高 · 方向键微移':'点击选择设施，拖拽移动 · '+nav;
      if(s.mode==='network') return '点击选择节点或路段，拖拽节点调整位置 · '+nav;
      if(s.mode==='analysis') return '点击车辆查看实时状态 · '+nav;
      return '点击选择 · '+nav; });
    const isSel=(k,id)=>s.sel&&s.sel.kind===k&&s.sel.id===id;
    const nodeById=id=>s.sc.nodes.find(n=>n.id===id);
    const stationById=id=>s.sc.stations.find(x=>x.id===id);
    const stationAt=nid=>s.sc.stations.find(x=>x.node===nid);
    const nodeDegree=nid=>s.sc.edges.filter(e=>e.a===nid||e.b===nid).length;
    const edgeLen=e=>{const a=nodeById(e.a),b=nodeById(e.b);return a&&b?Math.hypot(a.x-b.x,a.z-b.z):0;};
    const routesUsing=sid=>s.sc.routes.filter(r=>r.stops.includes(sid)).map(r=>r.name).join('、');
    const fmtXZ=n=>n?`(${n.x}, ${n.z})`:'—';
    const stateTitle=v=>STATE_KEYS.map(k=>`${STATE[k].l} ${pct(v.pct[k])}`).join(' · ');
    return {s,locked,MODES,OBJ_TYPES,ZONE_KINDS,STATION_TYPES,VKINDS,STATE,STATE_KEYS,SPEEDS,ATABS,EVT,
      APP_VERSION,storeLabel,storeTitle,saveLabel,localCount,uploadLocal,downloadExport,
      selObj,selNode,selEdge,selStation,selRoute,selVtype,selVeh,netLength,currentName,exportText,compareRows,routeEst,hint,
      isSel,nodeById,stationById,stationAt,nodeDegree,edgeLen,routesUsing,fmtXZ,stateTitle,fmtT,fmtMS,pct,dwellText,stateColor,
      legInfos,legEditName,editLeg,finishLeg,clearLeg,undoVia,tidyNetwork,
      pushHistory,undo,redo,setView,fitView,setMode,setTool,select,rotateSel,dupSel,deleteSel,reverseEdge,splitSelEdge,makeStation,addRoute,addVtype,addStop,moveStop,removeStop,
      clearNet,loadBg,clearBg,runValidate,switchScenario,newScenario,dupScenario,doRename,doDelete,importScenario,importFile,restoreSample,copyExport,openDialog,
      togglePlay,stepOnce,fastRun,resetSim,pickVeh};
  },
  mounted(){ app=this; initThree(this.$refs.vp); }
});
vueApp.mount('#app');
const bootEl=document.getElementById('boot'); if(bootEl) bootEl.remove();
boot().catch(e=>{ toast('启动失败：'+e.message); });

watch(()=>s.sc,()=>{ if(suppress) return; scheduleRebuild(); scheduleSave(); },{deep:true});
watch(()=>[s.sel,s.labels,s.heat],()=>scheduleRebuild(),{deep:true});
watch(()=>[s.sc.layout.w,s.sc.layout.d],()=>{ if(T.renderer) setOrthoFrustum(); });
watch(()=>s.mode,m=>{ document.getElementById('app').className='app mode-'+m; nextTick(resize); });
watch(()=>s.sim.status,()=>buildHandles());
watch(()=>s.atab,()=>{ if(s.atab==='overview') nextTick(drawGantt); });
watch(()=>s.selVeh,()=>nextTick(drawGantt));
const themeChanged=()=>{ if(!T.renderer) return; disposeGroup(T.groups.veh); matCache.forEach(m=>m.dispose()); matCache.clear(); T.vehMeshes.clear(); scheduleRebuild(); nextTick(drawGantt); };
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',themeChanged);
new MutationObserver(themeChanged).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
if(document.fonts&&document.fonts.ready) document.fonts.ready.then(()=>scheduleRebuild());
window.addEventListener('focus',refreshFromServer);
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') refreshFromServer(); });
window.addEventListener('beforeunload',ev=>{
  if(!s.store.ready) return; const json=JSON.stringify(toRaw(s.sc)); if(Store.lastSaved[s.currentId]===json) return;
  if(Store.mode==='local'){ saveNow(); return; }
  const e=DB.list.find(x=>x.id===s.currentId); let sent=false;
  if(json.length<60000){ try{ fetch(API_URL+'?'+new URLSearchParams({action:'save',id:s.currentId,rev:e?e.rev:-1,name:s.sc.name}),{method:'POST',keepalive:true,
    headers:{'Content-Type':'application/json; charset=utf-8','X-LogiSim-Client':APP_VERSION},body:json}); sent=true; }catch(err){} }
  if(!sent){ ev.preventDefault(); ev.returnValue=''; } });
