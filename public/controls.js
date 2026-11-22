import { icon } from './icons.js';

const html = value => String(value).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[c]);
let nextId = 0;

export function choice(name, label, entries, selected = entries[0][0], css = '') {
  const id = 'choice-' + ++nextId;
  const labelForValue = entries.find(([value]) => value === selected)?.[1] || '';
  return '<div class="choice '+css+'" data-choice>'+
    '<input type="hidden" name="'+html(name)+'" value="'+html(selected)+'">'+
    '<button type="button" class="choice-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="'+id+'" aria-label="'+html(label+': '+labelForValue)+'" data-label="'+html(label)+'">'+
    '<span>'+html(labelForValue)+'</span>'+icon('caret',16)+'</button>'+
    '<div class="choice-menu" id="'+id+'" role="listbox" aria-label="'+html(label)+'" hidden>'+
    entries.map(([value,title]) => '<button type="button" role="option" aria-selected="'+(value===selected)+'" tabindex="-1" data-value="'+html(value)+'">'+
      '<span>'+html(title)+'</span>'+icon('check',16)+'</button>').join('')+'</div></div>';
}

function closeChoice(choice, focus = false) {
  const button = choice.querySelector('.choice-trigger');
  button.setAttribute('aria-expanded','false');
  choice.querySelector('.choice-menu').hidden = true;
  if (focus) button.focus();
}

function openChoice(choice, index) {
  for (const other of document.querySelectorAll('[data-choice]')) {
    if (other !== choice) closeChoice(other);
  }
  const menu = choice.querySelector('.choice-menu');
  menu.hidden = false;
  choice.querySelector('.choice-trigger').setAttribute('aria-expanded','true');
  menu.classList.toggle('choice-up', false);
  if (menu.getBoundingClientRect().bottom > window.innerHeight - 10 &&
      choice.getBoundingClientRect().top > menu.offsetHeight + 12) {
    menu.classList.add('choice-up');
  }
  (menu.querySelectorAll('[role=option]')[index] || menu.querySelector('[aria-selected=true]') || menu.firstElementChild)?.focus();
}

function selectChoice(choice, item) {
  const input = choice.querySelector('input');
  const button = choice.querySelector('.choice-trigger');
  const title = item.firstElementChild.textContent;
  const changed = input.value !== item.dataset.value;
  input.value = item.dataset.value;
  button.firstElementChild.textContent = title;
  button.setAttribute('aria-label', button.dataset.label + ': ' + title);
  for (const option of choice.querySelectorAll('[role=option]')) {
    option.setAttribute('aria-selected', String(option === item));
  }
  closeChoice(choice, true);
  if (changed) input.dispatchEvent(new Event('change',{bubbles:true}));
}

export function filePicker(accept) {
  return '<div class="field">Вложение<div class="file-picker" data-file-picker>'+
    '<input type="file" name="file" accept="'+html(accept)+'" hidden>'+
    '<button type="button" class="btn" data-file-open>' + icon('paperclip',17) + '<span>Выбрать файл</span></button>'+
    '<span class="file-name muted small" aria-live="polite">Файл не выбран</span></div></div>';
}

function timestamp(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2,'0');
}

export function player(kind, source, title, credit) {
  const video = kind === 'video';
  const data = ' src="'+html(source)+'" preload="'+(video?'metadata':'none')+'"';
  return '<div class="player'+(video?' player-video':' player-audio')+'" data-player>'+
    (video?'<video class="media" playsinline'+data+' aria-label="'+html(title)+'"></video>':'<audio hidden'+data+'></audio>')+
    '<div class="player-main"><button type="button" class="player-play" data-player-action="play" aria-label="Воспроизвести">'+icon('play',19)+'</button>'+
    '<div class="player-info"><h3>'+html(title)+'</h3><div class="muted small">'+html(credit)+'</div></div>'+
    '<button type="button" class="icon-button player-extra" data-player-action="mute" aria-label="Выключить звук" aria-pressed="false">'+icon('volume',19)+'</button>'+
    (video?'<button type="button" class="icon-button player-extra" data-player-action="fullscreen" aria-label="На весь экран">'+icon('fullscreen',18)+'</button>':'')+'</div>'+
    '<div class="player-progress"><input type="range" data-player-seek value="0" min="0" max="1000" step="1" disabled aria-label="Позиция воспроизведения">'+
    '<span class="player-time" aria-hidden="true">0:00</span></div><p class="muted small player-error" role="status" hidden></p></div>';
}

function updatePlayer(player, media) {
  const next = player.querySelector('[data-player-action=play]');
  const paused = media.paused || media.ended;
  const label = paused ? 'Воспроизвести' : 'Пауза';
  if (next.getAttribute('aria-label') !== label) {
    next.innerHTML = icon(paused ? 'play' : 'pause',19);
    next.setAttribute('aria-label',label);
  }
  const seek = player.querySelector('[data-player-seek]');
  seek.disabled = !Number.isFinite(media.duration) || media.duration <= 0;
  seek.value = seek.disabled ? 0 : Math.round(1000 * media.currentTime / media.duration);
  seek.setAttribute('aria-valuetext', timestamp(media.currentTime) + ' из ' + timestamp(media.duration));
  player.querySelector('.player-time').textContent = timestamp(media.currentTime) +
    (seek.disabled ? '' : ' / ' + timestamp(media.duration));
  const mute = player.querySelector('[data-player-action=mute]');
  if (mute && mute.getAttribute('aria-pressed') !== String(media.muted)) {
    mute.innerHTML = icon(media.muted ? 'muted' : 'volume',19);
    mute.setAttribute('aria-label',media.muted?'Включить звук':'Выключить звук');
    mute.setAttribute('aria-pressed',String(media.muted));
  }
}

function showPlayerError(player, message) {
  const element = player.querySelector('.player-error');
  element.textContent = message;
  element.hidden = !message;
}

document.addEventListener('click', async event => {
  const element = event.target.closest('[data-choice]');
  if (!element) document.querySelectorAll('[data-choice]').forEach(item=>closeChoice(item));
  if (event.target.closest('.choice-trigger')) {
    const menu = element.querySelector('.choice-menu');
    if (menu.hidden) openChoice(element);
    else closeChoice(element);
  }
  const item = event.target.closest('.choice-menu [role=option]');
  if (item) selectChoice(element,item);
  if (event.target.closest('[data-file-open]')) {
    event.target.closest('[data-file-picker]').querySelector('[type=file]').click();
  }
  const button = event.target.closest('[data-player-action]');
  if (!button) return;
  const box = button.closest('[data-player]');
  const media = box.querySelector('audio, video');
  try {
    if (button.dataset.playerAction === 'play') {
      showPlayerError(box, '');
      if (media.paused || media.ended) await media.play();
      else media.pause();
    }
    if (button.dataset.playerAction === 'mute') media.muted = !media.muted;
    if (button.dataset.playerAction === 'fullscreen') {
      if (document.fullscreenElement === box) await document.exitFullscreen();
      else if (box.requestFullscreen) await box.requestFullscreen();
      else if (media.webkitEnterFullscreen) media.webkitEnterFullscreen();
      else showPlayerError(box, 'Полноэкранный режим недоступен.');
    }
  } catch {
    showPlayerError(box, button.dataset.playerAction === 'fullscreen' ? 'Не удалось открыть полноэкранный режим.' : 'Не удалось воспроизвести файл.');
  }
});

document.addEventListener('keydown', event => {
  const choice = event.target.closest('[data-choice]');
  if (!choice) return;
  const menu = choice.querySelector('.choice-menu');
  if (event.key === 'Escape' && !menu.hidden) {
    event.preventDefault();
    event.stopPropagation();
    closeChoice(choice,true);
    return;
  }
  if (event.target.matches('.choice-trigger') && ['ArrowDown','ArrowUp'].includes(event.key)) {
    event.preventDefault();
    openChoice(choice,event.key==='ArrowUp'?menu.children.length-1:undefined);
    return;
  }
  if (!event.target.matches('[role=option]')) return;
  const list = [...menu.children];
  const current = list.indexOf(event.target);
  const target = {ArrowDown:(current+1)%list.length,ArrowUp:(current+list.length-1)%list.length,Home:0,End:list.length-1}[event.key];
  if (Number.isInteger(target)) {
    event.preventDefault();
    list[target].focus();
  }
});

document.addEventListener('focusin', event => {
  for (const choice of document.querySelectorAll('[data-choice]')) {
    if (!choice.contains(event.target)) closeChoice(choice);
  }
});

document.addEventListener('change', event => {
  if (!event.target.matches('[data-file-picker] input')) return;
  const picker = event.target.closest('[data-file-picker]');
  picker.querySelector('.file-name').textContent = event.target.files[0]?.name || 'Файл не выбран';
});

document.addEventListener('input', event => {
  if (!event.target.matches('[data-player-seek]')) return;
  const box = event.target.closest('[data-player]');
  const media = box.querySelector('audio, video');
  if (Number.isFinite(media.duration)) media.currentTime=media.duration*Number(event.target.value)/1000;
});

for (const name of ['play','pause','ended','loadedmetadata','durationchange','timeupdate','volumechange','error']) {
  document.addEventListener(name, event => {
    if (!(event.target instanceof HTMLMediaElement)) return;
    const media = event.target;
    const box = media.closest('[data-player]');
    if (!box) return;
    if (name === 'play') {
      for (const other of document.querySelectorAll('[data-player] audio,[data-player] video')) {
        if (other !== media && !other.paused) other.pause();
      }
    }
    if (name === 'error') showPlayerError(box,'Не удалось воспроизвести файл.');
    updatePlayer(box,media);
  }, true);
}
