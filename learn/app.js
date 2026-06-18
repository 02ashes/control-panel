/* Обучалка чаттера. Личность — ник аккаунта (из админ-панели, localStorage 'nickname').
   Уроки приходят с сервера БЕЗ правильных ответов; тест проверяется на сервере и пишет прогресс.
   Разблокировка уроков — по серверному прогрессу (подделать через localStorage нельзя). */
(function(){
  const app = document.getElementById('app');
  const crumbs = document.getElementById('crumbs');
  const h1 = document.getElementById('title');
  const bar = document.getElementById('bar');

  const NICK = (localStorage.getItem('nickname') || '').trim();

  let L = [];               // очищенные уроки с сервера
  let DONE = new Set();     // id сданных уроков (с сервера)
  const passedCache = {};   // 'lesson:qindex' -> true: паста уже зачтена в этой сессии (чтобы не гонять Grok повторно при перезаходе в тест)

  function esc(s){ return String(s==null?'':s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  function shuffle(a){ a=a.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
  function setProgress(p){ bar.style.width = Math.max(0,Math.min(100,p)) + '%'; }

  /* ---- сетевой помощник: всегда шлём ник аккаунта ---- */
  async function api(path, opts){
    opts = opts || {};
    const headers = Object.assign({ 'X-Nickname': NICK }, opts.headers || {});
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    return fetch(path, Object.assign({}, opts, { headers }));
  }

  /* ---- прогресс / разблокировка (источник правды — сервер) ---- */
  async function refreshProgress(){
    try{ const r = await api('/api/training/progress'); if(r.ok){ const d = await r.json(); DONE = new Set(d.passed || []); } }catch(e){}
  }
  function idxOf(id){ return L.findIndex(x=>x.id===id); }
  function unlocked(id){ const i=idxOf(id); return i===0 || (i>0 && DONE.has(L[i-1].id)); }
  function nextId(id){ const i=idxOf(id); return (i>=0 && i+1<L.length) ? L[i+1].id : null; }

  /* ---- навигация ---- */
  function go(id){ const u=new URL(location.href); if(id)u.searchParams.set('lesson',id); else u.searchParams.delete('lesson'); u.searchParams.delete('mode'); history.pushState({},'',u); route(); }
  function goTest(id){ const u=new URL(location.href); u.searchParams.set('lesson',id); u.searchParams.set('mode','test'); history.pushState({},'',u); route(); }
  window.addEventListener('popstate', route);

  /* ---------------- ЭКРАН: НУЖЕН ВХОД ---------------- */
  function renderNeedLogin(){
    crumbs.innerHTML='ОБУЧЕНИЕ ВОРКЕРА'; h1.textContent='Нужен вход';
    setProgress(0);
    app.innerHTML='<div class="card"><h2>Войди в аккаунт</h2>'
      +'<p>Обучение идёт под твоим ником. Сначала войди в панель — потом вернёшься сюда.</p>'
      +'<div class="nextbar" style="justify-content:flex-start"><a class="btn" href="/admin">Войти ▸</a></div></div>';
  }

  /* ---------------- МЕНЮ ---------------- */
  function renderMenu(){
    crumbs.innerHTML='ОБУЧЕНИЕ ВОРКЕРА · '+esc(NICK); h1.textContent='Программа';
    const done=L.filter(x=>DONE.has(x.id)).length;
    setProgress(L.length?Math.round(done/L.length*100):0);
    let html='<div class="menu">';
    L.forEach(l=>{
      const isDone=DONE.has(l.id), open=unlocked(l.id);
      const st = isDone ? '<span class="st ready">пройден ✓</span>'
        : open ? '<span class="st open">начать</span>'
        : '<span class="st soon">🔒</span>';
      html+='<button class="lcard'+(open?'':' lock')+'" data-go="'+(open?l.id:'')+'">'
        +'<span class="n">'+l.id+'</span>'
        +'<span class="tt"><b>'+esc(l.title)+'</b><span>'+esc(l.sub||'')+'</span></span>'
        +st+'</button>';
    });
    html+='</div><footer>пройдено '+done+' из '+L.length+(done===L.length&&L.length?' 🎉 курс пройден':'')+'</footer>';
    app.innerHTML=html;
    app.querySelectorAll('[data-go]').forEach(b=>{ const id=b.dataset.go; if(id) b.onclick=()=>go(+id); });
  }

  /* ---------------- УРОК (чтение) ---------------- */
  function renderRead(l){
    crumbs.innerHTML='<span class="back" id="back">‹ программа</span> · УРОК '+l.id;
    h1.textContent=l.title;
    setProgress(0);
    let html='<div class="kicker">Урок</div><div class="card">';
    (l.blocks||[]).forEach(b=>{
      if(b.type==='text') html+=(b.h?'<h2>'+esc(b.h)+'</h2>':'')+'<p>'+b.p+'</p>';
      else if(b.type==='shot') html+='<figure class="shot"><figcaption>'+esc(b.cap)+'</figcaption>'
        +'<img src="'+b.src+'" alt="'+esc(b.cap)+'">'+(b.note?'<div class="note">'+b.note+'</div>':'')+'</figure>';
      else if(b.type==='take'){ html+='<div class="take" style="margin-top:14px"><h3>Запомни</h3><ul>';
        b.items.forEach(i=>html+='<li><span>'+i+'</span></li>'); html+='</ul></div>'; }
      else if(b.type==='terms'){ html+='<div class="terms">';
        b.items.forEach(([t,d])=>html+='<div class="term"><b>'+esc(t)+'</b><span>'+esc(d)+'</span></div>'); html+='</div>'; }
    });
    html+='</div>';
    html+='<div class="nextbar"><button class="btn ghost" id="toMenu">‹ к программе</button>'
      +(l.quiz&&l.quiz.length?'<button class="btn" id="toTest">Пройти тест ▸</button>':'')+'</div>';
    app.innerHTML=html;
    document.getElementById('back').onclick=()=>go(null);
    document.getElementById('toMenu').onclick=()=>go(null);
    const tt=document.getElementById('toTest'); if(tt) tt.onclick=()=>goTest(l.id);
    window.scrollTo(0,0);
  }

  function renderVerdict(v,d){
    const cls=d.pass?'pass':'fail', label=d.pass?'зачёт':'доработай', c=d.criteria||{};
    const chips=Object.entries(c).map(([k,val])=>'<span>'+esc(k)+' <b>'+val+'/2</b></span>').join('');
    v.innerHTML='<div class="score '+cls+'">'+(d.score!=null?d.score:'?')+'<span style="font-size:15px"> /100 · '+label+'</span></div>'
      +'<div class="fb">'+esc(d.feedback||'')+'</div>'+(chips?'<div class="crit">'+chips+'</div>':'');
    v.classList.add('show');
  }

  /* ---------------- ТЕСТ (оценка на сервере) ---------------- */
  function renderTest(l){
    crumbs.innerHTML='<span class="back" id="exit">‹ выйти</span> · ТЕСТ (урок закрыт)';
    h1.textContent='Тест: '+l.title;
    const quiz=l.quiz||[];
    setProgress(0);

    app.innerHTML='<div class="kicker">Тест · отвечай сам, подсказок нет</div>'
      +'<div class="card" id="quiz"></div>'
      +'<div id="result"></div>'
      +'<div class="nextbar"><button class="btn ghost" id="exit2">‹ выйти</button>'
      +'<button class="btn" id="finish" disabled>Завершить тест</button></div>';
    const quizEl=document.getElementById('quiz');
    const finishBtn=document.getElementById('finish');
    const resultEl=document.getElementById('result');

    const cards=[];
    function refresh(){
      const answered=cards.filter(c=> c.type==='paste'? c.passed() : c.answered()).length;
      setProgress(Math.round(answered/quiz.length*100));
      finishBtn.disabled=answered<quiz.length;
    }

    function mcCard(q,i){
      const wrap=document.createElement('div'); wrap.className='q';
      wrap.innerHTML='<div class="q__t"><span class="num">'+(i+1)+'.</span> '+esc(q.q)+'</div>';
      const opts=shuffle(q.opts.slice());
      let pickedText=null;
      const btns=[];
      opts.forEach(t=>{
        const b=document.createElement('button'); b.className='opt'; b.type='button';
        b.innerHTML='<span class="mk"></span><span>'+esc(t)+'</span>';
        b.onclick=()=>{ btns.forEach(x=>{ x.dataset.sel='0'; x.querySelector('.mk').textContent=''; }); b.dataset.sel='1'; b.querySelector('.mk').textContent='✓'; pickedText=t; wrap.classList.remove('q--wrong'); refresh(); };
        btns.push(b); wrap.appendChild(b);
      });
      cards.push({ type:'mc', el:wrap,
        answered:()=>pickedText!==null,
        getAnswer:()=> pickedText!==null ? { i, choice:pickedText } : null,
        markWrong:()=>{ wrap.classList.add('q--wrong'); wrap.style.outline='2px solid var(--red)'; wrap.style.outlineOffset='6px'; wrap.style.borderRadius='12px'; }
      });
      return wrap;
    }

    function pasteCard(q,i){
      const wrap=document.createElement('div'); wrap.className='q';
      wrap.innerHTML='<div class="q__t"><span class="num">'+(i+1)+'.</span> '+q.q+'</div>'
        +'<textarea class="ta" maxlength="300" placeholder="'+esc(q.placeholder||'пиши руками...')+'"></textarea>'
        +'<div class="row"><button class="btn" type="button">Проверить</button><span class="hint">проверяет AI по рубрике</span></div>'
        +'<div class="verdict"></div>';
      const ta=wrap.querySelector('.ta'), btn=wrap.querySelector('.btn'), v=wrap.querySelector('.verdict');
      const ck=l.id+':'+i;
      let pass=passedCache[ck]===true;
      if(pass){ v.innerHTML='<div class="fb" style="color:var(--green)">✓ зачтено ранее</div>'; v.classList.add('show'); }
      btn.onclick=async()=>{
        const paste=ta.value.trim(); if(paste.length<4){ ta.focus(); return; }
        btn.disabled=true; btn.innerHTML='<span class="spin"></span>проверяю...'; v.classList.remove('show');
        try{
          const r=await api('/api/training/check-paste',{method:'POST',body:JSON.stringify({paste,lesson:l.id,qindex:i})});
          const d=await r.json(); if(d.error) throw new Error(d.error);
          renderVerdict(v,d); pass=!!d.pass; if(pass) passedCache[ck]=true; wrap.style.outline=''; refresh();
        }catch(e){ v.innerHTML='<div class="fb" style="color:var(--red)">Ошибка: '+esc(e.message||e)+'</div>'; v.classList.add('show'); }
        finally{ btn.disabled=false; btn.textContent='Проверить ещё раз'; }
      };
      cards.push({ type:'paste', el:wrap,
        passed:()=>pass===true,
        markWrong:()=>{ wrap.style.outline='2px solid var(--red)'; wrap.style.outlineOffset='6px'; wrap.style.borderRadius='12px'; }
      });
      return wrap;
    }

    quiz.forEach((q,i)=> quizEl.appendChild(q.type==='paste'?pasteCard(q,i):mcCard(q,i)));
    document.getElementById('exit').onclick=()=>go(null);
    document.getElementById('exit2').onclick=()=>go(null);

    finishBtn.onclick=async()=>{
      finishBtn.disabled=true;
      const mc=[];
      cards.forEach(c=>{ if(c.type==='mc'){ const a=c.getAnswer(); if(a) mc.push(a); } });
      let d;
      try{ const r=await api('/api/training/submit',{method:'POST',body:JSON.stringify({lesson:l.id, mc})}); d=await r.json(); }
      catch(e){ d={error:'нет связи с сервером'}; }

      if(d.error){
        resultEl.innerHTML='<div class="verdict show"><div class="fb" style="color:var(--red)">Ошибка: '+esc(d.error)+'</div></div>';
        finishBtn.disabled=false; return;
      }

      if(d.passed){
        await refreshProgress();
        const nx=d.nextLesson;
        resultEl.innerHTML='<div class="verdict show"><div class="score pass">Урок пройден ✓ <span style="font-size:15px">'+d.correct+'/'+d.total+'</span></div>'
          +'<div class="fb">'+(d.courseDone?'Это был последний урок. Поздравляю 🎉 Курс пройден.':(nx?'Следующий урок открыт.':'Готово.'))+'</div></div>';
        finishBtn.style.display='none';
        const nb=document.createElement('button'); nb.className='btn'; nb.style.cssText='width:100%;margin-top:12px';
        nb.textContent=nx?'Следующий урок ▸':'К программе ▸'; nb.onclick=()=> nx?go(nx):go(null);
        resultEl.appendChild(nb); setProgress(100); window.scrollTo(0,document.body.scrollHeight);
      } else {
        (d.wrong||[]).forEach(i=>{ const c=cards[i]; if(c&&c.markWrong) c.markWrong(); });
        resultEl.innerHTML='<div class="verdict show"><div class="score fail">Не сдал · '+d.correct+'/'+d.total+'<span style="font-size:15px"> верно</span></div>'
          +'<div class="fb">Ошибки отмечены красным. Перечитай урок и пройди заново — варианты перемешаются.</div></div>';
        const rb=document.createElement('button'); rb.className='btn'; rb.style.cssText='width:100%;margin-top:12px';
        rb.textContent='Пройти заново ▸'; rb.onclick=()=>renderTest(l); resultEl.appendChild(rb);
        const rr=document.createElement('button'); rr.className='btn ghost'; rr.style.cssText='width:100%;margin-top:8px';
        rr.textContent='‹ перечитать урок'; rr.onclick=()=>go(l.id); resultEl.appendChild(rr);
        window.scrollTo(0,document.body.scrollHeight);
      }
    };

    refresh(); window.scrollTo(0,0);
  }

  /* ---------------- роутер ---------------- */
  function route(){
    const sp=new URL(location.href).searchParams;
    const id=+sp.get('lesson')||0, mode=sp.get('mode');
    const l=L.find(x=>x.id===id);
    if(!l || !unlocked(id)){ renderMenu(); return; }   // закрытый урок -> в меню
    if(mode==='test' && l.quiz && l.quiz.length) renderTest(l); else renderRead(l);
  }

  /* ---------------- старт ---------------- */
  (async function init(){
    if(!NICK){ renderNeedLogin(); return; }
    crumbs.innerHTML='ОБУЧЕНИЕ ВОРКЕРА'; h1.textContent='Загрузка…'; setProgress(0);
    try{
      const lr=await api('/api/training/lessons');
      if(lr.status===401 || lr.status===403){ renderNeedLogin(); return; }
      const ld=await lr.json(); L=ld.lessons||[];
    }catch(e){ app.innerHTML='<div class="card"><p>Не удалось загрузить уроки. Обнови страницу.</p></div>'; return; }
    await refreshProgress();
    route();
  })();
})();
