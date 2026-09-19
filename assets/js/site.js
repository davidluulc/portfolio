/* ============ 页面共享脚本（design-spec.md §1/§3.4） ============
 * 主题切换 / 遮罩导航 / 分层视差 / 入视口调度（乱码·reveal·数字滚动）/ 点云蹦星 / 邮件复制。
 * 封装 init/destroy 生命周期（spec §4.5 软导航规范），页面底部 SitePage.init() 启动。 */
window.SitePage=(function(){
"use strict";

function init(){
  var listeners=[];   /* [target, type, fn] 供 destroy 注销 */
  var timeouts=[];
  function on(t,type,fn,opt){t.addEventListener(type,fn,opt);listeners.push([t,type,fn,opt])}
  function later(fn,ms){timeouts.push(setTimeout(fn,ms))}
  var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- 主题切换 ---- */
  var toggle=document.getElementById('themeToggle'),path=document.getElementById('knobPath');
  var root=document.documentElement;
  function setIcon(t){
    path.setAttribute('d', t==='dark'
      ? 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z'
      : 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z M12 1v2 M12 21v2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M1 12h2 M21 12h2 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4');
  }
  if(toggle&&path){
    setIcon(root.getAttribute('data-theme'));
    on(toggle,'click',function(){
      var next=root.getAttribute('data-theme')==='dark'?'light':'dark';
      root.setAttribute('data-theme',next);
      setIcon(next);
      try{localStorage.setItem('kwb-theme',next)}catch(e){}
    });
  }

  /* ---- 遮罩导航阈值 ---- */
  var bar=document.getElementById('topbar');
  if(bar){
    var navFn=function(){bar.dataset.over=scrollY>innerHeight*.85?'true':'false'};
    on(window,'scroll',navFn,{passive:true});
    navFn();
  }

  /* ---- 分层视差（data-sp=保留速度百分比） ---- */
  if(!reduce){
    var layers=[].slice.call(document.querySelectorAll('.pv')).map(function(el){
      return {el:el, sp:+el.getAttribute('data-sp')||50};
    });
    if(layers.length){
      var ticking=false;
      function upd(){
        ticking=false;
        var y=Math.min(scrollY, innerHeight*1.4);
        layers.forEach(function(L){
          L.el.style.transform='translateY('+(y*(100-L.sp)/100).toFixed(1)+'px)';
        });
      }
      on(window,'scroll',function(){
        if(!ticking){ticking=true;requestAnimationFrame(upd);}
      },{passive:true});
      upd();
    }
  }

  /* ---- 入视口调度器（scroll 事件同步驱动，统一供乱码/reveal/数字滚动） ----
     不用 IntersectionObserver、不依赖渲染帧：本机环境下无持续动画的静止页面
     会暂停帧调度，IO 与一次性 rAF 均不执行（子页实测，2026-09-18）；
     scroll 事件同步跑 getBoundingClientRect（≈19 元素 <1ms，收编完成后零开销）。 */
  function makeInview(onHit){
    var items=[],alive=true;
    function chk(){
      if(!alive)return;
      var vh=innerHeight;
      items=items.filter(function(el){
        var r=el.getBoundingClientRect();
        if(r.top<vh*.88&&r.bottom>-40){onHit(el);return false}
        return true;
      });
    }
    on(window,'scroll',chk,{passive:true});
    on(window,'resize',chk,{passive:true});
    return {feed:function(els){items=items.concat(els);chk()},
            stop:function(){alive=false;items=[]}};
  }

  /* ---- 乱码解码（data-scramble[=ms延迟]：入视口后乱码逐字解锁定格） ----
     按文本节点解码，元素内部的 span/加粗等结构全程保留 */
  var POOL='！？＃＄％＆＊＋－＝／〈〉「」『』丶丿一丨乙乚丂丄丅';  /* 全角，宽度随汉字不抖 */
  var STEP=105, TAIL=300;   /* 短句 105ms/字；长文本自适应提速，总时长压在 ~1.4s 内 */
  function stepFor(n){return Math.min(STEP,Math.max(45,Math.round(1050/n)))}
  function scrParts(el){
    var parts=[],idx=0,w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),n;
    while((n=w.nextNode())){parts.push({node:n,start:idx,text:n.nodeValue});idx+=n.nodeValue.length}
    return parts;
  }
  var scrEls=[];
  function startScramble(el){
    var parts=scrParts(el), text=parts.map(function(p){return p.text}).join('');
    var n=text.length, step=stepFor(n), DUR=n*step+TAIL, t0=null;
    el.__parts=parts;
    later(function(){
      function tick(ts){
        if(t0===null)t0=ts;
        var p=ts-t0, lock=Math.floor(p/step);
        parts.forEach(function(pt){
          var out='',g;
          for(var k=0;k<pt.text.length;k++){
            g=pt.start+k;
            out+=g<lock?pt.text.charAt(k):POOL.charAt((Math.random()*POOL.length)|0);
          }
          pt.node.nodeValue=out;
        });
        if(p<DUR)el.__scr=requestAnimationFrame(tick);
        else{parts.forEach(function(pt){pt.node.nodeValue=pt.text});el.__scr=0}
      }
      el.__scr=requestAnimationFrame(tick);
    },+el.getAttribute('data-scramble')||0);
  }

  /* ---- 数字滚动（data-count=目标 data-from=起点 data-suffix=后缀，入视口 550ms 滚到位） ----
     静态内容写终值：无 JS / reduced-motion 直接显示，动画从起点滚下来让"变化"可感知 */
  var cntEls=[];
  function startCount(el){
    var to=+el.getAttribute('data-count'), from=+el.getAttribute('data-from')||0;
    var suf=el.getAttribute('data-suffix')||'';
    el.__cntTo=to+suf;
    var t0=null, DUR=550;
    function tick(ts){
      if(t0===null)t0=ts;
      var p=Math.min((ts-t0)/DUR,1), e=1-Math.pow(1-p,3);
      el.textContent=Math.round(from+(to-from)*e)+suf;
      if(p<1)el.__cnt=requestAnimationFrame(tick);
      else{el.textContent=to+suf;el.__cnt=0}
    }
    el.__cnt=requestAnimationFrame(tick);
  }

  /* ---- 三类视口元素统一挂载 ---- */
  var iv=null;
  if(!reduce){
    document.documentElement.classList.add('js-rv');   /* reveal 隐藏态仅在有动画时生效 */
    scrEls=[].slice.call(document.querySelectorAll('[data-scramble]'));
    cntEls=[].slice.call(document.querySelectorAll('[data-count]'));
    iv=makeInview(function(el){
      if(el.hasAttribute('data-scramble'))startScramble(el);
      else if(el.hasAttribute('data-count'))startCount(el);
      else el.classList.add('in');
    });
    var targets=[].slice.call(document.querySelectorAll('[data-rv],[data-scramble],[data-count]'));
    targets.forEach(function(el){
      var d=+el.getAttribute('data-rv');
      if(d)el.style.transitionDelay=d+'ms';
    });
    iv.feed(targets);
  }

  /* ---- 点云蹦星（点击云丘：抖动 + 云絮） ---- */
  var land=document.querySelector('.landscape');
  if(land){
    function wisps(px,py){
      for(var i=0;i<3;i++){
        (function(i){
          later(function(){
            var w=document.createElement('span');w.className='wisp';
            var sz=12+Math.random()*10;
            w.style.width=sz.toFixed(0)+'px';w.style.height=(sz*0.72).toFixed(0)+'px';
            w.style.left=px+'px';w.style.top=py+'px';
            w.style.setProperty('--wx',((i-1)*16+(Math.random()*10-5)).toFixed(0)+'px');
            w.style.setProperty('--wy',(38+Math.random()*20).toFixed(0)+'px');
            land.appendChild(w);
            later(function(){w.remove()},1400);
          },i*130);
        })(i);
      }
    }
    [].forEach.call(document.querySelectorAll('.cl'),function(cl){
      on(cl,'click',function(e){
        var r=land.getBoundingClientRect();
        wisps(e.clientX-r.left+(Math.random()*14-7),e.clientY-r.top);
        var t=cl.hasAttribute('transform')?cl.parentNode:cl;
        t.classList.remove('bounce');void t.getBoundingClientRect();t.classList.add('bounce');
      });
    });
    on(document,'animationend',function(e){
      if(e.animationName==='clBounce')e.target.classList.remove('bounce');
    },true);
  }

  /* ---- 子页小节标题吸顶态（静态透明融入渐变，贴住吸顶线才显示磨砂底） ---- */
  var heads=[].slice.call(document.querySelectorAll('.sec-head'));
  if(heads.length){
    var TOP=58;
    function chkHeads(){
      heads.forEach(function(h){
        var r=h.getBoundingClientRect();
        h.classList.toggle('stuck',r.top<=TOP+1&&r.bottom>TOP);
      });
    }
    on(window,'scroll',chkHeads,{passive:true});
    on(window,'resize',chkHeads,{passive:true});
    chkHeads();
  }

  /* ---- 邮件复制 ---- */
  var btn=document.getElementById('mailBtn');
  if(btn){
    var mail=btn.getAttribute('data-mail')||btn.textContent.trim();
    var label=btn.querySelector('b');   /* c-chip 结构：只改地址文本，图标与结构不动 */
    on(btn,'click',function(){
      function done(){
        if(!label){var t=btn.textContent;btn.textContent='已复制到剪贴板';later(function(){btn.textContent=t},1800);return}
        var t2=label.textContent;label.textContent='已复制到剪贴板';later(function(){label.textContent=t2},1800);
      }
      if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(mail).then(done,done)}
      else{var i=document.createElement('textarea');i.value=mail;i.style.position='fixed';i.style.opacity='0';
        document.body.appendChild(i);i.select();try{document.execCommand('copy')}catch(e){}i.remove();done()}
    });
  }

  return {
    destroy:function(){
      listeners.forEach(function(l){l[0].removeEventListener(l[1],l[2],l[3])});
      timeouts.forEach(clearTimeout);
      if(iv)iv.stop();
      scrEls.forEach(function(el){
        if(el.__scr){cancelAnimationFrame(el.__scr);el.__scr=0}
        if(el.__parts)el.__parts.forEach(function(pt){pt.node.nodeValue=pt.text});  /* 中断时还原原文（保留内联结构） */
      });
      cntEls.forEach(function(el){
        if(el.__cnt){cancelAnimationFrame(el.__cnt);el.__cnt=0}
        if(el.__cntTo)el.textContent=el.__cntTo;
      });
    }
  };
}

return {init:init};
})();
