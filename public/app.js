import {icon} from './icons.js';
import { choice, filePicker, player } from './controls.js';
const $=(selector)=>document.querySelector(selector);
const main=$('#main'), dialog=$('#dialog'), content=$('#dialog-body'), warning=$('#dialog-error');
const state={me:null, providers:{}, view:'welcome', id:'', mode:'all', filter:'', groups:[], posts:new Map(), comments:new Set(), renderToken:0};
const nav=[['feed','Лента','feed'],['people','Друзья','people'],['groups','Сообщества','groups'],
  ['bookmarks','Закладки','bookmark'],['audio','Музыка','music'],['video','Видео','video'],['photo','Фотографии','photo'],['wiki','Статьи и Wiki','book'],['regions','Регионы','globe'],['governance','Синклит','people'],['settings','Настройки','settings']];
const kinds={photo:'Фото',audio:'Музыка',video:'Видео',article:'Статья'};
const privacy={public:'Публичная',members:'Участники',friends:'Друзья',private:'Только я'};
const fileTypes={photo:'image/jpeg,image/png,image/webp',audio:'audio/mpeg,audio/ogg,audio/wav,audio/x-wav',video:'video/mp4,video/webm'};
const modes={all:'Все записи',social:'Подписки',groups:'Сообщества',work:'Произведения'};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const uri=encodeURIComponent;
const link=(view,id)=>'#'+view+(id?'/'+uri(id):'');
const params=values=>new URLSearchParams(Object.entries(values).filter(([,v])=>v));
const time=value=>new Intl.DateTimeFormat('ru',{day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}).format(value);
const btn=(key,text,{symbol='',css='btn',data='',label=''}={})=>'<button type="button" class="'+css+'" data-action="'+key+'" '+data+(label?' aria-label="'+escape(label)+'"':'')+'>'+(symbol?icon(symbol,17):'')+escape(text)+'</button>';
const idAttr=id=>'data-id="'+escape(id)+'"';
const empty=text=>'<p class="panel empty">'+escape(text)+'</p>';
const heading=(title,note='',tools='')=>'<div class="heading"><div><h1>'+escape(title)+'</h1>'+(note?'<p>'+escape(note)+'</p>':'')+'</div>'+tools+'</div>';
function avatar(subject,style=''){
  const color=['blue','violet','amber','mint'].includes(subject?.color)?subject.color:'mint';
  const initials=(subject?.name||'').split(/\s+/).slice(0,2).map(word=>[...word][0]).join('');
  return '<span class="avatar '+color+' '+style+'" aria-hidden="true">'+(escape(initials)||icon('user'))+'</span>';
}
async function api(path,method='GET',body){
  const options={method};
  if(body!==undefined){options.headers={'Content-Type':'application/json'}; options.body=JSON.stringify(body);}
  const response=await fetch('/api/'+path,options);
  const data=await response.json();
  if(!response.ok) throw new Error(data.error||'Не удалось выполнить запрос.');
  return data;
}
let timer;
function tell(message){
  $('#toast').textContent=message;
  clearTimeout(timer);
  timer=setTimeout(()=>{$('#toast').textContent='';},3600);
}
function open(title,html){
  $('#dialog-title').textContent=title;
  content.innerHTML=html;
  warning.hidden=true;
  if(!dialog.open) dialog.showModal();
}
function navItem([page,title,symbol]){
  const selected=state.view===page || page==='groups'&&state.view==='group';
  return '<a href="'+link(page)+'"'+(selected?' aria-current="page"':'')+'>'+icon(symbol)+'<span>'+title+'</span></a>';
}
const authPages = new Set(['welcome','login','register']);

function navigation(){
  $('#navigation').innerHTML=nav.map(entry=>(['audio','regions'].includes(entry[0])?'<div class="nav-divider"></div>':'')+navItem(entry)).join('')+
    btn('compose','Новая запись',{css:'btn primary rail-compose',symbol:'plus'});
  $('#mobile').innerHTML=navItem(nav[0])+navItem(nav[1])+btn('compose','Создать',{css:'create',symbol:'plus'})+navItem(['groups','Группы','groups'])+navItem(['profile','Профиль','user']);
  $('#account').innerHTML=state.me
    ? '<button type="button" class="btn logged" data-action="account" aria-label="Меню профиля">'+avatar(state.me,'round')+'<span class="account-name">'+escape(state.me.name)+'</span>'+icon('caret',15)+'</button>'
    : '<a class="btn header-entry" href="'+link(state.view==='login'?'register':'login')+'">'+(state.view==='login'?'Регистрация':'Войти')+'</a>';
}
function governanceView(data) {
  const title=heading('Синклит и Триумвират','Общие для всех Регионов CeZeOs');
  if (!data.available) return title+empty('Общий сервер управления пока недоступен.');
  const seats=data.triumvirs.length?data.triumvirs.map(person=>row(
    '<strong>@'+escape(person.nickname)+'</strong>'+
    '<span class="muted small">'+(person.verified?'Aquamarine подтверждён':'Ожидает подтверждения Aquamarine')+'</span>'
  )).join(''):'<p class="muted">Состав Триумвирата ещё не задан.</p>';
  const tri=panel('<h2>Триумвират</h2>'+seats);
  const summary='<h2>Синклит</h2><p class="muted small">Участников: '+data.members+'</p>';
  if (!data.local) {
    return title+stack(tri+panel(summary+'<p class="muted">Заявки и голосование доступны на общем сервере управления.</p>'+
      row('<a class="btn primary" href="'+escape(data.home)+'/#governance">Перейти в Синклит</a>')));
  }

  const { roles, application, applications, cases }=data;
  const statuses={pending:'На рассмотрении',approved:'Принята',rejected:'Отклонена',withdrawn:'Отозвана'};
  let recruitment='';
  if (roles.synclit) recruitment='<p>Вы участник Синклита.</p>'+row(btn('case-create','Внести дело',{css:'btn primary'}));
  else if (roles.triumvir) recruitment='<p class="muted">Здесь можно рассматривать заявки и голосовать по делам.</p>';
  else if (!state.me) recruitment=row(btn('account','Войти, чтобы подать заявку',{css:'btn primary'}));
  else {
    const status=application?'<p>Ваша заявка: '+statuses[application.status]+'</p>':'';
    const control=application?.status==='pending'
      ? btn('application-withdraw','Отозвать заявку',{data:idAttr(application.id)})
      : btn('application-create','Подать заявку',{css:'btn primary'});
    recruitment=status+row(control);
  }

  const votes=(item,key,yes,no)=>row(
    btn(key,yes,{data:idAttr(item.id)+' data-active="true"',css:'btn primary'})+
    btn(key,no,{data:idAttr(item.id)+' data-active="false"'}));
  const tally=item=>'<p class="muted small">За: '+item.for+' · Против: '+item.against+'</p>';
  const reviews=roles.triumvir?'<h2>Заявки в Синклит</h2>'+
    (applications.map(item=>panel('<h3>'+escape(item.name)+'</h3><p class="muted small">@'+escape(item.handle)+'</p>'+
      '<p class="preline">'+escape(item.body)+'</p>'+tally(item)+
      (item.voted?'<p class="muted small">Ваш голос учтён.</p>':votes(item,'application-vote','Принять','Отклонить'))
    )).join('')||empty('Заявок на рассмотрении нет.')):'';
  const details=cases.map(item=>panel('<h3>'+escape(item.title)+'</h3><p class="muted small">'+
    ({pending:'На голосовании',approved:'Одобрено',rejected:'Отклонено'})[item.status]+'</p>'+
    '<p class="preline">'+escape(item.body)+'</p>'+tally(item)+
    (roles.triumvir && item.status==='pending' && !item.voted && item.author!==state.me?.id ? votes(item,'case-vote','За','Против'):'')
  )).join('');
  return title+stack(tri+panel(summary+recruitment)+reviews+(details?'<h2>Дела Синклита</h2>'+details:''));
}

function regionsView(data) {
  const local=panel('<h2>'+escape(data.local.name)+'</h2><p class="muted small">Текущий Регион</p>'+
    '<p class="region-id small">'+escape(data.local.id)+'</p>');
  const remote=data.peers.map(peer=>panel('<h3>'+escape(peer.name||peer.origin)+'</h3>'+
    '<p class="muted small">'+(peer.available?'Подпись подтверждена':'Недоступен или подпись не подтверждена')+'</p>'+
    (peer.available?'<a class="btn" href="'+link('regions',peer.id)+'">Публичные записи</a>':''))).join('');
  return heading('Регионы')+stack(local+'<h2>Доверенные Регионы</h2>'+
    (remote||empty('Другие Регионы ещё не подключены.')));
}

function aquaStatus(data) {
  if (!state.me) return '<p class="muted">Войдите, чтобы подключить Aquamarine.</p>';
  if (data.linked) return row('<span class="ecosystem-badge">'+icon('check',16)+'Aquamarine подключён</span>'+
    (data.available?btn('aqua-link','Обновить подтверждение Aquamarine')+btn('aqua-grant','Подтверждение для Aquamarine'):'')+btn('aqua-unlink','Отключить'));
  if (!data.available) return '<p class="muted">В этом Регионе подтверждение Aquamarine пока не настроено.</p>';
  return '<p class="muted">После подтверждения в профиле появится отметка Aquamarine.</p>'+
    row(btn('aqua-link','Подключить Aquamarine',{css:'btn primary'}));
}

function groupLink(group){
  return '<a class="list-item" href="'+link('group',group.id)+'">'+avatar(group)+'<div><div class="list-title">'+escape(group.name)+'</div><small class="muted">'+escape(group.closed?'Закрытое сообщество':group.bio)+'</small></div></a>';
}
function sidebar(){
  $('#sidebar').innerHTML='<section class="panel side-card"><h2>Сообщества</h2>'+state.groups.slice(0,3).map(groupLink).join('')+
    '<a href="#groups">Все сообщества</a></section><a class="panel side-wiki" href="#wiki">'+icon('book')+'<div><div class="list-title">Энциклопедия</div><small>История и проекты CeZeOs</small></div></a>';
}
function composeCard(group=''){
  const data='data-group="'+escape(group)+'"';
  return '<section class="panel composer"><div class="composer-line">'+avatar(state.me,'round')+btn('compose','Что нового?',{css:'composer-start',data})+
    btn('compose','Новая запись',{css:'btn primary',symbol:'plus',data})+'</div><div class="composer-tools">'+
    [['photo','photo'],['audio','music'],['video','video'],['article','book']].map(([key,symbol])=>btn('compose',kinds[key],{css:'ghost',symbol,data:data+' data-kind="'+key+'"'})).join('')+'</div></section>';
}
function media(post){
  const title=post.title;
  const credit=[post.credit,post.work_type==='Оригинал'?'':post.work_type].filter(Boolean).join(' · ');
  if(post.kind==='photo') return '<figure class="photo"><img src="'+escape(post.media)+'" alt="'+escape(title)+'"><figcaption>'+escape(title)+' · '+escape(credit)+'</figcaption></figure>';
  if(['audio','video'].includes(post.kind)) return player(post.kind,post.media,title,credit);
  return '';
}
function postCard(post){
  const data=idAttr(post.id), person=post.profile;
  const detail=(post.group?'<a href="'+link('group',post.group.id)+'">'+escape(post.group.name)+'</a> · ':'')+
    '<a class="post-permalink" href="'+link('post',post.id)+'" aria-label="Открыть обсуждение публикации"><time datetime="'+new Date(post.created).toISOString()+'">'+time(post.created)+'</time></a>'+
    (post.pinned?' · Закреплено':'')+(post.visibility==='public'?'':' · '+privacy[post.visibility]);
  const reaction=btn('like',post.likes,{symbol:'heart',css:'ghost'+(post.liked?' liked':''),data:data+' aria-pressed="'+post.liked+'"',label:post.liked?'Убрать реакцию':'Поставить реакцию'});
  const controls=(person.id===state.me?.id?btn('post-menu','',{symbol:'more',css:'icon-button',data,label:'Действия с записью'}):'');
  return '<article class="post" id="post-'+escape(post.id)+'"><div class="post-inner"><div class="post-top">'+avatar(person,'round')+
    '<div class="identity"><a href="'+link('profile',person.id)+'">'+escape(person.name)+'</a><div class="post-info">'+detail+'</div></div>'+controls+'</div>'+
    (post.kind==='article'?'<h3 class="post-copy">'+escape(post.title)+'</h3>':'')+
    (post.body?'<p class="post-copy preline">'+escape(post.body)+'</p>':'')+media(post)+'<div class="post-actions">'+reaction+
    btn('comments',post.comments,{symbol:'comment',css:'ghost',data:data+' aria-expanded="'+state.comments.has(post.id)+'"',label:'Комментарии'})+
    btn('bookmark','',{symbol:'bookmark',css:'ghost'+(post.bookmarked?' bookmarked':''),data:data+' aria-pressed="'+post.bookmarked+'"',label:post.bookmarked?'Убрать из закладок':'Сохранить в закладки'})+
    btn('share','',{symbol:'link',css:'ghost',data,label:'Ссылка на публикацию'})+'</div></div><div class="comments" id="comments-'+escape(post.id)+'" hidden></div></article>';
}
function postList(posts){
  if(!posts.length) return empty('Здесь пока нет публикаций.');
  return '<div class="stack">'+posts.map(postCard).join('')+'</div>';
}
function peopleList(people){
  if(!people.length) return empty('Никого не найдено.');
  return '<div class="panel panel-pad">'+people.map(person=>'<a class="list-item" href="'+link('profile',person.id)+'">'+avatar(person,'round')+'<div><div class="list-title">'+escape(person.name)+'</div><div class="muted small">@'+escape(person.handle)+(person.following?' · Вы подписаны':'')+(person.friendship?.recipient===state.me?.id&&person.friendship?.status==='pending'?' · Заявка в друзья':'')+'</div></div></a>').join('')+'</div>';
}
const stack=html=>'<div class="stack">'+html+'</div>';
const panel=html=>'<section class="panel panel-pad stack">'+html+'</section>';
const row=html=>'<div class="row">'+html+'</div>';
const hero=(subject,detail,controls)=>'<section class="panel hero"><div class="hero-banner"></div><div class="hero-content">'+avatar(subject,'big')+
  '<h1>'+escape(subject.name)+'</h1>'+(subject.aquamarine?'<span class="ecosystem-badge">'+icon('check',16)+'Aquamarine</span>':'')+'<p class="muted small">'+escape(detail)+'</p><p class="preline">'+escape(subject.bio)+'</p>'+row(controls)+'</div></section>';
function providerOption(key, name, symbol) {
  const mark=key==='aquamarine'?'<img src="/assets/aquamarine.png" width="22" height="22" alt="">':icon(symbol,22);
  const label='<span>'+name+'</span>';
  if(state.providers[key]) return '<a class="btn provider" href="/api/auth/'+key+'/start">'+mark+label+'</a>';
  return '<button type="button" class="btn provider" disabled aria-label="'+name+' — требуется подключение">'+mark+label+'<span class="provider-note">Требуется подключение</span></button>';
}

function welcome(page){
  const signIn=page==='login';
  const error=new URLSearchParams(location.search).get('auth');
  const message=error==='cancelled'?'Вход отменён. Можно попробовать снова.':
    error==='failed'?'Не удалось завершить вход. Попробуйте снова.':'';
  const panelTitle=signIn?'Войти в CeZeOs':'Создать аккаунт';
  const switchPage=signIn?'register':'login';
  const switchLabel=signIn?'Создать аккаунт':'Войти';
  return '<div class="welcome-layout">'+
    '<section class="welcome-intro"><div class="welcome-emblem" aria-hidden="true"><span class="orbit orbit-inner"></span><span class="orbit orbit-outer"></span><img src="/assets/icon.svg" alt="" width="88" height="88"></div>'+
    '<h1>Свобода искусства.<br><span>Свобода души.</span></h1>'+
    '<p>CeZeOs — независимая сеть для людей, которые создают и сохраняют музыку, фотографии, видео и тексты.</p></section>'+
    '<section class="panel welcome-account" aria-labelledby="entry-heading"><h2 id="entry-heading">'+panelTitle+'</h2>'+
    '<p class="muted welcome-account-note">'+(signIn?'Выберите сервис, с которым связан ваш аккаунт.':'Выберите сервис для регистрации.')+'</p>'+
    (message?'<p class="form-error" role="alert">'+message+'</p>':'')+
    '<div class="providers">'+providerOption('aquamarine','Aquamarine','user')+providerOption('telegram','Telegram','telegram')+'</div>'+
    '<div class="welcome-other"><span>'+ (signIn?'Впервые здесь?':'Уже есть аккаунт?') +'</span> <a href="'+link(switchPage)+'">'+switchLabel+'</a></div>'+
    '<div class="welcome-preview"><a class="btn" href="#feed">'+icon('feed',17)+'Смотреть ленту</a>'+
    (state.providers.demo?btn('demo','Деморежим',{css:'ghost'}):'')+'</div></section></div>';
}
function mobileSections(){
  const links=nav.slice(3).map(([page,title,symbol])=>'<a class="list-item" href="'+link(page)+'">'+icon(symbol)+'<span>'+title+'</span></a>').join('');
  return '<nav class="mobile-sections" aria-label="Другие разделы">'+panel(links)+'</nav>';
}
async function view(page,id){
  if(authPages.has(page)) return {html:welcome(page)};
  const posts=async values=>{
    const list=await api('posts?'+params(values));
    return {list, html:postList(list)};
  };
  if(page==='feed'){
    const result=await posts({mode:state.mode,kind:state.filter});
    const filters=[['','Все'],...Object.entries(kinds).map(([key,title])=>[key,key==='article'?'Статьи':title])];
    const chips=filters.map(([key,title])=>btn('filter',title,{css:'chip',data:'data-key="'+key+'" aria-pressed="'+(state.filter===key)+'"'})).join('');
    const tabs=Object.entries(modes).map(([mode,label])=>btn('timeline',label,{
      css:'timeline-tab',data:'data-key="'+mode+'" aria-pressed="'+(mode===state.mode)+'"'
    })).join('');
    const signIn=state.mode==='social'&&!state.me;
    const entries=signIn?panel('<p>Войдите, чтобы читать записи друзей и авторов, на которых вы подписаны.</p>'+
      row(btn('account','Войти',{css:'btn primary'}))):result.html;
    return {list:result.list,html:heading('Моя лента')+'<div class="panel timeline-tabs" role="group" aria-label="Режим ленты">'+tabs+'</div>'+
      composeCard()+'<div class="stream-bar"><div class="chips" aria-label="Тип публикации">'+chips+'</div></div>'+entries};
  }
  if(['audio','video','photo'].includes(page)){
    const result=await posts({kind:page});
    const title=nav.find(entry=>entry[0]===page)[1];
    return {list:result.list,html:heading(title,'',btn('compose','Добавить',{symbol:'plus',css:'btn primary',data:'data-kind="'+page+'"'}))+result.html};
  }
  if(page==='people') return {html:heading('Друзья','Люди, подписки и заявки в друзья')+peopleList(await api('profiles'))};
  if(page==='groups') return {html:heading('Сообщества','',btn('group-create','Создать',{symbol:'plus',css:'btn primary'}))+panel((await api('groups')).map(groupLink).join(''))};
  if(page==='group'){
    const [group,result]=await Promise.all([api('groups/'+uri(id)),posts({group:id})]);
    const owner=group.owner===state.me?.id, member=group.membership==='member', pending=group.membership==='pending';
    const tools=owner?'<span class="muted small">Вы администратор</span>':btn('group-join',pending?'Отозвать заявку':member?'Выйти':group.closed?'Подать заявку':'Вступить',
      {css:'btn primary',data:idAttr(id)+' data-active="'+(!member&&!pending)+'"'});
    const requests=group.requests?.length?panel('<h2>Заявки на вступление</h2>'+group.requests.map(person=>row(avatar(person,'round')+escape(person.name)+[true,false].map(ok=>
      btn('group-request',ok?'Принять':'Отклонить',{data:idAttr(id)+' data-user="'+escape(person.id)+'" data-active="'+ok+'"'})).join(''))).join('')):'';
    return {list:result.list,html:hero(group,(group.closed?'Закрытое':'Открытое')+' сообщество · Участники: '+group.size,tools)+
      (member?composeCard(id):'')+stack(requests+(group.closed&&!member?empty('Стена доступна участникам сообщества.'):result.html))};
  }
  if(page==='profile'){
    const target=id||state.me?.id;
    if(!target) return {html:heading('Мой профиль')+stack(panel('<p>Войдите, чтобы открыть профиль и публиковать записи.</p>'+row(btn('account','Войти',{css:'btn primary'})))+mobileSections())};
    const [person,result]=await Promise.all([api('profiles/'+uri(target)),posts({author:target})]);
    const own=target===state.me?.id, edge=person.friendship, data=idAttr(target);
    const incoming=edge?.recipient===state.me?.id&&edge?.status==='pending';
    const command=!edge?'request':incoming?'accept':'remove';
    const caption=!edge?'Добавить в друзья':incoming?'Принять заявку':edge.status==='pending'?'Отменить заявку':'Удалить из друзей';
    const tools=own?btn('profile-edit','Редактировать',{symbol:'pen'}):
      btn('follow',person.following?'Отписаться':'Подписаться',{css:'btn primary',data:data+' data-active="'+!person.following+'"'})+
      btn('friend',caption,{data:data+' data-key="'+command+'"'})+(incoming?btn('friend','Отклонить',{data:data+' data-key="remove"'}):'');
    return {list:result.list,html:hero(person,'@'+person.handle,tools)+(own?mobileSections()+composeCard():'')+result.html};
  }
  if(page==='wiki'&&!id){
    const [entries,result]=await Promise.all([api('wiki'),posts({kind:'article'})]);
    const catalog=entries.map(item=>'<a class="list-item" href="'+link('wiki',item.id)+'"><span class="avatar">'+icon('book')+'</span><div><strong>'+escape(item.title)+'</strong><div class="muted small">'+escape(item.category)+'</div></div></a>').join('');
    return {list:result.list,html:heading('Статьи и Wiki','',btn('wiki-edit','Новая статья',{css:'btn primary',symbol:'plus'}))+stack(panel(catalog)+'<h2>Статьи участников</h2>'+result.html)};
  }
  if(page==='wiki'){
    const [entry]=await api('wiki/'+uri(id));
    const data=idAttr(id);
    return {html:heading(entry.title,entry.category)+panel('<p class="preline">'+escape(entry.body)+'</p>'+
      row(btn('wiki-edit','Редактировать',{symbol:'pen',data})+btn('wiki-history','История',{symbol:'clock',data}))+
      '<p class="muted small">Версия '+entry.revision+' · '+escape(entry.profile.name)+' · '+time(entry.created)+'</p>')};
  }
  if(page==='search'){
    const [people,groups,result]=await Promise.all([api('profiles?'+params({q:id})),api('groups'),posts({q:id})]);
    const matches=groups.filter(group=>[group.name,group.bio].some(text=>text.toLowerCase().includes(id.toLowerCase())));
    return {list:result.list,html:heading('Поиск',id)+stack('<h2>Люди</h2>'+peopleList(people)+'<h2>Сообщества</h2>'+
      (matches.length?panel(matches.map(groupLink).join('')):empty('Сообщества не найдены.'))+'<h2>Публикации</h2>'+result.html)};
  }
  if(page==='bookmarks'){
    if(!state.me) return {html:heading('Закладки')+panel('<p>Войдите, чтобы сохранять публикации.</p>'+row(btn('account','Войти',{css:'btn primary'})))};
    const list=await api('bookmarks');
    return {list,html:heading('Закладки','Сохранённые публикации видны только вам')+
      (list.length?postList(list):empty('У вас пока нет сохранённых публикаций.'))};
  }
  if(page==='post'){
    const entry=await api('posts/'+uri(id));
    state.comments.add(entry.id);
    return {list:[entry],html:heading('Обсуждение','', '<a class="btn" href="#feed">К ленте</a>')+postList([entry])};
  }
  if(page==='settings') return {html:heading('Настройки')+stack(panel('<h2>Профиль и вход</h2>'+
    row(btn('account',state.me?'Меню профиля':'Войти',{css:'btn primary'})+(state.me?btn('profile-edit','Редактировать профиль'):'')))+
    panel('<h2>Aquamarine</h2>'+aquaStatus(await api('ecosystem/aquamarine'))))};
  if(page==='governance') return {html:governanceView(await api('governance'))};
  if(page==='regions'&&!id) return {html:regionsView(await api('regions'))};
  if(page==='regions') {
    const remote=await api('regions/'+uri(id));
    const items=remote.posts.map(item=>panel(
      '<h3>'+escape(item.title||item.author)+'</h3>'+
      '<p class="small muted">'+escape(item.author)+' · '+time(item.created)+'</p>'+
      '<p class="preline">'+escape(item.body)+'</p>'+
      '<a class="btn" href="'+escape(remote.origin)+'/#post/'+uri(item.id)+'" rel="noopener noreferrer">Открыть оригинал</a>'
    )).join('');
    return {html:heading(remote.name,'Публичные записи')+stack(items||empty('Публичных записей пока нет.'))};
  }
  return {html:heading('Страница не найдена')+'<a class="btn" href="#feed">Открыть ленту</a>'};
}
async function render(){
  const token=++state.renderToken;
  const [page,id]=location.hash.slice(1).split('/');
  state.view=page||(state.me?'feed':'welcome');
  if(state.me&&authPages.has(state.view)) state.view='feed';
  document.body.classList.toggle('auth-page',authPages.has(state.view));
  try {state.id=decodeURIComponent(id||'');}catch{state.id='';}
  navigation();
  main.setAttribute('aria-busy','true');
  try{
    const result=await view(state.view,state.id);
    if(token!==state.renderToken) return;
    state.posts=new Map((result.list||[]).map(post=>[post.id,post]));
    main.innerHTML=result.html;
    await Promise.all([...state.posts.keys()].filter(post=>state.comments.has(post)).map(post=>loadComments(post)));
  }catch(error){
    if(token===state.renderToken) main.innerHTML=heading('Не удалось открыть страницу')+empty(error.message);
  }finally{    if(token===state.renderToken){
      main.setAttribute('aria-busy','false');
      document.body.classList.remove('booting');
    }}
}
function go(page,id){
  const dest=link(page,id);
  if(location.hash===dest) return render();
  location.hash=dest;
}
const field=(name,title,attrs='',value='')=>'<label class="field">'+title+'<input name="'+name+'" '+attrs+' value="'+escape(value)+'"></label>';
const area=(name,title,attrs='',value='')=>'<label class="field">'+title+'<textarea name="'+name+'" '+attrs+'>'+escape(value)+'</textarea></label>';
const select=(name,title,values)=>'<div class="field">'+title+choice(name,title,values)+'</div>';
const form=(name,html,caption,data='')=>'<form id="'+name+'" class="field-grid" '+data+'>'+html+'<div class="dialog-actions"><button type="submit" class="btn primary">'+caption+'</button></div></form>';
function account(){
  if(!state.me) return go('login');
  return open('Мой аккаунт',stack(row(avatar(state.me,'round')+'<strong>'+escape(state.me.name)+'</strong>')+
    '<a class="btn" href="#profile" data-dialog-link>Мой профиль</a><a class="btn" href="#settings" data-dialog-link>Настройки</a>'+
    btn('logout','Выйти',{css:'btn danger'})));
}
function demo(){
  open('Демопрофиль',stack('<p class="muted">Профиль для проверки локальной версии CeZeOs.</p>'+
    form('demo-form',field('name','Имя в деморежиме','required maxlength="45" autocomplete="nickname" autofocus'),'Создать демопрофиль')));
}
function signedIn(){
  if(state.me) return true;
  account();
  return false;
}
function compose(kind='',group=''){
  if(!signedIn()) return;
  const isArticle=kind==='article', work=Object.hasOwn(kinds,kind);
  const credit=field('credit','Автор или исполнитель','maxlength="150" placeholder="Автор неизвестен"')+
      select('workType','Тип произведения',['Оригинал','Чужая запись','Кавер','Ремикс','Сэмпл','Совместная работа'].map(item=>[item,item]));
  const file=filePicker(fileTypes[kind]||Object.values(fileTypes).join(','));
  const title=field('title','Название','maxlength="120"'+(work?' required':''));
  const fields=(work?title:'')+area('body',isArticle?'Текст статьи':'Текст записи','maxlength="4000" placeholder="Что нового?"'+(isArticle?' required':''))+
      (isArticle?'':file+(work?credit:'<div class="field-grid" id="file-fields" hidden>'+title+credit+'</div>'))+
      select('visibility','Видимость',Object.entries(privacy));
  open('Новая запись',form('compose-form',fields,'Опубликовать','data-kind="'+escape(kind)+'" data-group="'+escape(group)+'"'));
}
async function loadComments(id){
  const target=document.getElementById('comments-'+id);
  if(!target) return;
  const comments=await api('posts/'+uri(id)+'/comments');
  if(!target.isConnected||!state.comments.has(id)) return;
  target.innerHTML=comments.map(comment=>'<div class="comment">'+avatar(comment.profile,'round')+
    '<div><h3>'+escape(comment.profile.name)+'</h3><p class="preline">'+escape(comment.body)+'</p><time class="small">'+time(comment.created)+'</time></div></div>').join('')+
    (state.me?'<form class="comment-form" data-post="'+escape(id)+'"><input name="body" aria-label="Комментарий" maxlength="1000" placeholder="Написать комментарий" required><button type="submit" class="btn">Отправить</button></form>':btn('account','Войдите, чтобы ответить'));
  target.hidden=false;
}
function editWiki(entry,latest=0){
  open(entry?'Редактировать статью':'Новая статья Wiki',form('wiki-form',
    field('title','Название','required maxlength="120"',entry?.title)+field('category','Категория','maxlength="60"',entry?.category)+
    area('body','Текст статьи','required maxlength="12000"',entry?.body),'Сохранить',idAttr(entry?.id||'')+' data-revision="'+latest+'"'));
}
async function perform(key,data){
  const id=data.id?uri(data.id):'';
  switch(key){
    case 'account': return account();
    case 'demo': return demo();
    case 'compose': return compose(data.kind,data.group);
    case 'timeline':
      state.mode=data.key;
      await render();
      $('.timeline-tab[aria-pressed="true"]')?.focus();
      return;
    case 'filter':
      state.filter=data.key;
      await render();
      $('.chip[aria-pressed="true"]')?.focus();
      return;
    case 'comments': {
      if(state.view==='post') {
        const area=document.getElementById('comments-'+data.id);
        (area?.querySelector('input,button')||area)?.focus();
        return;
      }
      const button=$('#post-'+CSS.escape(data.id)+' [data-action="comments"]');
      if(state.comments.delete(data.id)){
        document.getElementById('comments-'+data.id).hidden=true;
        button.setAttribute('aria-expanded','false');
      }else{
        state.comments.add(data.id);
        button.setAttribute('aria-expanded','true');
        await loadComments(data.id);
      }
      return;
    }
    case 'share': {
      const url=new URL(link('post',data.id),location.href).href;
      try{await navigator.clipboard.writeText(url);return tell('Ссылка скопирована.');}catch{}
      return open('Ссылка на публикацию',field('url','Ссылка','readonly',url));
    }
    case 'wiki-history': {
      const versions=await api('wiki/'+id);
      return open('История статьи',stack(versions.map(version=>row(
        '<span>Версия '+version.revision+' · '+escape(version.profile.name)+' · '+time(version.created)+'</span>'+
        btn('wiki-version','Открыть',{data:idAttr(data.id)+' data-key="'+version.revision+'"'}))).join('')));
    }
    case 'wiki-version': {
      const versions=await api('wiki/'+id);
      const version=versions.find(item=>item.revision===Number(data.key));
      if(!version) return;
      const restore=version===versions[0]?'':btn('wiki-edit','Восстановить версию',{data:idAttr(data.id)+' data-key="'+version.revision+'"'});
      return open('Версия '+version.revision,stack('<h3>'+escape(version.title)+'</h3><p class="preline">'+escape(version.body)+'</p>'+row(restore)));
    }
  }
  if(!signedIn()) return;
  switch(key){
    case 'logout':
      await api('session','DELETE',{});
      state.me=null;
      dialog.close();
      return go('welcome');
    case 'bookmark': {
      const post=state.posts.get(data.id);
      const route=state.renderToken;
      const updated=await api('posts/'+id+'/bookmark','POST',{active:!post.bookmarked});
      if(route!==state.renderToken) return;
      if(state.view==='bookmarks') return render();
      state.posts.set(data.id,{...state.posts.get(data.id),bookmarked:updated.bookmarked});
      const button=$('#post-'+CSS.escape(data.id)+' [data-action="bookmark"]');
      button.classList.toggle('bookmarked',updated.bookmarked);
      button.setAttribute('aria-pressed',String(updated.bookmarked));
      button.setAttribute('aria-label',updated.bookmarked?'Убрать из закладок':'Сохранить в закладки');
      return;
    }
    case 'like': {
      const post=state.posts.get(data.id);
      const route=state.renderToken;
      const updated=await api('posts/'+id+'/like','POST',{active:!post.liked});
      if(route!==state.renderToken) return;
      state.posts.set(data.id,{...state.posts.get(data.id),liked:updated.liked,likes:updated.likes});
      const button=$('#post-'+CSS.escape(data.id)+' [data-action="like"]');
      button.innerHTML=icon('heart',17)+updated.likes;
      button.classList.toggle('liked',updated.liked);
      button.setAttribute('aria-pressed',String(updated.liked));
      button.setAttribute('aria-label',updated.liked?'Убрать реакцию':'Поставить реакцию');
      return;
    }
    case 'post-menu': {
      const post=state.posts.get(data.id), attrs=idAttr(data.id);
      return open('Действия с записью',stack(btn('post-edit','Редактировать',{symbol:'pen',data:attrs})+
        btn('post-pin',post.pinned?'Открепить':'Закрепить',{data:attrs+' data-active="'+!post.pinned+'"'})+
        btn('post-confirm','Удалить',{css:'btn danger',data:attrs})));
    }
    case 'post-edit':
      return open('Редактировать запись',form('post-edit-form',area('body','Текст записи','maxlength="4000"',state.posts.get(data.id).body),'Сохранить',idAttr(data.id)));
    case 'post-confirm':
      return open('Удалить запись?',btn('post-delete','Удалить запись',{css:'btn danger',data:idAttr(data.id)}));
    case 'post-pin':
    case 'post-delete':
      await api('posts/'+id,key==='post-pin'?'PATCH':'DELETE',{pinned:data.active==='true'});
      dialog.close();
      return key==='post-delete'&&state.view==='post'?go('feed'):render();
    case 'aqua-link': {
      const request=await api('ecosystem/aquamarine/start','POST',{});
      return open('Подключить Aquamarine',form('aqua-form',
        '<p class="muted">Передайте запрос подключённому клиенту Aquamarine и вставьте выданное подтверждение. Запрос действует пять минут.</p>'+
        field('challenge','Одноразовый запрос','readonly',request.challenge)+area('proof','Подтверждение Aquamarine','required maxlength="8192"'),'Подключить'));
    }
    case 'aqua-grant':
      return open('Подтверждение для Aquamarine',form('aqua-grant-form',field('challenge','Одноразовый запрос Aquamarine','required minlength="43" maxlength="43"'),'Получить подтверждение'));
    case 'aqua-unlink':
      return open('Отключить Aquamarine?',btn('aqua-unlink-confirm','Отключить',{css:'btn danger'}));
    case 'aqua-unlink-confirm':
      await api('ecosystem/aquamarine/unlink','POST',{});
      dialog.close();
      return render();
    case 'application-create':
      return open('Заявка в Синклит',form('application-form',
        area('body','Чем вы хотите помочь Синклиту?','required maxlength="2000"'),'Отправить заявку'));
    case 'application-withdraw':
      return open('Отозвать заявку?',btn('application-withdraw-confirm','Отозвать заявку',{css:'btn danger',data:idAttr(data.id)}));
    case 'application-withdraw-confirm':
      await api('governance/withdraw/'+uri(data.id),'POST',{});
      dialog.close();
      return render();
    case 'application-vote':
      return open('Подтвердить голос по заявке',btn('application-vote-confirm',data.active==='true'?'Голосовать за приём':'Голосовать за отказ',
        {css:'btn primary',data:idAttr(data.id)+' data-active="'+data.active+'"'}));
    case 'application-vote-confirm':
      await api('governance/vote-application/'+uri(data.id),'POST',{approve:data.active==='true'});
      dialog.close();
      return render();
    case 'case-create':
      return open('Новое дело',form('case-form',field('title','Заголовок','required maxlength="140"')+
        area('body','Описание','required maxlength="4000"'),'Внести дело'));
    case 'case-vote':
      return open('Подтвердить голос',btn('case-vote-confirm',data.active==='true'?'Голосовать за':'Голосовать против',
        {css:'btn primary',data:idAttr(data.id)+' data-active="'+data.active+'"'}));
    case 'case-vote-confirm':
      await api('governance/vote/'+uri(data.id),'POST',{approve:data.active==='true'});
      dialog.close();
      return render();
    case 'profile-edit':
      return open('Редактировать профиль',form('profile-form',field('name','Имя','required maxlength="45"',state.me.name)+area('bio','О себе','maxlength="350"',state.me.bio),'Сохранить'));
    case 'group-create':
      return open('Новое сообщество',form('group-form',field('name','Название','required maxlength="65"')+
        area('bio','Описание','maxlength="400"')+'<label><input type="checkbox" name="closed"> Закрытое сообщество</label>','Создать сообщество'));
    case 'wiki-edit': {
      if(!id) return editWiki();
      const versions=await api('wiki/'+id);
      const entry=data.key?versions.find(item=>item.revision===Number(data.key)):versions[0];
      if(entry) return editWiki(entry,versions[0].revision);
      return;
    }
  }
  const calls={
    follow:['profiles/'+id+'/follow',{active:data.active==='true'}],
    friend:['profiles/'+id+'/friend',{command:data.key}],
    'group-join':['groups/'+id+'/join',{active:data.active==='true'}],
    'group-request':['groups/'+id+'/members',{member:data.user,accept:data.active==='true'}]
  };
  if(Object.hasOwn(calls,key)){
    const [path,body]=calls[key];
    await api(path,'POST',body);
    return render();
  }
}
function fileData(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result).split(',')[1]);
    reader.onerror=()=>reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}
async function save(t){
  const fields=new FormData(t), values=Object.fromEntries(fields);
  if(t.classList.contains('comment-form')){
    await api('posts/'+uri(t.dataset.post)+'/comments','POST',{body:values.body});
    await render();
    document.getElementById('comments-'+t.dataset.post)?.querySelector('input')?.focus();
    return;
  }
  let destination;
  switch(t.id){
    case 'demo-form':
      state.me=(await api('session/demo','POST',values)).profile;
      tell('Демопрофиль создан.');
      destination=['feed'];
      break;
    case 'compose-form': {
      const file=values.file;
      if(fileTypes[t.dataset.kind]&&!file?.size) throw new Error('Выберите файл.');
      if(file?.size>24*1024*1024) throw new Error('Файл должен быть до 24 МиБ.');
      const media=file?.size?{mime:file.type,data:await fileData(file)}:undefined;
      const result=await api('posts','POST',{body:values.body,title:values.title,credit:values.credit,workType:values.workType,visibility:values.visibility,
        group:t.dataset.group,article:t.dataset.kind==='article',media});
      if(state.view==='feed'){state.filter='';state.mode='all';}
      else if(!t.dataset.group) destination=['post',result.id];
      tell('Запись опубликована.');
      break;
    }
    case 'aqua-grant-form': {
      const grant=await api('ecosystem/aquamarine/grant','POST',{challenge:values.challenge.trim()});
      open('Подтверждение для Aquamarine',area('proof','Подтверждение действует 60 секунд','readonly',grant.proof));
      return;
    }
    case 'aqua-form':
      await api('ecosystem/aquamarine/finish','POST',{proof:values.proof.trim()});
      tell('Aquamarine подключён.');
      break;
    case 'application-form':
      await api('governance/applications','POST',values);
      tell('Заявка отправлена.');
      break;
    case 'case-form':
      await api('governance/cases','POST',values);
      break;
    case 'post-edit-form': await api('posts/'+uri(t.dataset.id),'PATCH',values); break;
    case 'profile-form': state.me=await api('profiles/'+uri(state.me.id),'PATCH',values); break;
    case 'group-form': {
      const group=await api('groups','POST',{...values,closed:fields.has('closed')});
      destination=['group',group.id];
      api('groups').then(groups=>{state.groups=groups;sidebar();}).catch(()=>{});
      break;
    }
    case 'wiki-form': {
      const article=await api('wiki'+(t.dataset.id?'/'+uri(t.dataset.id):''),'POST',{...values,revision:Number(t.dataset.revision)});
      destination=['wiki',article.id];
      break;
    }
    default: return;
  }
  if(dialog.open) dialog.close();
  return destination?go(...destination):render();
}
document.querySelectorAll('[data-icon]').forEach(element=>{element.innerHTML=icon(element.dataset.icon);});
$('#close').addEventListener('click',()=>dialog.close());
$('#skip').addEventListener('click',event=>{event.preventDefault();main.focus();});
document.addEventListener('click',async event=>{
  if(event.target.closest('[data-dialog-link]')&&dialog.open) dialog.close();
  const button=event.target.closest('[data-action]');
  if(!button||button.disabled) return;
  button.disabled=true;
  try{await perform(button.dataset.action,button.dataset);}catch(error){tell(error.message);}finally{button.disabled=false;}
});
document.addEventListener('change',event=>{
  if(event.target.name==='file'&&$('#file-fields')){
    const fields=$('#file-fields');
    fields.hidden=!event.target.files.length;
    fields.querySelector('[name="title"]').required=!fields.hidden;
  }
});
document.addEventListener('submit',async event=>{
  const t=event.target;
  event.preventDefault();
  if(t.id==='search'){
    const term=new FormData(t).get('query').trim();
    if(term) go('search',term);
    return;
  }
  const button=t.querySelector('[type="submit"]');
  if(button) button.disabled=true;
  warning.hidden=true;
  try{await save(t);}catch(error){
    if(dialog.open){warning.textContent=error.message;warning.hidden=false;}else tell(error.message);
  }finally{if(button) button.disabled=false;}
});
window.addEventListener('hashchange',()=>{
  window.scrollTo(0,0);
  if(dialog.open) dialog.close();
  render();
});
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(error=>console.warn(error));
try{
  const [session,groups]=await Promise.all([api('session'),api('groups')]);
  state.me=session.profile;
  state.providers=session.providers||{};
  state.groups=groups;
}catch{tell('Локальный регион недоступен.');}
sidebar();
render();
