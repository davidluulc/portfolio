/* ============ 咕嘎桌宠模块（design-spec.md §4 + §4.5） ============
 * 用法：
 *   GuaPet.init({ base:'assets/gua/', ver:'?v=15', surfaces:[...] })
 *   surfaces 省略时自动探测 .landscape .pv 云丘（首页）；传 [] 显式进入角落待命模式。
 * 行为：沿注册行走面自主漫步 / 双击跳层（蹬云+落云颠簸）/ 拖拽弹回原面 /
 *       单击摸头 / 待机张望。角落模式：右下待命，可拖可摸不漫游。
 * 架构：零 canvas（本机 GPU 栈损坏加速画布纹理）；每动作专属元素逐帧仅 translate；
 *       云漂移同相位解析计算，每帧零样式读取；懒加载分组控制解码内存。
 * 跨页：pagehide 时状态写 localStorage（状态接力），新页 init 时恢复。
 * 生命周期：init() 返回实例；destroy() 清定时器/监听/DOM，供软导航换页使用。 */
window.GuaPet=(function(){
"use strict";

function init(opts){
  opts=opts||{};
  var BASE=opts.base||'assets/gua/';
  var VER=opts.ver||'?v=15';
  var SC=opts.scale||1;            /* 子页缩放（如导航栏行走面用 0.38） */
  var XMIN=opts.xMin, XMAX=opts.xMax;  /* 漫步范围（内容边界，自动让出半身） */
  var ALWAYS=!!opts.always;        /* true=滚出首屏也活动（sticky 行走面用） */

  /* ---- 挂载点自建（body 顶层，z45 见 gua.css） ---- */
  var mount=document.createElement('span');
  mount.className='gua-mount';mount.id='guaMount';mount.setAttribute('aria-hidden','true');
  mount.innerHTML='<span class="gua-fly" id="guaFly"><i class="gua-shadow"></i></span>';
  var fly=mount.firstChild;

  /* ---- 行走面注册：显式传入 > 自动探测云丘 > 空数组=角落模式 ---- */
  var surfaces;
  if(opts.surfaces){
    surfaces=opts.surfaces.map(normalizeSurface);
  }else{
    surfaces=detectClouds();
  }
  var cornerMode=surfaces.length===0;
  if(cornerMode||ALWAYS)mount.classList.add('fixed');   /* ALWAYS=sticky 行走面，mount 用屏幕坐标 */
  document.body.appendChild(mount);

  function normalizeSurface(s){
    return {path:s.path,sp:s.sp||50,dd:s.dd||0,delay:s.delay||0,
            svg:s.svg,vbW:s.vbW||1440,vbH:s.vbH||1000,driftAmp:s.driftAmp==null?26:s.driftAmp};
  }
  function detectClouds(){
    var landSvg=document.querySelector('.landscape svg[viewBox]');
    return [].map.call(document.querySelectorAll('.pv'),function(g){
      var d=g.querySelector('.drift');
      var s={path:g.querySelector('.cl'),sp:+g.getAttribute('data-sp')||50,
             dd:d?(parseFloat(d.style.getPropertyValue('--dd'))||14):0,
             delay:d?(parseFloat(getComputedStyle(d).animationDelay)||0):0,
             svg:landSvg,vbW:1440,vbH:1000,driftAmp:26};
      return s.path?s:null;
    }).filter(Boolean);
  }
  /* 运行时切换行走面（首页跨屏陪读用：滚出首屏换导航栏轨道，滚回换云丘） */
  function setSurfaces(list,scaleK){
    if(scaleK)SC=scaleK;
    surfaces=(list||[]).map(normalizeSurface);
    cornerMode=surfaces.length===0;
    mount.classList.toggle('fixed',cornerMode||ALWAYS);
    MAP.ok=false;
    curLayer=Math.min(curLayer,Math.max(0,surfaces.length-1));
    if(!cornerMode){computeMap();fitBox();placeGua(performance.now())}
    else{fitBox();placeGua(performance.now())}
    return true;
  }

  /* ---- 播放器（每动作专属元素） ---- */
  var elsByName={},order=[],activeE=null,flipGen=0;
  var conf=null,cur=null,timer=null,frame=0;
  var playGen=0;
  var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  var sheets={},pending={};
  var fit={k:1};

  function applySize(e){
    var a=conf[e.act],K=fit.k,wCss=K*a.w;
    e.node.style.width=wCss.toFixed(2)+'px';
    e.node.style.height=(K*a.h).toFixed(2)+'px';
    e.node.style.marginLeft=(-wCss/2).toFixed(2)+'px';
    if(!e.img){
      e.img=document.createElement('img');
      e.img.alt='';e.img.draggable=false;
      e.node.appendChild(e.img);
    }
    e.img.src=BASE+a.file+VER;
    e.img.style.width=(K*a.cols*a.w).toFixed(2)+'px';
    e.img.style.height=(K*a.rows*a.h).toFixed(2)+'px';
    e.K=K;
  }
  function fitBox(){
    fit.k=(mount.clientWidth||160)*1.25/157*SC;
    order.forEach(applySize);
    computeBounds();
  }
  function getEl(name){
    var e=elsByName[name];
    if(e)return e;
    var node=document.createElement('i');
    node.className='gfr';
    fly.appendChild(node);
    e={node:node,act:name,K:0,img:null};
    elsByName[name]=e;order.push(e);
    bindPointer(node);
    return e;
  }
  /* Image 引用必须持有到 decode 结算：onload 后若无引用，元素会被 GC，
     挂起的 decode() Promise 成为孤儿永不 settle（实测踩坑） */
  var kept={};
  function ensure(name){
    if(sheets[name])return Promise.resolve(true);
    if(pending[name])return pending[name];
    var a=conf[name];
    var p=new Promise(function(res,rej){
      var im=new Image();
      kept[name]=im;
      im.onload=function(){if(im.decode)im.decode().then(function(){delete kept[name];res()},function(e){delete kept[name];rej(e)});else{delete kept[name];res()}};
      im.onerror=function(){delete kept[name];rej()};
      im.src=BASE+a.file+VER;
    }).then(function(){
      sheets[name]=true;
      applySize(getEl(name));
      return true;
    },function(){delete pending[name]});
    pending[name]=p;
    return p;
  }
  function drawEl(e,i){
    var a=conf[e.act];
    if(!a||!sheets[e.act]||i>=a.frames)return;
    if(e.K!==fit.k)applySize(e);
    var c=i%a.cols,r=Math.floor(i/a.cols);
    e.img.style.transform='translate('+(-(c*a.w)*fit.k).toFixed(1)+'px,'+(-(r*a.h)*fit.k).toFixed(1)+'px)';
  }
  function play(name,loop,onend){
    if(!conf||!conf[name])return;
    if(cur===name&&loop)return;
    var gen=++playGen;
    ensure(name).then(function(){
      if(gen!==playGen)return;
      if(state==='drag'&&name!=='drag')return;
      var same=cur===name;
      cur=name;frame=0;clearInterval(timer);
      var st=getEl(name);
      if(same||!activeE){
        drawEl(st,0);
        if(!activeE){st.node.classList.add('on');activeE=st}
      }else{
        drawEl(st,0);
        st.node.classList.add('warm');
        var fg=++flipGen;
        requestAnimationFrame(function(){requestAnimationFrame(function(){
          if(fg!==flipGen)return;
          var old=activeE;
          st.node.classList.add('on');
          if(old){old.node.classList.remove('on');old.node.classList.remove('warm')}
          activeE=st;
        })});
      }
      if(reduce){cur=null;return}
      timer=setInterval(function(){
        frame++;
        if(frame>=conf[name].frames){
          if(loop)frame=0;
          else{clearInterval(timer);cur=null;if(onend)onend();return}
        }
        drawEl(activeE,frame);
      },conf[name].refresh*1000);
    }).catch(function(){});
  }

  var state='boot',lookT=null;
  function toIdle(){state='idle';play('default',true);scheduleLook()}
  function scheduleLook(){
    clearTimeout(lookT);if(reduce)return;
    lookT=setTimeout(function(){
      if(state!=='idle')return;
      play(Math.random()<.5?'lookleft':'lookright',false,toIdle);
    },8000+Math.random()*6000);
  }

  var dragPreloaded=false;
  function preload(list){list.forEach(function(n){ensure(n).catch(function(){})})}
  function onFirstDrag(){
    if(dragPreloaded)return;dragPreloaded=true;
    preload(['fall','patpat'])
  }

  /* ---- 行走面几何（云丘版实现；其它面可扩展 normalizeSurface 约定） ---- */
  var MAP={ok:false,scale:1,vbX0:0,vbY0:0};
  function computeMap(){
    if(!surfaces.length)return;
    var svg=surfaces[0].svg;
    if(!svg)return;
    var r=svg.getBoundingClientRect();
    /* 坐标基准：fixed mount 用视口坐标（sticky 轨道），absolute mount 用文档坐标 */
    MAP.offY=r.top+(mount.classList.contains('fixed')?0:scrollY);
    var sc=Math.max(r.width/surfaces[0].vbW,r.height/surfaces[0].vbH);
    MAP.scale=sc;
    MAP.vbX0=(surfaces[0].vbW-r.width/sc)/2;
    MAP.vbY0=surfaces[0].vbH-r.height/sc;
    surfaces.forEach(function(L){
      if(!L.topPath&&L.path){
        var d=L.path.getAttribute('d').split(/V\s*/)[0];
        L.topPath=document.createElementNS('http://www.w3.org/2000/svg','path');
        L.topPath.setAttribute('d',d);L.topPath.setAttribute('fill','none');
        L.topPath.style.display='none';
        svg.appendChild(L.topPath);
      }
      if(L.topPath)L.len=L.topPath.getTotalLength();
    });
    MAP.ok=true;
  }
  function driftX(L,now){
    if(!L.dd)return 0;
    var ph=(((now/1000-L.delay)%(2*L.dd))+2*L.dd)%(2*L.dd)/L.dd;
    if(ph>1)ph=2-ph;
    return L.driftAmp*(ph*ph*(3-2*ph))*MAP.scale;
  }
  function parallaxY(L){
    return Math.min(scrollY,innerHeight*1.4)*(100-L.sp)/100*MAP.scale;
  }
  function surfaceY(L,clx,now){
    var t=Math.min(Math.max((MAP.vbX0+clx/MAP.scale+120)/1680,0),1);
    var pt=L.topPath.getPointAtLength(t*L.len);
    return (pt.y-MAP.vbY0)*MAP.scale+parallaxY(L)+MAP.offY;
  }

  var curLayer=Math.min(1,surfaces.length-1);
  var walker={x:0,target:0,dir:0,speed:40,waitT:2.5,state:'idle'};
  var WPR={ok:false};
  var bounceOff=0,lastRender=null;
  function computeBounds(){
    if(!MAP.ok&&!cornerMode)return;
    WPR.guaHalf=mount.clientWidth/2;
    var xmin=XMIN!=null?(typeof XMIN==='function'?XMIN():XMIN):40;
    var xmax=XMAX!=null?(typeof XMAX==='function'?XMAX():XMAX):innerWidth-40;
    WPR.xMin=xmin+WPR.guaHalf;
    WPR.xMax=Math.max(xmax-WPR.guaHalf,WPR.xMin+80);
    if(!cornerMode)walker.x=Math.min(Math.max(walker.x||((WPR.xMin+WPR.xMax)/2+120),WPR.xMin),WPR.xMax);
    WPR.ok=true;
  }
  function cornerPlace(){
    var a=conf&&conf.default;
    var h=a?fit.k*a.h:200;
    var x=innerWidth-40;
    var y=innerHeight-h-20;
    mount.style.transform='translate('+(x-WPR.guaHalf).toFixed(1)+'px,'+y.toFixed(1)+'px)';
    lastRender={x:x,y:y};
  }
  function placeGua(now){
    if(!WPR.ok)return;
    if(cornerMode){cornerPlace();return}
    if(!MAP.ok)return;
    now=now||performance.now();
    var L=surfaces[curLayer];
    var x=walker.x+driftX(L,now);
    var y=surfaceY(L,walker.x,now)+bounceOff;
    mount.style.transform='translate('+(x-WPR.guaHalf).toFixed(1)+'px,'+y.toFixed(1)+'px)';
    lastRender={x:x,y:y};
  }
  function kickCloud(L){
    if(!L||!L.path)return;
    var cl=L.path;
    cl.classList.remove('bounce');void cl.getBoundingClientRect();cl.classList.add('bounce');
  }
  function bounceFollow(cb){
    if(cornerMode){if(cb)cb();return}
    var t0=performance.now(),dur=650,S=5*MAP.scale;
    function bf(now){
      var p=Math.min((now-t0)/dur,1),k;
      if(p<.30)k=p/.30;
      else if(p<.62)k=1-((p-.30)/.32)*2;
      else k=-1+((p-.62)/.38);
      bounceOff=k*S;
      if(p<1){requestAnimationFrame(bf);placeGua(now)}
      else{bounceOff=0;placeGua(now);if(cb)cb()}
    }
    requestAnimationFrame(bf);
  }
  function startJump(){
    if(cornerMode||state==='jump'||state==='drag'||state==='fall'||!WPR.ok||reduce)return;
    if(surfaces.length<2)return;
    var to=curLayer;while(to===curLayer)to=Math.floor(Math.random()*surfaces.length);
    var from=surfaces[curLayer],dest=surfaces[to];
    state='jump';
    onFirstDrag();
    kickCloud(from);
    play('drag',true);
    var start=lastRender||{x:walker.x,y:surfaceY(from,walker.x,0)};
    var startCl=walker.x;
    var destCl=Math.min(Math.max(startCl,WPR.xMin),WPR.xMax);
    var arcH=110+Math.abs(innerHeight*0.16);
    var t0=performance.now(),half=false;
    function jstep(now){
      if(state!=='jump'){bounceOff=0;return}
      var y0=surfaceY(from,startCl,now),y1=surfaceY(dest,destCl,now);
      var dur=Math.max(650,Math.abs(y1-y0)*2.2+500);
      var p=Math.min((now-t0)/dur,1);
      var pe=1-Math.pow(1-p,3);
      var x=start.x+((destCl+driftX(dest,now))-start.x)*pe;
      var y=y0+(y1-y0)*pe-arcH*4*p*(1-p);
      mount.style.transform='translate('+(x-WPR.guaHalf).toFixed(1)+'px,'+y.toFixed(1)+'px)';
      lastRender={x:x,y:y};
      if(p>=.5&&!half){half=true;play('fall',true)}
      if(p<1){requestAnimationFrame(jstep);return}
      curLayer=to;walker.x=destCl;walker.target=destCl;
      kickCloud(dest);
      bounceFollow(function(){state='idle';toIdle()});
    }
    requestAnimationFrame(jstep);
  }
  var lastTick=performance.now();
  function walkerTick(now){
    var dt=Math.min((now-lastTick)/1000,0.1);lastTick=now;
    if(!WPR.ok||reduce||state==='drag'||state==='fall'||state==='jump')return;
    if(cornerMode){placeGua(now);return}
    if(walker.state==='idle'){
      walker.waitT-=dt;
      if(walker.waitT<=0){
        var nx=WPR.xMin+Math.random()*(WPR.xMax-WPR.xMin);
        if(Math.abs(nx-walker.x)<70)nx=walker.x+(nx>=walker.x?70:-70);
        nx=Math.min(Math.max(nx,WPR.xMin),WPR.xMax);
        walker.target=nx;walker.dir=nx>=walker.x?1:-1;
        walker.state='turn';state='turn';
        play(walker.dir<0?'defaultToleft':'defaultToright',false,function(){
          if(walker.state!=='turn')return;
          walker.state='walk';state='walk';
          play(walker.dir<0?'walkleft':'walkright',true);
        });
      }
    }else if(walker.state==='walk'){
      walker.x+=walker.dir*walker.speed*dt;
      if(walker.dir>0?walker.x>=walker.target:walker.x<=walker.target){
        walker.x=walker.target;
        walker.state='stopping';state='stopping';
        play(walker.dir<0?'leftTodefault':'rightTodefault',false,function(){
          if(walker.state!=='stopping')return;
          walker.state='idle';walker.waitT=2.5+Math.random()*5;
          toIdle();
        });
      }
    }
    placeGua(now);
  }
  var lastRun=0,rafId=null;
  function loop(){
    var now=performance.now();
    lastRun=now;
    rafId=requestAnimationFrame(loop);
    if(!cornerMode&&!ALWAYS&&scrollY>innerHeight*1.05)return;
    walkerTick(now);
  }
  rafId=requestAnimationFrame(loop);
  var keepTimer=setInterval(function(){if(performance.now()-lastRun>220)loop()},250);

  /* ---- 指针：拖拽 / 双击跳层 / 单击摸头 ---- */
  var drag=null;
  function down(e){
    e.preventDefault();
    try{e.currentTarget.setPointerCapture(e.pointerId)}catch(_){}
    drag={x0:e.clientX,y0:e.clientY,dx:0,dy:0,moved:false};
    state='drag';onFirstDrag();play('drag',true);
  }
  function move(e){
    if(!drag)return;
    drag.dx=e.clientX-drag.x0;drag.dy=e.clientY-drag.y0;
    if(Math.abs(drag.dx)+Math.abs(drag.dy)>8)drag.moved=true;
    fly.style.transform='translate('+drag.dx+'px,'+drag.dy+'px)';
  }
  var lastTap=0;
  function release(){
    if(!drag)return;
    var d=drag;drag=null;
    if(!d.moved){
      fly.style.transform='';
      var now=performance.now();
      if(now-lastTap<380){lastTap=0;state='idle';startJump();return}
      lastTap=now;
      state='pat';play('patpat',false,toIdle);return
    }
    state='fall';play('fall',true);
    var old=lastRender;
    var dropX=(old?old.x:walker.x)+d.dx;
    var dropY=(old?old.y:0)+d.dy;
    if(!cornerMode){
      var L=surfaces[curLayer];
      walker.x=Math.min(Math.max(dropX-driftX(L,performance.now()),WPR.xMin),WPR.xMax);
    }
    placeGua(performance.now());
    var nr=lastRender;
    var fdx=dropX-nr.x,fdy=dropY-nr.y;
    var t0=null,dur=520;
    function step(ts){
      if(!t0)t0=ts;
      var p=Math.min((ts-t0)/dur,1),g=p*p;
      fly.style.transform='translate('+(fdx*(1-g)).toFixed(1)+'px,'+(fdy*(1-g)).toFixed(1)+'px)';
      if(p<1)requestAnimationFrame(step);
      else{fly.style.transform='';state='pat';play('patpat',false,toIdle)}
    }
    var fallTimer=setInterval(function(){
      if(state!=='fall'){clearInterval(fallTimer);return}
      step(performance.now());
      if(state!=='fall')clearInterval(fallTimer);
    },60);
    requestAnimationFrame(step);
  }
  function bindPointer(node){
    node.addEventListener('pointerdown',down);
    node.addEventListener('pointermove',move);
    node.addEventListener('pointerup',release);
    node.addEventListener('pointercancel',release);
  }

  /* ---- 状态接力（跨页连续感，spec §4.5） ---- */
  function saveState(){
    try{
      localStorage.setItem('gua-remain',JSON.stringify({
        corner:cornerMode,layer:curLayer,x:+walker.x.toFixed(1),t:Date.now()
      }));
    }catch(_){}
  }
  function restoreState(){
    try{
      var s=JSON.parse(localStorage.getItem('gua-remain')||'null');
      if(!s||Date.now()-s.t>10*60*1000)return;
      if(!cornerMode&&!s.corner&&s.x!=null){
        walker.x=s.x;
        if(s.layer!=null&&s.layer<surfaces.length)curLayer=s.layer;
      }
    }catch(_){}
  }
  var onHide=function(){saveState()};
  addEventListener('pagehide',onHide);

  var rsT=null;
  var onResize=function(){
    clearTimeout(rsT);
    rsT=setTimeout(function(){computeMap();fitBox();placeGua()},200);
  };
  addEventListener('resize',onResize);

  /* ---- 启动 ---- */
  fetch(BASE+'manifest3.json'+VER).then(function(r){return r.json()}).then(function(m){
    
    conf=m;
    restoreState();
    computeMap();fitBox();placeGua();
    ensure('default').then(toIdle,toIdle);
    setTimeout(function(){preload(['lookleft','lookright'])},2500);
    setTimeout(function(){preload(['walkleft','walkright','defaultToleft','defaultToright','leftTodefault','rightTodefault'])},4000);
    setTimeout(function(){preload(['drag','fall','patpat'])},5500);
  }).catch(function(e){mount.style.display='none'});

  /* ---- 生命周期 ---- */
  return {
    destroy:function(){
      clearInterval(timer);clearInterval(keepTimer);
      clearTimeout(lookT);clearTimeout(rsT);
      if(rafId)cancelAnimationFrame(rafId);
      removeEventListener('resize',onResize);
      removeEventListener('pagehide',onHide);
      saveState();
      mount.remove();
    },
    jump:function(){startJump()},
    setSurfaces:setSurfaces,
    detectClouds:detectClouds,
    get layer(){return cornerMode?-1:curLayer},
    get cornerMode(){return cornerMode}
  };
}

return {init:init};
})();
