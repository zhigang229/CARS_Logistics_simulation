/* 场内物流 3D 仿真台 · 仿真内核（不依赖界面，可在浏览器与 Node.js 中运行） */
"use strict";
const OBJ_TYPES = {
  rack:   {label:'货架',     w:2.7, d:1.0, h:2.2,  color:'#2f68a8'},
  bench:  {label:'工位台',   w:2.0, d:1.0, h:0.9,  color:'#6f9478'},
  line:   {label:'装配线',   w:14,  d:1.6, h:0.95, color:'#7c8894'},
  buffer: {label:'线边料架', w:1.6, d:0.8, h:0.8,  color:'#c98b3a'},
  charger:{label:'充电桩',   w:0.6, d:0.4, h:1.3,  color:'#3aa66b'},
  wall:   {label:'墙体',     w:8,   d:0.24,h:3.5,  color:'#929ca6'},
  column: {label:'立柱',     w:0.6, d:0.6, h:6,    color:'#a7afb7'},
  zone:   {label:'功能区域', w:10,  d:6,   h:0,    color:'#3d7cc9'},
};
const ZONE_KINDS = ['仓库区','暂存区','产线区','充电区','禁行区','人车混行区','办公区'];
const STATION_TYPES = {
  pick:  {label:'取料点',   color:'#2f6fb0'},
  drop:  {label:'送料点',   color:'#2b8a57'},
  empty: {label:'空箱回收', color:'#c98b3a'},
  charge:{label:'充电点',   color:'#7b55b8'},
  park:  {label:'待命点',   color:'#8a949e'},
};
const VKINDS = {agv:'潜伏顶升 AGV', tug:'牵引车 + 料车', fork:'叉车式 AGV', cart:'人工小料车'};

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

function buildGraph(sc){
  const N = new Map(sc.nodes.map(n=>[n.id,n]));
  const adj = new Map(); for(const n of sc.nodes) adj.set(n.id,[]);
  const mk=(a,b,e,two)=>{const len=Math.hypot(b.x-a.x,b.z-a.z);return {from:a.id,to:b.id,key:a.id+'>'+b.id,edge:e,two,len,ax:a.x,az:a.z,bx:b.x,bz:b.z,ux:(b.x-a.x)/len,uz:(b.z-a.z)/len,limit:(e.limit>0?e.limit:Infinity)};};
  for(const e of sc.edges){
    const a=N.get(e.a), b=N.get(e.b); if(!a||!b) continue;
    if(Math.hypot(b.x-a.x,b.z-a.z)<0.05) continue;
    const two=e.dir==='both';
    adj.get(a.id).push(mk(a,b,e,two));
    if(two) adj.get(b.id).push(mk(b,a,e,two));
  }
  return {N,adj,cache:new Map()};
}
function shortestPath(g, from, to, vmax){
  if(from===to) return [];
  const ck=from+'|'+to+'|'+vmax; if(g.cache.has(ck)) return g.cache.get(ck);
  const dist=new Map([[from,0]]), prev=new Map(), done=new Set();
  const open=[from];
  while(open.length){
    let bi=0; for(let i=1;i<open.length;i++) if(dist.get(open[i])<dist.get(open[bi])) bi=i;
    const u=open.splice(bi,1)[0]; if(done.has(u)) continue; done.add(u);
    if(u===to) break;
    for(const arc of g.adj.get(u)||[]){
      const c=dist.get(u)+arc.len/Math.min(vmax,arc.limit);
      if(c<(dist.has(arc.to)?dist.get(arc.to):Infinity)){dist.set(arc.to,c);prev.set(arc.to,arc);open.push(arc.to);}
    }
  }
  let res=null;
  if(prev.has(to)){res=[];let n=to;while(n!==from){const a=prev.get(n);res.push(a);n=a.from;}res.reverse();}
  g.cache.set(ck,res); return res;
}
/* 路线分段：站点 A → 站点 B 的行驶路径。
   route.via["A>B"] 为用户指定的途经节点（按顺序），相邻两点之间取最短路径；未指定时整段取最短路径。 */
const legKey=(fromStationId,toStationId)=>fromStationId+'>'+toStationId;
function legVia(route,fromStationId,toStationId){ const v=route&&route.via&&route.via[legKey(fromStationId,toStationId)]; return Array.isArray(v)?v:[]; }
function routeLegPath(g,route,fromSt,toSt,vmax){
  const pts=[fromSt.node,...legVia(route,fromSt.id,toSt.id).filter(n=>g.N.has(n)),toSt.node], out=[];
  for(let i=0;i<pts.length-1;i++){ if(pts[i]===pts[i+1]) continue; const p=shortestPath(g,pts[i],pts[i+1],vmax); if(!p) return null; for(const a of p) out.push(a); }
  return out;
}

/* 路网整理：合并相近节点、节点落在路段上时拆分、交叉处生成路口、重叠路段合并（反向单向合并为双向）。
   返回新的 nodes/edges/stations/routes，不修改传入对象。 */
function normalizeNetwork(sc,opt={}){
  const tolMerge=opt.tolMerge??0.2, tolOn=opt.tolOn??0.15;
  let seq=0; const newId=opt.uid||(()=>'nx'+Date.now().toString(36)+(seq++).toString(36));
  let nodes=sc.nodes.map(n=>({...n})), edges=sc.edges.map(e=>({...e}));
  const stations=(sc.stations||[]).map(x=>({...x})), routes=(sc.routes||[]).map(r=>({...r,stops:[...(r.stops||[])],via:r.via?JSON.parse(JSON.stringify(r.via)):undefined}));
  const stats={nodes:0,splits:0,crossings:0,edges:0}, remap=new Map();
  const stNodes=new Set(stations.map(x=>x.node));
  // 1. 合并相近节点（优先保留带站点的节点）
  for(let i=0;i<nodes.length;i++){ let a=nodes[i]; if(remap.has(a.id)) continue;
    for(let j=i+1;j<nodes.length;j++){ const b=nodes[j]; if(remap.has(b.id)) continue;
      if(Math.hypot(a.x-b.x,a.z-b.z)<=tolMerge){ if(stNodes.has(b.id)&&!stNodes.has(a.id)){ remap.set(a.id,b.id); stats.nodes++; break; } remap.set(b.id,a.id); stats.nodes++; } } }
  const R=id=>{ let k=id; while(remap.has(k)) k=remap.get(k); return k; };
  if(remap.size){ nodes=nodes.filter(n=>!remap.has(n.id)); for(const e of edges){ e.a=R(e.a); e.b=R(e.b); } for(const st of stations) st.node=R(st.node); }
  edges=edges.filter(e=>e.a!==e.b);
  const split=(e,id)=>{ const b=e.b; e.b=id; edges.push({...e,id:newId('e'),a:id,b}); };
  const segInter=(a,b,c,d)=>{ const rx=b.x-a.x,rz=b.z-a.z,sx=d.x-c.x,sz=d.z-c.z,den=rx*sz-rz*sx; if(Math.abs(den)<1e-9) return null;
    const qx=c.x-a.x,qz=c.z-a.z,t=(qx*sz-qz*sx)/den,u=(qx*rz-qz*rx)/den, la=Math.hypot(rx,rz), lc=Math.hypot(sx,sz), ea=0.05/la, ec=0.05/lc;
    return (t>ea&&t<1-ea&&u>ec&&u<1-ec)?{x:a.x+rx*t,z:a.z+rz*t}:null; };
  // 2. 节点落在路段上 → 拆分；3. 路段交叉 → 生成路口
  let guard=0, changed=true;
  while(changed&&guard++<5000){ changed=false; const M=new Map(nodes.map(n=>[n.id,n]));
    scan: for(const e of edges){ const a=M.get(e.a),b=M.get(e.b),dx=b.x-a.x,dz=b.z-a.z,L2=dx*dx+dz*dz; if(L2<1e-6) continue; const L=Math.sqrt(L2);
      for(const n of nodes){ if(n.id===e.a||n.id===e.b) continue; const t=((n.x-a.x)*dx+(n.z-a.z)*dz)/L2; if(t*L<=tolOn||(1-t)*L<=tolOn) continue;
        if(Math.hypot(n.x-(a.x+dx*t),n.z-(a.z+dz*t))<=tolOn){ split(e,n.id); stats.splits++; changed=true; break scan; } } }
    if(changed) continue;
    cross: for(let i=0;i<edges.length;i++) for(let j=i+1;j<edges.length;j++){ const e=edges[i],f=edges[j];
      if(e.a===f.a||e.a===f.b||e.b===f.a||e.b===f.b) continue;
      const p=segInter(M.get(e.a),M.get(e.b),M.get(f.a),M.get(f.b)); if(!p) continue;
      const id=newId('n'); nodes.push({id,x:Math.round(p.x*100)/100,z:Math.round(p.z*100)/100}); split(e,id); split(f,id); stats.crossings++; changed=true; break cross; } }
  // 4. 重叠路段合并
  const byKey=new Map(), out=[];
  for(const e of edges){ if(e.a===e.b) continue; const k=e.a<e.b?e.a+'|'+e.b:e.b+'|'+e.a, o=byKey.get(k);
    if(!o){ byKey.set(k,e); out.push(e); continue; }
    stats.edges++; if(o.dir==='both'||e.dir==='both'||o.a!==e.a) o.dir='both';
    if(e.limit>0) o.limit=o.limit>0?Math.min(o.limit,e.limit):e.limit; }
  // 同一节点上的重复站点：保留第一个，路线改指向它
  const stByNode=new Map(), stRemap=new Map(), keptSt=[];
  for(const st of stations){ const k=stByNode.get(st.node); if(k){ stRemap.set(st.id,k.id); continue; } stByNode.set(st.node,st); keptSt.push(st); }
  for(const r of routes){ if(stRemap.size) r.stops=r.stops.map(id=>stRemap.get(id)||id).filter((id,i,arr)=>i===0||id!==arr[i-1]);
    if(r.via&&remap.size) for(const k in r.via) r.via[k]=r.via[k].map(R).filter((id,i,arr)=>i===0||id!==arr[i-1]); }
  const total=stats.nodes+stats.splits+stats.crossings+stats.edges;
  return {nodes,edges:out,stations:keptSt,routes,remap,stats,changed:total>0};
}
function vehLength(vt){ return (vt.length||1)+(vt.kind==='tug'?(vt.carts||0)*((vt.cartLen||1.2)+0.3):0); }
function dwellMean(st){ if(!st||st.type==='charge') return 0; return Math.max(0, st.d1||0) + (st.dwellMode==='uniform'?Math.max(0,(st.d2||0)-(st.d1||0))/2:0); }

const SIM_DT=0.1, LOOK=14, GAP=0.8, STOPBACK=0.8, VTURN=0.45, LANE_OFF=0.5;

function createSim(sc, opt){
  const g=buildGraph(sc), rng=mulberry32((opt.seed|0)||1);
  const stations=new Map(sc.stations.map(s=>[s.id,s]));
  const vts=new Map(sc.vtypes.map(v=>[v.id,v]));
  const holds=new Map();
  const sim={t:0,duration:opt.duration||28800,vehicles:[],events:[],problems:[],g,holds,occ:new Map(),
    stationStats:{},edgeWait:{},edgePass:{},routeStats:{},overrides:0,done:false};
  for(const s of sc.stations) sim.stationStats[s.id]={visits:0,waitT:0,dwellT:0,maxQ:0};
  const log=(type,msg)=>{sim.events.push({t:sim.t,type,msg});if(sim.events.length>1500)sim.events.splice(0,300);};
  const incomingArc=(node)=>{for(const arr of g.adj.values()) for(const a of arr) if(a.to===node) return a;
    const n=g.N.get(node);return {from:'_v',to:node,key:'_v>'+node,edge:{id:'_v'},two:false,len:2,ax:n.x-2,az:n.z,bx:n.x,bz:n.z,ux:1,uz:0,limit:Infinity};};
  const dwellTime=(st)=>{ if(st.dwellMode==='uniform'){const a=+st.d1||0,b=Math.max(a,+st.d2||0);return a+rng()*(b-a);}
    if(st.dwellMode==='normal'){let u=0,v=0;while(u===0)u=rng();while(v===0)v=rng();return Math.max(0,(+st.d1||0)+(+st.d2||0)*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v));}
    return Math.max(0,+st.d1||0); };

  sc.routes.forEach((r,ri)=>{
    const vt=vts.get(r.vtype); const stops=(r.stops||[]).filter(id=>stations.has(id));
    const count=Math.max(0,Math.floor(r.count||0));
    sim.routeStats[r.id]={id:r.id,name:r.name,color:r.color,count:0,laps:0,cycles:[],late:0,onTime:0,period:r.period>0?r.period:0};
    if(!count) return;
    if(!vt){sim.problems.push(`路线「${r.name}」未选择车型，已跳过`);return;}
    if(stops.length<2){sim.problems.push(`路线「${r.name}」停靠站点少于 2 个，已跳过`);return;}
    for(let i=0;i<stops.length;i++){
      const A=stations.get(stops[i]), B=stations.get(stops[(i+1)%stops.length]);
      if(!routeLegPath(g,r,A,B,vt.vmax)){sim.problems.push(`路线「${r.name}」：从「${A.name}」到「${B.name}」没有可达路径（检查路段方向${legVia(r,A.id,B.id).length?'或指定的途经点':''}），已跳过`);return;}
    }
    sim.routeStats[r.id].count=count;
    const L=vehLength(vt);
    const headway=r.period>0? r.period/count : Math.max(0,r.gap??60);
    const node0=stations.get(stops[0]).node;
    for(let i=0;i<count;i++){
      const inc=incomingArc(node0);
      sim.vehicles.push({id:`R${ri+1}-${i+1}`,route:r,rs:sim.routeStats[r.id],stops,vt,L,launchAt:i*headway,active:false,state:'idle',
        legs:[inc],li:0,s:inc.len,v:0,odo:0,hist:[],holds:[],k:0,target:null,dwellLeft:0,waitSched:false,schedAt:0,lapStartT:0,lapNo:0,
        battery:vt.runtimeH>0?100-(i%3)*22:100,waitRun:0,override:false,blocked:null,st:{idle:0,move:0,dwell:0,wait:0,charge:0},
        dist:0,charges:0,segs:[{s:'idle',t:0}],chargerWarned:false});
    }
  });

  const setState=(v,s)=>{ if(v.state===s) return; v.state=s; const last=v.segs[v.segs.length-1];
    if(Math.abs(last.t-sim.t)<1e-9){ last.s=s; const p=v.segs[v.segs.length-2]; if(p&&p.s===s) v.segs.pop(); } else v.segs.push({s,t:sim.t}); };
  const isFree=(v,n)=>{const h=holds.get(n);return h===undefined||h===v.id;};
  const holdsNode=(v,n)=>holds.get(n)===v.id;
  const hold=(v,n)=>{holds.set(n,v.id);if(!v.holds.some(h=>h.node===n&&h.rel===Infinity))v.holds.push({node:n,rel:Infinity});};
  const pushHist=(v,leg)=>{v.hist.push(leg);if(v.hist.length>8)v.hist.shift();};
  const curNode=(v)=>v.legs[v.li].to;
  const startPath=(v,toNode,given)=>{
    const from=curNode(v);
    const legs=given!==undefined?given:(from===toNode?[]:shortestPath(g,from,toNode,v.vt.vmax)); if(!legs) return null; if(!legs.length) return 'here';
    const h=v.holds.find(h=>h.node===from&&h.rel===Infinity); if(h) h.rel=v.odo+v.L+0.5;
    pushHist(v,v.legs[v.li]); v.legs=legs; v.li=0; v.s=0; return 'ok';
  };
  const beginDwell=(v)=>{ const st=stations.get(v.stops[v.k]); v.dwellLeft=dwellTime(st); sim.stationStats[st.id].visits++; setState(v,'dwell'); };
  const atHome=(v)=>{ const per=v.route.period>0?v.route.period:0;
    if(per>0){ v.schedAt=v.launchAt+v.lapNo*per;
      if(sim.t>v.schedAt+30){v.rs.late++;log('late',`${v.id} 晚于计划节拍 ${Math.round(sim.t-v.schedAt)} s 回到首站`);} else v.rs.onTime++;
      if(sim.t<v.schedAt-1e-6){ v.waitSched=true; setState(v,'idle'); return; } }
    beginDwell(v); };
  const findCharger=(v)=>{ let best=null,bl=Infinity; const from=curNode(v);
    for(const st of stations.values()){ if(st.type!=='charge') continue; const p=from===st.node?[]:shortestPath(g,from,st.node,v.vt.vmax); if(!p) continue;
      const back=shortestPath(g,st.node,stations.get(v.stops[0]).node,v.vt.vmax); if(!back&&st.node!==stations.get(v.stops[0]).node) continue;
      const l=p.reduce((a,b)=>a+b.len,0); if(l<bl){bl=l;best=st;} } return best; };
  const goCharge=(v)=>{ const st=findCharger(v);
    if(!st){ if(!v.chargerWarned){log('warn',`${v.id} 电量低但找不到可达的充电点`);v.chargerWarned=true;} v.lapStartT=sim.t; atHome(v); return; }
    v.target={kind:'charge',st:st.id}; log('charge',`${v.id} 电量 ${v.battery.toFixed(0)}%，前往「${st.name}」`);
    const r=startPath(v,st.node); if(r==='here') arrive(v); else setState(v,'move'); };
  const lapEnd=(v)=>{ const cyc=sim.t-v.lapStartT; v.rs.cycles.push(cyc); v.rs.laps++; v.lapNo++;
    if(v.vt.runtimeH>0 && v.battery<=(v.vt.lowPct||25)) goCharge(v); else { v.lapStartT=sim.t; atHome(v); } };
  const depart=(v)=>{ const nk=(v.k+1)%v.stops.length; const st=stations.get(v.stops[nk]); v.target={kind:'stop',k:nk};
    const r=startPath(v,st.node,routeLegPath(g,v.route,stations.get(v.stops[v.k]),st,v.vt.vmax)); if(r==='here') arrive(v); else if(r===null){log('warn',`${v.id} 无法到达「${st.name}」`); v.dwellLeft=60; setState(v,'dwell');} else setState(v,'move'); };
  function arrive(v){ v.v=0; const tg=v.target;
    if(tg.kind==='stop'){ v.k=tg.k; if(v.k===0) lapEnd(v); else beginDwell(v); }
    else if(tg.kind==='charge'){ v.charges++; setState(v,'charge'); }
    else { v.k=0; v.lapStartT=sim.t; atHome(v); } }

  const addOcc=(key,v,rear)=>{let a=sim.occ.get(key);if(!a){a=[];sim.occ.set(key,a);}a.push({v,rear});};
  function buildOcc(){ sim.occ.clear();
    for(const v of sim.vehicles){ if(!v.active) continue; const L=v.legs[v.li]; const rear=v.s-v.L; addOcc(L.key,v,Math.max(0,rear));
      if(rear<0){ let rem=-rear; for(let i=v.hist.length-1;i>=0&&rem>0;i--){const h=v.hist[i];addOcc(h.key,v,Math.max(0,h.len-rem));rem-=h.len;} } } }

  function moveStep(v,dt){
    const vt=v.vt, acc=Math.max(0.05,vt.acc||0.5), dec=Math.max(acc,0.5);
    let stopDist=Infinity, vAllowed=Math.min(vt.vmax,v.legs[v.li].limit), blocked=null;
    let dStart=-v.s;
    for(let j=v.li;j<v.legs.length;j++){
      const L=v.legs[j]; if(j>v.li) vAllowed=Math.min(vAllowed, Math.sqrt(Math.min(vt.vmax,L.limit)**2+2*dec*Math.max(0,dStart)));
      const occ=sim.occ.get(L.key);
      if(occ) for(const o of occ){ if(o.v===v) continue; if(j===v.li && o.rear<=v.s+1e-3) continue;
        const d=dStart+o.rear-GAP; if(d<stopDist){stopDist=d;blocked='veh';} }
      const dEnd=dStart+L.len, isLast=j===v.legs.length-1, endNode=L.to;
      if(isLast && dEnd<stopDist){stopDist=dEnd;blocked=null;}
      if(!holdsNode(v,endNode)){
        const brake=v.v*v.v/(2*dec)+1.2;
        if(dEnd-STOPBACK<=brake+0.4){
          if(isFree(v,endNode)) hold(v,endNode);
          else if(v.override){ holds.set(endNode,v.id); v.holds.push({node:endNode,rel:Infinity}); v.override=false; sim.overrides++; log('deadlock',`${v.id} 长时间等待，强制放行通过节点`); }
          else { const d=dEnd-STOPBACK; if(d<stopDist){stopDist=d;blocked='node';} break; }
        } else break;
      }
      if(!isLast){ const N=v.legs[j+1]; const c=L.ux*N.ux+L.uz*N.uz; if(c<0.9){ const vt2=c<-0.5?0.25:VTURN; vAllowed=Math.min(vAllowed,Math.sqrt(vt2*vt2+2*dec*Math.max(0,dEnd))); } }
      dStart=dEnd; if(isLast||dStart>LOOK) break;
    }
    const vA=Math.min(vAllowed,Math.sqrt(2*dec*Math.max(0,stopDist)));
    let nv=Math.min(v.v+acc*dt,vA); if(nv<0) nv=0;
    let ds=Math.min(nv*dt,Math.max(0,stopDist)); if(stopDist-ds<0.004 && stopDist>0) ds=Math.max(0,stopDist);
    v.v=nv; v.blocked=ds<1e-4?blocked:null;
    let arrived=false;
    if(ds>0){ v.s+=ds; v.odo+=ds; v.dist+=ds;
      while(v.s>=v.legs[v.li].len-1e-6){ const L=v.legs[v.li];
        if(v.li<v.legs.length-1){ v.s-=L.len; const h=v.holds.find(h=>h.node===L.to&&h.rel===Infinity); if(h) h.rel=v.odo-v.s+v.L+0.5;
          sim.edgePass[L.edge.id]=(sim.edgePass[L.edge.id]||0)+1; pushHist(v,L); v.li++; }
        else { v.s=L.len; arrived=true; sim.edgePass[L.edge.id]=(sim.edgePass[L.edge.id]||0)+1; break; } } }
    if(arrived){ arrive(v); return; }
    if(ds<1e-4){ setState(v,'wait'); v.waitRun+=dt;
      if(v.blocked==='node' && v.waitRun>300 && !v.override){ v.override=true; }
      const e=v.legs[v.li].edge.id; sim.edgeWait[e]=(sim.edgeWait[e]||0)+dt;
    } else { setState(v,'move'); v.waitRun=0; v.override=false; }
  }

  sim.step=function(dt){
    if(sim.done) return;
    sim.t+=dt; buildOcc();
    const q={};
    for(const v of sim.vehicles){
      if(!v.active){
        if(sim.t>=v.launchAt){ const n0=stations.get(v.stops[0]).node; if(isFree(v,n0)){ v.active=true; hold(v,n0); v.k=0; v.lapStartT=sim.t; atHome(v); log('start',`${v.id} 投入运行（${v.vt.name}）`);} }
      } else if(v.state==='idle' && v.waitSched){ if(sim.t>=v.schedAt){ v.waitSched=false; beginDwell(v);} }
      else if(v.state==='dwell'){ v.dwellLeft-=dt; sim.stationStats[v.stops[v.k]].dwellT+=dt; if(v.dwellLeft<=0) depart(v); }
      else if(v.state==='charge'){ if(v.battery>=95){ log('charge',`${v.id} 充电完成，返回首站`); v.target={kind:'home'}; const r=startPath(v,stations.get(v.stops[0]).node); if(r==='here') arrive(v); else setState(v,'move'); } }
      else if(v.state==='move'||v.state==='wait'){ moveStep(v,dt);
        if(v.state==='wait' && v.target){ const sid=v.target.kind==='stop'?v.stops[v.target.k]:v.target.kind==='charge'?v.target.st:v.stops[0];
          let rem=-v.s; for(let j=v.li;j<v.legs.length;j++) rem+=v.legs[j].len;
          if(rem<25){ sim.stationStats[sid].waitT+=dt; q[sid]=(q[sid]||0)+1; } } }
      if(v.active){ v.holds=v.holds.filter(h=>{ if(v.odo>=h.rel){ if(holds.get(h.node)===v.id) holds.delete(h.node); return false;} return true; }); }
      const vt=v.vt;
      if(v.active && vt.runtimeH>0){ const drain=100/(vt.runtimeH*3600);
        if(v.state==='move') v.battery-=drain*dt; else if(v.state==='charge') v.battery+=100/(Math.max(0.1,vt.chargeH)*3600)*dt; else v.battery-=drain*0.15*dt;
        v.battery=Math.max(0,Math.min(100,v.battery)); }
      v.st[v.state]+=dt;
    }
    for(const k in q){ const s=sim.stationStats[k]; if(q[k]>s.maxQ) s.maxQ=q[k]; }
    if(sim.t>=sim.duration-1e-9){ sim.done=true; log('done','仿真结束'); }
  };
  return sim;
}

function legPoint(L,d){ let x=L.ax+L.ux*d, z=L.az+L.uz*d;
  if(L.two){ const f=Math.max(0,Math.min(1,Math.min(d,L.len-d)/1.2))*LANE_OFF; x+=-L.uz*f; z+=L.ux*f; } return {x,z}; }
function posAlong(v,back){ const L=v.legs[v.li]; let d=v.s-back; if(d>=0) return legPoint(L,d);
  let rem=-d; for(let i=v.hist.length-1;i>=0;i--){ const h=v.hist[i]; if(rem<=h.len) return legPoint(h,h.len-rem); rem-=h.len; }
  const h=v.hist[0]||L; return legPoint(h,-rem); }

function computeKPI(sim,sc){
  const T=Math.max(sim.t,1e-9), K=['idle','move','dwell','wait','charge'];
  const vehicles=sim.vehicles.map(v=>{const pct={};K.forEach(k=>pct[k]=v.st[k]/T);
    return {id:v.id,route:v.route.name,color:v.route.color,vt:v.vt.name,state:v.state,util:(v.st.move+v.st.dwell)/T,pct,laps:v.lapNo,dist:v.dist,battery:v.battery,charges:v.charges,hasBat:v.vt.runtimeH>0,waitT:v.st.wait};});
  const routes=Object.values(sim.routeStats).filter(r=>r.count>0).map(r=>{const c=r.cycles;const n=r.onTime+r.late;
    return {id:r.id,name:r.name,color:r.color,count:r.count,laps:r.laps,avg:c.length?c.reduce((a,b)=>a+b,0)/c.length:null,max:c.length?Math.max(...c):null,period:r.period,ontime:r.period&&n?r.onTime/n:null,onTime:r.onTime,n};});
  const stations=sc.stations.map(s=>{const x=sim.stationStats[s.id]||{visits:0,waitT:0,dwellT:0,maxQ:0};return {id:s.id,name:s.name,type:s.type,visits:x.visits,avgDwell:x.visits?x.dwellT/x.visits:0,waitT:x.waitT,maxQ:x.maxQ};});
  const N=new Map(sc.nodes.map(n=>[n.id,n]));
  const hotEdges=Object.entries(sim.edgeWait).filter(([id])=>id!=='_v').sort((a,b)=>b[1]-a[1]).slice(0,5).map(([id,w])=>{const e=sc.edges.find(x=>x.id===id);const a=e&&N.get(e.a),b=e&&N.get(e.b);
    return {id,wait:w,len:a&&b?Math.hypot(a.x-b.x,a.z-b.z):0,label:a&&b?`(${a.x},${a.z}) → (${b.x},${b.z})`:id};});
  const deliveries=sc.stations.filter(s=>s.type==='drop').reduce((a,s)=>a+(sim.stationStats[s.id]?.visits||0),0);
  const on=routes.reduce((a,r)=>a+(r.period?r.onTime:0),0), nn=routes.reduce((a,r)=>a+(r.period?r.n:0),0);
  const moveT=sim.vehicles.reduce((a,v)=>a+v.st.move+v.st.wait,0), waitT=sim.vehicles.reduce((a,v)=>a+v.st.wait,0);
  return {t:sim.t,util:vehicles.length?vehicles.reduce((a,v)=>a+v.util,0)/vehicles.length:0,deliveries,laps:routes.reduce((a,r)=>a+r.laps,0),
    ontime:nn?on/nn:null,waitShare:moveT?waitT/moveT:0,overrides:sim.overrides,vehicles,routes,stations,hotEdges,problems:sim.problems.slice(),
    events:sim.events.slice(-200).reverse()};
}

function validateScenario(sc){
  const out=[], g=buildGraph(sc), deg=new Map(sc.nodes.map(n=>[n.id,{i:0,o:0}]));
  for(const [id,arcs] of g.adj) for(const a of arcs){ deg.get(a.from).o++; deg.get(a.to).i++; }
  for(const n of sc.nodes){ const d=deg.get(n.id); if(!d.i&&!d.o) out.push({level:'warn',msg:`节点 (${n.x}, ${n.z}) 没有连接任何路段`});
    else if(!d.o) out.push({level:'warn',msg:`节点 (${n.x}, ${n.z}) 只能进不能出（死胡同）`}); else if(!d.i) out.push({level:'warn',msg:`节点 (${n.x}, ${n.z}) 只能出不能进（无法到达）`}); }
  for(const e of sc.edges){ const a=g.N.get(e.a),b=g.N.get(e.b); if(a&&b&&Math.hypot(a.x-b.x,a.z-b.z)<0.5) out.push({level:'warn',msg:`路段 (${a.x},${a.z})→(${b.x},${b.z}) 短于 0.5 m`}); }
  const st=new Map(sc.stations.map(s=>[s.id,s])), vt=new Map(sc.vtypes.map(v=>[v.id,v]));
  for(const r of sc.routes){ const v=vt.get(r.vtype); const stops=r.stops.filter(id=>st.has(id));
    if(!v){out.push({level:'error',msg:`路线「${r.name}」未选择车型`});continue;}
    if(stops.length<2){out.push({level:'error',msg:`路线「${r.name}」至少需要 2 个停靠站点`});continue;}
    if(!(r.count>0)) out.push({level:'warn',msg:`路线「${r.name}」车辆数为 0，仿真时不会运行`});
    for(let i=0;i<stops.length;i++){ const A=st.get(stops[i]),B=st.get(stops[(i+1)%stops.length]);
      const vias=legVia(r,A.id,B.id), missing=vias.filter(n=>!g.N.has(n)).length;
      if(missing) out.push({level:'warn',msg:`路线「${r.name}」：「${A.name}」→「${B.name}」有 ${missing} 个途经点已被删除，已忽略`});
      if(!routeLegPath(g,r,A,B,v.vmax)) out.push({level:'error',msg:`路线「${r.name}」：「${A.name}」→「${B.name}」不可达${vias.length?'（按指定途经点无法走通，检查路段方向）':''}`}); }
    if(r.period>0){ let len=0,drive=0; for(let i=0;i<stops.length;i++){const p=routeLegPath(g,r,st.get(stops[i]),st.get(stops[(i+1)%stops.length]),v.vmax)||[];for(const a of p){len+=a.len;drive+=a.len/Math.min(v.vmax,a.limit);}}
      const cyc=drive+stops.reduce((a,id)=>a+dwellMean(st.get(id)),0); if(cyc>r.period) out.push({level:'warn',msg:`路线「${r.name}」理论循环 ${Math.round(cyc)} s 已超过计划周期 ${r.period} s`}); }
  }
  if(sc.routes.some(r=>vt.get(r.vtype)?.runtimeH>0 && r.count>0) && !sc.stations.some(s=>s.type==='charge')) out.push({level:'warn',msg:'有带电池的车辆，但方案中没有充电点'});
  return out;
}

function sampleScenario(){
  const O=[]; let oi=0;
  const ob=(type,x,z,w,d,h,rot=0,ex={})=>O.push({id:'o'+(++oi),type,name:ex.name||OBJ_TYPES[type].label,x,z,w,d,h,rot,color:ex.color||OBJ_TYPES[type].color,zoneKind:ex.zoneKind||''});
  ob('zone',8,20,12,36,0,0,{name:'原材料仓库',zoneKind:'仓库区',color:'#3d7cc9'});
  ob('zone',37,13,34,7,0,0,{name:'A 装配线',zoneKind:'产线区',color:'#4f9a6a'});
  ob('zone',37,27,34,7,0,0,{name:'B 装配线',zoneKind:'产线区',color:'#4f9a6a'});
  ob('zone',24,38.4,6,2.6,0,0,{name:'充电区',zoneKind:'充电区',color:'#7b55b8'});
  ob('zone',52,38.4,6,2.6,0,0,{name:'空箱暂存',zoneKind:'暂存区',color:'#c98b3a'});
  ob('wall',32,0.12,64,0.24,3.5); ob('wall',32,39.88,64,0.24,3.5); ob('wall',0.12,20,40,0.24,3.5,90); ob('wall',63.88,20,40,0.24,3.5,90);
  for(const x of [32,48]){ ob('column',x,0.6,0.6,0.6,6); ob('column',x,39.4,0.6,0.6,6); }
  for(const x of [4,8,12]) for(let k=0;k<10;k++) ob('rack',x,5.5+k*3.2,2.7,1.0,2.2,90,{name:`货架 ${String.fromCharCode(65+(x/4-1))}${String(k+1).padStart(2,'0')}`});
  ob('line',37,13,30,1.6,0.95,0,{name:'A 线输送带'}); ob('line',37,27,30,1.6,0.95,0,{name:'B 线输送带'});
  [25,31,37,43,49].forEach((x,i)=>{ob('bench',x,10.6,2,1,0.9,0,{name:`A 线工位 ${i+1}`});ob('bench',x,29.4,2,1,0.9,0,{name:`B 线工位 ${i+1}`});});
  [26,36,46].forEach((x,i)=>ob('buffer',x,17.8,1.6,0.8,0.8,0,{name:`A${i+1} 线边料架`}));
  [30,44].forEach((x,i)=>ob('buffer',x,32.6,1.6,0.8,0.8,0,{name:`B${i+1} 线边料架`}));
  ob('buffer',50.5,38.6,1.2,1.0,0.7,0,{name:'空箱架 1'}); ob('buffer',53.5,38.6,1.2,1.0,0.7,0,{name:'空箱架 2'});
  ob('charger',24,39.45,0.6,0.4,1.3,0,{name:'充电桩 1'});
  const P={n1:[17,5],n2:[60,5],n3:[60,20],n4:[60,35],n5:[17,35],n6:[17,20],n8:[17,12],pin:[17,32],pout:[17,24],d1:[15.2,30.5],dock:[15.2,25.5],
    n9:[26,20],n10:[36,20],n11:[46,20],n12:[52,35],n13:[44,35],n14:[30,35],n15:[24,35],n16:[24,38.8]};
  const nodes=Object.entries(P).map(([id,[x,z]])=>({id,x,z}));
  let ei=0; const E=(a,b,dir='fwd')=>({id:'e'+(++ei),a,b,dir,limit:null});
  const edges=[E('n1','n2'),E('n2','n3'),E('n3','n4'),E('n4','n12'),E('n12','n13'),E('n13','n14'),E('n14','n15'),E('n15','n5'),E('n5','pin'),E('pin','pout'),E('pout','n6'),E('n6','n8'),E('n8','n1'),
    E('pin','d1'),E('d1','dock'),E('dock','pout'),E('n6','n9'),E('n9','n10'),E('n10','n11'),E('n11','n3'),E('n15','n16','both')];
  edges.find(e=>e.a==='pin'&&e.b==='d1').limit=0.6; edges.find(e=>e.a==='dock').limit=0.6;
  const S=(id,name,node,type,mode,d1,d2,note='')=>({id,name,node,type,dwellMode:mode,d1,d2,note});
  const stations=[S('s1','仓库出库口 1','dock','pick','fixed',90,0,'装 3 车料箱'),S('s2','仓库出库口 2','n8','pick','uniform',50,70,'顶升料架'),
    S('s3','A 线 1 号位','n9','drop','fixed',60,0,'卸 4 箱'),S('s4','A 线 2 号位','n10','drop','uniform',45,75,'卸 4 箱'),S('s5','A 线 3 号位','n11','drop','fixed',60,0,'卸 3 箱'),
    S('s6','空箱回收','n12','empty','fixed',45,0,'回收空箱'),S('s7','B 线 1 号位','n14','drop','fixed',40,0,'放下料架'),S('s8','B 线 2 号位','n13','drop','fixed',40,0,'放下料架'),
    S('s9','充电位 1','n16','charge','fixed',0,0)];
  const vtypes=[
    {id:'vt-agv',name:'潜伏顶升 AGV',kind:'agv',length:1.2,width:0.8,height:0.35,vmax:1.2,acc:0.5,carts:0,cartLen:1.2,runtimeH:4,chargeH:1.2,lowPct:25,color:'#e1a200'},
    {id:'vt-tug',name:'牵引车 + 3 节料车',kind:'tug',length:1.6,width:0.8,height:1.0,vmax:1.0,acc:0.4,carts:3,cartLen:1.3,runtimeH:10,chargeH:2,lowPct:20,color:'#2f6fb0'},
    {id:'vt-cart',name:'人工小料车',kind:'cart',length:1.1,width:0.6,height:0.9,vmax:0.9,acc:0.8,carts:0,cartLen:1.2,runtimeH:0,chargeH:1,lowPct:20,color:'#c9572f'},
    {id:'vt-fork',name:'叉车式 AGV',kind:'fork',length:1.8,width:0.9,height:1.6,vmax:1.0,acc:0.4,carts:0,cartLen:1.2,runtimeH:6,chargeH:1.5,lowPct:25,color:'#3a8f8a'},
  ];
  const routes=[
    {id:'r1',name:'Milk Run · A 线配送',color:'#2f6fb0',vtype:'vt-tug',count:2,period:600,gap:120,stops:['s1','s3','s4','s5','s6']},
    {id:'r2',name:'AGV · B 线补料',color:'#d48a00',vtype:'vt-agv',count:3,period:0,gap:90,stops:['s2','s8','s7']},
  ];
  return {v:1,name:'示例车间 · A/B 双线',layout:{w:64,d:40},bg:null,objects:O,nodes,edges,stations,vtypes,routes,sim:{duration:28800,seed:7}};
}
function blankScenario(name){ const s=sampleScenario(); return {v:1,name,layout:{w:40,d:24},bg:null,objects:[],nodes:[],edges:[],stations:[],vtypes:s.vtypes,routes:[],sim:{duration:14400,seed:1}}; }
if(typeof module!=="undefined"&&module.exports){module.exports={OBJ_TYPES,ZONE_KINDS,STATION_TYPES,VKINDS,buildGraph,shortestPath,routeLegPath,legVia,legKey,normalizeNetwork,createSim,posAlong,computeKPI,validateScenario,sampleScenario,blankScenario,vehLength,dwellMean,SIM_DT};}
